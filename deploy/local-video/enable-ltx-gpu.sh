#!/usr/bin/env bash
set -euo pipefail
root=/home/brocotech1/lineage-video/ComfyUI
available_kib=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
minimum_kib=$((48 * 1024 * 1024))
if (( available_kib < minimum_kib )); then
 printf 'GPU activation deferred: %.1f GiB available; this profile requires at least 48 GiB available before testing. Existing AI services were left running.\n' "$(awk "BEGIN {print $available_kib / 1048576}")"
 exit 3
fi
python3 - <<'PY'
import json
from pathlib import Path
root=Path('/home/brocotech1/lineage-video/ComfyUI')
receipt=root/'model-receipt.json'
if not receipt.exists():raise SystemExit('Model download verification is incomplete')
items=json.loads(receipt.read_text())
if len(items)!=6:raise SystemExit('Six verified model components are required')
for item in items:
 p=root/'models'/item['file']
 if not p.exists() or p.stat().st_size!=item['bytes']:raise SystemExit('Model component is missing or changed')
PY
docker stop lineage-comfy
docker rm lineage-comfy
docker run -d --name lineage-comfy --restart unless-stopped --user 1000:1000 --gpus all --cpus=8 --memory=64g --memory-swap=64g --security-opt no-new-privileges --cap-drop ALL -p 127.0.0.1:8188:8188 -v "$root/models:/app/ComfyUI/models" -v "$root/user:/app/ComfyUI/user" -v "$root/input:/app/ComfyUI/input" -v "$root/output:/app/ComfyUI/output" lineage-comfy:8d534945 --listen 0.0.0.0 --port 8188 --disable-auto-launch --disable-api-nodes --cache-none --lowvram --fast-disk --disable-pinned-memory --temp-directory /tmp/comfy
