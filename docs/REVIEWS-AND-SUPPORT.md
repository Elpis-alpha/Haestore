# Reviews and support

The two places the shop hears back from the people it sells to. Phase 9 of the rebuild.

Both are built on the same observation. Signing in here is a code sent to an address
(ADR-004), so an account is exactly *an address somebody has proven they read* — and that is
the thing a review and a support conversation each need most. A review is worth reading
because the person bought the thing; a reply is worth sending because it reaches the person
who asked. Neither feature has an anonymous path, and neither needs a spam filter, a captcha
or a moderation queue that holds content back, because the identity is already proven by the
time anyone types.

---

## Reviews

### A review is a verified purchase, or it does not exist

`Review.order` is **required**. There is no route to a review that does not name the order
behind it, so "verified purchase" is not a badge some reviews earn — it is what a review is,
and the page says so once, under the list, rather than stamping every entry.

The qualifying order is found on the server, never sent by the client:

    Order.findOne({ user, 'lines.product': productId, 'history.status': 'delivered' })

**"Reached `delivered`", read from the history rather than the status.** An order that was
delivered and later refunded after a return was in the person's hands, and their opinion of
it is exactly the kind a shopper wants — so it qualifies. An order refunded before it shipped
never reached anyone, and its history says so. The earliest such order is used, so a review
keeps pointing at the same purchase however many times the person buys again. Both directions
are integration tests.

**One per person per product**, as a unique index on `{product, user}`. A second review
replaces the first, which is what somebody who changed their mind means. The write is
addressed by product — `PUT /api/reviews/products/:id` — so pressing Save twice is idempotent.
Two first saves racing from two tabs both find nothing and both insert; the index refuses the
second with a duplicate key, which a transaction does not retry, so the service retries it
once, and the retry finds the first and updates it. Tested with both saves fired at once.

### Published first, read after

A review is on the product page the moment it is written. There is no approval step.

The usual reason for one is spam, and a review that required a delivered order is not spam.
The other reason is less comfortable: **a shop that approves reviews before anyone can read
them is choosing its own average.** So moderation comes after publication, and it is built so
that the easy thing to do with it is read, not remove.

Two independent facts on the review, deliberately not one status:

| | |
|---|---|
| `status` | Visibility — `published` or `hidden`. The only thing the average reads. |
| `needsReview` | The queue. True when written and **again whenever the author edits**; false once someone in the shop has read it. |

The console offers three things, derived from those two fields:

- **Read** — takes the review out of the queue and changes nothing anyone sees. This is most
  moderation, and it is one press.
- **Hide** — takes it off the page and its star out of the average. It **requires a note, and
  the note is shown to the author** on their own review page. That is the check on hiding:
  a note written to the person whose words are being removed is easy to write about a review
  that names another customer and hard to write about one that is merely unflattering.
- **Restore** — puts it back.

Hidden is never deleted; the review, the reason and who hid it all remain. **An edit to a
hidden review puts it back in the queue without making it visible**, so hiding cannot be
undone by the author pressing Save — and an author who fixes what the note asked for is read
again without having to write in about it. None of the three is behind step-up: each is
reversible, and routine work behind a code prompt teaches people to type codes without reading.

Every refused moderation action answers **409 with the review's current state**, the same shape
an order action gives, and the console reloads rather than showing an error it cannot explain.

### The average is derived, in the transaction

`Product.ratingAverage` and `ratingCount` have been on the product and the listing card since
Phase 2, written by nothing. They are listing fields, so a review write is a product write as
far as the search index is concerned.

Every write that changes what the public sees — writing, rewriting, deleting, hiding,
restoring — goes through one helper, `withRatingRefresh`, which in the review's own
transaction:

1. groups the product's **published** reviews by star (indexed on `{product, status, rating}`),
2. derives the average and count from those counts,
3. sets both on the product,
4. appends a search outbox row.

### "Best rated" is a Bayesian score (Phase 10)

Phase 9 left the listing's `rating` sort ordering one five-star review above two hundred at
4.9, and said the fix belonged with a seed that made the difference visible. It does now: the
seeded shop's small lot of Rwandan coffee has one review, of five stars.

The same step now writes a third figure, `ratingScore = (3 × 5 + average × count) / (5 +
count)` — every average pulled towards three stars by the weight of five imaginary reviews.
A single five scores 3.33; a dozen at 4.8 score 4.27; two hundred at 4.9 score 4.85; and by a
few dozen reviews the score and the average are within a tenth of each other. `sort=rating`
orders by it, in Meilisearch and on the degraded path. In the seeded shop the small lot sorts
38th of 58.

Three choices in it are deliberate. **The prior is a fixed three, not the shop's own mean** —
a mean would move every product's score whenever any review anywhere was written, and
re-index the catalogue to follow it. **A product with no reviews scores zero**, not the prior,
so "best rated" lists what has been rated first. **The card still shows the average**: the
score is an ordering, and printing "3.33" beside five stars would misstate what reviewers
said.

**Counts, not a running average.** Folding each review into the stored figure —
`(avg × n + r) / (n + 1)` — is cheap and wrong in two quiet ways: every fold re-rounds, so the
figure drifts away from the reviews it describes, and a hidden or deleted review has to be
folded back out of a number that no longer remembers it. Dividing grouped counts once is exact.
`summariseRatings` is pure and tested, including 500 fives and 500 fours landing on exactly
4.5.

**Two reviews landing on one product at once both count.** Both transactions write the product
document, so one meets a write conflict, and `withTransaction` retries it against a snapshot
that now includes the other review. No lock; the integration suite fires two first reviews at
once and asserts a count of 2 and an average of 4.

### What the public sees

- **The byline is a first name and an initial** — "Ada L." — rendered when the review is
  written. Never the email address and never the whole name: somebody who typed their full name
  into the account page so parcels arrive addressed properly did not thereby agree to have
  their surname printed beside an opinion about a teapot. An account with no name signs
  "A customer". The account's review page says how the byline will read before anyone publishes.
- **An explicit projection**: rating, title, body, byline, the variant as bought, dates. The
  suite asserts the exact key set and that no address appears anywhere in the response.
- **The distribution beside the average**, because 4.2 from forty fours and 4.2 from thirty
  fives and ten ones are different products. Each row is one sentence to a screen reader.

The first page of reviews is **read with the product and rendered into its HTML**, where a
crawler and a slow connection both receive it — softly, so a review read that fails is a
product page with one section fewer. Sorting and "more" fetch from the browser rather than
navigating: the product page is cached per URL, and `?sort=` would make every order a separate
page to cache and to index. A slow response for an old sort cannot overwrite a newer one.

### There is no "Write a review" button on the product page

The product page is cached and does not know who is looking at it, and almost nobody looking
at it can review it. A button shown to all of them that then tells nearly all of them "you
can't" is the disabled-control mistake this codebase keeps declining to make (FRONTEND.md,
Phase 4). Instead:

- the product page ends its reviews with a sentence saying who can review, linking to the
  account;
- **`/account/reviews`** lists everything from delivered orders not yet reviewed — every item
  offered there can actually be reviewed — above the reviews already written, hidden ones
  included, with the shop's reason;
- a **delivered order's page** offers "Review it" per product, landing on
  `/account/reviews?write=<productId>`, which opens that product's dialog on arrival.

The rating control is a radio group of five stars — one choice from five is what it is —
with roving focus and arrow keys from Radix, each star labelled "4 stars, good", and the word
beside the row.

---

## Support

### It needs an account

[ADR-014](decisions/ADR-014-support-needs-an-account.md). An anonymous contact form would make
this shop's sender write to any address anybody typed, need a second credential to read a
thread, and attach orders on trust. A signed-in account is a proven address, its orders are
known, and the only email a conversation ever produces is the shop's reply to that address.

`/support` is a static, indexable page that says this in plain words — what signing in involves,
why there is no form on it, and where to look before writing — and links into the account area,
whose middleware sends a signed-out visitor to sign in and back to the form.

### Who owes the next message

| Status | Means | Set by |
|---|---|---|
| `open` | the shop owes a reply | opening, or any customer message — **including one to a closed conversation, which reopens it** |
| `answered` | the shop replied last | a reply from the shop |
| `closed` | ended | either side; idempotent |

Named for the question both inboxes are asking. The console calls them "Needs a reply",
"Answered" and "Closed"; the customer sees "Waiting for our reply", "We replied" and "Closed".
A reply from the shop can close in the same step, because the commonest last message is an
answer, and making that two steps is how finished conversations sit as "answered" forever.

### The guards are in the filter

- **Ownership.** Every customer read and write is scoped to the caller in the query, so "not
  yours" and "does not exist" — and a malformed reference — are the same 404.
- **The cap.** Messages are embedded, at most 100; a thread is read whole and written a message
  at a time, and a hundred messages is a relationship rather than a query. Array validators do
  not run on `$push`, so the cap is `messages.99: {$exists: false}` in the write's filter, for
  the customer and the shop alike, and a refused shop reply owes no email.
- **Attached orders** are looked up among the caller's own, through the same order-number
  normaliser the shopper's order lookup uses — "hae cjorthpk", typed with a letter O, finds
  `HAE-CJ0RTHPK`, and someone else's number is "not on your account".
- **Five open conversations** per customer is a nuisance limit, checked before the insert, and
  documented as such: two tabs at once could make a sixth.

### The reply email goes through the outbox

A reply from the shop and the intent to email it are **one transaction**: the message is pushed
and a `support-reply` row is appended to the mail outbox together, so a reply cannot be saved
without its email being owed, or emailed after a rollback. The row names the message by id —
minted before the write — so two replies a minute apart are two emails with two different
bodies.

It lives in the order outbox (`order_outbox`) rather than a collection of its own. It is the one
other transactional email the shop sends a customer, and a second outbox would be a second
sweep, a second TTL and a second place to look when someone asks whether a reply arrived.

**The sweep is the only delivery path.** Building this found that the post-commit fast path
CHECKOUT.md described — `enqueueOrderMail` — has no caller; receipts have always gone out on the
sweep. A minute's latency is fine for mail, so it stays unwired and the documentation now says
so.

### References

`SUP-` and six Crockford base32 characters, random, with the order number's alphabet and its
folding (`O` → `0`, `I`/`L` → `1`), so a reference typed from an email or read down a phone
finds its conversation. An insert that draws a used reference draws again.

### Both sides of the counter

- `/account/support` — the conversations, with **"New reply"** in words for a shop reply the
  customer has not opened. Opening the thread is what clears it: the API records
  `customerReadAt` on that read, so the mark means the person looked, not that an email was
  delivered.
- `/account/support/new` — the customer's recent orders as choices rather than a field to type
  a number into, and `?order=` preselects one; every order page has "Ask us about this order".
- `/admin/support` — opens on "Needs a reply", **longest-waiting first**; a search looks across
  every status, since someone quoting a reference does not know whether it was closed.
- `/admin/support/:id` — the thread, the reply box, and the customer and order one link each.

Both threads are one component. The shop's messages are paper and the customer's sit in the
well — Phase 1's two surfaces meaning what they always mean — and the names are there for anyone
who cannot see the difference. **Which admin wrote a reply is recorded and shown in the console,
and never sent to the customer**, whose thread and email say "Hæstore".

---

## Today

The dashboard gained two daybook lines, each a count and the oldest few: people waiting on a
reply, placed second, after parcels to pack; and reviews nobody has read, placed last, because
they are already public and nothing about them is urgent. A hidden review back in the queue
after an edit is marked as such.

---

## What is deliberately not here

- **Photographs** in reviews or conversations. There is no upload path until Phase 10's
  Cloudinary work, and a support thread that asks for a picture it cannot receive is worse
  than one that does not ask.
- **The shop replying to a review in public.** It is the obvious next feature and it needs its
  own moderation story.
- **Helpful votes, and sorting by them.** An unauthenticated vote is noise and an authenticated
  one is a second identity question.
- **Replying by email.** Replies to the notification are not read into the thread.
- **Notifying the shop by email** of a new conversation. The dashboard is where the shop looks.
- **An anonymous contact form** — ADR-014.
