# ---- build: install dependencies, compiling the SQLite module if no prebuilt binary fits ----
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- run: just Node, the app, and its installed dependencies ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY scripts ./scripts
COPY public ./public

# The SQLite file (journal, accounts, pictures) lives here — mount a volume on this path or
# everything is lost when the container is replaced.
VOLUME ["/app/data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "server/index.js"]
