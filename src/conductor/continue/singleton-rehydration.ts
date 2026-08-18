/**
 * Singleton Rehydration — reinitialise all global singletons that
 * `intakeNode` normally sets up, since intake is skipped on continuation.
 *
 * Sub-Plan 05 of the "Continue Run" feature (Plan 23).
 *
 * When a stopped run is continued, the pipeline bypasses intakeNode (its
 * idempotency guard fires because `outputPath` and `workspacePath` are
 * already set). This module replicates the singleton setup that intakeNode
 * performs so that downstream nodes have a fully initialised run
 * infrastructure: logging, ledger, response log, token tracking, budget
 * enforcement, and the local bare-repo path for offline GitHub mode.
 *
 * Called by `continueRun()` in `run.ts` after state reconstruction and
 * before graph invocation.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger, setRunLogPath } from '../../utils/logger';
import { tokenTracker } from '../../utils/token-tracker';
import { refreshTokenReport } from '../../utils/token-report';
import { initLedger } from '../../utils/run-ledger';
import { initResponseLog } from '../../utils/response-log';
import { startRunBudget } from '../../utils/run-budget';
import { GITHUB_MODE } from '../../utils/github-local';
import { setLocalBareRepoPath } from '../pr-workflow';
import { gitExec } from '../../utils/git-exec';
import type { CollectedRunState } from './state-collector';

const log = getLogger('[SingletonRehydration]', 177);

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Reinitialise all global singletons for a continued run.
 *
 * Must be called after state reconstruction and before graph invocation.
 * The `state` parameter is the reconstructed state object (not yet injected
 * into the graph).
 *
 * This mirrors the singleton setup performed by `intakeNode` (lines ~612–780
 * of `nodes.ts`) with adjustments for continuation semantics:
 *
 * - The ledger is opened in append mode (existing entries are preserved)
 * - The response log continues from the next sequence number
 * - Token usage records from the previous run are restored so budget
 *   calculations account for already-spent tokens
 * - A continuation marker is appended to the ledger
 */
export function rehydrateSingletons(
    collected: CollectedRunState,
    state: Record<string, any>,
): void {
    const outputPath = collected.outputPath;

    // ── 1. Run log ───────────────────────────────────────────────────────
    // Point the logger at the (existing) run.log file. New entries are
    // appended, so the log from the original run is preserved.
    const runLogPath = path.join(outputPath, 'run.log');
    setRunLogPath(runLogPath);
    log.info(`Run log: ${runLogPath}`);

    // ── 2. Ledger (append to existing) ───────────────────────────────────
    // initLedger() just sets the output path for appendLedger(). Since the
    // ledger is an append-only JSONL file, all previous entries survive.
    initLedger(outputPath);
    log.info('Ledger initialised (append mode)');

    // ── 3. Response log (continue sequence numbering) ────────────────────
    // initResponseLog() resets the internal sequence counter to 0 and
    // creates the full-responses/ directory if needed. Because files are
    // named <seq>-<agentId>-<phase>.json, the new run's files will start
    // from 0 but that's fine — the index.jsonl is also append-only.
    initResponseLog(outputPath);
    log.info('Response log initialised');

    // ── 4. Token tracker ─────────────────────────────────────────────────
    // Restore previous token usage so budget calculations account for
    // already-spent tokens. We do NOT call tokenTracker.reset() — we want
    // the cumulative totals from both the original and continued run.
    const systemName = state.input?.systemName ?? '';
    tokenTracker.enablePersistence(outputPath, systemName);
    tokenTracker.setRefreshCallback(() => refreshTokenReport());

    // Restore previously recorded token usage records from the original
    // run. These are loaded into the tracker's ledger so getRunSummary()
    // and budget enforcement see the full history.
    if (collected.tokenUsageRecords.length > 0) {
        log.info(`Restoring ${collected.tokenUsageRecords.length} previous token usage records`);
        for (const record of collected.tokenUsageRecords) {
            tokenTracker.recordFromPreviousRun(record);
        }
    }

    // Write the initial report skeleton so the HTML file exists on disk
    refreshTokenReport();

    // ── 5. Run budget ────────────────────────────────────────────────────
    // startRunBudget() resets the wall-clock origin to now. Since the
    // token tracker already contains the previous run's usage, budget
    // calculations (token limit, cost limit) automatically account for
    // the carry-forward spend. Only the wall-clock budget resets — this
    // is intentional: the continued run gets a fresh wall-clock window.
    startRunBudget();
    log.info('Run budget started (with carry-forward from previous run)');

    // ── 6. Local bare repo path (for local GitHub mode) ──────────────────
    // In local GitHub mode, the bare repo backing the `origin` remote is
    // typically at `<outputPath>/origin.git`. If the workspace was
    // initialised with a local bare repo, we need to point the PR
    // workflow at it so branch/PR operations work.
    rehydrateLocalBareRepo(collected, outputPath);
}

// ─── Internals ──────────────────────────────────────────────────────────────

/**
 * Detect and set the local bare repo path for offline GitHub mode.
 *
 * Search order:
 * 1. `<outputPath>/origin.git` — the default location created by intakeNode
 * 2. The workspace's git remote `origin` URL — may point to a bare repo
 */
function rehydrateLocalBareRepo(
    collected: CollectedRunState,
    outputPath: string,
): void {
    if (GITHUB_MODE !== 'local') return;

    // Check for origin.git in the output directory
    const bareRepoPath = path.join(outputPath, 'origin.git');
    if (fs.existsSync(bareRepoPath)) {
        setLocalBareRepoPath(bareRepoPath);
        log.info(`Local bare repo: ${bareRepoPath}`);
        return;
    }

    // Try to detect from the workspace's git remote
    if (collected.workspacePath && collected.workspaceIsGitRepo) {
        try {
            const remoteUrl = gitExec(collected.workspacePath, 'remote get-url origin');
            if (remoteUrl && !remoteUrl.startsWith('Error:') && remoteUrl.includes('origin.git')) {
                setLocalBareRepoPath(remoteUrl.trim());
                log.info(`Local bare repo (from remote): ${remoteUrl.trim()}`);
            }
        } catch { /* best-effort */ }
    }
}
