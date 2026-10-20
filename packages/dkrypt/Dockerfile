FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS ipadecrypt
ARG IPADECRYPT_VERSION=v0.7.5
RUN set -eu; \
  go mod download github.com/londek/ipadecrypt@${IPADECRYPT_VERSION}; \
  source="$(go env GOMODCACHE)/github.com/londek/ipadecrypt@${IPADECRYPT_VERSION}"; \
  mkdir -p /src/ipadecrypt; \
  cp -R "${source}"/. /src/ipadecrypt/; \
  cd /src/ipadecrypt; \
  go mod edit -require=golang.org/x/crypto@v0.55.0 -require=golang.org/x/mod@v0.40.0 -require=golang.org/x/net@v0.60.0; \
  go mod tidy; \
  go test ./...; \
  go build -trimpath -o /go/bin/ipadecrypt ./cmd/ipadecrypt

FROM rust:1.99.0-bookworm@sha256:114c7a4425406451c2866b6aafe69fe29b1b298832db1277d411ac73c82d04d6 AS device-bridge
WORKDIR /bridge
COPY packages/device-bridge/Cargo.toml packages/device-bridge/Cargo.lock ./
COPY packages/device-bridge/src ./src
ARG CARGO_AUDITABLE_VERSION=0.7.4
RUN cargo install cargo-auditable --version ${CARGO_AUDITABLE_VERSION} --locked \
  && cargo auditable build --release --locked

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS netmuxd
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

FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS web
WORKDIR /web
COPY packages/dkrypt/web/package.json packages/dkrypt/web/bun.lock ./
RUN bun install --frozen-lockfile
COPY packages/dkrypt/web ./
ARG BUILD_REF=development
ENV VITE_BUILD_REF=$BUILD_REF
RUN bun run build

FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288
WORKDIR /app
ARG BUILD_REF=development
ARG DEPLOYMENT_ID=local

RUN apt-get update && apt-get upgrade -y --no-install-recommends && apt-get install -y --no-install-recommends ca-certificates findutils libusb-1.0-0 openssh-client passwd util-linux \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 dkrypt && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin dkrypt

COPY --from=ipadecrypt /go/bin/ipadecrypt /usr/local/bin/ipadecrypt
COPY --from=device-bridge /bridge/target/release/dkrypt-device-bridge /usr/local/bin/dkrypt-device-bridge
COPY --from=netmuxd /usr/local/bin/netmuxd /usr/local/bin/netmuxd
COPY packages/dkrypt/package.json packages/dkrypt/bun.lock packages/dkrypt/tsconfig.json ./
RUN bun install --production --frozen-lockfile
COPY packages/dkrypt/src ./src
COPY packages/dkrypt/entrypoint.sh /usr/local/bin/dkrypt-entrypoint
COPY --from=web /public ./public
RUN chmod 0755 /usr/local/bin/dkrypt-entrypoint

ENV NODE_ENV=production BUILD_REF=$BUILD_REF DEPLOYMENT_ID=$DEPLOYMENT_ID
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "\
    fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/v1/health', \
      { headers: { authorization: 'Bearer ' + process.env.API_KEY } }) \
      .then((r) => process.exit(r.ok ? 0 : 1)) \
      .catch(() => process.exit(1))"

CMD ["/usr/local/bin/dkrypt-entrypoint"]
