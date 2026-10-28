FROM node:24-alpine

RUN apk add --no-cache ca-certificates ffmpeg

# Bothost mounts its checkout over /app; keep runtime code outside that mount.
WORKDIR /opt/aisylu
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=96 \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    DATABASE_PATH=/app/data/aisylu.sqlite

COPY package.json ./
COPY src ./src
COPY content ./content
COPY scripts/backup.js ./scripts/backup.js
RUN mkdir -p /app/data

# System FFmpeg and built-in SQLite mean no npm install is needed in this image.
CMD ["node", "src/index.js"]
