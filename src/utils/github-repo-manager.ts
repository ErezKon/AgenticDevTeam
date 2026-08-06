/**
 * GitHub repository management utility for multi-repo targeting.
 *
 * Provides functions to create new GitHub repos, validate existing ones,
 * and initialize local git workspaces with a remote.
 * Uses @octokit/rest (already a project dependency).
 */
import { Octokit } from '@octokit/rest';
import { execSync } from 'child_process';
import { GIT_USER_NAME, GIT_USER_EMAIL } from '../config';
import { getLogger } from './logger';
import { GITHUB_MODE } from './github-local';

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

    const octokit = new Octokit({ auth: token });

    // Determine if the owner is the authenticated user or an org
    const { data: authedUser } = await octokit.users.getAuthenticated();
    const isUserRepo = authedUser.login.toLowerCase() === owner.toLowerCase();

    logger.info(`Creating ${isPrivate ? 'private' : 'public'} repo: ${owner}/${repoName}`);

    let data: any;
    if (isUserRepo) {
        const response = await octokit.repos.createForAuthenticatedUser({
            name: repoName,
            private: isPrivate,
            auto_init: true,
        });
        data = response.data;
    } else {
        const response = await octokit.repos.createInOrg({
            org: owner,
            name: repoName,
            private: isPrivate,
            auto_init: true,
        });
        data = response.data;
    }

    logger.info(`Repo created: ${data.full_name} (${data.html_url})`);

    return {
        fullName: data.full_name,
        htmlUrl: data.html_url,
        cloneUrl: data.clone_url,
        defaultBranch: data.default_branch ?? 'main',
    };
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

    const octokit = new Octokit({ auth: token });

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
    const run = (cmd: string) =>
        execSync(cmd, { cwd: workspacePath, stdio: 'pipe' }).toString().trim();

    logger.info(`Initializing local repo at: ${workspacePath}`);

    run(`git init -b ${defaultBranch}`);
    run(`git config user.name "${GIT_USER_NAME}"`);
    run(`git config user.email "${GIT_USER_EMAIL}"`);

    // Build the authenticated remote URL if a token is provided
    const authenticatedUrl = token
        ? remoteUrl.replace('https://', `https://x-access-token:${token}@`)
        : remoteUrl;

    run(`git remote add origin ${authenticatedUrl}`);

    // Create initial commit (empty or with existing files)
    run('git add -A');

    // Only commit if there are staged changes
    try {
        run('git diff --cached --quiet');
        // No changes — create an empty initial commit
        run('git commit --allow-empty -m "Initial commit"');
    } catch {
        // There are staged changes
        run('git commit -m "Initial commit"');
    }

    logger.info(`Local repo initialized on branch: ${defaultBranch}`);
}
