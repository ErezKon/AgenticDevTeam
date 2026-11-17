/**
 * Unit tests for the GitHub Repo Manager utility.
 *
 * All GitHub API calls are mocked via jest.mock('@octokit/rest').
 * Git operations are mocked via jest.mock('child_process').
 */
import {
    createGitHubRepo,
    validateGitHubRepo,
    initializeRepoLocally,
} from '../src/utils/github-repo-manager';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateForAuthenticatedUser = jest.fn();
const mockCreateInOrg = jest.fn();
const mockReposGet = jest.fn();
const mockGetAuthenticated = jest.fn();
const mockListCommits = jest.fn();
const mockListBranches = jest.fn();

jest.mock('@octokit/rest', () => ({
    Octokit: jest.fn().mockImplementation(() => ({
        users: { getAuthenticated: mockGetAuthenticated },
        repos: {
            createForAuthenticatedUser: mockCreateForAuthenticatedUser,
            createInOrg: mockCreateInOrg,
            get: mockReposGet,
            listCommits: mockListCommits,
            listBranches: mockListBranches,
        },
    })),
}));

const mockExecFileSync = jest.fn().mockReturnValue(Buffer.from(''));

jest.mock('child_process', () => ({
    execFileSync: (...args: any[]) => mockExecFileSync(...args),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

beforeEach(() => {
    jest.clearAllMocks();
    // Default: git diff --cached --quiet throws (meaning there are staged changes)
    mockExecFileSync.mockImplementation((_bin: string, args: string[]) => {
        if (Array.isArray(args) && args.includes('--quiet')) {
            throw new Error('changes exist');
        }
        return Buffer.from('');
    });
});

// ─── createGitHubRepo ───────────────────────────────────────────────────────

describe('createGitHubRepo', () => {
    it('creates a user repo when owner matches authenticated user', async () => {
        mockGetAuthenticated.mockResolvedValue({
            data: { login: 'my-user' },
        });
        mockCreateForAuthenticatedUser.mockResolvedValue({
            data: {
                full_name: 'my-user/test-repo',
                html_url: 'https://github.com/my-user/test-repo',
                clone_url: 'https://github.com/my-user/test-repo.git',
                default_branch: 'main',
            },
        });

        const result = await createGitHubRepo('token123', 'my-user', 'test-repo', true);

        expect(mockCreateForAuthenticatedUser).toHaveBeenCalledWith({
            name: 'test-repo',
            private: true,
            auto_init: true,
        });
        expect(mockCreateInOrg).not.toHaveBeenCalled();
        expect(result).toEqual({
            fullName: 'my-user/test-repo',
            htmlUrl: 'https://github.com/my-user/test-repo',
            cloneUrl: 'https://github.com/my-user/test-repo.git',
            defaultBranch: 'main',
        });
    });

    it('creates an org repo when owner differs from authenticated user', async () => {
        mockGetAuthenticated.mockResolvedValue({
            data: { login: 'my-user' },
        });
        mockCreateInOrg.mockResolvedValue({
            data: {
                full_name: 'my-org/test-repo',
                html_url: 'https://github.com/my-org/test-repo',
                clone_url: 'https://github.com/my-org/test-repo.git',
                default_branch: 'main',
            },
        });

        const result = await createGitHubRepo('token123', 'my-org', 'test-repo', false);

        expect(mockCreateInOrg).toHaveBeenCalledWith({
            org: 'my-org',
            name: 'test-repo',
            private: false,
            auto_init: true,
        });
        expect(mockCreateForAuthenticatedUser).not.toHaveBeenCalled();
        expect(result).toEqual({
            fullName: 'my-org/test-repo',
            htmlUrl: 'https://github.com/my-org/test-repo',
            cloneUrl: 'https://github.com/my-org/test-repo.git',
            defaultBranch: 'main',
        });
    });

    it('defaults isPrivate to true', async () => {
        mockGetAuthenticated.mockResolvedValue({
            data: { login: 'me' },
        });
        mockCreateForAuthenticatedUser.mockResolvedValue({
            data: {
                full_name: 'me/repo',
                html_url: 'https://github.com/me/repo',
                clone_url: 'https://github.com/me/repo.git',
                default_branch: 'main',
            },
        });

        await createGitHubRepo('tok', 'me', 'repo');

        expect(mockCreateForAuthenticatedUser).toHaveBeenCalledWith(
            expect.objectContaining({ private: true }),
        );
    });

    // Plan 30-B: a repo left behind by an interrupted intake made the rerun die on 422.
    describe('when the name is already taken (422)', () => {
        const nameTaken = {
            status: 422,
            message: 'Repository creation failed.',
            response: { data: { errors: [{ field: 'name', message: 'name already exists on this account' }] } },
        };
        const existing = {
            full_name: 'me/left-over',
            html_url: 'https://github.com/me/left-over',
            clone_url: 'https://github.com/me/left-over.git',
            default_branch: 'main',
            private: true,
        };

        beforeEach(() => {
            mockGetAuthenticated.mockResolvedValue({ data: { login: 'me' } });
            mockCreateForAuthenticatedUser.mockRejectedValue(nameTaken);
            mockReposGet.mockResolvedValue({ data: existing });
        });

        it('reuses a repo that holds only the auto-init commit (system branch at the same tip)', async () => {
            mockListCommits.mockResolvedValue({ data: [{ sha: 'abc' }] });
            mockListBranches.mockResolvedValue({
                data: [{ name: 'main', commit: { sha: 'abc' } }, { name: 'project/left-over', commit: { sha: 'abc' } }],
            });

            const result = await createGitHubRepo('tok', 'me', 'left-over', true);

            expect(result).toEqual({
                fullName: 'me/left-over',
                htmlUrl: 'https://github.com/me/left-over',
                cloneUrl: 'https://github.com/me/left-over.git',
                defaultBranch: 'main',
            });
            expect(mockListCommits).toHaveBeenCalledWith(expect.objectContaining({ sha: 'main', per_page: 2 }));
        });

        it('reuses a completely empty repo (GitHub answers 409 for its commits)', async () => {
            mockListCommits.mockRejectedValue({ status: 409, message: 'Git Repository is empty.' });
            mockListBranches.mockResolvedValue({ data: [] });

            await expect(createGitHubRepo('tok', 'me', 'left-over', true)).resolves.toEqual(
                expect.objectContaining({ fullName: 'me/left-over' }),
            );
        });

        it('refuses a repo whose default branch has real history', async () => {
            mockListCommits.mockResolvedValue({ data: [{ sha: 'b' }, { sha: 'a' }] });

            await expect(createGitHubRepo('tok', 'me', 'left-over', true)).rejects.toThrow(
                /already exists and contains work — choose a different repository name/,
            );
            expect(mockListBranches).not.toHaveBeenCalled();
        });

        it('refuses a repo with work pushed to another branch', async () => {
            mockListCommits.mockResolvedValue({ data: [{ sha: 'abc' }] });
            mockListBranches.mockResolvedValue({
                data: [{ name: 'main', commit: { sha: 'abc' } }, { name: 'feature', commit: { sha: 'def' } }],
            });

            await expect(createGitHubRepo('tok', 'me', 'left-over', true)).rejects.toThrow(/contains work on other branches/);
        });

        it('refuses a repo whose visibility differs from the request', async () => {
            await expect(createGitHubRepo('tok', 'me', 'left-over', false)).rejects.toThrow(/already exists and is private/);
            expect(mockListCommits).not.toHaveBeenCalled();
        });

        it('rethrows other creation errors unchanged', async () => {
            const forbidden = { status: 403, message: 'Forbidden' };
            mockCreateForAuthenticatedUser.mockRejectedValue(forbidden);

            await expect(createGitHubRepo('tok', 'me', 'left-over', true)).rejects.toBe(forbidden);
            expect(mockReposGet).not.toHaveBeenCalled();
        });
    });
});

// ─── validateGitHubRepo ─────────────────────────────────────────────────────

describe('validateGitHubRepo', () => {
    it('returns exists: true for an accessible repo', async () => {
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
        expect(result.fullName).toBe('owner/repo');
        expect(result.private).toBe(true);
    });

    it('returns exists: false for a 404', async () => {
        mockReposGet.mockRejectedValue({ status: 404 });

        const result = await validateGitHubRepo('tok', 'owner', 'missing');

        expect(result.exists).toBe(false);
        expect(result.fullName).toBe('owner/missing');
    });

    it('rethrows non-404 errors', async () => {
        mockReposGet.mockRejectedValue({ status: 403, message: 'Forbidden' });

        await expect(validateGitHubRepo('tok', 'owner', 'forbidden')).rejects.toEqual(
            expect.objectContaining({ status: 403 }),
        );
    });
});

// ─── initializeRepoLocally ──────────────────────────────────────────────────

describe('initializeRepoLocally', () => {
    it('runs git init, config, remote add, and commit', () => {
        initializeRepoLocally(
            '/tmp/test-workspace',
            'https://github.com/owner/repo.git',
            'main',
            'my-token',
        );

        // execFileSync is called as ('git', argsArray, opts)
        const calls = mockExecFileSync.mock.calls.map(
            (c: any[]) => c[1], // args array
        );

        expect(calls).toEqual(expect.arrayContaining([
            ['init', '-b', 'main'],
            expect.arrayContaining(['config', 'user.name']),
            expect.arrayContaining(['config', 'user.email']),
            ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'],
            ['add', '-A'],
            ['diff', '--cached', '--quiet'],
            ['commit', '-m', 'Initial commit'],
        ]));

        // Token should NOT be in the remote URL — it's set via http.extraHeader config
        const remoteAddCall = mockExecFileSync.mock.calls.find(
            (c: any[]) => Array.isArray(c[1]) && c[1].includes('remote'),
        );
        const remoteArgs = remoteAddCall?.[1] ?? [];
        expect(remoteArgs.join(' ')).not.toContain('x-access-token');

        // Verify http.extraHeader config was set for the token
        const configCall = mockExecFileSync.mock.calls.find(
            (c: any[]) => Array.isArray(c[1]) && c[1].some((a: string) => a.includes('extraHeader')),
        );
        expect(configCall).toBeTruthy();

        // Verify CWD is correct for all calls
        for (const call of mockExecFileSync.mock.calls) {
            expect(call[2]).toEqual(expect.objectContaining({ cwd: '/tmp/test-workspace' }));
        }
    });

    it('creates empty commit when no staged changes', () => {
        // Override: diff --cached --quiet succeeds (no changes)
        mockExecFileSync.mockImplementation(() => {
            return Buffer.from('');
        });

        initializeRepoLocally('/tmp/empty', 'https://github.com/o/r.git');

        const calls = mockExecFileSync.mock.calls.map((c: any[]) => c[1]);
        expect(calls).toContainEqual(['commit', '--allow-empty', '-m', 'Initial commit']);
    });

    it('uses remote URL without token when token is not provided', () => {
        initializeRepoLocally('/tmp/ws', 'https://github.com/o/r.git', 'main');

        const remoteCall = mockExecFileSync.mock.calls.find(
            (c: any[]) => Array.isArray(c[1]) && c[1].includes('remote'),
        );
        expect(remoteCall?.[1]).toEqual(['remote', 'add', 'origin', 'https://github.com/o/r.git']);

        // No extraHeader config call should exist without a token
        const configCalls = mockExecFileSync.mock.calls.filter(
            (c: any[]) => Array.isArray(c[1]) && c[1].some((a: string) => typeof a === 'string' && a.includes('extraHeader')),
        );
        expect(configCalls).toHaveLength(0);
    });
});
