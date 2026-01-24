FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source
COPY . .

# Build
RUN npm run build

# Runtime
ENV NODE_ENV=production

# Default command - autonomous mode
CMD ["node", "dist/index.js", "start", "--claim"]
