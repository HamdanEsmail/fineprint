# Fineprint: Stamped Ledger

*The world for the Time Machine build. Shared craft rules live in `../PRINCIPLES.md`; this file is the look. Copy to the repo root as `DESIGN.md` with `tokens.css` into the stylesheet entry.*

## The world in one paragraph

A notary's ledger with a stamp on it. Warm paper, black ink, serif headlines, monospace figures. Records are physical cards: a thin ink border and a hard offset shadow, never a soft blur. One colour, a deep oxblood, used as a stamp would be: on the mark beside the wordmark, on the one number that matters, on the timestamp of a real change. Everything else is paper and ink. The feeling: this was recorded carefully by someone who keeps receipts.

## Colour (muted on purpose)

| Token | Value | Use |
|---|---|---|
| `--paper` | `#f3eee4` | page |
| `--paper-raised` | `#fbf8f1` | cards, inputs |
| `--paper-sunken` | `#e9e2d3` | thumbnails, code, table stripes |
| `--ink` | `#191613` | text, borders, shadows, primary buttons |
| `--ink-soft` | `#3d3832` | body on cards |
| `--ink-muted` | `#6a635a` | secondary text, evidence lines |
| `--ink-faint` | `#978f82` | placeholders |
| `--rule` | `#d8cfbf` | hairlines |
| `--accent` | `#9b2335` | the stamp, the key figure, change timestamps, focus |
| `--accent-wash` | `#f1e3e3` | added text in diffs, row highlight |
| `--ok` `--warn` `--bad` | `#3f6b4f` `#9a6a1f` `#8c2f2f` | status chips only |

Contrast: ink on paper 14:1; muted on paper 5.4:1; white on accent 7.2:1. No dark mode: paper is the identity.

## Type

Fraunces (display, opsz axis, 500/600, italic 400) for titles, card titles, the wordmark and key figures. Inter (400/500/600) for body and UI. JetBrains Mono (400/500) for timestamps, prices, IDs, URLs, stamps and uppercase labels. Scale: hero 44/1.02, h1 32/1.1, h2 24/1.2, h3 17/1.3, body 15/1.55, small 13/1.45, label 11.5 mono uppercase tracking .06em, figure 28 Fraunces 500 tabular.

## Surfaces and edges

Radius 2px everywhere. Borders `1.5px solid var(--ink)` on cards, inputs, tables, stat blocks; `1px solid var(--rule)` inside them. Shadow `3px 3px 0 var(--ink)`; hover `4px 4px 0` with a 1px lift; press `1px 1px 0`. Focus `2px solid var(--accent)` offset 2px.

## Signature pieces

- **Wordmark + stamp.** `Fineprint` in Fraunces 600 20px, then the stamp: mono 10px uppercase tracking .14em, 1.5px accent border, accent text, 4px 6px padding, rotated -4deg, reading RECORDING, with a slow 1.2 s pulse dot while the recorder is live.
- **Catch card.** 92px screenshot thumbnail left; mono accent label row (time, kind); Fraunces 600 16px page title; one-line summary in ink-soft; a delta badge ink-on-paper ("−1 fact · ~2 blocks"); evidence line.
- **Stat blocks.** Ink background, paper text, figure in Fraunces; exactly one block per view may use the accent background, for the number that matters (real changes).
- **Timeline.** 2px ink track, 12px paper dots with 2px ink border; the selected version is a filled accent dot; inside a raised bordered panel.
- **Diff view.** Two columns on desktop, stacked on mobile. Added: accent-wash with a 3px accent left bar. Removed: paper-sunken, strike-through in ink-muted. Section headings in Fraunces. Never whole lines in red and green.
- **Page as-of scrubber.** A mono date input beside the timeline; the chosen version's card gets the stamp "AS OF 5 NOV 2026 09:12 UTC".

## Layout

Home: serif hero line built from live data ("The web changed its mind 14 times this week."), feed left, 200px stat column right; below 900px the column becomes a 2×2 grid under the hero. Page view: timeline strip, then the as-of card, then compare. Content max 1180px, gutters 24/48.

## Copy voice

Plain and specific: "Pro went from $20 to $25 on 5 November." Dates in UI `5 Nov 2026, 09:12 UTC`; in data, ISO.
