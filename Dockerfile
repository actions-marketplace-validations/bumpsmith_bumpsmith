# Bumpsmith self-hosted server. See docs/self-hosting.md.
#   docker build -t bumpsmith .
#   docker run -p 4477:4477 -v bumpsmith-data:/data \
#     -e BUMPSMITH_PUBLIC_URL=https://bumpsmith.example.com -e BUMPSMITH_BEHIND_PROXY=1 bumpsmith

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Production dependencies only; no package may run install scripts (pnpm-workspace.yaml).
RUN pnpm install --prod --frozen-lockfile

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --gid 0 --home-dir /data --shell /usr/sbin/nologin bumpsmith \
 && mkdir -p /data && chown 10001:0 /data && chmod 700 /data
WORKDIR /app
# The docker client only, for upgrade runs when a Docker engine is attached (see compose.sandbox.yaml).
COPY --from=docker:29-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d /usr/local/bin/docker /usr/local/bin/docker
COPY --from=deps /app/node_modules ./node_modules
COPY package.json LICENSE NOTICE ./
COPY dist ./dist
COPY dashboard ./dashboard
COPY sandbox ./sandbox

ENV NODE_ENV=production \
    BUMPSMITH_DATA=/data \
    BUMPSMITH_HOST=0.0.0.0 \
    BUMPSMITH_PORT=4477
USER 10001
VOLUME ["/data"]
EXPOSE 4477
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.BUMPSMITH_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/cli.js", "server"]
