# ---------- Build stage ----------
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies (dev included for build)
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy configuration and source files needed to build
COPY tsconfig*.json ./
COPY nest-cli.json ./
COPY src ./src

# Build the NestJS app to ./dist
RUN npm run build

# ---------- Runtime stage ----------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install production dependencies only (includes node-pg-migrate)
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Copy built application code
COPY --from=builder /app/dist ./dist

# Copy raw SQL migration files into the runtime environment
COPY migrations ./migrations

# Environment and port defaults
ENV PORT=8080
EXPOSE 8080

# Execute database migrations before starting main server process
CMD ["npm", "run", "start:prod"]