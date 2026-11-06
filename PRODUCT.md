# Product

Fineprint is a public version history for the pages people sign up under: pricing, fees, terms, privacy policies, visa and baggage rules. It records each real change with a screenshot and shows what was true on any date.

## Platform
web

## Stack
Cloudflare Worker (Hono), server-rendered HTML with hono/jsx, D1, R2. No client framework.

## Users
- Judges of the TinyFish Time Machine bounty, on a laptop, with a few minutes: they want proof that real changes were caught, a diff they can read, and to add a page of their own.
- Developers who want the JSON API or the export.
- Readers arriving from a post on X or LinkedIn, mostly on a phone.

## Product Purpose
Answer three questions: what did this page say on date X, what changed between A and B, what changed this week.

## Positioning
A notary's ledger for the web's small print. Evidence first: every claim sits beside the screenshot, the source and the read time.

## Operating Context
Read-mostly. Twenty curated pages checked twice a day by TinyFish Monitor; four public slots that expire after seven days. Runs on a small fixed budget, shown in the footer.

## Capabilities and Constraints
- Records only from the moment a page is added. No earlier history.
- Text is the diff; screenshots are evidence.
- Works without JavaScript. Phone first.

## Brand Commitments
The Stamped Ledger world in DESIGN.md is fixed: paper, ink, one oxblood accent used like a stamp. No dark mode. No gradients, blur, glow, illustration packs or decorative icons.

## Evidence on Hand
Live data at the production URL: recorded changes with screenshots across 20 pages, a noise count by reason, and a spend ledger.

## Product Principles
See design/PRINCIPLES.md: evidence line, screenshot beside the claim, honest states, spend meter, restraint, plain copy.

## Accessibility & Inclusion
WCAG AA contrast (7:1 for body text), visible focus, labelled controls, alt text naming source and time, reduced motion respected, no text under 11.5px.
