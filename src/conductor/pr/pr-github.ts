/**
 * GitHub API operations — Octokit wrapper, PR creation, merge, branch cleanup.
 *
 * Extracted from pr-workflow.ts (Sub-Plan 26-08).
 */
import { execSync } from 'child_process';
import { Octokit } from '@octokit/rest';
import { getLogger } from '../../utils/logger';
import { emitRunEvent } from '../../utils/event-bus';
import { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } from '../../config';
import { GITHUB_MODE, createLocalGitHub } from '../../utils/github-local';
import { classifyPrFailure, isFatalPrFailure } from '../pr-failure';
import type { GitContext, PullRequest } from '../../agents/_shared/base-schemas';

const log = getLogger('[PR-Workflow]', 135);

/** Local-mode bare repo path, resolved once per process from gitContext. */
let _localBareRepoPath: string | null = null;

/** Set the bare repo path for local GitHub mode (called by intakeNode). */
export function setLocalBareRepoPath(p: string): void {
    _localBareRepoPath = p;
}

export function getOctokit(gitContext?: GitContext | null): Octokit {
    if (GITHUB_MODE === 'local') {
        // Return a local GitHub stand-in backed by a bare repo
        const bareRepoPath = _localBareRepoPath ?? gitContext?.repo ?? '';
        return createLocalGitHub(bareRepoPath) as unknown as Octokit;
    }
    const token = gitContext?.token ?? GITHUB_TOKEN;
    if (!token) {
        throw new Error('GITHUB_TOKEN is not set. Cannot perform GitHub API operations.');
    }
    return new Octokit({ auth: token });
}

/**
 * Create a GitHub PR using curl as a fallback when Octokit fails.
 * This avoids Node.js HTTP stack issues with corporate SSL proxies.
 */
export function createPRViaCurl(title: string, body: string, head: string, base: string, gitContext?: GitContext | null): { number: number; html_url: string; node_id: string } {
    const token = gitContext?.token ?? GITHUB_TOKEN;
    const owner = gitContext?.owner ?? GITHUB_OWNER;
    const repo = gitContext?.repo ?? GITHUB_REPO;
    const payload = JSON.stringify({ title, body, head, base });
    const result = execSync(
        `curl -s -X POST "https://api.github.com/repos/${owner}/${repo}/pulls" `
        + `-H "Authorization: token ${token}" `
        + `-H "Accept: application/vnd.github+json" `
        + `-H "Content-Type: application/json" `
        + `--data-binary @-`,
        { encoding: 'utf-8', timeout: 30_000, input: payload },
    ).trim();
    const data = JSON.parse(result);
    if (data.message) {
        throw new Error(`GitHub API error: ${data.message} (${JSON.stringify(data.errors ?? [])})`);
    }
    return { number: data.number, html_url: data.html_url, node_id: data.node_id };
}

/**
 * Find an existing open PR for the given head branch to avoid 422 errors.
 *
 * Plan 24, A1: the bare-ref fallback is gated on local mode only. In live
 * GitHub mode, `pulls.list({ head: 'branch' })` without the `owner:` prefix
 * is not a head filter — it silently returns the full open-PR list and
 * `data[0]` is whatever PR was opened first. This attached nine branches to
 * the wrong PR in the pacmanclaude run.
 *
 * Both modes validate unconditionally: a candidate is accepted only when
 * `pr.head?.ref === head` (the local stand-in stores `head` as the bare
 * branch name, so one predicate covers both).
 */
export async function findExistingPR(
    octokit: any, owner: string, repo: string, head: string,
): Promise<{ number: number; html_url: string; node_id: string; head?: { ref: string } } | null> {
    try {
        const headRef = `${owner}:${head}`;
        const { data } = await octokit.pulls.list({ owner, repo, head: headRef, state: 'open' });
        for (const pr of data) {
            // Validate: candidate's actual head must match the requested branch
            const prHeadRef = pr.head?.ref ?? pr.head;
            if (prHeadRef === head) {
                log.info(`Found existing open PR #${pr.number} for ${head}`);
                return { number: pr.number, html_url: pr.html_url, node_id: pr.node_id ?? `pr-${pr.number}`, head: { ref: prHeadRef } };
            }
            log.warn(`Rejected PR #${pr.number}: head '${prHeadRef}' !== requested '${head}'`);
        }
        // Bare-ref fallback: only in local mode (Plan 24, A1)
        if (GITHUB_MODE === 'local') {
            const { data: data2 } = await octokit.pulls.list({ owner, repo, head, state: 'open' });
            for (const pr of data2) {
                const prHeadRef = pr.head?.ref ?? pr.head;
                if (prHeadRef === head) {
                    log.info(`Found existing open PR #${pr.number} for ${head} (bare)`);
                    return { number: pr.number, html_url: pr.html_url, node_id: pr.node_id ?? `pr-${pr.number}`, head: { ref: prHeadRef } };
                }
                log.warn(`Rejected PR #${pr.number} (bare): head '${prHeadRef}' !== requested '${head}'`);
            }
        }
    } catch (err: any) {
        log.warn(`Failed to list existing PRs: ${err.message}`);
    }
    return null;
}

/**
 * PR identity mismatch error — thrown when the PR about to be merged or
 * whose branch is about to be deleted has a different head than expected.
 * Plan 24, A1: this is the assertion that would have prevented the deletion
 * of `us-010-screen-manager` in the pacmanclaude run.
 */
export class PrIdentityMismatchError extends Error {
    constructor(public readonly prNumber: number, public readonly expectedHead: string, public readonly actualHead: string) {
        super(`PR #${prNumber} head mismatch: expected '${expectedHead}', got '${actualHead}'`);
        this.name = 'PrIdentityMismatchError';
    }
}

/**
 * Create a GitHub PR with retry logic, curl fallback, and existing-PR reuse.
 * Returns the PR data on success, or null if creation failed after all retries.
 */
export async function createOrReusePR(
    octokit: any,
    ghOwner: string,
    ghRepo: string,
    branchName: string,
    baseBranch: string,
    prTitle: string,
    prBody: string,
    gitContext?: GitContext | null,
): Promise<{ number: number; html_url: string; node_id: string; head?: { ref: string } } | null> {
    // Sub-Plan 06 §4: Check for existing open PR before creating (prevents 422 deadlock)
    const existingPR = await findExistingPR(octokit, ghOwner, ghRepo, branchName);
    if (existingPR) {
        log.info(`Reusing existing PR #${existingPR.number} for ${branchName}`);
        // Update the PR body with current changes
        try {
            await octokit.pulls.update({
                owner: ghOwner, repo: ghRepo,
                pull_number: existingPR.number,
                body: prBody,
            });
        } catch (updateErr: any) {
            log.warn(`Failed to update existing PR body: ${updateErr.message}`);
        }
        return existingPR;
    }

    // Retry loop for transient GitHub failures (server-error, network, rate-limit)
    const PR_CREATE_MAX_RETRIES = 3;
    const PR_CREATE_BASE_DELAY_MS = 2_000;
    let prCreationFailed: Error | null = null;
    let ghPr: { number: number; html_url: string; node_id: string; head?: { ref: string } } | null = null;

    for (let attempt = 1; attempt <= PR_CREATE_MAX_RETRIES; attempt++) {
        try {
            const { data } = await octokit.pulls.create({
                owner: ghOwner,
                repo: ghRepo,
                title: prTitle,
                body: prBody,
                head: branchName,
                base: baseBranch,
            });
            ghPr = { number: data.number, html_url: data.html_url, node_id: data.node_id };
            break; // success
        } catch (octokitErr: any) {
            // Sub-Plan 06 §4: classify the error
            const classification = classifyPrFailure(octokitErr);

            // Auth errors are fatal — stop the entire run
            if (isFatalPrFailure(classification)) {
                throw new Error(`Fatal PR error (${classification.kind}): ${classification.message}`);
            }

            // pr-already-exists: list and reuse instead of falling back to curl
            if (classification.kind === 'pr-already-exists') {
                const reusePR = await findExistingPR(octokit, ghOwner, ghRepo, branchName);
                if (reusePR) {
                    ghPr = reusePR;
                    log.info(`Reusing existing PR #${ghPr.number} after 422`);
                } else {
                    prCreationFailed = octokitErr;
                }
                break;
            } else if (GITHUB_MODE === 'local') {
                // In local mode, Octokit is a local stand-in — do not fall back to curl
                prCreationFailed = octokitErr;
                break;
            } else {
                log.warn(`Octokit PR creation failed (${classification.kind}), falling back to curl`);
                try {
                    ghPr = createPRViaCurl(prTitle, prBody, branchName, baseBranch, gitContext);
                    break; // curl succeeded
                } catch (curlErr: any) {
                    const curlClassification = classifyPrFailure(curlErr);
                    if (curlClassification.kind === 'pr-already-exists') {
                        const reusePR = await findExistingPR(octokit, ghOwner, ghRepo, branchName);
                        if (reusePR) {
                            ghPr = reusePR;
                            log.info(`Reusing existing PR #${ghPr.number} after curl 422`);
                        } else {
                            prCreationFailed = curlErr;
                        }
                        break;
                    } else if (curlClassification.retryable && attempt < PR_CREATE_MAX_RETRIES) {
                        const delay = PR_CREATE_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                        log.warn(`PR creation attempt ${attempt}/${PR_CREATE_MAX_RETRIES} failed (${curlClassification.kind}) — retrying in ${delay}ms`);
                        await new Promise(r => setTimeout(r, delay));
                        prCreationFailed = curlErr; // will be cleared if next attempt succeeds
                        continue; // retry the whole attempt
                    } else {
                        prCreationFailed = curlErr;
                        break;
                    }
                }
            }
        }
    }

    if (prCreationFailed) {
        const failMsg = prCreationFailed.message || String(prCreationFailed);
        log.error(`PR creation failed after ${PR_CREATE_MAX_RETRIES} attempts: ${failMsg}`);
        return null;
    }

    return ghPr;
}

/**
 * Retry PR creation for a branch that had `pr-creation-failed` status.
 * The branch code is already pushed — this only creates the GitHub PR.
 * Returns the updated PullRequest with a real PR number on success,
 * or re-throws on failure so the caller can stop gracefully.
 */
export async function retryFailedPRCreation(
    failedPR: PullRequest,
    baseBranch: string,
    gitContext?: GitContext | null,
): Promise<PullRequest> {
    const ghOwner = gitContext?.owner ?? GITHUB_OWNER;
    const ghRepo = gitContext?.repo ?? GITHUB_REPO;
    const octokit = getOctokit(gitContext);
    const branchName = failedPR.branchName;

    log.info(`Retrying PR creation for branch ${branchName}...`);

    // Check if a PR was created manually or by a previous retry
    const existingPR = await findExistingPR(octokit, ghOwner, ghRepo, branchName);
    if (existingPR) {
        log.info(`Found existing PR #${existingPR.number} for ${branchName} — reusing`);
        return {
            ...failedPR,
            id: `PR-${existingPR.number}`,
            prNumber: existingPR.number,
            prUrl: existingPR.html_url,
            status: 'open',
        };
    }

    // Retry with the same retry/backoff logic
    const PR_RETRY_MAX = 3;
    const PR_RETRY_BASE_DELAY_MS = 2_000;
    let lastErr: Error | null = null;

    for (let attempt = 1; attempt <= PR_RETRY_MAX; attempt++) {
        try {
            const { data } = await octokit.pulls.create({
                owner: ghOwner,
                repo: ghRepo,
                title: failedPR.title,
                body: failedPR.description,
                head: branchName,
                base: baseBranch,
            });
            log.info(`PR #${data.number} created on retry for ${branchName}`);
            emitRunEvent('pr:opened', { prNumber: data.number, title: failedPR.title, branch: branchName, baseBranch });
            return {
                ...failedPR,
                id: `PR-${data.number}`,
                prNumber: data.number,
                prUrl: data.html_url,
                status: 'open',
            };
        } catch (err: any) {
            const classification = classifyPrFailure(err);
            if (isFatalPrFailure(classification)) {
                throw new Error(`Fatal PR error on retry (${classification.kind}): ${classification.message}`);
            }
            if (classification.kind === 'pr-already-exists') {
                const reusePR = await findExistingPR(octokit, ghOwner, ghRepo, branchName);
                if (reusePR) {
                    return {
                        ...failedPR,
                        id: `PR-${reusePR.number}`,
                        prNumber: reusePR.number,
                        prUrl: reusePR.html_url,
                        status: 'open',
                    };
                }
            }

            lastErr = err;
            if (classification.retryable && attempt < PR_RETRY_MAX) {
                const delay = PR_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                log.warn(`PR retry attempt ${attempt}/${PR_RETRY_MAX} failed (${classification.kind}) — retrying in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    // All retries failed — throw so the caller can stop gracefully again
    throw lastErr ?? new Error(`PR creation retry failed for ${branchName}`);
}

/**
 * Merge a PR via squash, delete the remote branch, and return success status.
 */
export async function mergePr(
    octokit: any,
    ghOwner: string,
    ghRepo: string,
    ghPr: { number: number; head?: { ref: string } },
    branchName: string,
    baseBranch: string,
): Promise<boolean> {
    try {
        await octokit.pulls.merge({
            owner: ghOwner,
            repo: ghRepo,
            pull_number: ghPr.number,
            merge_method: 'squash',
        });
        log.info(`PR #${ghPr.number} merged to ${baseBranch}`);
        emitRunEvent('pr:merged', { prNumber: ghPr.number, branch: branchName, baseBranch });

        // Delete the remote feature branch
        try {
            await octokit.git.deleteRef({
                owner: ghOwner,
                repo: ghRepo,
                ref: `heads/${branchName}`,
            });
            log.info(`Deleted remote branch: ${branchName}`);
        } catch (delErr: any) {
            log.warn(`Failed to delete remote branch ${branchName}: ${delErr.message}`);
        }
        return true;
    } catch (err: any) {
        log.error(`Merge failed: ${err.message}`);
        return false;
    }
}

/**
 * Post a comment on a GitHub issue/PR.
 */
export async function postComment(
    octokit: any,
    ghOwner: string,
    ghRepo: string,
    issueNumber: number,
    body: string,
): Promise<void> {
    try {
        await octokit.issues.createComment({
            owner: ghOwner, repo: ghRepo,
            issue_number: issueNumber, body,
        });
    } catch (commentErr: any) {
        log.warn(`Failed to post comment: ${commentErr.message}`);
    }
}
