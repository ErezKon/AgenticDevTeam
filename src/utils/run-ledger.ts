/**
 * Append-only JSONL evidence ledger — the backbone of post-mortem diagnostics.
 *
 * Every decision the pipeline makes is recorded with its evidence so a failure
 * is diagnosable in minutes instead of a 6,000-line log read.
 *
 * Written synchronously with fs.appendFileSync (a run is not throughput-bound)
 * so a crash still leaves the ledger intact.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from './logger';
import { appendOutputLine } from './artifact-writer';
import { trace } from './debug-trace';
import { RUN_LEDGER_ENABLED } from '../config';
import type { PhaseName } from '../agents/_shared/schemas/phase.schema';
import type { AcceptanceStatus } from '../conductor/gate-types';
import type { TamperFinding } from '../conductor/gate-integrity';

const log = getLogger('[Ledger]', 178);

// ─── Types ──────────────────────────────────────────────────────────────────

/** Dispatch-plan evidence (Plan 30-01): one entry per development round. */
export type DispatchPlanRecord = {
    branches: Array<{ name: string; kind: string; reason: string; assignments: string[]; dependsOn: string[] }>;
    order: string[];
    layers: string[][];
    skippedEdges: Array<{ from: string; to: string; reason: string }>;
    brokenEdges: Array<{ from: string; to: string; level: string; cycle: string[]; via?: Array<{ from: string; to: string }> }>;
    warnings: string[];
};

/**
 * One dev-agent invocation (Plan 30-02: real numbers). `toolCalls` sums the loop-guard
 * usage of every respawn generation; `filesWritten` are the files in the invocation's
 * durable commit; `ok-budget-capped` = crossed MAX_INVOCATION_INPUT_TOKENS with valid
 * output, which was kept; `budget-exhausted` = crossed it without valid output.
 */
type AgentLedgerRecord = {
    agentId: string; phase: PhaseName; invocation: number; assignmentId?: string; branch?: string;
    toolCalls: { read: number; write: number; shell: number; turns?: number }; respawns: number; budgetCapped?: boolean;
    poisoned: boolean; filesWritten: string[]; filesClaimed: string[]; phantoms: string[];
    outcome: 'ok' | 'ok-budget-capped' | 'failed' | 'budget-exhausted'; error?: string;
};

export type LedgerEntry =
    | { t: string; kind: 'phase';          phase: PhaseName; event: 'start' | 'end'; durationMs?: number }
    | { t: string; kind: 'plan-funnel';    epics: number; stories: number; criteria: number; tasks: number; assignments: number; unassignedStories: string[]; unassignedTasks: string[] }
    | ({ t: string; kind: 'agent' } & AgentLedgerRecord)
    | { t: string; kind: 'gate';           branch: string | null; stacks: string[]; steps: Array<{ step: string; mode: string; passed: boolean; skipped: boolean; ms: number }>; passed: boolean; inconclusive: boolean }
    | { t: string; kind: 'integrity';      branch: string; findings: TamperFinding[] }
    | { t: string; kind: 'product-verify'; artifacts: number; artifactsFailed: number; unresolvedRefs: number; smoke: string }
    | { t: string; kind: 'review';         prNumber: number; reviewerId: string; outcome: 'approved' | 'changes_requested' | 'abstained'; reason?: string; blocking: number }
    | { t: string; kind: 'merge';          prNumber: number; decision: boolean; reason: string; blockers: string[] }
    | { t: string; kind: 'test-run';       root: string; framework: string; total: number; passed: number; failed: number; skipped: number; coverage?: number; runnerError: boolean; untraced: number }
    | { t: string; kind: 'coverage';       verifiedPct: number; implementedPct: number; deliveryScore: number; missing: number; blocked: number }
    | { t: string; kind: 'acceptance';     status: AcceptanceStatus; blockers: string[]; unrecoverable: boolean }
    | { t: string; kind: 'salvage';        branch: string; patchPath: string; reason: string }
    | { t: string; kind: 'invariant';      id: string; phase: PhaseName; detail: string }
    | ({ t: string; kind: 'dispatch-plan' } & DispatchPlanRecord);

/** Distributive Omit — preserves union discrimination. */
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

// ─── Singleton state ────────────────────────────────────────────────────────

import { getRunContext } from './run-context';

let _outputPath: string | null = null;

/** Get the active ledger output path — per-run scoped or module default. */
function _activeOutputPath(): string | null {
    const ctx = getRunContext();
    return ctx ? ctx.ledger.outputPath : _outputPath;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Set the output directory for this run. Must be called before the first append. */
export function initLedger(outputPath: string): void {
    const ctx = getRunContext();
    if (ctx) {
        ctx.ledger.outputPath = outputPath;
    } else {
        _outputPath = outputPath;
    }
}

/** Append a single entry to the ledger JSONL file. Never throws. */
export function appendLedger(entry: DistributiveOmit<LedgerEntry, 't'>): void {
    trace({ kind: 'ledger', entry });
    const outPath = _activeOutputPath();
    if (!RUN_LEDGER_ENABLED || !outPath) return;
    const full = { t: new Date().toISOString(), ...entry };
    const line = JSON.stringify(full) + '\n';
    appendOutputLine(outPath, 'ledger.jsonl', line);
}

/** Read back the complete ledger as an array of entries. */
export function readLedger(outputPath: string): LedgerEntry[] {
    const filePath = path.join(outputPath, 'ledger.jsonl');
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    const entries: LedgerEntry[] = [];
    for (const line of lines) {
        try {
            entries.push(JSON.parse(line));
        } catch { /* skip malformed lines */ }
    }
    return entries;
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Reset the ledger output path — tests only. */
export function _resetLedger(): void {
    _outputPath = null;
}
