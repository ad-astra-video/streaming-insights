# streaming-insights — dev image
# Phase 0b scaffold: single multi-stage build (pnpm workspace).
# Services are run per-package in production; this image provides the
# toolchain + built workspace for local/dev and CI parity.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r build

FROM base AS dev
COPY --from=build /app /app
EXPOSE 3100
CMD ["pnpm", "-r", "test"]
