#!/usr/bin/env bash
# Run the CI gate against a commit, not the working tree.
#
# Checks that run in place see whatever is on disk — including untracked files
# a partially committed change still depends on — so a commit can pass locally
# and fail in CI. This checks the commit out into a temporary worktree that
# shares the installed node_modules and runs `pnpm ci-check` there. Nothing in
# the main checkout (dist/, dev server, uncommitted work) is touched.
set -euo pipefail

sha="${1:?usage: scripts/check-commit.sh <commit>}"
root="$(git rev-parse --show-toplevel)"
sha="$(git -C "$root" rev-parse --verify "$sha^{commit}")"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/relay-check-XXXXXX")"

cleanup() {
  git -C "$root" worktree remove --force "$tmp" >/dev/null 2>&1 || rm -rf "$tmp"
  git -C "$root" worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

git -C "$root" worktree add --detach --quiet "$tmp" "$sha"
# Share installed dependencies. The lockfile is part of the commit, so a
# dependency change still needs a real `pnpm install` before pushing.
for dir in node_modules app/node_modules; do
  [ -d "$root/$dir" ] && ln -s "$root/$dir" "$tmp/$dir"
done

echo "check-commit: running CI checks against $(git -C "$root" rev-parse --short "$sha") in a clean worktree…"
(cd "$tmp" && pnpm ci-check)
