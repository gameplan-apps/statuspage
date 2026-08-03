# Status page — setup

Upptime status page for the AppRabbit platform. Probes run on GitHub's
runners, so the page survives an outage of anything we operate.

> Upptime rewrites `README.md` with the generated status summary. Keep human
> documentation in this file — anything put in the README will be overwritten.

## What is here

| Path | What it is |
|---|---|
| `.upptimerc.yml` | Probe list + site config. **Edit this to add/remove checks.** |
| `.github/workflows/maintenance-mirror.yml` | Ours — mirrors declared maintenance notices onto the page |
| `scripts/mirror-maintenance.sh` | The mirror logic (fail-soft; no-ops until the status document exists) |
| `scripts/fetch-upptime-workflows.sh` | Pulls Upptime's canonical workflows from upstream |

## One-time setup

**1. Create the repo — public.**

Public is required for free unlimited Actions minutes at a 5-minute cron. A
private repo burns ~288 runs/day against quota, and Pages on a private repo
needs a paid plan.

```bash
cd ~/Documents/apprabbit/rewrite/statuspage
git init && git add -A && git commit -m "[CHORE] bootstrap Upptime status page"
gh repo create gameplan-apps/statuspage --public --source=. --push
```

**Consequence of public, stated plainly:** every URL in `.upptimerc.yml` is
disclosed, along with response-time history. Probe only anonymous, safe
endpoints — no auth'd routes, no admin surfaces, no customer hostnames.

**2. Pull the Upptime workflows.**

```bash
bash scripts/fetch-upptime-workflows.sh
git add -A && git commit -m "[CHORE] add Upptime workflows"
```

**3. Create the `GH_PAT` secret.** *(optional — see below)*

The current Upptime workflows fall back to `github.token` (`${{ secrets.GH_PAT
|| github.token }}`), so the page works without a PAT. The gap: commits made
with `github.token` do not trigger further workflows, so the chained
summary/graph updates only land on their own cron rather than immediately after
a probe. Add a PAT when that lag annoys you.

- Create a fine-grained token scoped to **only this repo**, with
  `Contents: read+write`, `Issues: read+write`, `Workflows: read+write`.
- Add it as a repo secret named `GH_PAT`. Never paste the value anywhere else.

```bash
gh secret set GH_PAT --repo gameplan-apps/statuspage   # prompts; value is not echoed
```

**4. Enable GitHub Pages.** Settings → Pages → source `gh-pages` branch. The
`site` workflow creates that branch on its first successful run, so do this
after step 5.

**5. Kick the first run.**

```bash
gh workflow run "Uptime CI" --repo gameplan-apps/statuspage
```

**6. Confirm the assignee.** `.upptimerc.yml` assigns incidents to
`elijah-apprabbit`. Add teammates there so an outage issue reaches more than
one person.

## Wiring the maintenance mirror

The mirror is inert until the edge status document exists. When it does:

1. Set the repo variable:

```bash
gh variable set STATUS_DOC_URL \
  --repo gameplan-apps/statuspage \
  --body "https://status.apprabbit.app/v1/status.json"
```

2. Have the maintenance CLI / admin console fire a dispatch right after it
   writes KV, so a published notice appears in seconds instead of waiting on
   the 10-minute cron:

```bash
gh api repos/gameplan-apps/statuspage/dispatches -f event_type=maintenance
```

Declared notices become issues labelled `status` + `maintenance`, which Upptime
renders as incidents. Clearing the notice closes the issue. The KV document
stays the source of truth — this page never writes back to it.

The mirror titles each incident from `copy.override.en.title`, falling back to
"Scheduled maintenance". It deliberately never prints `copy.titlePath` — a lex
key on a public page leaks an internal identifier. Any notice worth mirroring
should carry human copy.

## Known limits

- **Actions cron drifts.** Scheduled every 5 minutes, in practice fires 5–15
  minutes late under GitHub load. This is a record, not a pager. If you want
  fast detection, that is the Cloudflare Worker cron detector — a separate
  piece, deliberately not built here.
- **One vantage point.** GitHub's US runners. A transient network event between
  them and us reads as an outage. Expect occasional false incidents.
- **Repo grows.** A commit per run per site. Squash history yearly if it gets
  unwieldy.
- **Cannot see itself.** If GitHub is down, so is the page. Accepted — GitHub
  and our stack share no dependency, which is the property we bought.

## Adding a check

Append to `sites:` in `.upptimerc.yml`. Prefer asserting on the body when an
endpoint reports health in its payload rather than its status code — our
`/readyz` answers `200` while degraded, so a status-code-only check would call
a half-dead API healthy:

```yaml
- name: Some service
  url: https://example.svcrabbit.com/readyz
  __dangerous__body_degraded: '"status":"degraded"'
  __dangerous__body_down_if_text_missing: '"status"'
  maxResponseTime: 3000
```

## Still to confirm

- `alfred` health path — commented out in `.upptimerc.yml` pending a real
  unauthenticated endpoint.
- `axis` hostname — not present anywhere in the repos yet.
- A demo tenant slug to probe app delivery end to end (app lookup + branding
  KV), which the `studio.apprabbit.app` check does not exercise.
- Whether `status.apprabbit.com` gets a CNAME, or the default Pages URL is fine.
