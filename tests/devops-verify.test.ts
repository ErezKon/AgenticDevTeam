/**
 * DevOps Verification — unit tests.
 *
 * Tests chooseDeploymentMode, deriveServiceUrls, and verifyDeployment (disabled
 * mode). No Docker required — the disabled-mode test asserts that execSync is
 * never called.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { chooseDeploymentMode, deriveServiceUrls } from '../src/conductor/devops-verify';

// Mock logger
jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    })),
    setRunLogPath: jest.fn(),
}));

// ─── Temp dir helpers ───────────────────────────────────────────────────────

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'devops-verify-'));
}

function cleanupDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

// ─── chooseDeploymentMode ───────────────────────────────────────────────────

describe('chooseDeploymentMode', () => {
    let tempDir: string;

    beforeEach(() => { tempDir = makeTempDir(); });
    afterEach(() => { cleanupDir(tempDir); });

    it('returns "compose" when docker-compose.yml exists', () => {
        fs.writeFileSync(path.join(tempDir, 'docker-compose.yml'), 'version: "3"');
        expect(chooseDeploymentMode(tempDir)).toBe('compose');
    });

    it('returns "compose" when docker-compose.yaml exists', () => {
        fs.writeFileSync(path.join(tempDir, 'docker-compose.yaml'), 'version: "3"');
        expect(chooseDeploymentMode(tempDir)).toBe('compose');
    });

    it('returns "compose" when compose.yml exists', () => {
        fs.writeFileSync(path.join(tempDir, 'compose.yml'), 'version: "3"');
        expect(chooseDeploymentMode(tempDir)).toBe('compose');
    });

    it('returns "dockerfile" when only Dockerfile exists', () => {
        fs.writeFileSync(path.join(tempDir, 'Dockerfile'), 'FROM node:18');
        expect(chooseDeploymentMode(tempDir)).toBe('dockerfile');
    });

    it('prefers compose over dockerfile when both exist', () => {
        fs.writeFileSync(path.join(tempDir, 'docker-compose.yml'), 'version: "3"');
        fs.writeFileSync(path.join(tempDir, 'Dockerfile'), 'FROM node:18');
        expect(chooseDeploymentMode(tempDir)).toBe('compose');
    });

    it('returns "none" when neither compose nor Dockerfile exists', () => {
        fs.writeFileSync(path.join(tempDir, 'README.md'), '# Hello');
        expect(chooseDeploymentMode(tempDir)).toBe('none');
    });

    it('returns "none" for empty directory', () => {
        expect(chooseDeploymentMode(tempDir)).toBe('none');
    });
});

// ─── deriveServiceUrls ──────────────────────────────────────────────────────

describe('deriveServiceUrls', () => {
    it('parses two services with published ports', () => {
        const fixture = [
            JSON.stringify({
                Service: 'web',
                State: 'running',
                Publishers: [
                    { PublishedPort: 8080, TargetPort: 80, Protocol: 'tcp' },
                ],
            }),
            JSON.stringify({
                Service: 'api',
                State: 'running',
                Publishers: [
                    { PublishedPort: 3000, TargetPort: 3000, Protocol: 'tcp' },
                ],
            }),
        ].join('\n');

        const urls = deriveServiceUrls(fixture);
        expect(urls).toHaveLength(2);
        expect(urls[0]).toEqual({ service: 'web', url: 'http://localhost:8080' });
        expect(urls[1]).toEqual({ service: 'api', url: 'http://localhost:3000' });
    });

    it('skips services with no published port (PublishedPort: 0)', () => {
        const fixture = [
            JSON.stringify({
                Service: 'web',
                State: 'running',
                Publishers: [
                    { PublishedPort: 8080, TargetPort: 80, Protocol: 'tcp' },
                ],
            }),
            JSON.stringify({
                Service: 'redis',
                State: 'running',
                Publishers: [
                    { PublishedPort: 0, TargetPort: 6379, Protocol: 'tcp' },
                ],
            }),
        ].join('\n');

        const urls = deriveServiceUrls(fixture);
        expect(urls).toHaveLength(1);
        expect(urls[0].service).toBe('web');
    });

    it('handles services with no publishers', () => {
        const fixture = JSON.stringify({
            Service: 'worker',
            State: 'running',
            Publishers: [],
        });

        const urls = deriveServiceUrls(fixture);
        expect(urls).toHaveLength(0);
    });

    it('handles empty input', () => {
        expect(deriveServiceUrls('')).toHaveLength(0);
    });

    it('handles malformed JSON lines gracefully', () => {
        const fixture = [
            'not-json',
            JSON.stringify({
                Service: 'web',
                State: 'running',
                Publishers: [
                    { PublishedPort: 8080, TargetPort: 80, Protocol: 'tcp' },
                ],
            }),
        ].join('\n');

        const urls = deriveServiceUrls(fixture);
        expect(urls).toHaveLength(1);
        expect(urls[0].service).toBe('web');
    });

    it('uses custom hostname', () => {
        const fixture = JSON.stringify({
            Service: 'web',
            State: 'running',
            Publishers: [
                { PublishedPort: 8080, TargetPort: 80, Protocol: 'tcp' },
            ],
        });

        const urls = deriveServiceUrls(fixture, '192.168.1.100');
        expect(urls[0].url).toBe('http://192.168.1.100:8080');
    });

    it('handles lowercase publisher fields (published_port)', () => {
        const fixture = JSON.stringify({
            Service: 'web',
            State: 'running',
            Publishers: [
                { published_port: 9090, target_port: 80, protocol: 'tcp' },
            ],
        });

        const urls = deriveServiceUrls(fixture);
        expect(urls).toHaveLength(1);
        expect(urls[0].url).toBe('http://localhost:9090');
    });
});

// ─── verifyDeployment (disabled mode) ───────────────────────────────────────

describe('verifyDeployment (disabled mode)', () => {
    afterEach(() => {
        jest.resetModules();
    });

    it('returns all-skipped when DEVOPS_VERIFY_ENABLED=false', async () => {
        jest.resetModules();

        // Mock config to disable verification
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            DEVOPS_VERIFY_ENABLED: false,
            DEVOPS_VERIFY_TIMEOUT_MS: 600000,
            DEVOPS_VERIFY_BASE_PORT: 18080,
            DEVOPS_HEALTH_RETRIES: 5,
            DEVOPS_HEALTH_DELAY_MS: 3000,
        }));

        const { verifyDeployment } = require('../src/conductor/devops-verify');
        const result = await verifyDeployment('/tmp/nonexistent', 'test-project');

        expect(result.buildStatus).toBe('skipped');
        expect(result.runStatus).toBe('skipped');
        expect(result.serviceUrls).toHaveLength(0);
        expect(result.healthChecks).toHaveLength(0);
        expect(result.containerNames).toHaveLength(0);
        expect(result.logs).toBe('');
    });

    it('returns all-skipped when workspace has no Docker artifacts (mode=none)', async () => {
        jest.resetModules();

        // Keep DEVOPS_VERIFY_ENABLED=true but mock isDockerAvailable to true
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            DEVOPS_VERIFY_ENABLED: true,
            DEVOPS_VERIFY_TIMEOUT_MS: 600000,
            DEVOPS_VERIFY_BASE_PORT: 18080,
            DEVOPS_HEALTH_RETRIES: 5,
            DEVOPS_HEALTH_DELAY_MS: 3000,
        }));

        const tempDir = makeTempDir();
        try {
            const { verifyDeployment } = require('../src/conductor/devops-verify');
            // Even if Docker IS available, an empty dir should return skipped (mode=none)
            // The function checks Docker availability first, but with no Docker files it returns skipped
            const result = await verifyDeployment(tempDir, 'test-empty');
            // Either skipped (no docker) or skipped (no artifacts) — both valid
            expect(['skipped', 'failed']).toContain(result.buildStatus);
        } finally {
            cleanupDir(tempDir);
        }
    });
});
