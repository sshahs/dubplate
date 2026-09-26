# syntax=docker/dockerfile:1

# ---- web: compile the UI once, natively on the build machine ----
# The output is plain HTML/JS/CSS, so it doesn't need emulating per platform.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- deps: runtime dependencies for the target platform ----
# Installed separately so platform-specific binaries (esbuild, used by tsx)
# match the image's architecture.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="Dubplate" \
      org.opencontainers.image.description="AI-assisted music tagger and renamer for sound-system collections" \
      org.opencontainers.image.source="https://github.com/sshahs/dubplate"

# libchromaprint-tools provides fpcalc for AcoustID audio fingerprinting.
# Build with --build-arg WITH_FPCALC=0 to skip it (e.g. without apt access).
ARG WITH_FPCALC=1
RUN if [ "$WITH_FPCALC" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends libchromaprint-tools \
      && rm -rf /var/lib/apt/lists/*; \
    fi \
  && mkdir -p /data /music \
  && chown node:node /data

WORKDIR /app
ENV NODE_ENV=production \
    DUBPLATE_HOST=0.0.0.0 \
    DUBPLATE_PORT=4455 \
    DUBPLATE_DATA_DIR=/data

COPY --chown=node:node package.json ./
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=web --chown=node:node /app/dist ./dist
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared

USER node
VOLUME ["/data"]
EXPOSE 4455

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4455/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run with --init (compose sets init: true) so signals are forwarded cleanly.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "server/index.ts"]
