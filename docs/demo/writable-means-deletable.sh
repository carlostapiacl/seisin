#!/usr/bin/env bash
#
# One agent. One project. One command.
#
# The agent is confined to the project it is working in: it may write there and
# nowhere else. That is the ordinary case a sandbox is for. Then it runs
# `rm -rf .git`.
#
# Nothing here needs seisin. This is the enforcement runtime's own model —
# write-allowed and delete-allowed are one permission.
#
#   macOS   works as-is (Seatbelt)
#   Linux   apt install bubblewrap ripgrep socat   first
#
set -euo pipefail
export LANG=C LC_ALL=C

SRT=${SRT:-"npx -y -p @anthropic-ai/sandbox-runtime srt"}
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
R=$(cd "$D" && pwd -P)

mkdir -p "$R/proj" && cd "$R/proj"
git init -q .
echo "the work" > a.txt
git add -A
git -c user.email=demo@demo -c user.name=demo commit -qm "the history that matters"
cd "$R"

printf '\n  BEFORE\n'
printf '    %s commit · %s\n' "$(git -C proj rev-list --count HEAD)" "$(git -C proj log --oneline -1)"
printf '    .git holds:   %s\n\n' "$(ls proj/.git | tr '\n' ' ')"

cat > settings.json <<JSON
{ "network":    { "allowedDomains": [], "deniedDomains": [], "allowUnixSockets": [], "allowLocalBinding": false },
  "filesystem": { "allowRead": ["$R/proj"], "denyRead": [],
                  "allowWrite": ["$R/proj"], "denyWrite": [] } }
JSON

echo "  \$ srt --settings settings.json -- sh -c 'rm -rf proj/.git'"
salida=$($SRT --settings settings.json -- sh -c "rm -rf $R/proj/.git" 2>&1 || true)
negados=$(printf '%s\n' "$salida" | grep -c '^rm:' || true)
printf '    rm was refused %s time(s); every refusal was under .git/hooks or\n' "$negados"
printf '    .git/config, the paths this runtime denies on purpose. Everything\n'
printf '    else it asked to delete, it deleted.\n\n'

printf '  AFTER\n'
printf '    .git exists:  %s\n' "$([ -d proj/.git ] && echo yes || echo no)"
printf '    .git holds:   %s\n' "$(ls proj/.git 2>/dev/null | tr '\n' ' ')"
printf '    git log:      %s\n\n' "$(git -C proj log --oneline 2>&1 | head -1)"

cat <<'TEXT'
  The directory survives and the repository does not. objects, refs, HEAD and
  index are gone; what remains is whichever paths the runtime protects on its
  own — on macOS that is config and hooks, on Linux only config. Either way a
  .git/ is still sitting there, which is the part that makes the loss easy to
  miss.

  "May edit this file" and "may destroy this file" are one permission today, and
  there is no way to ask for anything narrower.

  The ask is filed upstream:  github.com/anthropics/sandbox-runtime/issues/545
  What measured its cost:     github.com/carlostapiaolguin3-stack/seisin
TEXT
