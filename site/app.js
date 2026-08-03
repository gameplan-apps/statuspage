/**
 * Renders both status pages from site/data.json.
 *
 * The JSON is built in CI (scripts/build-status-data.mjs), so this file does no
 * API calls, no pagination and no date maths beyond formatting — a page load is
 * one fetch of one small file. That is deliberate: a status page has to render
 * when things are broken, so it depends on as little as possible.
 *
 * Each page sets `data-page` on <body>; everything else is shared.
 */

const BASE = document.body.dataset.base || ".";
const PAGE = document.body.dataset.page || "status";

const WORD = { up: "Operational", degraded: "Degraded", partial: "Partial outage", down: "Down" };
const MODE_WORD = { BANNER: "Scheduled", READ_ONLY: "Read-only", BLOCK: "Downtime" };

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";

const fmtTime = (iso) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC" : "";

const monthOf = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "Undated";

function ago(iso) {
  if (!iso) return "unknown";
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function durationLabel(mins) {
  if (!mins) return null;
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

function windowLabel(m) {
  if (!m.startsAt) return "until resolved";
  const start = new Date(m.startsAt);
  const end = m.endsAt ? new Date(m.endsAt) : null;
  const sameDay = end && start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10);
  return sameDay
    ? `${fmtDate(m.startsAt)}, ${fmtTime(m.startsAt)}–${fmtTime(m.endsAt)}`
    : `${fmtDate(m.startsAt)} ${fmtTime(m.startsAt)}${end ? ` → ${fmtDate(m.endsAt)} ${fmtTime(m.endsAt)}` : ""}`;
}

// ── rendering ────────────────────────────────────────────────────────

function renderHero(data) {
  const { summary } = data;
  const el = document.getElementById("hero");
  if (!el) return;
  el.innerHTML = `
    <div class="verdict">
      <span class="beacon"><i class="ring" style="background:var(--${summary.overall})"></i><i style="background:var(--${summary.overall})"></i></span>
      <h1>${esc(summary.headline)}</h1>
    </div>
    <p class="sub">Checked every five minutes from GitHub's infrastructure — independent of ours, so this page keeps reporting during an outage.</p>
    <div class="stamp">
      <span>Last checked ${esc(ago(summary.lastCheck))}</span>
      <span>${summary.servicesMonitored} service${summary.servicesMonitored === 1 ? "" : "s"} monitored</span>
      <span>Updated ${esc(fmtTime(data.generatedAt))}</span>
    </div>`;
}

function renderStats(data) {
  const { summary } = data;
  const el = document.getElementById("stats");
  if (!el) return;
  const cells = [
    { k: "Uptime · 7d", v: summary.uptime7 },
    { k: "Response · median", v: summary.medianMs ? `${summary.medianMs}<small>ms</small>` : "—" },
    { k: "Incidents · 30d", v: String(summary.incidents30d) },
    { k: "Time to recover", v: summary.mttrMin ? `${summary.mttrMin}<small>min</small>` : "—" },
  ];
  el.innerHTML = cells.map((c) => `<div class="stat"><span class="k">${c.k}</span><span class="v">${c.v}</span></div>`).join("");
}

function renderMaintenanceBands(data) {
  const el = document.getElementById("active-maint");
  if (!el) return;
  const show = data.maintenance.filter((m) => m.active || m.upcoming);
  el.innerHTML = show
    .map(
      (m) => `
      <div class="maint-band">
        <span class="icn">◑</span>
        <div>
          <div class="t">${esc(m.title)}${m.active ? " · in progress" : ""}</div>
          <div class="d">${esc(m.body)}</div>
        </div>
        <div class="w">${esc(windowLabel(m))}</div>
      </div>`,
    )
    .join("");
}

function renderServices(data) {
  const bars = document.getElementById("view-bars");
  const tiles = document.getElementById("view-tiles");
  if (!bars || !tiles) return;

  bars.innerHTML = data.services
    .map(
      (s) => `
      <article class="svc">
        <div class="svc-top">
          <div class="svc-id">
            <span class="dot" style="background: var(--${s.state})"></span>
            <div style="min-width:0">
              <div class="name">${esc(s.name)}</div>
              <div class="host">${esc(s.host)}</div>
            </div>
          </div>
          <div class="svc-fig">
            <div class="fig"><div class="k">7-day</div><div class="v">${esc(s.uptime)}</div></div>
            <div class="fig"><div class="k">Response</div><div class="v">${s.responseMs ?? "—"}<span style="font-size:12px;color:var(--text-dim)">ms</span></div></div>
            <span class="pill ${s.state}">${WORD[s.state]}</span>
          </div>
        </div>
        <div class="bars">${s.daily
          .map((d) => `<span data-s="${d.state}" title="${d.d} — ${d.state === "none" ? "no data yet" : d.state}"></span>`)
          .join("")}</div>
        <div class="bars-legend"><span>90 days ago</span><span>today</span></div>
      </article>`,
    )
    .join("");

  tiles.innerHTML = data.services.map((s) => tileHtml(s)).join("");
}

function tileHtml(s) {
  const pts = s.daily.filter((d) => d.state !== "none").slice(-34);
  const spark = pts.length > 1 ? sparkSvg(s, pts) : `<div style="height:20px"></div>`;
  return `
    <article class="tile">
      <div class="row">
        <div>
          <div class="name">${esc(s.name)}</div>
          <div class="k" style="margin-top:2px">${esc(s.uptime)} · 7 days</div>
        </div>
        <span class="pill ${s.state}">${WORD[s.state]}</span>
      </div>
      <div class="row" style="align-items:flex-end">
        <div class="big">${s.responseMs ?? "—"}<span style="font-size:14px;font-weight:500;color:var(--text-dim);letter-spacing:0">ms</span></div>
        <div class="k" style="padding-bottom:5px">latest</div>
      </div>
      ${spark}
    </article>`;
}

// One point per recorded day. With a single day of history there is nothing to
// draw, which is why the caller guards on length.
function sparkSvg(s, pts) {
  const w = 260;
  const h = 56;
  const values = pts.map((p) => p.ms || 0);
  const max = Math.max(...values, 1) * 1.18;
  const step = w / (values.length - 1);
  const y = (v) => h - (v / max) * (h - 6) - 3;
  const line = values.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return `
    <svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="g-${s.slug}" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="var(--${s.state})" stop-opacity="0.32"/>
        <stop offset="100%" stop-color="var(--${s.state})" stop-opacity="0.02"/>
      </linearGradient></defs>
      <path d="${line}L${w},${h}L0,${h}Z" fill="url(#g-${s.slug})"/>
      <path d="${line}" fill="none" stroke="var(--${s.state})" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
}

// ── history entries ──────────────────────────────────────────────────

function incidentHtml(i) {
  const dur = durationLabel(i.durationMin);
  return `
    <article class="entry" data-kind="${i.kind}">
      <div class="rail"></div>
      <div class="inner">
        <div class="head">
          <span class="pill ${i.resolved ? i.kind : "down"}">${i.resolved ? "Resolved" : "Ongoing"}</span>
          <span class="title">${esc(i.title)}</span>
        </div>
        ${i.body ? `<p>${esc(i.body)}</p>` : ""}
        ${i.services.length ? `<div class="scope">${i.services.map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
        <div class="meta">
          <span>${esc(fmtDate(i.startedAt))}, ${esc(fmtTime(i.startedAt))}</span>
          ${dur ? `<span>duration ${dur}</span>` : ""}
          <span><a href="${esc(i.url)}" style="color:inherit">incident #${i.number}</a></span>
        </div>
      </div>
    </article>`;
}

function maintenanceHtml(m) {
  const scope = [...m.services, ...m.apps, ...m.surfaces].filter((t) => t && t !== "*");
  return `
    <article class="entry" data-kind="maintenance">
      <div class="rail"></div>
      <div class="inner">
        <div class="head">
          <span class="pill maint">${MODE_WORD[m.mode] || "Scheduled"}</span>
          <span class="title">${esc(m.title)}</span>
        </div>
        ${m.body ? `<p>${esc(m.body)}</p>` : ""}
        ${scope.length ? `<div class="scope">${scope.map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
        <div class="meta">
          <span>${esc(windowLabel(m))}</span>
          <span>notice ${esc(m.id)}</span>
          ${m.active ? "<span>in progress</span>" : ""}
        </div>
      </div>
    </article>`;
}

function renderHistory(data, filter) {
  const el = document.getElementById("history-list");
  if (!el) return;

  const rows = [
    ...data.incidents.map((i) => ({ kind: "incident", at: i.startedAt, html: incidentHtml(i) })),
    ...data.maintenance.map((m) => ({ kind: "maintenance", at: m.startsAt || data.generatedAt, html: maintenanceHtml(m) })),
  ]
    .filter((r) => filter === "all" || r.kind === filter)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  if (!rows.length) {
    el.innerHTML = `<div class="empty">Nothing recorded${filter === "all" ? " yet" : " in this category"}.</div>`;
    return;
  }

  const months = [...new Set(rows.map((r) => monthOf(r.at)))];
  el.innerHTML = months
    .map((m) => `<div class="month">${esc(m)}</div>${rows.filter((r) => monthOf(r.at) === m).map((r) => r.html).join("")}`)
    .join("");
}

function renderHistoryStamp(data) {
  const el = document.getElementById("history-stamp");
  if (!el) return;
  const openMaint = data.maintenance.length;
  el.innerHTML = `
    <span>${data.incidents.length} incident${data.incidents.length === 1 ? "" : "s"} · ${openMaint} maintenance window${openMaint === 1 ? "" : "s"}</span>
    <span>${esc(data.summary.uptime7)} uptime across monitored services</span>`;
}

// ── boot ─────────────────────────────────────────────────────────────

fetch(`${BASE}/data.json`, { cache: "no-cache" })
  .then((r) => {
    if (!r.ok) throw new Error(`data.json ${r.status}`);
    return r.json();
  })
  .then((data) => {
    document.getElementById("footer-stamp").textContent = `Updated ${fmtDate(data.generatedAt)}, ${fmtTime(data.generatedAt)}`;

    if (PAGE === "status") {
      renderHero(data);
      renderStats(data);
      renderMaintenanceBands(data);
      renderServices(data);

      const recent = document.getElementById("recent");
      if (recent) {
        recent.innerHTML = data.incidents.length
          ? data.incidents.slice(0, 2).map(incidentHtml).join("")
          : `<div class="empty">No incidents recorded.</div>`;
      }

      document.querySelectorAll(".seg button").forEach((btn) => {
        btn.addEventListener("click", () => {
          document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
          document.getElementById("view-bars").classList.toggle("hidden", btn.dataset.view !== "bars");
          document.getElementById("view-tiles").classList.toggle("hidden", btn.dataset.view !== "tiles");
        });
      });
    } else {
      renderHistoryStamp(data);
      renderHistory(data, "all");
      document.querySelectorAll(".chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
          renderHistory(data, chip.dataset.filter);
        });
      });
    }
  })
  .catch((err) => {
    // The page itself failing is the one thing a status page cannot do quietly.
    const target = document.getElementById("hero") || document.getElementById("history-list");
    if (target) {
      target.innerHTML = `<div class="empty">Status data could not be loaded (${esc(err.message)}). The services themselves may be fine — this is a problem with this page.</div>`;
    }
    console.error(err);
  });
