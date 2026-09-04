#!/usr/bin/env bash
# Rebase our fork's patch stack onto upstream/main and, on a clean rebase,
# publish the next <upstream-base>-schuettc.N to npm. On conflicts: abort,
# open a tracking issue, publish nothing. Invoked by .github/workflows/upstream-sync.yml.
set -euo pipefail

PKG="@schuettc/pi-claude-bridge"
UPSTREAM_URL="https://github.com/elidickinson/pi-claude-bridge.git"
BRANCH="schuettc-publish"
FORCE="${1:-false}"

git config user.name "schuettc-fork-bot"
git config user.email "actions@github.com"

git remote add upstream "$UPSTREAM_URL" 2>/dev/null || git remote set-url upstream "$UPSTREAM_URL"
git fetch upstream main --quiet

base="$(git merge-base HEAD upstream/main)"
ahead="$(git rev-list --count "${base}..upstream/main")"
echo "upstream/main is ${ahead} commit(s) ahead of our base ${base}"

if [ "$ahead" -eq 0 ] && [ "$FORCE" != "true" ]; then
  echo "In sync; nothing to publish."
  exit 0
fi

if [ "$ahead" -gt 0 ]; then
  echo "Rebasing our patch stack onto upstream/main..."
  if ! git rebase upstream/main; then
    upstream_log="$(git --no-pager log --oneline "${base}..upstream/main")"
    git rebase --abort || true
    title="upstream sync: manual rebase needed (${ahead} new upstream commit(s))"
    body="$(printf 'Automated rebase of %s onto elidickinson/main hit conflicts and was aborted — nothing was published.\n\nNew upstream commits:\n\n```\n%s\n```\n\nResolve locally: rebase %s onto upstream/main, force-push, then re-run the upstream-sync workflow (or let the next daily run pick it up).' "$BRANCH" "$upstream_log" "$BRANCH")"
    if [ "$(gh issue list --state open --search "$title in:title" --json number --jq 'length')" = "0" ]; then
      gh issue create --title "$title" --body "$body" 2>/dev/null \
        || echo "Could not open issue (continuing); conflicts still need manual resolution."
    else
      echo "A conflict issue is already open; skipping duplicate."
    fi
    exit 0
  fi
fi

upstream_ver="$(git show upstream/main:package.json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')"
echo "upstream base version: ${upstream_ver}"

published="$(npm view "$PKG" versions --json 2>/dev/null || echo '[]')"
next_n="$(BASE="$upstream_ver" PUBLISHED="$published" node -e '
  const base = process.env.BASE;
  let v = [];
  try { v = JSON.parse(process.env.PUBLISHED); } catch (_) {}
  if (!Array.isArray(v)) v = [v];
  const re = new RegExp("^" + base.replace(/[.]/g, "\\.") + "-schuettc\\.(\\d+)$");
  let max = 0;
  for (const s of v) { const m = re.exec(s); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  process.stdout.write(String(max + 1));
')"
new_ver="${upstream_ver}-schuettc.${next_n}"
echo "publishing new version: ${new_ver}"

npm version "$new_ver" --no-git-tag-version --allow-same-version >/dev/null
git commit -am "chore: fork packaging + CI — ${PKG} ${new_ver}" --amend

npm publish --provenance --access public --tag latest

git push --force-with-lease origin "HEAD:${BRANCH}"
git tag "v${new_ver}"
git push origin "v${new_ver}"

echo "Published ${PKG}@${new_ver}; pushed ${BRANCH} + tag v${new_ver}."
