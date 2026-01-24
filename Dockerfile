FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY packages/core/package*.json ./packages/core/
COPY packages/sidecar/package*.json ./packages/sidecar/

# Install dependencies
RUN npm install

# Copy source
COPY packages/core ./packages/core
COPY packages/sidecar ./packages/sidecar

# Build
WORKDIR /app/packages/core
RUN npm run build

WORKDIR /app/packages/sidecar
RUN npm run build

# Runtime
ENV NODE_ENV=production

# Default command - monitor mode
CMD ["node", "dist/index.js", "monitor"]
