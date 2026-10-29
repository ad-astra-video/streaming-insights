# streaming-insights — lightweight control/service image.
#
# Builds the pnpm workspace (packages/* + services/* + webapp) and runs the
# control server, which also serves the built webapp bundle (webapp/dist) at /.
# The media service is started from the same image with a different command.
# The Mage-VL SGLang runner lives in Dockerfile.runner (a separate, heavy GPU
# image) — see the runner image below.
#
# Build:
#   docker build -t streaming-insights:control .
# Run (control server):
#   docker run -p 3100:3100 streaming-insights:control
# Run (media service):
#   docker run -p 4070:4070 streaming-insights:control node services/media/dist/index.js

FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY webapp ./webapp
RUN pnpm install --frozen-lockfile=false && pnpm -r build

FROM node:24-slim
ENV NODE_ENV=production
# ffmpeg is the WebRTC ingest decoder: services/media samples the received video
# track by running short-lived ffmpeg decode passes on the buffered H264/VP8/VP9
# segment. Without it every RTC session reports `packets>0 frames=0` — the stack
# looks healthy while no window ever reaches the runner (Phase 7 deploy bug).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/services ./services
COPY --from=build /repo/webapp ./webapp
EXPOSE 3100 4070
CMD ["node", "services/server/dist/index.js"]
