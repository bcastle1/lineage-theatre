#!/usr/bin/env bash
# Run as root. Verify the downloaded archive SHA separately; REV is its full commit label.
# stage SOURCE REV sha256:CURRENT_IMAGE | activate REV [WAIT_SECONDS, default 900]
# Builds copy-only/offline; never reads runtime.env or runs a worker/media check.
set -euo pipefail
umask 077
ROOT=/opt/lineage-worker/photo-deploy
CONF=/etc/lineage-worker/host.conf
SERVICE=lineage-worker.service
TIMER=lineage-worker.timer
die() { printf '%s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || die 'Run as root.'
[[ -f $CONF && ! -L $CONF && $(stat -c %u "$CONF") == 0 ]] || die 'Invalid host.conf.'
[[ ! -L $ROOT ]] || die 'Invalid staging directory.'
install -d -m 0700 "$ROOT"
exec 9>/run/lock/lineage-photo-deploy.lock
flock -n 9 || die 'Another deployment is running.'
pin() {
  local value
  value=$(sed -n 's/^LINEAGE_WORKER_IMAGE=\(sha256:[a-f0-9]\{64\}\)$/\1/p' "$CONF")
  [[ $value =~ ^sha256:[a-f0-9]{64}$ && $(grep -c '^LINEAGE_WORKER_IMAGE=' "$CONF") == 1 ]] || return 1
  printf '%s' "$value"
}
action=${1:-}; source_dir=${2:-}; rev=${3:-}; context=; replacement=; backup=; restore_timer=0; changed=0; startup_requested=0
cleanup() {
  local result=$? rollback current_hash
  trap - EXIT INT TERM
  if (( result != 0 && startup_requested )); then
    printf 'Worker startup was requested; new image pin retained. Inspect service/timer before recovery.\n' >&2
  fi
  if (( result != 0 && changed )); then
    # Only pre-start failures may roll back. Keep the durable backup intact.
    current_hash=$(sha256sum "$CONF"); current_hash=${current_hash%% *}
    if [[ $(pin 2>/dev/null || true) == "$image" && $current_hash == "$next_hash" && -f $backup ]]; then
      if rollback=$(mktemp /etc/lineage-worker/.photo-rollback.XXXXXXXX) && cp -- "$backup" "$rollback" \
        && chmod 0600 "$rollback" && mv -fT "$rollback" "$CONF"; then
        printf 'Restored previous image pin.\n' >&2
      else printf 'Could not restore host.conf; inspect before restarting.\n' >&2; restore_timer=0; fi
    else printf 'Host configuration changed; inspect it before restarting.\n' >&2; restore_timer=0; fi
  fi
  [[ -z $replacement ]] || rm -f -- "$replacement"
  [[ -z $context ]] || rm -rf -- "$context"
  if (( restore_timer )); then systemctl start "$TIMER" || result=1; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ $action == stage ]]; then
  [[ $# == 4 && $rev =~ ^[a-f0-9]{40}$ && $4 =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Usage: stage SOURCE REV sha256:CURRENT_IMAGE'
  base=$4; source_dir=$(realpath -e -- "$source_dir")
  [[ $(pin) == "$base" ]] || die 'Current image pin differs from the supplied base.'
  docker image inspect "$base" >/dev/null
  for file in api/_lib/production-photo-reference.mjs scripts/production-worker.mjs scripts/evaluate-film-models.mjs; do
    [[ -f $source_dir/$file && ! -L $source_dir/$file ]] || die "Missing regular source file: $file"
  done
  [[ -d $source_dir/api/_lib && ! -L $source_dir/api/_lib ]] || die 'Invalid source library directory.'
  [[ -z $(find "$source_dir/api/_lib" -type l -print -quit) ]] || die 'Source library contains a symlink.'
  [[ ! -e $ROOT/$rev.receipt ]] || die 'This revision already has a staging receipt.'
  context=$(mktemp -d "$ROOT/context.XXXXXXXX")
  mkdir -p "$context/api/_lib" "$context/scripts"
  cp -- "$source_dir"/api/_lib/*.mjs "$context/api/_lib/"
  cp -- "$source_dir/scripts/production-worker.mjs" "$source_dir/scripts/evaluate-film-models.mjs" "$context/scripts/"
  (cd "$context"; find api scripts -type f -print0 | sort -z | xargs -0 sha256sum) > "$ROOT/$rev.sources.sha256"
  cat > "$context/Dockerfile" <<'DOCKERFILE'
ARG BASE
FROM ${BASE}
ARG REV
ARG BASE_ID
LABEL org.opencontainers.image.revision=$REV com.lineagetheater.base-image=$BASE_ID
USER root
WORKDIR /app
COPY --chown=node:node api/_lib/ ./api/_lib/
COPY --chown=node:node scripts/ ./scripts/
USER node
ENTRYPOINT ["node", "scripts/production-worker.mjs"]
CMD ["--check"]
DOCKERFILE
  docker tag "$base" "lineage-photo-base:$rev"
  docker build --pull=false --network=none --build-arg "BASE=lineage-photo-base:$rev" --build-arg "BASE_ID=$base" \
    --build-arg "REV=$rev" --iidfile "$context/image-id" -t "lineage-worker:photo-$rev" "$context"
  image=$(cat "$context/image-id")
  [[ $image =~ ^sha256:[a-f0-9]{64}$ && $(pin) == "$base" ]] || die 'Image or current pin changed during staging.'
  printf '%s\n%s\n%s\n' "$rev" "$base" "$image" > "$ROOT/$rev.receipt"
  printf 'Staged revision=%s image=%s\nActivate: bash scripts/deploy-photo-worker.sh activate %s\n' "$rev" "$image" "$rev"
elif [[ $action == activate ]]; then
  rev=${2:-}; wait_seconds=${3:-900}
  [[ $# -ge 2 && $# -le 3 && $rev =~ ^[a-f0-9]{40}$ && $wait_seconds =~ ^[1-9][0-9]{0,3}$ ]] || die 'Usage: activate REV [WAIT_SECONDS]'
  (( wait_seconds <= 7200 )) || die 'Wait must be at most 7200 seconds.'
  receipt=$ROOT/$rev.receipt
  [[ -f $receipt && ! -L $receipt && $(stat -c %u "$receipt") == 0 ]] || die 'Missing root-owned staging receipt.'
  mapfile -t fields < "$receipt"
  [[ ${#fields[@]} == 3 && ${fields[0]} == "$rev" && ${fields[1]} =~ ^sha256:[a-f0-9]{64}$ && ${fields[2]} =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Invalid staging receipt.'
  base=${fields[1]}; image=${fields[2]}
  [[ $(pin) == "$base" ]] || die 'Current image pin changed; stage against the current image.'
  [[ $(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image") == "$rev" \
    && $(docker image inspect -f '{{index .Config.Labels "com.lineagetheater.base-image"}}' "$image") == "$base" ]] || die 'Staged image binding differs.'
  before=$(sha256sum "$CONF"); before=${before%% *}
  if systemctl is-active --quiet "$TIMER"; then restore_timer=1; fi
  systemctl stop "$TIMER"
  printf 'Waiting up to %s seconds for the existing worker to finish; no job will be stopped.\n' "$wait_seconds"
  deadline=$((SECONDS + wait_seconds))
  while [[ $(systemctl show -p ActiveState --value "$SERVICE") != inactive && $(systemctl show -p ActiveState --value "$SERVICE") != failed ]]; do
    (( SECONDS < deadline )) || die 'Active worker did not finish in time; old pin retained.'
    sleep 3
  done
  containers=$(docker ps -aq --filter 'name=^/lineage-production-worker$')
  [[ -z $containers ]] || die 'Worker container still exists; old pin retained.'
  after=$(sha256sum "$CONF"); after=${after%% *}
  [[ $after == "$before" && $(pin) == "$base" ]] || die 'Host configuration changed while waiting.'
  backup=$ROOT/$rev.host.conf.previous
  if [[ -e $backup ]]; then
    [[ -f $backup && ! -L $backup && $(stat -c %u "$backup") == 0 ]] || die 'Invalid previous configuration backup.'
    saved=$(sha256sum "$backup"); saved=${saved%% *}
    [[ $saved == "$before" ]] || die 'A different previous configuration backup already exists.'
  else (set -o noclobber; cat "$CONF" > "$backup"); fi
  chmod 0600 "$backup"
  replacement=$(mktemp /etc/lineage-worker/.photo-next.XXXXXXXX)
  sed "s/^LINEAGE_WORKER_IMAGE=.*/LINEAGE_WORKER_IMAGE=$image/" "$CONF" > "$replacement"
  chmod 0600 "$replacement"
  next_hash=$(sha256sum "$replacement"); next_hash=${next_hash%% *}
  final=$(sha256sum "$CONF"); final=${final%% *}
  [[ $final == "$before" ]] || die 'Host configuration changed before activation.'
  mv -fT "$replacement" "$CONF"; replacement=; changed=1
  # A start request can have an uncertain result. Never revert to an old worker
  # after the new worker might have advertised its photo capability.
  startup_requested=1; changed=0; restore_timer=0
  systemctl start --no-block "$SERVICE"
  systemctl start "$TIMER"
  printf 'Activated revision=%s image=%s service=%s timer=%s\n' "$rev" "$image" "$SERVICE" "$TIMER"
  printf 'Previous configuration retained at %s\n' "$backup"
  printf 'Startup was queued; this is not a successful worker-run or heartbeat receipt.\n'
else die 'Use stage SOURCE REV sha256:CURRENT_IMAGE, then activate REV [WAIT_SECONDS].'; fi
