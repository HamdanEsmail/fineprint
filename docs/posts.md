# Fineprint posts

Two posts for the TinyFish Time Machine bounty entry, in Hamdan's own words: one on X, one on LinkedIn. Both go out after the repository is public on 16 Nov 2026, and before entries close on 17 Nov 2026.

## Fill the figures on posting day

The posts carry three placeholders: `{pages}`, `{changes}` and `{days}`. One command reads all three from the live `/api/stats`:

```bash
curl -s https://fineprint.hamdanesmail12-7a9.workers.dev/api/stats | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("pages="+j.monitors.active,"changes="+j.changes,"days="+Math.floor((Date.now()-Date.parse(j.recording_since))/864e5))})'
```

It prints one line such as `pages=21 changes=12 days=4` (the reading on 8 Nov 2026, 06:56 UTC).

- `{pages}` is `monitors.active`: the pages watched now, each by its own Monitor.
- `{changes}` is `changes`: real changes, without the ones labelled layout-only.
- `{days}` is the whole days since `recording_since` (3 Nov 2026, 14:17 UTC). On 16 Nov it reads 12 before 14:17 UTC and 13 after.

## X

Under 280 characters including the link, which X counts as 23. Counted with the figures filled (two-digit `{changes}`): **272**. With a three-digit `{changes}`: 273.

```text
For the TinyFish Time Machine bounty I built Fineprint: a TinyFish Monitor reads each of {pages} pages of small print, and every real change is kept with a screenshot. {changes} caught in {days} days, one of them on Anthropic's pricing page on 7 Nov.

Have a look: https://fineprint.hamdanesmail12-7a9.workers.dev
```

The repository link goes in a reply, posted straight after, so the post keeps one link and its card:

```text
The code is public now: [REPO LINK: https://github.com/HamdanEsmail/fineprint, added after the flip]
```

**The image.** The card under the link shows `public/assets/social.png` (the Anthropic pricing catch of 7 Nov, before and after) when the live home carries the `og:image` and `twitter:card` tags. On 8 Nov 2026 the tags are in the code but not yet deployed: the live home has `og:title` and `og:description` only. Before posting, paste the link into the X composer and wait for the card: if it shows the image, post as it is; if not, attach `public/assets/social.png` to the post by hand.

## LinkedIn

Under 1,300 characters. Counted with the figures filled (two-digit `{changes}`) and the repository URL in its slot: **1,274**.

```text
For the TinyFish Time Machine bounty I built Fineprint, a dated record of the web's small print.

It watches the pages people agree to without reading: pricing, fees, terms, privacy policies, visa and baggage rules. When one really changes, Fineprint keeps the date, the text, a full-page screenshot and the HTML source, so anyone can see what a page said on any day and which words changed.

TinyFish Monitor does the core work: each page has its own Monitor, which reads it twice a day, and every version comes from a Monitor run. Without the Monitors, nothing new is recorded. Browser takes the screenshots, Fetch keeps the sources, Agent reads price tables and Search finds a site's small print.

One catch: on 7 Nov, Anthropic's pricing page added Claude Code to the Pro plan's list and removed the "Claude Code included" lines under Pro, Max and Ultra. Both versions are kept, the changed words marked. Noise like timestamps never becomes a version, and a change that only rearranges the same words and prices, like GitHub's pricing table on 5 Nov, is kept but labelled layout-only.

So far: {pages} pages, {changes} real changes in {days} days, each with a screenshot.

Have a look: https://fineprint.hamdanesmail12-7a9.workers.dev
The code: [REPO LINK: https://github.com/HamdanEsmail/fineprint, added after the flip]
```

LinkedIn builds its preview from the first link, the live site.

## Where the facts come from

- The Anthropic catch: [the comparison of 3 Nov 2026 21:03 UTC and 7 Nov 2026 21:03 UTC](https://fineprint.hamdanesmail12-7a9.workers.dev/pages/d53d1b28-3480-42e1-a498-8224025dd840/compare?from=d0f38678-44d9-45e2-b411-96efa1efb646&to=100dbf11-07db-483c-9f00-54d1b7471ed5): under Pro, "Claude Code" is new in the plan's list, and "Claude Code included" is removed under Pro, Max and Ultra.
- The GitHub layout-only change: [GitHub pricing, 5 Nov 2026 14:38 UTC](https://fineprint.hamdanesmail12-7a9.workers.dev/pages/b841e0ec-ccb0-4543-9059-b4480aca1f4e/compare?to=8b2800f4-e565-4de9-8770-fe39f9a2e545), labelled "Same words and figures, different structure."
- How TinyFish is used: the table in the [README](../README.md#how-tinyfish-is-used) and on [About](https://fineprint.hamdanesmail12-7a9.workers.dev/about#tinyfish).

## After posting

Paste the two post links into their slots in [submission.md](submission.md).
