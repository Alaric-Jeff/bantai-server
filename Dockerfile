# ---------- Build stage ----------
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies (dev included for build)
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy only files needed to build
COPY tsconfig*.json ./
COPY nest-cli.json ./
COPY src ./src

# Build the NestJS app to ./dist
RUN npm run build

# ---------- Runtime stage ----------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install production dependencies only
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Copy built artifacts
COPY --from=builder /app/dist ./dist

# Railway provides PORT; default to 8080
ENV PORT=8080
EXPOSE 8080

# Start the application (package.json: start:prod -> node dist/main.js)
CMD ["npm", "run", "start:prod"]
