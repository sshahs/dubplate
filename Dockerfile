# syntax=docker/dockerfile:1

# ---- build: compile the web app ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
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

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared

USER node
VOLUME ["/data"]
EXPOSE 4455

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4455/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run with --init (compose sets init: true) so signals are forwarded cleanly.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "server/index.ts"]
