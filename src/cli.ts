#!/usr/bin/env npx tsx
/**
 * Interactive CLI for the AgenticDevTeam multi-agent system.
 *
 * Supports:
 * - Autonomous mode: full pipeline runs unattended.
 * - Human-in-the-loop mode: pauses after each phase for approve/deny/enhance.
 * - Requirements from file path or inline text.
 */
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) (globalThis as any).crypto = webcrypto;

// TLS: honour NODE_EXTRA_CA_CERTS for corporate CAs instead of disabling
// certificate validation globally. (Plan 26-02, D1)
import './env';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { LogColors, color256 } from './utils/log-colors.util';
import { AGENT_REGISTRY } from './agents/registry';
import { runAutonomous, runHumanInTheLoop, continueRun, type RunSession } from './conductor/run';
import { listStoppedRuns, collectRunState, reconstructState } from './conductor/continue';
import { parseRequirementsFile } from './tools/requirements/parse-requirements';
import type { ProjectStateType } from './conductor/state';
import type { RepoTarget } from './agents/_shared/base-schemas';
import { tokenTracker } from './utils/token-tracker';
import { slugify } from './utils/branch-naming';
import { refreshTokenReport } from './utils/token-report';
import { redactState } from './utils/run-snapshot';

const TAG = `${color256(46)}[CLI]${LogColors.RESET}`;

// ─── Signal handlers — flush token report on unexpected exit ─────────────────

function flushTokenReportOnExit(reason: string) {
    try {
        if (tokenTracker.getOutputPath()) {
            tokenTracker.setRunStatus('failed');
            refreshTokenReport();
            console.error(`${TAG} Token report saved (${reason}).`);
        }
    } catch { /* best-effort */ }
}

process.on('SIGINT', () => {
    flushTokenReportOnExit('SIGINT');
    process.exit(130);
});
process.on('SIGTERM', () => {
    flushTokenReportOnExit('SIGTERM');
    process.exit(143);
});
process.on('uncaughtException', (err) => {
    console.error(`${TAG} Uncaught exception: ${err.message}`);
    flushTokenReportOnExit('uncaughtException');
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error(`${TAG} Unhandled rejection: ${reason}`);
    flushTokenReportOnExit('unhandledRejection');
    process.exit(1);
});

// ─── Readline setup ─────────────────────────────────────────────────────────

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function ask(prompt: string): Promise<string> {
    return new Promise((resolve) => {
        rl.question(`${TAG} ${prompt}`, (answer) => resolve(answer.trim()));
    });
}

function printHeader() {
    console.log(`
${color256(46)}╔══════════════════════════════════════════════════════════════╗
║              AgenticDevTeam — Multi-Agent System             ║
║          Autonomous Software Delivery Pipeline               ║
╚══════════════════════════════════════════════════════════════╝${LogColors.RESET}
`);
}

function printAgentRoster() {
    console.log(`${color256(255)}Agent Roster (${AGENT_REGISTRY.length} agents):${LogColors.RESET}`);
    for (const agent of AGENT_REGISTRY) {
        console.log(`  ${color256(agent.colorCode)}${agent.tag}${LogColors.RESET} ${agent.name} [${agent.category}]`);
    }
    console.log('');
}

function printArtifactReport(state: ProjectStateType): void {
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

function printAllArtifacts(state: ProjectStateType): void {
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

function printPhaseStatus(state: ProjectStateType) {
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

// ─── Main menu ──────────────────────────────────────────────────────────────

async function mainMenu(): Promise<void> {
    printHeader();

    console.log(`${color256(255)}Commands:${LogColors.RESET}`);
    console.log('  1) Start new run (autonomous)');
    console.log('  2) Start new run (human-in-the-loop)');
    console.log('  3) Maintain existing project');
    console.log('  4) Continue a stopped run');
    console.log('  5) Show agent roster');
    console.log('  6) Exit');
    console.log('');

    const choice = await ask('Choose [1-6]: ');

    switch (choice) {
        case '1':
            await startAutonomousRun();
            break;
        case '2':
            await startHitlRun();
            break;
        case '3':
            await startMaintainRun();
            break;
        case '4':
            await startContinueRun();
            break;
        case '5':
            printAgentRoster();
            await mainMenu();
            break;
        case '6':
            console.log(`${TAG} Goodbye!`);
            rl.close();
            process.exit(0);
        default:
            console.log(`${TAG} Invalid choice. Try again.`);
            await mainMenu();
    }
}

// ─── Requirements input ─────────────────────────────────────────────────────

async function getRequirements(): Promise<{ systemName: string; requirementsText?: string; requirementsDocPath?: string }> {
    const systemName = await ask('System name: ');
    if (!systemName) {
        console.log(`${TAG} System name is required.`);
        return getRequirements();
    }

    console.log(`${TAG} How to provide requirements?`);
    console.log('  1) File path (.md, .txt, .pdf, .docx)');
    console.log('  2) Type/paste text inline');

    const method = await ask('Choose [1-2]: ');

    if (method === '1') {
        const filePath = await ask('File path: ');
        const resolved = path.resolve(filePath);
        if (!fs.existsSync(resolved)) {
            console.log(`${TAG} File not found: ${resolved}`);
            return getRequirements();
        }
        return { systemName, requirementsDocPath: resolved };
    } else {
        console.log(`${TAG} Enter requirements (type END on a new line to finish):`);
        const lines: string[] = [];
        while (true) {
            const line = await ask('');
            if (line === 'END') break;
            lines.push(line);
        }
        return { systemName, requirementsText: lines.join('\n') };
    }
}

// ─── Repo target selection ──────────────────────────────────────────────────

async function getRepoTarget(systemName: string): Promise<RepoTarget | undefined> {
    console.log(`\n${TAG} Where should this project be hosted?`);
    console.log('  1) Same repository (AgenticDevTeam)');
    console.log('  2) New GitHub repository');
    console.log('  3) Existing GitHub repository');

    const choice = await ask('Choose [1-3]: ');

    switch (choice) {
        case '1':
            return { type: 'same-repo', isPrivate: true };

        case '2': {
            const defaultName = slugify(systemName);
            const repoName = (await ask(`Repository name [${defaultName}]: `)) || defaultName;
            const privateAnswer = await ask('Private repository? [Y/n]: ');
            const isPrivate = !privateAnswer || privateAnswer.toLowerCase() !== 'n';
            return { type: 'new-repo', repoName, isPrivate };
        }

        case '3': {
            const repoName = await ask('Repository name: ');
            if (!repoName) {
                console.log(`${TAG} Repository name is required.`);
                return getRepoTarget(systemName);
            }
            return { type: 'existing-repo', repoName, isPrivate: true };
        }

        default:
            console.log(`${TAG} Invalid choice. Defaulting to same repository.`);
            return undefined;
    }
}

// ─── Autonomous run ─────────────────────────────────────────────────────────

async function startAutonomousRun() {
    const reqs = await getRequirements();

    let requirementsText = reqs.requirementsText;
    if (reqs.requirementsDocPath && !requirementsText) {
        console.log(`${TAG} Parsing requirements file...`);
        requirementsText = await parseRequirementsFile(reqs.requirementsDocPath);
    }

    // Ask where to host the project (greenfield only)
    const repoTarget = await getRepoTarget(reqs.systemName);

    console.log(`\n${TAG} Starting autonomous run for "${reqs.systemName}"...`);
    console.log(`${TAG} The full pipeline will run without interruption.\n`);

    try {
        const finalState = await runAutonomous({
            systemName: reqs.systemName,
            requirementsText,
            requirementsDocPath: reqs.requirementsDocPath,
            mode: 'autonomous',
            repoTarget,
        });

        console.log(`\n${color256(46)}═══ Run Complete ═══${LogColors.RESET}`);
        printPhaseStatus(finalState);

        if (finalState.workspacePath) {
            console.log(`${TAG} Generated project: ${finalState.workspacePath}`);
        }
        if (finalState.outputPath) {
            console.log(`${TAG} Run logs: ${finalState.outputPath}`);
        }
    } catch (err: any) {
        console.error(`\n${TAG} ${LogColors.RED}Run failed: ${err.message}${LogColors.RESET}`);
        console.error(err.stack);
        // Token report is already flushed by run.ts try/catch, but log path for user
        const reportPath = tokenTracker.getOutputPath();
        if (reportPath) {
            console.error(`${TAG} Partial token report: ${reportPath}/token-usage-report.html`);
        }
    }

    await mainMenu();
}

// ─── Human-in-the-loop run ──────────────────────────────────────────────────

async function startHitlRun() {
    const reqs = await getRequirements();

    let requirementsText = reqs.requirementsText;
    if (reqs.requirementsDocPath && !requirementsText) {
        console.log(`${TAG} Parsing requirements file...`);
        requirementsText = await parseRequirementsFile(reqs.requirementsDocPath);
    }

    // Ask where to host the project (greenfield only)
    const repoTarget = await getRepoTarget(reqs.systemName);

    console.log(`\n${TAG} Starting human-in-the-loop run for "${reqs.systemName}"...`);
    console.log(`${TAG} You will be asked to approve each phase before continuing.\n`);

    let session: RunSession;
    try {
        session = await runHumanInTheLoop({
            systemName: reqs.systemName,
            requirementsText,
            requirementsDocPath: reqs.requirementsDocPath,
            mode: 'human',
            repoTarget,
        });
    } catch (err: any) {
        console.error(`\n${TAG} ${LogColors.RED}Failed to start run: ${err.message}${LogColors.RESET}`);
        await mainMenu();
        return;
    }

    // HITL loop — keep resuming until finalize
    let running = true;
    while (running) {
        const state = await session.getState();
        printPhaseStatus(state);

        if (state.phase === 'finalize') {
            console.log(`${color256(46)}═══ Run Complete ═══${LogColors.RESET}`);
            if (state.workspacePath) console.log(`${TAG} Generated project: ${state.workspacePath}`);
            if (state.outputPath) console.log(`${TAG} Run logs: ${state.outputPath}`);
            running = false;
            break;
        }

        // Display the latest agent's mission report
        printArtifactReport(state);

        // Show latest transcript messages
        const recentTranscript = state.transcript.slice(-5);
        if (recentTranscript.length > 0) {
            console.log(`${color256(255)}Recent activity:${LogColors.RESET}`);
            for (const t of recentTranscript) {
                console.log(`  ${t.timestamp} ${t.agentId}: ${t.message}`);
            }
            console.log('');
        }

        console.log(`${TAG} Phase "${state.phase}" completed. Review the report above.`);
        console.log('  a) Approve and continue');
        console.log('  d) Deny (stop the run)');
        console.log('  e) Enhance (provide feedback and re-run this phase)');
        console.log('  r) Show all mission reports');
        console.log('  s) Show full state details');

        const decision = await ask('Your decision [a/d/e/r/s]: ');

        switch (decision.toLowerCase()) {
            case 'a': {
                console.log(`${TAG} Approved. Continuing...\n`);
                try {
                    await session.resume('approve');
                } catch (err: any) {
                    console.error(`${TAG} ${LogColors.RED}Error: ${err.message}${LogColors.RESET}`);
                }
                break;
            }
            case 'd': {
                const denyFeedback = await ask('Reason for denial (optional): ');
                console.log(`${TAG} Run denied by user. Cancelling...\n`);
                try {
                    await session.resume('deny', denyFeedback || undefined);
                } catch (err: any) {
                    console.error(`${TAG} ${LogColors.RED}Error: ${err.message}${LogColors.RESET}`);
                }
                running = false;
                break;
            }
            case 'e': {
                const feedback = await ask('Enhancement feedback: ');
                if (!feedback) {
                    console.log(`${TAG} Feedback is required for enhance.`);
                    break;
                }
                console.log(`${TAG} Enhancing with feedback...\n`);
                try {
                    await session.resume('enhance', feedback);
                } catch (err: any) {
                    console.error(`${TAG} ${LogColors.RED}Error: ${err.message}${LogColors.RESET}`);
                }
                break;
            }
            case 'r': {
                printAllArtifacts(state);
                break;
            }
            case 's': {
                console.log(JSON.stringify(redactState(state), null, 2));
                break;
            }
            default:
                console.log(`${TAG} Invalid choice.`);
        }
    }

    await mainMenu();
}

// ─── Maintain existing project ──────────────────────────────────────────────

async function startMaintainRun() {
    const projectPath = await ask('Existing project path: ');
    const resolvedPath = path.resolve(projectPath);
    if (!fs.existsSync(resolvedPath)) {
        console.log(`${TAG} ${LogColors.RED}Directory not found: ${resolvedPath}${LogColors.RESET}`);
        await mainMenu();
        return;
    }

    // Infer system name from directory, allow override
    const dirName = path.basename(resolvedPath);
    const systemName = await ask(`System name [${dirName}]: `) || dirName;

    // Get the specs/demands
    console.log(`${TAG} How to provide the specs/demands?`);
    console.log('  1) File path (.md, .txt, .pdf, .docx)');
    console.log('  2) Type/paste text inline');

    const method = await ask('Choose [1-2]: ');
    let requirementsText: string | undefined;
    let requirementsDocPath: string | undefined;

    if (method === '1') {
        const filePath = await ask('File path: ');
        const resolved = path.resolve(filePath);
        if (!fs.existsSync(resolved)) {
            console.log(`${TAG} ${LogColors.RED}File not found: ${resolved}${LogColors.RESET}`);
            await mainMenu();
            return;
        }
        requirementsDocPath = resolved;
        console.log(`${TAG} Parsing specs file...`);
        requirementsText = await parseRequirementsFile(resolved);
    } else {
        console.log(`${TAG} Enter specs/demands (type END on a new line to finish):`);
        const lines: string[] = [];
        while (true) {
            const line = await ask('');
            if (line === 'END') break;
            lines.push(line);
        }
        requirementsText = lines.join('\n');
    }

    // Choose run mode
    console.log(`${TAG} Run mode?`);
    console.log('  1) Autonomous (no stops)');
    console.log('  2) Human-in-the-loop (approve each phase)');
    const modeChoice = await ask('Choose [1-2]: ');
    const mode = modeChoice === '1' ? 'autonomous' : 'human';

    console.log(`\n${TAG} Starting ${mode} maintain run for "${systemName}" at ${resolvedPath}...\n`);

    const runOpts = {
        systemName,
        requirementsText,
        requirementsDocPath,
        mode: mode as 'autonomous' | 'human',
        runType: 'maintain' as const,
        existingProjectPath: resolvedPath,
    };

    try {
        if (mode === 'autonomous') {
            const finalState = await runAutonomous(runOpts);
            console.log(`\n${color256(46)}═══ Maintain Run Complete ═══${LogColors.RESET}`);
            printPhaseStatus(finalState);
            if (finalState.workspacePath) console.log(`${TAG} Project: ${finalState.workspacePath}`);
            if (finalState.outputPath) console.log(`${TAG} Run logs: ${finalState.outputPath}`);
        } else {
            const session = await runHumanInTheLoop(runOpts);

            let running = true;
            while (running) {
                const state = await session.getState();
                printPhaseStatus(state);

                if (state.phase === 'finalize') {
                    console.log(`${color256(46)}═══ Maintain Run Complete ═══${LogColors.RESET}`);
                    if (state.workspacePath) console.log(`${TAG} Project: ${state.workspacePath}`);
                    if (state.outputPath) console.log(`${TAG} Run logs: ${state.outputPath}`);
                    running = false;
                    break;
                }

                // Display the latest agent's mission report
                printArtifactReport(state);

                const recentTranscript = state.transcript.slice(-5);
                if (recentTranscript.length > 0) {
                    console.log(`${color256(255)}Recent activity:${LogColors.RESET}`);
                    for (const t of recentTranscript) {
                        console.log(`  ${t.timestamp} ${t.agentId}: ${t.message}`);
                    }
                    console.log('');
                }

                console.log(`${TAG} Phase "${state.phase}" completed. Review the report above.`);
                console.log('  a) Approve and continue');
                console.log('  d) Deny (stop the run)');
                console.log('  e) Enhance (provide feedback and re-run this phase)');
                console.log('  r) Show all mission reports');
                console.log('  s) Show full state details');

                const decision = await ask('Your decision [a/d/e/r/s]: ');

                switch (decision.toLowerCase()) {
                    case 'a': {
                        console.log(`${TAG} Approved. Continuing...\n`);
                        try { await session.resume('approve'); } catch (err: any) {
                            console.error(`${TAG} ${LogColors.RED}Error: ${err.message}${LogColors.RESET}`);
                        }
                        break;
                    }
                    case 'd': {
                        const denyFeedback = await ask('Reason for denial (optional): ');
                        console.log(`${TAG} Run denied by user. Cancelling...\n`);
                        try { await session.resume('deny', denyFeedback || undefined); } catch (err: any) {
                            console.error(`${TAG} ${LogColors.RED}Error: ${err.message}${LogColors.RESET}`);
                        }
                        running = false;
                        break;
                    }
                    case 'e': {
                        const feedback = await ask('Enhancement feedback: ');
                        if (!feedback) {
                            console.log(`${TAG} Feedback is required for enhance.`);
                            break;
                        }
                        console.log(`${TAG} Enhancing with feedback...\n`);
                        try { await session.resume('enhance', feedback); } catch (err: any) {
                            console.error(`${TAG} ${LogColors.RED}Error: ${err.message}${LogColors.RESET}`);
                        }
                        break;
                    }
                    case 'r': {
                        printAllArtifacts(state);
                        break;
                    }
                    case 's': {
                        console.log(JSON.stringify(redactState(state), null, 2));
                        break;
                    }
                    default:
                        console.log(`${TAG} Invalid choice.`);
                }
            }
        }
    } catch (err: any) {
        console.error(`\n${TAG} ${LogColors.RED}Maintain run failed: ${err.message}${LogColors.RESET}`);
        console.error(err.stack);
        const reportPath = tokenTracker.getOutputPath();
        if (reportPath) {
            console.error(`${TAG} Partial token report: ${reportPath}/token-usage-report.html`);
        }
    }

    await mainMenu();
}

// ─── Continue a stopped run ─────────────────────────────────────────────────

async function startContinueRun() {
    // ── 1. List stopped runs ─────────────────────────────────────────────
    const stoppedRuns = listStoppedRuns();

    if (stoppedRuns.length === 0) {
        console.log(`${TAG} No stopped runs found in outputs/.`);
        console.log(`${TAG} Only runs with status crashed, failed, or cancelled can be continued.`);
        await mainMenu();
        return;
    }

    console.log(`\n${color256(255)}Stopped runs available for continuation:${LogColors.RESET}`);
    console.log(`${color256(255)}${'─'.repeat(60)}${LogColors.RESET}`);

    for (let i = 0; i < stoppedRuns.length; i++) {
        const run = stoppedRuns[i];
        const statusColor = run.status === 'crashed' ? LogColors.RED
            : run.status === 'failed' ? LogColors.RED
            : color256(214); // orange for cancelled
        console.log(
            `  ${color256(255)}${i + 1})${LogColors.RESET} ` +
            `${color256(46)}${run.systemName}${LogColors.RESET}  ` +
            `${statusColor}[${run.status}]${LogColors.RESET}  ` +
            `phase: ${run.finalPhase}`,
        );
        console.log(
            `     ${color256(240)}${run.timestamp}${LogColors.RESET}  ` +
            `${color256(240)}${run.workspacePath || '(no workspace)'}${LogColors.RESET}`,
        );
    }
    console.log(`${color256(255)}${'─'.repeat(60)}${LogColors.RESET}`);
    console.log(`  ${color256(255)}p)${LogColors.RESET} Enter output path manually`);
    console.log(`  ${color256(255)}b)${LogColors.RESET} Back to main menu`);
    console.log('');

    const selection = await ask(`Select a run [1-${stoppedRuns.length}/p/b]: `);

    if (selection.toLowerCase() === 'b') {
        await mainMenu();
        return;
    }

    // ── 2. Resolve the output path ───────────────────────────────────────
    let outputPath: string;

    if (selection.toLowerCase() === 'p') {
        const manualPath = await ask('Output directory path: ');
        if (!manualPath) {
            console.log(`${TAG} Path is required.`);
            await mainMenu();
            return;
        }
        outputPath = path.resolve(manualPath);
        if (!fs.existsSync(outputPath)) {
            console.log(`${TAG} ${LogColors.RED}Directory not found: ${outputPath}${LogColors.RESET}`);
            await mainMenu();
            return;
        }
    } else {
        const idx = parseInt(selection, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= stoppedRuns.length) {
            console.log(`${TAG} Invalid selection.`);
            await mainMenu();
            return;
        }
        outputPath = stoppedRuns[idx].outputPath;
    }

    // ── 3. Collect and reconstruct — show summary ────────────────────────
    console.log(`\n${TAG} Analyzing run at: ${outputPath}...\n`);

    let collected;
    try {
        collected = collectRunState(outputPath);
    } catch (err: any) {
        console.error(`${TAG} ${LogColors.RED}Failed to collect run state: ${err.message}${LogColors.RESET}`);
        await mainMenu();
        return;
    }

    if (!collected.workspaceExists) {
        console.error(
            `${TAG} ${LogColors.RED}Cannot continue — workspace directory not found: ` +
            `"${collected.workspacePath || '(unknown)'}".${LogColors.RESET}`,
        );
        console.error(`${TAG} The generated project must exist on disk to continue.`);
        await mainMenu();
        return;
    }

    let reconstruction;
    try {
        reconstruction = reconstructState(collected);
    } catch (err: any) {
        console.error(`${TAG} ${LogColors.RED}Failed to reconstruct state: ${err.message}${LogColors.RESET}`);
        await mainMenu();
        return;
    }

    const { resumePhase, confidence, warnings } = reconstruction;

    // Display reconstruction summary
    console.log(`${color256(255)}─── Reconstruction Summary ───${LogColors.RESET}`);
    console.log(`  System:        ${reconstruction.state.input?.systemName ?? '(unknown)'}`);
    console.log(`  Run type:      ${reconstruction.state.input?.runType ?? 'greenfield'}`);
    console.log(`  Resume from:   ${color256(46)}${resumePhase}${LogColors.RESET}`);

    const confidenceColor = confidence === 'full' ? color256(46)   // green
        : confidence === 'partial' ? color256(214)                  // orange
        : LogColors.RED;                                            // red
    console.log(`  Confidence:    ${confidenceColor}${confidence}${LogColors.RESET}`);

    console.log(`  Workspace:     ${collected.workspacePath}`);
    console.log(`  Output:        ${collected.outputPath}`);

    // Show phase completion status
    const completedPhases: string[] = [];
    const pendingPhases: string[] = [];
    const phaseOrder = [
        'intake', 'codebase-analyzer', 'architect', 'product-manager',
        'dba', 'team-leader', 'development', 'qa', 'bugfix-triage',
        'devops', 'e2e', 'acceptance-gate', 'finalize',
    ];
    const resumeIdx = phaseOrder.indexOf(resumePhase);
    for (let i = 0; i < phaseOrder.length; i++) {
        if (i < resumeIdx) {
            completedPhases.push(phaseOrder[i]);
        } else {
            pendingPhases.push(phaseOrder[i]);
        }
    }
    console.log(`  Completed:     ${completedPhases.length > 0 ? completedPhases.join(', ') : '(none)'}`);
    console.log(`  Remaining:     ${pendingPhases.join(', ')}`);

    if (warnings.length > 0) {
        console.log(`\n${color256(214)}  Warnings:${LogColors.RESET}`);
        for (const w of warnings) {
            console.log(`    ${color256(214)}! ${w}${LogColors.RESET}`);
        }
    }
    console.log('');

    // ── 4. Choose run mode ───────────────────────────────────────────────
    console.log(`${TAG} Run mode for continuation?`);
    console.log('  1) Autonomous (no stops)');
    console.log('  2) Human-in-the-loop (approve each phase)');
    console.log('  b) Back to main menu');
    const modeChoice = await ask('Choose [1/2/b]: ');

    if (modeChoice.toLowerCase() === 'b') {
        await mainMenu();
        return;
    }

    const mode: 'autonomous' | 'human' = modeChoice === '1' ? 'autonomous' : 'human';

    // ── 5. Confirm and continue ──────────────────────────────────────────
    console.log(`\n${TAG} Ready to continue run:`);
    console.log(`  System:  ${reconstruction.state.input?.systemName ?? '(unknown)'}`);
    console.log(`  Resume:  ${resumePhase}`);
    console.log(`  Mode:    ${mode}`);
    const confirm = await ask('Continue? [Y/n]: ');
    if (confirm.toLowerCase() === 'n') {
        console.log(`${TAG} Cancelled.`);
        await mainMenu();
        return;
    }

    console.log(`\n${TAG} Continuing run from "${resumePhase}" in ${mode} mode...\n`);

    try {
        const result = await continueRun({
            outputPath,
            mode,
        });

        // In autonomous mode, result is the final ProjectState
        if ('phase' in result && 'input' in result) {
            const finalState = result as ProjectStateType;
            console.log(`\n${color256(46)}═══ Continued Run Complete ═══${LogColors.RESET}`);
            printPhaseStatus(finalState);
            if (finalState.workspacePath) console.log(`${TAG} Project: ${finalState.workspacePath}`);
            if (finalState.outputPath) console.log(`${TAG} Run logs: ${finalState.outputPath}`);
        } else {
            // HITL mode — result is a RunSession
            const session = result as RunSession;
            let running = true;
            while (running) {
                const state = await session.getState();
                printPhaseStatus(state);

                if (state.phase === 'finalize') {
                    console.log(`${color256(46)}═══ Continued Run Complete ═══${LogColors.RESET}`);
                    if (state.workspacePath) console.log(`${TAG} Project: ${state.workspacePath}`);
                    if (state.outputPath) console.log(`${TAG} Run logs: ${state.outputPath}`);
                    running = false;
                    break;
                }

                printArtifactReport(state);

                const recentTranscript = state.transcript.slice(-5);
                if (recentTranscript.length > 0) {
                    console.log(`${color256(255)}Recent activity:${LogColors.RESET}`);
                    for (const t of recentTranscript) {
                        console.log(`  ${t.timestamp} ${t.agentId}: ${t.message}`);
                    }
                    console.log('');
                }

                console.log(`${TAG} Phase "${state.phase}" completed. Review the report above.`);
                console.log('  a) Approve and continue');
                console.log('  d) Deny (stop the run)');
                console.log('  e) Enhance (provide feedback and re-run this phase)');
                console.log('  r) Show all mission reports');
                console.log('  s) Show full state details');

                const decision = await ask('Your decision [a/d/e/r/s]: ');

                switch (decision.toLowerCase()) {
                    case 'a': {
                        console.log(`${TAG} Approved. Continuing...\n`);
                        try { await session.resume('approve'); } catch (err: any) {
                            console.error(`${TAG} ${LogColors.RED}Error: ${err.message}${LogColors.RESET}`);
                        }
                        break;
                    }
                    case 'd': {
                        const denyFeedback = await ask('Reason for denial (optional): ');
                        console.log(`${TAG} Run denied by user. Cancelling...\n`);
                        try { await session.resume('deny', denyFeedback || undefined); } catch (err: any) {
                            console.error(`${TAG} ${LogColors.RED}Error: ${err.message}${LogColors.RESET}`);
                        }
                        running = false;
                        break;
                    }
                    case 'e': {
                        const feedback = await ask('Enhancement feedback: ');
                        if (!feedback) {
                            console.log(`${TAG} Feedback is required for enhance.`);
                            break;
                        }
                        console.log(`${TAG} Enhancing with feedback...\n`);
                        try { await session.resume('enhance', feedback); } catch (err: any) {
                            console.error(`${TAG} ${LogColors.RED}Error: ${err.message}${LogColors.RESET}`);
                        }
                        break;
                    }
                    case 'r': {
                        printAllArtifacts(state);
                        break;
                    }
                    case 's': {
                        console.log(JSON.stringify(redactState(state), null, 2));
                        break;
                    }
                    default:
                        console.log(`${TAG} Invalid choice.`);
                }
            }
        }
    } catch (err: any) {
        console.error(`\n${TAG} ${LogColors.RED}Continue run failed: ${err.message}${LogColors.RESET}`);
        if (err.stack) console.error(err.stack);
        const reportPath = tokenTracker.getOutputPath();
        if (reportPath) {
            console.error(`${TAG} Partial token report: ${reportPath}/token-usage-report.html`);
        }
    }

    await mainMenu();
}

// ─── Entry point ────────────────────────────────────────────────────────────

mainMenu().catch((err) => {
    console.error(`${TAG} Fatal error: ${err.message}`);
    process.exit(1);
});
