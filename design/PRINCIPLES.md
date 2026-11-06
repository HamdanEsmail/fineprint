# Shared craft rules for Hamdan's four TinyFish builds

*Locked by Hamdan on 2026-11-03. Each product has its own visual world (see `fineprint/DESIGN.md`, `standing/DESIGN.md`, `groundwork/DESIGN.md`, `mcp/DESIGN.md`). These rules are the same in all four, so the set reads as one maker's work without looking like one template.*

## Evidence is the brand

1. **Evidence line on every record.** Source link, the exact read time in UTC, and the method (Agent, Fetch, Monitor). Same position in every card across all four products: the last line, small, muted, with the source as a real link.
2. **Screenshot beside the claim.** Anything read from a live site shows the page as it was read, as a thumbnail that opens full size.
3. **Honest states, in this order:** ok, empty ("the registry lists nothing"), unavailable (with the reason and the manual link), pending ("reading… 2 of 4"), error (what failed and what to do). Never a blank area, never a spinner without words.
4. **Spend meter in every footer.** "TinyFish spend $1.84 · 14 real changes · $0.13 per catch". Budget discipline is part of the story.
5. **Ambiguity is shown, not resolved for the user.** Candidate lists with distinguishing fields; "no match" with what was tried.

## Restraint

6. **One accent per product, muted.** Accents are earth and ink tones, not neon or saturated primaries. The accent marks the one thing that matters on a screen: a status, a change, a stamp. Everything else is surface and text.
7. **No gradients, no blur, no glow, no glassmorphism, no illustration packs, no decorative icons.** Depth comes from borders, offsets, rules and whitespace.
8. **Typography does the work.** Three faces at most per product; tabular numerals on every figure; a reading measure of 60 to 72 characters; no text under 11.5px.
9. **Motion is functional.** 150 to 240 ms, ease-out, one property. `prefers-reduced-motion` turns it all off.
10. **Phone first in layout, desktop first in density.** 16px gutters at 375px, no horizontal scroll, tables collapse to cards; on desktop, data stays dense and scannable.

## Accessibility and copy

11. Text contrast 4.5:1 or better everywhere, 7:1 for body on paper. Visible focus rings in the accent. Every control labelled; every screenshot has alt text naming the source and time.
12. Plain copy: sentences say what happened and when; labels are nouns; errors say what went wrong and what to do; no exclamation marks, no emoji in product UI.

## Deliverables that match

13. **README hero image**: the product's wordmark in its own world, one sentence, one real screenshot. **Social images**: same.
14. **README skeleton**, identical order in all four: what it does, live URL, how TinyFish is used (table), run locally, how it was built and verified, limits and posture.
15. **The four worlds, in one line each**: Fineprint is a stamped ledger of receipts; Standing is a clinical verification sheet; Groundwork is a drafting-table survey; the MCP project is a console for developers.
