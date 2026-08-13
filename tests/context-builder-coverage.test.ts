/**
 * Tests for context-builder.ts additions from Sub-Plan 04:
 * - storiesForIds returns { text, missing }
 * - storiesWithCriteria provides full AC to the TL
 * - tasksForIds delivers task descriptions to developers
 */
import {
    storiesForIds, storiesWithCriteria, tasksForIds,
} from '../src/conductor/context-builder';
import type { UserStory, Task } from '../src/agents/_shared/base-schemas';

const stories: UserStory[] = [
    {
        id: 'US-001', epicId: 'E-001',
        asA: 'user', iWant: 'login', soThat: 'I can access the system',
        acceptanceCriteria: ['AC0: valid creds', 'AC1: invalid rejected'],
    },
    {
        id: 'US-002', epicId: 'E-001',
        asA: 'admin', iWant: 'manage users', soThat: 'roles enforced',
        acceptanceCriteria: ['AC0: add user'],
    },
];

const tasks: Task[] = [
    { id: 'TASK-001', storyId: 'US-001', title: 'Auth endpoint', layer: 'backend', suggestedTech: 'Node', description: 'Build the auth endpoint with JWT.', moduleIds: [] },
    { id: 'TASK-002', storyId: 'US-002', title: 'Admin UI', layer: 'frontend', suggestedTech: 'React', description: 'Build admin management UI.', moduleIds: [] },
];

// ─── storiesForIds ──────────────────────────────────────────────────────────

describe('storiesForIds', () => {
    it('returns matching stories with AC', () => {
        const { text, missing } = storiesForIds(stories, ['US-001']);
        expect(text).toContain('US-001');
        expect(text).toContain('AC0: valid creds');
        expect(missing).toEqual([]);
    });

    it('reports missing ids', () => {
        const { text, missing } = storiesForIds(stories, ['US-001', 'US-GHOST']);
        expect(text).toContain('US-001');
        expect(missing).toEqual(['US-GHOST']);
    });

    it('returns "(no stories)" with all missing when stories array empty', () => {
        const { text, missing } = storiesForIds([], ['US-001']);
        expect(text).toBe('(no stories)');
        expect(missing).toEqual(['US-001']);
    });

    it('returns all missing when no matches', () => {
        const { missing } = storiesForIds(stories, ['US-GHOST']);
        expect(missing).toEqual(['US-GHOST']);
    });
});

// ─── storiesWithCriteria ────────────────────────────────────────────────────

describe('storiesWithCriteria', () => {
    it('includes numbered AC for each story', () => {
        const text = storiesWithCriteria(stories);
        expect(text).toContain('AC0: valid creds');
        expect(text).toContain('AC1: invalid rejected');
        expect(text).toContain('US-001');
        expect(text).toContain('US-002');
    });

    it('returns placeholder for empty stories', () => {
        expect(storiesWithCriteria([])).toBe('(no user stories)');
    });
});

// ─── tasksForIds ────────────────────────────────────────────────────────────

describe('tasksForIds', () => {
    it('returns matched tasks with descriptions', () => {
        const text = tasksForIds(tasks, ['TASK-001']);
        expect(text).toContain('TASK-001');
        expect(text).toContain('Build the auth endpoint with JWT.');
    });

    it('returns placeholder when no matches', () => {
        expect(tasksForIds(tasks, ['TASK-GHOST'])).toBe('(no matching tasks)');
    });

    it('clips long descriptions', () => {
        const longTasks: Task[] = [{
            id: 'TASK-LONG', storyId: 'US-001', title: 'Long', layer: 'backend',
            suggestedTech: 'Node', description: 'x'.repeat(2000), moduleIds: [],
        }];
        const text = tasksForIds(longTasks, ['TASK-LONG'], 100);
        expect(text.length).toBeLessThan(2000);
    });
});
