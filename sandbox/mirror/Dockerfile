# Read-only registry mirror (GET/HEAD only) for sandboxes. See mirror.mjs.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
COPY mirror.mjs /opt/mirror/mirror.mjs
USER node
EXPOSE 443 8081
ENV MIRROR_PORT=8443
CMD ["node", "/opt/mirror/mirror.mjs"]
