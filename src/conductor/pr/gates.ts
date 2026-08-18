/**
 * Gate running with repair — quality gates + integrity checks in PR context.
 *
 * Extracted from pr-workflow.ts (Sub-Plan 26-08).
 */
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../../utils/logger';
import { gitExec, gitPush } from '../../utils/git-exec';
import { emitRunEvent } from '../../utils/event-bus';
import { runQualityGates, detectStackRoots } from '../quality-gates';
import type { GateReport } from '../quality-gates';
import {
    captureConfigBaseline, detectTampering,
    detectTrivialTests, findTestFiles, findProductSourceFiles, trivialTestSeverity,
    type ConfigBaseline, type TamperFinding,
} from '../gate-integrity';
import {
    GATE_INTEGRITY_MODE, GATE_INTEGRITY_DELETE_TRIVIAL_TESTS,
    PR_TEST_TIMEOUT_MS, PR_TEST_INSTALL_TIMEOUT_MS,
} from '../../config';

const log = getLogger('[PR-Workflow]', 135);

/**
 * Archive a test file the integrity gate is about to delete (Plan 22, F3).
 *
 * Deleting source on the strength of a heuristic must never be unrecoverable.
 * Never throws — a failed archive must not abort the gate.
 */
export function archiveDeletedTest(
    outputPath: string | undefined, branchName: string, relPath: string, absPath: string,
): void {
    if (!outputPath) return;
    try {
        const dir = path.join(outputPath, 'deleted-tests', branchName.replace(/[^a-zA-Z0-9._-]+/g, '-'));
        const dest = path.join(dir, relPath.replace(/[\\/]/g, '__'));
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(absPath, dest);
        log.info(`  Archived before deletion: ${dest}`);
    } catch (err: any) {
        log.warn(`Could not archive ${relPath} before deletion: ${err.message}`);
    }
}

/**
 * Capture a per-branch config baseline for tamper detection.
 */
export function captureBaseline(
    worktreeWorkspace: string,
): ConfigBaseline | null {
    if (GATE_INTEGRITY_MODE === 'off') return null;
    try {
        const worktreeRoots = detectStackRoots(worktreeWorkspace);
        const baseline = captureConfigBaseline(worktreeWorkspace, worktreeRoots);
        log.info(`Config baseline captured: ${Object.keys(baseline.scripts).length} package.json(s), ${baseline.testFiles.length} test files`);
        return baseline;
    } catch (blErr: any) {
        log.warn(`Config baseline capture failed (non-fatal): ${blErr.message}`);
        return null;
    }
}

export interface IntegrityGateResult {
    integrityFindings: TamperFinding[];
    gateReport: GateReport | null;
}

/**
 * Run the integrity gate: tamper detection + trivial test detection.
 * Optionally reverts protected files and re-runs quality gates.
 */
export async function runIntegrityGate(
    worktreeWorkspace: string,
    branchBaseline: ConfigBaseline,
    branchName: string,
    projectSlug: string,
    gateReport: GateReport | null,
    outputPath: string | undefined,
    gitContext?: any,
): Promise<IntegrityGateResult> {
    const integrityFindings: TamperFinding[] = [];

    try {
        const currentRoots = detectStackRoots(worktreeWorkspace);
        const currentBaseline = captureConfigBaseline(worktreeWorkspace, currentRoots);
        const tampering = detectTampering(branchBaseline, currentBaseline, worktreeWorkspace);
        integrityFindings.push(...tampering);

        // Also run trivial test detection
        const testFiles = findTestFiles(worktreeWorkspace);
        const productFiles = findProductSourceFiles(worktreeWorkspace);
        const trivialFindings = detectTrivialTests(worktreeWorkspace, testFiles, productFiles);
        for (const tf of trivialFindings) {
            // Check if this is a new test file (not in baseline)
            if (!branchBaseline.testFiles.includes(tf.file)) {
                integrityFindings.push({
                    kind: 'trivial-test-added',
                    // Plan 22 F3: heuristic import-graph reasons are `major`
                    // (report only); unambiguous gate-gaming stays `critical`.
                    severity: trivialTestSeverity(tf.reason),
                    file: tf.file,
                    detail: `${tf.reason}: ${tf.detail}`,
                });
            }
        }

        if (integrityFindings.length > 0) {
            const criticals = integrityFindings.filter(f => f.severity === 'critical');
            log.error(`Gate integrity: ${integrityFindings.length} finding(s) (${criticals.length} critical)`);
            for (const f of integrityFindings) {
                log.error(`  [${f.severity.toUpperCase()}] ${f.kind}: ${f.file} — ${f.detail}`);
            }

            if (criticals.length > 0 && GATE_INTEGRITY_MODE === 'enforce') {
                gateReport = await revertAndRerunGates(
                    worktreeWorkspace, branchBaseline, branchName, projectSlug,
                    integrityFindings, gateReport, outputPath, gitContext,
                );
            }
        }
    } catch (intErr: any) {
        log.warn(`Gate integrity check failed (non-fatal): ${intErr.message}`);
    }

    return { integrityFindings, gateReport };
}

/**
 * Revert protected files to baseline and re-run quality gates.
 */
async function revertAndRerunGates(
    worktreeWorkspace: string,
    branchBaseline: ConfigBaseline,
    branchName: string,
    projectSlug: string,
    integrityFindings: TamperFinding[],
    gateReport: GateReport | null,
    outputPath: string | undefined,
    gitContext?: any,
): Promise<GateReport | null> {
    const criticals = integrityFindings.filter(f => f.severity === 'critical');

    // Plan 24 B3: remember pre-revert gate status so we can
    // detect revert-induced failures and undo them.
    const gatesGreenBeforeRevert = gateReport?.passed ?? false;

    // Snapshot the current (pre-revert) content of files we are
    // about to overwrite, so we can restore if the revert breaks gates.
    const preRevertBodies: Record<string, string> = {};
    for (const [relPath, body] of Object.entries(branchBaseline.protectedBodies)) {
        const absPath = path.join(worktreeWorkspace, relPath);
        if (fs.existsSync(absPath)) {
            const currentBody = fs.readFileSync(absPath, 'utf-8');
            if (currentBody !== body) {
                preRevertBodies[relPath] = currentBody;
            }
        }
    }

    // Revert protected files to baseline content
    log.warn('Reverting protected files to baseline content...');
    for (const [relPath, body] of Object.entries(branchBaseline.protectedBodies)) {
        const absPath = path.join(worktreeWorkspace, relPath);
        if (fs.existsSync(absPath)) {
            const currentBody = fs.readFileSync(absPath, 'utf-8');
            if (currentBody !== body) {
                fs.writeFileSync(absPath, body, 'utf-8');
                log.info(`  Reverted: ${relPath}`);
            }
        }
    }

    // Delete fabricated test files (in current but not baseline).
    //
    // Plan 22 F3: only CRITICAL trivial-test findings are eligible,
    // deletion is behind GATE_INTEGRITY_DELETE_TRIVIAL_TESTS
    // (default false), and every deleted body is archived to
    // outputs/<run>/deleted-tests/ so a false positive is
    // recoverable. Previously every `trivial-test-added` finding —
    // including the purely heuristic `no-product-import` — was
    // unlinked and the deletion pushed.
    const deletableTests = integrityFindings.filter(
        f => f.kind === 'trivial-test-added' && f.severity === 'critical',
    );
    const reportOnlyTests = integrityFindings.filter(
        f => f.kind === 'trivial-test-added' && f.severity !== 'critical',
    );
    if (reportOnlyTests.length > 0) {
        log.warn(
            `  ${reportOnlyTests.length} trivial-test finding(s) are heuristic — reported, not deleted: `
            + reportOnlyTests.map(f => f.file).join(', '),
        );
    }
    if (deletableTests.length > 0 && !GATE_INTEGRITY_DELETE_TRIVIAL_TESTS) {
        log.warn(
            `  ${deletableTests.length} fabricated test(s) left in place `
            + '(GATE_INTEGRITY_DELETE_TRIVIAL_TESTS=false) — reported to reviewers instead',
        );
    }
    if (deletableTests.length > 0 && GATE_INTEGRITY_DELETE_TRIVIAL_TESTS) {
        for (const f of deletableTests) {
            const absPath = path.join(worktreeWorkspace, f.file);
            if (!fs.existsSync(absPath)) continue;
            archiveDeletedTest(outputPath, branchName, f.file, absPath);
            fs.unlinkSync(absPath);
            log.info(`  Deleted fabricated test: ${f.file}`);
        }
    }

    // Re-commit reverted state
    gitExec(worktreeWorkspace, 'add .');
    const revertStatus = gitExec(worktreeWorkspace, 'status --short');
    if (revertStatus && !revertStatus.includes('nothing to commit')) {
        gitExec(worktreeWorkspace, `commit -m "[${projectSlug}]-integrity: revert tampering — ${criticals.length} critical finding(s)"`);
        gitPush(worktreeWorkspace, branchName, gitContext);
    }

    // Re-run quality gates on reverted tree
    try {
        gateReport = await runQualityGates(worktreeWorkspace, {
            timeoutMs: PR_TEST_TIMEOUT_MS,
            installTimeoutMs: PR_TEST_INSTALL_TIMEOUT_MS,
        });
        log.info(`Quality gates after revert: ${gateReport?.passed ? 'passed' : 'failed'}`);

        // Plan 24 B3: if gates were green before the revert and red
        // after, the revert itself broke them. Restore the reverted
        // content, record a config-change finding at major, and emit
        // an event. Never let revert-induced failures reach decideMerge.
        if (gatesGreenBeforeRevert && gateReport && !gateReport.passed) {
            log.warn('Revert broke quality gates — restoring pre-revert content and flagging as config-change');
            for (const [relPath, body] of Object.entries(preRevertBodies)) {
                const absPath = path.join(worktreeWorkspace, relPath);
                fs.writeFileSync(absPath, body, 'utf-8');
                log.info(`  Restored: ${relPath}`);
            }

            // Re-commit restored state
            gitExec(worktreeWorkspace, 'add .');
            const restoreStatus = gitExec(worktreeWorkspace, 'status --short');
            if (restoreStatus && !restoreStatus.includes('nothing to commit')) {
                gitExec(worktreeWorkspace, `commit -m "[${projectSlug}]-integrity: restore config (revert broke gates)"`);
                gitPush(worktreeWorkspace, branchName, gitContext);
            }

            // Record as a major (informational) finding, not a gate blocker
            integrityFindings.push({
                kind: 'config-change-by-feature-branch',
                severity: 'major',
                file: Object.keys(preRevertBodies).join(', '),
                detail: 'config-change-by-feature-branch: feature branch config changes are required for gates to pass',
            });

            emitRunEvent('pr:config-change-flagged', {
                branch: branchName,
                files: Object.keys(preRevertBodies),
            });

            // Restore the pre-revert gate report so the revert-induced
            // failure does not reach decideMerge as a blocker.
            gateReport = await runQualityGates(worktreeWorkspace, {
                timeoutMs: PR_TEST_TIMEOUT_MS,
                installTimeoutMs: PR_TEST_INSTALL_TIMEOUT_MS,
            });
        }
    } catch (rerunErr: any) {
        log.warn(`Quality gate re-run after revert failed: ${rerunErr.message}`);
    }

    return gateReport;
}
