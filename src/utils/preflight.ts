/**
 * Run preflight — checks that must pass before a run creates any external
 * side effect (GitHub repo, workspace, pushed branches).
 *
 * Plan 30-A: session 1 of the pacman-live-analysis loop ran on Node 19.8.1,
 * created a GitHub repo, pushed the system branch, and only then died on the
 * very first LLM call with `AbortSignal.any is not a function` (LangChain's
 * agent middleware needs Node >= 20.3; `@langchain/mcp-adapters` declares
 * `engines.node >= 20.10.0`). The orphaned repo then broke the rerun (F2).
 *
 * Plan 30-C: a configured model with no MODEL_PRICING entry is costed at $0,
 * so MAX_RUN_COST_USD silently cannot bind on it (claude-opus-5-5 was 23 % of
 * the claudeopus5 run's real spend). This is surfaced here, loudly, at start.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
    ARCHITECT_MODEL,
    CODEBASE_ANALYZER_MODEL,
    DBA_MODEL,
    DEVOPS_MODEL,
    GENERATED_PROJECTS_DIR,
    JUNIOR_DEV_MODEL,
    LLM_MODEL,
    MODEL_PRICING,
    PREFLIGHT_MIN_FREE_DISK_GB,
    PRINCIPAL_DEV_MODEL,
    PRODUCT_MANAGER_MODEL,
    QA_MODEL,
    SENIOR_DEV_MODEL,
    STRONG_FIXER_MODEL,
    TEAM_LEADER_MODEL,
} from '../config';
import { getLogger } from './logger';
import { isToolAvailable } from './shell-exec';

const log = getLogger('[Preflight]', 214);

/** Highest `engines.node` floor among runtime dependencies (`@langchain/mcp-adapters`). */
export const MIN_NODE_VERSION = '20.10.0';

export class PreflightError extends Error {
    constructor(public readonly problems: string[]) {
        super(`Preflight failed: ${problems.join(' | ')}`);
        this.name = 'PreflightError';
    }
}

export interface PreflightResult {
    errors: string[];
    warnings: string[];
}

/** Compare dotted numeric versions: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
    const pa = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    const pb = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * Returns a problem description when the runtime cannot run the pipeline,
 * or `null` when it can. `AbortSignal.any` is feature-detected because it is
 * the API whose absence actually crashed the run.
 */
export function checkNodeRuntime(
    version: string = process.versions.node,
    hasAbortSignalAny: boolean = typeof (AbortSignal as any).any === 'function',
): string | null {
    if (compareVersions(version, MIN_NODE_VERSION) < 0 || !hasAbortSignalAny) {
        return `Node ${version} is not supported — the pipeline requires Node >= ${MIN_NODE_VERSION}` +
            `${hasAbortSignalAny ? '' : ' (AbortSignal.any is missing)'}. ` +
            'Switch runtime before starting a run (e.g. `nvm use 20`).';
    }
    return null;
}

/** Every model the pipeline can invoke with the current configuration (deduplicated). */
export function configuredModels(): string[] {
    const models = [
        LLM_MODEL, ARCHITECT_MODEL, PRODUCT_MANAGER_MODEL, DBA_MODEL, TEAM_LEADER_MODEL,
        DEVOPS_MODEL, CODEBASE_ANALYZER_MODEL, PRINCIPAL_DEV_MODEL, SENIOR_DEV_MODEL,
        JUNIOR_DEV_MODEL, QA_MODEL, STRONG_FIXER_MODEL,
    ];
    return [...new Set(models.filter((m): m is string => !!m))];
}

/** Configured models that `estimateCost()` would silently price at $0. */
export function findUnpricedModels(models: string[] = configuredModels()): string[] {
    return models.filter(m => !MODEL_PRICING[m]);
}

/** Binaries karma-chrome-launcher and similar runners look up on PATH (Linux). */
const HEADLESS_BROWSER_BINARIES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

/**
 * Plan 30-G: locate a headless browser for browser-based test runners (Karma's
 * ChromeHeadless is the Angular CLI default). Returns the env path or binary name.
 */
export function findHeadlessBrowser(
    available: (bin: string) => boolean = bin => isToolAvailable(bin, process.cwd()),
    env: NodeJS.ProcessEnv = process.env,
): string | null {
    if (env.CHROME_BIN) return env.CHROME_BIN;
    if (env.CHROMIUM_BIN) return env.CHROMIUM_BIN;
    return HEADLESS_BROWSER_BINARIES.find(available) ?? null;
}

/** Free space (GB) on the volume holding `dir` (nearest existing ancestor), or null. */
export function freeDiskGb(dir: string): number | null {
    let probe = path.resolve(dir);
    while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) return null;
        probe = parent;
    }
    try {
        const s = fs.statfsSync(probe);
        return (s.bavail * s.bsize) / 1e9;
    } catch {
        return null;
    }
}

/** Collect preflight problems without throwing (config reads + host probes only). */
export function collectPreflight(): PreflightResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const runtimeProblem = checkNodeRuntime();
    if (runtimeProblem) errors.push(runtimeProblem);

    for (const model of findUnpricedModels()) {
        warnings.push(
            `Model "${model}" has no MODEL_PRICING entry — its calls are costed at $0, so ` +
            'MAX_RUN_COST_USD cannot see that spend. Add it to MODEL_PRICING or MODEL_PRICING_OVERRIDES.',
        );
    }

    if (!findHeadlessBrowser()) {
        warnings.push(
            'No headless browser found (CHROME_BIN, CHROMIUM_BIN, or google-chrome/chromium on PATH) — ' +
            'browser-based test runners (e.g. Karma ChromeHeadless, the Angular CLI default) cannot run, ' +
            'so every test gate of such a stack fails.',
        );
    }

    const freeGb = PREFLIGHT_MIN_FREE_DISK_GB > 0 ? freeDiskGb(GENERATED_PROJECTS_DIR) : null;
    if (freeGb !== null && freeGb < PREFLIGHT_MIN_FREE_DISK_GB) {
        warnings.push(
            `Only ${freeGb.toFixed(1)} GB free for ${GENERATED_PROJECTS_DIR} (< PREFLIGHT_MIN_FREE_DISK_GB=${PREFLIGHT_MIN_FREE_DISK_GB}) — ` +
            'worktrees + node_modules need ~2 GB per Node/Angular project; ENOSPC mid-development surfaces as random tool failures.',
        );
    }
    return { errors, warnings };
}

/**
 * Run all preflight checks. Logs every warning and throws `PreflightError`
 * when any check fails (fail closed — Plan 25 rule 16). Must be called
 * before intake creates repos or workspaces.
 */
export function runPreflight(): PreflightResult {
    const result = collectPreflight();
    for (const w of result.warnings) log.error(w);
    if (result.errors.length > 0) {
        for (const e of result.errors) log.error(e);
        throw new PreflightError(result.errors);
    }
    log.info(`Preflight passed (Node ${process.versions.node}, ${configuredModels().length} configured model(s))`);
    return result;
}
