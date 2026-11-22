# syntax=docker/dockerfile:1

# Same Node major as development (see "engines" in package.json).
FROM node:24-slim AS base
WORKDIR /app
ENV PATH=/app/node_modules/.bin:$PATH
# Prisma's migration engine needs OpenSSL, which the slim image leaves out.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# Every dependency and the whole repo. The `migrate` service in docker-compose.yml
# runs from this stage, for migrations and the seed.
FROM base AS builder
# `npm ci` runs `prisma generate`, which needs the config and schema.
COPY package.json package-lock.json prisma.config.js ./
COPY prisma ./prisma
RUN npm ci
COPY . .

# Drops the dev dependencies but keeps the generated Prisma client.
FROM builder AS deps
RUN npm prune --omit=dev

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY web-widget ./web-widget
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
