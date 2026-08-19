/**
 * Bug-fix triage node — deduplicates bugs, detects unrecoverable state,
 * and re-invokes the team leader to create bugfix assignments.
 */
import { getLogger } from '../../utils/logger';
import { getAccessToken } from '../../utils/oauth-auth.util';
import { createTeamLeaderAgent } from '../../agents/team-leader/team-leader.agent';
import { TeamLeaderOutputSchema } from '../../agents/team-leader/schemas/tl-output.schema';
import { dedupeBugs, namespaceBugfixAssignments, sanitizeAssignmentStoryIds } from '../assignment-policy';
import { detectUnrecoverable } from '../acceptance-gate';
import { getEffectiveLimits } from '../../utils/run-budget';
import {
    CONTEXT_MAX_CHARS, RUN_FAIL_POLICY,
} from '../../config';
import {
    summariseArchitecture, buildContext, recordContextChars,
} from '../context-builder';
import type { ContextSection } from '../context-builder';
import { emitRunEvent } from '../../utils/event-bus';
import { writePeriodicSnapshot } from '../../utils/run-snapshot';
import { shouldSkipOnContinue, checkBudgetStop, msg } from './_guards';
import { invokeAgent } from './_invoke';
import type { ProjectStateType } from '../state';
import type { PhaseName } from '../../agents/_shared/base-schemas';

const bugLog = getLogger('[BugTriage]', 196);

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

    // ── Runaway guard (Plan 21, E3)
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

    // ── Deduplicate and filter already-fixed bugs
    const fixedSet = new Set(state.fixedBugIds ?? []);
    const openBugs = dedupeBugs(state.bugs)
        .filter(b => !fixedSet.has(b.id))
        .filter(b => b.severity === 'critical' || b.severity === 'major');

    if (openBugs.length === 0) {
        bugLog.info('No critical/major bugs — skipping to DevOps');
        emitRunEvent('phase:end', { phase: 'bugfix-triage', nextPhase: 'devops', skipped: true });
        return {
            phase: 'bugfix-triage' as PhaseName,
            iteration: { bugfix: iteration },
            transcript: [msg('team-leader', 'bugfix-triage', 'No critical bugs to fix')],
        };
    }

    bugLog.info(`Re-assigning ${openBugs.length} bugs to developers...`);
    const apiKey = await getAccessToken();
    const agent = createTeamLeaderAgent(apiKey);

    let userMsg: string;
    {
        const sections: ContextSection[] = [
            { title: `Bug-fix Triage — Iteration ${iteration}`, body: '', priority: 1 },
            { title: 'Open Bugs', body: JSON.stringify(openBugs, null, 2), priority: 1 },
            { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 2 },
            { title: 'Existing Assignments', body: state.assignments.map(a => `- ${a.id} [${a.devAgentId}]: ${a.description?.slice(0, 100)}`).join('\n'), priority: 3 },
            // Without this the LLM copies the synthetic BUG id into `storyId` (Plan 21, E5).
            { title: 'Valid Story IDs', body: (state.userStories ?? []).map(s => `- ${s.id}: ${s.iWant}`).join('\n') || '(no user stories)', priority: 1 },
            { title: 'Instructions', body: `Please create NEW assignments to fix these bugs. Assign each bug to the most appropriate developer.

Every assignment's "storyId" MUST be one of the ids listed under "Valid Story IDs" above. NEVER put a bug id (e.g. "QA-no-tests", "BUG-003") in "storyId" — bug ids belong in the description.

IMPORTANT: When triaging lint errors about "unused imports" or "defined but never used" in the application entry point file (main.ts, App.tsx, index.ts, server.ts, etc.):
- If the unused imports are core application components (services, managers, UI components, controllers), the fix is NOT to remove them — it is to ADD the integration code that uses them (game loop, app bootstrap, route mounting, etc.)
- Only remove imports that are genuinely extraneous (duplicates, wrong file, superseded).`, priority: 1 },
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
    const { assignments: namespacedAssignments, dropped } = sanitizeAssignmentStoryIds(
        namespaced, state.userStories ?? [], state.bugs ?? [],
    );
    if (dropped.length > 0) {
        bugLog.warn(`Dropped ${dropped.length} unresolvable storyId reference(s) from bugfix assignments: ${dropped.join(', ')}`);
    }
    bugLog.info(`Created ${namespacedAssignments.length} bugfix assignments (iteration ${iteration})`);

    // Track which bugs are being attempted (not fixed — fix is verified later)
    const bugIdsBeingAttempted = openBugs.map(b => b.id);

    // Increment bug attempt counts
    const newBugAttempts: Record<string, number> = {};
    for (const id of bugIdsBeingAttempted) {
        newBugAttempts[id] = (state.bugAttempts?.[id] ?? 0) + 1;
    }

    emitRunEvent('phase:end', { phase: 'bugfix-triage', nextPhase: 'development', bugs: bugIdsBeingAttempted.length, assignments: namespacedAssignments.length });
    return {
        assignments: namespacedAssignments,
        attemptedBugIds: bugIdsBeingAttempted,
        bugAttempts: newBugAttempts,
        iteration: { bugfix: iteration },
        phase: 'bugfix-triage' as PhaseName,
        transcript: [msg('team-leader', 'bugfix-triage', `Iteration ${iteration}: reassigned ${namespacedAssignments.length} bug fixes for ${bugIdsBeingAttempted.length} bugs`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}
