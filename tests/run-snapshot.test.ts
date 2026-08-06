/**
 * Run snapshot — unit tests.
 *
 * Tests redactState, writeStateSnapshot, writeRunManifest.
 * Uses a temp directory for file I/O.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock config to keep event-bus happy
jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    EVENT_BUFFER_SIZE: 10,
    MAX_RUN_TOKENS: 0,
    MAX_RUN_COST_USD: 0,
    MAX_RUN_WALL_MS: 0,
    BUDGET_WARN_AT: 0.70,
    BUDGET_DEGRADE_AT: 0.90,
}));

import {
    redactState,
    writeStateSnapshot,
    writeRunManifest,
} from '../src/utils/run-snapshot';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-snapshot-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── redactState ────────────────────────────────────────────────────────────

describe('redactState', () => {
    it('redacts token fields', () => {
        const state = {
            gitContext: { token: 'ghp_secret123', owner: 'acme', repo: 'foo' },
            input: { systemName: 'test' },
        };
        const result = redactState(state);
        expect(result.gitContext.token).toBe('***REDACTED***');
        expect(result.gitContext.owner).toBe('acme');
        expect(result.input.systemName).toBe('test');
    });

    it('redacts nested apiKey fields', () => {
        const state = { config: { apiKey: 'sk-123', host: 'localhost' } };
        const result = redactState(state);
        expect(result.config.apiKey).toBe('***REDACTED***');
        expect(result.config.host).toBe('localhost');
    });

    it('does not redact empty string values', () => {
        const state = { gitContext: { token: '', owner: 'x' } };
        const result = redactState(state);
        expect(result.gitContext.token).toBe('');
    });

    it('handles null and undefined', () => {
        expect(redactState(null)).toBeNull();
        expect(redactState(undefined)).toBeUndefined();
    });

    it('returns a deep copy (not a reference)', () => {
        const state = { input: { systemName: 'test' } };
        const result = redactState(state);
        expect(result).not.toBe(state);
        result.input.systemName = 'changed';
        expect(state.input.systemName).toBe('test');
    });
});

// ─── writeStateSnapshot ─────────────────────────────────────────────────────

describe('writeStateSnapshot', () => {
    it('writes state.json to outputPath', () => {
        const state = {
            input: { systemName: 'test' },
            gitContext: { token: 'secret', owner: 'o', repo: 'r' },
            phase: 'finalize',
        };
        const dest = writeStateSnapshot(tmpDir, state);
        expect(dest).toBe(path.join(tmpDir, 'state.json'));
        expect(fs.existsSync(dest!)).toBe(true);

        const written = JSON.parse(fs.readFileSync(dest!, 'utf-8'));
        expect(written.gitContext.token).toBe('***REDACTED***');
        expect(written.input.systemName).toBe('test');
    });

    it('returns null on invalid path', () => {
        const result = writeStateSnapshot('/nonexistent/path/xyz', { input: {} });
        expect(result).toBeNull();
    });
});

// ─── writeRunManifest ───────────────────────────────────────────────────────

describe('writeRunManifest', () => {
    it('writes run-manifest.json with correct structure', () => {
        const state = {
            input: { systemName: 'TestProject', runType: 'greenfield' },
            phase: 'finalize',
            epics: [{ id: '1' }],
            userStories: [{ id: '1' }, { id: '2' }],
            tasks: [],
            assignments: [{ id: 'a1' }],
            fileChanges: [{ path: 'x' }],
            testReports: [],
            bugs: [],
            pullRequests: [{ number: 1 }],
            artifacts: [{ title: 'x' }],
        };
        const dest = writeRunManifest(tmpDir, state, 'completed');
        expect(dest).toBe(path.join(tmpDir, 'run-manifest.json'));
        expect(fs.existsSync(dest!)).toBe(true);

        const manifest = JSON.parse(fs.readFileSync(dest!, 'utf-8'));
        expect(manifest.status).toBe('completed');
        expect(manifest.systemName).toBe('TestProject');
        expect(manifest.runType).toBe('greenfield');
        expect(manifest.finalPhase).toBe('finalize');
        expect(manifest.counts.epics).toBe(1);
        expect(manifest.counts.userStories).toBe(2);
        expect(manifest.counts.assignments).toBe(1);
        expect(manifest.counts.fileChanges).toBe(1);
        expect(manifest.counts.pullRequests).toBe(1);
        expect(manifest.counts.artifacts).toBe(1);
        expect(manifest.generatedAt).toBeTruthy();
        expect(manifest.tokenUsage).toBeDefined();
        expect(manifest.budget).toBeDefined();
        expect(typeof manifest.eventCount).toBe('number');
    });

    it('handles crashed status', () => {
        const state = { input: { systemName: 'CrashTest' }, phase: 'architect' };
        const dest = writeRunManifest(tmpDir, state, 'crashed');
        const manifest = JSON.parse(fs.readFileSync(dest!, 'utf-8'));
        expect(manifest.status).toBe('crashed');
        expect(manifest.systemName).toBe('CrashTest');
    });

    it('returns null on invalid path', () => {
        const result = writeRunManifest('/nonexistent/path/xyz', {}, 'failed');
        expect(result).toBeNull();
    });
});
