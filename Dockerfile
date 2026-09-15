FROM node:22-bookworm-slim AS deps

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev \
  && npm cache clean --force

FROM node:22-bookworm-slim

WORKDIR /app
ARG BUILD_VERSION=dev
ARG BUILD_DATE=unknown
ENV BUILD_VERSION=$BUILD_VERSION
ENV BUILD_DATE=$BUILD_DATE
ENV NODE_ENV=production

# ca-certificates + gosu are needed by the CS2 bot.
# ffmpeg is required by the Discord video-stream library: it spawns a SYSTEM
# ffmpeg binary (fluent-ffmpeg), which must be built with the libzmq muxer
# (Discord sends stream data over a ZMQ socket). Debian bookworm's ffmpeg
# ships with libzmq and pulls in the libva2 runtime for VAAPI.
# (The CS2 bot does NOT use this system binary — it always uses the
#  self-contained ffmpeg-static npm binary, so it is unaffected.)
#
# Optional, for hardware decoding (HARDWARE_ACCEL=true) inside this image:
#   - Intel GPU : add `libva-intel-driver`
#   - NVIDIA GPU: keep software encode; hardware paths need the NVIDIA
#                 container toolkit (docker run --gpus all) + matching
#                 driver/runtime libraries, which are deployment-specific.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu ffmpeg libva2 libva-intel-driver curl \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp is an EXTERNAL binary (not an npm package) used by the selfbot's
# resolver (src/streambot/sources.js) to turn platform page URLs
# (twitch.tv, youtube.com, vimeo.com, …) into direct media URLs that ffmpeg
# can play. Standalone binary from the yt-dlp releases — no Python needed.
# Override with YTDLP_PATH if you prefer a different install.
# Pinned to a known-good release; bump deliberately.
ARG YTDLP_VERSION=2026.08.19
RUN curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
      -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && yt-dlp --version

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY run.sh /app/run.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /app/run.sh \
  && mkdir -p /app/data \
  && chown -R node:node /app

# Default CMD runs the single launcher (run.sh) with MODE=bot, which preserves
# the previous behavior (CS2 real-bot only, no selfbot token required).
# To enable the TV selfbot, set MODE=streambot or MODE=all in the run env:
#   docker run ... MODE=all <image>       # both bots
#   docker run ... MODE=streambot <image> # selfbot only
# (You may also override CMD with ["/app/run.sh"] — run.sh reads MODE from env.)
ENV MODE=bot
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["/app/run.sh"]
