/**
 * Deterministic Dockerfile + docker-compose.yml generator.
 *
 * When the DevOps agent fails or produces nothing, this module generates
 * infrastructure from detected stack roots using simple templates — no LLM.
 * Covers: Node static SPA (nginx), Node server, Python, Go.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../utils/logger';
import { DOCKER_ALLOW_INSECURE_NPM } from '../config';
import type { StackRoot } from './quality-gates';
import type { RepoContract } from '../agents/_shared/schemas/repo-contract.schema';

const log = getLogger('[DevOpsFallback]', 33);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FileChange {
    path: string;
    action: 'created' | 'modified';
}

export interface FallbackResult {
    files: FileChange[];
    composeServices: string[];
}

// ─── Templates ──────────────────────────────────────────────────────────────

/**
 * Template for a static SPA served by nginx (multi-stage build).
 * @param buildOutputDir - Build output directory, e.g. 'dist'.
 */
function spaDockerfile(buildOutputDir: string): string {
    const npmInstall = DOCKER_ALLOW_INSECURE_NPM
        ? 'RUN npm config set strict-ssl false && npm ci'
        : 'RUN npm ci';
    return `FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
${npmInstall}
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/${buildOutputDir} /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`;
}

/**
 * Template for a Node.js server (TypeScript or JavaScript).
 * @param entryPoint - Entry point file, e.g. 'src/server.ts' or 'src/index.js'.
 */
function nodeServerDockerfile(entryPoint: string): string {
    const ext = path.extname(entryPoint);
    const needsTsc = ext === '.ts';
    const buildStep = needsTsc
        ? `RUN npm run build 2>/dev/null || npx tsc --outDir dist 2>/dev/null || true`
        : '';
    const runCmd = needsTsc
        ? `CMD ["node", "dist/${entryPoint.replace(/\.ts$/, '.js').replace(/^src\//, '')}"]`
        : `CMD ["node", "${entryPoint}"]`;
    const npmInstall = DOCKER_ALLOW_INSECURE_NPM
        ? 'RUN npm config set strict-ssl false && npm ci --omit=dev'
        : 'RUN npm ci --omit=dev';
    return `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
${npmInstall}
COPY . .
${buildStep}
EXPOSE 3000
${runCmd}
`;
}

/**
 * Template for a Python service (uvicorn).
 */
function pythonDockerfile(): string {
    return `FROM python:3.12-slim
WORKDIR /app
COPY requirements*.txt ./
RUN pip install --no-cache-dir -r requirements.txt 2>/dev/null || true
COPY . .
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
`;
}

/**
 * Template for a Go service (multi-stage build).
 */
function goDockerfile(): string {
    return `FROM golang:1.22-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /server ./...

FROM alpine:3.19
COPY --from=build /server /server
EXPOSE 8080
CMD ["/server"]
`;
}

// ─── Fallback generator ─────────────────────────────────────────────────────

/**
 * Generate a deterministic Dockerfile + docker-compose.yml from detected stack roots.
 *
 * Template-based, no LLM. Covers: node static SPA, node server, python, go.
 * Skips roots that already have a Dockerfile. Uses RepoContract data (when
 * available) for buildOutputDir, entryPoints, and kind.
 *
 * @param workspacePath - Absolute path to the workspace root.
 * @param roots         - Detected stack roots from quality-gates.
 * @param contract      - Optional RepoContract for richer metadata.
 * @returns Created file paths and compose service names.
 */
export function generateFallbackDeployment(
    workspacePath: string,
    roots: StackRoot[],
    contract?: RepoContract | null,
): FallbackResult {
    const files: FileChange[] = [];
    const composeServices: string[] = [];
    const serviceBlocks: string[] = [];
    let portCounter = 3000;

    for (const root of roots) {
        const rootDir = root.relDir || '.';
        const dockerfilePath = rootDir === '.' ? 'Dockerfile' : path.join(rootDir, 'Dockerfile');
        const absDockerfile = path.join(workspacePath, dockerfilePath);

        // Skip if a Dockerfile already exists for this root
        if (fs.existsSync(absDockerfile)) continue;

        // Determine the contract root if available
        const contractRoot = contract?.roots?.find(r => r.dir === rootDir || r.dir === root.dir);
        const entryPoints = contractRoot?.entryPoints ?? [];
        const buildOutputDir = contractRoot?.buildOutputDir ?? null;
        const kind = contractRoot?.kind ?? (root.stack === 'node' ? 'frontend' : root.stack);

        let dockerfile = '';
        let serviceName = rootDir === '.'
            ? 'app'
            : rootDir.replace(/[/\\]/g, '-').replace(/^packages-/, '');

        if (root.stack === 'node') {
            if (kind === 'frontend' || kind === 'shared') {
                // SPA: build and serve via nginx
                const outDir = buildOutputDir ?? 'dist';
                dockerfile = spaDockerfile(outDir);
            } else {
                // Backend: node server
                const entry = entryPoints[0] ?? 'src/index.js';
                dockerfile = nodeServerDockerfile(entry);
            }
        } else if (root.stack === 'python') {
            dockerfile = pythonDockerfile();
        } else if (root.stack === 'go') {
            dockerfile = goDockerfile();
        } else {
            // Unknown stack — skip
            log.info(`No fallback template for stack '${root.stack}' at '${rootDir}' — skipping`);
            continue;
        }

        // Write the Dockerfile
        const dir = path.dirname(absDockerfile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(absDockerfile, dockerfile, 'utf-8');
        files.push({ path: dockerfilePath, action: 'created' });
        log.info(`Generated fallback Dockerfile at ${dockerfilePath}`);

        // Write .dockerignore if missing
        const dockerignorePath = path.join(path.dirname(absDockerfile), '.dockerignore');
        if (!fs.existsSync(dockerignorePath)) {
            const ignore = `node_modules\n.git\ndist\nbuild\ncoverage\n*.log\n.env*\n`;
            fs.writeFileSync(dockerignorePath, ignore, 'utf-8');
            const relIgnore = rootDir === '.' ? '.dockerignore' : path.join(rootDir, '.dockerignore');
            files.push({ path: relIgnore, action: 'created' });
        }

        // Build compose service entry
        const port = portCounter++;
        const contextDir = rootDir === '.' ? '.' : `./${rootDir}`;
        const dockerfileRel = 'Dockerfile';
        serviceBlocks.push(`  ${serviceName}:
    build:
      context: ${contextDir}
      dockerfile: ${dockerfileRel}
    ports:
      - "${port}:${kind === 'frontend' || kind === 'shared' ? 80 : 3000}"
    restart: unless-stopped`);
        composeServices.push(serviceName);
    }

    // Write docker-compose.yml if we generated any services
    if (serviceBlocks.length > 0) {
        const composePath = path.join(workspacePath, 'docker-compose.yml');
        if (!fs.existsSync(composePath)) {
            const compose = `version: "3.8"\nservices:\n${serviceBlocks.join('\n')}\n`;
            fs.writeFileSync(composePath, compose, 'utf-8');
            files.push({ path: 'docker-compose.yml', action: 'created' });
            log.info(`Generated fallback docker-compose.yml with ${serviceBlocks.length} service(s)`);
        }
    }

    return { files, composeServices };
}
