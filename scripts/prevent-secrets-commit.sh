#!/usr/bin/env bash
set -euo pipefail

# Set ALLOW_SECRETS_COMMIT=1 to bypass this check intentionally.
if [[ "${ALLOW_SECRETS_COMMIT:-}" == "1" ]]; then
  exit 0
fi

staged_files="$(git diff --cached --name-only)"
if [[ -z "${staged_files}" ]]; then
  exit 0
fi

blocked=""
while IFS= read -r f; do
  [[ -z "${f}" ]] && continue
  base="$(basename "${f}")"
  if [[ "${base}" == ".env" \
     || "${base}" == ".env.local" \
     || "${base}" == "private.key" \
     || "${base}" == *.pem \
     || "${base}" == .env.*.local ]]; then
    blocked+="${f}"$'\n'
  fi
done <<< "${staged_files}"

if [[ -n "${blocked}" ]]; then
  echo "ERROR: staged files include env/key files that must not be committed."
  printf '%s' "${blocked}"
  echo "Templates like .env.example are allowed. If intentional, use ALLOW_SECRETS_COMMIT=1."
  exit 1
fi

# Inspect only added lines in staged diff to catch obvious secret material.
# Exclude docs/templates — they often mention the words "private key" in prose.
# Exclude docs/templates and this script (its own pattern strings are not secrets).
staged_added_lines="$(
  git diff --cached -U0 -- . \
    ':(exclude)*.md' \
    ':(exclude)*.txt' \
    ':(exclude)*.example' \
    ':(exclude)*.sample' \
    ':(exclude)scripts/prevent-secrets-commit.sh'
)"
# Match PEM armor / known secret env keys in added lines only.
if printf '%s\n' "${staged_added_lines}" \
  | rg -n -i '^\+.*(BEGIN RSA PRIVATE KEY|BEGIN PRIVATE KEY|VITE_ALTASTATA_PASSWORD=|AWSSecretKey=)' \
  >/dev/null; then
  echo "ERROR: staged diff appears to include secret content."
  printf '%s\n' "${staged_added_lines}" \
    | rg -n -i '^\+.*(BEGIN RSA PRIVATE KEY|BEGIN PRIVATE KEY|VITE_ALTASTATA_PASSWORD=|AWSSecretKey=)' \
    || true
  echo "Remove/redact secrets before committing. If intentional, use ALLOW_SECRETS_COMMIT=1."
  exit 1
fi

exit 0
