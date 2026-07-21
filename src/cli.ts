#!/usr/bin/env npx tsx
/**
 * Interactive CLI for the AgenticDevTeam multi-agent system.
 *
 * Supports:
 * - Autonomous mode: full pipeline runs unattended.
 * - Human-in-the-loop mode: pauses after each phase for approve/deny/enhance.
 * - Requirements from file path or inline text.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { LogColors, color256 } from './utils/log-colors.util';
import { AGENT_REGISTRY } from './agents/registry';
import { runAutonomous, runHumanInTheLoop, type RunSession } from './conductor/run';
import { parseRequirementsFile } from './tools/requirements/parse-requirements';
import type { ProjectStateType } from './conductor/state';

const TAG = `${color256(46)}[CLI]${LogColors.RESET}`;

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
    console.log('  3) Show agent roster');
    console.log('  4) Exit');
    console.log('');

    const choice = await ask('Choose [1-4]: ');

    switch (choice) {
        case '1':
            await startAutonomousRun();
            break;
        case '2':
            await startHitlRun();
            break;
        case '3':
            printAgentRoster();
            await mainMenu();
            break;
        case '4':
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

// ─── Autonomous run ─────────────────────────────────────────────────────────

async function startAutonomousRun() {
    const reqs = await getRequirements();

    let requirementsText = reqs.requirementsText;
    if (reqs.requirementsDocPath && !requirementsText) {
        console.log(`${TAG} Parsing requirements file...`);
        requirementsText = await parseRequirementsFile(reqs.requirementsDocPath);
    }

    console.log(`\n${TAG} Starting autonomous run for "${reqs.systemName}"...`);
    console.log(`${TAG} The full pipeline will run without interruption.\n`);

    try {
        const finalState = await runAutonomous({
            systemName: reqs.systemName,
            requirementsText,
            requirementsDocPath: reqs.requirementsDocPath,
            mode: 'autonomous',
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

    console.log(`\n${TAG} Starting human-in-the-loop run for "${reqs.systemName}"...`);
    console.log(`${TAG} You will be asked to approve each phase before continuing.\n`);

    let session: RunSession;
    try {
        session = await runHumanInTheLoop({
            systemName: reqs.systemName,
            requirementsText,
            requirementsDocPath: reqs.requirementsDocPath,
            mode: 'human',
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

        // Show latest transcript messages
        const recentTranscript = state.transcript.slice(-5);
        if (recentTranscript.length > 0) {
            console.log(`${color256(255)}Recent activity:${LogColors.RESET}`);
            for (const t of recentTranscript) {
                console.log(`  ${t.timestamp} ${t.agentId}: ${t.message}`);
            }
            console.log('');
        }

        console.log(`${TAG} Phase "${state.phase}" is ready for review.`);
        console.log('  a) Approve and continue');
        console.log('  d) Deny (stop the run)');
        console.log('  e) Enhance (provide feedback and re-run this phase)');
        console.log('  s) Show full state details');

        const decision = await ask('Your decision [a/d/e/s]: ');

        switch (decision.toLowerCase()) {
            case 'a': {
                console.log(`${TAG} Approved. Continuing...\n`);
                try {
                    await session.resume(true);
                } catch (err: any) {
                    console.error(`${TAG} ${LogColors.RED}Error: ${err.message}${LogColors.RESET}`);
                }
                break;
            }
            case 'd': {
                console.log(`${TAG} Run denied by user.`);
                running = false;
                break;
            }
            case 'e': {
                const feedback = await ask('Enhancement feedback: ');
                console.log(`${TAG} Enhancing with feedback...\n`);
                try {
                    await session.resume(true, feedback);
                } catch (err: any) {
                    console.error(`${TAG} ${LogColors.RED}Error: ${err.message}${LogColors.RESET}`);
                }
                break;
            }
            case 's': {
                console.log(JSON.stringify(state, null, 2));
                break;
            }
            default:
                console.log(`${TAG} Invalid choice.`);
        }
    }

    await mainMenu();
}

// ─── Entry point ────────────────────────────────────────────────────────────

mainMenu().catch((err) => {
    console.error(`${TAG} Fatal error: ${err.message}`);
    process.exit(1);
});
