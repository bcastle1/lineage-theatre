FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates python3 python3-venv \
      fluidsynth fluid-soundfont-gm=3.1-5.3 espeak-ng libsndfile1 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.7.0

WORKDIR /app
RUN python3 -m venv /opt/speech \
    && /opt/speech/bin/pip install --no-cache-dir faster-whisper==1.2.1 \
    && HF_HOME=/opt/whisper /opt/speech/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('small.en', device='cpu', compute_type='int8')" \
    && HF_HOME=/opt/whisper /opt/speech/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('medium.en', device='cpu', compute_type='int8')" \
    && chmod -R a+rX /opt/whisper
RUN python3 -m venv /opt/soundtrack
COPY scripts/rebuild-film-soundtrack-requirements.txt /opt/soundtrack/requirements-source.txt
RUN /opt/soundtrack/bin/pip install --no-cache-dir -r /opt/soundtrack/requirements-source.txt \
    && /opt/soundtrack/bin/pip freeze > /opt/soundtrack/requirements-resolved.txt
COPY scripts/rebuild-film-soundtrack-assets.py /opt/soundtrack/cache-assets.py
RUN /opt/soundtrack/bin/python /opt/soundtrack/cache-assets.py /opt/soundtrack \
    && chmod -R a+rX /opt/soundtrack \
    && dpkg-query -W fluidsynth fluid-soundfont-gm > /opt/soundtrack/score-packages.txt
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY api/_lib/ ./api/_lib/
COPY src/studio/hosted-invoice-url.mjs ./src/studio/
COPY shared/ ./shared/
COPY scripts/production-worker.mjs scripts/assemble-film.mjs scripts/check-worker-runtime.mjs scripts/check-hosted-reversals.mjs scripts/paid-film-delivery-worker.mjs scripts/review-film-speech.mjs scripts/transcribe-film.py ./scripts/
COPY scripts/test-kling-production.mjs ./scripts/
COPY scripts/automatic-film-soundtrack.mjs scripts/rebuild-film-soundtrack.mjs scripts/rebuild-film-soundtrack.py scripts/repair-name-proof.mjs scripts/compare-repair-name-pronunciations.py ./scripts/
COPY scripts/authored-soundtrack-casting.mjs scripts/approve-film-soundtrack-casting.mjs scripts/inspect-film-soundtrack-fit.mjs ./scripts/

ENV NODE_ENV=production FFMPEG_PATH=/usr/bin/ffmpeg PYTHON_PATH=/opt/speech/bin/python HF_HOME=/opt/whisper HF_HUB_OFFLINE=1
ENV LINEAGE_TTS_PYTHON=/opt/soundtrack/bin/python LINEAGE_TTS_MODEL_DIR=/opt/soundtrack/models/kokoro \
    FLUIDSYNTH_PATH=/usr/bin/fluidsynth LINEAGE_SOUNDFONT=/usr/share/sounds/sf2/FluidR3_GM.sf2 \
    LINEAGE_WORKER_TEMP_ROOT=/tmp/lineage-production-worker TRANSFORMERS_OFFLINE=1 PYTHONDONTWRITEBYTECODE=1 \
    OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 MKL_NUM_THREADS=2 NUMEXPR_NUM_THREADS=2
RUN install -d -m 0700 -o node -g node /run/lineage-native
USER node
ENTRYPOINT ["node", "scripts/production-worker.mjs"]
CMD ["--check"]
