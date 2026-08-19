/**
 * Tests for PR title and description builders (pr-body.ts).
 */
jest.mock('../src/agents/developers/registry', () => ({
    getDevAgent: jest.fn((id: string) => {
        if (id === 'junior-fullstack') return { name: 'Junior Dev', id: 'junior-fullstack' };
        return null;
    }),
}));

import { buildPRTitle, buildPRDescription } from '../src/conductor/pr/pr-body';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeAssignment(overrides: Partial<any> = {}): any {
    return {
        id: 'A-001',
        storyId: 'US-001',
        additionalStoryIds: [],
        taskIds: [],
        acIndexes: [],
        devAgentId: 'junior-fullstack',
        rank: 'junior',
        priority: 'medium',
        complexity: 'moderate',
        estimate: '2h',
        description: 'Implement user login form with email validation.',
        dependsOn: [],
        branchName: 'proj/feat/login',
        reviewerAgentIds: [],
        taskType: 'feature',
        moduleIds: [],
        ...overrides,
    };
}

function makeFileChange(overrides: Partial<any> = {}): any {
    return {
        path: 'src/login.ts',
        action: 'created',
        summary: 'Login component with email validation',
        storyId: 'US-001',
        agentId: 'junior-fullstack',
        ...overrides,
    };
}

// ─── buildPRTitle ───────────────────────────────────────────────────────────

describe('buildPRTitle', () => {
    it('builds a feature title for a single assignment', () => {
        const title = buildPRTitle([makeAssignment()], 'feature', 'slug');
        expect(title).toBe('[slug] feat: Implement user login form with email validation');
    });

    it('uses "fix" prefix for bug taskType', () => {
        const title = buildPRTitle([makeAssignment()], 'bug', 'slug');
        expect(title).toMatch(/^\[slug\] fix:/);
    });

    it('uses "refactor" prefix for refactor taskType', () => {
        const title = buildPRTitle([makeAssignment()], 'refactor', 'slug');
        expect(title).toMatch(/^\[slug\] refactor:/);
    });

    it('includes story IDs for multiple assignments', () => {
        const a1 = makeAssignment({ storyId: 'US-001' });
        const a2 = makeAssignment({ id: 'A-002', storyId: 'US-002', description: 'Add password reset.' });
        const title = buildPRTitle([a1, a2], 'feature', 'slug');
        // Uses first assignment description and appends story IDs
        expect(title).toContain('(US-001, US-002)');
    });

    it('strips backticks from the description', () => {
        const a = makeAssignment({ description: 'Fix the `login` bug in `auth`.' });
        const title = buildPRTitle([a], 'feature', 'slug');
        expect(title).not.toContain('`');
        expect(title).toContain('Fix the login bug in auth');
    });

    it('truncates long descriptions to 80 chars on a word boundary', () => {
        const longDesc =
            'Implement the entire authentication flow including login registration password reset email verification and two factor authentication setup.';
        const a = makeAssignment({ description: longDesc });
        const title = buildPRTitle([a], 'feature', 'slug');
        // The desc portion (after stripping backticks) should be at most 80 chars
        // and end with "..."
        const descPart = title.replace(/^\[slug\] feat: /, '');
        expect(descPart.endsWith('...')).toBe(true);
        expect(descPart.length).toBeLessThanOrEqual(80);
    });

    it('uses only the first sentence (splits on ".")', () => {
        const a = makeAssignment({
            description: 'Add login page. Also add signup page and error handling.',
        });
        const title = buildPRTitle([a], 'feature', 'slug');
        expect(title).toBe('[slug] feat: Add login page');
        expect(title).not.toContain('Also add signup');
    });
});

// ─── buildPRDescription ─────────────────────────────────────────────────────

describe('buildPRDescription', () => {
    it('includes task summary with assignment details', () => {
        const desc = buildPRDescription([makeAssignment()], [], 'feature');
        expect(desc).toContain('## Task Summary');
        expect(desc).toContain('**A-001**');
        expect(desc).toContain('[medium/moderate]');
        expect(desc).toContain('Implement user login form');
    });

    it('includes author attribution when authorAgentId is provided', () => {
        const desc = buildPRDescription([makeAssignment()], [], 'feature', undefined, 'junior-fullstack');
        expect(desc).toContain('**Opened by Junior Dev (junior-fullstack)**');
    });

    it('has no author section when authorAgentId is undefined', () => {
        const desc = buildPRDescription([makeAssignment()], [], 'feature');
        expect(desc).not.toContain('Opened by');
    });

    it('includes current state for bug/fix/refactor types', () => {
        const desc = buildPRDescription(
            [makeAssignment()],
            [],
            'bug',
            'Login throws 500 on empty email',
        );
        expect(desc).toContain('## Current State');
        expect(desc).toContain('Login throws 500 on empty email');
    });

    it('does not include current state section for feature type', () => {
        const desc = buildPRDescription(
            [makeAssignment()],
            [],
            'feature',
            'Some state that should not appear',
        );
        expect(desc).not.toContain('## Current State');
    });

    it('lists file changes when provided', () => {
        const fc = makeFileChange();
        const desc = buildPRDescription([makeAssignment()], [fc], 'feature');
        expect(desc).toContain('## Changes Made');
        expect(desc).toContain('`src/login.ts`');
        expect(desc).toContain('**created**');
        expect(desc).toContain('Login component with email validation');
    });

    it('shows placeholder when no file changes are provided', () => {
        const desc = buildPRDescription([makeAssignment()], [], 'feature');
        expect(desc).toContain('_(changes will be listed after development)_');
    });
});
