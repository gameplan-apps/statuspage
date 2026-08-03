#!/usr/bin/env bash
#
# Mirror DECLARED maintenance notices from the edge status document onto this
# status page, as GitHub issues labelled `status` + `maintenance` (Upptime
# renders `status`-labelled issues as incidents, so they appear on the site and
# in history for free).
#
# Direction is one-way on purpose: the KV document is the source of truth and
# the app's control plane. This page is a mirror and never writes back.
#
# Fail-soft by design — if the status document does not exist yet, or the fetch
# fails, this exits 0 and changes nothing. A broken mirror must never make the
# status page itself look broken.
#
# Env:
#   STATUS_DOC_URL   the public status document (repo variable). Unset = no-op.
#   GITHUB_TOKEN     provided by Actions; needs issues: write.

set -euo pipefail

DOC_URL="${STATUS_DOC_URL:-}"
if [ -z "$DOC_URL" ]; then
  echo "STATUS_DOC_URL is not set — nothing to mirror, exiting cleanly."
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
DOC="$WORK/status.json"

if ! curl -fsSL --max-time 15 "$DOC_URL" -o "$DOC"; then
  echo "Could not fetch $DOC_URL — leaving existing issues untouched."
  exit 0
fi

if ! jq -e '.notices | type == "array"' "$DOC" >/dev/null 2>&1; then
  echo "Document at $DOC_URL has no notices array — nothing to mirror."
  exit 0
fi

# Public page, so the title must be human copy — a lex path would leak an
# internal key. Notices without an override title get a generic one.
title_for() {
  jq -r --arg id "$1" '
    .notices[] | select(.id == $id)
    | (.copy.override.en.title // "Scheduled maintenance")
    | gsub("[\t\n\r]"; " ")
  ' "$DOC"
}

# Written straight to a file so newlines stay newlines — no escape round-trip.
body_for() {
  jq -r --arg id "$1" '
    .notices[] | select(.id == $id)
    | "**Effect:** " + .mode,
      "**Severity:** " + .severity,
      "**Services:** " + ((.scope.services // ["*"]) | join(", ")),
      "**Apps:** " + ((.scope.apps // ["*"]) | join(", ")),
      "**Surfaces:** " + ((.scope.surfaces // ["*"]) | join(", ")),
      "**Window:** " + (.window.startsAt // "now") + " → " + (.window.endsAt // "until resolved"),
      "",
      (.copy.override.en.body // ""),
      "",
      "<!-- notice:" + .id + " -->",
      "<!-- Mirrored from the edge status document. Edit the notice, not this issue. -->"
  ' "$DOC"
}

mapfile -t WANT_IDS < <(jq -r '.notices[].id' "$DOC")

# Snapshot every notice into the repo. The KV document holds only what is
# CURRENT — clearing a notice deletes it — so without this the history page
# loses each maintenance window the moment it ends.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$REPO_ROOT/maintenance"
for id in "${WANT_IDS[@]}"; do
  jq --arg id "$id" '
    .notices[] | select(.id == $id)
    | {
        id,
        title: (.copy.override.en.title // "Scheduled maintenance"),
        body:  (.copy.override.en.body  // ""),
        mode,
        services: (.scope.services // ["*"]),
        apps:     (.scope.apps     // ["*"]),
        surfaces: (.scope.surfaces // ["*"]),
        startsAt: (.window.startsAt // null),
        endsAt:   (.window.endsAt   // null)
      }
  ' "$DOC" > "$REPO_ROOT/maintenance/$id.json"
done
echo "Snapshotted ${#WANT_IDS[@]} notice(s) to maintenance/."

# ── what is already open here ─────────────────────────────────────────
declare -A HAVE_NUMBER
while IFS=$'\t' read -r number id; do
  [ -n "$id" ] || continue
  HAVE_NUMBER["$id"]="$number"
done < <(
  gh issue list --label maintenance --state open --limit 100 --json number,body |
    jq -r '
      .[]
      | select(.body | test("<!-- notice:[^ ]+ -->"))
      | [ (.number | tostring), (.body | capture("<!-- notice:(?<id>[^ ]+) -->").id) ]
      | @tsv
    '
)

# ── open anything new ─────────────────────────────────────────────────
opened=0
for id in "${WANT_IDS[@]}"; do
  [ -n "${HAVE_NUMBER[$id]:-}" ] && continue
  echo "Opening incident for notice $id"
  body_for "$id" > "$WORK/body.md"
  gh issue create \
    --title "🛠 $(title_for "$id")" \
    --body-file "$WORK/body.md" \
    --label status \
    --label maintenance
  opened=$((opened + 1))
done

# ── close anything the document dropped ───────────────────────────────
closed=0
for id in "${!HAVE_NUMBER[@]}"; do
  for want in "${WANT_IDS[@]}"; do
    [ "$want" = "$id" ] && continue 2
  done
  echo "Closing incident for cleared notice $id (#${HAVE_NUMBER[$id]})"
  gh issue close "${HAVE_NUMBER[$id]}" \
    --comment "This maintenance window has ended — the notice was cleared from the status document."
  closed=$((closed + 1))
done

echo "Mirror complete: ${#WANT_IDS[@]} declared, $opened opened, $closed closed."
