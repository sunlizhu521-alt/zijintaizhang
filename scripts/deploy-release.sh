#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin
unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH

APP_ROOT=/home/ubuntu/zhuge-ai-lab/zijintaizhang
APP_NAME=zijintaizhang
APP_PORT=4010
commit=${1:-}
staging=${2:-}
[[ $# -eq 2 && $commit =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid release arguments.' >&2; exit 64; }
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Linux x86_64 is required.' >&2; exit 1; }
[[ $staging == "$APP_ROOT/incoming/release.$commit."* && -d $staging && ! -L $staging ]] || { echo 'Invalid staging directory.' >&2; exit 1; }
[[ $(realpath "$staging") == "$staging" ]] || { echo 'Staging path must not contain symlinks.' >&2; exit 1; }
for command in pm2 ss curl python3; do command -v "$command" >/dev/null || { echo "Required command is missing: $command" >&2; exit 1; }; done
runtime="$staging/runtime/node"
"$runtime" --version
"$runtime" --input-type=module -e '
  import { backup, DatabaseSync } from "node:sqlite";
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 22 || minor < 16 || process.platform !== "linux" || process.arch !== "x64" || typeof backup !== "function") process.exit(1);
  new DatabaseSync(":memory:").close();
'
python3 - "$APP_ROOT/shared/config.json" <<'PY_CONFIG'
import json, sys
expected = {'port': 4010, 'publicOrigin': 'https://129.211.9.242', 'host': '127.0.0.1', 'trustProxy': 'loopback'}
if json.load(open(sys.argv[1])) != expected:
    raise SystemExit('Shared configuration differs from the reviewed deployment settings.')
PY_CONFIG

mkdir -p "$APP_ROOT/releases" "$APP_ROOT/shared/data" "$APP_ROOT/shared/backups" "$APP_ROOT/shared/logs"
previous=''
if [[ -e "$APP_ROOT/current" || -L "$APP_ROOT/current" ]]; then
  [[ -L "$APP_ROOT/current" ]] || { echo 'current must be a release symlink.' >&2; exit 1; }
  previous=$(readlink -f "$APP_ROOT/current")
  [[ $previous =~ ^$APP_ROOT/releases/[0-9a-f]{40}$ && -f $previous/ecosystem.config.cjs ]] || { echo 'Previous release is not owned by this project.' >&2; exit 1; }
fi
release="$APP_ROOT/releases/$commit"
state_file=$(mktemp "$APP_ROOT/incoming/pm2-state.XXXXXX")
listeners_file=$(mktemp "$APP_ROOT/incoming/listeners.XXXXXX")
switched=0
touched_pm2=0

health_matches() {
  local expected=$1
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$APP_PORT/zijintaizhang/api/health" |
    python3 -c 'import json,sys; p=json.load(sys.stdin); sys.exit(0 if p.get("status")=="ok" and p.get("app")=="zijintaizhang" and p.get("release")==sys.argv[1] else 1)' "$expected"
}

switch_current() {
  local target=$1
  local link="$APP_ROOT/.current.$$.tmp"
  ln -s "$target" "$link"
  mv -Tf "$link" "$APP_ROOT/current"
}

finish() {
  local status=$?
  trap - EXIT
  set +e
  rm -f -- "$state_file" "$listeners_file" "$APP_ROOT/.current.$$.tmp"
  if [[ $status -ne 0 && $switched -eq 1 ]]; then
    echo 'Deployment failed; restoring only the zijintaizhang release.' >&2
    if [[ $touched_pm2 -eq 1 ]]; then pm2 delete "$APP_NAME" >/dev/null 2>&1; fi
    if [[ -n $previous ]]; then
      switch_current "$previous"
      pm2 start "$previous/ecosystem.config.cjs" --only "$APP_NAME" --update-env >/dev/null
      local recovered=0
      for attempt in $(seq 1 20); do
        if health_matches "$(basename "$previous")" >/dev/null 2>&1; then recovered=1; break; fi
        sleep 1
      done
      if [[ $recovered -eq 1 ]]; then pm2 save >/dev/null; echo 'Previous release health check passed.' >&2;
      else echo 'Rollback health check failed; operator attention is required.' >&2; fi
    else
      [[ $(readlink "$APP_ROOT/current") != "$release" ]] || rm -f "$APP_ROOT/current"
      pm2 save >/dev/null
      echo 'First release removed; shared data has been retained.' >&2
    fi
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# PM2 output can contain environment secrets: retain only the process identity fields.
pm2 jlist | python3 -c '
import json,sys
print(json.dumps([{ "pid":p.get("pid",0), "cwd":p.get("pm2_env",{}).get("pm_cwd",""),
  "script":p.get("pm2_env",{}).get("pm_exec_path","") }
  for p in json.load(sys.stdin) if p.get("name")=="zijintaizhang"]))
' > "$state_file"
ss -H -ltnp "( sport = :$APP_PORT )" > "$listeners_file"
existing=$(python3 - "$state_file" "$listeners_file" "$APP_ROOT" "$previous" <<'PY_OWNERSHIP'
import json, os, re, sys
state, listeners_path, root, previous = sys.argv[1:]
root = os.path.realpath(root)
apps = json.load(open(state))
if len(apps) > 1:
    raise SystemExit('Multiple PM2 processes use this project name.')
app = apps[0] if apps else None
if app:
    cwd = os.path.realpath(app['cwd'])
    if not re.fullmatch(re.escape(root) + r'/releases/[0-9a-f]{40}', cwd):
        raise SystemExit('PM2 project name belongs to a different working directory.')
    if os.path.realpath(app['script']) != os.path.join(cwd, 'server/index.js'):
        raise SystemExit('PM2 process script does not match this project.')
    if not previous or cwd != os.path.realpath(previous):
        raise SystemExit('Running PM2 release differs from the current release symlink.')
listeners = open(listeners_path).read().strip()
pids = set(map(int, re.findall(r'pid=(\d+)', listeners)))
if listeners and (not pids or not app or pids != {app['pid']} or app['pid'] <= 0):
    raise SystemExit('Port 4010 is occupied by an unverified process; nothing was restarted.')
print(1 if app else 0)
PY_OWNERSHIP
)
[[ $existing -eq 0 || -n $previous ]] || { echo 'A PM2 process exists without a previous managed release.' >&2; exit 1; }
if [[ -d $release ]]; then
  if [[ $previous == "$release" ]] && health_matches "$commit" >/dev/null; then echo "Release $commit is already healthy."; exit 0; fi
  echo 'This immutable release already exists. Review the failed release or deploy a new commit.' >&2
  exit 1
fi

database="$APP_ROOT/shared/data/zijintaizhang.sqlite"
python3 - "$APP_ROOT" "$database" <<'PY_SPACE'
import os, sys
root, database = sys.argv[1:]
size = sum(os.path.getsize(p) for p in (database, os.path.join(os.path.dirname(database), 'gongyingshangpingji.sqlite')) if os.path.exists(p))
disk = os.statvfs(root)
if disk.f_bavail * disk.f_frsize < size * 2 + 128 * 1024 * 1024:
    raise SystemExit('Insufficient free space for a verified database backup.')
PY_SPACE
backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
for database in "$APP_ROOT/shared/data/zijintaizhang.sqlite" "$APP_ROOT/shared/data/gongyingshangpingji.sqlite"; do
if [[ -f $database ]]; then
  backup="$APP_ROOT/shared/backups/predeploy-$(basename "$database" .sqlite)-$backup_stamp-$commit.sqlite"
  "$runtime" --input-type=module - "$database" "$backup" <<'JS_BACKUP'
import { DatabaseSync, backup } from 'node:sqlite';
import { renameSync, rmSync } from 'node:fs';
const [sourcePath, destination] = process.argv.slice(2);
const temporary = `${destination}.tmp`;
const source = new DatabaseSync(sourcePath, { readOnly: true });
try {
  await backup(source, temporary);
  const copy = new DatabaseSync(temporary, { readOnly: true });
  try {
    const rows = copy.prepare('PRAGMA quick_check').all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new Error('Backup integrity check failed');
  } finally { copy.close(); }
  renameSync(temporary, destination);
} catch (error) { rmSync(temporary, { force: true }); throw error; }
finally { source.close(); }
JS_BACKUP
  echo 'Database backup and integrity check passed.'
fi
done

mv "$staging" "$release"
switch_current "$release"
switched=1
touched_pm2=1
if [[ $existing -eq 1 ]]; then pm2 delete "$APP_NAME" >/dev/null; fi
pm2 start "$release/ecosystem.config.cjs" --only "$APP_NAME" --update-env >/dev/null
healthy=0
for attempt in $(seq 1 30); do
  if health_matches "$commit" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done
[[ $healthy -eq 1 ]] || { echo 'New release failed its app/commit health check.' >&2; exit 1; }
# Keep public routing/TLS verification inside the rollback window; Actions checks it externally again.
curl --fail --silent --show-error --max-time 15 --retry 2 --retry-delay 1 \
  'https://129.211.9.242/zijintaizhang/api/health' |
  python3 -c 'import json,sys; p=json.load(sys.stdin); sys.exit(0 if p.get("status")=="ok" and p.get("app")=="zijintaizhang" and p.get("release")==sys.argv[1] else 1)' "$commit"
if [[ -f "$release/server/rating-api.js" ]]; then
curl --fail --silent --show-error --max-time 15 --retry 2 --retry-delay 1 \
  'https://129.211.9.242/gongyingshangpingji/api/health' |
  python3 -c 'import json,sys; p=json.load(sys.stdin); sys.exit(0 if p.get("status")=="ok" and p.get("app")=="gongyingshangpingji" and p.get("release")==sys.argv[1] else 1)' "$commit"
fi
pm2 save >/dev/null
echo "Deployed zijintaizhang commit $commit on 127.0.0.1:$APP_PORT."
