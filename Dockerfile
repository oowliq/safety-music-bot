# syntax=docker/dockerfile:1.7
#
# Safety Music Bot image.
# - No yt-dlp / cookies / PO-token sidecars: all provider playback goes through NodeLink.
# - ffmpeg comes from Debian's signed repository (no ffmpeg-static download at install time).
# - Runs as the unprivileged `node` user, no package manager or corepack at runtime.
#
# The base image is pinned by tag + digest; Dependabot (.github/dependabot.yml) proposes updates.
FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS base

FROM base AS deps
WORKDIR /app
ENV CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: no dependency lifecycle scripts run during install.
# @napi-rs/canvas and @livekit/rtc-node ship prebuilt binaries as optional deps and need no scripts.
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm run build

# `docker build --target test .` runs typecheck and the unit tests.
FROM build AS test
COPY test ./test
RUN pnpm run typecheck && pnpm test

FROM base AS prod-deps
WORKDIR /app
ENV CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=1024 \
    FFMPEG_BIN=/usr/bin/ffmpeg \
    MONITORING_HOST=127.0.0.1 \
    MONITORING_PORT=9091 \
    HEAP_SNAPSHOT_SIGNAL_ENABLED=0
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
# Package managers are not needed at runtime; removing them shrinks the attack surface.
RUN rm -rf /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
           /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json ./
COPY --chown=root:root assets/fonts ./assets/fonts

# Code is owned by root and read-only for the runtime user.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD ["node", "-e", "require('node:http').get({host:'127.0.0.1',port:process.env.MONITORING_PORT||9091,path:'/readyz'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/index.js"]
