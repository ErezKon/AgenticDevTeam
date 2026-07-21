/**
 * Conductor graph nodes — one function per pipeline phase.
 *
 * Each node reads ProjectState, invokes agent(s), and returns a partial
 * state update that the LangGraph reducers merge into the full state.
 */
import { getAccessToken } from '../utils/oauth-auth.util';
import { getLogger, setRunLogPath } from '../utils/logger';
import { writeArtifact } from '../agents/_shared/artifact';
import { createProjectWorkspace, createRunOutputDir } from '../utils/workspace';
import { parseRequirementsFile } from '../tools/requirements/parse-requirements';
import { createArchitectAgent } from '../agents/architect/architect.agent';
import { createProductManagerAgent } from '../agents/product-manager/product-manager.agent';
import { createDbaAgent } from '../agents/dba/dba.agent';
import { createTeamLeaderAgent } from '../agents/team-leader/team-leader.agent';
import { dispatchDevelopers } from '../agents/developers/dispatcher';
import { createQaLeadAgent, createQaUnitAgent, createQaE2eAgent } from '../agents/qa/qa.agents';
import { createDevOpsAgent } from '../agents/devops/devops.agent';
import { getPlaywrightMcpTools, closePlaywrightMcp } from '../tools/mcp/playwright-mcp';
import { MAX_BUGFIX_ITERATIONS } from '../config';
import type { ProjectStateType } from './state';
import type { PhaseName, TranscriptMessage, Bug } from '../agents/_shared/base-schemas';
import * as path from 'path';

// ─── Helpers ────────────────────────────────────────────────────────────────

function ts(): string { return new Date().toISOString(); }

function msg(agentId: string, phase: PhaseName, message: string): TranscriptMessage {
    return { timestamp: ts(), agentId, phase, message };
}

async function invokeAgent(agent: any, userMessage: string, threadSuffix: string): Promise<any> {
    const result = await agent.invoke(
        { messages: [{ role: 'user', content: userMessage }] },
        { configurable: { thread_id: `conductor-${threadSuffix}-${Date.now()}` } },
    );
    const last = result.messages[result.messages.length - 1];
    return typeof last.content === 'string' ? JSON.parse(last.content) : last.content;
}

// ─── 1. Intake ──────────────────────────────────────────────────────────────

const intakeLog = getLogger('[Intake]', 255);

export async function intakeNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    intakeLog.info('Starting intake phase...');

    let requirementsText = state.input.requirementsText;
    if (state.input.requirementsDocPath && !requirementsText) {
        intakeLog.info(`Parsing requirements from: ${state.input.requirementsDocPath}`);
        requirementsText = await parseRequirementsFile(state.input.requirementsDocPath);
        intakeLog.info(`Extracted ${requirementsText.length} characters`);
    }

    const workspacePath = createProjectWorkspace(state.input.systemName);
    const outputPath = createRunOutputDir(state.input.systemName);
    setRunLogPath(path.join(outputPath, 'run.log'));

    intakeLog.info(`Workspace: ${workspacePath}`);
    intakeLog.info(`Output: ${outputPath}`);

    return {
        input: { ...state.input, requirementsText },
        workspacePath,
        outputPath,
        phase: 'architect' as PhaseName,
        transcript: [msg('conductor', 'intake', `Intake complete. Requirements: ${requirementsText.length} chars`)],
    };
}

// ─── 2. Architect ───────────────────────────────────────────────────────────

const archLog = getLogger('[Architect]', 39);

export async function architectNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    archLog.info('Starting architecture phase...');
    const apiKey = await getAccessToken();
    const agent = createArchitectAgent(apiKey);

    const userMsg = `## System Requirements\n\n${state.input.requirementsText}`;
    const output = await invokeAgent(agent, userMsg, 'architect');

    archLog.info(`Architecture: ${output.architecture?.components?.length ?? 0} components`);
    archLog.info(`Tech decisions: ${output.techStack?.length ?? 0}`);
    archLog.info(`Epics: ${output.epics?.length ?? 0}`);

    const artifact = writeArtifact({
        agentId: 'architect',
        colorCode: 39,
        workspacePath: state.workspacePath,
        title: 'Architect Mission Report',
        content: [
            `## Architecture Style\n\n${output.architecture?.style}`,
            `\n## Components\n\n${(output.architecture?.components ?? []).map((c: any) => `- **${c.name}** (${c.type}): ${c.description}`).join('\n')}`,
            `\n## Tech Stack\n\n${(output.techStack ?? []).map((t: any) => `- **${t.layer}**: ${t.choice} — ${t.rationale}`).join('\n')}`,
            `\n## Epics\n\n${(output.epics ?? []).map((e: any) => `- **${e.id}** ${e.title}: ${e.description}`).join('\n')}`,
            output.architecture?.mermaidDiagram ? `\n## Architecture Diagram\n\n\`\`\`mermaid\n${output.architecture.mermaidDiagram}\n\`\`\`` : '',
        ].join('\n'),
    });

    return {
        architecture: output.architecture,
        techStack: output.techStack ?? [],
        epics: output.epics ?? [],
        phase: 'product-manager' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('architect', 'architect', `Designed ${output.architecture?.components?.length ?? 0} components, ${output.epics?.length ?? 0} epics`)],
    };
}

// ─── 3. Product Manager ─────────────────────────────────────────────────────

const pmLog = getLogger('[Product Manager]', 214);

export async function productManagerNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    pmLog.info('Starting product management phase...');
    const apiKey = await getAccessToken();
    const agent = createProductManagerAgent(apiKey);

    const userMsg = [
        `## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
        `\n## Tech Stack\n\n${JSON.stringify(state.techStack, null, 2)}`,
        `\n## Epics\n\n${JSON.stringify(state.epics, null, 2)}`,
        `\n## Original Requirements\n\n${state.input.requirementsText}`,
    ].join('\n');

    const output = await invokeAgent(agent, userMsg, 'pm');
    pmLog.info(`Stories: ${output.userStories?.length ?? 0}, Tasks: ${output.tasks?.length ?? 0}`);

    const artifact = writeArtifact({
        agentId: 'product-manager',
        colorCode: 214,
        workspacePath: state.workspacePath,
        title: 'Product Manager Mission Report',
        content: [
            `## User Stories (${output.userStories?.length ?? 0})\n`,
            ...(output.userStories ?? []).map((s: any) => `### ${s.id}: As a ${s.asA}, I want ${s.iWant}\n- So that: ${s.soThat}\n- AC: ${s.acceptanceCriteria?.join('; ')}`),
            `\n## Tasks (${output.tasks?.length ?? 0})\n`,
            ...(output.tasks ?? []).map((t: any) => `- **${t.id}** [${t.layer}/${t.suggestedTech}] ${t.title}`),
        ].join('\n'),
    });

    return {
        userStories: output.userStories ?? [],
        tasks: output.tasks ?? [],
        phase: 'dba' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('product-manager', 'product-manager', `Created ${output.userStories?.length ?? 0} stories, ${output.tasks?.length ?? 0} tasks`)],
    };
}

// ─── 4. DBA ─────────────────────────────────────────────────────────────────

const dbaLog = getLogger('[DBA]', 100);

export async function dbaNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    dbaLog.info('Starting database design phase...');
    const apiKey = await getAccessToken();
    const agent = createDbaAgent(apiKey);

    const userMsg = [
        `## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
        `\n## Tech Stack\n\n${JSON.stringify(state.techStack, null, 2)}`,
        `\n## User Stories\n\n${JSON.stringify(state.userStories, null, 2)}`,
        `\n## Tasks\n\n${JSON.stringify(state.tasks, null, 2)}`,
    ].join('\n');

    const output = await invokeAgent(agent, userMsg, 'dba');
    dbaLog.info(`DB engine: ${output.dbDesign?.engine}, Entities: ${output.dbDesign?.entities?.length ?? 0}`);

    const artifact = writeArtifact({
        agentId: 'dba',
        colorCode: 100,
        workspacePath: state.workspacePath,
        title: 'DBA Mission Report',
        content: [
            `## Database Engine: ${output.dbDesign?.engine}\n\n${output.dbDesign?.rationale}`,
            `\n## Entities (${output.dbDesign?.entities?.length ?? 0})\n`,
            ...(output.dbDesign?.entities ?? []).map((e: any) => `- **${e.name}**: ${e.columns?.length ?? 0} columns`),
            output.dbDesign?.erdMermaid ? `\n## ERD\n\n\`\`\`mermaid\n${output.dbDesign.erdMermaid}\n\`\`\`` : '',
        ].join('\n'),
    });

    return {
        dbDesign: output.dbDesign,
        phase: 'team-leader' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('dba', 'dba', `Designed ${output.dbDesign?.entities?.length ?? 0} entities on ${output.dbDesign?.engine}`)],
    };
}

// ─── 5. Team Leader ─────────────────────────────────────────────────────────

const tlLog = getLogger('[Team Leader]', 213);

export async function teamLeaderNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    tlLog.info('Starting assignment phase...');
    const apiKey = await getAccessToken();
    const agent = createTeamLeaderAgent(apiKey);

    const userMsg = [
        `## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
        `\n## Tech Stack\n\n${JSON.stringify(state.techStack, null, 2)}`,
        `\n## DB Design\n\n${JSON.stringify(state.dbDesign, null, 2)}`,
        `\n## User Stories\n\n${JSON.stringify(state.userStories, null, 2)}`,
        `\n## Tasks\n\n${JSON.stringify(state.tasks, null, 2)}`,
    ].join('\n');

    const output = await invokeAgent(agent, userMsg, 'tl');
    tlLog.info(`Assignments: ${output.assignments?.length ?? 0}`);

    const artifact = writeArtifact({
        agentId: 'team-leader',
        colorCode: 213,
        workspacePath: state.workspacePath,
        title: 'Team Leader Mission Report',
        content: [
            `## Assignments (${output.assignments?.length ?? 0})\n`,
            ...(output.assignments ?? []).map((a: any) =>
                `### ${a.id} -> ${a.devAgentId} [${a.rank}]\n- Priority: ${a.priority} | Complexity: ${a.complexity}\n- ${a.description}`
            ),
        ].join('\n'),
    });

    return {
        assignments: output.assignments ?? [],
        phase: 'development' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('team-leader', 'team-leader', `Created ${output.assignments?.length ?? 0} assignments`)],
    };
}

// ─── 6. Development (fan-out) ───────────────────────────────────────────────

const devLog = getLogger('[Development]', 226);

export async function developmentNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    devLog.info(`Starting development with ${state.assignments.length} assignments...`);
    const apiKey = await getAccessToken();

    const contextPrompt = [
        `## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
        `\n## Tech Stack\n\n${JSON.stringify(state.techStack, null, 2)}`,
        `\n## DB Design\n\n${JSON.stringify(state.dbDesign, null, 2)}`,
        `\n## User Stories\n\n${JSON.stringify(state.userStories, null, 2)}`,
        `\n## Existing File Changes\n\n${JSON.stringify(state.fileChanges, null, 2)}`,
    ].join('\n');

    const result = await dispatchDevelopers(apiKey, state.assignments, state.workspacePath, contextPrompt);

    devLog.info(`Development complete: ${result.fileChanges.length} file changes`);

    return {
        fileChanges: result.fileChanges,
        artifacts: result.artifacts,
        transcript: [
            ...result.transcript,
            msg('conductor', 'development', `Development phase complete: ${result.fileChanges.length} files changed`),
        ],
        phase: 'qa' as PhaseName,
    };
}

// ─── 7. QA ──────────────────────────────────────────────────────────────────

const qaLog = getLogger('[QA]', 198);

export async function qaNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    qaLog.info('Starting QA phase...');
    const apiKey = await getAccessToken();
    const transcript: TranscriptMessage[] = [];
    const allBugs: Bug[] = [];

    // 7a. QA Lead — create test plan
    qaLog.info('QA Lead creating test plan...');
    const qaLeadAgent = createQaLeadAgent(apiKey);
    const leadMsg = [
        `## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
        `\n## User Stories\n\n${JSON.stringify(state.userStories, null, 2)}`,
        `\n## Tech Stack\n\n${JSON.stringify(state.techStack, null, 2)}`,
        `\n## DB Design\n\n${JSON.stringify(state.dbDesign, null, 2)}`,
    ].join('\n');
    const leadOutput = await invokeAgent(qaLeadAgent, leadMsg, 'qa-lead');
    qaLog.info(`Test plan: ${leadOutput.testPlan?.unit?.length ?? 0} unit, ${leadOutput.testPlan?.e2e?.length ?? 0} e2e`);

    const leadArtifact = writeArtifact({
        agentId: 'qa-lead', colorCode: 198, workspacePath: state.workspacePath,
        title: 'QA Lead — Test Plan',
        content: `## Test Plan\n\n${JSON.stringify(leadOutput.testPlan, null, 2)}`,
    });
    transcript.push(msg('qa-lead', 'qa', `Test plan created: ${leadOutput.testPlan?.unit?.length ?? 0} unit, ${leadOutput.testPlan?.e2e?.length ?? 0} e2e`));

    // 7b. QA Unit — write & run unit/integration tests
    qaLog.info('QA Unit writing and running tests...');
    const qaUnitAgent = createQaUnitAgent(apiKey, state.workspacePath);
    const unitMsg = [
        `## Test Plan (unit + integration)\n\n${JSON.stringify({ unit: leadOutput.testPlan?.unit, integration: leadOutput.testPlan?.integration }, null, 2)}`,
        `\n## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
        `\n## Tech Stack\n\n${JSON.stringify(state.techStack, null, 2)}`,
    ].join('\n');
    const unitOutput = await invokeAgent(qaUnitAgent, unitMsg, 'qa-unit');
    qaLog.info(`Unit tests: ${unitOutput.testReport?.passed ?? 0} passed, ${unitOutput.testReport?.failed ?? 0} failed`);
    if (unitOutput.bugs) allBugs.push(...unitOutput.bugs);

    const unitArtifact = writeArtifact({
        agentId: 'qa-unit', colorCode: 205, workspacePath: state.workspacePath,
        title: 'QA Unit — Test Report',
        content: `## Results\n\n${JSON.stringify(unitOutput.testReport, null, 2)}`,
    });
    transcript.push(msg('qa-unit', 'qa', `Unit tests: ${unitOutput.testReport?.passed ?? 0}/${unitOutput.testReport?.total ?? 0} passed`));

    // 7c. QA E2E — Playwright MCP testing (only if services are running)
    let e2eReport = null;
    let e2eArtifact = null;
    if (state.devops?.serviceUrls && state.devops.serviceUrls.length > 0) {
        qaLog.info('QA E2E running Playwright tests...');
        try {
            const mcpTools = await getPlaywrightMcpTools();
            const qaE2eAgent = createQaE2eAgent(apiKey, mcpTools);
            const e2eMsg = [
                `## Test Plan (e2e)\n\n${JSON.stringify(leadOutput.testPlan?.e2e, null, 2)}`,
                `\n## Service URLs\n\n${JSON.stringify(state.devops.serviceUrls, null, 2)}`,
            ].join('\n');
            const e2eOutput = await invokeAgent(qaE2eAgent, e2eMsg, 'qa-e2e');
            e2eReport = e2eOutput.testReport;
            if (e2eOutput.bugs) allBugs.push(...e2eOutput.bugs);
            qaLog.info(`E2E tests: ${e2eReport?.passed ?? 0} passed, ${e2eReport?.failed ?? 0} failed`);

            e2eArtifact = writeArtifact({
                agentId: 'qa-e2e', colorCode: 118, workspacePath: state.workspacePath,
                title: 'QA E2E — Test Report',
                content: `## Results\n\n${JSON.stringify(e2eReport, null, 2)}`,
            });
            transcript.push(msg('qa-e2e', 'qa', `E2E tests: ${e2eReport?.passed ?? 0}/${e2eReport?.total ?? 0} passed`));
            await closePlaywrightMcp();
        } catch (err: any) {
            qaLog.error(`E2E testing failed: ${err.message}`);
            transcript.push(msg('qa-e2e', 'qa', `E2E testing failed: ${err.message}`));
        }
    } else {
        qaLog.info('Skipping E2E tests — no running services');
        transcript.push(msg('qa-e2e', 'qa', 'Skipped — no running services'));
    }

    const testReports = [unitOutput.testReport, ...(e2eReport ? [e2eReport] : [])].filter(Boolean);
    const artifacts = [leadArtifact, unitArtifact, ...(e2eArtifact ? [e2eArtifact] : [])];

    return {
        testPlan: leadOutput.testPlan,
        testReports,
        bugs: allBugs,
        fileChanges: unitOutput.fileChanges ?? [],
        artifacts,
        transcript,
        phase: 'qa' as PhaseName,
    };
}

// ─── 8. Bug-fix Triage ──────────────────────────────────────────────────────

const bugLog = getLogger('[BugTriage]', 196);

export async function bugfixTriageNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    const iteration = state.iteration.bugfix + 1;
    bugLog.info(`Bug-fix triage iteration ${iteration}/${MAX_BUGFIX_ITERATIONS}`);

    const openBugs = state.bugs.filter(b => b.severity === 'critical' || b.severity === 'major');
    if (openBugs.length === 0) {
        bugLog.info('No critical/major bugs — skipping to DevOps');
        return {
            phase: 'devops' as PhaseName,
            iteration: { bugfix: iteration },
            transcript: [msg('team-leader', 'bugfix-triage', 'No critical bugs to fix')],
        };
    }

    bugLog.info(`Re-assigning ${openBugs.length} bugs to developers...`);
    const apiKey = await getAccessToken();
    const agent = createTeamLeaderAgent(apiKey);

    const userMsg = [
        `## Bug-fix Triage — Iteration ${iteration}`,
        `\n## Open Bugs\n\n${JSON.stringify(openBugs, null, 2)}`,
        `\n## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
        `\n## Existing Assignments\n\n${JSON.stringify(state.assignments, null, 2)}`,
        `\n\nPlease create NEW assignments to fix these bugs. Assign each bug to the most appropriate developer.`,
    ].join('\n');

    const output = await invokeAgent(agent, userMsg, `tl-bugfix-${iteration}`);
    bugLog.info(`Created ${output.assignments?.length ?? 0} bugfix assignments`);

    return {
        assignments: output.assignments ?? [],
        iteration: { bugfix: iteration },
        phase: 'development' as PhaseName,
        transcript: [msg('team-leader', 'bugfix-triage', `Iteration ${iteration}: reassigned ${output.assignments?.length ?? 0} bug fixes`)],
    };
}

// ─── 9. DevOps ──────────────────────────────────────────────────────────────

const opsLog = getLogger('[DevOps]', 33);

export async function devopsNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    opsLog.info('Starting DevOps phase...');
    const apiKey = await getAccessToken();
    const agent = createDevOpsAgent(apiKey, state.workspacePath);

    const userMsg = [
        `## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
        `\n## Tech Stack\n\n${JSON.stringify(state.techStack, null, 2)}`,
        `\n## DB Design\n\n${JSON.stringify(state.dbDesign, null, 2)}`,
        `\n## File Changes\n\n${JSON.stringify(state.fileChanges, null, 2)}`,
    ].join('\n');

    const output = await invokeAgent(agent, userMsg, 'devops');
    opsLog.info(`Build: ${output.devops?.buildStatus}, Run: ${output.devops?.runStatus}`);

    const artifact = writeArtifact({
        agentId: 'devops', colorCode: 33, workspacePath: state.workspacePath,
        title: 'DevOps Mission Report',
        content: [
            `## Build Status: ${output.devops?.buildStatus}`,
            `## Run Status: ${output.devops?.runStatus}`,
            `\n## Services\n\n${(output.devops?.serviceUrls ?? []).map((s: any) => `- **${s.service}**: ${s.url}`).join('\n')}`,
            `\n## Health Checks\n\n${(output.devops?.healthChecks ?? []).map((h: any) => `- ${h.service}: ${h.status}`).join('\n')}`,
        ].join('\n'),
    });

    return {
        devops: output.devops,
        fileChanges: output.fileChanges ?? [],
        phase: 'finalize' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('devops', 'devops', `Build: ${output.devops?.buildStatus}, Run: ${output.devops?.runStatus}`)],
    };
}

// ─── 10. Finalize ───────────────────────────────────────────────────────────

const finalLog = getLogger('[Finalize]', 46);

export async function finalizeNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    finalLog.info('Finalizing run...');

    const summary = [
        `System: ${state.input.systemName}`,
        `Architecture: ${state.architecture?.style} with ${state.architecture?.components?.length ?? 0} components`,
        `Stories: ${state.userStories.length}, Tasks: ${state.tasks.length}`,
        `Assignments: ${state.assignments.length}`,
        `File changes: ${state.fileChanges.length}`,
        `Test reports: ${state.testReports.length}`,
        `Bugs: ${state.bugs.length}`,
        `Artifacts: ${state.artifacts.length}`,
    ].join('\n');

    finalLog.info(`\n${summary}`);

    // Write final summary artifact
    writeArtifact({
        agentId: 'conductor',
        colorCode: 46,
        workspacePath: state.workspacePath,
        title: 'Run Summary',
        content: summary,
    });

    return {
        phase: 'finalize' as PhaseName,
        transcript: [msg('conductor', 'finalize', 'Run complete')],
    };
}
