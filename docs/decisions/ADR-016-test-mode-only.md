# ADR-016 — The shop takes no real money: live payment keys are refused

**Status:** Accepted · 2026-09-19

## Context

Hæstore is deployed as a demonstration. It runs a real checkout — Stripe's Payment Element,
PayPal's buttons, an order state machine, reserved stock — against Stripe's test mode and
the PayPal sandbox, and it will never be switched to live payments.

Nothing in the payment code knows that. Stripe's test and live modes are the same API
reached with different keys; PayPal's sandbox and live are the same API at different hosts,
chosen by `PAYPAL_ENV`. So the difference between a demonstration and a shop that charges
cards is a value in an `.env` file, and a live key pasted into the deployment would not
fail. It would work. The first person to try the demo with their own card would be charged,
and the order would be fulfilled by nobody.

A warning at startup would be read by no one: the API runs in a container, and its log is
looked at when something is wrong, which by then it would not appear to be.

## Decision

**A live payment credential is a configuration error, and the processes refuse to start on
one — naming the key and this record.**

- **The API** refuses, at boot, a `STRIPE_SECRET_KEY` beginning `sk_live_` or `rk_live_`,
  and `PAYPAL_ENV=live` (`back-end/src/config/payment-mode.ts`, applied by the environment
  contract in `config/env.ts`). It exits the way it exits for any incoherent config, with
  every problem listed at once.
- **The storefront build** refuses a `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` beginning
  `pk_live_` (`front-end/src/lib/security/payment-mode.ts`, called from `next.config.ts`),
  so `cf:build` fails rather than shipping a checkout wired to a live account.
- **The templates say so** — `deploy/vps/.env.example` and
  `front-end/.env.production.example` carry test-mode placeholders and name this record.

What is not checked, because it cannot be:

- **`STRIPE_WEBHOOK_SECRET`** (`whsec_…`) looks the same in both modes. A live one is useless
  without a live secret key, which is refused.
- **A PayPal client id** carries no mode. The mode lives in `PAYPAL_ENV`, which is held to
  `sandbox` instead.

## What we give up

- **A switch.** Making the shop real is a code change — this guard removed, this record
  superseded — not an edit to `.env`. That is the point of it, but it is a cost if the shop
  is ever meant to trade.
- **PayPal's live host stays in the code** (`paypal.ts`'s host table), unreachable. Removing
  it would narrow the type for no behavioural gain, and the table is where a future live
  mode would go.

## Why the tempting option is tempting

Because configuration is supposed to be the thing that differs between environments, and a
guard in the code looks like the code second-guessing its operator. And because test keys
and live keys are "just keys": every payment tutorial treats the swap as a deployment step.

That is exactly the reasoning that makes a live key in a demo a quiet, working mistake. The
refusal costs nothing on every deploy that is correct, and stops the one that is not before
it takes anyone's money.
