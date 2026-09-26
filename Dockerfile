FROM node:22-trixie-slim AS deps

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev \
  && npm cache clean --force

FROM node:22-trixie-slim AS dashboard-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
RUN npm run build

FROM node:22-trixie-slim

WORKDIR /app
ENV NODE_ENV=production

# ca-certificates + gosu are needed by the CS2 bot.
# ffmpeg is required by the Discord video-stream library: it spawns a SYSTEM
# ffmpeg binary (fluent-ffmpeg), which must be built with the libzmq muxer
# (Discord sends stream data over a ZMQ socket). Debian trixie's ffmpeg
# ships with libzmq and pulls in the libva2 runtime for VAAPI.
# (The CS2 bot does NOT use this system binary — it always uses the
#  self-contained ffmpeg-static npm binary, so it is unaffected.)
#
# Optional, for explicitly selected VAAPI encoding inside this image:
#   - Intel GPU : Intel Media Driver (`intel-media-va-driver`)
#   - NVIDIA GPU: keep software encode; hardware paths need the NVIDIA
#                 container toolkit (docker run --gpus all) + matching
#                 driver/runtime libraries, which are deployment-specific.
# Core: everything the bot needs on any arch.
# Intel Media Driver supports modern Intel graphics, including Arc. It is
# x86-only, so installation is best-effort for arm64 development builds.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu ffmpeg fonts-dejavu-core libva2 vainfo curl jq openvpn wireguard-tools iproute2 unzip \
  && { apt-get install -y --no-install-recommends intel-media-va-driver \
       || echo "skip: Intel VAAPI drivers unavailable on this architecture"; } \
  && rm -rf /var/lib/apt/lists/*

# Intel's modern VAAPI backend.
ENV LIBVA_DRIVER_NAME=iHD

# yt-dlp is an EXTERNAL binary (not an npm package) used by the selfbot's
# resolver (src/streambot/sources.js) to turn platform page URLs
# (twitch.tv, youtube.com, vimeo.com, …) into direct media URLs that ffmpeg
# can play. We use the SELF-CONTAINED release assets (yt-dlp_linux /
# yt-dlp_linux_aarch64 / yt-dlp_macos) — the plain `yt-dlp` asset is a Python
# script and would require python3, which this image does not ship.
# TARGETARCH is set by Docker buildx (amd64 | arm64 | arm).
# Override the install with YTDLP_PATH if you prefer your own.
ARG YTDLP_VERSION=2026.08.19
ARG TARGETARCH
RUN case "$TARGETARCH" in \
        amd64)  ASSET=yt-dlp_linux ;; \
        arm64)  ASSET=yt-dlp_linux_aarch64 ;; \
        arm*)   ASSET=yt-dlp_linux_armv7l ;; \
        *)      echo "yt-dlp: unsupported TARGETARCH '$TARGETARCH'" >&2; exit 1 ;; \
    esac \
  && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${ASSET}" \
      -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && yt-dlp --version

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src
COPY --from=dashboard-build --chown=node:node /web/dist ./web/dist
COPY pia-ca.rsa.4096.crt /usr/local/share/pia/ca.rsa.4096.crt
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY docker-entrypoint-vpn.sh /usr/local/bin/docker-entrypoint-vpn.sh
COPY --chown=node:node run.sh /app/run.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-entrypoint-vpn.sh /app/run.sh \
  && mkdir -p /app/data \
  && chown node:node /app /app/data

# Set commit-specific metadata after filesystem layers so releases can share them.
ARG BUILD_VERSION=dev
ARG BUILD_DATE=unknown
ENV BUILD_VERSION=$BUILD_VERSION
ENV BUILD_DATE=$BUILD_DATE

# Default CMD runs the single launcher (run.sh) with MODE=bot, which preserves
# the previous behavior (CS2 real-bot only, no selfbot token required).
# To enable the TV selfbot, set MODE=streambot or MODE=all in the run env:
#   docker run ... MODE=all <image>       # both bots
#   docker run ... MODE=streambot <image> # selfbot only
# (You may also override CMD with ["/app/run.sh"] — run.sh reads MODE from env.)
ENV MODE=bot
ENTRYPOINT ["docker-entrypoint-vpn.sh"]
CMD ["/app/run.sh"]
