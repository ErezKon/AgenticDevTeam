/**
 * HITL decision loop — drives a RunSession through its phases, prompting the
 * user for approve/deny/enhance at each interrupt.
 *
 * Extracted from cli.ts in Sub-Plan 25-09 to eliminate the 3-copy HITL loop
 * that was duplicated across startHitlRun, startMaintainRun, and startContinueRun.
 */
import { LogColors, color256 } from '../utils/log-colors.util';
import type { RunSession } from '../conductor/run';
import { printPhaseStatus, printArtifactReport, printAllArtifacts, printStateJson } from './printers';
import { ask } from './prompts';

const TAG = `${color256(46)}[CLI]${LogColors.RESET}`;

/**
 * Drive a HITL session to completion — loops until finalize or user deny.
 *
 * @param session   The RunSession returned by runHumanInTheLoop() or continueRun()
 * @param label     Display label for completion banner (e.g. 'Run', 'Maintain Run', 'Continued Run')
 */
export async function driveHitlSession(
    session: RunSession,
    label: string = 'Run',
): Promise<void> {
    let running = true;
    while (running) {
        const state = await session.getState();
        printPhaseStatus(state);

        if (state.phase === 'finalize') {
            console.log(`${color256(46)}═══ ${label} Complete ═══${LogColors.RESET}`);
            if (state.workspacePath) console.log(`${TAG} Project: ${state.workspacePath}`);
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
                printStateJson(state);
                break;
            }
            default:
                console.log(`${TAG} Invalid choice.`);
        }
    }
}
