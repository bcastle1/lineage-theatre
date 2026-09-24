# Existing IONOS worker host

The lowest-operation deployment is an isolated Node 22 / FFmpeg container on the existing IONOS Ubuntu VPS. The website, payments, private Blob store and source repository keep their existing hosts. The worker opens no listening port. Its durable queue and immutable completed media use the app's existing private records.

## Verified host inventory — September 24, 2026 UTC

A read-only SSH session using the existing administrator key and strict host-key verification reached `74.208.212.139`. The server reported Ubuntu 24.04.4 LTS, 6 CPUs, 7,884 MiB RAM (6,766 MiB available), and 193 GiB free on its root filesystem. Docker 29.1.3 and Compose 2.40.3 were installed; Node and FFmpeg were not installed on the host. No Lineage service or host directory existed at inspection.

The two existing application containers were healthy and together used about 159 MiB. The pre-existing `nginx.service` failure was observed and left untouched. This inventory establishes access and capacity, not MagicLight or payment-reversal readiness.

Vercel remains appropriate for the application APIs. Its current Node/Python extended duration can reach 30 minutes in beta, but that still requires partitioning this paginated CPU/media worker into bounded requests. The existing Docker host can run the existing process directly, with fewer architectural changes. GitHub Actions remains validation/build infrastructure; a scheduled runner is not installed as this application's production worker.

References: [Vercel function duration announcement](https://vercel.com/changelog/vercel-functions-can-now-run-up-to-30-minutes), [Vercel cron operation](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [GitHub Actions execution limits](https://docs.github.com/en/actions/reference/limits).

## Package and offline acceptance

- `deploy/worker/Dockerfile` installs Node 22, FFmpeg, CA certificates, and frozen production dependencies. It runs as the unprivileged `node` user.
- `deploy/worker/Dockerfile.dockerignore` allows only package/lock files, server libraries and the three worker scripts. No repository metadata, environment files, local dependencies, customer documents or generated media enter the image.
- `scripts/check-worker-runtime.mjs` encodes and fully decodes a one-second synthetic 640×360, 24 fps H.264/AAC sample, verifies output, and removes its temporary files. It does not contact a provider, storage, or any customer queue.
- The systemd unit and timer are templates only. Staging them does not install or enable them.

Build from an allowlisted source staging directory:

```sh
docker build --file deploy/worker/Dockerfile --tag lineage-worker:REVIEWED-REVISION-staging .
docker run --rm --init --network none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges --cpus 2 \
  --memory 3g --memory-swap 3g --pids-limit 256 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1g,mode=1777 \
  --entrypoint node lineage-worker:REVIEWED-REVISION-staging scripts/check-worker-runtime.mjs
docker run --rm --network none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges \
  lineage-worker:REVIEWED-REVISION-staging --check
```

Record the built image ID and the runtime report. A successful synthetic media report proves this image can encode/decode media; the separate worker check may still correctly report `available:false` and `storageConfigured:false`. Neither command is a real provider render.

## Activation after the remaining integration checks

Do not enable the timer until the supported provider adapter, current payment reversal verifier, immutable production budget, intended private storage and an authorized bounded real acceptance job are ready. No environment flag replaces those prerequisites.

On the host, put the immutable image ID in root-owned `/etc/lineage-worker/host.conf` as `LINEAGE_WORKER_IMAGE=sha256:...`. Keep necessary credentials only in root-owned mode-0600 `/etc/lineage-worker/runtime.env` (or an approved host secret manager that materializes that file). Obtain them through the existing vault/runtime process. Do not include secret values in commands, this repository, copied source archives, or logs. Use only the required Blob, QuickBooks encryption/connection and provider configuration; do not export all Vercel secrets. Never grant Docker access to an untrusted user.

Install the reviewed unit and timer only at activation time. The service runs one paginated pass and the timer waits 15 seconds after that pass ends; it cannot overlap itself. The container is limited to 2 CPUs and 3 GiB RAM, exposes no ports, has no host bind mounts, and uses a 1 GiB temporary memory filesystem. The size cap deliberately fails closed when media exceeds the available workspace; review measured production media sizes before increasing it. Limit CPU/memory again if existing workloads need more headroom.

The timer does not post status messages or initiate payments. The worker records only fixed progress counts; provider URLs, private media and credentials remain out of logs. Use `systemctl status lineage-worker.timer lineage-worker.service` and sanitized journal counts for operations. Stop the timer before maintenance, then stop its service; interrupted submissions resume through existing stable-ID reconciliation.

## Staging evidence

Verified on the existing IONOS host on September 24, 2026 UTC:

| Evidence | Result |
| --- | --- |
| Committed source revision | `c850e7a4f62a137f1a1088fe664e4151f37c496c` |
| Source bundle | 39 explicitly allowlisted files; each SHA-256 verified after transfer and rechecked against the committed working tree |
| Source manifest SHA-256 | `b28804b50a59960f7a9b3acfcd550b905de9fb3412a19db8e8788194355dd212` |
| Transfer archive SHA-256 | `4299a21e9dde30f1af65d69ba8a541e0bd51295654150b060eb4fdd759eb8608` |
| Staging directory | `/opt/lineage-worker/staging/b28804b50a59` |
| Image tag | `lineage-worker:b28804b50a59-staging` |
| Immutable image ID | `sha256:c74a4c28db766119592e10f5ddfa88e4f84863934ab86e67bd92395fb03d3f70` |
| Image size / configured user | 335,142,903 bytes / `node` |
| Actual container runtime | Node 22.23.2; FFmpeg 5.1.9-0+deb12u1 |
| Synthetic sample | H.264/AAC, 100,570 bytes; 24 fully decoded frames over 1.002667 seconds |
| Sample SHA-256 | `269794c63ee6246f4c537b272e40c27aeaf22f13367c310122f9e14361259ba4` |
| Cleanup | Temporary synthetic media removed; transient test containers removed |
| Worker configuration check | `available:false`, `provider:magiclight`, `storageConfigured:false` |

Both runtime commands used `--network none`, no runtime environment file, and no credentials. The media check reported `runtimeReady:true`, `providerContacted:false`, and `customerWorkProcessed:false`. The missing-executable regression separately confirmed that failures do not expose the executable's private path. The image records the committed revision and exact source-manifest digest as labels; the bundle digest identifies its precise file bytes, including working-tree line endings.

The systemd templates passed `systemd-analyze verify`. Their copied file modes were normalized to 0644 before that final verification. No unit or timer was installed or enabled, and no customer queue was read. The two pre-existing application containers remained healthy. The staging directory retains only the allowlisted source bundle, image-build logs and sanitized acceptance reports; it contains no credentials or customer media.

The later MagicLight protocol and recorded-reversal diagnostic changes are not present in the image above. The current Dockerfile and positive allowlist now include `scripts/check-hosted-reversals.mjs` for the next reviewed build. Rebuild from the reviewed revision and verify the new source manifest before activating a worker; the historical image evidence must not be represented as verification of later source.
