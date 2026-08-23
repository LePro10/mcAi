# mcAI in a container.
#
# Two stages so the runtime image carries no TypeScript and no dev tooling.
# Node 22 on Alpine; the compiler is pure JavaScript and mineflayer needs no
# native build, so there is nothing to compile at install time.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY scripts ./scripts
# `prepare` would try to build before the sources are copied, so skip it here
# and run the build explicitly once everything is in place.
RUN npm ci --ignore-scripts
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY web ./web
COPY styles ./styles
COPY blueprints ./blueprints

# The config file (provider and key) lives here; mount it to keep it.
ENV MCAI_HOME=/data
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

# The dashboard must be reachable from outside the container.
ENV MCAI_HTTP_HOST=0.0.0.0
EXPOSE 8765

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8765/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/cli/main.js"]
CMD ["serve"]
