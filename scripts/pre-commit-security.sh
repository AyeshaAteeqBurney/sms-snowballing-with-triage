#!/bin/sh
# Automated pre-commit security checks (staged diff only).
# Full review: use @security-reviewer in Cursor (.cursor/agents/security-reviewer.md).

set -e

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

STAGED_NAMES="$(git diff --cached --name-only --diff-filter=ACMRTUXB)"
if [ -z "$STAGED_NAMES" ]; then
  exit 0
fi

STAGED_PATCH="$(git diff --cached --diff-filter=ACMRTUXB)"
CRITICAL=0

fail() {
  echo "CRITICAL: $1"
  CRITICAL=1
}

# Hardcoded provider API keys in added lines
if printf '%s\n' "$STAGED_PATCH" | grep -qE '^\+.*(AIza[0-9A-Za-z_-]{20,}|sk-ant-[0-9A-Za-z_-]+)'; then
  fail "Possible hardcoded API key in staged changes. Use env vars or UI paste, never commit secrets."
fi

# Gemini key in URL query (must use x-goog-api-key header)
if printf '%s\n' "$STAGED_PATCH" | grep -qE '^\+.*generativelanguage\.googleapis\.com.*\?key='; then
  fail "Gemini API key must not be in URL (?key=). Use the x-goog-api-key header."
fi

# .env files must not be committed
if printf '%s\n' "$STAGED_NAMES" | grep -qE '(^|/)\.env(\.|$)|\.env\.local$'; then
  fail "Refusing to commit .env or .env.local files."
fi

# API key field must not use type=password (browser Save password prompt)
if printf '%s\n' "$STAGED_PATCH" | grep -qE '^\+[^#]*id="llmKey"[^>]*type="password"|^\+[^#]*type="password"[^>]*id="llmKey"'; then
  fail 'llmKey must not use type="password". Use masked text (field__control--masked).'
fi

# Do not persist API keys in localStorage/session snapshots
if printf '%s\n' "$STAGED_PATCH" | grep -qE '^\+.*localStorage\.(setItem|getItem).*(apiKey|llmKey|geminiApiKey|anthropicApiKey)'; then
  fail "Do not persist API keys in localStorage."
fi

if printf '%s\n' "$STAGED_PATCH" | grep -qE '^\+.*"(apiKey|llmKey|geminiApiKey|anthropicApiKey)"\s*:'; then
  if printf '%s\n' "$STAGED_NAMES" | grep -qE 'public/app\.js$|persistSession'; then
    fail "Do not add API key fields to session persistence objects."
  fi
fi

# Server should bind localhost by default (warn only if binding 0.0.0.0 without HOST guard)
if printf '%s\n' "$STAGED_PATCH" | grep -qE '^\+.*app\.listen\([^)]*\)' \
  && printf '%s\n' "$STAGED_PATCH" | grep -qE '^\+.*app\.listen\(\s*PORT\s*\)'; then
  fail "app.listen should bind to 127.0.0.1 by default (use HOST env for LAN)."
fi

if [ "$CRITICAL" -ne 0 ]; then
  echo ""
  echo "Commit blocked by pre-commit security hook."
  echo "Fix Critical issues above, or run @security-reviewer in Cursor for a full review."
  exit 1
fi

echo "Pre-commit security scan passed (automated checks on staged files)."
echo "Tip: run @security-reviewer in Cursor before pushing for a full diff review."
exit 0
