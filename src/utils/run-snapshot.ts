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
import { getRecentEvents, type RunEvent } from './event-bus';

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

// ─── Periodic phase snapshot (Plan 25) ──────────────────────────────────────

/**
 * Write a state snapshot at the start of a phase — captures the full
 * accumulated state from all previous phases. This ensures continue-run
 * has a recent snapshot even if the process crashes mid-phase.
 *
 * Also writes a lightweight `latest-phase.json` marker so the continue-run
 * state collector can quickly determine the last completed phase.
 */
export function writePeriodicSnapshot(
    outputPath: string | undefined,
    state: any,
    currentPhase: string,
): void {
    if (!outputPath) return;
    try {
        // Write the full state snapshot (overwrites previous)
        writeStateSnapshot(outputPath, state);
        // Write a lightweight marker with the phase and timestamp
        const marker = {
            phase: currentPhase,
            timestamp: new Date().toISOString(),
            reason: 'periodic',
        };
        const markerPath = path.join(outputPath, 'latest-phase.json');
        fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf-8');
    } catch (err: any) {
        log.warn(`Periodic snapshot failed (non-fatal): ${err?.message ?? err}`);
    }
}

// ─── Run manifest ───────────────────────────────────────────────────────────

export interface RunManifest {
    /** ISO 8601 timestamp when the manifest was generated. */
    generatedAt: string;
    /** Run status: 'completed' | 'failed' | 'crashed' | 'cancelled' | 'partial' | 'inconclusive' | 'budget-exhausted'. */
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

    // ── PR & branch counters (Sub-Plan G) ────────────────────────────────
    /** PRs created in this run (de-duplicated by prNumber+branchName). */
    prsCreated?: number;
    /** PRs reused from a previous run (same branch re-opened). */
    prsReused?: number;
    /** PRs merged successfully. */
    prsMerged?: number;
    /** PRs blocked (could not merge). */
    prsBlocked?: number;
    /** Branches salvaged (failed to merge but patches exported). */
    branchesSalvaged?: number;
    /** Branches deferred (not attempted in this run). */
    branchesDeferred?: number;
    /** Branches where no PR was attempted. */
    branchesNotAttempted?: number;

    // ── Phase timeline (Sub-Plan G4) ─────────────────────────────────────
    /** Per-phase start/end timestamps and duration. */
    phaseTimeline?: Array<{
        phase: string;
        startedAt: string;
        endedAt: string;
        durationMs: number;
    }>;
}

// ─── PR de-duplication (Sub-Plan G2) ────────────────────────────────────────

export interface PRCountsInput {
    prsCreated: number;
    prsReused: number;
    prsMerged: number;
    prsBlocked: number;
}

/**
 * De-duplicate PRs by (prNumber, branchName) and count by status.
 * Entries with prNumber === 0 are internal placeholders (PR-SKIPPED-*) and are excluded.
 */
export function countPRsByStatus(pullRequests: Array<{
    prNumber: number;
    branchName: string;
    status: string;
    id?: string;
}>): PRCountsInput {
    // De-duplicate by (prNumber, branchName) — keep the last entry per pair
    const seen = new Map<string, { status: string; prNumber: number }>();
    for (const pr of pullRequests) {
        if (pr.prNumber === 0) continue; // skip internal placeholders
        const key = `${pr.prNumber}:${pr.branchName}`;
        seen.set(key, { status: pr.status, prNumber: pr.prNumber });
    }

    let created = 0;
    let reused = 0;
    let merged = 0;
    let blocked = 0;

    // Track which prNumbers we've already counted as "created"
    const seenNumbers = new Set<number>();
    for (const [, pr] of seen) {
        if (seenNumbers.has(pr.prNumber)) {
            reused++;
        } else {
            created++;
            seenNumbers.add(pr.prNumber);
        }
        if (pr.status === 'merged') merged++;
        if (pr.status === 'blocked') blocked++;
    }

    return { prsCreated: created, prsReused: reused, prsMerged: merged, prsBlocked: blocked };
}

// ─── Phase timeline extraction (Sub-Plan G4) ────────────────────────────────

export interface PhaseTimelineEntry {
    phase: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
}

/** Extract a phase timeline from run events (phase:start / phase:end pairs). */
export function extractPhaseTimeline(events: RunEvent[]): PhaseTimelineEntry[] {
    const starts = new Map<string, string>();
    const timeline: PhaseTimelineEntry[] = [];

    for (const e of events) {
        const phase = e.payload?.phase as string | undefined;
        if (!phase) continue;
        if (e.type === 'phase:start') {
            starts.set(phase, e.ts);
        } else if (e.type === 'phase:end') {
            const startTs = starts.get(phase);
            if (startTs) {
                const durationMs = new Date(e.ts).getTime() - new Date(startTs).getTime();
                timeline.push({ phase, startedAt: startTs, endedAt: e.ts, durationMs });
            }
        }
    }

    return timeline;
}

/** Render a phase timeline as a human-readable text block. */
export function renderPhaseTimeline(timeline: PhaseTimelineEntry[]): string {
    if (timeline.length === 0) return '';
    const lines = ['Phase Timeline:'];
    // Find longest phase name for alignment
    const maxLen = Math.max(...timeline.map(t => t.phase.length));
    for (const t of timeline) {
        const pad = ' '.repeat(maxLen - t.phase.length);
        const start = new Date(t.startedAt).toLocaleTimeString('en-GB', { hour12: false });
        const end = new Date(t.endedAt).toLocaleTimeString('en-GB', { hour12: false });
        const durSec = Math.round(t.durationMs / 1000);
        lines.push(`  ${t.phase}:${pad} ${start} → ${end} (${durSec}s)`);
    }
    return lines.join('\n');
}

// ─── Manifest counter assertion (Sub-Plan G1) ──────────────────────────────

/**
 * Compare counters between the manifest and externally-derived values.
 * Logs a warning for each mismatch. Returns the number of disagreements.
 */
function assertCountersAgree(
    label: string,
    manifest: Record<string, number>,
    derived: Record<string, number>,
): number {
    let disagreements = 0;
    for (const [key, derivedVal] of Object.entries(derived)) {
        const manifestVal = manifest[key];
        if (manifestVal !== undefined && manifestVal !== derivedVal) {
            log.warn(
                `Counter mismatch [${label}] ${key}: manifest=${manifestVal}, derived=${derivedVal}`,
            );
            disagreements++;
        }
    }
    return disagreements;
}

/**
 * Write a run-manifest.json summarising the run. Returns the path written,
 * or null on failure.
 */
export function writeRunManifest(
    outputPath: string,
    state: any,
    status: 'completed' | 'failed' | 'crashed' | 'cancelled' | 'partial' | 'inconclusive' | 'budget-exhausted',
    opts?: {
        traceability?: RunManifest['traceability'];
        acceptance?: RunManifest['acceptance'];
        verification?: RunManifest['verification'];
        phantomFileChanges?: number;
        filesDelivered?: number;
        prCounts?: PRCountsInput;
        branchesSalvaged?: number;
        branchesDeferred?: number;
        branchesNotAttempted?: number;
        phaseTimeline?: PhaseTimelineEntry[];
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

        // ── PR & branch counters (Sub-Plan G1/G2) ───────────────────────
        if (opts?.prCounts) {
            manifest.prsCreated = opts.prCounts.prsCreated;
            manifest.prsReused = opts.prCounts.prsReused;
            manifest.prsMerged = opts.prCounts.prsMerged;
            manifest.prsBlocked = opts.prCounts.prsBlocked;
        }
        if (opts?.branchesSalvaged !== undefined) {
            manifest.branchesSalvaged = opts.branchesSalvaged;
        }
        if (opts?.branchesDeferred !== undefined) {
            manifest.branchesDeferred = opts.branchesDeferred;
        }
        if (opts?.branchesNotAttempted !== undefined) {
            manifest.branchesNotAttempted = opts.branchesNotAttempted;
        }

        // ── Phase timeline (Sub-Plan G4) ────────────────────────────────
        const timeline = opts?.phaseTimeline ?? extractPhaseTimeline(events);
        if (timeline.length > 0) {
            manifest.phaseTimeline = timeline;
        }

        // ── Counter assertion (Sub-Plan G1) ─────────────────────────────
        // Verify the manifest's counts agree with separately-derived values.
        if (opts?.prCounts) {
            const derivedPrTotal = opts.prCounts.prsCreated + opts.prCounts.prsReused;
            assertCountersAgree('PR counts', {
                pullRequests: manifest.counts.pullRequests,
            }, {
                pullRequests: derivedPrTotal,
            });
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
