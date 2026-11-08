# Fineprint posts

Two posts for the TinyFish Time Machine bounty entry, in Hamdan's own words: one on X, one on LinkedIn. Both go out on 8 Nov 2026, once the repository is public, and before entries close on 17 Nov 2026.

## Fill the figures on posting day

The posts carry three placeholders: `{pages}`, `{changes}` and `{days}`. One command reads all three from the live `/api/stats`:

```bash
curl -s https://fineprint.hamdanesmail12-7a9.workers.dev/api/stats | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("pages="+j.monitors.active,"changes="+j.changes,"days="+Math.floor((Date.now()-Date.parse(j.recording_since))/864e5))})'
```

It prints one line such as `pages=21 changes=13 days=5` (the reading on 8 Nov 2026, 16:47 UTC).

- `{pages}` is `monitors.active`: the pages watched now, each by its own Monitor.
- `{changes}` is `changes`: real changes, without the ones labelled layout-only.
- `{days}` is the whole days since `recording_since` (3 Nov 2026, 14:17 UTC). On 8 Nov it reads 5.

## X

Under 280 characters including the link, which X counts as 23. Counted with the 8 Nov figures filled (21, 13, 5): **273**.

```text
For the TinyFish Time Machine bounty I built Fineprint: a TinyFish Monitor watched each of {pages} pages of small print, and every real change is kept with a screenshot. {changes} caught in {days} days, one of them on Anthropic's pricing page on 7 Nov.

Have a look: https://fineprint.hamdanesmail12-7a9.workers.dev
```

The repository link goes in a reply, posted straight after, so the post keeps one link and its card:

```text
The code is public now: https://github.com/HamdanEsmail/fineprint
```

**The image.** The card under the link shows `public/assets/social.png` (the Anthropic pricing catch of 7 Nov, before and after): the live home has carried the `og:image` and `twitter:card` tags since 8 Nov 2026, 08:27 UTC. Before posting, paste the link into the X composer and wait for the card: if it shows the image, post as it is; if not, attach `public/assets/social.png` to the post by hand.

## LinkedIn

Under 1,300 characters. Counted with the 8 Nov figures filled (21, 13, 5) and the repository URL in its slot: **1,282**.

```text
For the TinyFish Time Machine bounty I built Fineprint, a dated record of the web's small print.

It watches the pages people agree to without reading: pricing, fees, terms, privacy policies, visa and baggage rules. When one really changes, Fineprint keeps the date, the text, a full-page screenshot and the HTML source, so anyone can see what a page said on any day and which words changed.

TinyFish Monitor does the core work: each watched page has its own Monitor, which reads it twice a day, and every version comes from a Monitor run. Without the Monitors, nothing new is recorded. Browser takes the screenshots, Fetch keeps the sources, Agent reads price tables and Search finds a site's small print.

One catch: on 7 Nov, Anthropic's pricing page added Claude Code to the Pro plan's list and removed the "Claude Code included" lines under Pro, Max and Ultra. Both versions are kept, the changed words marked. Noise like timestamps never becomes a version, and a change that only rearranges the same words and prices, like GitHub's pricing table on 5 Nov, is kept but labelled layout-only.

In {days} days: {pages} pages watched, {changes} real changes, each with a screenshot.

Have a look: https://fineprint.hamdanesmail12-7a9.workers.dev
The code: https://github.com/HamdanEsmail/fineprint
```

LinkedIn builds its preview from the first link, the live site.

## Where the facts come from

- The Anthropic catch: [the comparison of 3 Nov 2026 21:03 UTC and 7 Nov 2026 21:03 UTC](https://fineprint.hamdanesmail12-7a9.workers.dev/pages/d53d1b28-3480-42e1-a498-8224025dd840/compare?from=d0f38678-44d9-45e2-b411-96efa1efb646&to=100dbf11-07db-483c-9f00-54d1b7471ed5): under Pro, "Claude Code" is new in the plan's list, and "Claude Code included" is removed under Pro, Max and Ultra.
- The GitHub layout-only change: [GitHub pricing, 5 Nov 2026 14:38 UTC](https://fineprint.hamdanesmail12-7a9.workers.dev/pages/b841e0ec-ccb0-4543-9059-b4480aca1f4e/compare?to=8b2800f4-e565-4de9-8770-fe39f9a2e545), labelled "Same words and figures, different structure."
- How TinyFish is used: the table in the [README](../README.md#how-tinyfish-is-used) and on [About](https://fineprint.hamdanesmail12-7a9.workers.dev/about#tinyfish).

## After posting

Paste the two post links into their slots in [submission.md](submission.md).
