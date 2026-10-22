# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:22-bookworm-slim AS production-dependencies
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs
ENV COREPACK_HOME=/opt/corepack
RUN install -d -o nextjs -g nodejs "$COREPACK_HOME" \
  && corepack enable \
  && corepack prepare pnpm@10.20.0 --activate \
  && chown -R nextjs:nodejs "$COREPACK_HOME"
ENV COREPACK_ENABLE_NETWORK=0

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

COPY --from=production-dependencies --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/server ./server
COPY --from=builder --chown=nextjs:nodejs /app/worker ./worker
COPY --from=builder --chown=nextjs:nodejs /app/lib ./lib
COPY --from=builder --chown=nextjs:nodejs /app/auth.ts /app/auth.config.ts /app/envConfig.ts ./
COPY --from=builder --chown=nextjs:nodejs /app/package.json /app/pnpm-workspace.yaml /app/tsconfig.json /app/next.config.mjs ./

USER nextjs
RUN test "$(pnpm --version)" = "10.20.0"
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "start"]
