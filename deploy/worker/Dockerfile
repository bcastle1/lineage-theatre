FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.7.0

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY api/_lib/ ./api/_lib/
COPY scripts/production-worker.mjs scripts/assemble-film.mjs scripts/check-worker-runtime.mjs ./scripts/

ENV NODE_ENV=production FFMPEG_PATH=/usr/bin/ffmpeg
USER node
ENTRYPOINT ["node", "scripts/production-worker.mjs"]
CMD ["--check"]
