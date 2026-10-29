# streaming-insights — lightweight control/service image.
#
# Builds the pnpm workspace (packages/* + services/*) and runs the control
# server. The media service is started from the same image with a different
# command. The Mage-VL SGLang runner lives in Dockerfile.runner (a separate,
# heavy GPU image) — see the runner image below.
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
COPY package.json pnpm-workspace.yaml .npmrc ./
COPY packages ./packages
COPY services ./services
RUN pnpm install --frozen-lockfile=false && pnpm -r build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/services ./services
EXPOSE 3100 4070
CMD ["node", "services/server/dist/index.js"]
