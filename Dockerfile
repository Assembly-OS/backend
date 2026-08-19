# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241

FROM ${DEBIAN_IMAGE} AS whisper-build
ARG WHISPER_CPP_COMMIT=4979e04f5dcaccb36057e059bbaed8a2f5288315
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates cmake git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --filter=blob:none https://github.com/ggml-org/whisper.cpp.git . \
    && git checkout --detach "${WHISPER_CPP_COMMIT}" \
    && test "$(git rev-parse HEAD)" = "${WHISPER_CPP_COMMIT}" \
    && cmake -S . -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DGGML_NATIVE=OFF \
      -DWHISPER_BUILD_TESTS=OFF \
      -DWHISPER_BUILD_EXAMPLES=ON \
    && cmake --build build --target whisper-cli --parallel \
    && strip build/bin/whisper-cli

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN --mount=type=cache,target=/app/.next/cache npm run build

FROM ${NODE_IMAGE} AS runner
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /nonexistent --shell /usr/sbin/nologin app \
    && rm -rf /usr/local/lib/node_modules \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/pnpm /usr/local/bin/yarn \
      /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-config /usr/bin/apt-mark \
      /usr/bin/dpkg /usr/bin/dpkg-deb /usr/bin/dpkg-divert /usr/bin/dpkg-maintscript-helper \
      /usr/bin/dpkg-query /usr/bin/dpkg-realpath /usr/bin/dpkg-split \
      /usr/bin/dpkg-statoverride /usr/bin/dpkg-trigger

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    HOME=/tmp \
    ASSAMBLEYA_DATA_DIR=/data \
    ASSAMBLEYA_UPLOAD_DIR=/data/uploads \
    WHISPER_BIN=/usr/local/bin/whisper-cli \
    FFMPEG_BIN=/usr/bin/ffmpeg \
    WHISPER_MODEL=/models/ggml-large-v3-turbo.bin \
    WHISPER_VAD_MODEL=/models/ggml-silero-v5.1.2.bin

COPY --from=build --chown=10001:10001 /app/.next/standalone ./
COPY --from=build --chown=10001:10001 /app/.next/static ./.next/static
# migrate() в instrumentation.ts — единственный, кто создаёт схему, и читает
# он db/schema.postgres.sql. Отсутствие файла он проглатывает молча, поэтому
# со старым schema.sql контейнер поднимался с пустой базой без единой таблицы.
COPY --from=build --chown=10001:10001 /app/db/schema.postgres.sql ./db/schema.postgres.sql
COPY --from=whisper-build /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
RUN install -d -o 10001 -g 10001 /data /data/uploads /app/.next/cache \
    && install -d -o root -g root -m 0755 /models

USER 10001:10001
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
