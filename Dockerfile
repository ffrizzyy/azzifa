FROM node:20-alpine

WORKDIR /app

# Native module (better-sqlite3) needs a build toolchain on Alpine.
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public

# SQLite file lives here — mount a volume on this path or data is lost when the container is removed.
VOLUME ["/app/data"]

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/index.js"]
