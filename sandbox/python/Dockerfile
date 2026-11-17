# Bumpsmith sandbox image for Python projects. Pinned by digest.
# Extra interpreters are installed at build time (uv checks their hashes): the sandbox
# cannot download them later, and projects often need a newer or older Python.
FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates coreutils tar git build-essential \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir uv==0.13.8 poetry==2.5.1 pipenv==2026.10.4 pdm==2.29.4 \
 && UV_PYTHON_INSTALL_DIR=/opt/uv-python uv python install 3.10 3.11 3.13 3.14 3.15 \
 && chmod -R a+rX /opt/uv-python \
 && groupadd --gid 10001 sandbox && useradd --uid 10001 --gid 10001 --create-home sandbox \
 && mkdir /workspace && chown sandbox:sandbox /workspace
ENV CI=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INPUT=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_PYTHON_DOWNLOADS=never \
    SETUPTOOLS_SCM_PRETEND_VERSION=0.0.0 \
    GIT_CONFIG_NOSYSTEM=1 \
    POETRY_VIRTUALENVS_IN_PROJECT=true \
    PIPENV_VENV_IN_PROJECT=1 \
    PIPENV_YES=1 \
    PIPENV_NOSPIN=1 \
    PDM_CHECK_UPDATE=false \
    PATH=/workspace/.bumpsmith-cache/venv/bin:$PATH
# Git dependencies are served from shallow local copies (src/sandbox/git-deps.ts); this
# wrapper lets `git fetch` accept their shallow history (--update-shallow).
COPY git-wrapper.sh /usr/local/bin/git
RUN chmod 755 /usr/local/bin/git && git --version
USER 10001:10001
WORKDIR /workspace
CMD ["sleep", "infinity"]
