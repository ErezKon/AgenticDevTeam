/**
 * Conductor Graph — the LangGraph state machine that orchestrates
 * all agents through the pipeline phases.
 *
 * Phases: intake → architect → PM → DBA → TL → development → QA → bugfix? → devops → e2e → finalize
 */
import { StateGraph, END, MemorySaver } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { ProjectState } from './state';
import { RUN_MODE, E2E_BUGFIX_ENABLED, CHECKPOINT_PERSIST } from '../config';
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

export function afterQaRouter(state: ProjectStateType): string {
    if (state.cancelled) return 'finalize';
    const hasFailures = (state.testReports ?? []).some(r => r.status === 'fail');
    if (hasFailures && (state.iteration?.bugfix ?? 0) < getEffectiveLimits().maxBugfixIterations) {
        return 'bugfix-triage';
    }
    return 'devops';
}

/**
 * After E2E, route to bugfix-triage only when ALL of:
 * - E2E_BUGFIX_ENABLED is true (default false — keeps today's cost profile)
 * - an E2E report has status === 'fail'
 * - bugfix iterations remaining
 *
 * Otherwise route to finalize.
 */
export function afterE2eRouter(state: ProjectStateType): string {
    if (state.cancelled) return 'finalize';
    if (E2E_BUGFIX_ENABLED) {
        const hasE2eFailures = (state.testReports ?? []).some(r => r.status === 'fail');
        if (hasE2eFailures && (state.iteration?.bugfix ?? 0) < getEffectiveLimits().maxBugfixIterations) {
            return 'bugfix-triage';
        }
    }
    return 'finalize';
}

function afterBugfixRouter(state: ProjectStateType): string {
    // After bugfix triage reassigns work, go back to development
    return 'development';
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

/**
 * Map of each HITL phase to its "normal" next destination.
 * Used by rerunRouter to decide where to go when not re-running.
 */
const PHASE_NEXT: Partial<Record<PhaseName, string>> = {
    'codebase-analyzer': 'architect',
    'architect': 'product-manager',
    'product-manager': 'dba',
    'dba': 'team-leader',
    'team-leader': 'development',
    'development': 'qa',
    // qa, devops, e2e have their own conditional routers so they are not here
};

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

        // Conditional: after QA, either bugfix or devops (includes cancel + rerun)
        .addConditionalEdges('qa', (state: ProjectStateType) => {
            if (state.cancelled) return 'finalize';
            if (state.pendingRerun === 'qa') return 'qa';
            return afterQaRouter(state);
        }, {
            'qa': 'qa',
            'bugfix-triage': 'bugfix-triage',
            'devops': 'devops',
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

        // After E2E: either bugfix (if enabled and failures) or finalize (includes cancel + rerun)
        .addConditionalEdges('e2e', (state: ProjectStateType) => {
            if (state.cancelled) return 'finalize';
            if (state.pendingRerun === 'e2e') return 'e2e';
            return afterE2eRouter(state);
        }, {
            'e2e': 'e2e',
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
