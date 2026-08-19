/**
 * Produces outputs/<run>/run-report.md — a one-page human-first summary
 * derived purely from the ledger.
 *
 * The report is the answer to "what happened?" that the post-mortem had to
 * reconstruct by hand from a 6,000-line log.
 */
import * as path from 'path';
import { getLogger } from './logger';
import { writeOutputFile } from './artifact-writer';
import type { LedgerEntry } from './run-ledger';
import { readLedger } from './run-ledger';

const log = getLogger('[LedgerReport]', 178);

// ─── Public API ─────────────────────────────────────────────────────────────

/** Generate the run report markdown from the ledger. Returns the file path. */
export function generateRunReport(outputPath: string, systemName: string): string {
    const entries = readLedger(outputPath);
    const md = renderRunReport(entries, systemName);
    writeOutputFile(outputPath, 'run-report.md', md);
    return path.join(outputPath, 'run-report.md');
}

/** Render the run report markdown from an array of ledger entries. Exported for testing. */
export function renderRunReport(entries: LedgerEntry[], systemName: string): string {
    const lines: string[] = [];

    // ── Header ──
    const acceptanceEntry = entries.filter(e => e.kind === 'acceptance').pop() as
        Extract<LedgerEntry, { kind: 'acceptance' }> | undefined;
    const status = acceptanceEntry?.status?.toUpperCase() ?? 'UNKNOWN';
    lines.push(`# Run Report — ${systemName} — ${status}`);
    lines.push('');

    // ── Verdict ──
    lines.push('## Verdict');
    if (acceptanceEntry) {
        const blockers = acceptanceEntry.blockers ?? [];
        if (blockers.length > 0) {
            lines.push(`${status} — ${blockers.length} blocker(s):`);
            for (let i = 0; i < blockers.length; i++) {
                lines.push(`  ${i + 1}. ${blockers[i]}`);
            }
        } else {
            lines.push(`${status} — no blockers`);
        }
        if (acceptanceEntry.unrecoverable) {
            lines.push(`\n**Unrecoverable:** pipeline detected that no further work could change the outcome.`);
        }
    } else {
        lines.push('No acceptance entry found in ledger.');
    }
    lines.push('');

    // ── Plan funnel ──
    const funnelEntry = entries.filter(e => e.kind === 'plan-funnel').pop() as
        Extract<LedgerEntry, { kind: 'plan-funnel' }> | undefined;
    if (funnelEntry) {
        lines.push('## Plan funnel');
        lines.push(
            `${funnelEntry.epics} epics → ${funnelEntry.stories} stories (${funnelEntry.criteria} AC) → ` +
            `${funnelEntry.tasks} tasks → ${funnelEntry.assignments} assignments`,
        );
        const warnings: string[] = [];
        if (funnelEntry.unassignedStories.length > 0) {
            warnings.push(`${funnelEntry.unassignedStories.length} stories unassigned`);
        }
        if (funnelEntry.unassignedTasks.length > 0) {
            warnings.push(`${funnelEntry.unassignedTasks.length} tasks unassigned`);
        }
        if (warnings.length > 0) lines.push(`⚠ ${warnings.join(', ')}`);
        lines.push('');
    }

    // ── Delivery ──
    lines.push('## Delivery');
    const mergeEntries = entries.filter(e => e.kind === 'merge') as
        Extract<LedgerEntry, { kind: 'merge' }>[];
    const merged = mergeEntries.filter(e => e.decision).length;
    const blocked = mergeEntries.filter(e => !e.decision).length;
    lines.push(`Branches merged: ${merged}   Blocked: ${blocked}`);

    const salvageEntries = entries.filter(e => e.kind === 'salvage') as
        Extract<LedgerEntry, { kind: 'salvage' }>[];
    if (salvageEntries.length > 0) {
        lines.push(`Salvaged: ${salvageEntries.length} branch(es)`);
    }

    // Phantom file changes from agent entries
    const agentEntries = entries.filter(e => e.kind === 'agent') as
        Extract<LedgerEntry, { kind: 'agent' }>[];
    const totalPhantoms = agentEntries.reduce((sum, e) => sum + e.phantoms.length, 0);
    const totalFilesWritten = agentEntries.reduce((sum, e) => sum + e.filesWritten.length, 0);
    if (totalPhantoms > 0) {
        lines.push(`Files written: ${totalFilesWritten}   Phantom fileChanges: ${totalPhantoms} ⚠`);
    } else {
        lines.push(`Files written: ${totalFilesWritten}`);
    }

    // Coverage
    const coverageEntry = entries.filter(e => e.kind === 'coverage').pop() as
        Extract<LedgerEntry, { kind: 'coverage' }> | undefined;
    if (coverageEntry) {
        lines.push(
            `Coverage: verified ${(coverageEntry.verifiedPct * 100).toFixed(0)}% | ` +
            `implemented ${(coverageEntry.implementedPct * 100).toFixed(0)}% | ` +
            `delivery score ${coverageEntry.deliveryScore.toFixed(2)}`,
        );
    }
    lines.push('');

    // ── Agent health ──
    lines.push('## Agent health');
    const poisonedCount = agentEntries.filter(e => e.poisoned).length;
    const totalRespawns = agentEntries.reduce((sum, e) => sum + e.respawns, 0);
    const zeroFileAgents = new Map<string, [number, number]>();
    for (const e of agentEntries) {
        const key = e.agentId;
        const [zero, total] = zeroFileAgents.get(key) ?? [0, 0];
        zeroFileAgents.set(key, [
            zero + (e.filesWritten.length === 0 ? 1 : 0),
            total + 1,
        ]);
    }

    if (poisonedCount > 0) {
        lines.push(`Poisoned invocations: ${poisonedCount}   Respawns: ${totalRespawns}`);
    }
    const zeroFileLines: string[] = [];
    for (const [agent, [zero, total]] of zeroFileAgents) {
        if (zero > 0) zeroFileLines.push(`${agent} (${zero}/${total})`);
    }
    if (zeroFileLines.length > 0) {
        lines.push(`Agents that produced 0 files: ${zeroFileLines.join(', ')}`);
    }
    const failedAgents = agentEntries.filter(e => e.outcome !== 'ok');
    if (failedAgents.length > 0) {
        lines.push(`Failed invocations: ${failedAgents.length}`);
    }
    lines.push('');

    // ── Verification ──
    lines.push('## Verification');
    const gateEntries = entries.filter(e => e.kind === 'gate') as
        Extract<LedgerEntry, { kind: 'gate' }>[];
    const gatesPassed = gateEntries.filter(e => e.passed).length;
    const gatesFailed = gateEntries.filter(e => !e.passed).length;
    lines.push(`Quality gates: ${gateEntries.length} runs, ${gatesPassed} passed, ${gatesFailed} failed`);

    const pvEntries = entries.filter(e => e.kind === 'product-verify') as
        Extract<LedgerEntry, { kind: 'product-verify' }>[];
    if (pvEntries.length > 0) {
        const pv = pvEntries[pvEntries.length - 1];
        lines.push(
            `Product verify: artifacts ${pv.artifacts - pv.artifactsFailed}/${pv.artifacts}, ` +
            `unresolved refs ${pv.unresolvedRefs}, smoke ${pv.smoke}`,
        );
    }

    const integrityEntries = entries.filter(e => e.kind === 'integrity') as
        Extract<LedgerEntry, { kind: 'integrity' }>[];
    const totalFindings = integrityEntries.reduce((sum, e) => sum + e.findings.length, 0);
    lines.push(`Integrity findings: ${totalFindings}`);

    const testEntries = entries.filter(e => e.kind === 'test-run') as
        Extract<LedgerEntry, { kind: 'test-run' }>[];
    const totalTests = testEntries.reduce((sum, e) => sum + e.total, 0);
    const totalPassed = testEntries.reduce((sum, e) => sum + e.passed, 0);
    const totalFailed = testEntries.reduce((sum, e) => sum + e.failed, 0);
    lines.push(`Tests executed: ${totalTests} (${totalPassed} passed, ${totalFailed} failed)`);

    const runnerErrors = testEntries.filter(e => e.runnerError);
    if (runnerErrors.length > 0) {
        lines.push(`Runner errors: ${runnerErrors.length}`);
    }

    const invariantEntries = entries.filter(e => e.kind === 'invariant') as
        Extract<LedgerEntry, { kind: 'invariant' }>[];
    if (invariantEntries.length > 0) {
        lines.push(`Invariant violations: ${invariantEntries.length}`);
        for (const inv of invariantEntries) {
            lines.push(`  - ${inv.id}: ${inv.detail}`);
        }
    }
    lines.push('');

    // ── Phase timeline ──
    lines.push('## Phase timeline');
    const phaseEntries = entries.filter(e => e.kind === 'phase') as
        Extract<LedgerEntry, { kind: 'phase' }>[];
    const starts = new Map<string, string>();
    // Collect completed phases for alignment padding
    const completedPhases: Array<{ phase: string; startTs: string; endTs: string; durSec: string }> = [];
    for (const e of phaseEntries) {
        if (e.event === 'start') {
            starts.set(e.phase, e.t);
        } else if (e.event === 'end') {
            const start = starts.get(e.phase);
            const durSec = e.durationMs != null
                ? (e.durationMs / 1000).toFixed(0)
                : start
                ? ((new Date(e.t).getTime() - new Date(start).getTime()) / 1000).toFixed(0)
                : '?';
            const startTs = start ?? '?';
            completedPhases.push({ phase: e.phase, startTs, endTs: e.t, durSec });
        }
    }
    if (completedPhases.length > 0) {
        const maxLen = Math.max(...completedPhases.map(p => p.phase.length));
        const fmtTime = (iso: string): string => {
            if (iso === '?') return '?';
            return new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
        };
        for (const p of completedPhases) {
            const pad = ' '.repeat(maxLen - p.phase.length);
            lines.push(`  ${p.phase}:${pad} ${fmtTime(p.startTs)} → ${fmtTime(p.endTs)} (${p.durSec}s)`);
        }
    }
    lines.push('');

    return lines.join('\n');
}
