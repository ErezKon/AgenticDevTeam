/**
 * CLI display / print helpers — header, roster, artifacts, phase status.
 *
 * Extracted from cli.ts in Sub-Plan 25-09 to reduce the 871-line monolith.
 */
import * as fs from 'fs';
import * as path from 'path';
import { LogColors, color256 } from '../utils/log-colors.util';
import { AGENT_REGISTRY } from '../agents/registry';
import { redactState } from '../utils/run-snapshot';
import type { ProjectStateType } from '../conductor/state';

const TAG = `${color256(46)}[CLI]${LogColors.RESET}`;

export function printHeader(): void {
    console.log(`
${color256(46)}\u2554${'═'.repeat(62)}\u2557
\u2551              AgenticDevTeam \u2014 Multi-Agent System             \u2551
\u2551          Autonomous Software Delivery Pipeline               \u2551
\u255a${'═'.repeat(62)}\u255d${LogColors.RESET}
`);
}

export function printAgentRoster(): void {
    console.log(`${color256(255)}Agent Roster (${AGENT_REGISTRY.length} agents):${LogColors.RESET}`);
    for (const agent of AGENT_REGISTRY) {
        console.log(`  ${color256(agent.colorCode)}${agent.tag}${LogColors.RESET} ${agent.name} [${agent.category}]`);
    }
    console.log('');
}

export function printArtifactReport(state: ProjectStateType): void {
    const latestArtifact = state.artifacts?.[state.artifacts.length - 1];
    if (!latestArtifact || !state.workspacePath) return;

    const filePath = path.join(state.workspacePath, latestArtifact.filePath);
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, 'utf-8');
    console.log(`\n${color256(255)}${'─'.repeat(60)}${LogColors.RESET}`);
    console.log(`${color256(46)}${latestArtifact.title}${LogColors.RESET}`);
    console.log(`${color256(255)}${'─'.repeat(60)}${LogColors.RESET}`);
    console.log(content);
    console.log(`${color256(255)}${'─'.repeat(60)}${LogColors.RESET}\n`);
}

export function printAllArtifacts(state: ProjectStateType): void {
    if (!state.artifacts?.length || !state.workspacePath) {
        console.log(`${TAG} No mission reports available yet.`);
        return;
    }

    for (const artifact of state.artifacts) {
        const filePath = path.join(state.workspacePath, artifact.filePath);
        if (!fs.existsSync(filePath)) {
            console.log(`${TAG} ${artifact.title} — file not found: ${artifact.filePath}`);
            continue;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        console.log(`\n${color256(255)}${'═'.repeat(60)}${LogColors.RESET}`);
        console.log(`${color256(46)}${artifact.title}${LogColors.RESET}  ${color256(33)}[${artifact.agentId}]${LogColors.RESET}`);
        console.log(`${color256(255)}${'═'.repeat(60)}${LogColors.RESET}`);
        console.log(content);
    }
    console.log(`${color256(255)}${'═'.repeat(60)}${LogColors.RESET}\n`);
}

export function printPhaseStatus(state: ProjectStateType): void {
    console.log(`\n${color256(255)}─── Current State ───${LogColors.RESET}`);
    console.log(`  Phase:       ${state.phase}`);
    console.log(`  System:      ${state.input.systemName}`);
    console.log(`  Workspace:   ${state.workspacePath || '(not created yet)'}`);
    console.log(`  Architecture: ${state.architecture ? `${state.architecture.style} (${state.architecture.components.length} components)` : '(pending)'}`);
    console.log(`  Stories:     ${state.userStories.length}`);
    console.log(`  Tasks:       ${state.tasks.length}`);
    console.log(`  Assignments: ${state.assignments.length}`);
    console.log(`  File changes: ${state.fileChanges.length}`);
    console.log(`  Test reports: ${state.testReports.length}`);
    console.log(`  Bugs:        ${state.bugs.length}`);
    console.log(`  Artifacts:   ${state.artifacts.length}`);
    console.log(`  Bug-fix iter: ${state.iteration.bugfix}`);
    console.log('');
}

export function printStateJson(state: ProjectStateType): void {
    console.log(JSON.stringify(redactState(state), null, 2));
}
