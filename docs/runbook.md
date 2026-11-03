# Fineprint deploy runbook

How to take Fineprint from the repo to a live Worker that is recording 20 pages. Written for Git Bash on Windows. Each step says what success looks like; if you do not see it, stop and read "If something goes wrong" at the end.

Do this only when the Cloudflare account is ready: R2 is enabled and the API token in `../.cloudflare.env` may use Workers, D1 and R2. The steps run in this order on purpose: the first deploy creates the Worker so that `secret put` has something to attach to, and the webhook rehearsal comes before any page is registered, so a payload shape surprise costs one test Monitor and not twenty.

## How the blocks work

- **Every block stands alone.** Each one starts with `cd` into the repo and re-reads what it needs (the Worker URL, a secret's length, the rehearsal state) from the files, so it runs correctly in a fresh shell, one block per shell. Nothing depends on a variable or a function from an earlier block. Where a block needs a value that only you can know (the D1 id, the Worker URL, a payload id), it says `<paste ...>`; replace that, and the block checks the shape of what you pasted before it uses it.
- **`STOP` means stop.** A guard that fails prints `STOP: ...` and ends the shell with `exit 1` before anything after it runs. Fix what it says, then run the block again from its top (open a new terminal first if you are working in an interactive one).
- A block with several commands is meant to run as a whole. Do not skip lines.

## Rules for the secret files

- **Cloudflare token.** This machine's environment holds an old `CLOUDFLARE_API_TOKEN` that Cloudflare rejects. Every wrangler command that touches the real account is therefore prefixed with
  `CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r')`
  which reads the right token from `../.cloudflare.env` for that one command. Never echo, print, log or commit that value, and never copy that file into the repo. Do not `cat` the file.
- **TinyFish key.** The shell's `TINYFISH_API_KEY` is also stale (TinyFish answers 401). The key to use is the one in `.dev.vars`. Commands below read it from there; never from the environment.
- **Fineprint's own secrets** (`WEBHOOK_SECRET`, `ADMIN_TOKEN`) live in `../.fineprint-prod.env`, one level above the repo, so no `git add` can ever pick them up. Never `cat` it. Check it with `awk -F= '{print $1, length($2)}' ../.fineprint-prod.env`, which prints names and lengths only.
- **`wrangler tail` prints the webhook secret.** The Worker's log line for a webhook is `POST https://<worker>/hooks/monitor/<WEBHOOK_SECRET>`. Every `tail` command in this runbook is piped through a `sed` that replaces the secret with `<redacted>`. Raw `tail` output must never be pasted into a chat, an issue, a commit or a log; if you ever run `tail` without the `sed`, treat the output as secret and do not copy it anywhere.
- If wrangler stops with "More than one account available", add `CLOUDFLARE_ACCOUNT_ID=<the account id>` (not a secret) in front of the same command.

## 0. Checks

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
git status --short            # nothing you do not expect
npm run check || { echo "STOP: npm run check failed"; exit 1; }
test -f .dev.vars && echo ".dev.vars present" || { echo "STOP: .dev.vars is missing"; exit 1; }
test -f ../.cloudflare.env && echo ".cloudflare.env present" || { echo "STOP: ../.cloudflare.env is missing"; exit 1; }
test -f ../.fineprint-prod.env && echo "WARNING: prod secrets file exists already, step 5 keeps it" || echo "no prod secrets file yet (step 5 makes it)"
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler whoami
```

Success: `npm run check` ends green, both files are present, and `wrangler whoami` names the right account (it may not list an API token's permissions; steps 1 and 2 show at once whether D1 and R2 are allowed).

## 1. Create the D1 database

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 create fineprint
```

Success: wrangler reports the database and prints a `database_id` (a UUID). If wrangler offers to add the binding to the config itself, answer no; the binding is already there and only the id is missing. Paste the id into `wrangler.jsonc`, replacing `TBD-after-create`:

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
DB_ID=<paste the database_id here>
[[ $DB_ID =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] || { echo "STOP: DB_ID is not a UUID"; exit 1; }
grep -q 'TBD-after-create' wrangler.jsonc || { echo "STOP: wrangler.jsonc has no TBD-after-create left to replace"; exit 1; }
sed -i "s/TBD-after-create/$DB_ID/" wrangler.jsonc
grep -n database_id wrangler.jsonc     # shows the UUID, not TBD-after-create
```

## 2. Create the R2 bucket

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler r2 bucket create fineprint
```

Success: "Created bucket 'fineprint'". An "R2 is not enabled" error means the account step before this runbook is not done: stop and tell Hamdan.

## 3. Apply the migration to the remote database

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npm run migrate:remote
```

Answer `y` if wrangler asks "Ok to proceed?". Success: `0001_init.sql` applied. Confirm the tables:

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Success: `diff_cache`, `pages`, `public_adds`, `runs`, `spend`, `versions` are listed (with wrangler's own `d1_migrations` and a few internal tables). When its output is piped, wrangler prints JSON instead of a table; the content is the same.

## 4. First deploy

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npm run deploy
```

Success: wrangler prints the bindings (DB, STORE, the hourly cron) and a URL of the form `https://fineprint.<subdomain>.workers.dev`. Write that URL down; it is `<url>` below. If wrangler says the account has no workers.dev subdomain, Hamdan registers one in the dashboard (Workers & Pages, Overview) and the deploy is run again.

At this point the Worker answers, but it has no secrets: it has no admin and rejects every webhook. That is expected for the next two steps.

## 5. Secrets

Make the two secrets Fineprint owns, once. Both are 48 hex characters. The file lives outside the repo. The block keeps an existing file and shows only names and lengths.

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
test -f ../.fineprint-prod.env || printf 'WEBHOOK_SECRET=%s\nADMIN_TOKEN=%s\n' \
  "$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")" \
  "$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")" > ../.fineprint-prod.env
awk -F= '{print $1, length($2)}' ../.fineprint-prod.env
```

Success: exactly `WEBHOOK_SECRET 48` and `ADMIN_TOKEN 48`. Now put all three secrets on the Worker, piping each value in so it is never shown. The block first checks that none of the three is empty, because an empty secret would be uploaded as it is:

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
for n in WEBHOOK_SECRET ADMIN_TOKEN; do
  [ "$(grep -m1 "^$n=" ../.fineprint-prod.env | cut -d= -f2- | tr -d '\r\n' | wc -c | tr -d ' ')" = 48 ] || { echo "STOP: $n is missing or not 48 characters in ../.fineprint-prod.env"; exit 1; }
done
[ -n "$(grep -m1 '^TINYFISH_API_KEY=' .dev.vars | cut -d= -f2- | tr -d '\r\n')" ] || { echo "STOP: TINYFISH_API_KEY is missing in .dev.vars"; exit 1; }
grep -m1 '^WEBHOOK_SECRET=' ../.fineprint-prod.env | cut -d= -f2- | tr -d '\r\n' | CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler secret put WEBHOOK_SECRET &&
grep -m1 '^ADMIN_TOKEN=' ../.fineprint-prod.env | cut -d= -f2- | tr -d '\r\n' | CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler secret put ADMIN_TOKEN &&
grep -m1 '^TINYFISH_API_KEY=' .dev.vars | cut -d= -f2- | tr -d '\r\n' | CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler secret put TINYFISH_API_KEY &&
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler secret list
```

Success: each `secret put` says "Success! Uploaded secret ..." and `secret list` shows `ADMIN_TOKEN`, `TINYFISH_API_KEY`, `WEBHOOK_SECRET`.

## 6. Point `PUBLIC_BASE_URL` at the Worker and deploy again

`PUBLIC_BASE_URL` is the root of every webhook URL Fineprint gives TinyFish, so it must be the real address before a single page is added. Set it to the URL from step 4, keep local development on localhost, and deploy:

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
BASE=<url from step 4>        # e.g. https://fineprint.<subdomain>.workers.dev, no trailing slash
[[ $BASE =~ ^https://[^/]+$ ]] || { echo "STOP: BASE must look like https://fineprint.<subdomain>.workers.dev"; exit 1; }
sed -i "s#\"PUBLIC_BASE_URL\": \"[^\"]*\"#\"PUBLIC_BASE_URL\": \"$BASE\"#" wrangler.jsonc
grep -n PUBLIC_BASE_URL wrangler.jsonc          # shows the workers.dev URL

# Local development keeps working on localhost (a .dev.vars value overrides the wrangler.jsonc var in `wrangler dev`):
grep -q '^PUBLIC_BASE_URL=' .dev.vars || printf '\nPUBLIC_BASE_URL=http://localhost:8787\n' >> .dev.vars

CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npm run deploy
```

Success: the deploy lists `PUBLIC_BASE_URL` among the vars with the workers.dev address. From here on every block reads the Worker URL back from `wrangler.jsonc` and refuses to run while it is still the localhost default.

## 7. Commit the config and smoke test

Commit only `wrangler.jsonc` (the path list after `--` keeps anything else that is staged out of the commit). Then push.

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
git add -- wrangler.jsonc && git -c user.name="Hamdan Esmail" -c user.email="hamdan@alsayaddc.com" commit -m "chore: production D1 id and base URL" -- wrangler.jsonc
```

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
BASE=$(grep -o '"PUBLIC_BASE_URL": *"[^"]*"' wrangler.jsonc | cut -d'"' -f4)
[[ $BASE =~ ^https://[^/]+$ ]] || { echo "STOP: PUBLIC_BASE_URL in wrangler.jsonc is not the workers.dev URL (step 6)"; exit 1; }
curl -s "$BASE/api/stats"; echo
curl -s -o /dev/null -w "webhook with a wrong secret: HTTP %{http_code}\n" -X POST "$BASE/hooks/monitor/not-the-secret" -d '{}'
```

Success: `/api/stats` answers with JSON whose counts (`pages`, `runs`, `versions`, `spend_usd`) are all 0, and the wrong secret gets `HTTP 404`.

## 8. Webhook rehearsal (spec section 9)

Purpose: see one real scheduled Monitor payload arrive at the deployed handler before 20 Monitors are created. The spike Monitor `e92c04d7-9243-4abe-b7fa-09a769c5a9c7` (it watches `https://vercel.com/pricing`) is re-pointed at the Worker with a 10-minute schedule, runs once or twice, and is paused again. Cost: about $0.005 per check, so under $0.02 if it is paused promptly. **A Monitor left active on `*/10 * * * *` costs about $0.72 a day**, and if its page row is gone every payload it sends is a 404. So the pause in 8f is not optional, and if you abandon the rehearsal at any point you pause the Monitor first (see "If something goes wrong").

Every block below stands alone (see "How the blocks work"). The spike Monitor is driven by `scripts/spike-monitor.mjs`, which reads the TinyFish key from `.dev.vars`, the webhook secret from `../.fineprint-prod.env` and the Worker URL from `wrangler.jsonc`, prints only an HTTP status, an error code and a few facts about the Monitor (never the key, the secret, a webhook URL or a response body), and exits 1 unless TinyFish answered 2xx.

The handler refuses payloads for Monitors it does not know (404, nothing stored), so the spike Monitor needs a temporary page row first.

**8a. Look at the spike Monitor.**

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
node scripts/spike-monitor.mjs GET --expect paused || { echo "STOP: the spike Monitor could not be read or is not paused"; exit 1; }
```

Success: `HTTP 200` and `monitor status=paused`.

**8b. Temporary page row for the spike Monitor.**

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote -y --command "INSERT INTO pages (id, url, label, kind, monitor_id, schedule_cron, status, added_by, ignore_patterns, created_at) VALUES ('rehearsal-spike', 'https://vercel.com/pricing', 'Webhook rehearsal (spike monitor)', 'other', 'e92c04d7-9243-4abe-b7fa-09a769c5a9c7', '*/10 * * * *', 'paused', 'admin', '[]', strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
```

Success: wrangler reports the command executed (1 row written).

**8c. Re-point the spike Monitor and resume it.** Two PATCHes, because TinyFish's PATCH is a union: the edit must carry `schedule_cron`, and the status change must be sent alone. The block first checks that the temporary row from 8b exists, so the Monitor is never started with nothing to receive its payloads, and it stops at the first PATCH that fails.

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote --json --command "SELECT id FROM pages WHERE id = 'rehearsal-spike'" | grep -q '"rehearsal-spike"' || { echo "STOP: the temporary page row from 8b is missing; the Monitor was not touched"; exit 1; }
node scripts/spike-monitor.mjs PATCH --webhook || { echo "STOP: re-pointing the Monitor failed; it was not resumed"; exit 1; }
node scripts/spike-monitor.mjs PATCH '{"status":"active"}' || { echo "STOP: resuming failed; run 8f to make sure the Monitor is paused"; exit 1; }
node scripts/spike-monitor.mjs GET --expect active || { echo "STOP: the Monitor is not active; run 8f"; exit 1; }
```

Success: `HTTP 200` for both PATCHes, then `status=active`, `schedule_cron="*/10 * * * *"`, `webhook_is_ours=true`. From this moment the Monitor is billing: the clock for 8f is running.

**8d. Wait for one scheduled payload.** The schedule fires every 10 minutes, so allow up to 12. The loop polls every 30 seconds for 8 minutes (16 times, under a 10-minute tool timeout) and stops as soon as a run for the temporary page exists. If it ends without one, run the same block once more.

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
for i in $(seq 1 16); do
  date -u +"%H:%M:%S UTC, check $i of 16"
  CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote --json --command "SELECT outcome, raw_key FROM runs WHERE page_id = 'rehearsal-spike'" | grep -q '"raw_key"' && break
  sleep 30
done
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote --command "SELECT id, outcome, raw_key, received_at FROM runs WHERE page_id = 'rehearsal-spike'"
```

Success: a row with an `outcome` and a `raw_key` like `raw/<payload id>.json`. No row after the second run (about 12 minutes in all): pause the Monitor (8f, first block) and see "If something goes wrong".

**8e. Copy the raw payload out of R2, scan it for secrets, and put it in the fixtures** (R55). The payload goes to `unchanged.json` only if its `outcome` is `unchanged`. Any other outcome is saved as `recorded-<outcome>.json`, and `changed-real.json` and `changed-noise.json` are never overwritten (their tests seed the Vercel base text).

The payload comes from TinyFish, and TinyFish can echo back what it was given, including the webhook URL with the secret in it. So the file is first fetched to `../rehearsal-payload.json`, outside the repo, scanned without printing anything, and copied into `tests/fixtures/webhooks/` only if the scan is clean. The scan looks for the three secret values themselves (`WEBHOOK_SECRET` and `ADMIN_TOKEN` from `../.fineprint-prod.env`, the TinyFish key from `.dev.vars`) and for the text `/hooks/monitor/`, and it never prints a value, only which one it found.

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
RAW_KEY=<paste raw_key from 8d>         # like raw/<payload id>.json
OUTCOME=<paste outcome from 8d>         # unchanged, changed, baseline, ...
[[ $RAW_KEY =~ ^raw/[A-Za-z0-9_.-]{1,200}\.json$ ]] || { echo "STOP: RAW_KEY does not look like raw/<id>.json"; exit 1; }
[[ $OUTCOME =~ ^[a-z_]{1,32}$ ]] || { echo "STOP: OUTCOME must be a plain lower-case word"; exit 1; }
if [ "$OUTCOME" = "unchanged" ]; then DEST=tests/fixtures/webhooks/unchanged.json; else DEST="tests/fixtures/webhooks/recorded-$OUTCOME.json"; fi
TMP=../rehearsal-payload.json
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler r2 object get "fineprint/$RAW_KEY" --remote --file "$TMP" || { echo "STOP: could not fetch the payload from R2"; exit 1; }

# Secret scan: values are read into variables and compared, never printed.
FOUND=0
for spec in "../.fineprint-prod.env:WEBHOOK_SECRET" "../.fineprint-prod.env:ADMIN_TOKEN" ".dev.vars:TINYFISH_API_KEY"; do
  file=${spec%%:*}; name=${spec##*:}
  val=$(grep -m1 "^$name=" "$file" | cut -d= -f2- | tr -d '\r\n')
  if [ -z "$val" ]; then echo "STOP: cannot read $name from $file, so the scan cannot be trusted"; FOUND=1
  elif grep -qF -- "$val" "$TMP"; then echo "STOP: the payload contains the value of $name"; FOUND=1; fi
done
grep -qF '/hooks/monitor/' "$TMP" && { echo "STOP: the payload contains a /hooks/monitor/ url"; FOUND=1; }
[ "$FOUND" = 0 ] || { echo "The payload stays at ../rehearsal-payload.json, outside the repo. Do not copy it anywhere and do not paste it. Report which value was found."; exit 1; }

# Names only, never values. Look for any field that could hold a webhook url, a secret or a key.
node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
console.log("top-level keys:", Object.keys(j).join(", "));
const paths = new Set();
const walk = (v, p) => { if (Array.isArray(v)) v.slice(0, 3).forEach((x) => walk(x, p + "[]")); else if (v && typeof v === "object") for (const k of Object.keys(v)) { paths.add(p + "." + k); walk(v[k], p + "." + k); } };
walk(j, "");
console.log("key paths (names only):", [...paths].slice(0, 60).join(" "));
' "$TMP" 2>/dev/null || { echo "STOP: the payload is not valid JSON"; exit 1; }
cp "$TMP" "$DEST" && rm -f "$TMP" && echo "saved to $DEST"
```

Success: no `STOP` line, `saved to tests/fixtures/webhooks/...`, and the two lists of key names (expect `id`, `fetch_monitor_id`, `outcome`, `results`, and the other fields of the documented payload). **Read the key-path list: if any name looks like a webhook url, a secret, a token or a key (for example `webhook_url`), do not commit the file; its value is not in the payload as far as the scan can tell, but ask Hamdan first.** Note the outcome and the keys in `docs/build-log.md`.

**8f. Pause the spike Monitor, verify it, and only then remove the temporary rows.** Two blocks. Run the first one even if you abandoned the rehearsal earlier.

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
node scripts/spike-monitor.mjs PATCH '{"status":"paused"}' || { echo "STOP: the pause failed. Run this block again until it works; do not go on, the Monitor is still billing"; exit 1; }
node scripts/spike-monitor.mjs GET --expect paused || { echo "STOP: the Monitor is not paused. Run this block again; do not delete anything"; exit 1; }
```

Success: `HTTP 200` twice and `monitor status=paused`.

Wait a minute after the payload before the second block; if the outcome was `changed` the handler started a capture for the temporary page, which should finish before its rows go. The second block checks again that the Monitor is paused and deletes nothing if it is not. It keeps the spend rows and the R2 raw object.

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
BASE=$(grep -o '"PUBLIC_BASE_URL": *"[^"]*"' wrangler.jsonc | cut -d'"' -f4)
[[ $BASE =~ ^https://[^/]+$ ]] || { echo "STOP: PUBLIC_BASE_URL in wrangler.jsonc is not the workers.dev URL (step 6)"; exit 1; }
node scripts/spike-monitor.mjs GET --expect paused || { echo "STOP: the spike Monitor is not paused; nothing was deleted. Run the first 8f block"; exit 1; }
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote -y --command "DELETE FROM versions WHERE page_id='rehearsal-spike'; DELETE FROM runs WHERE page_id='rehearsal-spike'; DELETE FROM pages WHERE id='rehearsal-spike'" || { echo "STOP: the delete failed"; exit 1; }
curl -s "$BASE/api/stats"; echo
```

Success: `/api/stats` shows 0 for `pages`, `runs` and `versions` again, with `spend_usd` a little above 0. The `pages` row must be gone before step 9, because `https://vercel.com/pricing` is one of the 20 and its url is unique (step 9 checks this and refuses to run otherwise).

**8g. Check the handler against the real payload, and commit it.** The block re-derives the file name from the outcome, scans the file once more right before it is staged (the same no-echo scan as in 8e), runs the webhook tests, and commits only that file.

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
OUTCOME=<paste outcome from 8d>         # the same word as in 8e
[[ $OUTCOME =~ ^[a-z_]{1,32}$ ]] || { echo "STOP: OUTCOME must be a plain lower-case word"; exit 1; }
if [ "$OUTCOME" = "unchanged" ]; then DEST=tests/fixtures/webhooks/unchanged.json; else DEST="tests/fixtures/webhooks/recorded-$OUTCOME.json"; fi
[ -f "$DEST" ] || { echo "STOP: $DEST does not exist (run 8e)"; exit 1; }

FOUND=0
for spec in "../.fineprint-prod.env:WEBHOOK_SECRET" "../.fineprint-prod.env:ADMIN_TOKEN" ".dev.vars:TINYFISH_API_KEY"; do
  file=${spec%%:*}; name=${spec##*:}
  val=$(grep -m1 "^$name=" "$file" | cut -d= -f2- | tr -d '\r\n')
  if [ -z "$val" ]; then echo "STOP: cannot read $name from $file, so the scan cannot be trusted"; FOUND=1
  elif grep -qF -- "$val" "$DEST"; then echo "STOP: $DEST contains the value of $name"; FOUND=1; fi
done
grep -qF '/hooks/monitor/' "$DEST" && { echo "STOP: $DEST contains a /hooks/monitor/ url"; FOUND=1; }
[ "$FOUND" = 0 ] || exit 1

npx vitest run tests/webhook.test.ts || { echo "STOP: the webhook tests fail with the real payload; do not commit, do not register pages; report which test failed and the payload's keys"; exit 1; }
git add -- "$DEST" && git -c user.name="Hamdan Esmail" -c user.email="hamdan@alsayaddc.com" commit -m "test: real webhook payload recorded in the rehearsal" -- "$DEST"
```

Success: every test in `tests/webhook.test.ts` passes with the real fixture in place (the tests seed their own page from whichever fixture they load), and one commit holds only the fixture. A failure here means the real payload differs from the documented shape: stop, do not register pages.

## 9. Register the 20 pages

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
BASE=$(grep -o '"PUBLIC_BASE_URL": *"[^"]*"' wrangler.jsonc | cut -d'"' -f4)
[[ $BASE =~ ^https://[^/]+$ ]] || { echo "STOP: PUBLIC_BASE_URL in wrangler.jsonc is not the workers.dev URL (step 6)"; exit 1; }
ADMIN_TOKEN=$(grep -m1 '^ADMIN_TOKEN=' ../.fineprint-prod.env | cut -d= -f2- | tr -d '\r\n')
[ "${#ADMIN_TOKEN}" = 48 ] || { echo "STOP: ADMIN_TOKEN is missing or not 48 characters in ../.fineprint-prod.env"; exit 1; }
export ADMIN_TOKEN
# The rehearsal row must be gone: a leftover row for vercel.com/pricing would answer 409 already_watched, which counts as registered.
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote --json --command "SELECT COUNT(*) AS n FROM pages WHERE id = 'rehearsal-spike'" | grep -q '"n": 0' || { echo "STOP: the rehearsal page row still exists (8f); registering now would count it as one of the 20"; exit 1; }
node scripts/register-pages.mjs --base "$BASE" --limit 20
```

What it does: first checks the admin token (a wrong token would otherwise create public pages that expire in 7 days), then adds the 30 entries of `pages.json` in order, one at a time, waiting 10 seconds after each new page, until 20 are registered. A page that TinyFetch cannot read (bot-blocked, login wall) is skipped with its reason and the next one is tried; pages already added count as registered, so running the command again after an interruption just continues. Expect about 5 to 10 minutes (each add runs TinyFetch and a billed first Monitor check, then waits 10 seconds); run it as a background task if your shell limits a command to 10 minutes.

Cost ceiling, from the constants in `src/core/`: 20 baseline checks ($0.005) and 20 screenshots ($0.002) is about $0.14; the facts runs for the pricing and fees pages (13 if the first 20 entries all register, at most 15) are at most 6 steps at $0.016 each, so under $1.50. About $1.60 in all. Everything is recorded in the `spend` table.

Success: it ends with `20 of 20 registered`, exit code 0, and writes `docs/registration-log.md`. Skipped pages are listed there with their reasons. The log is rewritten after every entry, so an interrupted run leaves a partial one; a re-run replaces it, so copy it aside first if its skipped entries matter (`cp docs/registration-log.md ../registration-log-run1.md`).

## 10. Commit the registration log

The README's "tried and skipped" table comes from this file. It holds page urls, labels and ids, and no secret.

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
grep -q '20 of 20 registered' docs/registration-log.md || { echo "STOP: docs/registration-log.md does not say 20 of 20 registered; finish step 9 first"; exit 1; }
git add -- docs/registration-log.md && git -c user.name="Hamdan Esmail" -c user.email="hamdan@alsayaddc.com" commit -m "docs: registration log for the first 20 pages" -- docs/registration-log.md
```

## 11. Check that recording has started

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
BASE=$(grep -o '"PUBLIC_BASE_URL": *"[^"]*"' wrangler.jsonc | cut -d'"' -f4)
[[ $BASE =~ ^https://[^/]+$ ]] || { echo "STOP: PUBLIC_BASE_URL in wrangler.jsonc is not the workers.dev URL (step 6)"; exit 1; }
curl -s "$BASE/api/stats"; echo
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote --command "SELECT capture_status, COUNT(*) AS n FROM versions GROUP BY capture_status"
```

- Straight after step 9: `pages` is 20 and `versions` is 20 in the stats.
- Within about 10 minutes of the last add: screenshots and sources are done, so every version is `complete` or `awaiting_facts`.
- Over the next 30 minutes or so: the pricing and fees pages move from `awaiting_facts` to `complete`, one at a time. Fineprint runs the facts extractions as a serial queue (one Agent run at a time, about 1 to 2 minutes each) after the pages are added; registration does not wait for it.
- A version still `pending` or `partial` after 10 minutes failed a capture. Find out why:

```bash
cd "/c/Tinyfish Bounties/fineprint" || exit 1
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote --command "SELECT page_id, capture_status, capture_attempts, capture_error FROM versions WHERE capture_status NOT IN ('complete', 'awaiting_facts')"
```

The hourly cron is live and repairs captures: each tick it retries up to 3 versions that are `pending` or `partial`, are older than 10 minutes and have attempts left (3 attempts in all). A version that is still stuck after a few ticks is out of attempts, and its `capture_error` says which capture failed.

The clock has started when `pages` is 20 and the first hourly and twice-daily Monitor checks begin to arrive. Record: the `/api/stats` output, `docs/registration-log.md`, the rehearsal payload's outcome and top-level keys.

## If something goes wrong

- **You abandon the rehearsal, or anything in step 8 fails after 8c.** Pause the spike Monitor first, before anything else, and check that it is paused:

  ```bash
  cd "/c/Tinyfish Bounties/fineprint" || exit 1
  node scripts/spike-monitor.mjs PATCH '{"status":"paused"}' && node scripts/spike-monitor.mjs GET --expect paused
  ```

  Only then remove the temporary rows (the second 8f block). A Monitor left active costs about $0.72 a day and sends payloads that the Worker answers with 404 once the page row is gone.
- **A webhook shows "unknown monitor" (404).** Watch the Worker's log, always through the redaction (it hides the secret in `/hooks/monitor/<secret>`; never paste the raw output anywhere). Stop it with Ctrl-C after one schedule tick:

  ```bash
  cd "/c/Tinyfish Bounties/fineprint" || exit 1
  CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler tail --format pretty 2>&1 | sed -E 's#(/hooks/[a-z]+/)[^ ?"]+#\1<redacted>#g'
  ```

  It shows a warning with the first 100 characters of the monitor id. Compare it with the `pages` table: `CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote --command "SELECT id, monitor_id, url FROM pages"`. In the rehearsal this means step 8b did not run or has a typo in the monitor id.
- **No payload within 12 minutes in step 8d.** Run `node scripts/spike-monitor.mjs GET`: the status must be `active`, the schedule `*/10 * * * *` and `webhook_is_ours=true`; if not, repeat 8c. Then run the redacted `tail` above across the next tick (the schedule fires at :00, :10, :20 and so on) to see whether a request arrives. A request answered 404 with no "unknown monitor" warning means the secret in the URL differs from the Worker's: check `secret list` (step 5), and that `../.fineprint-prod.env` still holds the `WEBHOOK_SECRET` that was put in step 5, then repeat 8c.
- **The secret scan in 8e or 8g says STOP.** Do not commit the file and do not paste it anywhere. For 8e the payload is still at `../rehearsal-payload.json`; for 8g the file is in `tests/fixtures/webhooks/` and must not be staged. Report which value was found (the message names it, never shows it). If it is `WEBHOOK_SECRET`, TinyFish echoed the webhook URL: rotate the secret (see the last bullet) before step 9.
- **The script says the admin token was not accepted (401).** The `ADMIN_TOKEN` read from `../.fineprint-prod.env` is not the one on the Worker. Run step 9 again (it re-reads the token), and if it still fails put the secret again (the `ADMIN_TOKEN` line of step 5).
- **A page fails to add.** Read `docs/registration-log.md`. `unfetchable` (422) means TinyFetch could not read the page (`bot_blocked`, empty page): nothing was created, no cost, and the script moved on to the next page. `monitor_create_failed` (502) means TinyFish refused the Monitor; run the script again later and only that page is retried. `watchlist_full` (409) means 24 Monitors exist already.
- **Registration was interrupted.** Run the step 9 block again. Pages already added answer `already_watched` and count towards the 20.
- **Take a page off the list.** The id is in `docs/registration-log.md`:

  ```bash
  cd "/c/Tinyfish Bounties/fineprint" || exit 1
  BASE=$(grep -o '"PUBLIC_BASE_URL": *"[^"]*"' wrangler.jsonc | cut -d'"' -f4)
  [[ $BASE =~ ^https://[^/]+$ ]] || { echo "STOP: PUBLIC_BASE_URL in wrangler.jsonc is not the workers.dev URL (step 6)"; exit 1; }
  ADMIN_TOKEN=$(grep -m1 '^ADMIN_TOKEN=' ../.fineprint-prod.env | cut -d= -f2- | tr -d '\r\n')
  [ "${#ADMIN_TOKEN}" = 48 ] || { echo "STOP: ADMIN_TOKEN is missing or not 48 characters in ../.fineprint-prod.env"; exit 1; }
  PAGE_ID=<paste the page id>
  [[ $PAGE_ID =~ ^[0-9a-f-]{36}$ ]] || { echo "STOP: PAGE_ID is not a page id"; exit 1; }
  curl -s -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/pages/$PAGE_ID"; echo
  ```

  Its Monitor is deleted and its history stays. **Deleting a page does not free its place in the 20, and running registration again does not replace it:** the deleted page keeps its url (the column is unique), so the script gets `409 already_watched` for it and counts it as registered. To put another page in its place, add that page by hand with `POST /api/pages` or run the script with a higher `--limit`.
- **Rotating the webhook secret or host.** `POST /api/admin/rotate-webhook` arrives with Task 10. Until then, changing `WEBHOOK_SECRET` means re-pointing every Monitor by hand, so do not change it after step 9.
- **Day-2 check: is any page producing a version on most pulls?** Pulls are what records the pages (the hourly cron asks TinyFish to run an overdue check and compares the text itself), and on a pricing or fees page every change that gets through buys a facts run of up to about $0.10. A page whose text moves on every pull (a rotating banner, reordered cards, a counter) would spend the budget in days. Compare the versions made since registration with the pulls made:

  ```bash
  cd "/c/Tinyfish Bounties/fineprint" || exit 1
  BASE=$(grep -o '"PUBLIC_BASE_URL": *"[^"]*"' wrangler.jsonc | cut -d'"' -f4)
  [[ $BASE =~ ^https://[^/]+$ ]] || { echo "STOP: PUBLIC_BASE_URL in wrangler.jsonc is not the workers.dev URL (step 6)"; exit 1; }
  curl -s "$BASE/api/stats"; echo
  ```

  `versions` minus 20 (the baselines) is the number of changes recorded; `runs_by_trigger.pull` is the number of pulls. If `versions − 20` is a large share of the pulls, one or a few pages are making a version on most pulls. Find them:

  ```bash
  cd "/c/Tinyfish Bounties/fineprint" || exit 1
  CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote --command "SELECT p.id, p.label, COUNT(*) AS changes FROM versions v JOIN pages p ON p.id = v.page_id WHERE v.is_baseline = 0 GROUP BY p.id ORDER BY changes DESC LIMIT 5"
  ```

  Such a page needs `ignore_patterns`: case-insensitive regexes, and a line of the page text that matches one is left out of the comparison. Compare two of its versions (`GET /api/pages/<id>/diff?from=...&to=...`) to see which line moves, then set the patterns with `PATCH /api/pages/:id`. The patch replaces the whole list, so include any patterns the page already has (`GET /api/pages/<id>` shows them):

  ```bash
  cd "/c/Tinyfish Bounties/fineprint" || exit 1
  BASE=$(grep -o '"PUBLIC_BASE_URL": *"[^"]*"' wrangler.jsonc | cut -d'"' -f4)
  [[ $BASE =~ ^https://[^/]+$ ]] || { echo "STOP: PUBLIC_BASE_URL in wrangler.jsonc is not the workers.dev URL (step 6)"; exit 1; }
  ADMIN_TOKEN=$(grep -m1 '^ADMIN_TOKEN=' ../.fineprint-prod.env | cut -d= -f2- | tr -d '\r\n')
  [ "${#ADMIN_TOKEN}" = 48 ] || { echo "STOP: ADMIN_TOKEN is missing or not 48 characters in ../.fineprint-prod.env"; exit 1; }
  PAGE_ID=<paste the page id>
  [[ $PAGE_ID =~ ^[0-9a-f-]{36}$ ]] || { echo "STOP: PAGE_ID is not a page id"; exit 1; }
  curl -s -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"ignore_patterns":["<regex for the line that moves>"]}' "$BASE/api/pages/$PAGE_ID"; echo
  ```

  The stats also say when the budget is in play: `facts_paused` turns true at $6 of total spend (no new facts runs start; the versions stay queued, and pulls and screenshot and source captures go on), and `spend_paused` at $8 (nothing that costs money runs, pulls included).
- **A page shows as `failed` (the `monitors` counts in `/api/stats`).** The hourly check marks a page `failed` when TinyFish reports its Monitor as anything but `active`, or does not know it. That does not stop its recording: a failed page is still pulled each tick, and the hourly check puts it back to `active` on its own once its Monitor reads `active` again. A status TinyFish does not give (missing or `unknown`) is never held against a page. To put a page back by hand (for example after resuming its Monitor in the TinyFish dashboard), with the page id from `docs/registration-log.md`:

  ```bash
  cd "/c/Tinyfish Bounties/fineprint" || exit 1
  PAGE_ID=<paste the page id>
  [[ $PAGE_ID =~ ^[0-9a-f-]{36}$ ]] || { echo "STOP: PAGE_ID is not a page id"; exit 1; }
  CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote -y --command "UPDATE pages SET status='active' WHERE id='$PAGE_ID' AND status='failed'"
  ```

  If the Monitor is still not `active`, the next hourly check flags the page again. A deleted Monitor leaves the page `failed` for good, and each tick's pull of it fails without a charge.
- **Never** paste a token, key or webhook URL into a commit, an issue, a log or a chat. If one leaks, rotate it: a new Cloudflare token from the dashboard, a new TinyFish key from its console, and for `ADMIN_TOKEN` a new value put with `wrangler secret put`.
