/**
 * Conductor Graph — the LangGraph state machine that orchestrates
 * all agents through the pipeline phases.
 *
 * Phases: intake → architect → PM → DBA → TL → development → QA → bugfix? → devops → e2e → finalize
 */
import { StateGraph, END } from '@langchain/langgraph';
import { ProjectState } from './state';
import { RUN_MODE, MAX_BUGFIX_ITERATIONS, E2E_BUGFIX_ENABLED } from '../config';
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

// ─── Conditional edges ──────────────────────────────────────────────────────

export function afterQaRouter(state: ProjectStateType): string {
    const hasFailures = (state.testReports ?? []).some(r => r.status === 'fail');
    if (hasFailures && (state.iteration?.bugfix ?? 0) < MAX_BUGFIX_ITERATIONS) {
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
    if (E2E_BUGFIX_ENABLED) {
        const hasE2eFailures = (state.testReports ?? []).some(r => r.status === 'fail');
        if (hasE2eFailures && (state.iteration?.bugfix ?? 0) < MAX_BUGFIX_ITERATIONS) {
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

// ─── Graph builder ──────────────────────────────────────────────────────────

export function buildConductorGraph() {
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

        // Analyzer always flows to architect
        .addEdge('codebase-analyzer', 'architect')
        .addEdge('architect', 'product-manager')
        .addEdge('product-manager', 'dba')
        .addEdge('dba', 'team-leader')
        .addEdge('team-leader', 'development')
        .addEdge('development', 'qa')

        // Conditional: after QA, either bugfix or devops
        .addConditionalEdges('qa', afterQaRouter, {
            'bugfix-triage': 'bugfix-triage',
            'devops': 'devops',
        })

        // After bugfix, back to development
        .addEdge('bugfix-triage', 'development')

        // After devops, E2E testing
        .addEdge('devops', 'e2e')

        // After E2E: either bugfix (if enabled and failures) or finalize
        .addConditionalEdges('e2e', afterE2eRouter, {
            'bugfix-triage': 'bugfix-triage',
            'finalize': 'finalize',
        })

        // Finalize is the end
        .addEdge('finalize', END);

    return graph.compile({
        // In human mode, interrupt before each HITL phase so the user can approve
        ...(RUN_MODE === 'human'
            ? { interruptBefore: HITL_PHASES }
            : {}),
    });
}

/**
 * Convenience: build and return the compiled graph ready for invoke/stream.
 */
export function createConductor() {
    return buildConductorGraph();
}
