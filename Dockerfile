FROM node:18-alpine

# Native builds (better-sqlite3) need these build tools
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies first for better layer caching
COPY package*.json ./
RUN npm install --production

# Copy the rest of the app
COPY . .

# SQLite lives in /app/data. Mount a Railway Volume here for persistence.
RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
