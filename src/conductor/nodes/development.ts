/**
 * Development node — fan-out dispatch of developer agents.
 */
import { getLogger } from '../../utils/logger';
import { getAccessToken } from '../../utils/oauth-auth.util';
import { dispatchDevelopers } from '../../agents/developers/dispatcher';
import { getDevAgent } from '../../agents/developers/registry';
import { deployConventionsToWorkspace, resolveConventionFiles } from '../../utils/coding-conventions';
import { ensureProjectGitignore, managedGitignoreEntries } from '../../utils/workspace';
import { gitExec, findGitRoot } from '../../utils/git-exec';
import { retryFailedPRCreation } from '../pr-workflow';
import { syncWorkspaceToBranch, looksSourceless } from '../workspace-sync';
import {
    abandonedBranches, bugAttemptsAfterRound, dispatchRoundOf, newlyExecutedIds, selectPendingAssignments, settleCompletion,
} from '../assignment-policy';
import { runAssemblyGate } from '../assembly-gate';
import { makeGateBug } from '../bug-factory';
import {
    CONTEXT_MAX_CHARS, DEV_CONTEXT_FILE_CHANGES_LIMIT, ASSIGNMENT_MAX_ATTEMPTS,
} from '../../config';
import {
    summariseArchitecture, summariseTechStack, summariseDbDesign,
    summariseRepoContract, summariseFileChanges, summariseCodebaseAnalysis,
    buildContext, recordContextChars,
} from '../context-builder';
import type { ContextSection } from '../context-builder';
import { emitRunEvent } from '../../utils/event-bus';
import { withTokenAttribution } from '../../utils/token-tracker';
import { writePeriodicSnapshot } from '../../utils/run-snapshot';
import { projectSlugFromBranch } from '../../utils/branch-naming';
import { phaseNode, msg } from './_guards';
import type { PhaseName, TranscriptMessage, Bug } from '../../agents/_shared/base-schemas';
import type { PullRequest } from '../../agents/_shared/schemas/pr.schema';

const devLog = getLogger('[Development]', 226);

export const developmentNode = phaseNode('development', devLog, { haltCheck: true }, async (state, { rerunUpdate }) => {
    devLog.info(`Starting development with ${state.assignments.length} assignments...`);

    // ── Retry any PR-creation-failed branches from a previous run
    const failedPRs = (state.pullRequests ?? []).filter((pr: PullRequest) => pr.status === 'pr-creation-failed');
    if (failedPRs.length > 0) {
        devLog.info(`Found ${failedPRs.length} branch(es) with pr-creation-failed — retrying PR creation`);
        const retriedPRs: PullRequest[] = [];
        const retriedTranscript: TranscriptMessage[] = [];
        for (const failedPR of failedPRs) {
            try {
                const updatedPR = await retryFailedPRCreation(failedPR, state.systemBranch, state.gitContext);
                retriedPRs.push(updatedPR);
                retriedTranscript.push(msg('conductor', 'development', `PR creation retry succeeded for ${failedPR.branchName}: PR #${updatedPR.prNumber}`));
            } catch (retryErr: any) {
                devLog.error(`PR creation retry failed again for ${failedPR.branchName}: ${retryErr.message}`);
                retriedTranscript.push(msg('conductor', 'development', `PR creation retry failed again for ${failedPR.branchName}: ${retryErr.message} — stopping run`));
                return {
                    ...rerunUpdate,
                    phase: 'development' as PhaseName,
                    pullRequests: [failedPR],
                    transcript: retriedTranscript,
                };
            }
        }
        if (retriedPRs.length > 0) {
            devLog.info(`Successfully retried ${retriedPRs.length} PR(s) — updating state`);
            // pullRequests is append-only: returning the other records again duplicated every one of
            // them, and Plan 30-05 reads that history (abandoned branches, first executions).
            return {
                ...rerunUpdate,
                phase: 'development' as PhaseName,
                pullRequests: retriedPRs,
                transcript: retriedTranscript,
            };
        }
    }

    // ── Filter to only pending assignments (fixes A2)
    const pending = selectPendingAssignments(state.assignments, state.completedAssignmentIds);
    devLog.info(`Development: ${pending.length} pending of ${state.assignments.length} total assignments (${state.completedAssignmentIds.length} already complete)`);
    if (pending.length === 0) {
        devLog.warn('No pending assignments — skipping development phase');
        emitRunEvent('phase:end', { phase: 'development', nextPhase: 'qa', skipped: true });
        return { phase: 'development' as PhaseName, transcript: [msg('conductor', 'development', 'No pending assignments')] };
    }

    const apiKey = await getAccessToken();

    const devLanguages = [...new Set(
        pending.flatMap(a => getDevAgent(a.devAgentId)?.languages ?? []),
    )];
    const devConventionFiles = resolveConventionFiles(devLanguages, state.techStack);
    deployConventionsToWorkspace(state.workspacePath, devConventionFiles);

    ensureProjectGitignore(state.workspacePath, managedGitignoreEntries(state.techStack));

    let contextPrompt: string;
    {
        const sections: ContextSection[] = [
            { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 2 },
            { title: 'Tech Stack', body: summariseTechStack(state.techStack), priority: 1 },
            { title: 'Repo Contract', body: summariseRepoContract(state.repoContract), priority: 1 },
            { title: 'DB Design', body: summariseDbDesign(state.dbDesign, 'compact'), priority: 3 },
            { title: 'Files Already Written', body: summariseFileChanges(state.fileChanges, DEV_CONTEXT_FILE_CHANGES_LIMIT), priority: 3 },
        ];
        if (state.codebaseAnalysis) {
            sections.unshift({ title: 'Existing Codebase Analysis', body: summariseCodebaseAnalysis(state.codebaseAnalysis), priority: 3 });
            sections.push({ title: 'NOTE', body: 'This is MAINTAIN mode. Modify existing files where appropriate rather than creating new ones.', priority: 1 });
        }
        contextPrompt = buildContext(sections, CONTEXT_MAX_CHARS);
    }
    devLog.info(`Context [development]: ${contextPrompt.length} chars`);
    recordContextChars('development', contextPrompt.length);
    const projectSlug = projectSlugFromBranch(state.systemBranch);

    const isMaintainMode = state.codebaseAnalysis != null;
    // Plan 30-05: a branch unmerged in consecutive rounds is not dispatched again
    const abandoned = abandonedBranches(state.pullRequests ?? []);
    if (abandoned.length > 0) {
        devLog.warn(`${abandoned.length} abandoned branch(es) will not be dispatched: ${abandoned.map(b => `${b.branchName} (${b.rounds} unmerged rounds, last ${b.lastStatus})`).join(', ')}`);
    }
    // Plan 30-06: the round's invocations are attributed to it in the token report
    const result = await withTokenAttribution({ round: (state.dispatchRounds?.length ?? 0) + 1 }, () => dispatchDevelopers(
        apiKey, pending, state.workspacePath, contextPrompt, state.systemBranch, projectSlug, state.gitContext, state.techStack,
        state.completedAssignmentIds, state.userStories, isMaintainMode, state.outputPath, state.tasks, state.repoContract,
        abandoned.map(b => b.branchName),
    ));

    devLog.info(`Development complete: ${result.fileChanges.length} file changes, ${result.pullRequests.length} PRs`);
    // Plan 30-05 step 5: an attempt on a bug counts only when an assignment working on it ran
    const executedIds = newlyExecutedIds(state.pullRequests ?? [], result.pullRequests);
    const bugAttempts = bugAttemptsAfterRound(state.assignments, executedIds, state.bugAttempts ?? {});
    // Plan 30-02 step 8 (Sub-Plan 06 §6): merged work without completion evidence goes back to
    // pending with an INCOMPLETE-* bug, until it has merged ASSIGNMENT_MAX_ATTEMPTS times.
    const settled = settleCompletion(
        result.completedAssignmentIds, result.completionEvidence,
        [...(state.pullRequests ?? []), ...result.pullRequests], ASSIGNMENT_MAX_ATTEMPTS,
    );
    if (settled.reopened.length > 0) {
        devLog.warn(`${settled.reopened.length} merged assignment(s) lack completion evidence — kept pending with an INCOMPLETE bug: ${settled.reopened.map(e => e.assignmentId).join(', ')}`);
    }
    if (result.deferredAssignmentIds.length > 0) {
        devLog.warn(`${result.deferredAssignmentIds.length} assignment(s) deferred to the next round (branch budget): ${result.deferredAssignmentIds.join(', ')}`);
    }
    if (result.salvageBranches.length > 0) {
        devLog.warn(`${result.salvageBranches.length} branch(es) salvaged (not merged): ${result.salvageBranches.join(', ')}`);
    }

    // Plan 25: provider failure — stop gracefully so continue-run can pick up
    if (result.stopReason?.startsWith('provider-')) {
        const reason = result.stopReason;
        devLog.error(`Provider failure (${reason}) — routing to finalize for graceful shutdown`);
        writePeriodicSnapshot(state.outputPath, state, 'development');
        return {
            ...rerunUpdate,
            fileChanges: result.fileChanges,
            artifacts: result.artifacts,
            pullRequests: result.pullRequests,
            completedAssignmentIds: settled.completed,
            completionEvidence: result.completionEvidence,
            salvageBranches: result.salvageBranches,
            bugs: settled.bugs,
            bugAttempts,
            transcript: [
                ...result.transcript,
                msg('conductor', 'development', `Run stopped: provider failure (${reason})`),
            ],
            phase: 'development' as PhaseName,
            tokenUsage: result.tokenUsage ?? [],
            cancelled: true,
            _stopReason: reason,
        };
    }

    // ── Sync workspace to merged system branch (fixes A1)
    let gitRoot: string;
    try {
        gitRoot = findGitRoot(state.workspacePath);
    } catch {
        gitRoot = state.workspacePath;
    }
    const syncResult = await syncWorkspaceToBranch(gitRoot, state.systemBranch, state.gitContext);
    devLog.info(`Workspace synced to origin/${state.systemBranch}: ${syncResult.details}`);

    const lsFiles = gitExec(gitRoot, 'ls-files');
    if (!lsFiles.startsWith('Error:')) {
        const files = lsFiles.split('\n').filter(Boolean);
        if (looksSourceless(files)) {
            devLog.error(`WARNING: Workspace appears sourceless after sync — QA and DevOps will see no application code. Files: ${files.length}`);
            result.transcript.push(msg('conductor', 'development', `ERROR: Workspace is sourceless after development sync — PR merges may not have landed`));
        }
    }

    // Plan 24, F1–F3: Assembly gate
    // Plan 25-04 §7: Hoist assemblyBugs so they reach the return object.
    const assemblyBugs: Bug[] = [];
    if (result.pullRequests.some(pr => pr.status === 'merged')) {
        const assemblyResult = runAssemblyGate(state.workspacePath);
        if (!assemblyResult.passed) {
            devLog.warn(`Assembly gate failed: ${assemblyResult.summary}`);
            result.transcript.push(msg('conductor', 'development', `Assembly gate: ${assemblyResult.summary}`));
            emitRunEvent('gate:result', { gate: 'assembly', passed: false, summary: assemblyResult.summary });

            if (assemblyResult.missingAssets.length > 0) {
                assemblyBugs.push(makeGateBug(
                    'ASSEMBLY-MISSING-ASSETS',
                    `${assemblyResult.missingAssets.length} referenced asset(s) missing from disk`,
                    'major',
                    'assembly-gate',
                    `Check referenced assets in HTML: ${assemblyResult.missingAssets.slice(0, 5).join(', ')}`,
                    'All referenced assets should exist on disk',
                    `${assemblyResult.missingAssets.length} assets not found`,
                    'public/ or src/assets/ directory',
                ));
            }
            if (assemblyResult.unwiredModules.length > 0) {
                assemblyBugs.push(makeGateBug(
                    'ASSEMBLY-UNWIRED',
                    'Entry point does not import product modules',
                    'critical',
                    'assembly-gate',
                    'Check the entry point (main.ts/index.ts) for module imports',
                    'Entry point should import all declared modules',
                    `Entry point has no imports: ${assemblyResult.unwiredModules.join(', ')}`,
                    'src/main.ts or src/index.ts',
                ));
            }
            result.transcript.push(msg('conductor', 'development', `Assembly gate synthesized ${assemblyBugs.length} bug(s)`));
        } else {
            devLog.info(`Assembly gate passed: ${assemblyResult.summary}`);
            emitRunEvent('gate:result', { gate: 'assembly', passed: true, summary: assemblyResult.summary });
        }
    }

    // Plan 30-05: merged PRs are the progress signal; unmerged file changes are not
    const round = dispatchRoundOf(state.pullRequests ?? [], {
        pullRequests: result.pullRequests, fileChanges: result.fileChanges.length,
        deferredAssignmentIds: result.deferredAssignmentIds, completed: settled.completed.length,
    });
    const mergedPrCount = round.merged;
    if (round.merged === 0) {
        const text = `Dispatch round merged no PR: ${result.pullRequests.length} PR record(s), ${round.fileChanges} unmerged file change(s), `
            + `${round.executed} assignment(s) run for the first time, ${round.deferred} deferred`;
        // Deferred work resumes next round — in flight, not a stall
        if (round.deferred > 0) devLog.warn(text);
        else devLog.error(text);
    }

    emitRunEvent('phase:end', { phase: 'development', nextPhase: 'qa', fileChanges: result.fileChanges.length, prs: mergedPrCount });
    return {
        ...rerunUpdate,
        dispatchRounds: [round],
        bugAttempts,
        fileChanges: result.fileChanges,
        artifacts: result.artifacts,
        pullRequests: result.pullRequests,
        completedAssignmentIds: settled.completed,
        completionEvidence: result.completionEvidence,
        salvageBranches: result.salvageBranches,
        // Plan 25-04 §7: surface assembly-gate bugs so bugfix triage picks them up
        // (Plan 30-02: plus INCOMPLETE-* bugs for merged work without completion evidence)
        bugs: [...assemblyBugs, ...settled.bugs],
        transcript: [
            ...result.transcript,
            msg('conductor', 'development', `Development phase complete: ${result.fileChanges.length} files changed, ${mergedPrCount} of ${result.pullRequests.length} PR record(s) merged. Sync: ${syncResult.details}`),
        ],
        phase: 'development' as PhaseName,
        tokenUsage: result.tokenUsage ?? [],
    };
});
