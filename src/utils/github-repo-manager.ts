/**
 * GitHub repository management utility for multi-repo targeting.
 *
 * Provides functions to create new GitHub repos, validate existing ones,
 * and initialize local git workspaces with a remote.
 * Uses @octokit/rest (already a project dependency).
 */
import { Octokit } from '@octokit/rest';
import { GIT_USER_NAME, GIT_USER_EMAIL } from '../config';
import { getLogger } from './logger';
import { GITHUB_MODE } from './github-local';
import { execFileSync } from './shell-exec';
import { traceOctokit } from './debug-trace';

const logger = getLogger('[RepoManager]', 33);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CreateRepoResult {
    fullName: string;
    htmlUrl: string;
    cloneUrl: string;
    defaultBranch: string;
}

export interface ValidateRepoResult {
    exists: boolean;
    fullName: string;
    htmlUrl: string;
    cloneUrl: string;
    defaultBranch: string;
    private: boolean;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Create a new GitHub repository under the given owner.
 *
 * If `owner` matches the authenticated user, creates a user repo.
 * Otherwise creates an org repo.
 */
export async function createGitHubRepo(
    token: string,
    owner: string,
    repoName: string,
    isPrivate: boolean = true,
): Promise<CreateRepoResult> {
    // In local mode, return synthetic results — the actual repo is managed locally
    if (GITHUB_MODE === 'local') {
        logger.info(`[local] Synthetic createGitHubRepo: ${owner}/${repoName}`);
        return {
            fullName: `${owner}/${repoName}`,
            htmlUrl: `local://repos/${owner}/${repoName}`,
            cloneUrl: `local://repos/${owner}/${repoName}.git`,
            defaultBranch: 'main',
        };
    }

    const octokit = traceOctokit(new Octokit({ auth: token }), 'github');

    // Determine if the owner is the authenticated user or an org
    const { data: authedUser } = await octokit.users.getAuthenticated();
    const isUserRepo = authedUser.login.toLowerCase() === owner.toLowerCase();

    logger.info(`Creating ${isPrivate ? 'private' : 'public'} repo: ${owner}/${repoName}`);

    let data: any;
    try {
        const response = isUserRepo
            ? await octokit.repos.createForAuthenticatedUser({ name: repoName, private: isPrivate, auto_init: true })
            : await octokit.repos.createInOrg({ org: owner, name: repoName, private: isPrivate, auto_init: true });
        data = response.data;
    } catch (err: any) {
        if (!isNameTakenError(err)) throw err;
        // Plan 30-B: an interrupted/crashed intake leaves the repo behind; rerunning
        // with the same name used to die here with GitHub 422.
        const reusable = await findReusableRepo(octokit, owner, repoName, isPrivate);
        if (typeof reusable === 'string') {
            throw new Error(
                `Repository ${owner}/${repoName} already exists and ${reusable} — choose a different ` +
                'repository name or select "Existing GitHub repository".',
            );
        }
        logger.warn(`Repository ${owner}/${repoName} already exists but carries no work (left by an interrupted run) — reusing it`);
        return reusable;
    }

    logger.info(`Repo created: ${data.full_name} (${data.html_url})`);

    return {
        fullName: data.full_name,
        htmlUrl: data.html_url,
        cloneUrl: data.clone_url,
        defaultBranch: data.default_branch ?? 'main',
    };
}

/** GitHub's 422 for a duplicate repository name ("name already exists on this account"). */
function isNameTakenError(err: any): boolean {
    if (err?.status !== 422) return false;
    return /already exists/i.test(`${JSON.stringify(err?.response?.data ?? {})} ${err?.message ?? ''}`);
}

/**
 * A repo is reusable only when it provably carries no work: at most one commit
 * (GitHub's auto-init) on the default branch, every other branch pointing at that
 * same commit, and the requested visibility. Returns the reason when it is not.
 */
async function findReusableRepo(
    octokit: Octokit,
    owner: string,
    repoName: string,
    isPrivate: boolean,
): Promise<CreateRepoResult | string> {
    const { data: repo } = await octokit.repos.get({ owner, repo: repoName });
    if (repo.private !== isPrivate) return `is ${repo.private ? 'private' : 'public'}`;
    const defaultBranch = repo.default_branch ?? 'main';

    let commits: Array<{ sha: string }> = [];
    try {
        ({ data: commits } = await octokit.repos.listCommits({ owner, repo: repoName, sha: defaultBranch, per_page: 2 }));
    } catch (err: any) {
        if (err?.status !== 409) throw err; // 409 = "Git Repository is empty"
    }
    if (commits.length > 1) return 'contains work';

    const { data: branches } = await octokit.repos.listBranches({ owner, repo: repoName, per_page: 100 });
    if (branches.some(b => b.commit.sha !== commits[0]?.sha)) return 'contains work on other branches';

    return { fullName: repo.full_name, htmlUrl: repo.html_url, cloneUrl: repo.clone_url, defaultBranch };
}

/**
 * Validate that a GitHub repository exists and is accessible with the given token.
 */
export async function validateGitHubRepo(
    token: string,
    owner: string,
    repoName: string,
): Promise<ValidateRepoResult> {
    // In local mode, always return "exists" with synthetic data
    if (GITHUB_MODE === 'local') {
        logger.info(`[local] Synthetic validateGitHubRepo: ${owner}/${repoName}`);
        return {
            exists: true,
            fullName: `${owner}/${repoName}`,
            htmlUrl: `local://repos/${owner}/${repoName}`,
            cloneUrl: `local://repos/${owner}/${repoName}.git`,
            defaultBranch: 'main',
            private: false,
        };
    }

    const octokit = traceOctokit(new Octokit({ auth: token }), 'github');

    logger.info(`Validating repo: ${owner}/${repoName}`);

    try {
        const { data } = await octokit.repos.get({ owner, repo: repoName });
        logger.info(`Repo validated: ${data.full_name} (${data.private ? 'private' : 'public'})`);

        return {
            exists: true,
            fullName: data.full_name,
            htmlUrl: data.html_url,
            cloneUrl: data.clone_url,
            defaultBranch: data.default_branch ?? 'main',
            private: data.private,
        };
    } catch (err: any) {
        if (err.status === 404) {
            logger.warn(`Repo not found: ${owner}/${repoName}`);
            return {
                exists: false,
                fullName: `${owner}/${repoName}`,
                htmlUrl: '',
                cloneUrl: '',
                defaultBranch: 'main',
                private: false,
            };
        }
        throw err;
    }
}

/**
 * Initialize a local workspace directory as a fresh git repo with a remote.
 *
 * - Runs `git init` in the workspace
 * - Configures committer identity
 * - Adds the remote origin (with token embedded for push access)
 * - Creates an initial commit on the given default branch
 */
export function initializeRepoLocally(
    workspacePath: string,
    remoteUrl: string,
    defaultBranch: string = 'main',
    token?: string,
): void {
    const run = (args: string[]) =>
        execFileSync('git', args, { cwd: workspacePath, stdio: 'pipe' }).toString().trim();

    logger.info(`Initializing local repo at: ${workspacePath}`);

    run(['init', '-b', defaultBranch]);
    run(['config', 'user.name', GIT_USER_NAME]);
    run(['config', 'user.email', GIT_USER_EMAIL]);

    // Add the remote without embedding the token in the URL.
    // Authentication is handled per-command via http.extraHeader
    // (see gitPush in git-exec.ts) so the PAT never lands in .git/config.
    run(['remote', 'add', 'origin', remoteUrl]);

    if (token) {
        // Store auth as a credential helper config entry (stays in .git/config
        // but is more contained than putting the token in the URL itself).
        const encodedToken = Buffer.from(`x-access-token:${token}`).toString('base64');
        run(['config', `http.${remoteUrl}.extraHeader`, `Authorization: Basic ${encodedToken}`]);
    }

    // Create initial commit (empty or with existing files)
    run(['add', '-A']);

    // Only commit if there are staged changes
    try {
        run(['diff', '--cached', '--quiet']);
        // No changes — create an empty initial commit
        run(['commit', '--allow-empty', '-m', 'Initial commit']);
    } catch {
        // There are staged changes
        run(['commit', '-m', 'Initial commit']);
    }

    logger.info(`Local repo initialized on branch: ${defaultBranch}`);
}
