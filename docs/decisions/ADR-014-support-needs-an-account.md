# ADR-014 — Support conversations need an account; there is no anonymous contact form

**Status:** Accepted · 2026-09-14

## Context

The 2022 app had a `/complain` form: a name, an address and a message, emailed to the
admin and stored nowhere. Phase 9 replaces it with persisted conversations — both sides
reading the same thread, a reference to quote, a reply emailed when the shop answers.

Every shop has a contact form a visitor can fill in without an account, and the obvious
version of this phase keeps one: type an address, type a message, get a reply at that
address.

What that form would do in this codebase:

- **Send email to an address nobody has proven.** The first thing a conversation does is
  tell the customer the shop replied, at the address they typed. An anonymous form is
  therefore a way to make this shop's Gmail sender write to any address on the internet,
  as often as someone can submit a form — which is how a sender's reputation goes, and
  with it every sign-in code the shop sends.
- **Need a second way to read a thread.** A guest cannot be shown their conversation by
  session, so each one needs its own bearer link — a second credential in a second
  inbox, with its own expiry and its own "I lost the email" support request.
- **Attach orders by trust.** "This is about HAE-CJ0RTHPK" from an unproven address is
  either ignored or believed. Believing it lets anyone who has seen an order number read
  a conversation about someone else's parcel.

The thing that makes all three go away already exists. Signing in here is a six-digit code
sent to an address (ADR-004): there is no password to create and no separate sign-up, and
the first correct code makes the account. **An account is exactly "an address that has been
proven", which is exactly what a support conversation needs.**

## Decision

**A support conversation requires a signed-in account.** `/api/support` mounts
`requireSession` once at its top, like the wishlist and order history.

- Replies go only to the address on the account that opened the conversation.
- An order can be attached only if it is one of the caller's own; "that order is not on
  your account" is the same answer whether or not the number exists.
- Nothing a customer does sends email. The only message a conversation produces is the
  shop's reply, committed to the mail outbox with the reply itself.
- A guest who checked out is not locked out: signing in with the checkout address attaches
  their orders to the new account at verification (`claimGuestOrders`), so "ask about this
  order" works for them the moment they are in.

`/support` is a static, indexable page that says this in plain words — why there is no form
on it, what signing in involves, and where to look first — so it reads as a door rather
than a wall.

## What we give up

- **A visitor who will not sign in cannot write.** Somebody who wants to ask a question
  before buying, and will not give an address a code, has no way in. For a shop this size
  that is a real cost, and it is accepted.
- **One more step for a first-time writer**: an email, a code, then the form. The middleware
  sends a signed-out visitor to sign in and brings them straight back to the form.
- **No shared inbox address.** A customer who emails the sender address directly is
  outside this system.

## Why the tempting option is tempting

Because every shop has one, and because the cost of the code step is visible while the cost
of an open mail relay is not — until the sender is on a blocklist and sign-in codes stop
arriving for everyone. The anonymous form is also the one place in the shop an attacker
could make *us* send the email.

Revisit this if pre-purchase questions turn out to matter: the answer then is not an open
form but a form that asks for a code first — which is this, with the account created
quietly in the same step.
