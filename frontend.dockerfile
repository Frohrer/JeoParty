FROM node:18-alpine as builder

WORKDIR /app

# Copy package files, configs, and type definitions
COPY package*.json ./
COPY tsconfig.json ./
COPY global.d.ts ./

# Install dependencies
RUN npm install

# Copy source code
COPY src/ ./src/
COPY index.html ./
COPY public/ ./public/

# Build frontend
RUN npm run buildReact

# Serve using nginx
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80