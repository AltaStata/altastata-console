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

blocked_file_pattern='(^|/)\.env($|\.|/)|(^|/)frontend/\.env\.local$|(^|/)private\.key$|(^|/).*\.pem$'
if printf '%s\n' "${staged_files}" | rg -n "${blocked_file_pattern}" >/dev/null; then
  echo "ERROR: staged files include env/key files that must not be committed."
  printf '%s\n' "${staged_files}" | rg -n "${blocked_file_pattern}" || true
  echo "If this is intentional, run with ALLOW_SECRETS_COMMIT=1."
  exit 1
fi

# Inspect only added lines in staged diff to catch obvious secret material.
staged_added_lines="$(git diff --cached -U0 -- . ':(exclude)*.md' ':(exclude)*.txt')"
secret_content_pattern='^\+.*(BEGIN RSA PRIVATE KEY|BEGIN PRIVATE KEY|VITE_ALTASTATA_PASSWORD|AWSSecretKey|private[_ -]?key|account_password|-----BEGIN)'
if printf '%s\n' "${staged_added_lines}" | rg -n -i "${secret_content_pattern}" >/dev/null; then
  echo "ERROR: staged diff appears to include secret content."
  printf '%s\n' "${staged_added_lines}" | rg -n -i "${secret_content_pattern}" || true
  echo "Remove/redact secrets before committing. If intentional, use ALLOW_SECRETS_COMMIT=1."
  exit 1
fi

exit 0
