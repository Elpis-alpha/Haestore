# Authentication

Sign-in, sessions, the account area, and the guards that stand in front of everything
Phase 2 built. Phase 5 of the rebuild — the phase that makes the admin surface reachable
for the first time.

The whole design is one sentence: **there is no password, and there is no signup.** Both
absences are load-bearing, and most of what follows is a consequence of one of them.

---

## Requesting a code does the same work for everyone

`POST /api/auth/otp/request` takes an email and answers **202**. It answers 202 for an
address that has an account, for one that does not, and for one that has tripped every
rate limit in the system. The body is the same shape in all three cases.

This is where enumeration resistance comes from, and it is structural rather than
careful: there is no signup path and no login path, so **there is no branch to time and
no pair of messages to keep in sync**. Compare the 2022 app, which shipped
`GET /api/users/user/exists?email=` — a purpose-built oracle, unthrottled.

A throttled request returns a well-formed `challengeId` that no challenge stands behind.
Verifying against it answers "that code has expired", which is exactly what a real
challenge answers after ten minutes. From outside, a throttled request and a sent one
are indistinguishable.

The one thing that is **not** a 202 is a mail transport failure: that returns 503. It
leaks nothing — it is identical for every address, because it is a fault in us rather
than a fact about the caller — and telling someone a code is on its way when it is not
leaves them staring at an empty inbox blaming themselves. The challenge is discarded
with the failed send, so a code nobody was told does not sit in Redis waiting to be
guessed.

### The limits are the security, not the hash

A six-digit code has 10⁶ possibilities. What protects it:

| Limit | Value |
|---|---|
| Attempts per challenge | 5, then the challenge is destroyed |
| Codes per address | 5 per hour |
| Codes per IP | 20 per hour |
| Resend cooldown | 60 seconds per address |
| Code lifetime | 10 minutes |

Five attempts against five challenges is **25 guesses an hour**. Exhausting 10⁶ at that
rate takes about four and a half years, against a code that lives for ten minutes.

The rate-limit counters are deliberately **not refunded** when the send afterwards
fails. A limit you get back on an error is a free retry loop, and a mail outage is
exactly the condition under which a client retries hardest.

`clientIp()` unwraps the IPv4-mapped IPv6 form (`::ffff:203.0.113.9`) that Node reports
on a dual-stack socket. Left alone, one client reaching the API over both spellings gets
two buckets and twice the per-IP allowance.

### Why the code is hashed with HMAC and not bcrypt

bcrypt's work factor defends a *large* offline search space. Six digits is not one — an
attacker holding a Redis dump enumerates it whatever the cost factor, so paying for
bcrypt buys latency and nothing else.

What actually protects the stored value is a server-side pepper that lives in the
environment and never in Redis, so a Redis dump alone is useless:

```
HMAC-SHA256(OTP_PEPPER, challengeId + email + code)
```

The challenge id and the address are **inside** the hash. That is what stops a code
observed on one challenge verifying another, and stops a code mailed to one address
being replayed against a different one.

### Compare-and-delete is one Lua script

A read, then a compare, then a delete is three round trips, and two concurrent
verifications can both pass between them — which turns a single-use code into a reusable
one for as long as the race window lasts. The script in `otp.ts` runs to completion with
nothing interleaved, so "this code is correct" and "this code is spent" are the same
event.

The string comparison inside it is not constant-time and does not need to be: the value
compared is an HMAC under a pepper the attacker does not have, so there is no input they
can steer toward a longer match.

---

## Sessions

Opaque 256-bit ids in Redis. No JWTs anywhere — see
[ADR-004](decisions/ADR-004-passwordless-otp-sessions.md) for why statelessness buys
nothing in a system that already has Redis on the same network.

**The Redis key is SHA-256 of the session id, not the session id.** A dump of Redis then
yields no usable cookie values, the same way a file of password hashes yields no
passwords — except that here the preimage is 256 random bits, so there is nothing to
brute-force at all. It also makes the device list publishable: the id shown on the
account page *is* that digest, so it identifies a session for revocation while being
useless as a credential.

The record holds who, when, and from where. It deliberately does **not** hold roles —
see [ADR-010](decisions/ADR-010-roles-are-read-not-carried.md).

### The cookie

```
__Host-hae_sid; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000
```

`__Host-` is a contract the **browser** enforces: it refuses the cookie outright unless
it is `Secure`, has `Path=/`, and declares **no `Domain`**. That last clause is the one
that matters — without it, script on any compromised subdomain can set a session cookie
the API will accept and cannot distinguish from one it issued. No server code can defend
against that; the prefix moves the check somewhere an attacker cannot reach.

It is why the frontend proxies `/api/*` through a Next rewrite: a cookie with no
`Domain` is single-origin by definition, so the browser must only ever see one origin.
Server components call `API_ORIGIN` directly and deliberately do not carry this cookie —
when one needs to, it forwards it explicitly, in `lib/auth/session.ts`, and nowhere else.

**The prefix is kept in development.** Browsers treat `localhost` as a secure context, so
`Secure` is honoured over plain http there — verified in a real browser, because the
failure mode is silent: the browser simply declines the cookie and sign-in never sticks.
Dropping the prefix locally would repeat the mistake
[ADR-007](decisions/ADR-007-gmail-api-only-no-smtp.md) removed, of exercising a
configuration that cannot ship.

`Lax`, not `Strict`. `Strict` withholds the cookie on any cross-site navigation,
including the redirect back from Stripe or PayPal — so a shopper returns from paying and
appears signed out, mid-checkout. `originGuard` is the second lock, and it is a real one:
the same request with the same valid cookie is 200 from our origin and **403** from
another.

### Sliding expiry, without a write per request

The Redis TTL is renewed at most once a day rather than on every read. Thirty days minus
up to twenty-four hours is not a window anyone notices, and it turns one write per page
view into one write per active day.

The cookie has its own `Max-Age`, so it is re-issued exactly when the server-side window
moves — `readSession` reports whether it renewed. Sliding one without the other expires
the browser's copy on day thirty however active the person was.

### Rotation, and the three levels of revocation

The session id is replaced on every privilege change — verification today, the
guest-to-user upgrade in Phase 6. An attacker who plants a known session id in a
victim's browser before sign-in must not still hold a valid one afterwards.

| Level | Mechanism | Reach |
|---|---|---|
| One device | `DEL sess:{hash}` | That session |
| All others | iterate `usess:{userId}` | Every session but the current one |
| Nuclear | `$inc User.sessionVersion` | Every session, without touching Redis |

The third is the one worth understanding. The session snapshots `sessionVersion` at
creation and the guard compares it against the live document, so incrementing the
document invalidates everything at once — which is what makes an admin demotion take
effect on the demoted person's next request rather than in thirty days.

`usess:{userId}` is a set, and Redis cannot expire one member of a set, so it
accumulates ids pointing at nothing. `listDevices` sweeps them as it reads, which keeps
the set bounded by *active* sessions rather than by lifetime sign-ins and needs no
background job.

---

## Step-up

`requireRole('admin')` answers "is this an admin". Step-up answers "is this an admin
**here, now**" — a session left open on an unattended laptop is a valid session, and the
twelve-hour window on `authAt` is what stops it being enough to delete a branch of the
catalogue.

It is mounted on the two admin routes that cannot be undone: `DELETE` a category and
`DELETE` a product. Not on archive, which is reversible, and not on the router, because
requiring a fresh code to *read* the admin console would train people to type codes.

**It answers 403 `STEP_UP_REQUIRED`, never 401**, and the distinction is the whole point:
the session is valid and must survive the re-verification. A 401 tells the client to
start a fresh sign-in, which discards whatever the person was in the middle of.
`/auth/step-up/verify` moves `authAt` and changes nothing else — no new session id.

The code must have been minted for **this session's own address**. Without that check a
step-up could be satisfied with a code sent to an address the attacker controls, which
would make the whole thing decorative.

---

## Mail

Gmail over HTTPS or nothing, per ADR-007. `console` prints and opens no socket at all,
so it cannot be mistaken for evidence that sending works.

**Reached with `fetch`, not `googleapis`.** The Gmail API takes one field — a base64url
RFC 5322 message — so the entire job is composing that and making two POSTs. Carrying
`googleapis` for one request, plus nodemailer used only as a MIME builder and then thrown
away, is a lot of dependency tree for something `fetch` already does. What the libraries
were buying is in `mail/mime.ts` and is tested: encoded-words for non-ASCII headers,
base64 bodies so no line exceeds 998 octets, CRLF throughout.

That last set is not hypothetical here. The sender's display name is **Hæstore**, and a
raw `æ` in a header is a malformed message — Gmail's response to which is to silently
rewrite the `From`. The test that a multi-byte character is never split across two
encoded-words exists because a byte-wise chunker produces a subject line with a
replacement character in the middle of a word.

The transport is verified at boot and **never fatally**. The 2022 deployment did
`await verifyMailer()` before `app.listen()` and `process.exit(1)` on failure; with
`restart: unless-stopped`, a blocked SMTP port became a container that crash-looped
forever while the logs looked like a hang. A mail outage should cost sign-ins, not the
shop.

`GET /api/dev/outbox` serves the last 25 messages so local development and E2E can read
a code without a mailbox. **Those bodies contain live sign-in codes**, so it is guarded
twice: `app.ts` does not mount the router in production, and the router refuses anyway.
Two independent checks is right when the failure mode is publishing working credentials.

### The email itself

The code is in the **subject line** as well as the body, because that is where most of
these are read — a lock-screen banner is then enough to finish signing in.

No tracking pixel, no images, and **no magic link**. A code the person types is
phishing-resistant in a way a link is not: a link in an email trains people to click
links in emails, which is the behaviour every credential-phishing campaign depends on.

---

## The account area

`/sign-in` is one door. There is no "create an account" tab and no link to one, because
there is no such operation — the first correct code for an address makes the account,
already verified. The copy has to carry that or a returning shopper hunts for a sign-in
they are already looking at.

**Sign-in posts from the browser**, through the `/api/*` rewrite. The `Set-Cookie` has to
land on the origin the shopper is browsing; a server action calling Express directly
would have to intercept the header and re-issue it, reimplementing by hand the one thing
the browser already does correctly.

The code field is Radix's `unstable_OneTimePasswordField` — six boxes, so the shape says
how many digits are coming and a wrong one can be fixed in place. Radix supplies the
parts always got wrong by hand: pasting a whole code into the first box, Backspace
stepping back, arrow keys, and a hidden input carrying the value. `type="text"` rather
than `password`: masking a single-use code that expires in ten minutes defends nothing
and costs the person the ability to check what they typed against the message open
beside them.

`autoSubmit` fires on the sixth digit, **and there is a Continue button anyway**. Any
path that reaches the field without the keystrokes Radix hooks — a password manager, an
autofill, a future change to an `unstable_` component — would otherwise leave someone
staring at six filled boxes with nothing to press.

The resend countdown is the honest half of a silent server control. The API enforces the
60-second gap and says nothing about it, because "wait 40 seconds for that address"
would be a signal about the address; showing the same countdown to everyone in the
browser, where the person already knows they just asked, means nobody presses a button
that does nothing.

### The header does not read the session

The account link is a plain `/account` link, and that is deliberate. `cookies()` in a
layout opts **every route beneath it** into dynamic rendering, and this layout wraps the
whole site — so a header saying "Signed in as…" would cost the home page and every shelf
their prerender to render one word. The link is correct in both states, and `/account`
sorts it out: signed in you get the page, signed out you are redirected and brought back.

The build's route table is the check: `/` is still `○ Static` after this phase.

Phase 6 changes the calculus — a bag needs per-request state in the header regardless —
and that is the moment to revisit it, not before.

### Guards, in two layers

`middleware.ts` turns away anyone reaching `/account/*` with **no cookie at all**, which
is the overwhelming majority of signed-out visitors and saves them a render they would
only be bounced out of.

It is a presence check, not an authentication check. Middleware has no Redis and cannot
tell a valid session from an expired one. **The real decision is `requireSession` in the
page**, which asks the API. Treating a cookie's existence as proof of a session is how an
expired credential becomes a valid one.

`?next=` is validated, never sanitised. `//evil.test` starts with a slash and is an
absolute address on another host; `/\evil.test` is the same trick through a backslash
browsers normalise. Anything that is not obviously a local path becomes `/account`.

### There is no `loading.tsx` in the account area, and there must not be one

The Phase 4 lesson, in its second costume. A Suspense boundary lets Next flush the shell
and commit a 200 before the page has decided anything — here, before it has decided
whether the session is valid. The `redirect()` to sign-in then arrives after the status
and degrades to a meta refresh in the body: a signed-out person watching the account page
render, and then bounce.

---

## What is deliberately not here

- **No password, and no `passwordHash` field.** Adding one later would not be an extra
  option; it would reintroduce every failure mode this replaced. The user model says so
  where someone would go to add it.
- **No "remember me".** The session is thirty days and slides. A checkbox offering a
  shorter one is a security decision handed to someone with no information to make it
  with.
- **No email change flow.** The address *is* the identity, and changing it is closer to
  merging two accounts than to editing a field. It belongs with orders, in Phase 7, where
  there is something to carry across.
- **No admin UI for roles.** `ADMIN_EMAILS` bootstraps the first administrator at
  verification time, which is what makes a fresh database yield a working admin with no
  seeded password — replacing the 2022 app's shared `?item_password=` in the query string
  of every mutating request. Granting a role to someone else is Phase 8's console.
- **No step-up dialog in the frontend.** The mechanism is mounted and tested on real
  routes, but the only things behind it are admin deletes, and the admin console arrives
  in Phase 8. A dialog with nothing to guard is the disabled-button mistake.

## The known gap

The admin `DELETE` routes are not in `openapi.json` — none of the admin delete surface
was registered in Phase 2, and adding just these two would leave the document
inconsistent about which mutations exist. Phase 8 needs them documented anyway, because
that is when a frontend has to handle `STEP_UP_REQUIRED`, so they go in together.
