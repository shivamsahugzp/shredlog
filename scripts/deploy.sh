#!/usr/bin/env bash
# Deploy ShredLog to GitHub Pages on the PERSONAL account. Token is read from a file, never echoed.
set -euo pipefail
cd "$(dirname "$0")/.."
TOKEN_FILE="$HOME/.config/github-personal/token"
[ -s "$TOKEN_FILE" ] || { echo "Missing $TOKEN_FILE"; exit 1; }
OWNER="${OWNER:-shivamsahugzp}"; REPO="${REPO:-shredlog}"
api() { curl -s -H "Authorization: Bearer $(cat "$TOKEN_FILE")" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$@"; }

echo "→ regenerating service worker precache"
python3 scripts/build-sw.py

echo "→ ensuring repo $OWNER/$REPO exists"
code=$(api -o /dev/null -w "%{http_code}" "https://api.github.com/repos/$OWNER/$REPO")
if [ "$code" = "404" ]; then
  api -X POST https://api.github.com/user/repos -d "{\"name\":\"$REPO\",\"description\":\"ShredLog — free Indian-food-aware calorie, macro, workout and habit tracker (PWA)\",\"homepage\":\"https://$OWNER.github.io/$REPO/\",\"has_issues\":false,\"has_wiki\":false,\"has_projects\":false}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('   created' if d.get('full_name') else '   create failed: '+str(d.get('message'))+' '+str(d.get('errors')))"
else
  echo "   exists (HTTP $code)"
fi

echo "→ committing"
git add -A
git commit -q -m "${MSG:-Deploy ShredLog}

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" || echo "   nothing to commit"
git branch -M main
git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$OWNER/$REPO.git"

echo "→ pushing"
git -c credential.helper= -c "credential.helper=!f() { echo username=$OWNER; echo password=\$(cat $TOKEN_FILE); }; f" push -u origin main -q

echo "→ enabling GitHub Pages (main branch, root)"
pcode=$(api -o /tmp/pages.json -w "%{http_code}" -X POST "https://api.github.com/repos/$OWNER/$REPO/pages" -d '{"source":{"branch":"main","path":"/"}}')
case "$pcode" in
  201) echo "   Pages enabled";;
  409) echo "   Pages already enabled";;
  *) echo "   Pages API returned $pcode: $(python3 -c "import json;print(json.load(open('/tmp/pages.json')).get('message'))" 2>/dev/null)"; echo "   If this is a permissions error, enable Pages manually: repo → Settings → Pages → Branch main / root.";;
esac
api "https://api.github.com/repos/$OWNER/$REPO/pages" | python3 -c "import sys,json; d=json.load(sys.stdin); print('   URL:', d.get('html_url') or 'https://$OWNER.github.io/$REPO/'); print('   status:', d.get('status'))" 2>/dev/null || true
echo "Done. First Pages build takes 1–3 minutes."
