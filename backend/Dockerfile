# ─── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifests first for layer-cache efficiency
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma/

# Install all deps (including devDeps needed for compile)
RUN npm ci

# Generate Prisma client before compiling
RUN npx prisma generate

# Copy source and compile
COPY src ./src
RUN npm run build

# ─── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Only install production deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy Prisma artifacts
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY prisma ./prisma/

# Copy compiled JS
COPY --from=builder /app/dist ./dist

# Expose the API port
EXPOSE 3000

# Run migrations then start the server
# Using npx prisma migrate deploy (safe for production — no interactive prompts)
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
