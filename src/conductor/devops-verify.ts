/**
 * DevOps Verification — actually build, run, and health-check what the
 * DevOps agent produced, replacing the LLM's unverified self-report.
 *
 * The agent's self-reported buildStatus/runStatus/serviceUrls were never
 * verified (PART A5) and docker-runner.ts sat unused. The returned values
 * OVERRIDE the agent's claims. Never throws: a Docker-less environment
 * degrades to `{ buildStatus: 'skipped' }`, not a failed run.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getLogger } from '../utils/logger';
import { buildImage, runContainer, healthCheck, stopContainer } from '../executor/docker-runner';
import type { HealthCheckResult } from '../executor/docker-runner';
import {
    DEVOPS_VERIFY_ENABLED, DEVOPS_VERIFY_TIMEOUT_MS,
    DEVOPS_VERIFY_BASE_PORT, DEVOPS_HEALTH_RETRIES,
    DEVOPS_HEALTH_DELAY_MS,
} from '../config';

export type { HealthCheckResult };

const log = getLogger('[DevOpsVerify]', 33);

// ─── Types ──────────────────────────────────────────────────────────────────

export type DeploymentMode = 'compose' | 'dockerfile' | 'none';

export interface VerifyResult {
    buildStatus: 'success' | 'failed' | 'skipped';
    runStatus: 'running' | 'failed' | 'skipped';
    serviceUrls: { service: string; url: string }[];
    healthChecks: HealthCheckResult[];
    containerNames: string[];
    logs: string;
}

// ─── Pure helpers (exported for testing) ────────────────────────────────────

/**
 * Pick a deployment strategy from the files the DevOps agent produced.
 */
export function chooseDeploymentMode(workspacePath: string): DeploymentMode {
    const composeNames = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
    for (const name of composeNames) {
        if (fs.existsSync(path.join(workspacePath, name))) {
            return 'compose';
        }
    }
    if (fs.existsSync(path.join(workspacePath, 'Dockerfile'))) {
        return 'dockerfile';
    }
    return 'none';
}

/**
 * Parse `docker compose ps --format json` output into service URLs.
 *
 * The output is one JSON object per line (NDJSON), each with at least
 * `Service`, `State`, and `Publishers` (an array of port mappings).
 */
export function deriveServiceUrls(
    composePsJson: string,
    hostname: string = 'localhost',
): { service: string; url: string }[] {
    const urls: { service: string; url: string }[] = [];
    const lines = composePsJson.trim().split('\n').filter(Boolean);

    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            const service = entry.Service ?? entry.Name ?? 'unknown';
            const publishers: any[] = entry.Publishers ?? [];

            for (const pub of publishers) {
                const publishedPort = pub.PublishedPort ?? pub.published_port;
                if (publishedPort && publishedPort > 0) {
                    const proto = (pub.Protocol ?? pub.protocol ?? 'tcp') === 'tcp' ? 'http' : 'http';
                    urls.push({
                        service,
                        url: `${proto}://${hostname}:${publishedPort}`,
                    });
                }
            }
        } catch {
            // Skip unparseable lines
        }
    }

    return urls;
}

/**
 * Parse EXPOSE lines from a Dockerfile.
 */
function parseExposePorts(workspacePath: string): number[] {
    const dockerfilePath = path.join(workspacePath, 'Dockerfile');
    if (!fs.existsSync(dockerfilePath)) return [];
    const content = fs.readFileSync(dockerfilePath, 'utf-8');
    const ports: number[] = [];
    for (const match of content.matchAll(/^EXPOSE\s+(\d+)/gm)) {
        ports.push(parseInt(match[1], 10));
    }
    return ports;
}

/**
 * Check if Docker is available on the host.
 */
function isDockerAvailable(): boolean {
    try {
        execSync('docker info', { timeout: 10000, stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Truncate output to the last N characters.
 */
function truncateOutput(output: string, maxChars: number = 4000): string {
    if (output.length <= maxChars) return output;
    return '... (truncated)\n' + output.slice(-maxChars);
}

// ─── Main verification function ─────────────────────────────────────────────

/**
 * Actually build and run what the DevOps agent wrote, and health-check it.
 *
 * The agent's self-reported buildStatus/runStatus/serviceUrls were never
 * verified (PART A5) and docker-runner.ts sat unused. The returned values
 * OVERRIDE the agent's claims. Never throws: a Docker-less environment must
 * degrade to `{ buildStatus: 'skipped' }`, not fail the run.
 */
export async function verifyDeployment(
    workspacePath: string,
    projectSlug: string,
): Promise<VerifyResult> {
    const skipped: VerifyResult = {
        buildStatus: 'skipped',
        runStatus: 'skipped',
        serviceUrls: [],
        healthChecks: [],
        containerNames: [],
        logs: '',
    };

    if (!DEVOPS_VERIFY_ENABLED) {
        log.info('Deployment verification disabled (DEVOPS_VERIFY_ENABLED=false)');
        return skipped;
    }

    if (!isDockerAvailable()) {
        log.info('Docker is not available — skipping deployment verification');
        return skipped;
    }

    const mode = chooseDeploymentMode(workspacePath);
    if (mode === 'none') {
        log.info('No Docker artifacts found — skipping deployment verification');
        return { ...skipped, logs: 'No Dockerfile or docker-compose found' };
    }

    log.info(`Deployment mode: ${mode}`);
    const allLogs: string[] = [];
    const containerNames: string[] = [];

    try {
        if (mode === 'compose') {
            return await verifyCompose(workspacePath, projectSlug, allLogs, containerNames);
        } else {
            return await verifyDockerfile(workspacePath, projectSlug, allLogs, containerNames);
        }
    } catch (err: any) {
        log.error(`Deployment verification failed: ${err.message}`);
        return {
            buildStatus: 'failed',
            runStatus: 'failed',
            serviceUrls: [],
            healthChecks: [],
            containerNames,
            logs: truncateOutput(allLogs.join('\n') + '\nERROR: ' + err.message),
        };
    }
}

// ─── Compose mode ───────────────────────────────────────────────────────────

async function verifyCompose(
    workspacePath: string,
    projectSlug: string,
    allLogs: string[],
    containerNames: string[],
): Promise<VerifyResult> {
    // Validate compose file
    try {
        const validateOut = execSync('docker compose config -q', {
            cwd: workspacePath,
            timeout: DEVOPS_VERIFY_TIMEOUT_MS,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        allLogs.push(`compose config: valid`);
    } catch (err: any) {
        const stderr = err.stderr?.toString() ?? err.message;
        allLogs.push(`compose config failed: ${stderr}`);
        log.error(`docker compose config failed: ${truncateOutput(stderr)}`);
        return {
            buildStatus: 'failed',
            runStatus: 'failed',
            serviceUrls: [],
            healthChecks: [],
            containerNames: [],
            logs: truncateOutput(allLogs.join('\n')),
        };
    }

    // Build and start
    try {
        const buildOut = execSync('docker compose up -d --build', {
            cwd: workspacePath,
            timeout: DEVOPS_VERIFY_TIMEOUT_MS,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        allLogs.push(`compose up: ${truncateOutput(buildOut)}`);
    } catch (err: any) {
        const stderr = err.stderr?.toString() ?? err.message;
        allLogs.push(`compose up failed: ${stderr}`);
        log.error(`docker compose up failed: ${truncateOutput(stderr)}`);
        return {
            buildStatus: 'failed',
            runStatus: 'failed',
            serviceUrls: [],
            healthChecks: [],
            containerNames: [],
            logs: truncateOutput(allLogs.join('\n')),
        };
    }

    // Get service info
    let psOutput = '';
    try {
        psOutput = execSync('docker compose ps --format json', {
            cwd: workspacePath,
            timeout: 30000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        allLogs.push(`compose ps: ${psOutput}`);
    } catch (err: any) {
        allLogs.push(`compose ps failed: ${err.message}`);
    }

    // Extract container names for teardown
    try {
        const psNames = execSync('docker compose ps -q', {
            cwd: workspacePath,
            timeout: 10000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        containerNames.push(...psNames.trim().split('\n').filter(Boolean));
    } catch { /* best-effort */ }

    const serviceUrls = deriveServiceUrls(psOutput);
    allLogs.push(`Derived ${serviceUrls.length} service URLs`);

    // Health-check
    const checks = serviceUrls.map(s => ({ service: s.service, url: s.url }));
    const healthChecks = checks.length > 0
        ? await healthCheck(checks, DEVOPS_HEALTH_RETRIES, DEVOPS_HEALTH_DELAY_MS)
        : [];

    return {
        buildStatus: 'success',
        runStatus: serviceUrls.length > 0 ? 'running' : 'failed',
        serviceUrls,
        healthChecks,
        containerNames,
        logs: truncateOutput(allLogs.join('\n')),
    };
}

// ─── Dockerfile mode ────────────────────────────────────────────────────────

async function verifyDockerfile(
    workspacePath: string,
    projectSlug: string,
    allLogs: string[],
    containerNames: string[],
): Promise<VerifyResult> {
    const imageName = `${projectSlug}:run`;
    const containerName = `${projectSlug}-verify`;

    // Build the image
    const buildResult = await buildImage(workspacePath, 'Dockerfile', imageName);
    allLogs.push(`Build: ${buildResult.success ? 'success' : 'failed'}`);
    if (buildResult.logs) allLogs.push(truncateOutput(buildResult.logs));

    if (!buildResult.success) {
        return {
            buildStatus: 'failed',
            runStatus: 'failed',
            serviceUrls: [],
            healthChecks: [],
            containerNames: [],
            logs: truncateOutput(allLogs.join('\n')),
        };
    }

    // Parse EXPOSE ports and create port bindings
    const exposePorts = parseExposePorts(workspacePath);
    const portBindings: Record<string, string> = {};
    const serviceUrls: { service: string; url: string }[] = [];

    exposePorts.forEach((port, i) => {
        const hostPort = DEVOPS_VERIFY_BASE_PORT + i;
        portBindings[`${port}`] = `${hostPort}`;
        serviceUrls.push({
            service: `${projectSlug}-port-${port}`,
            url: `http://localhost:${hostPort}`,
        });
    });

    // Run the container
    const runResult = await runContainer(imageName, containerName, portBindings);
    allLogs.push(`Run: ${runResult.success ? 'success' : 'failed'}`);
    if (runResult.logs) allLogs.push(truncateOutput(runResult.logs));

    if (!runResult.success) {
        return {
            buildStatus: 'success',
            runStatus: 'failed',
            serviceUrls: [],
            healthChecks: [],
            containerNames: [],
            logs: truncateOutput(allLogs.join('\n')),
        };
    }

    containerNames.push(containerName);

    // Health-check
    const checks = serviceUrls.map(s => ({ service: s.service, url: s.url }));
    const healthChecks = checks.length > 0
        ? await healthCheck(checks, DEVOPS_HEALTH_RETRIES, DEVOPS_HEALTH_DELAY_MS)
        : [];

    return {
        buildStatus: 'success',
        runStatus: 'running',
        serviceUrls,
        healthChecks,
        containerNames,
        logs: truncateOutput(allLogs.join('\n')),
    };
}

// ─── Teardown ───────────────────────────────────────────────────────────────

/**
 * Stop and remove everything verifyDeployment started.
 */
export async function teardownDeployment(
    workspacePath: string,
    containerNames: string[],
): Promise<void> {
    // Try compose down first (handles compose-mode cleanup)
    const mode = chooseDeploymentMode(workspacePath);
    if (mode === 'compose') {
        try {
            execSync('docker compose down --remove-orphans', {
                cwd: workspacePath,
                timeout: 60000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            log.info('Compose teardown complete');
            return;
        } catch (err: any) {
            log.warn(`Compose teardown failed, falling back to container stop: ${err.message}`);
        }
    }

    // Stop individual containers (dockerfile mode or compose fallback)
    for (const name of containerNames) {
        try {
            await stopContainer(name);
        } catch (err: any) {
            log.warn(`Failed to stop container ${name}: ${err.message}`);
        }
    }
}
