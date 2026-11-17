/**
 * Plan 30-A / 30-C: run preflight — runtime floor and unpriced-model detection.
 */
jest.mock('../src/utils/logger');
jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    LLM_MODEL: 'priced-model',
    ARCHITECT_MODEL: 'priced-model',
    PRODUCT_MANAGER_MODEL: 'priced-model',
    DBA_MODEL: 'priced-model',
    TEAM_LEADER_MODEL: 'priced-model',
    DEVOPS_MODEL: 'priced-model',
    CODEBASE_ANALYZER_MODEL: undefined,
    PRINCIPAL_DEV_MODEL: 'unpriced-principal',
    SENIOR_DEV_MODEL: 'priced-model',
    JUNIOR_DEV_MODEL: 'priced-model',
    QA_MODEL: 'priced-model',
    STRONG_FIXER_MODEL: '',
    MODEL_PRICING: { 'priced-model': { inputPer1k: 0.001, outputPer1k: 0.002 } },
    PREFLIGHT_MIN_FREE_DISK_GB: 0,
}));

import * as os from 'os';
import {
    MIN_NODE_VERSION, PreflightError, checkNodeRuntime, collectPreflight,
    compareVersions, configuredModels, findHeadlessBrowser, findUnpricedModels, freeDiskGb, runPreflight,
} from '../src/utils/preflight';

// Host-independent: a browser is "configured" for every test unless a test overrides it.
// (Restored explicitly: the jest env guard is not active, and tests run in-band.)
const originalChromeBin = process.env.CHROME_BIN;
beforeEach(() => { process.env.CHROME_BIN = '/opt/test/chrome'; });
afterAll(() => {
    if (originalChromeBin === undefined) delete process.env.CHROME_BIN;
    else process.env.CHROME_BIN = originalChromeBin;
});

describe('compareVersions', () => {
    it('orders dotted versions numerically, not lexically', () => {
        expect(compareVersions('20.10.0', '20.9.9')).toBeGreaterThan(0);
        expect(compareVersions('19.8.1', '20.10.0')).toBeLessThan(0);
        expect(compareVersions('v20.10.0', '20.10')).toBe(0);
    });
});

describe('checkNodeRuntime', () => {
    it('rejects Node 19.8.1 — the runtime that crashed session 1', () => {
        const problem = checkNodeRuntime('19.8.1', false);
        expect(problem).toContain('Node 19.8.1 is not supported');
        expect(problem).toContain(`>= ${MIN_NODE_VERSION}`);
        expect(problem).toContain('AbortSignal.any is missing');
    });

    it('rejects a new-enough version string when AbortSignal.any is absent', () => {
        expect(checkNodeRuntime('22.0.0', false)).toContain('AbortSignal.any is missing');
    });

    it('rejects versions below the dependency engines floor even with AbortSignal.any', () => {
        expect(checkNodeRuntime('20.5.0', true)).toContain('Node 20.5.0 is not supported');
    });

    it('accepts the floor and newer runtimes', () => {
        expect(checkNodeRuntime(MIN_NODE_VERSION, true)).toBeNull();
        expect(checkNodeRuntime('25.9.0', true)).toBeNull();
    });
});

describe('unpriced model detection', () => {
    it('deduplicates configured models and drops empty/undefined entries', () => {
        expect(configuredModels()).toEqual(['priced-model', 'unpriced-principal']);
    });

    it('lists models that estimateCost would price at $0', () => {
        expect(findUnpricedModels()).toEqual(['unpriced-principal']);
        expect(findUnpricedModels(['priced-model'])).toEqual([]);
    });

    it('reports unpriced models as warnings, not errors', () => {
        const result = collectPreflight();
        expect(result.errors).toEqual([]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('"unpriced-principal" has no MODEL_PRICING entry');
    });
});

describe('host checks (30-G)', () => {
    it('prefers CHROME_BIN / CHROMIUM_BIN, then a browser binary on PATH', () => {
        expect(findHeadlessBrowser(() => false, { CHROME_BIN: '/x/chrome' })).toBe('/x/chrome');
        expect(findHeadlessBrowser(() => false, { CHROMIUM_BIN: '/x/chromium' })).toBe('/x/chromium');
        expect(findHeadlessBrowser(bin => bin === 'chromium', {})).toBe('chromium');
        expect(findHeadlessBrowser(() => false, {})).toBeNull();
    });

    it('warns (does not fail) when no headless browser is available', () => {
        delete process.env.CHROME_BIN;
        delete process.env.CHROMIUM_BIN;
        const originalPath = process.env.PATH;
        process.env.PATH = '/nonexistent';
        try {
            const result = collectPreflight();
            expect(result.errors).toEqual([]);
            expect(result.warnings.some(w => w.includes('No headless browser found'))).toBe(true);
        } finally {
            process.env.PATH = originalPath;
        }
    });

    it('measures free disk on the nearest existing ancestor of a missing directory', () => {
        const gb = freeDiskGb(`${os.tmpdir()}/does/not/exist/yet`);
        expect(gb).not.toBeNull();
        expect(gb!).toBeGreaterThan(0);
    });
});

describe('runPreflight', () => {
    const original = process.versions.node;
    const originalAny = (AbortSignal as any).any;
    afterEach(() => {
        Object.defineProperty(process.versions, 'node', { value: original });
        (AbortSignal as any).any = originalAny;
    });

    it('passes on a supported runtime and returns the warnings', () => {
        Object.defineProperty(process.versions, 'node', { value: '25.9.0' });
        (AbortSignal as any).any = originalAny ?? (() => undefined);
        expect(runPreflight().warnings).toHaveLength(1);
    });

    it('throws PreflightError on an unsupported runtime (fail closed)', () => {
        Object.defineProperty(process.versions, 'node', { value: '19.8.1' });
        expect(() => runPreflight()).toThrow(PreflightError);
        expect(() => runPreflight()).toThrow(/Node 19\.8\.1 is not supported/);
    });
});
