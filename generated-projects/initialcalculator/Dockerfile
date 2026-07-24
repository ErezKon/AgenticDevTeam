# Simple Dockerfile for static SPA using nginx
FROM nginx:alpine
# Remove default nginx static assets
RUN rm -rf /usr/share/nginx/html/*
# Copy all project files (including index.html) to nginx html directory
COPY . /usr/share/nginx/html
# Expose port 80
EXPOSE 80
# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://localhost || exit 1
