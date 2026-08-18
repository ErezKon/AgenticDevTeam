/**
 * Conductor Graph — the LangGraph state machine that orchestrates
 * all agents through the pipeline phases.
 *
 * Phases: intake → architect → PM → DBA → TL → development → QA → bugfix? → devops → e2e → acceptance → finalize
 */
import { StateGraph, END, MemorySaver } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { ProjectState } from './state';
import { RUN_MODE, E2E_BUGFIX_ENABLED, RUN_FAIL_POLICY, CHECKPOINT_PERSIST } from '../config';
import { FileCheckpointer } from './file-checkpointer';
import { getEffectiveLimits } from '../utils/run-budget';
import {
    intakeNode,
    codebaseAnalyzerNode,
    architectNode,
    productManagerNode,
    dbaNode,
    teamLeaderNode,
    developmentNode,
    qaNode,
    bugfixTriageNode,
    devopsNode,
    e2eNode,
    acceptanceNode,
    finalizeNode,
} from './nodes';
import type { ProjectStateType } from './state';
import type { PhaseName } from '../agents/_shared/base-schemas';

// ─── HITL interrupt points (human mode only) ────────────────────────────────

const HITL_PHASES: PhaseName[] = [
    'codebase-analyzer',
    'architect',
    'product-manager',
    'dba',
    'team-leader',
    'development',
    'qa',
    'devops',
    'e2e',
];

// ─── Conductor options ──────────────────────────────────────────────────────

export interface ConductorOptions {
    /** Interrupt after each HITL phase. Defaults to the RUN_MODE env value. */
    mode?: 'autonomous' | 'human';
    /** Checkpointer. A MemorySaver is created when omitted. */
    checkpointer?: BaseCheckpointSaver;
    /** Output path — used to create a FileCheckpointer when CHECKPOINT_PERSIST=true. */
    outputPath?: string;
}

// ─── Conditional edges ──────────────────────────────────────────────────────

/**
 * Filter test reports to the current bugfix iteration. Uses the whole
 * array when no iteration tracking exists (backward-compat).
 */
function currentIterationFailures(state: ProjectStateType): Array<{ status: string }> {
    // The latestGateReport (replace reducer) is always current.
    // For test reports (append reducer), we consider all since there's no
    // iterationIndex yet — the latestGateReport is the authoritative signal.
    if (state.latestGateReport) {
        const gr = state.latestGateReport;
        if (!gr.passed) return [{ status: 'fail' }];
        // Also check non-gate test reports
        const recentFails = (state.testReports ?? []).filter(r => r.status === 'fail');
        return recentFails;
    }
    return (state.testReports ?? []).filter(r => r.status === 'fail');
}

export function afterQaRouter(state: ProjectStateType): string {
    if (state.cancelled) return 'finalize';
    if (state.unrecoverable?.flag) return RUN_FAIL_POLICY === 'halt' ? 'finalize' : 'acceptance-gate';
    const current = currentIterationFailures(state);
    if (current.length > 0 && (state.iteration?.bugfix ?? 0) < getEffectiveLimits().maxBugfixIterations) {
        return 'bugfix-triage';
    }
    // Budget spent with failures still present: under 'halt' go straight to acceptance as a failure;
    // otherwise continue to devops so the run still produces deployment artifacts.
    if (current.length > 0 && RUN_FAIL_POLICY === 'halt') return 'acceptance-gate';
    return 'devops';
}

/**
 * After E2E, route to acceptance (never directly to finalize).
 * Fixes E8: filter to e2e-type reports only, honour iterationIndex.
 * Fixes D7: E2E_BUGFIX_ENABLED default flipped to true.
 */
export function afterE2eRouter(state: ProjectStateType): string {
    if (state.cancelled) return 'finalize';
    if (E2E_BUGFIX_ENABLED) {
        const currentIteration = state.iteration?.bugfix ?? 0;
        // Filter to e2e-type reports with source='executed' at the current iteration
        const hasE2eFailures = (state.testReports ?? []).some(r =>
            r.type === 'e2e'
            && r.source === 'executed'
            && r.status === 'fail'
            && (r.iterationIndex === undefined || r.iterationIndex === currentIteration),
        );
        if (hasE2eFailures && currentIteration < getEffectiveLimits().maxBugfixIterations) {
            return 'bugfix-triage';
        }
    }
    return 'acceptance-gate';
}

/**
 * After acceptance gate: route to bugfix-triage while budget remains
 * and the product is not accepted (and not unrecoverable), or to finalize.
 */
export function afterAcceptanceRouter(state: ProjectStateType): string {
    if (state.cancelled) return 'finalize';
    const a = state.acceptance;
    if (a && a.status !== 'accepted' && !a.unrecoverable
        && (state.iteration?.bugfix ?? 0) < getEffectiveLimits().maxBugfixIterations) {
        return 'bugfix-triage';
    }
    return 'finalize';
}

export function afterIntakeRouter(state: ProjectStateType): string {
    if (state.input.runType === 'maintain') {
        return 'codebase-analyzer';
    }
    return 'architect';
}

// ─── Rerun & cancel routers (HITL support) ──────────────────────────────────

/**
 * Route a phase back to itself when the user asked to enhance it.
 *
 * `pendingRerun` is cleared by the node itself at the start of its next
 * execution, so a phase can only re-run once per request. This replaces the
 * previous no-op "enhance" path, which stored feedback in `approvals` that no
 * node ever read (PART A4.3).
 */
function rerunRouter(phase: PhaseName, next: string) {
    return (state: ProjectStateType): string => {
        if (state.cancelled) return 'finalize';
        if (state.pendingRerun === phase) return phase;
        return next;
    };
}

// ─── Graph builder ──────────────────────────────────────────────────────────

export function buildConductorGraph(opts: ConductorOptions = {}) {
    const resolvedMode = opts.mode ?? RUN_MODE;

    const graph = new StateGraph(ProjectState)
        // Add all nodes
        .addNode('intake', intakeNode)
        .addNode('codebase-analyzer', codebaseAnalyzerNode)
        .addNode('architect', architectNode)
        .addNode('product-manager', productManagerNode)
        .addNode('dba', dbaNode)
        .addNode('team-leader', teamLeaderNode)
        .addNode('development', developmentNode)
        .addNode('qa', qaNode)
        .addNode('bugfix-triage', bugfixTriageNode)
        .addNode('devops', devopsNode)
        .addNode('e2e', e2eNode)
        .addNode('acceptance-gate', acceptanceNode)
        .addNode('finalize', finalizeNode)

        // Linear edges for the main pipeline
        .addEdge('__start__', 'intake')

        // After intake: route to analyzer (maintain) or architect (greenfield)
        .addConditionalEdges('intake', afterIntakeRouter, {
            'codebase-analyzer': 'codebase-analyzer',
            'architect': 'architect',
        })

        // Phases with rerun support — use conditional edges so "enhance" can loop back
        .addConditionalEdges('codebase-analyzer', rerunRouter('codebase-analyzer', 'architect'), {
            'codebase-analyzer': 'codebase-analyzer',
            'architect': 'architect',
            'finalize': 'finalize',
        })
        .addConditionalEdges('architect', rerunRouter('architect', 'product-manager'), {
            'architect': 'architect',
            'product-manager': 'product-manager',
            'finalize': 'finalize',
        })
        .addConditionalEdges('product-manager', rerunRouter('product-manager', 'dba'), {
            'product-manager': 'product-manager',
            'dba': 'dba',
            'finalize': 'finalize',
        })
        .addConditionalEdges('dba', rerunRouter('dba', 'team-leader'), {
            'dba': 'dba',
            'team-leader': 'team-leader',
            'finalize': 'finalize',
        })
        .addConditionalEdges('team-leader', rerunRouter('team-leader', 'development'), {
            'team-leader': 'team-leader',
            'development': 'development',
            'finalize': 'finalize',
        })
        .addConditionalEdges('development', rerunRouter('development', 'qa'), {
            'development': 'development',
            'qa': 'qa',
            'finalize': 'finalize',
        })

        // Conditional: after QA, either bugfix, devops, or acceptance (includes cancel + rerun)
        .addConditionalEdges('qa', (state: ProjectStateType) => {
            if (state.cancelled) return 'finalize';
            if (state.pendingRerun === 'qa') return 'qa';
            return afterQaRouter(state);
        }, {
            'qa': 'qa',
            'bugfix-triage': 'bugfix-triage',
            'devops': 'devops',
            'acceptance-gate': 'acceptance-gate',
            'finalize': 'finalize',
        })

        // After bugfix, back to development
        .addEdge('bugfix-triage', 'development')

        // After devops — rerun support + route to e2e
        .addConditionalEdges('devops', rerunRouter('devops', 'e2e'), {
            'devops': 'devops',
            'e2e': 'e2e',
            'finalize': 'finalize',
        })

        // After E2E: either bugfix (if enabled and failures) or acceptance (includes cancel + rerun)
        .addConditionalEdges('e2e', (state: ProjectStateType) => {
            if (state.cancelled) return 'finalize';
            if (state.pendingRerun === 'e2e') return 'e2e';
            return afterE2eRouter(state);
        }, {
            'e2e': 'e2e',
            'bugfix-triage': 'bugfix-triage',
            'acceptance-gate': 'acceptance-gate',
            'finalize': 'finalize',
        })

        // After acceptance gate: either bugfix-triage (if budget remains and not accepted) or finalize
        .addConditionalEdges('acceptance-gate', afterAcceptanceRouter, {
            'bugfix-triage': 'bugfix-triage',
            'finalize': 'finalize',
        })

        // Finalize is the end
        .addEdge('finalize', END);

    // ── Resolve checkpointer ────────────────────────────────────────────
    let checkpointer: BaseCheckpointSaver;
    if (opts.checkpointer) {
        checkpointer = opts.checkpointer;
    } else if (CHECKPOINT_PERSIST && opts.outputPath) {
        checkpointer = new FileCheckpointer(opts.outputPath);
    } else {
        checkpointer = new MemorySaver();
    }

    return graph.compile({
        checkpointer,
        // In human mode, interrupt after each HITL phase so the agent runs first,
        // produces its output (including the MD mission report), and then the
        // graph pauses for user review before advancing to the next phase.
        ...(resolvedMode === 'human'
            ? { interruptAfter: HITL_PHASES }
            : {}),
    });
}

/**
 * Convenience: build and return the compiled graph ready for invoke/stream.
 */
export function createConductor(opts: ConductorOptions = {}) {
    return buildConductorGraph(opts);
}
