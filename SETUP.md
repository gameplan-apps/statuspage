# Status page — setup

Upptime status page for the AppRabbit platform. Probes run on GitHub's
runners, so the page survives an outage of anything we operate.

> Upptime rewrites `README.md` with the generated status summary. Keep human
> documentation in this file — anything put in the README will be overwritten.

## Division of labour

**Upptime does the measuring. We do the rendering.** Upstream probes endpoints,
opens and closes issues, and commits results. Its own generated site is
disabled — `site/` replaces it.

That split is why the theme file (`assets/apprabbit.css`) and Upptime's
`themeUrl` are no longer used. They stay in the repo only for the case where we
ever fall back to the upstream site.

## What is here

| Path | What it is |
|---|---|
| `.upptimerc.yml` | Probe list. **Edit this to add/remove checks.** |
| `site/index.html`, `site/history/` | The two pages |
| `site/status.css`, `site/app.js` | Shared styles and renderer |
| `site/data.json` | Built in CI — everything the pages render. Never hand-edit |
| `scripts/build-status-data.mjs` | Builds `data.json` |
| `scripts/mirror-maintenance.sh` | Pulls KV notices → issues + `maintenance/*.json` |
| `scripts/fetch-upptime-workflows.sh` | Re-syncs upstream workflows |
| `data/daily/<slug>.json` | The 90-day strip, one entry per run |
| `maintenance/<id>.json` | Notice snapshots, so history outlives KV |
| `.github/workflows/status-site.yml` | Builds data, commits it, deploys `site/` |

## How the page gets its data

```
Uptime CI  →  history/*.yml + api/*/*.json   (upstream)
                        ↓
              Status site workflow
                        ↓
  build-status-data.mjs  ──→  site/data.json  ──→  gh-pages
     ↑            ↑                ↑
  issues     KV notices     data/daily/*.json
```

A page load is **one fetch of one file**. No GitHub API calls, no pagination —
which matters most in exactly the situation the page exists for.

### The 90-day strip accumulates

Upptime commits history only on a status *change*, so per-day state can't be
read cheaply from its files. Instead each run appends today's verdict to
`data/daily/<slug>.json`, worst-state-wins within a day. Days before that file
existed render as grey "no data" — never as green, which would be a lie.

**Consequence:** the strip fills in over 90 days. It cannot be backfilled.

### Uptime is the 7-day figure

Not all-time. All-time carries every misconfigured probe we ever ran — a wrong
health path once had a perfectly healthy gateway at 20% — which reports our
setup errors as the service's reliability.

## Theming

Colours come from
`studio/packages/application/dashboard/src/theme/dashboard-theme.css`, with
traffic-light status colours on top. Every state has **two** tokens: `--up` etc.
is the vivid FILL for bars and dots, `--up-ink` is the deeper shade for text —
the signal colours are far too light to read on near-white. Dark mode carries
lifted versions of the same hues and sets ink equal to fill.

Edit `site/status.css`. Changes deploy on the next `Status site` run.

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

**4. Enable GitHub Pages.** Done — source is the `gh-pages` branch, which
`Static Site CI` creates and updates.

**4a. Where the page is served — pick exactly one.** The generated site links
its assets from the server root, so it needs to know its own base. Set one of
these under `status-website:`, never both:

| Setting | URL | Notes |
|---|---|---|
| `baseUrl: /statuspage` | `gameplan-apps.github.io/statuspage/` | **Current.** No DNS needed. |
| `cname: status.apprabbit.com` | `status.apprabbit.com` | Needs a DNS record, below |

With **neither** set, every stylesheet and script 404s and the page renders as
unstyled HTML — that is the failure mode to recognise if it ever looks broken.

To move to the custom domain later: swap the two lines, push, wait for
`Static Site CI`, set the domain under Settings → Pages, and add:

```
status.apprabbit.com   CNAME   gameplan-apps.github.io
```

On Cloudflare that record must be **DNS-only (grey cloud)** until GitHub has
issued the certificate — a proxied record breaks cert provisioning.

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

## Disabled workflows

`Setup CI` and `Update Template CI` are **disabled**. They try to rewrite this
repo's own `.github/workflows/` on a schedule, which `github.token` is not
permitted to do — every run failed. Re-syncing with upstream is deliberate here
instead: run `scripts/fetch-upptime-workflows.sh` and commit the diff, so a
workflow change is something you reviewed rather than something that landed
overnight.

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
