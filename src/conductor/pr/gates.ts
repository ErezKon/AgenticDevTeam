/**
 * Gate running with repair — quality gates + integrity checks in PR context.
 *
 * Extracted from pr-workflow.ts (Sub-Plan 25-08). Plan 30-02: the
 * post-development gate + repair loop moved here from the orchestrator, and
 * every gate run in the PR workflow goes through `runBranchGates` so each
 * report that can reach `decideMerge()` has the same shape.
 */
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../../utils/logger';
import { emitRunEvent } from '../../utils/event-bus';
import { getEffectiveLimits } from '../../utils/run-budget';
import { runQualityGates, detectStackRoots } from '../quality-gates';
import type { GateReport, GateResult } from '../quality-gates';
import { summariseTestOutput } from '../../utils/terminal-output';
import { runProductVerification } from '../product-verify';
import {
    captureConfigBaseline, detectTampering,
    detectTrivialTests, findTestFiles, findProductSourceFiles, trivialTestSeverity,
    type ConfigBaseline, type TamperFinding,
} from '../gate-integrity';
import { buildDevAgent } from '../../agents/developers/dev-agent.builder';
import { getDevAgent } from '../../agents/developers/registry';
import { resolveConventionFiles } from '../../utils/coding-conventions';
import {
    GATE_INTEGRITY_MODE, GATE_INTEGRITY_DELETE_TRIVIAL_TESTS,
    PR_TEST_TIMEOUT_MS, PR_TEST_INSTALL_TIMEOUT_MS,
} from '../../config';
import { invokeDevAgent, getModelForRank } from './agent-invoke';
import { commitAndPush, commitWorktree, headSha } from './commit';
import { buildRepairMessage } from './dev-prompts';
import { msg } from './transcript';
import type { FileChange, GitContext, PullRequest, TechDecision, TranscriptMessage } from '../../agents/_shared/base-schemas';
import type { TokenCallRecord } from '../../utils/token-tracker';
import type { DevRank } from '../../agents/_shared/persona';

const log = getLogger('[PR-Workflow]', 135);

// ─── Branch gate evidence ───────────────────────────────────────────────────

/**
 * A branch's gate evidence: quality gates (install/typecheck/build/lint/test),
 * then product verification (artifacts + import resolution) on the tree they
 * just built. Before Plan 30-02 product verification ran before the build, and
 * only the first gate run carried it — a repair or re-run silently dropped the
 * product-verification blocker from the merge decision.
 */
export async function runBranchGates(worktreeWorkspace: string): Promise<GateReport> {
    const report = await runQualityGates(worktreeWorkspace, { timeoutMs: PR_TEST_TIMEOUT_MS, installTimeoutMs: PR_TEST_INSTALL_TIMEOUT_MS });
    try {
        const pv = await runProductVerification(worktreeWorkspace, detectStackRoots(worktreeWorkspace), 'artifacts+resolve');
        log.info(`Product verification: artifacts=${pv.artifacts.filter(a => a.passed).length}/${pv.artifacts.length}, unresolved refs=${pv.resolveIssues.length}`);
        report.productVerify = pv;
    } catch (pvErr: any) { log.warn(`Product verification error (non-fatal): ${pvErr.message}`); }
    return report;
}

/** Char budget of a failing step's output on a PR record and in a repair prompt. */
const FAILED_GATE_SUMMARY_CHARS = 1500;

/**
 * The first failing step among `results`, for the PR record (Plan 30-05): the
 * step, its command and its output, summarised (Plan 30-07: gate results hold
 * rendered output already). Bug-fix triage shows it to the Team Leader, who used
 * to see no more than a step name.
 */
export function failedGateOf(results: GateResult[] | undefined): PullRequest['failedGate'] {
    const failed = results?.find(r => !r.passed && !r.skipped && r.mode !== 'absent');
    if (!failed) return undefined;
    return {
        step: failed.relDir && failed.relDir !== '.' ? `${failed.step} (${failed.relDir})` : failed.step,
        command: failed.command,
        summary: summariseTestOutput(failed.output ?? '', FAILED_GATE_SUMMARY_CHARS),
    };
}

export interface GateRepairInput {
    worktreeWorkspace: string;
    branchName: string;
    baseBranch: string;
    projectSlug: string;
    primaryStoryId: string;
    /** Dev agent that repairs failing gates (the branch's first assignment). */
    primaryDevId: string;
    contextPrompt: string;
    apiKey: string;
    gitContext?: GitContext | null;
    techStack?: TechDecision[];
    isMaintainMode?: boolean;
    respawnCtx: { worktreeDir: string; baseRef: string };
    reconcileClaims: (who: string, claimed?: FileChange[]) => FileChange[];
}

export interface GateRepairResult {
    gateReport: GateReport | null;
    /** HEAD the gate report was produced at ('' when no gate run completed). */
    gateSha: string;
    fileChanges: FileChange[];
    transcript: TranscriptMessage[];
    tokenUsage: TokenCallRecord[];
}

/**
 * Post-development quality gates, with up to `prTestRepairAttempts` dev-agent
 * repair passes while they fail. Returns the latest report and the HEAD it was
 * produced at, so the merge decision can tell whether it is still fresh.
 */
export async function runGatesWithRepair(input: GateRepairInput): Promise<GateRepairResult> {
    const { worktreeWorkspace, branchName, projectSlug, primaryStoryId, gitContext } = input;
    const result: GateRepairResult = { gateReport: null, gateSha: '', fileChanges: [], transcript: [], tokenUsage: [] };
    let report: GateReport;
    try {
        report = await runBranchGates(worktreeWorkspace);
        result.gateReport = report;
        result.gateSha = headSha(worktreeWorkspace);
    } catch (testErr: any) {
        log.warn(`Post-dev quality gate error: ${testErr.message}`);
        return result;
    }
    if (report.passed) {
        log.info(`Quality gates passed on branch ${branchName}`);
        result.transcript.push(msg('conductor', `Quality gates passed on branch ${branchName}`));
        return result;
    }
    if (report.results.length === 0) return result;

    const failingSteps = report.results.filter(r => !r.passed && !r.skipped).map(r => `${r.step}: ${r.output.slice(0, 200)}`);
    log.warn(`Quality gates FAILED on branch ${branchName} — giving dev agent a repair attempt`);
    result.transcript.push(msg('conductor', `WARNING: Quality gates failed on branch ${branchName}:\n${failingSteps.join('\n').slice(0, 500)}`));

    const { prTestRepairAttempts } = getEffectiveLimits();
    for (let repair = 0; repair < prTestRepairAttempts; repair++) {
        try {
            const primaryEntry = getDevAgent(input.primaryDevId);
            if (!primaryEntry) break;

            const repairConventions = resolveConventionFiles(primaryEntry.languages, input.techStack);
            const buildRepairAgentFn = () => buildDevAgent(input.apiKey, primaryEntry, worktreeWorkspace, gitContext, input.baseBranch, repairConventions, input.isMaintainMode);
            const repairAgent = buildRepairAgentFn();

            // Plan 30-07: the failures and verdict — the last 1,000 chars of a Karma run were progress lines
            const failDetails = report.results
                .filter(r => !r.passed && !r.skipped)
                .map(r => `### ${r.step} (\`${r.command}\`)\n\`\`\`\n${summariseTestOutput(r.output, FAILED_GATE_SUMMARY_CHARS)}\n\`\`\``)
                .join('\n\n');

            const repairMsg = buildRepairMessage(input.contextPrompt, projectSlug, branchName, failDetails);
            log.info(`Quality gate repair attempt ${repair + 1}/${prTestRepairAttempts}`);
            const repairModel = getModelForRank(primaryEntry.rank as DevRank);
            const { output: repairOutput, tokenUsage: repairTokenUsage } = await invokeDevAgent(
                repairAgent, repairMsg, `repair-${primaryEntry.id}-${branchName}`, primaryEntry.id, repairModel, buildRepairAgentFn, input.respawnCtx);
            if (repairTokenUsage) result.tokenUsage.push(repairTokenUsage);
            result.fileChanges.push(...input.reconcileClaims(`${primaryEntry.id} (gate repair)`, repairOutput.fileChanges));
        } catch (repairErr: any) { log.warn(`Quality gate repair attempt failed (non-fatal): ${repairErr.message}`); }
        finally {
            commitWorktree(worktreeWorkspace, branchName, projectSlug, primaryStoryId, 'fix',
                `repair failing quality gates (attempt ${repair + 1})`, gitContext);
        }

        try {
            report = await runBranchGates(worktreeWorkspace);
            result.gateReport = report;
            result.gateSha = headSha(worktreeWorkspace);
            if (report.passed) {
                log.info(`Quality gates passed after repair attempt ${repair + 1}`);
                result.transcript.push(msg('conductor', `Quality gates passed after repair attempt ${repair + 1}`));
                break;
            }
        } catch (gateErr: any) { log.warn(`Quality gate re-run failed: ${gateErr.message}`); }
    }
    return result;
}

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

    // Re-commit reverted state (Plan 30-04: safe staging, verified push)
    commitAndPush(worktreeWorkspace, branchName, `[${projectSlug}]-integrity: revert tampering — ${criticals.length} critical finding(s)`, gitContext);

    // Re-run quality gates on reverted tree
    try {
        gateReport = await runBranchGates(worktreeWorkspace);
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
            commitAndPush(worktreeWorkspace, branchName, `[${projectSlug}]-integrity: restore config (revert broke gates)`, gitContext);

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
            gateReport = await runBranchGates(worktreeWorkspace);
        }
    } catch (rerunErr: any) {
        log.warn(`Quality gate re-run after revert failed: ${rerunErr.message}`);
    }

    return gateReport;
}
