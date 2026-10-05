/**
 * Plan 30-05 — bug-fix triage input (`selectTriageBugs`).
 *
 * The fixture is the 63 bugs claudeopus5's first triage handed the Team Leader
 * (failed-run/state.json, verbatim). Every one was a pipeline artifact: a test
 * runner that never started, a build checked before it ran, and one PR blocked
 * by review findings. The Team Leader invented merge conflicts and file paths.
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { AssignmentSchema } from '../src/agents/_shared/base-schemas';
import { selectTriageBugs, currentBugs, bugStoryId, summariseDropped } from '../src/conductor/triage-selection';
import { makeState } from './helpers/state-factory';
import type { Bug, PullRequest, UserStory } from '../src/agents/_shared/base-schemas';

const FIXTURES = path.join(__dirname, 'fixtures', 'plan30');
const BUGS: Bug[] = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'claudeopus5-triage-bugs.json'), 'utf-8'));
const ASSIGNMENTS = z.array(AssignmentSchema).parse(JSON.parse(fs.readFileSync(path.join(FIXTURES, 'claudeopus5-assignments.json'), 'utf-8')));
/** Merged by round 1 (failed-run/state.json `completedAssignmentIds`). */
const COMPLETED = ['ASSIGN-001', 'ASSIGN-002', 'ASSIGN-003', 'ASSIGN-004', 'ASSIGN-005', 'ASSIGN-027'];

const SCAFFOLD = 'claudeopus5/chore/scaffold';
const US027 = 'claudeopus5/feature/us-027-storage-accessibility-integration';

function pr(fields: Partial<PullRequest> & Pick<PullRequest, 'id' | 'branchName' | 'status'>): PullRequest {
    return {
        prNumber: 0, prUrl: '', title: fields.id, description: '', authorAgentId: 'junior-angular',
        reviewerAgentIds: [], reviews: [], assignmentIds: [], taskType: 'feature', ...fields,
    };
}

function bug(id: string, extra: Partial<Bug> = {}): Bug {
    return {
        id, title: id, severity: 'critical', reportedBy: 'test', stepsToReproduce: id,
        expectedBehavior: '', actualBehavior: id, suspectedArea: '', ...extra,
    };
}

const PR1 = pr({ id: 'PR-1', prNumber: 1, branchName: SCAFFOLD, status: 'merged', assignmentIds: COMPLETED });
/** PR #2 as the merge stage records it since Plan 30-03: blocked by review findings — no conflict. */
const PR2 = pr({
    id: 'PR-2', prNumber: 2, branchName: US027, status: 'blocked',
    assignmentIds: ['ASSIGN-021', 'ASSIGN-022', 'ASSIGN-023', 'ASSIGN-024', 'ASSIGN-025', 'ASSIGN-026'],
    blockers: ['Quorum not met: 0/2 approvals (0 abstention(s))'],
});

const round1 = () => makeState({ bugs: BUGS, assignments: ASSIGNMENTS, completedAssignmentIds: COMPLETED, pullRequests: [PR1, PR2] });

describe("selectTriageBugs on claudeopus5's first triage (Plan 30-05)", () => {
    it('the fixture is the 63 bugs the Team Leader received', () => {
        expect(BUGS).toHaveLength(63);
    });

    it('leaves only the actionable items: the runner, the empty build, and one bug for the blocked PR', () => {
        const { bugs, dropped } = selectTriageBugs(round1());

        expect(bugs.map(b => b.id)).toEqual(['QA-runner-error', 'PRODUCT-ARTIFACTS-root', `PR-BLOCKED-${US027}`]);
        expect(dropped).toHaveLength(61);
    });

    it('drops undelivered work: 28 untested stories and 16 criteria of the blocked PR, whose work has not merged', () => {
        const undelivered = selectTriageBugs(round1()).dropped.filter(d => d.reason.startsWith('undelivered'));

        expect(undelivered).toHaveLength(44);
        expect(undelivered.map(d => d.id)).toEqual(expect.arrayContaining(['QA-story-untested-US-027', 'QA-story-untested-US-005', 'AC-US-027-0', 'AC-US-034-1']));
        expect(undelivered.map(d => d.id)).not.toContain('QA-story-untested-US-001');
    });

    it('lets a root cause absorb its derivatives', () => {
        const { dropped } = selectTriageBugs(round1());
        const byRunner = dropped.filter(d => d.reason.includes('QA-runner-error')).map(d => d.id);

        // 7 delivered stories untested and 9 implemented criteria untested — because the runner failed
        expect(byRunner).toHaveLength(16);
        expect(byRunner).toEqual(expect.arrayContaining(['QA-story-untested-US-001', 'QA-story-untested-US-035', 'AC-US-001-0', 'AC-US-017-0']));
        expect(dropped.find(d => d.id === 'PRODUCT-SMOKE')?.reason).toContain('PRODUCT-ARTIFACTS');
    });

    it("the blocked PR's bug carries its real blockers", () => {
        const prBug = selectTriageBugs(round1()).bugs.find(b => b.id === `PR-BLOCKED-${US027}`)!;

        expect(prBug.title).toBe(`PR #2 blocked on ${US027}`);
        expect(prBug.actualBehavior).toContain('Quorum not met: 0/2 approvals');
        expect(prBug.actualBehavior).not.toMatch(/conflict/i);
    });

    it('summarises what was left out, grouped by reason', () => {
        expect(summariseDropped(selectTriageBugs(round1()).dropped)).toMatch(/^44 × undelivered.*; 16 × absorbed by QA-runner-error.*; 1 × absorbed by PRODUCT-ARTIFACTS/);
    });
});

describe('the bug window (Plan 30-05)', () => {
    it('reads only what was raised after the previous triage round', () => {
        const state = makeState({
            bugs: [bug('QA-runner-error'), bug('GATE-node-build')],
            triageRounds: [{ iteration: 1, bugCursor: 1, bugIds: ['QA-runner-error'] }],
        });
        expect(currentBugs(state).map(b => b.id)).toEqual(['GATE-node-build']);
        expect(selectTriageBugs(state).bugs.map(b => b.id)).toEqual(['GATE-node-build']);
    });

    it('a bug that is no longer reported is not triaged again; a regression is, although QA once marked it fixed', () => {
        // Round 1 raised A and B; round 2 raised nothing (QA marked both fixed); round 3 raises B again.
        const state = makeState({
            bugs: [bug('A'), bug('B'), bug('B')],
            fixedBugIds: ['A', 'B'],
            triageRounds: [{ iteration: 1, bugCursor: 2, bugIds: ['A', 'B'] }, { iteration: 2, bugCursor: 2, bugIds: [] }],
        });
        expect(selectTriageBugs(state).bugs.map(b => b.id)).toEqual(['B']);
    });

    it('drops minor and trivial bugs', () => {
        const state = makeState({ bugs: [bug('LINT-1', { severity: 'minor' }), bug('GATE-node-test')] });
        expect(selectTriageBugs(state).bugs.map(b => b.id)).toEqual(['GATE-node-test']);
    });
});

describe('undelivered branches (Plan 30-05)', () => {
    it('one bug per branch that needs a fix; none for a deferred branch or a PR-less placeholder without a gate failure', () => {
        const state = makeState({
            pullRequests: [
                pr({ id: 'PR-7', prNumber: 7, branchName: 'app/feature/a', status: 'blocked', blockers: ['Quality gates not passed (1 failures)'] }),
                pr({ id: 'PR-DEFERRED-app/feature/b', branchName: 'app/feature/b', status: 'deferred' }),
                pr({ id: 'PR-SKIPPED-app/feature/c', branchName: 'app/feature/c', status: 'closed' }),
                pr({
                    id: 'PR-GATES-FAILED-app/feature/d', branchName: 'app/feature/d', status: 'closed',
                    failedGate: { step: 'build', command: 'npm run build', summary: 'error TS2307: Cannot find module' },
                }),
                pr({ id: 'PR-8', prNumber: 8, branchName: 'app/feature/e', status: 'blocked' }),
                pr({ id: 'PR-9', prNumber: 9, branchName: 'app/feature/e', status: 'merged' }),
            ],
        });
        const bugs = selectTriageBugs(state).bugs;

        expect(bugs.map(b => b.id)).toEqual(['PR-BLOCKED-app/feature/a', 'PR-BLOCKED-app/feature/d']);
        expect(bugs[1].title).toBe('Branch app/feature/d blocked before a PR');
        expect(bugs[1].actualBehavior).toContain('build failed (`npm run build`)');
    });

    it('an abandoned branch gets no bug — also not the one the AC gate raised', () => {
        const blocked = (n: number) => pr({ id: `PR-${n}`, prNumber: 2, branchName: US027, status: 'blocked', blockers: ['review'] });
        const state = makeState({ pullRequests: [PR1, blocked(1), blocked(2)], bugs: [bug(`PR-BLOCKED-${US027}`), bug('QA-runner-error')] });
        const { bugs, dropped } = selectTriageBugs(state);

        expect(bugs.map(b => b.id)).toEqual(['QA-runner-error']);
        expect(dropped).toEqual([{ id: `PR-BLOCKED-${US027}`, reason: expect.stringContaining('abandoned') }]);
    });
});

describe('story scoping and restatements (Plan 30-05)', () => {
    const story = (id: string): UserStory => ({ id, epicId: 'E-1', asA: 'player', iWant: id, soThat: 'fun', acceptanceCriteria: ['works'] });

    it('keeps a story bug when no assignment covers the story — nothing else would deliver it', () => {
        const state = makeState({
            assignments: ASSIGNMENTS, completedAssignmentIds: COMPLETED,
            bugs: [bug('AC-US-099-0', { actualBehavior: 'Status "missing" — no assignment references this story' })],
        });
        expect(selectTriageBugs(state).bugs.map(b => b.id)).toEqual(['AC-US-099-0']);
    });

    it('ACCEPT-SCOPE is undelivered work while every story has an assignment, and a gap when one has none', () => {
        const scope = bug('ACCEPT-SCOPE');
        const assigned = makeState({ assignments: ASSIGNMENTS, userStories: [story('US-001'), story('US-027')], bugs: [scope] });
        const unassigned = makeState({ assignments: ASSIGNMENTS, userStories: [story('US-001'), story('US-099')], bugs: [scope] });

        expect(selectTriageBugs(assigned).bugs).toEqual([]);
        expect(selectTriageBugs(unassigned).bugs.map(b => b.id)).toEqual(['ACCEPT-SCOPE']);
    });

    it("an acceptance restatement is dropped while the specific bug is open, and kept on its own", () => {
        const withGate = makeState({ bugs: [bug('GATE-node-build'), bug('ACCEPT-BUILD'), bug('ACCEPT-TESTS'), bug('QA-runner-error')] });
        expect(selectTriageBugs(withGate).bugs.map(b => b.id)).toEqual(['GATE-node-build', 'QA-runner-error']);
        expect(selectTriageBugs(makeState({ bugs: [bug('ACCEPT-BUILD')] })).bugs.map(b => b.id)).toEqual(['ACCEPT-BUILD']);
    });

    it('bugStoryId reads storyId, else the story embedded in a story-scoped id', () => {
        expect(bugStoryId(bug('X', { storyId: 'US-005' }))).toBe('US-005');
        expect(bugStoryId(bug('AC-US-027-1'))).toBe('US-027');
        expect(bugStoryId(bug('QA-PLAN-GAP-US-004-0'))).toBe('US-004');
        expect(bugStoryId(bug('QA-story-untested-US-012'))).toBe('US-012');
        expect(bugStoryId(bug('QA-runner-error'))).toBeUndefined();
        expect(bugStoryId(bug('ACCEPT-SCOPE'))).toBeUndefined();
    });
});
