FROM node:24-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pil ffmpeg espeak-ng fonts-dejavu-core ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN npm install --omit=dev @vercel/blob@2.8.0
COPY scripts/local-video-render.py scripts/local-video-worker.py scripts/local-video-upload.mjs ./
USER 1000:1000
CMD ["python3", "local-video-worker.py"]
