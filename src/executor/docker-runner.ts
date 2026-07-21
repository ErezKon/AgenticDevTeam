/**
 * Docker Runner — builds images and runs containers for the generated project.
 *
 * Uses dockerode to talk to the Docker daemon via socket or DOCKER_HOST.
 */
import Dockerode from 'dockerode';
import * as path from 'path';
import * as fs from 'fs';
import { DOCKER_HOST } from '../config';
import { getLogger } from '../utils/logger';

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

    log.info(`Building image "${imageName}" from ${relDockerfile}...`);

    try {
        const stream = await docker.buildImage(
            { context: contextPath, src: ['.'] } as any,
            { t: imageName, dockerfile: relDockerfile },
        );

        const logs = await new Promise<string>((resolve, reject) => {
            const chunks: string[] = [];
            docker.modem.followProgress(
                stream,
                (err: any, output: any) => {
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
        return { imageName, success: true, logs };
    } catch (err: any) {
        log.error(`Build failed for "${imageName}": ${err.message}`);
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

        return {
            containerId: container.id,
            containerName,
            success: true,
            logs: logText,
            ports: portBindings,
        };
    } catch (err: any) {
        log.error(`Run failed for "${containerName}": ${err.message}`);
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

        for (let attempt = 0; attempt < retries; attempt++) {
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
    try {
        const container = docker.getContainer(containerName);
        await container.stop().catch(() => {});
        await container.remove().catch(() => {});
        log.info(`Stopped and removed container "${containerName}"`);
    } catch (err: any) {
        log.warn(`Could not stop container "${containerName}": ${err.message}`);
    }
}
