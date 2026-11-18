# Bumpsmith sandbox image for Node.js projects. Base images pinned by digest (reproducibility, PRD NFR).
# NODE_IMAGE is chosen per job from the repo's .nvmrc / engines (Node 22, 24 or 26).
#
# Package managers are preinstalled because Corepack downloads ignore the egress proxy:
#   pnpm 10 (fetches a repo's pinned pnpm version itself, through the proxy)
#   Yarn 1 (ships with Node 22/24 images; installed for Node 26+) and Yarn 4 as `yarn-berry`
#   Bun (platform binary from npm; install scripts stay disabled)
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
FROM ${NODE_IMAGE}
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates coreutils tar git \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --ignore-scripts pnpm@10.34.9 \
 && { command -v yarn >/dev/null || npm install -g --ignore-scripts yarn@1.22.22; } \
 && npm install --prefix /opt/yarn-berry --ignore-scripts @yarnpkg/cli-dist@4.18.1 \
 && printf '#!/bin/sh\nexec node /opt/yarn-berry/node_modules/@yarnpkg/cli-dist/bin/yarn.js "$@"\n' > /usr/local/bin/yarn-berry \
 && chmod 755 /usr/local/bin/yarn-berry \
 && BUN_PKG="@oven/bun-linux-$([ "$TARGETARCH" = "arm64" ] && echo aarch64 || echo x64)" \
 && npm install --prefix /opt/bun --ignore-scripts "${BUN_PKG}@1.4.4" \
 && ln -s "/opt/bun/node_modules/${BUN_PKG}/bin/bun" /usr/local/bin/bun \
 && bun --version \
 && npm cache clean --force \
 && groupadd --gid 10001 sandbox && useradd --uid 10001 --gid 10001 --create-home sandbox \
 && mkdir /workspace && chown sandbox:sandbox /workspace
ENV CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_ENABLE_STRICT=0 \
    npm_config_ignore_scripts=true \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    NEXT_TELEMETRY_DISABLED=1 \
    YARN_ENABLE_SCRIPTS=0 \
    YARN_ENABLE_IMMUTABLE_INSTALLS=false \
    YARN_ENABLE_TELEMETRY=0 \
    GIT_CONFIG_NOSYSTEM=1 \
    npm_config_registry=https://registry.npmjs.org/ \
    npm_config_replace_registry_host=always \
    YARN_REGISTRY=https://registry.yarnpkg.com
# Package caches live on the job volume (disk), not the 2g home tmpfs (memory).
# .bumpsmith-cache is excluded from copy-in/out, patches and agent tools.
ENV YARN_ENABLE_GLOBAL_CACHE=0 \
    YARN_CACHE_FOLDER=/workspace/.bumpsmith-cache/yarn \
    YARN_GLOBAL_FOLDER=/workspace/.bumpsmith-cache/yarn-global \
    npm_config_cache=/workspace/.bumpsmith-cache/npm \
    npm_config_store_dir=/workspace/.bumpsmith-cache/pnpm-store \
    BUN_INSTALL_CACHE_DIR=/workspace/.bumpsmith-cache/bun
USER 10001:10001
WORKDIR /workspace
CMD ["sleep", "infinity"]
