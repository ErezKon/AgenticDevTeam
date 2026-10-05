/**
 * Bug-fix triage node — detects unrecoverable state, selects the actionable
 * bugs of the latest evaluation (Plan 30-05, triage-selection.ts) and
 * re-invokes the team leader to create bugfix assignments.
 */
import { getLogger } from '../../utils/logger';
import { getAccessToken } from '../../utils/oauth-auth.util';
import { projectSlugFromBranch } from '../../utils/branch-naming';
import { createTeamLeaderAgent } from '../../agents/team-leader/team-leader.agent';
import { TeamLeaderOutputSchema } from '../../agents/team-leader/schemas/tl-output.schema';
import { buildBugfixInstructions } from '../../agents/team-leader/team-leader.prompt';
import { abandonedBranches, namespaceBugfixAssignments, resolveBugIds, sanitizeAssignmentStoryIds } from '../assignment-policy';
import { detectUnrecoverable } from '../unrecoverable';
import { selectTriageBugs, summariseDropped } from '../triage-selection';
import { buildWorkspaceSnapshot } from '../workspace-snapshot';
import { getEffectiveLimits } from '../../utils/run-budget';
import {
    CONTEXT_MAX_CHARS, RUN_FAIL_POLICY, SNAPSHOT_MAX_FILES, SNAPSHOT_MAX_CHARS,
} from '../../config';
import {
    summariseArchitecture, summariseBugs, summariseUndeliveredBranches, buildContext, recordContextChars,
} from '../context-builder';
import type { ContextSection } from '../context-builder';
import { emitRunEvent } from '../../utils/event-bus';
import { writePeriodicSnapshot } from '../../utils/run-snapshot';
import { shouldSkipOnContinue, checkBudgetStop, msg } from './_guards';
import { invokeAgent } from './_invoke';
import type { ProjectStateType } from '../state';
import type { TriageRound } from '../gate-types';
import type { PhaseName } from '../../agents/_shared/base-schemas';

const bugLog = getLogger('[BugTriage]', 196);

/** The real file list of the system branch, so the Team Leader does not guess paths. */
function sourceFiles(workspacePath: string): string {
    try {
        return buildWorkspaceSnapshot(workspacePath, { maxFiles: SNAPSHOT_MAX_FILES, maxChars: SNAPSHOT_MAX_CHARS });
    } catch (err: any) {
        bugLog.warn(`Workspace snapshot failed (non-fatal): ${err.message}`);
        return '(workspace snapshot unavailable)';
    }
}

export async function bugfixTriageNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    // Continue-run idempotency: skip only if resume target is past bugfix-triage
    if (shouldSkipOnContinue(state, 'bugfix-triage', bugLog)) {
        return { phase: 'bugfix-triage' as PhaseName };
    }
    emitRunEvent('phase:start', { phase: 'bugfix-triage' });
    writePeriodicSnapshot(state.outputPath, state, 'bugfix-triage');
    const budgetStop = checkBudgetStop(state, 'bugfix-triage' as PhaseName, bugLog);
    if (budgetStop) return budgetStop;
    const iteration = state.iteration.bugfix + 1;
    bugLog.info(`Bug-fix triage iteration ${iteration}/${getEffectiveLimits().maxBugfixIterations}`);

    // ── Runaway guard (Plan 21, E3; Plan 30-05)
    const triageHalt = detectUnrecoverable(state);
    if (triageHalt.unrecoverable) {
        bugLog.error(`Run is unrecoverable: ${triageHalt.reason}`);
        const update: Partial<ProjectStateType> = {
            unrecoverable: { flag: true, reason: triageHalt.reason ?? 'unrecoverable' },
            phase: 'bugfix-triage' as PhaseName,
            transcript: [msg('conductor', 'bugfix-triage', `Unrecoverable: ${triageHalt.reason}`)],
        };
        if (RUN_FAIL_POLICY === 'halt') {
            bugLog.warn('RUN_FAIL_POLICY=halt — skipping bug-fix triage, no new assignments will be dispatched');
            emitRunEvent('phase:end', { phase: 'bugfix-triage', nextPhase: 'devops', skipped: true });
            return { ...update, iteration: { bugfix: iteration } };
        }
        // Non-halt policies: flag it so downstream gates report truthfully, but continue.
        bugLog.warn(`RUN_FAIL_POLICY=${RUN_FAIL_POLICY} — continuing triage despite unrecoverable state`);
    }

    // ── Plan 30-05: only the real, actionable bugs of the latest evaluation
    const { bugs: openBugs, dropped } = selectTriageBugs(state);
    const round: TriageRound = { iteration, bugCursor: (state.bugs ?? []).length, bugIds: openBugs.map(b => b.id) };
    const droppedNote = dropped.length > 0 ? ` (${dropped.length} not actionable: ${summariseDropped(dropped)})` : '';
    if (dropped.length > 0) {
        bugLog.info(`Triage: ${openBugs.length} actionable bug(s); left out ${dropped.length}: ${summariseDropped(dropped)}`);
        bugLog.debug(`Left out: ${dropped.map(d => d.id).join(', ')}`);
    }

    if (openBugs.length === 0) {
        bugLog.info('No actionable critical/major bugs — no bug-fix assignments this round');
        emitRunEvent('phase:end', { phase: 'bugfix-triage', nextPhase: 'devops', skipped: true });
        return {
            phase: 'bugfix-triage' as PhaseName,
            iteration: { bugfix: iteration },
            triageRounds: [round],
            transcript: [msg('team-leader', 'bugfix-triage', `No critical bugs to fix${droppedNote}`)],
        };
    }

    bugLog.info(`Re-assigning ${openBugs.length} bugs to developers...`);
    const apiKey = await getAccessToken();
    const agent = createTeamLeaderAgent(apiKey);
    const abandoned = new Set(abandonedBranches(state.pullRequests ?? []).map(b => b.branchName));

    let userMsg: string;
    {
        const sections: ContextSection[] = [
            { title: `Bug-fix Triage — Iteration ${iteration}`, body: '', priority: 1 },
            { title: 'Open Bugs', body: summariseBugs(openBugs), priority: 1 },
            { title: 'Undelivered Branches', body: summariseUndeliveredBranches(state.pullRequests ?? [], abandoned), priority: 1 },
            { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 2 },
            { title: 'Source Files (system branch)', body: sourceFiles(state.workspacePath), priority: 3 },
            { title: 'Existing Assignments', body: state.assignments.map(a => `- ${a.id} [${a.devAgentId}]: ${a.description?.slice(0, 100)}`).join('\n'), priority: 3 },
            // Without this the LLM copies the synthetic BUG id into `storyId` (Plan 21, E5).
            { title: 'Valid Story IDs', body: (state.userStories ?? []).map(s => `- ${s.id}: ${s.iWant}`).join('\n') || '(no user stories)', priority: 1 },
            { title: 'Instructions', body: buildBugfixInstructions(projectSlugFromBranch(state.systemBranch ?? '')), priority: 1 },
        ];
        userMsg = buildContext(sections, CONTEXT_MAX_CHARS);
    }
    bugLog.info(`Context [bugfix-triage]: ${userMsg.length} chars`);
    recordContextChars('bugfix-triage', userMsg.length);

    const { output, tokenUsage } = await invokeAgent(agent, userMsg, `tl-bugfix-${iteration}`, 'team-leader', 'bugfix-triage', { schema: TeamLeaderOutputSchema });

    // ── Namespace bugfix assignment ids to avoid collisions
    const rawAssignments = output.assignments ?? [];
    const namespaced = namespaceBugfixAssignments(rawAssignments, iteration);

    // ── Story-id integrity (Plan 21, E5)
    const { assignments: sanitized, dropped: droppedStoryIds } = sanitizeAssignmentStoryIds(
        namespaced, state.userStories ?? [], state.bugs ?? [],
    );
    if (droppedStoryIds.length > 0) {
        bugLog.warn(`Dropped ${droppedStoryIds.length} unresolvable storyId reference(s) from bugfix assignments: ${droppedStoryIds.join(', ')}`);
    }
    // Plan 30-05: the bugs each fix works on — attempts are counted when such an assignment ran
    const bugfixAssignments = sanitized.map(a => ({ ...a, bugIds: resolveBugIds(a, round.bugIds) }));
    bugLog.info(`Created ${bugfixAssignments.length} bugfix assignments (iteration ${iteration})`);

    emitRunEvent('phase:end', { phase: 'bugfix-triage', nextPhase: 'development', bugs: round.bugIds.length, assignments: bugfixAssignments.length });
    return {
        assignments: bugfixAssignments,
        // Which bugs are being attempted (not fixed — QA verifies the fix later)
        attemptedBugIds: round.bugIds,
        iteration: { bugfix: iteration },
        triageRounds: [round],
        phase: 'bugfix-triage' as PhaseName,
        transcript: [msg('team-leader', 'bugfix-triage', `Iteration ${iteration}: reassigned ${bugfixAssignments.length} bug fixes for ${round.bugIds.length} bugs${droppedNote}`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}
