/**
 * Minimal local stand-in for the GitHub REST API, backed by a bare git repo
 * used as `origin`.
 *
 * Implements only what pr-workflow.ts and github-repo-manager.ts call:
 *   pulls.create / pulls.merge / pulls.get / issues.createComment /
 *   pulls.createReview / git.deleteRef / repos.get / repos.createForAuthenticatedUser.
 *
 * `pulls.merge` performs a real `git merge --squash` in a scratch clone and
 * pushes the result, so the merged tree -- and therefore Sub-Plan 1's workspace
 * sync -- behaves exactly as it does against real GitHub.
 *
 * This is the other half of offline determinism (alongside llm-cassette.ts).
 * It has standalone product value: today the system cannot run at all without
 * a GitHub account and a PAT.
 */
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getLogger } from './logger';

const log = getLogger('[github-local]', 183);

// ─── Configuration ──────────────────────────────────────────────────────────

export type GitHubMode = 'live' | 'local';

export const GITHUB_MODE: GitHubMode =
    (process.env.GITHUB_MODE as GitHubMode) ?? 'live';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Minimal shape that matches what pr-workflow.ts and github-repo-manager.ts consume. */
export interface OctokitLike {
    pulls: {
        create: (params: { owner: string; repo: string; title: string; body: string; head: string; base: string }) => Promise<{ data: { number: number; html_url: string; node_id: string } }>;
        merge: (params: { owner: string; repo: string; pull_number: number; merge_method?: string }) => Promise<{ data: { merged: boolean; sha: string } }>;
        get: (params: { owner: string; repo: string; pull_number: number }) => Promise<{ data: { number: number; state: string; merged: boolean; title: string; html_url: string } }>;
        list: (params: { owner: string; repo: string; head?: string; state?: string }) => Promise<{ data: Array<{ number: number; html_url: string; node_id: string; state: string; title: string }> }>;
    };
    issues: {
        createComment: (params: { owner: string; repo: string; issue_number: number; body: string }) => Promise<{ data: { id: number } }>;
    };
    git: {
        deleteRef: (params: { owner: string; repo: string; ref: string }) => Promise<void>;
    };
    repos: {
        get: (params: { owner: string; repo: string }) => Promise<{ data: { full_name: string; html_url: string; clone_url: string; default_branch: string; private: boolean } }>;
        createForAuthenticatedUser: (params: { name: string; private?: boolean; auto_init?: boolean }) => Promise<{ data: { full_name: string; html_url: string; clone_url: string; default_branch: string } }>;
    };
    users: {
        getAuthenticated: () => Promise<{ data: { login: string } }>;
    };
}

interface LocalPR {
    number: number;
    title: string;
    body: string;
    head: string;
    base: string;
    state: 'open' | 'closed' | 'merged';
    merged: boolean;
    mergeSha?: string;
    comments: Array<{ id: number; body: string }>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function gitLocal(cwd: string, args: string): string {
    try {
        return execSync(`git ${args}`, {
            cwd, encoding: 'utf-8',
            timeout: 30_000, maxBuffer: 1024 * 1024 * 5,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0',
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_AUTHOR_NAME: 'LocalGitHub',
                GIT_AUTHOR_EMAIL: 'local@github.local',
                GIT_COMMITTER_NAME: 'LocalGitHub',
                GIT_COMMITTER_EMAIL: 'local@github.local',
            },
        }).trim();
    } catch (err: any) {
        return `Error: ${err.stderr?.toString() ?? err.message}`.trim();
    }
}

// ─── Local GitHub factory ───────────────────────────────────────────────────

/**
 * Create a minimal local stand-in for GitHub's REST API.
 *
 * All state is stored in memory and in the bare repo at `bareRepoPath`.
 * PR numbers are monotonic and stable within a single process.
 *
 * @param bareRepoPath  Path to a bare git repo (e.g. `<OUTPUTS_DIR>/<run>/origin.git`)
 */
export function createLocalGitHub(bareRepoPath: string): OctokitLike {
    // PR counter persisted in the bare repo's config
    let nextPRNumber = 1;
    try {
        const stored = gitLocal(bareRepoPath, 'config --get localgithub.nextpr');
        if (stored && !stored.startsWith('Error:')) {
            nextPRNumber = parseInt(stored, 10) || 1;
        }
    } catch { /* first use */ }

    const prs = new Map<number, LocalPR>();
    let commentCounter = 1;

    function persistPRCounter(): void {
        gitLocal(bareRepoPath, `config localgithub.nextpr ${nextPRNumber}`);
    }

    return {
        pulls: {
            async create({ title, body, head, base }) {
                const prNumber = nextPRNumber++;
                persistPRCounter();

                const pr: LocalPR = {
                    number: prNumber,
                    title,
                    body,
                    head,
                    base,
                    state: 'open',
                    merged: false,
                    comments: [],
                };
                prs.set(prNumber, pr);

                log.info(`[local] PR #${prNumber} created: "${title}" (${head} -> ${base})`);
                return {
                    data: {
                        number: prNumber,
                        html_url: `local://pr/${prNumber}`,
                        node_id: `local-pr-${prNumber}`,
                    },
                };
            },

            async merge({ pull_number, merge_method }) {
                const pr = prs.get(pull_number);
                if (!pr) throw new Error(`PR #${pull_number} not found`);
                if (pr.merged) throw new Error(`PR #${pull_number} already merged`);

                // Perform a real squash merge in a scratch clone
                const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localgithub-merge-'));
                try {
                    gitLocal(scratchDir, `clone "${bareRepoPath}" .`);
                    gitLocal(scratchDir, `checkout ${pr.base}`);

                    // Merge the head branch into base
                    const method = merge_method ?? 'squash';
                    let mergeResult: string;
                    if (method === 'squash') {
                        mergeResult = gitLocal(scratchDir, `merge --squash origin/${pr.head}`);
                        if (mergeResult.startsWith('Error:')) {
                            throw new Error(`Squash merge failed: ${mergeResult}`);
                        }
                        const commitResult = gitLocal(scratchDir, `commit -m "${pr.title} (#${pr.number})"`);
                        if (commitResult.startsWith('Error:')) {
                            // May have "nothing to commit" — that's OK (git may
                            // output the message on stdout or stderr depending on version)
                            const lower = commitResult.toLowerCase();
                            if (!lower.includes('nothing to commit') && !lower.includes('no changes added')) {
                                // Last resort: check `git status` for confirmation
                                const status = gitLocal(scratchDir, 'status --porcelain');
                                if (status && !status.startsWith('Error:')) {
                                    throw new Error(`Merge commit failed: ${commitResult}`);
                                }
                                // Empty status means working tree is clean — nothing to commit is fine
                            }
                        }
                    } else {
                        mergeResult = gitLocal(scratchDir, `merge origin/${pr.head} --no-edit`);
                        if (mergeResult.startsWith('Error:')) {
                            throw new Error(`Merge failed: ${mergeResult}`);
                        }
                    }

                    // Push the merged base branch back to the bare repo
                    const pushResult = gitLocal(scratchDir, `push origin ${pr.base}`);
                    if (pushResult.startsWith('Error:')) {
                        throw new Error(`Push after merge failed: ${pushResult}`);
                    }

                    const sha = gitLocal(scratchDir, 'rev-parse HEAD');

                    pr.state = 'closed';
                    pr.merged = true;
                    pr.mergeSha = sha;

                    log.info(`[local] PR #${pull_number} merged (${method}): ${sha.slice(0, 8)}`);
                    return { data: { merged: true, sha } };
                } finally {
                    fs.rmSync(scratchDir, { recursive: true, force: true });
                }
            },

            async get({ pull_number }) {
                const pr = prs.get(pull_number);
                if (!pr) throw new Error(`PR #${pull_number} not found`);
                return {
                    data: {
                        number: pr.number,
                        state: pr.state,
                        merged: pr.merged,
                        title: pr.title,
                        html_url: `local://pr/${pr.number}`,
                    },
                };
            },

            async list({ head, state: filterState }) {
                const results: Array<{ number: number; html_url: string; node_id: string; state: string; title: string; head: { ref: string } }> = [];
                for (const pr of prs.values()) {
                    // head filter: GitHub format is "owner:branchName", but we
                    // also match bare branch names for convenience.
                    if (head) {
                        const headBranch = head.includes(':') ? head.split(':').pop()! : head;
                        if (pr.head !== headBranch) continue;
                    }
                    if (filterState && pr.state !== filterState) continue;
                    results.push({
                        number: pr.number,
                        html_url: `local://pr/${pr.number}`,
                        node_id: `local-pr-${pr.number}`,
                        state: pr.state,
                        title: pr.title,
                        head: { ref: pr.head },
                    });
                }
                return { data: results };
            },
        },

        issues: {
            async createComment({ issue_number, body }) {
                const pr = prs.get(issue_number);
                const id = commentCounter++;
                if (pr) {
                    pr.comments.push({ id, body });
                }
                return { data: { id } };
            },
        },

        git: {
            async deleteRef({ ref }) {
                // Delete the branch from the bare repo
                const branchName = ref.replace(/^heads\//, '');
                const result = gitLocal(bareRepoPath, `branch -D ${branchName}`);
                if (result.startsWith('Error:') && !result.includes('not found')) {
                    log.warn(`[local] deleteRef ${ref}: ${result}`);
                } else {
                    log.info(`[local] Deleted ref: ${ref}`);
                }
            },
        },

        repos: {
            async get({ owner, repo }) {
                return {
                    data: {
                        full_name: `${owner}/${repo}`,
                        html_url: `local://repos/${owner}/${repo}`,
                        clone_url: bareRepoPath,
                        default_branch: 'main',
                        private: false,
                    },
                };
            },

            async createForAuthenticatedUser({ name, auto_init }) {
                // The bare repo already exists (created by intakeNode in local mode)
                if (auto_init && !fs.existsSync(bareRepoPath)) {
                    gitLocal(path.dirname(bareRepoPath), `init --bare "${bareRepoPath}"`);
                }
                return {
                    data: {
                        full_name: `local/${name}`,
                        html_url: `local://repos/local/${name}`,
                        clone_url: bareRepoPath,
                        default_branch: 'main',
                    },
                };
            },
        },

        users: {
            async getAuthenticated() {
                return { data: { login: 'local-user' } };
            },
        },
    };
}
