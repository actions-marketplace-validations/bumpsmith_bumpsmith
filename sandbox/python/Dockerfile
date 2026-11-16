# Bumpsmith sandbox image for Python projects. Pinned by digest.
FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates coreutils tar git \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir uv==0.13.8 poetry==2.5.1 \
 && groupadd --gid 10001 sandbox && useradd --uid 10001 --gid 10001 --create-home sandbox \
 && mkdir /workspace && chown sandbox:sandbox /workspace
ENV CI=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INPUT=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    GIT_CONFIG_NOSYSTEM=1
USER 10001:10001
WORKDIR /workspace
CMD ["sleep", "infinity"]
