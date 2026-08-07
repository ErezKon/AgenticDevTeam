# Dockerfile for Vue 3 frontend using Vite
# Build stage
FROM node:18-alpine AS build
WORKDIR /app
# Install dependencies first for layer caching
COPY package.json .
RUN npm install
# Copy the rest of the source code
COPY . .
RUN npm run build

# Production stage – serve with nginx
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80

