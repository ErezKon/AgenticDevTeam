/**
 * Conductor Graph — the LangGraph state machine that orchestrates
 * all agents through the pipeline phases.
 *
 * Phases: intake → architect → PM → DBA → TL → development → QA → bugfix? → devops → finalize
 */
import { StateGraph, END } from '@langchain/langgraph';
import { ProjectState } from './state';
import { RUN_MODE, MAX_BUGFIX_ITERATIONS } from '../config';
import {
    intakeNode,
    architectNode,
    productManagerNode,
    dbaNode,
    teamLeaderNode,
    developmentNode,
    qaNode,
    bugfixTriageNode,
    devopsNode,
    finalizeNode,
} from './nodes';
import type { ProjectStateType } from './state';
import type { PhaseName } from '../agents/_shared/base-schemas';

// ─── HITL interrupt points (human mode only) ────────────────────────────────

const HITL_PHASES: PhaseName[] = [
    'architect',
    'product-manager',
    'dba',
    'team-leader',
    'development',
    'qa',
    'devops',
];

// ─── Conditional edges ──────────────────────────────────────────────────────

function afterQaRouter(state: ProjectStateType): string {
    const hasFailures = state.testReports.some(r => r.status === 'fail');
    if (hasFailures && state.iteration.bugfix < MAX_BUGFIX_ITERATIONS) {
        return 'bugfix-triage';
    }
    return 'devops';
}

function afterBugfixRouter(state: ProjectStateType): string {
    // After bugfix triage reassigns work, go back to development
    return 'development';
}

// ─── Graph builder ──────────────────────────────────────────────────────────

export function buildConductorGraph() {
    const graph = new StateGraph(ProjectState)
        // Add all nodes
        .addNode('intake', intakeNode)
        .addNode('architect', architectNode)
        .addNode('product-manager', productManagerNode)
        .addNode('dba', dbaNode)
        .addNode('team-leader', teamLeaderNode)
        .addNode('development', developmentNode)
        .addNode('qa', qaNode)
        .addNode('bugfix-triage', bugfixTriageNode)
        .addNode('devops', devopsNode)
        .addNode('finalize', finalizeNode)

        // Linear edges for the main pipeline
        .addEdge('__start__', 'intake')
        .addEdge('intake', 'architect')
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

        // After devops, finalize
        .addEdge('devops', 'finalize')

        // Finalize is the end
        .addEdge('finalize', END);

    return graph.compile({
        // In human mode, interrupt before each HITL phase so the user can approve
        ...(RUN_MODE === 'human'
            ? { interruptBefore: HITL_PHASES as string[] }
            : {}),
    });
}

/**
 * Convenience: build and return the compiled graph ready for invoke/stream.
 */
export function createConductor() {
    return buildConductorGraph();
}
