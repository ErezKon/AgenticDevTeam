# Stage 1: Build the Angular application
FROM node:18-alpine AS builder
WORKDIR /app

# Install dependencies based on package.json and package-lock.json (or npm-shrinkwrap.json)
COPY package*.json ./
RUN npm ci

# Copy the rest of the source code and build the application
COPY . .
RUN npm run build --prod

# Stage 2: Serve the compiled app with Nginx
FROM nginx:alpine
COPY --from=builder /app/dist/frontend /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
