#!/usr/bin/env bash
# Install repo git hooks (run once after clone).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK_SRC="${ROOT}/scripts/prevent-secrets-commit.sh"
HOOK_DST="${ROOT}/.git/hooks/pre-commit"

if [[ ! -d "${ROOT}/.git" ]]; then
  echo "ERROR: ${ROOT} is not a git checkout" >&2
  exit 1
fi
if [[ ! -f "${HOOK_SRC}" ]]; then
  echo "ERROR: missing ${HOOK_SRC}" >&2
  exit 1
fi

mkdir -p "${ROOT}/.git/hooks"
ln -sfn "${HOOK_SRC}" "${HOOK_DST}"
chmod +x "${HOOK_SRC}"
echo "Installed pre-commit hook -> scripts/prevent-secrets-commit.sh"
