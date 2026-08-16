/**
 * Bug-fix assignment story-id integrity — unit tests (Plan 21, sub-plan E).
 *
 * Test-sufficiency bugs get synthetic ids (`QA-no-tests`,
 * `QA-story-untested-US-001`). Triage handed them to the Team Leader, which
 * copied them into `assignment.storyId`, so `storiesForIds` matched nothing and
 * the developer worked with no acceptance criteria at all.
 *
 * Pure: no LLM, no git, no network.
 */
import { sanitizeAssignmentStoryIds } from '../src/conductor/assignment-policy';
import { sufficiencyViolationsToBugs } from '../src/conductor/test-sufficiency';
import type { Assignment, Bug } from '../src/agents/_shared/base-schemas';

const stories = [{ id: 'US-001' }, { id: 'US-002' }, { id: 'US-004' }];

function assignment(over: Partial<Assignment>): Assignment {
    return {
        id: 'BUGFIX-1-ASSIGN-001',
        storyId: 'US-001',
        additionalStoryIds: [],
        taskIds: ['TASK-001'],
        acIndexes: [],
        devAgentId: 'junior-go',
        rank: 'junior',
        priority: 'high',
        complexity: 'simple',
        estimate: '2h',
        description: 'fix it',
        dependsOn: [],
        taskType: 'bug',
        moduleIds: [],
        ...over,
    } as Assignment;
}

function bug(over: Partial<Bug>): Bug {
    return {
        id: 'QA-x',
        title: 't',
        severity: 'major',
        stepsToReproduce: 's',
        expectedBehavior: 'e',
        actualBehavior: 'a',
        suspectedArea: 'z',
        reportedBy: 'test-sufficiency',
        ...over,
    } as Bug;
}

describe('sanitizeAssignmentStoryIds', () => {
    it('leaves a legitimate story id untouched', () => {
        const { assignments, dropped } = sanitizeAssignmentStoryIds(
            [assignment({ storyId: 'US-004' })], stories, [],
        );
        expect(assignments[0].storyId).toBe('US-004');
        expect(dropped).toEqual([]);
    });

    it('remaps a QA bug id to the story carried on the bug', () => {
        const bugs = [bug({ id: 'QA-story-untested-US-001', storyId: 'US-001' })];
        const { assignments, dropped } = sanitizeAssignmentStoryIds(
            [assignment({ storyId: 'QA-story-untested-US-001' })], stories, bugs,
        );
        expect(assignments[0].storyId).toBe('US-001');
        expect(dropped).toEqual([]);
    });

    it('remaps by pattern when the bug carries no storyId (pre-existing state)', () => {
        const { assignments, dropped } = sanitizeAssignmentStoryIds(
            [assignment({ storyId: 'QA-below-min-per-story-US-002' })], stories, [],
        );
        expect(assignments[0].storyId).toBe('US-002');
        expect(dropped).toEqual([]);
    });

    it('drops an unresolvable id and reports it', () => {
        const { assignments, dropped } = sanitizeAssignmentStoryIds(
            [assignment({ storyId: 'QA-no-tests' })], stories, [bug({ id: 'QA-no-tests' })],
        );
        expect(assignments[0].storyId).toBe('');
        expect(dropped).toEqual(['QA-no-tests']);
    });

    it('drops a pattern-matching id whose story does not exist', () => {
        const { assignments, dropped } = sanitizeAssignmentStoryIds(
            [assignment({ storyId: 'QA-story-untested-US-999' })], stories, [],
        );
        expect(assignments[0].storyId).toBe('');
        expect(dropped).toEqual(['QA-story-untested-US-999']);
    });

    it('filters additionalStoryIds the same way and de-duplicates the primary', () => {
        const bugs = [bug({ id: 'QA-story-untested-US-002', storyId: 'US-002' })];
        const { assignments, dropped } = sanitizeAssignmentStoryIds(
            [assignment({
                storyId: 'US-001',
                additionalStoryIds: ['US-002', 'QA-story-untested-US-002', 'QA-no-tests', 'US-001'],
            })],
            stories, bugs,
        );
        expect(assignments[0].storyId).toBe('US-001');
        expect(assignments[0].additionalStoryIds).toEqual(['US-002']);
        expect(dropped).toEqual(['QA-no-tests']);
    });

    it('reports each unresolvable id once, across all assignments', () => {
        const { dropped } = sanitizeAssignmentStoryIds(
            [assignment({ storyId: 'QA-no-tests' }), assignment({ id: 'B', storyId: 'QA-no-tests' })],
            stories, [],
        );
        expect(dropped).toEqual(['QA-no-tests']);
    });

    it('does not mutate the input assignments', () => {
        const input = [assignment({ storyId: 'QA-no-tests' })];
        sanitizeAssignmentStoryIds(input, stories, []);
        expect(input[0].storyId).toBe('QA-no-tests');
    });
});

describe('sufficiencyViolationsToBugs', () => {
    it('carries the story id as structured data, not just prose', () => {
        const [b] = sufficiencyViolationsToBugs([
            { kind: 'story-untested', severity: 'major', detail: 'no tests', storyId: 'US-001' },
        ]);
        expect(b.id).toBe('QA-story-untested-US-001');
        expect(b.storyId).toBe('US-001');
    });

    it('omits storyId for suite-wide violations', () => {
        const [b] = sufficiencyViolationsToBugs([
            { kind: 'no-tests', severity: 'critical', detail: 'nothing ran' },
        ]);
        expect(b.id).toBe('QA-no-tests');
        expect(b.storyId).toBeUndefined();
    });

    it('end-to-end: a sufficiency bug resolves back to its story', () => {
        const bugs = sufficiencyViolationsToBugs([
            { kind: 'story-untested', severity: 'major', detail: 'no tests', storyId: 'US-004' },
        ]);
        const { assignments } = sanitizeAssignmentStoryIds(
            [assignment({ storyId: bugs[0].id })], stories, bugs,
        );
        expect(assignments[0].storyId).toBe('US-004');
    });
});
