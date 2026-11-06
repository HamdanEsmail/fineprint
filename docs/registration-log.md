# Registration log

- Run started: 2026-11-03T16:17:30.398Z (UTC)
- Base URL: https://fineprint.hamdanesmail12-7a9.workers.dev
- Limit: 20, delay after each new page: 10 s
- Outcome: 20 of 20 registered (19 new, 1 already watched), 1 skipped, 9 not tried

| # | Label | URL | Kind | Result | HTTP | Reason or page id |
|---|---|---|---|---|---|---|
| 1 | ChatGPT release notes | https://help.openai.com/en/articles/6825453-chatgpt-release-notes | rules | registered | 201 | 2b50b219-bba6-4cae-bec1-5a9c09e4bf09 |
| 2 | Claude release notes | https://docs.claude.com/en/release-notes/overview | other | registered | 201 | 233d04d4-77e6-4ebc-bc5f-15fecc07296a |
| 3 | Cloudflare Workers pricing | https://developers.cloudflare.com/workers/platform/pricing/ | pricing | registered | 201 | 63174341-721d-4c6f-b126-b8427dcf392b |
| 4 | UK visa decision waiting times | https://www.gov.uk/guidance/visa-decision-waiting-times-applications-outside-the-uk | rules | registered | 201 | 96e7efb1-df7e-4eed-8350-3ffefb02c5b4 |
| 5 | US visa bulletin | https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html | rules | skipped | 422 | unfetchable: target_http_error |
| 6 | Ryanair fees | https://www.ryanair.com/gb/en/useful-info/help-centre/fees | fees | registered | 201 | a71478d4-f246-4b63-b4a7-41507a6c4aad |
| 7 | Emirates baggage rules | https://www.emirates.com/ae/english/before-you-fly/baggage/ | rules | registered | 201 | 94fbe1aa-6178-4cab-8182-b19338976313 |
| 8 | Dubai Salik toll rates | https://www.dubai.ae/living/driving-transportation/road-toll-in-dubai-salik | fees | registered | 201 | abf474c4-3b2d-4363-b4b1-584cd3db38a8 |
| 9 | OpenAI API pricing | https://openai.com/api/pricing/ | pricing | registered | 201 | a534dcbb-b5a1-41e3-9f23-d241e0f5d544 |
| 10 | Anthropic pricing | https://www.anthropic.com/pricing | pricing | registered | 201 | d53d1b28-3480-42e1-a498-8224025dd840 |
| 11 | Gemini API pricing | https://ai.google.dev/gemini-api/docs/pricing | pricing | registered | 201 | ef7bbc62-fd9e-4610-8f61-4e512f263a27 |
| 12 | Vercel pricing | https://vercel.com/pricing | pricing | already watched (converted from the rehearsal row, monitor reused) | 409 | 987fec1f-35a2-4b4b-aee6-15ba6cbe32e9 |
| 13 | Cursor pricing | https://cursor.com/pricing | pricing | registered | 201 | 7979e74c-d2f1-4007-92d5-9c4ae77b2134 |
| 14 | Notion pricing | https://www.notion.com/pricing | pricing | registered | 201 | c5f20bfc-d934-4a0e-9cf8-36b64878c217 |
| 15 | Supabase pricing | https://supabase.com/pricing | pricing | registered | 201 | 0d4a7b7d-d55f-438e-96a8-9506f79e442e |
| 16 | GitHub pricing | https://github.com/pricing | pricing | registered | 201 | b841e0ec-ccb0-4543-9059-b4480aca1f4e |
| 17 | Netflix plans and pricing | https://help.netflix.com/en/node/24926 | pricing | registered | 201 | 8575a484-f23e-4038-b838-ef030337a227 |
| 18 | Spotify Premium UAE | https://www.spotify.com/ae/premium/ | pricing | registered | 201 | a263c8af-f438-4700-b1d7-74e7ded9ff0b |
| 19 | OpenAI terms of use | https://openai.com/policies/terms-of-use/ | policy | registered | 201 | 8ea654fb-ca62-4747-b409-6a047d09854b |
| 20 | OpenAI privacy policy | https://openai.com/policies/privacy-policy/ | policy | registered | 201 | a2434c6a-c1f5-4f2d-9386-54ce4c3a3584 |
| 21 | X terms of service | https://x.com/en/tos | policy | registered | 201 | 481e2838-68ec-4c8c-9bca-71fc2d0c740e |

Entries 22 to 30 of pages.json were not tried.

## Note on item 12

Vercel pricing was not created by this run. It is the day-1 webhook rehearsal row, converted into the real page just before registration: label and kind from `pages.json`, status active, schedule `0 0,12 * * *` (the first staggered slot), purpose set, and the rehearsal Monitor `e92c04d7-9243-4abe-b7fa-09a769c5a9c7` re-pointed and resumed rather than deleted. Its first version is the run-now pull of 3 Nov 2026 16:07 UTC (TinyFish run `bb6427b7-4d5f-4373-801e-66fd27c41b07`, trigger `pull`), and its baseline facts were extracted through the same single facts queue as the other pricing pages. So the 20 pages run on 20 Monitors.

Skipped: item 5, the US visa bulletin (`target_http_error` from TinyFetch); item 21 took its place.

## Swap on 6 Nov 2026: OpenAI API pricing out, DEWA slab tariff in

- 18:42 UTC: OpenAI API pricing (item 9, page `a534dcbb-b5a1-41e3-9f23-d241e0f5d544`) retired through `POST /api/admin/pages/:id/retire`. Its Monitor `b2423da3-93f3-4c22-9a02-4b92394263e8` was deleted; the page stays listed with status `retired`, and its 4 versions, runs and stored files are kept. The page rendered differently from one read to the next (a short table one time, the full table another), which produced false versions.
- 18:43 UTC: DEWA slab tariff (`https://www.dewa.gov.ae/en/consumer/billing/slab-tariff`, kind `fees`) added through the normal admin add, `POST /api/pages`: page `1fc7580e-9df9-40f5-8f8e-7f29b89babaa`, Monitor `690215c8-7f83-43fc-bd19-314cb32c028b`, schedule `13 7,19 * * *`, baseline version `5c6f7b4d-a984-4ff5-b0d7-dbd576c2653c` with screenshot and source; its facts run went through the single facts queue.
- The watch list is still 20 active pages on 20 Monitors.
