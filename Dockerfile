FROM node:20-slim

# Install Docker CLI (for driving sibling containers)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

# Note: The dashboard is not included in this image (API-only).
# To serve the dashboard, build it separately:
#   cd dashboard && npm run build
# Then copy dashboard/dist/dashboard/browser/ into the container,
# or run the Express server locally with a pre-built dashboard.

RUN mkdir -p /app/outputs /app/generated-projects

# TLS: Use NODE_EXTRA_CA_CERTS for corporate CAs instead of disabling validation.
# Set NODE_TLS_REJECT_UNAUTHORIZED=0 in docker-compose.yml env ONLY if absolutely required.
# ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

EXPOSE 3000

CMD ["npx", "tsx", "src/index.ts"]
