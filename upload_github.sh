#!/usr/bin/env bash
# Upload ffmpeg-studio source files to GitHub via the REST API.
# Usage: TOKEN=xxxx bash upload_github.sh
# Request body piped via stdin (--data @-) to avoid argv length limits.
# Always GET first to learn the file's sha, then create or update accordingly.
set -euo pipefail

TOKEN="${TOKEN:-${1:-}}"
if [ -z "$TOKEN" ]; then echo "缺少 token：TOKEN=xxxx bash upload_github.sh"; exit 1; fi

REPO="lly5848/ffmpeg-studio"
BRANCH="main"
AUTH="Authorization: Bearer $TOKEN"
ACC="Accept: application/vnd.github+json"

cd "$(dirname "$0")"

upload_one() {
  local f="$1"
  local content
  content=$(base64 -w0 "$f")
  local url="https://api.github.com/repos/$REPO/contents/$f"

  # Learn whether the file already exists (and its sha).
  local existing_sha=""
  existing_sha=$(curl -s --max-time 30 -H "$AUTH" -H "$ACC" "$url" \
    | grep -o '"sha"[ ]*:[ ]*"[^"]*"' | head -1 | cut -d'"' -f4)

  local body
  if [ -n "$existing_sha" ]; then
    body=$(printf '{"message":"update %s","content":"%s","sha":"%s","branch":"%s"}' "$f" "$content" "$existing_sha" "$BRANCH")
  else
    body=$(printf '{"message":"add %s","content":"%s","branch":"%s"}' "$f" "$content" "$BRANCH")
  fi

  local resp
  resp=$(printf '%s' "$body" \
    | curl -s --max-time 90 -X PUT \
        -H "$AUTH" -H "$ACC" -H "Content-Type: application/json" \
        --data @- "$url")

  if echo "$resp" | grep -q '"content"'; then
    echo "OK    $f"; return 0
  fi
  echo "FAIL  $f"; echo "$resp" | head -c 400; echo
  return 1
}

echo "=== 开始上传到 $REPO ($BRANCH) ==="
fail=0
if [ "$#" -gt 0 ]; then
  for f in "$@"; do
    upload_one "$f" || fail=1
  done
else
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    upload_one "$f" || fail=1
  done < <(git ls-files)
fi
echo "=== 上传结束 ==="
[ "$fail" -eq 0 ] && echo "全部成功" || echo "存在失败，见上"
