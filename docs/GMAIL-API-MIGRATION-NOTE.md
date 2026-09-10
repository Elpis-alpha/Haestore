# Handoff note: switching Gmail sending from SMTP → Gmail HTTPS API

**Purpose:** paste this into a Claude session on another backend that sends mail
with **nodemailer + Gmail OAuth2 SMTP**. It explains a production failure we hit
and the exact fix we applied, so the same change can be made there.

---

## The problem

The app sends email through Gmail using nodemailer's SMTP transport with an
OAuth2 `refreshToken`. It works fine on local machines but on the production VPS
(netcup, but this is common to most cloud/VPS hosts) it fails:

- `transporter.verify()` and `transporter.sendMail()` **hang, then time out**.
- Our startup sequence `await verifyMailer()` runs *before* `app.listen()`, and
  on failure calls `process.exit(1)`. Combined with Docker
  `restart: unless-stopped`, the container **crash-loops forever** and the API
  never comes up. `docker compose logs -f` looks like it's "hanging" — it's
  actually looping.

Other outbound services (MongoDB Atlas, Cloudinary — both HTTPS/443) worked
fine, which is the tell.

### Root cause

**The host blocks all outbound SMTP ports (25, 465, 587).** This is a standard
anti-spam policy on VPS providers. Nothing in application code can work around a
blocked port.

### How to confirm it on the target box

Run from inside the deployment environment (adjust container/service name):

```bash
docker compose run --rm --entrypoint node <service> -e "['465','587','25'].forEach(p=>require('net').createConnection(+p,'smtp.gmail.com').setTimeout(5000).on('connect',()=>console.log(p,'OPEN')).on('timeout',()=>console.log(p,'BLOCKED/timeout')).on('error',e=>console.log(p,'ERR',e.code)))"
```

If all three print `BLOCKED/timeout`, SMTP is blocked. Options:

1. Ask the host's support to unblock outbound SMTP (they often will for verified
   accounts) — keeps nodemailer SMTP as-is.
2. **Switch Gmail sending to the Gmail HTTPS API** (port 443) — what we did, below.
3. Move to a transactional email HTTP API (Resend / Brevo / Mailgun / SendGrid).

---

## The fix we applied (option 2)

Keep nodemailer **only to build the MIME message**; send the bytes through
`gmail.users.messages.send` over HTTPS using `googleapis`.

### Prerequisites (do these first — they are account/config, not code)

1. **Enable the Gmail API** in the Google Cloud project that owns the OAuth
   client (`MAIL_CLIENT_ID`). Visit
   `https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=<PROJECT_ID>`
   → Enable → wait ~2–5 min. Without this you get HTTP 403
   `accessNotConfigured`.
2. **Refresh-token scope** must include `https://mail.google.com/` or
   `https://www.googleapis.com/auth/gmail.send`. A refresh token created for
   Gmail SMTP OAuth already has `https://mail.google.com/`, so usually no
   re-consent is needed. If it was scoped narrower, re-consent once (OAuth
   Playground or your own flow) and replace `MAIL_REFRESH_TOKEN`.
3. `googleapis` must be a dependency (`npm i googleapis`). nodemailer stays.

Env vars used: `MAIL_CLIENT_ID`, `MAIL_CLIENT_SECRET`, `MAIL_REFRESH_TOKEN`,
plus the from-address / display name. `MAIL_REDIRECT_URI` is **not needed** for
the refresh-token flow.

### Before (SMTP — the version that fails on a blocked host)

```ts
import { createTransport } from "nodemailer";

const transporter = createTransport({
  service: "gmail", // or host: "smtp.gmail.com", port: 465, secure: true
  auth: {
    type: "OAuth2",
    user: MAIL_ADDRESS,
    clientId: MAIL_CLIENT_ID,
    clientSecret: MAIL_CLIENT_SECRET,
    refreshToken: MAIL_REFRESH_TOKEN,
  },
});

export const verifyMailer = async () => {
  await transporter.verify();
};

export const sendMail = async (to: string, subject: string, html: string) => {
  try {
    return await transporter.sendMail({ from: `"${MAIL_NAME}" <${MAIL_ADDRESS}>`, to, subject, html });
  } catch (error) {
    return "failed";
  }
};
```

### After (Gmail HTTPS API — works on a blocked host)

```ts
import { createTransport } from "nodemailer";
import { google } from "googleapis";

// OAuth2 client. googleapis refreshes the access token automatically.
const oauth2Client = new google.auth.OAuth2(MAIL_CLIENT_ID, MAIL_CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: MAIL_REFRESH_TOKEN });

const gmail = google.gmail({ version: "v1", auth: oauth2Client });

// nodemailer only composes MIME here — no SMTP connection is opened.
const mimeBuilder = createTransport({
  streamTransport: true,
  buffer: true,
  newline: "unix",
});

const toBase64Url = (buffer: Buffer) =>
  buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const verifyMailer = async () => {
  // No SMTP verify() anymore; just prove we can mint an access token.
  const { token } = await oauth2Client.getAccessToken();
  if (!token) throw new Error("Could not obtain a Gmail access token");
};

export const sendMail = async (to: string, subject: string, html: string) => {
  try {
    const built = await mimeBuilder.sendMail({
      from: `"${MAIL_NAME}" <${MAIL_ADDRESS}>`,
      to,
      subject,
      html,
    });

    // `buffer: true` guarantees `message` is a Buffer.
    const raw = toBase64Url(built.message as Buffer);

    const sent = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    return sent.data; // { id, threadId, labelIds }
  } catch (error) {
    return "failed";
  }
};
```

### Gotchas

- **`streamTransport: true, buffer: true`** makes `sendMail()` return the composed
  message as a Buffer in `info.message` instead of sending anything. TS types it
  as `string | Buffer | Readable`; cast `as Buffer` (the runtime value is a
  Buffer with `buffer: true`).
- Gmail API wants the raw RFC 2822 message **base64url**-encoded (`+`→`-`, `/`→`_`,
  strip `=` padding). Plain base64 gives 400.
- `userId: "me"` = the account that owns the refresh token. The `From:` header
  must be that same address (or a verified send-as alias) or Gmail rewrites it.
- No more `transporter.verify()` — there's no SMTP socket to verify. Checking
  `oauth2Client.getAccessToken()` is the equivalent "creds are good" probe.
- googleapis handles access-token refresh internally; you only store the refresh
  token.
- **Consider not making mail failure fatal at startup.** If your boot sequence
  does `await verifyMailer()` then `process.exit(1)` on failure, a mail outage
  takes the whole API down. Prefer logging loudly and continuing to
  `app.listen()`.

### Return-value change

`sendMail` used to resolve to nodemailer's `SentMessageInfo`; now it resolves to
Gmail's `{ id, threadId, labelIds }`. If callers only check
`result === "failed"` (ours did), nothing else needs to change. Otherwise audit
call sites.

### Quick test

```bash
node -r dotenv/config -e "
const { verifyMailer, sendMail } = require('./dist/middlewares/mail');
(async () => {
  await verifyMailer();
  const r = await sendMail('<your-address>', 'Gmail API test', '<b>hi</b>');
  console.log(typeof r === 'string' ? r : JSON.stringify(r));
})().catch(e => { console.error(e); process.exit(1); });
"
```

Success looks like: `{"id":"...","threadId":"...","labelIds":["SENT",...]}`.
