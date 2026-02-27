# ============================
# Stage 1: Build dependencies
# ============================
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ============================
# Stage 2: Production image
# ============================
FROM node:22-alpine

LABEL maintainer="linkroom"
LABEL description="LinkRoom - 跨设备实时共享工作空间"

# Security: run as non-root user
RUN addgroup -S linkroom && adduser -S linkroom -G linkroom

WORKDIR /app

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application code
COPY package.json ./
COPY server.js ./
COPY public ./public

# Create uploads directory with proper permissions
RUN mkdir -p /app/public/uploads && chown -R linkroom:linkroom /app

# Switch to non-root user
USER linkroom

# Environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/server-info || exit 1

CMD ["node", "server.js"]
