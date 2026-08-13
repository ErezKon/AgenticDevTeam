/**
 * Run snapshot utilities — write state.json and run-manifest.json
 * at the end of each run (or on crash) for post-run analysis.
 *
 * Sensitive fields (tokens, keys) are redacted before writing.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from './logger';
import { tokenTracker } from './token-tracker';
import { getBudgetStatus } from './run-budget';
import { getRecentEvents } from './event-bus';

const log = getLogger('[RunSnapshot]', 214);

// ─── Redaction ──────────────────────────────────────────────────────────────

/** Keys whose values should be replaced with '***REDACTED***'. */
const SENSITIVE_KEYS = new Set([
    'token', 'apiKey', 'api_key', 'accessToken', 'access_token',
    'secret', 'password', 'GITHUB_TOKEN', 'OAUTH_CLIENT_SECRET',
]);

/**
 * Deep-clone a state object and replace sensitive values with a placeholder.
 * Works on any JSON-serialisable object.
 */
export function redactState(state: any): any {
    if (state === null || state === undefined) return state;
    const json = JSON.stringify(state, (_key, value) => {
        if (typeof _key === 'string' && SENSITIVE_KEYS.has(_key) && typeof value === 'string' && value.length > 0) {
            return '***REDACTED***';
        }
        return value;
    });
    return JSON.parse(json);
}

// ─── State snapshot ─────────────────────────────────────────────────────────

/**
 * Write a redacted state.json to the run's output directory.
 * Returns the path written, or null on failure.
 */
export function writeStateSnapshot(outputPath: string, state: any): string | null {
    try {
        const dest = path.join(outputPath, 'state.json');
        const redacted = redactState(state);
        fs.writeFileSync(dest, JSON.stringify(redacted, null, 2), 'utf-8');
        log.info(`State snapshot written: ${dest}`);
        return dest;
    } catch (err: any) {
        log.warn(`Failed to write state snapshot: ${err?.message ?? err}`);
        return null;
    }
}

// ─── Run manifest ───────────────────────────────────────────────────────────

export interface RunManifest {
    /** ISO 8601 timestamp when the manifest was generated. */
    generatedAt: string;
    /** Run status: 'completed' | 'failed' | 'crashed' | 'cancelled' | 'partial' | 'inconclusive'. */
    status: string;
    /** System name from the run input. */
    systemName: string;
    /** Run type: 'greenfield' | 'maintain'. */
    runType: string;
    /** Final pipeline phase when the run ended. */
    finalPhase: string;
    /** Token usage summary. */
    tokenUsage: {
        totalCalls: number;
        totalTokens: number;
        totalInputTokens: number;
        totalOutputTokens: number;
    };
    /** Budget status at the time of manifest generation. */
    budget: {
        level: string;
        binding: string;
        utilisation: number;
        usedTokens: number;
        estCostUsd: number;
        elapsedMs: number;
    };
    /** Counts of key state arrays. */
    counts: {
        epics: number;
        userStories: number;
        tasks: number;
        assignments: number;
        fileChanges: number;
        testReports: number;
        bugs: number;
        pullRequests: number;
        artifacts: number;
    };
    /** Paths to companion files in the output directory. */
    files: {
        stateJson: string | null;
        runLog: string | null;
        tokenReportHtml: string | null;
        tokenReportJson: string | null;
        traceabilityMd: string | null;
    };
    /** Total events emitted during this run (from the ring buffer). */
    eventCount: number;
    /** Requirements traceability summary (Sub-Plan 10). */
    traceability?: {
        criteria: number;
        verified: number;
        implemented: number;
        missing: number;
        /** @deprecated Use verifiedPct instead — kept for backward compatibility. */
        coveragePct: number;
        verifiedPct?: number;
        implementedPct?: number;
        deliveryScore?: number;
        testedFailing?: number;
        blocked?: number;
        orphanedStories: string[];
        orphanedAssignments: string[];
        orphanedTasks?: string[];
    };
    /** Acceptance gate result (Sub-Plan 03). */
    acceptance?: {
        status: string;
        blockers: string[];
        criteria: Array<{ id: string; required: boolean; passed: boolean; inconclusive: boolean; detail: string }>;
        unrecoverable: boolean;
        unrecoverableReason?: string;
    };
    /** Verification summary (Sub-Plan 03). */
    verification?: {
        gateReportPassed?: boolean;
        gateReportInconclusive?: boolean;
        productVerifyPassed?: boolean;
        unresolvedReferences?: number;
        integrityFindings?: number;
    };
    /** Count of file-change paths NOT present on disk (Sub-Plan 03, PART A11). */
    phantomFileChanges?: number;
    /** Count of distinct files actually present on disk at finalize time. */
    filesDelivered?: number;
}

/**
 * Write a run-manifest.json summarising the run. Returns the path written,
 * or null on failure.
 */
export function writeRunManifest(
    outputPath: string,
    state: any,
    status: 'completed' | 'failed' | 'crashed' | 'cancelled' | 'partial' | 'inconclusive',
    opts?: {
        traceability?: RunManifest['traceability'];
        acceptance?: RunManifest['acceptance'];
        verification?: RunManifest['verification'];
        phantomFileChanges?: number;
        filesDelivered?: number;
    },
): string | null {
    try {
        const tokenSummary = tokenTracker.getRunSummary();
        const budget = getBudgetStatus();
        const events = getRecentEvents();

        const manifest: RunManifest = {
            generatedAt: new Date().toISOString(),
            status,
            systemName: state.input?.systemName ?? 'unknown',
            runType: state.input?.runType ?? 'greenfield',
            finalPhase: state.phase ?? 'unknown',
            tokenUsage: {
                totalCalls: tokenSummary.totalCalls,
                totalTokens: tokenSummary.totalTokens,
                totalInputTokens: tokenSummary.totalInputTokens,
                totalOutputTokens: tokenSummary.totalOutputTokens,
            },
            budget: {
                level: budget.level,
                binding: budget.binding,
                utilisation: budget.utilisation,
                usedTokens: budget.usedTokens,
                estCostUsd: budget.estCostUsd,
                elapsedMs: budget.elapsedMs,
            },
            counts: {
                epics: state.epics?.length ?? 0,
                userStories: state.userStories?.length ?? 0,
                tasks: state.tasks?.length ?? 0,
                assignments: state.assignments?.length ?? 0,
                fileChanges: state.fileChanges?.length ?? 0,
                testReports: state.testReports?.length ?? 0,
                bugs: state.bugs?.length ?? 0,
                pullRequests: state.pullRequests?.length ?? 0,
                artifacts: state.artifacts?.length ?? 0,
            },
            files: {
                stateJson: fs.existsSync(path.join(outputPath, 'state.json'))
                    ? 'state.json' : null,
                runLog: fs.existsSync(path.join(outputPath, 'run.log'))
                    ? 'run.log' : null,
                tokenReportHtml: fs.existsSync(path.join(outputPath, 'token-usage-report.html'))
                    ? 'token-usage-report.html' : null,
                tokenReportJson: fs.existsSync(path.join(outputPath, 'token-usage.json'))
                    ? 'token-usage.json' : null,
                traceabilityMd: fs.existsSync(path.join(outputPath, 'traceability.md'))
                    ? 'traceability.md' : null,
            },
            eventCount: events.length,
        };

        if (opts?.traceability) {
            manifest.traceability = opts.traceability;
        }
        if (opts?.acceptance) {
            manifest.acceptance = opts.acceptance;
        }
        if (opts?.verification) {
            manifest.verification = opts.verification;
        }
        if (opts?.phantomFileChanges !== undefined) {
            manifest.phantomFileChanges = opts.phantomFileChanges;
        }
        if (opts?.filesDelivered !== undefined) {
            manifest.filesDelivered = opts.filesDelivered;
        }

        const dest = path.join(outputPath, 'run-manifest.json');
        fs.writeFileSync(dest, JSON.stringify(manifest, null, 2), 'utf-8');
        log.info(`Run manifest written: ${dest}`);
        return dest;
    } catch (err: any) {
        log.warn(`Failed to write run manifest: ${err?.message ?? err}`);
        return null;
    }
}
