/**
 * Builds site/data.json — everything the status pages render.
 *
 * Runs in CI after each probe round. Three sources, none of them hit at page
 * load: Upptime's committed files, the GitHub issues list, and the maintenance
 * notices committed by the mirror.
 *
 * The 90-day strip is built INCREMENTALLY: each run appends today's verdict to
 * data/daily/<slug>.json. Upptime only commits history on a status CHANGE, so
 * deriving per-day state from its commit log means paginating the API on every
 * page view. Appending once per run is cheaper and exact. Days before this file
 * existed are absent and render as "no data" rather than as green.
 *
 * Usage: node scripts/build-status-data.mjs
 *   GITHUB_TOKEN   required for the issues read
 *   GITHUB_REPO    owner/repo (defaults to the .upptimerc.yml values)
 *   STATUS_DOC_URL optional; live KV notices merged over the committed ones
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DAILY_DIR = path.join(ROOT, "data", "daily");
const MAINT_DIR = path.join(ROOT, "maintenance");
const OUT = path.join(ROOT, "site", "data.json");

const DAYS = 90;

// ── tiny YAML reader ─────────────────────────────────────────────────
// Upptime's files are flat `key: value` maps. A real parser would be a
// dependency for no gain; anything nested here is a bug in our assumptions, so
// nested keys are ignored rather than half-parsed.
function parseFlatYaml(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let [, key, value] = m;
    value = value.trim().replace(/^["']|["']$/g, "");
    if (value === "") continue;
    out[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return out;
}

// The config's `sites:` list is a sequence of maps — enough structure that the
// flat reader above can't do it, still not enough to justify a dependency.
function parseSites(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^sites:\s*$/.test(l));
  if (start === -1) return [];
  const sites = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^[a-zA-Z]/.test(line)) break; // next top-level key
    const item = /^\s*-\s+([a-zA-Z0-9_]+):\s*(.*)$/.exec(line);
    if (item) {
      if (current) sites.push(current);
      current = { [item[1]]: strip(item[2]) };
      continue;
    }
    const kv = /^\s+([a-zA-Z0-9_]+):\s*(.*)$/.exec(line);
    if (kv && current) current[kv[1]] = strip(kv[2]);
  }
  if (current) sites.push(current);
  return sites.filter((s) => s.name && s.url);
}

const strip = (v) => v.trim().replace(/^["']|["']$/g, "");

const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const today = () => new Date().toISOString().slice(0, 10);

function dayList(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// ── per-service history ──────────────────────────────────────────────

async function readDaily(slug) {
  const file = path.join(DAILY_DIR, `${slug}.json`);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {}; // a corrupt file must not take the build down
  }
}

// Worst state seen in a day wins — a 10-minute outage should colour the day,
// not be averaged away by 280 healthy checks.
const RANK = { up: 0, degraded: 1, partial: 2, down: 3 };

async function writeDaily(slug, record, state, responseMs) {
  const key = today();
  const prev = record[key];
  const worse = !prev || RANK[state] > RANK[prev.state];
  record[key] = {
    state: worse ? state : prev.state,
    ms: responseMs || prev?.ms || null,
    checks: (prev?.checks || 0) + 1,
  };
  await mkdir(DAILY_DIR, { recursive: true });
  await writeFile(path.join(DAILY_DIR, `${slug}.json`), JSON.stringify(record, null, 0) + "\n");
  return record;
}

// ── incidents (GitHub issues) ────────────────────────────────────────

async function fetchIncidents(repo, token) {
  if (!token) return [];
  const url = `https://api.github.com/repos/${repo}/issues?state=all&labels=status&per_page=50&sort=created&direction=desc`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    console.warn(`Issues read failed: ${res.status}. Continuing without incidents.`);
    return [];
  }
  const issues = await res.json();

  return issues
    .filter((i) => !i.pull_request)
    .filter((i) => !i.labels.some((l) => l.name === "maintenance")) // mirrored notices render from their own source
    .map((i) => {
      const started = new Date(i.created_at);
      const ended = i.closed_at ? new Date(i.closed_at) : null;
      return {
        number: i.number,
        title: i.title.replace(/^[^\w(]+\s*/u, ""), // drop the leading emoji Upptime prefixes
        body: describe(i),
        kind: /degraded/i.test(i.title) ? "degraded" : "down",
        resolved: i.state === "closed",
        startedAt: i.created_at,
        endedAt: i.closed_at,
        durationMin: ended ? Math.max(1, Math.round((ended - started) / 60000)) : null,
        url: i.html_url,
        services: serviceTagsFrom(i.title),
      };
    });
}

// Upptime's issue body is a commit link and a response dump — useful in the
// repo, unreadable on a status page. A human-written line beats it, and anyone
// wanting the raw detail has the issue link in the meta row.
function describe(issue) {
  const kind = /degraded/i.test(issue.title) ? "degraded" : "down";
  const noun = serviceTagsFrom(issue.title)[0] || "The service";
  return kind === "degraded"
    ? `${noun} responded more slowly than its configured threshold.`
    : `${noun} failed its health check from GitHub's probes.`;
}

// Upptime titles read "<Name> is down"; the leading words are the service.
function serviceTagsFrom(title) {
  const m = /^(?:[^\w(]+\s*)?(.+?)\s+is\s+(?:down|degraded|up)/i.exec(title);
  return m ? [m[1].trim()] : [];
}

// ── maintenance ──────────────────────────────────────────────────────

async function readMaintenance(docUrl) {
  const committed = [];
  if (existsSync(MAINT_DIR)) {
    for (const file of (await readdir(MAINT_DIR)).filter((f) => f.endsWith(".json"))) {
      try {
        committed.push(JSON.parse(await readFile(path.join(MAINT_DIR, file), "utf8")));
      } catch {
        console.warn(`Skipping unreadable maintenance file: ${file}`);
      }
    }
  }

  // Live notices win over the committed copy — the KV document is the source of
  // truth while a window is open; the committed file is what outlives it.
  if (docUrl) {
    try {
      const res = await fetch(docUrl, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const doc = await res.json();
        for (const n of doc.notices || []) {
          const i = committed.findIndex((c) => c.id === n.id);
          const merged = { ...normalizeNotice(n), live: true };
          if (i >= 0) committed[i] = merged;
          else committed.push(merged);
        }
      }
    } catch (err) {
      console.warn(`Status document unreachable (${err.message}). Using committed notices only.`);
    }
  }

  const now = Date.now();
  return committed
    .map((n) => {
      const starts = n.startsAt ? Date.parse(n.startsAt) : null;
      const ends = n.endsAt ? Date.parse(n.endsAt) : null;
      return {
        ...n,
        upcoming: starts ? starts > now : false,
        active: (!starts || starts <= now) && (!ends || ends > now),
      };
    })
    .sort((a, b) => Date.parse(b.startsAt || 0) - Date.parse(a.startsAt || 0));
}

function normalizeNotice(n) {
  return {
    id: n.id,
    title: n.copy?.override?.en?.title || "Scheduled maintenance",
    body: n.copy?.override?.en?.body || "",
    mode: n.mode || "BANNER",
    services: n.scope?.services || ["*"],
    apps: n.scope?.apps || ["*"],
    surfaces: n.scope?.surfaces || ["*"],
    startsAt: n.window?.startsAt || null,
    endsAt: n.window?.endsAt || null,
  };
}

// ── main ─────────────────────────────────────────────────────────────

const config = await readFile(path.join(ROOT, ".upptimerc.yml"), "utf8");
const sites = parseSites(config);
const owner = /^owner:\s*(.+)$/m.exec(config)?.[1]?.trim();
const repoName = /^repo:\s*(.+)$/m.exec(config)?.[1]?.trim();
const repo = process.env.GITHUB_REPO || `${owner}/${repoName}`;

const window90 = dayList(DAYS);
const services = [];

for (const site of sites) {
  const slug = slugify(site.name);
  const historyFile = path.join(ROOT, "history", `${slug}.yml`);
  if (!existsSync(historyFile)) {
    console.warn(`No history for '${site.name}' (${slug}) — skipping.`);
    continue;
  }

  const h = parseFlatYaml(await readFile(historyFile, "utf8"));
  const state = h.status === "up" ? "up" : h.status === "degraded" ? "degraded" : "down";

  const record = await writeDaily(slug, await readDaily(slug), state, h.responseTime);

  // Week, not all-time: all-time carries every misconfigured probe we ever ran
  // (a wrong health path once put a healthy service at 20%), which reports our
  // setup mistakes as the service's reliability.
  const uptime = (await readShield(slug, "uptime-week")) || (await readShield(slug, "uptime"));
  const response = await readShield(slug, "response-time");

  services.push({
    slug,
    name: site.name,
    url: site.url,
    host: site.url.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    state,
    lastCheck: h.lastUpdated || null,
    uptime: uptime?.message || "—",
    responseMs: h.responseTime ?? null,
    responseLabel: response?.message || "—",
    daily: window90.map((d) => ({ d, state: record[d]?.state || "none" })),
  });
}

async function readShield(slug, metric) {
  const file = path.join(ROOT, "api", slug, `${metric}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

const incidents = await fetchIncidents(repo, process.env.GITHUB_TOKEN);
const maintenance = await readMaintenance(process.env.STATUS_DOC_URL);

const down = services.filter((s) => s.state === "down");
const degraded = services.filter((s) => s.state === "degraded");
const overall = down.length ? "down" : degraded.length ? "degraded" : "up";

const monthAgo = Date.now() - 30 * 86400000;
const recent = incidents.filter((i) => Date.parse(i.startedAt) > monthAgo);
const resolvedDurations = recent.filter((i) => i.durationMin).map((i) => i.durationMin);

const data = {
  generatedAt: new Date().toISOString(),
  repo,
  summary: {
    overall,
    headline:
      overall === "up"
        ? "All systems operational"
        : down.length
          ? `${down.length} service${down.length > 1 ? "s" : ""} down`
          : `${degraded.length} service${degraded.length > 1 ? "s" : ""} degraded`,
    servicesMonitored: services.length,
    uptime7: averageUptime(services),
    medianMs: median(services.map((s) => s.responseMs).filter(Boolean)),
    incidents30d: recent.length,
    mttrMin: resolvedDurations.length ? Math.round(avg(resolvedDurations)) : null,
    lastCheck: services.map((s) => s.lastCheck).filter(Boolean).sort().pop() || null,
  },
  services,
  incidents,
  maintenance,
};

function averageUptime(list) {
  const nums = list.map((s) => parseFloat(s.uptime)).filter((n) => !Number.isNaN(n));
  return nums.length ? `${avg(nums).toFixed(2)}%` : "—";
}
// Declarations, not const arrows — these are called from the object literal
// above, which runs before a const on this line would be initialised.
function avg(n) {
  return n.reduce((a, b) => a + b, 0) / n.length;
}
function median(n) {
  if (!n.length) return null;
  const s = [...n].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(data, null, 2) + "\n");

console.log(
  `Wrote ${path.relative(ROOT, OUT)}: ${services.length} services, ` +
    `${incidents.length} incidents, ${maintenance.length} maintenance notices, overall=${overall}.`,
);
