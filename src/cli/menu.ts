/**
 * CLI menu — main menu and run-start functions.
 *
 * Extracted from cli.ts in Sub-Plan 26-09 to reduce the 871-line monolith.
 */
import * as fs from 'fs';
import * as path from 'path';
import { LogColors, color256 } from '../utils/log-colors.util';
import { runAutonomous, runHumanInTheLoop, continueRun, type RunSession } from '../conductor/run';
import { listStoppedRuns, collectRunState, reconstructState } from '../conductor/continue';
import { parseRequirementsFile } from '../tools/requirements/parse-requirements';
import { tokenTracker } from '../utils/token-tracker';
import type { ProjectStateType } from '../conductor/state';
import { printHeader, printAgentRoster, printPhaseStatus } from './printers';
import { ask, getRequirements, getRepoTarget, closeReadline } from './prompts';
import { driveHitlSession } from './hitl-loop';

const TAG = `${color256(46)}[CLI]${LogColors.RESET}`;

// ─── Main menu ──────────────────────────────────────────────────────────────

export async function mainMenu(): Promise<void> {
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
            closeReadline();
            process.exit(0);
        default:
            console.log(`${TAG} Invalid choice. Try again.`);
            await mainMenu();
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

    await driveHitlSession(session, 'Run');
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
            await driveHitlSession(session, 'Maintain Run');
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
            await driveHitlSession(session, 'Continued Run');
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
