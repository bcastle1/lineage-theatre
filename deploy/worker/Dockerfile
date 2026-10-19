FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.7.0

WORKDIR /app
RUN python3 -m venv /opt/speech \
    && /opt/speech/bin/pip install --no-cache-dir faster-whisper==1.2.1 \
    && HF_HOME=/opt/whisper /opt/speech/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('small.en', device='cpu', compute_type='int8')" \
    && chmod -R a+rX /opt/whisper
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY api/_lib/ ./api/_lib/
COPY src/studio/hosted-invoice-url.mjs ./src/studio/
COPY shared/ ./shared/
COPY scripts/production-worker.mjs scripts/assemble-film.mjs scripts/check-worker-runtime.mjs scripts/check-hosted-reversals.mjs scripts/paid-film-delivery-worker.mjs scripts/review-film-speech.mjs scripts/transcribe-film.py ./scripts/

ENV NODE_ENV=production FFMPEG_PATH=/usr/bin/ffmpeg PYTHON_PATH=/opt/speech/bin/python HF_HOME=/opt/whisper HF_HUB_OFFLINE=1
USER node
ENTRYPOINT ["node", "scripts/production-worker.mjs"]
CMD ["--check"]
