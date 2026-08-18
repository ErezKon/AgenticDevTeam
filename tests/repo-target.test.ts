/**
 * Unit tests for multi-repo targeting schemas and integration.
 *
 * Covers:
 *   - GitContextSchema validation (valid, defaults, rejections)
 *   - RepoTargetSchema validation (all three types, defaults, edge cases)
 *   - RunInputSchema with repoTarget (optional, embedded validation)
 *   - createGitHubRepo / validateGitHubRepo integration-level assertions
 *     (mocked — complements the lower-level tests in github-repo-manager.test.ts)
 */
import {
    GitContextSchema,
    RepoTargetSchema,
    RunInputSchema,
} from '../src/agents/_shared/schemas/index';
import type { GitContext } from '../src/agents/_shared/schemas/git-context.schema';

// ─── GitContextSchema ───────────────────────────────────────────────────────

describe('GitContextSchema', () => {
    it('parses a valid full object', () => {
        const input = {
            token: 'ghp_abc123',
            owner: 'my-org',
            repo: 'my-repo',
            defaultBranch: 'develop',
        };
        const result = GitContextSchema.parse(input);
        expect(result).toEqual(input);
    });

    it('applies default "main" for defaultBranch when omitted', () => {
        const result = GitContextSchema.parse({
            token: 'tok',
            owner: 'owner',
            repo: 'repo',
        });
        expect(result.defaultBranch).toBe('main');
    });

    it('rejects when token is missing', () => {
        expect(() =>
            GitContextSchema.parse({ owner: 'o', repo: 'r' }),
        ).toThrow();
    });

    it('rejects when owner is missing', () => {
        expect(() =>
            GitContextSchema.parse({ token: 't', repo: 'r' }),
        ).toThrow();
    });

    it('rejects when repo is missing', () => {
        expect(() =>
            GitContextSchema.parse({ token: 't', owner: 'o' }),
        ).toThrow();
    });

    it('rejects non-string token', () => {
        expect(() =>
            GitContextSchema.parse({ token: 123, owner: 'o', repo: 'r' }),
        ).toThrow();
    });
});

// ─── RepoTargetSchema ───────────────────────────────────────────────────────

describe('RepoTargetSchema', () => {
    it('parses same-repo type', () => {
        const result = RepoTargetSchema.parse({ type: 'same-repo' });
        expect(result.type).toBe('same-repo');
        expect(result.isPrivate).toBe(true); // default
    });

    it('parses new-repo with repoName and isPrivate', () => {
        const result = RepoTargetSchema.parse({
            type: 'new-repo',
            repoName: 'my-new-project',
            isPrivate: false,
        });
        expect(result).toEqual({
            type: 'new-repo',
            repoName: 'my-new-project',
            isPrivate: false,
        });
    });

    it('parses existing-repo with repoName', () => {
        const result = RepoTargetSchema.parse({
            type: 'existing-repo',
            repoName: 'legacy-app',
        });
        expect(result.type).toBe('existing-repo');
        expect(result.repoName).toBe('legacy-app');
    });

    it('defaults isPrivate to true for new-repo', () => {
        const result = RepoTargetSchema.parse({
            type: 'new-repo',
            repoName: 'test',
        });
        expect(result.isPrivate).toBe(true);
    });

    it('allows repoName to be omitted', () => {
        const result = RepoTargetSchema.parse({ type: 'same-repo' });
        expect(result.repoName).toBeUndefined();
    });

    it('rejects an invalid type value', () => {
        expect(() =>
            RepoTargetSchema.parse({ type: 'fork-repo' }),
        ).toThrow();
    });

    it('rejects when type is missing', () => {
        expect(() =>
            RepoTargetSchema.parse({ repoName: 'test' }),
        ).toThrow();
    });
});

// ─── RunInputSchema with repoTarget ─────────────────────────────────────────

describe('RunInputSchema + repoTarget', () => {
    const baseInput = {
        systemName: 'TestSystem',
        requirementsText: 'Build a test system.',
        mode: 'autonomous' as const,
        runType: 'greenfield' as const,
    };

    it('accepts input without repoTarget (backward compatible)', () => {
        const result = RunInputSchema.parse(baseInput);
        expect(result.repoTarget).toBeUndefined();
    });

    it('accepts input with repoTarget same-repo', () => {
        const result = RunInputSchema.parse({
            ...baseInput,
            repoTarget: { type: 'same-repo' },
        });
        expect(result.repoTarget?.type).toBe('same-repo');
    });

    it('accepts input with repoTarget new-repo', () => {
        const result = RunInputSchema.parse({
            ...baseInput,
            repoTarget: {
                type: 'new-repo',
                repoName: 'fresh-project',
                isPrivate: true,
            },
        });
        expect(result.repoTarget?.type).toBe('new-repo');
        expect(result.repoTarget?.repoName).toBe('fresh-project');
    });

    it('accepts input with repoTarget existing-repo', () => {
        const result = RunInputSchema.parse({
            ...baseInput,
            repoTarget: {
                type: 'existing-repo',
                repoName: 'my-existing-repo',
            },
        });
        expect(result.repoTarget?.type).toBe('existing-repo');
        expect(result.repoTarget?.repoName).toBe('my-existing-repo');
    });

    it('rejects when repoTarget has invalid type', () => {
        expect(() =>
            RunInputSchema.parse({
                ...baseInput,
                repoTarget: { type: 'clone-repo' },
            }),
        ).toThrow();
    });

    it('preserves existing RunInput fields alongside repoTarget', () => {
        const result = RunInputSchema.parse({
            ...baseInput,
            existingProjectPath: '/tmp/project',
            repoTarget: { type: 'same-repo' },
        });
        expect(result.systemName).toBe('TestSystem');
        expect(result.requirementsText).toBe('Build a test system.');
        expect(result.mode).toBe('autonomous');
        expect(result.runType).toBe('greenfield');
        expect(result.existingProjectPath).toBe('/tmp/project');
        expect(result.repoTarget?.type).toBe('same-repo');
    });
});

// ─── createGitHubRepo / validateGitHubRepo — Schema-level integration ───────

const mockCreateForAuthenticatedUser = jest.fn();
const mockCreateInOrg = jest.fn();
const mockReposGet = jest.fn();
const mockGetAuthenticated = jest.fn();

jest.mock('@octokit/rest', () => ({
    Octokit: jest.fn().mockImplementation(() => ({
        users: { getAuthenticated: mockGetAuthenticated },
        repos: {
            createForAuthenticatedUser: mockCreateForAuthenticatedUser,
            createInOrg: mockCreateInOrg,
            get: mockReposGet,
        },
    })),
}));

import {
    createGitHubRepo,
    validateGitHubRepo,
} from '../src/utils/github-repo-manager';

beforeEach(() => {
    jest.clearAllMocks();
});

describe('createGitHubRepo — result conforms to GitContext fields', () => {
    it('returns values that can populate a GitContext', async () => {
        mockGetAuthenticated.mockResolvedValue({ data: { login: 'user1' } });
        mockCreateForAuthenticatedUser.mockResolvedValue({
            data: {
                full_name: 'user1/new-proj',
                html_url: 'https://github.com/user1/new-proj',
                clone_url: 'https://github.com/user1/new-proj.git',
                default_branch: 'main',
            },
        });

        const result = await createGitHubRepo('tok', 'user1', 'new-proj', true);

        // The result should provide all fields needed to construct a GitContext
        const gitContext: GitContext = GitContextSchema.parse({
            token: 'tok',
            owner: result.fullName.split('/')[0],
            repo: result.fullName.split('/')[1],
            defaultBranch: result.defaultBranch,
        });

        expect(gitContext.owner).toBe('user1');
        expect(gitContext.repo).toBe('new-proj');
        expect(gitContext.defaultBranch).toBe('main');
    });

    it('handles org repo creation and produces valid GitContext', async () => {
        mockGetAuthenticated.mockResolvedValue({ data: { login: 'user1' } });
        mockCreateInOrg.mockResolvedValue({
            data: {
                full_name: 'my-org/team-project',
                html_url: 'https://github.com/my-org/team-project',
                clone_url: 'https://github.com/my-org/team-project.git',
                default_branch: 'develop',
            },
        });

        const result = await createGitHubRepo('tok', 'my-org', 'team-project', false);

        const gitContext = GitContextSchema.parse({
            token: 'tok',
            owner: result.fullName.split('/')[0],
            repo: result.fullName.split('/')[1],
            defaultBranch: result.defaultBranch,
        });

        expect(gitContext.owner).toBe('my-org');
        expect(gitContext.repo).toBe('team-project');
        expect(gitContext.defaultBranch).toBe('develop');
    });
});

describe('validateGitHubRepo — result conforms to GitContext fields', () => {
    it('returns values that can populate a GitContext when repo exists', async () => {
        mockReposGet.mockResolvedValue({
            data: {
                full_name: 'owner/repo',
                html_url: 'https://github.com/owner/repo',
                clone_url: 'https://github.com/owner/repo.git',
                default_branch: 'main',
                private: true,
            },
        });

        const result = await validateGitHubRepo('tok', 'owner', 'repo');

        expect(result.exists).toBe(true);

        const gitContext = GitContextSchema.parse({
            token: 'tok',
            owner: result.fullName.split('/')[0],
            repo: result.fullName.split('/')[1],
            defaultBranch: result.defaultBranch,
        });

        expect(gitContext.owner).toBe('owner');
        expect(gitContext.repo).toBe('repo');
    });

    it('returns a non-existent result for a 404 — should not be used as GitContext', async () => {
        mockReposGet.mockRejectedValue({ status: 404 });

        const result = await validateGitHubRepo('tok', 'owner', 'ghost');

        expect(result.exists).toBe(false);
        expect(result.fullName).toBe('owner/ghost');
    });
});
