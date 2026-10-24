# Ronin Code API server — production image (user API + admin app processes).
# Build context = REPO ROOT:  docker build -f server/Dockerfile -t ronin-api .
# The admin process serves the admin panel's Vite build same-origin from
# /web/admin-panel/dist (server/src/admin/app.js resolves ../../../web/…),
# so the image includes that build output at the filesystem root level.

# ── Stage 1: build the admin panel ──────────────────────────────────────────
FROM node:22-slim AS admin-panel
WORKDIR /build/admin-panel
COPY web/admin-panel/package.json web/admin-panel/package-lock.json ./
RUN npm ci
COPY web/admin-panel/ ./
RUN npm run build

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:22-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7443 \
    ADMIN_PORT=7444

WORKDIR /app

# Only runtime dependency is `pg`; install exactly from the lockfile.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/src ./src
COPY server/scripts ./scripts

# Admin panel build output, at the path the admin app resolves.
COPY --from=admin-panel /build/admin-panel/dist /web/admin-panel/dist

# Receipts fallback dir (production uses Supabase Storage; harmless locally).
RUN mkdir -p /app/data/receipts && chown -R node:node /app /web
USER node

EXPOSE 7443 7444

# Default process = user API. The admin app runs as a second process
# (see fly.toml process groups) with: node src/admin-main.js
CMD ["node", "src/server.js"]
