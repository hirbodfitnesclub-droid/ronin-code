# Ronin Code API server — production image (user API + admin app processes).
# Build from the server/ directory:  docker build -t ronin-api server/
FROM node:22-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7443 \
    ADMIN_PORT=7444

WORKDIR /app

# Only runtime dependency is `pg`; install exactly from the lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

# Receipts fallback dir (production uses Supabase Storage; harmless locally).
RUN mkdir -p /app/data/receipts && chown -R node:node /app
USER node

EXPOSE 7443 7444

# Default process = user API. The admin app runs as a second process
# (see fly.toml process groups) with: node src/admin-main.js
CMD ["node", "src/server.js"]
