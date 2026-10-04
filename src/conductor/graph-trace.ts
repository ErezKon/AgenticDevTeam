/**
 * Graph-level debug tracing (DEBUG_MODE): every conductor node execution and
 * every conditional-edge decision, with the state "vitals" that drove it.
 *
 * Applied at graph registration in graph.ts, so the exported node and router
 * functions stay unchanged. Identity when DEBUG_MODE is off.
 */
import { isDebugMode, trace, withTraceContext, serializeError } from '../utils/debug-trace';
import type { ProjectStateType } from './state';

/** Array fields whose sizes summarise pipeline progress. */
const COUNTED_FIELDS = [
    'epics', 'userStories', 'tasks', 'assignments', 'completedAssignmentIds',
    'pullRequests', 'bugs', 'fixedBugIds', 'testReports', 'fileChanges', 'artifacts',
] as const;

const ID_SAMPLE = 30;
const KEY_SAMPLE = 30;

/** Compact view of the state fields that drive routing and progress. */
export function stateVitals(state: Partial<ProjectStateType> | null | undefined): Record<string, unknown> {
    if (!state) return {};
    const counts: Record<string, number> = {};
    for (const field of COUNTED_FIELDS) {
        const value = state[field];
        if (Array.isArray(value)) counts[field] = value.length;
    }
    return {
        phase: state.phase,
        iteration: state.iteration,
        cancelled: state.cancelled,
        stopReason: state._stopReason ?? undefined,
        pendingRerun: state.pendingRerun ?? undefined,
        resumePhase: state._isContinuation ? state._resumePhase : undefined,
        counts,
        gatePassed: state.latestGateReport?.passed,
        e2eStatus: state.e2eStatus,
        acceptance: state.acceptance?.status,
        unrecoverable: state.unrecoverable?.flag ? state.unrecoverable.reason : undefined,
    };
}

function idOf(item: unknown): string | undefined {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return undefined;
    const record = item as Record<string, unknown>;
    const id = record.id ?? record.number ?? record.branchName;
    return id === undefined || id === null ? undefined : String(id);
}

/** Per-key shape of a node's returned update: array sizes + ids, object keys, scalar values. */
export function summarizeUpdate(update: unknown): Record<string, unknown> | undefined {
    if (!update || typeof update !== 'object') return undefined;
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(update)) {
        if (Array.isArray(value)) {
            const ids = value.map(idOf).filter((id): id is string => id !== undefined).slice(0, ID_SAMPLE);
            summary[key] = { count: value.length, ...(ids.length > 0 ? { ids } : {}) };
        } else if (value !== null && typeof value === 'object') {
            summary[key] = { keys: Object.keys(value).slice(0, KEY_SAMPLE) };
        } else {
            summary[key] = value;
        }
    }
    return summary;
}

/**
 * Record a graph node's start (state vitals), end (update summary) or error,
 * and attribute every record written inside it to `phase: name`.
 */
export function traceNode<F extends (state: ProjectStateType, ...rest: any[]) => Promise<Partial<ProjectStateType>>>(
    name: string,
    fn: F,
): F {
    if (!isDebugMode()) return fn;
    const traced = (state: ProjectStateType, ...rest: any[]) => withTraceContext({ phase: name }, async () => {
        const startedAt = Date.now();
        trace({ kind: 'node', event: 'start', node: name, vitals: stateVitals(state) });
        try {
            const update = await fn(state, ...rest);
            trace({
                kind: 'node', event: 'end', node: name,
                durationMs: Date.now() - startedAt,
                nextPhase: update?.phase,
                update: summarizeUpdate(update),
            });
            return update;
        } catch (err) {
            trace({ kind: 'node', event: 'error', node: name, durationMs: Date.now() - startedAt, error: serializeError(err) });
            throw err;
        }
    });
    return traced as F;
}

/** Record which way a conditional edge routed, and the state vitals behind the decision. */
export function traceRoute<F extends (state: ProjectStateType) => string>(from: string, router: F): F {
    if (!isDebugMode()) return router;
    const traced = (state: ProjectStateType) => {
        const to = router(state);
        trace({ kind: 'route', event: 'decision', from, to, vitals: stateVitals(state) });
        return to;
    };
    return traced as F;
}
