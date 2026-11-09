FROM golang:1.27.3-bookworm@sha256:d9b6a1beb9474adc2a1ce842573639b44b2a0dd49b6669f51d3821baf9ec37c9 AS ipadecrypt
ARG IPADECRYPT_VERSION=v0.7.5
RUN set -eu; \
  go mod download github.com/londek/ipadecrypt@${IPADECRYPT_VERSION}; \
  source="$(go env GOMODCACHE)/github.com/londek/ipadecrypt@${IPADECRYPT_VERSION}"; \
  mkdir -p /src/ipadecrypt; \
  cp -R "${source}"/. /src/ipadecrypt/; \
  cd /src/ipadecrypt; \
  go mod edit -require=golang.org/x/crypto@v0.55.0 -require=golang.org/x/mod@v0.40.0 -require=golang.org/x/net@v0.62.0; \
  go mod tidy; \
  go test ./...; \
  go build -trimpath -o /go/bin/ipadecrypt ./cmd/ipadecrypt

FROM rust:1.99.1-bookworm@sha256:9181b56c2a21ab1d5e73cffe04fc762426d30aa7fac3c91141dd033f49a7fc8b AS device-bridge
WORKDIR /bridge
COPY packages/device-bridge/Cargo.toml packages/device-bridge/Cargo.lock ./
COPY packages/device-bridge/src ./src
ARG CARGO_AUDITABLE_VERSION=0.7.4
RUN cargo install cargo-auditable --version ${CARGO_AUDITABLE_VERSION} --locked \
  && cargo auditable build --release --locked

FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3 AS netmuxd
ARG NETMUXD_VERSION=v0.4.3
ARG TARGETARCH=amd64
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tar && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  case "${TARGETARCH}" in \
    amd64) asset=netmuxd-x86_64-unknown-linux-gnu.tar.gz; checksum=85b6598284fc639f2a282584461d05e2090b79bdf3ec949d2a5e5d3dc655dde4 ;; \
    arm64) asset=netmuxd-aarch64-unknown-linux-gnu.tar.gz; checksum=a89d587b094184b41431bc343da6dfa890391ccc7d4b3d6bce02b524f3191ae6 ;; \
    *) echo "unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  curl --fail --silent --show-error --location "https://github.com/jkcoxson/netmuxd/releases/download/${NETMUXD_VERSION}/${asset}" --output /tmp/netmuxd.tar.gz; \
  echo "${checksum}  /tmp/netmuxd.tar.gz" | sha256sum --check; \
  tar --extract --file /tmp/netmuxd.tar.gz --directory /usr/local/bin; \
  chmod 0755 /usr/local/bin/netmuxd

FROM rust:1.99.1-bookworm@sha256:9181b56c2a21ab1d5e73cffe04fc762426d30aa7fac3c91141dd033f49a7fc8b AS appstore-downloader
WORKDIR /src
COPY packages/appstore-core/Cargo.toml packages/appstore-core/LICENSE packages/appstore-core/UPSTREAM ./packages/appstore-core/
COPY packages/appstore-core/src ./packages/appstore-core/src
COPY packages/appstore-downloader/Cargo.toml packages/appstore-downloader/Cargo.lock ./packages/appstore-downloader/
COPY packages/appstore-downloader/src ./packages/appstore-downloader/src
COPY packages/appstore-downloader/tests ./packages/appstore-downloader/tests
WORKDIR /src/packages/appstore-downloader
RUN cargo test --locked && cargo build --release --locked

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS fairplay-decrypt
ARG FAIRPLAY_DECRYPT_REV=1bad106ee1698c6d9c483f67d898183ffa4c6eb3
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gcc libc6-dev make python3 python3-venv tar && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  mkdir -p /opt/fairplay-decrypt; \
  curl --fail --silent --show-error --location "https://codeload.github.com/EthanArbuckle/fairplay-decrypt/tar.gz/${FAIRPLAY_DECRYPT_REV}" --output /tmp/fairplay-decrypt.tar.gz; \
  echo "730b3911b0a316b7e3fec9ec80c69dea86521fb3840c118e61d96f204c90f1d1  /tmp/fairplay-decrypt.tar.gz" | sha256sum --check; \
  tar --extract --gzip --file /tmp/fairplay-decrypt.tar.gz --directory /opt/fairplay-decrypt --strip-components=1; \
  python3 -m venv /opt/fairplay-decrypt/.venv; \
  /opt/fairplay-decrypt/.venv/bin/pip install --no-cache-dir --disable-pip-version-check --upgrade cryptography==50.0.2 setuptools==84.0.0; \
  make -C /opt/fairplay-decrypt transform
COPY packages/dkrypt/fairplay-credential-bundle/ /opt/fairplay-decrypt/credential-retrieval/build/bundle/
RUN set -eu; \
  for item in credential.ios driver.ios trigger.ios static-key-table.bin core4-word-table.bin; do test -s "/opt/fairplay-decrypt/credential-retrieval/build/bundle/${item}"; done; \
  chmod 0755 /opt/fairplay-decrypt/credential-retrieval/build/bundle/*.ios

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS web
WORKDIR /web
COPY packages/dkrypt/web/package.json packages/dkrypt/web/bun.lock ./
RUN bun install --frozen-lockfile
COPY packages/dkrypt/web ./
ARG BUILD_REF=development
ENV VITE_BUILD_REF=$BUILD_REF
RUN bun run build

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
WORKDIR /app
ARG BUILD_REF=development
ARG DEPLOYMENT_ID=local

RUN apt-get update && apt-get upgrade -y --no-install-recommends && apt-get install -y --no-install-recommends ca-certificates findutils libusb-1.0-0 openssh-client passwd python3 util-linux \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 dkrypt && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin dkrypt

COPY --from=ipadecrypt /go/bin/ipadecrypt /usr/local/bin/ipadecrypt
COPY --from=device-bridge /bridge/target/release/dkrypt-device-bridge /usr/local/bin/dkrypt-device-bridge
COPY --from=netmuxd /usr/local/bin/netmuxd /usr/local/bin/netmuxd
COPY --from=appstore-downloader /src/packages/appstore-downloader/target/release/dkrypt-appstore-downloader /usr/local/bin/dkrypt-appstore-downloader
COPY --from=fairplay-decrypt /opt/fairplay-decrypt /opt/fairplay-decrypt
COPY packages/dkrypt/package.json packages/dkrypt/bun.lock packages/dkrypt/tsconfig.json ./
RUN bun install --production --frozen-lockfile
COPY packages/dkrypt/src ./src
COPY packages/dkrypt/entrypoint.sh /usr/local/bin/dkrypt-entrypoint
COPY --from=web /public ./public
RUN chmod 0755 /usr/local/bin/dkrypt-entrypoint
RUN printf '%s\n' '#!/bin/sh' 'exec /opt/fairplay-decrypt/.venv/bin/python /opt/fairplay-decrypt/decrypt.py "$@"' > /usr/local/bin/fairplay-decrypt \
  && chmod 0755 /usr/local/bin/fairplay-decrypt

ENV NODE_ENV=production BUILD_REF=$BUILD_REF DEPLOYMENT_ID=$DEPLOYMENT_ID
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "\
    fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/v1/health', \
      { headers: { authorization: 'Bearer ' + process.env.API_KEY } }) \
      .then((r) => process.exit(r.ok ? 0 : 1)) \
      .catch(() => process.exit(1))"

CMD ["/usr/local/bin/dkrypt-entrypoint"]
