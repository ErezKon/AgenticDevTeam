/**
 * Run Invariants — assertions checked at phase boundaries (Sub-Plan 12).
 *
 * These are _not_ acceptance criteria — they are structural invariants that
 * must hold for the pipeline to be functioning correctly. A violation means
 * the pipeline has a bug, not that the generated product is wrong.
 *
 * Invariants are checked after each phase and violations are:
 * - logged as ERROR
 * - appended to state.invariantViolations
 * - (in 'strict' mode) thrown to fail the run immediately
 */
import { getLogger } from '../utils/logger';
import { RUN_INVARIANTS_MODE } from '../config';
import { appendLedger } from '../utils/run-ledger';
import type { PhaseName } from '../agents/_shared/schemas/phase.schema';
import type { ProjectStateType } from './state';

const log = getLogger('[Invariants]', 196);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface InvariantViolation {
    id: string;
    phase: PhaseName;
    detail: string;
}

// ─── Invariant definitions ──────────────────────────────────────────────────

type InvariantCheck = {
    id: string;
    /** Phase(s) after which this invariant is checked. */
    afterPhases: PhaseName[];
    /** Return a violation detail string if the invariant is violated, or null if it holds. */
    check: (state: ProjectStateType) => string | null;
};

const INVARIANTS: InvariantCheck[] = [
    {
        id: 'INV-PLAN-COVERAGE',
        afterPhases: ['team-leader'],
        check: (state) => {
            if (state.assignments.length === 0) return null; // handled by INV-NO-EMPTY-ASSIGNMENTS
            const assignedStoryIds = new Set<string>();
            for (const a of state.assignments) {
                assignedStoryIds.add(a.storyId);
                if ('additionalStoryIds' in a && Array.isArray((a as any).additionalStoryIds)) {
                    for (const sid of (a as any).additionalStoryIds) assignedStoryIds.add(sid);
                }
            }
            const orphans = state.userStories
                .map(s => s.id)
                .filter(id => !assignedStoryIds.has(id));
            if (orphans.length > 0) {
                return `${orphans.length} stories have no assignment: ${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? '...' : ''}`;
            }
            return null;
        },
    },
    {
        id: 'INV-NO-EMPTY-ASSIGNMENTS',
        afterPhases: ['team-leader'],
        check: (state) => {
            if (state.assignments.length === 0 && state.userStories.length > 0) {
                return `${state.userStories.length} stories planned but 0 assignments produced`;
            }
            return null;
        },
    },
    {
        id: 'INV-WORKSPACE-HAS-SOURCE',
        afterPhases: ['development'],
        check: (state) => {
            if (!state.workspacePath) return null;
            // Check if workspace has any source files beyond boilerplate
            try {
                const gitLsFiles = require('child_process')
                    .execSync('git ls-files', { cwd: state.workspacePath, encoding: 'utf-8' })
                    .split('\n')
                    .filter(Boolean);
                const sourceFiles = gitLsFiles.filter((f: string) =>
                    /\.(ts|tsx|js|jsx|py|go|rs|java|cs|rb)$/.test(f) &&
                    !f.includes('node_modules') &&
                    !f.includes('.agent/'),
                );
                if (sourceFiles.length === 0) {
                    return 'Workspace has no source files after development phase';
                }
            } catch {
                return null; // Cannot verify — skip
            }
            return null;
        },
    },
    {
        id: 'INV-NO-PHANTOMS',
        afterPhases: ['development'],
        check: (state) => {
            const phantomCount = state.phantomFileChanges?.length ?? 0;
            if (phantomCount > 0) {
                return `${phantomCount} phantom file change(s) — agent claimed files that do not exist on disk`;
            }
            return null;
        },
    },
    {
        id: 'INV-TESTREPORT-EXISTS',
        afterPhases: ['qa'],
        check: (state) => {
            const executed = (state.testReports ?? []).filter(
                (r: any) => r.source === 'executed',
            );
            if (executed.length === 0) {
                return 'No executed test reports after QA phase — tests either never ran or all crashed';
            }
            return null;
        },
    },
    {
        id: 'INV-GATE-RAN',
        afterPhases: ['qa'],
        check: (state) => {
            const gr = state.latestGateReport;
            if (!gr) return 'No gate report exists after QA phase';
            const executed = gr.results.filter(
                (r: any) => !r.skipped && r.mode !== 'absent',
            );
            if (executed.length === 0) {
                return 'Gate report has 0 executed non-absent steps — quality gates were all skipped';
            }
            return null;
        },
    },
    {
        id: 'INV-NO-CRITICAL-INTEGRITY',
        afterPhases: ['development'],
        check: (state) => {
            // Also check for tamper findings in bugs
            const tamperBugs = (state.bugs ?? []).filter(
                b => b.id.startsWith('TAMPER-') && (b as any).severity === 'critical',
            );
            if (tamperBugs.length > 0) {
                return `${tamperBugs.length} critical tamper finding(s) not reverted`;
            }
            return null;
        },
    },
    {
        id: 'INV-E2E-STATUS-SET',
        afterPhases: ['e2e'],
        check: (state) => {
            if (state.e2eStatus === 'not-run') {
                return "e2eStatus is still 'not-run' after E2E phase — the phase produced no signal";
            }
            return null;
        },
    },
    {
        id: 'INV-STATUS-MATCHES-ACCEPTANCE',
        afterPhases: ['finalize'],
        check: (state) => {
            if (!state.acceptance) return null;
            // This check is informational — it verifies that the final status
            // in the acceptance report is consistent with what finalize would produce
            return null; // The real check is in finalizeNode; just register the invariant
        },
    },
    {
        id: 'INV-NO-MERGED-EMPTY-PR',
        afterPhases: ['development'],
        check: (state) => {
            const emptyMerged = (state.pullRequests ?? []).filter(
                (pr: any) => pr.status === 'merged' && (state.completionEvidence ?? [])
                    .filter((e: any) => e.merged)
                    .some((e: any) => e.filesChanged === 0),
            );
            if (emptyMerged.length > 0) {
                return `${emptyMerged.length} PR(s) merged with 0 real file changes`;
            }
            return null;
        },
    },
];

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Check all invariants relevant to the given phase.
 * Returns an array of violations (empty if all invariants hold).
 */
export function checkInvariants(
    state: ProjectStateType,
    phase: PhaseName,
): InvariantViolation[] {
    if (RUN_INVARIANTS_MODE === 'off') return [];

    const violations: InvariantViolation[] = [];

    for (const inv of INVARIANTS) {
        if (!inv.afterPhases.includes(phase)) continue;
        try {
            const detail = inv.check(state);
            if (detail) {
                const violation: InvariantViolation = { id: inv.id, phase, detail };
                violations.push(violation);
                log.error(`Invariant ${inv.id} violated after ${phase}: ${detail}`);
                appendLedger({ kind: 'invariant', id: inv.id, phase, detail });
            }
        } catch (err: any) {
            log.warn(`Invariant ${inv.id} check threw: ${err.message}`);
        }
    }

    if (violations.length > 0 && RUN_INVARIANTS_MODE === 'strict') {
        throw new Error(
            `Run invariant(s) violated in strict mode: ${violations.map(v => v.id).join(', ')}`,
        );
    }

    return violations;
}

/** Get the list of all defined invariant IDs. Exported for testing. */
export function getInvariantIds(): string[] {
    return INVARIANTS.map(i => i.id);
}
