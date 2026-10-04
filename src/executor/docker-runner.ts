/**
 * Docker Runner — builds images and runs containers for the generated project.
 *
 * Uses dockerode to talk to the Docker daemon via socket or DOCKER_HOST.
 */
import Dockerode from 'dockerode';
import * as path from 'path';
import { DOCKER_HOST } from '../config';
import { getLogger } from '../utils/logger';
import { isDebugMode, trace, scrubText, serializeError } from '../utils/debug-trace';

/** Build output keeps 80 % of its trace budget for the tail, where the failing step prints. */
const LOG_HEAD_RATIO = 0.2;

const log = getLogger('[DockerRunner]', 33);

function createDocker(): Dockerode {
    if (DOCKER_HOST) {
        const url = new URL(DOCKER_HOST);
        return new Dockerode({ host: url.hostname, port: parseInt(url.port || '2375') });
    }
    return new Dockerode();
}

export interface BuildResult {
    imageName: string;
    success: boolean;
    logs: string;
    error?: string;
}

export interface RunResult {
    containerId: string;
    containerName: string;
    success: boolean;
    logs: string;
    error?: string;
    ports: Record<string, string>;
}

export interface HealthCheckResult {
    service: string;
    url: string;
    status: 'healthy' | 'unhealthy';
    statusCode?: number;
    error?: string;
}

/**
 * Build a Docker image from a Dockerfile in the project workspace.
 */
export async function buildImage(
    workspacePath: string,
    dockerfilePath: string,
    imageName: string,
): Promise<BuildResult> {
    const docker = createDocker();
    const contextPath = workspacePath;
    const relDockerfile = path.relative(workspacePath, path.resolve(workspacePath, dockerfilePath));
    const startedAt = Date.now();
    const chunks: string[] = [];
    const traceFields = { kind: 'docker' as const, op: 'build', image: imageName, dockerfile: relDockerfile, context: contextPath };

    log.info(`Building image "${imageName}" from ${relDockerfile}...`);

    try {
        const stream = await docker.buildImage(
            { context: contextPath, src: ['.'] } as any,
            { t: imageName, dockerfile: relDockerfile },
        );

        const logs = await new Promise<string>((resolve, reject) => {
            docker.modem.followProgress(
                stream,
                (err: any, _output: any) => {
                    if (err) reject(err);
                    else resolve(chunks.join(''));
                },
                (event: any) => {
                    const line = event.stream || event.status || JSON.stringify(event);
                    chunks.push(line);
                },
            );
        });

        log.info(`Image "${imageName}" built successfully`);
        if (isDebugMode()) {
            trace({ ...traceFields, event: 'end', durationMs: Date.now() - startedAt, logs: scrubText(logs, LOG_HEAD_RATIO) });
        }
        return { imageName, success: true, logs };
    } catch (err: any) {
        log.error(`Build failed for "${imageName}": ${err.message}`);
        if (isDebugMode()) {
            trace({
                ...traceFields, event: 'error', durationMs: Date.now() - startedAt,
                logs: scrubText(chunks.join(''), LOG_HEAD_RATIO), error: serializeError(err),
            });
        }
        return { imageName, success: false, logs: '', error: err.message };
    }
}

/**
 * Run a container from a built image.
 */
export async function runContainer(
    imageName: string,
    containerName: string,
    portBindings: Record<string, string>,
    envVars?: string[],
    network?: string,
): Promise<RunResult> {
    const docker = createDocker();
    log.info(`Starting container "${containerName}" from image "${imageName}"...`);
    const startedAt = Date.now();
    const traceFields = {
        kind: 'docker' as const, op: 'run', image: imageName, container: containerName,
        ports: portBindings, network, envKeys: (envVars ?? []).map(e => e.split('=')[0]),
    };

    try {
        // Build ExposedPorts and PortBindings
        const exposedPorts: Record<string, {}> = {};
        const hostPortBindings: Record<string, { HostPort: string }[]> = {};
        for (const [containerPort, hostPort] of Object.entries(portBindings)) {
            const key = containerPort.includes('/') ? containerPort : `${containerPort}/tcp`;
            exposedPorts[key] = {};
            hostPortBindings[key] = [{ HostPort: hostPort }];
        }

        const container = await docker.createContainer({
            Image: imageName,
            name: containerName,
            ExposedPorts: exposedPorts,
            Env: envVars,
            HostConfig: {
                PortBindings: hostPortBindings,
                ...(network ? { NetworkMode: network } : {}),
            },
        });

        await container.start();
        log.info(`Container "${containerName}" started`);

        // Grab a few lines of initial logs
        const logStream = await container.logs({ stdout: true, stderr: true, tail: 30 });
        const logText = logStream.toString('utf-8').slice(0, 3000);
        trace({ ...traceFields, event: 'end', containerId: container.id, durationMs: Date.now() - startedAt, logs: logText });

        return {
            containerId: container.id,
            containerName,
            success: true,
            logs: logText,
            ports: portBindings,
        };
    } catch (err: any) {
        log.error(`Run failed for "${containerName}": ${err.message}`);
        trace({ ...traceFields, event: 'error', durationMs: Date.now() - startedAt, error: serializeError(err) });
        return {
            containerId: '',
            containerName,
            success: false,
            logs: '',
            error: err.message,
            ports: portBindings,
        };
    }
}

/**
 * Run health checks against running services.
 */
export async function healthCheck(
    checks: { service: string; url: string }[],
    retries = 5,
    delayMs = 3000,
): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];

    for (const check of checks) {
        let lastError = '';
        let healthy = false;
        let statusCode: number | undefined;
        let attempts = 0;
        const startedAt = Date.now();

        for (let attempt = 0; attempt < retries; attempt++) {
            attempts += 1;
            try {
                const resp = await fetch(check.url, { signal: AbortSignal.timeout(5000) });
                statusCode = resp.status;
                if (resp.ok) {
                    healthy = true;
                    break;
                }
                lastError = `HTTP ${resp.status}`;
            } catch (err: any) {
                lastError = err.message;
            }
            if (attempt < retries - 1) {
                await new Promise(r => setTimeout(r, delayMs));
            }
        }

        log.info(`Health check ${check.service}: ${healthy ? 'healthy' : 'unhealthy'}`);
        trace({
            kind: 'docker', event: 'end', op: 'health', service: check.service, url: check.url,
            ok: healthy, statusCode, attempts, durationMs: Date.now() - startedAt,
            ...(healthy ? {} : { error: lastError }),
        });
        results.push({
            service: check.service,
            url: check.url,
            status: healthy ? 'healthy' : 'unhealthy',
            statusCode,
            error: healthy ? undefined : lastError,
        });
    }

    return results;
}

/**
 * Stop and remove a container by name.
 */
export async function stopContainer(containerName: string): Promise<void> {
    const docker = createDocker();
    const startedAt = Date.now();
    const ignoredErrors: unknown[] = [];
    try {
        const container = docker.getContainer(containerName);
        await container.stop().catch((e: unknown) => { ignoredErrors.push(e); });
        await container.remove().catch((e: unknown) => { ignoredErrors.push(e); });
        log.info(`Stopped and removed container "${containerName}"`);
        trace({
            kind: 'docker', event: 'end', op: 'stop', container: containerName, durationMs: Date.now() - startedAt,
            ...(ignoredErrors.length > 0 ? { ignoredErrors: ignoredErrors.map(e => serializeError(e)) } : {}),
        });
    } catch (err: any) {
        log.warn(`Could not stop container "${containerName}": ${err.message}`);
        trace({ kind: 'docker', event: 'error', op: 'stop', container: containerName, durationMs: Date.now() - startedAt, error: serializeError(err) });
    }
}
