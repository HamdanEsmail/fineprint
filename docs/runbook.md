# Fineprint deploy runbook

How to take Fineprint from the repo to a live Worker that is recording 20 pages. Written for Git Bash on Windows. Every command is meant to be pasted as it stands, from the repo root (`C:\Tinyfish Bounties\fineprint`). Each step says what success looks like; if you do not see it, stop and read "If something goes wrong" at the end.

Do this only when the Cloudflare account is ready: R2 is enabled and the API token in `../.cloudflare.env` may use Workers, D1 and R2. The steps run in this order on purpose: the first deploy creates the Worker so that `secret put` has something to attach to, and the webhook rehearsal comes before any page is registered, so a payload shape surprise costs one test Monitor and not twenty.

## Rules for the two secret files

- **Cloudflare token.** This machine's environment holds an old `CLOUDFLARE_API_TOKEN` that Cloudflare rejects. Every wrangler command that touches the real account is therefore prefixed with
  `CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r')`
  which reads the right token from `../.cloudflare.env` for that one command. Never echo, print, log or commit that value, and never copy that file into the repo. Do not `cat` the file.
- **TinyFish key.** The shell's `TINYFISH_API_KEY` is also stale (TinyFish answers 401). The key to use is the one in `.dev.vars`. Commands below read it from there; never from the environment.
- **Fineprint's own secrets** (`WEBHOOK_SECRET`, `ADMIN_TOKEN`) live in `../.fineprint-prod.env`, one level above the repo, so no `git add` can ever pick them up. Never `cat` it. Check it with `awk -F= '{print $1, length($2)}' ../.fineprint-prod.env`, which prints names and lengths only.
- If wrangler stops with "More than one account available", add `CLOUDFLARE_ACCOUNT_ID=<the account id>` (not a secret) in front of the same command.

## 0. Shell setup and checks

Paste this at the top of every new shell; variables do not survive from one shell to the next.

```bash
cd "/c/Tinyfish Bounties/fineprint"
# The Worker's public URL, read back from wrangler.jsonc (it is the localhost default until step 6).
BASE=$(grep -o '"PUBLIC_BASE_URL": *"[^"]*"' wrangler.jsonc | cut -d'"' -f4)
echo "BASE=$BASE"
```

Then, once:

```bash
git status --short            # nothing you do not expect
npm run check                 # typecheck, tests and wrangler deploy --dry-run, all green
test -f .dev.vars && echo ".dev.vars present"
test -f ../.cloudflare.env && echo ".cloudflare.env present"
test -f ../.fineprint-prod.env && echo "WARNING: prod secrets file exists already, step 5 keeps it" || echo "no prod secrets file yet (step 5 makes it)"
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler whoami
```

Success: `npm run check` ends green, both files are present, and `wrangler whoami` names the right account (it may not list an API token's permissions; steps 1 and 2 show at once whether D1 and R2 are allowed).

## 1. Create the D1 database

```bash
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 create fineprint
```

Success: wrangler reports the database and prints a `database_id` (a UUID). Paste it into `wrangler.jsonc`, replacing `TBD-after-create`:

```bash
DB_ID=<paste the database_id here>
sed -i "s/TBD-after-create/$DB_ID/" wrangler.jsonc
grep -n database_id wrangler.jsonc     # shows the UUID, not TBD-after-create
```

If wrangler offers to add the binding to the config itself, answer no; the binding is already there and only the id is missing.

## 2. Create the R2 bucket

```bash
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler r2 bucket create fineprint
```

Success: "Created bucket 'fineprint'". An "R2 is not enabled" error means the account step before this runbook is not done: stop and tell Hamdan.

## 3. Apply the migration to the remote database

```bash
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npm run migrate:remote
```

Answer `y` if wrangler asks "Ok to proceed?". Success: `0001_init.sql` applied. Confirm the tables:

```bash
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Success: `diff_cache`, `pages`, `public_adds`, `runs`, `spend`, `versions` are listed (with wrangler's own `d1_migrations` and a few internal tables). When its output is piped, wrangler prints JSON instead of a table; the content is the same.

## 4. First deploy

```bash
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npm run deploy
```

Success: wrangler prints the bindings (DB, STORE, the hourly cron) and a URL of the form `https://fineprint.<subdomain>.workers.dev`. Write that URL down; it is `<url>` below. If wrangler says the account has no workers.dev subdomain, Hamdan registers one in the dashboard (Workers & Pages, Overview) and the deploy is run again.

At this point the Worker answers, but it has no secrets: it has no admin and rejects every webhook. That is expected for the next two steps.

## 5. Secrets

Make the two secrets Fineprint owns, once. Both are 48 hex characters. The file lives outside the repo.

```bash
test -f ../.fineprint-prod.env || printf 'WEBHOOK_SECRET=%s\nADMIN_TOKEN=%s\n' \
  "$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")" \
  "$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")" > ../.fineprint-prod.env
awk -F= '{print $1, length($2)}' ../.fineprint-prod.env
```

Success: exactly `WEBHOOK_SECRET 48` and `ADMIN_TOKEN 48`. Now put all three secrets on the Worker, piping each value in so it is never shown:

```bash
grep -m1 '^WEBHOOK_SECRET=' ../.fineprint-prod.env | cut -d= -f2- | tr -d '\r\n' | CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler secret put WEBHOOK_SECRET
grep -m1 '^ADMIN_TOKEN=' ../.fineprint-prod.env | cut -d= -f2- | tr -d '\r\n' | CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler secret put ADMIN_TOKEN
grep -m1 '^TINYFISH_API_KEY=' .dev.vars | cut -d= -f2- | tr -d '\r\n' | CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler secret put TINYFISH_API_KEY
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler secret list
```

Success: each `secret put` says "Success! Uploaded secret ..." and `secret list` shows `ADMIN_TOKEN`, `TINYFISH_API_KEY`, `WEBHOOK_SECRET`.

## 6. Point `PUBLIC_BASE_URL` at the Worker and deploy again

`PUBLIC_BASE_URL` is the root of every webhook URL Fineprint gives TinyFish, so it must be the real address before a single page is added. Set it to the URL from step 4:

```bash
BASE=<url from step 4>        # e.g. https://fineprint.<subdomain>.workers.dev, no trailing slash
sed -i "s#\"PUBLIC_BASE_URL\": \"[^\"]*\"#\"PUBLIC_BASE_URL\": \"$BASE\"#" wrangler.jsonc
grep -n PUBLIC_BASE_URL wrangler.jsonc          # shows the workers.dev URL

# Local development keeps working on localhost (a .dev.vars value overrides the wrangler.jsonc var in `wrangler dev`):
grep -q '^PUBLIC_BASE_URL=' .dev.vars || printf '\nPUBLIC_BASE_URL=http://localhost:8787\n' >> .dev.vars

CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npm run deploy
```

Success: the deploy lists `PUBLIC_BASE_URL` among the vars with the workers.dev address.

## 7. Commit the config and smoke test

```bash
git add wrangler.jsonc
git -c user.name="Hamdan Esmail" -c user.email="hamdan@alsayaddc.com" commit -m "chore: production D1 id and base URL"
curl -s "$BASE/api/stats"; echo
curl -s -o /dev/null -w "webhook with a wrong secret: HTTP %{http_code}\n" -X POST "$BASE/hooks/monitor/not-the-secret" -d '{}'
```

Success: `/api/stats` answers with JSON whose counts (`pages`, `runs`, `versions`, `spend_usd`) are all 0, and the wrong secret gets `HTTP 404`.

## 8. Webhook rehearsal (spec section 9)

Purpose: see one real scheduled Monitor payload arrive at the deployed handler before 20 Monitors are created. The spike Monitor `e92c04d7-9243-4abe-b7fa-09a769c5a9c7` (it watches `https://vercel.com/pricing`) is re-pointed at the Worker with a 10-minute schedule, runs once or twice, and is paused again. Cost: about $0.005 per check, so under $0.02.

The handler refuses payloads for Monitors it does not know (404, nothing stored), so the spike Monitor needs a temporary page row first.

**8a. A helper for the spike Monitor.** It reads the key from `.dev.vars` and the webhook secret from `../.fineprint-prod.env`, and prints only the HTTP status (and TinyFish's error code, if any), never the key, the secret or the response body, because TinyFish can echo the webhook URL back.

```bash
spike() {   # spike GET   |   spike PATCH '<json>'   (the text __WEBHOOK_URL__ in the json becomes the real webhook url)
  METHOD="$1" BODY="${2:-}" BASE="$BASE" node -e '
const fs = require("fs");
const read = (file, name) => {
  const line = fs.readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.startsWith(name + "="));
  if (!line) throw new Error(name + " is missing in " + file);
  return line.slice(name.length + 1).trim();
};
const key = read(".dev.vars", "TINYFISH_API_KEY");
const hook = process.env.BASE + "/hooks/monitor/" + read("../.fineprint-prod.env", "WEBHOOK_SECRET");
const method = process.env.METHOD;
fetch("https://agent.tinyfish.ai/v1/monitors/e92c04d7-9243-4abe-b7fa-09a769c5a9c7", {
  method,
  headers: { "X-API-Key": key, "Content-Type": "application/json" },
  body: method === "PATCH" ? process.env.BODY.replace("__WEBHOOK_URL__", hook) : undefined,
}).then(async (res) => {
  const b = await res.json().catch(() => ({}));
  const code = b?.error?.code ?? b?.code ?? "";
  console.log("HTTP", res.status, /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : "");
  if (method === "GET") console.log({ status: b.status, schedule_cron: b.schedule_cron, last_error_set: Boolean(b.last_error), webhook_is_ours: b.webhook_url === hook });
});
'
}
spike GET
```

Success: `HTTP 200` and the Monitor's current status (it should be `paused`).

**8b. Temporary page row for the spike Monitor.**

```bash
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote -y --command "INSERT INTO pages (id, url, label, kind, monitor_id, schedule_cron, status, added_by, ignore_patterns, created_at) VALUES ('rehearsal-spike', 'https://vercel.com/pricing', 'Webhook rehearsal (spike monitor)', 'other', 'e92c04d7-9243-4abe-b7fa-09a769c5a9c7', '*/10 * * * *', 'paused', 'admin', '[]', strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
```

Success: wrangler reports 1 row written.

**8c. Re-point the spike Monitor and resume it.** Two PATCHes, because TinyFish's PATCH is a union: the edit must carry `schedule_cron`, and the status change must be sent alone.

```bash
spike PATCH '{"schedule_cron":"*/10 * * * *","webhook_url":"__WEBHOOK_URL__"}'
spike PATCH '{"status":"active"}'
spike GET
```

Success: `HTTP 200` for both PATCHes, then `status: 'active'`, `schedule_cron: '*/10 * * * *'`, `webhook_is_ours: true`.

**8d. Wait for one scheduled payload** (up to 12 minutes; the schedule fires every 10). The loop stops as soon as a run for the temporary page exists. If your shell limits a command to 10 minutes, run the loop a second time.

```bash
for i in $(seq 1 24); do
  date -u +"%H:%M:%S UTC, check $i of 24"
  CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote --json --command "SELECT outcome, raw_key FROM runs WHERE page_id = 'rehearsal-spike'" | grep -q '"raw_key"' && break
  sleep 30
done
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote --command "SELECT id, outcome, raw_key, received_at FROM runs WHERE page_id = 'rehearsal-spike'"
```

Success: a row with an `outcome` and a `raw_key` like `raw/<payload id>.json`. No row after 12 minutes: see "If something goes wrong".

**8e. Copy the raw payload into the fixtures** (R55). The payload goes to `unchanged.json` only if its `outcome` is `unchanged`. Any other outcome is saved as `recorded-<outcome>.json`, and `changed-real.json` and `changed-noise.json` are never overwritten (their tests seed the Vercel base text).

```bash
RAW_KEY=raw/<payload id>.json         # the raw_key column from 8d
OUTCOME=<outcome from 8d>             # unchanged, changed, baseline, ...
if [ "$OUTCOME" = "unchanged" ]; then DEST=tests/fixtures/webhooks/unchanged.json; else DEST="tests/fixtures/webhooks/recorded-$OUTCOME.json"; fi
echo "saving to $DEST"
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler r2 object get "fineprint/$RAW_KEY" --remote --file "$DEST"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(Object.keys(j).join(", "))' "$DEST"
```

Success: the file exists and its top-level keys are printed (expect `id`, `fetch_monitor_id`, `outcome`, `results`, and the other fields of the documented payload). Note the outcome and the keys in `docs/build-log.md`.

**8f. Pause the spike Monitor, remove the temporary rows.** Wait a minute after the payload first; if the outcome was `changed` the handler started a capture for the temporary page that should finish before its rows go. Keep the spend rows and the R2 raw object.

```bash
spike PATCH '{"status":"paused"}'
spike GET
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote -y --command "DELETE FROM versions WHERE page_id='rehearsal-spike'; DELETE FROM runs WHERE page_id='rehearsal-spike'; DELETE FROM pages WHERE id='rehearsal-spike'"
curl -s "$BASE/api/stats"; echo
```

Success: `status: 'paused'`, and `/api/stats` shows 0 for `pages`, `runs` and `versions` again, with `spend_usd` a little above 0. The `pages` row must be gone before step 9, because `https://vercel.com/pricing` is one of the 20 and its url is unique.

**8g. Check the handler against the real payload, and commit it.**

```bash
npx vitest run tests/webhook.test.ts
git add "$DEST"
git -c user.name="Hamdan Esmail" -c user.email="hamdan@alsayaddc.com" commit -m "test: real webhook payload recorded in the rehearsal"
```

Success: every test in `tests/webhook.test.ts` passes with the real fixture in place (the tests seed their own page from whichever fixture they load). A failure here means the real payload differs from the documented shape: stop, do not register pages, and report which test failed and the payload's keys.

## 9. Register the 20 pages

```bash
export ADMIN_TOKEN=$(grep -m1 '^ADMIN_TOKEN=' ../.fineprint-prod.env | cut -d= -f2- | tr -d '\r\n')
node scripts/register-pages.mjs --base "$BASE" --limit 20
```

What it does: first checks the admin token (a wrong token would otherwise create public pages that expire in 7 days), then adds the 30 entries of `pages.json` in order, one at a time, waiting 10 seconds after each new page, until 20 are registered. A page that TinyFetch cannot read (bot-blocked, login wall) is skipped with its reason and the next one is tried; pages already added count as registered, so running the command again after an interruption just continues. Expect 10 to 25 minutes (each add runs TinyFetch and a billed first Monitor check); run it as a background task if your shell limits a command to 10 minutes.

Cost ceiling, from the constants in `src/core/`: 20 baseline checks ($0.005) and 20 screenshots ($0.002) is about $0.14; the facts runs for the pricing and fees pages (13 if the first 20 entries all register, at most 15) are at most 6 steps at $0.016 each, so under $1.50. About $1.60 in all. Everything is recorded in the `spend` table.

Success: it ends with `20 of 20 registered`, exit code 0, and writes `docs/registration-log.md`. Skipped pages are listed there with their reasons; keep that file, the README's "tried and skipped" table comes from it. The log is rewritten after every entry, so an interrupted run leaves a partial one; a re-run replaces it, so copy it aside first if its skipped entries matter (`cp docs/registration-log.md ../registration-log-run1.md`).

## 10. Check that recording has started

```bash
curl -s "$BASE/api/stats"; echo
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote --command "SELECT capture_status, COUNT(*) AS n FROM versions GROUP BY capture_status"
```

- Straight after step 9: `pages` is 20 and `versions` is 20 in the stats.
- Within about 10 minutes of the last add: screenshots and sources are done, so every version is `complete` or `awaiting_facts`.
- Over the next 30 minutes or so: the pricing and fees pages move from `awaiting_facts` to `complete`, one at a time. Fineprint runs the facts extractions as a serial queue (one Agent run at a time, about 1 to 2 minutes each) after the pages are added; registration does not wait for it.
- A version still `pending` or `partial` after 10 minutes failed a capture. Find out why:

```bash
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler d1 execute fineprint --remote --command "SELECT page_id, capture_status, capture_attempts, capture_error FROM versions WHERE capture_status NOT IN ('complete', 'awaiting_facts')"
```

The hourly repair cron is a stub until Task 11, so a failed capture is not retried by the Worker yet; note it in `docs/build-log.md`.

The clock has started when `pages` is 20 and the first hourly and twice-daily Monitor checks begin to arrive. Record: the `/api/stats` output, `docs/registration-log.md`, the rehearsal payload's outcome and top-level keys.

## If something goes wrong

- **A webhook shows "unknown monitor" (404).** `CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r') npx wrangler tail --format pretty` shows a warning with the first 100 characters of the monitor id. Compare it with `SELECT id, monitor_id, url FROM pages` (same `d1 execute` form as above). In the rehearsal this means step 8b did not run or has a typo in the monitor id.
- **No payload within 12 minutes in step 8d.** Run `spike GET`: the status must be `active`, the schedule `*/10 * * * *` and `webhook_is_ours` true; if not, repeat 8c. Then run `wrangler tail` across the next tick (the schedule fires at :00, :10, :20 and so on) to see whether a request arrives. A request answered 404 with no "unknown monitor" warning means the secret in the URL differs from the Worker's: check `secret list`, and that `../.fineprint-prod.env` still holds the `WEBHOOK_SECRET` that was put in step 5, then repeat 8c.
- **The script says the admin token was not accepted (401).** The `ADMIN_TOKEN` in the shell is not the one on the Worker. Re-export it from `../.fineprint-prod.env` (step 9), and if it still fails put the secret again (step 5).
- **A page fails to add.** Read `docs/registration-log.md`. `unfetchable` (422) means TinyFetch could not read the page (`bot_blocked`, empty page): nothing was created, no cost, and the script moved on to the next page. `monitor_create_failed` (502) means TinyFish refused the Monitor; run the script again later and only that page is retried. `watchlist_full` (409) means 24 Monitors exist already.
- **Registration was interrupted.** Run the same command again. Pages already added answer `already_watched` and count towards the 20.
- **Take a page off the list.** With `ADMIN_TOKEN` exported as in step 9: `curl -s -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/pages/<page id>"` (the id is in `docs/registration-log.md`). Its Monitor is deleted and its history stays.
- **Rotating the webhook secret or host.** `POST /api/admin/rotate-webhook` arrives with Task 10. Until then, changing `WEBHOOK_SECRET` means re-pointing every Monitor by hand, so do not change it after step 9.
- **Never** paste a token, key or webhook URL into a commit, an issue, a log or a chat. If one leaks, rotate it: a new Cloudflare token from the dashboard, a new TinyFish key from its console, and for `ADMIN_TOKEN` a new value put with `wrangler secret put`.
