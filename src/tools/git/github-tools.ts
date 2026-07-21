/**
 * GitHub API tools for PR management.
 *
 * Wraps @octokit/rest to create PRs, post reviews, merge, etc.
 * Reads GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO from config.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { Octokit } from '@octokit/rest';
import { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GIT_DEFAULT_BRANCH } from '../../config';
import { LogColors, color256 } from '../../utils/log-colors.util';

const TAG_COLOR = 240;
const TAG = `${color256(TAG_COLOR)}[GitHub]${LogColors.RESET}`;

function getOctokit(): Octokit {
    if (!GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN is not set. Cannot perform GitHub API operations.');
    }
    return new Octokit({ auth: GITHUB_TOKEN });
}

/**
 * Create GitHub API tools for PR management.
 */
export function createGitHubTools() {
    const owner = GITHUB_OWNER;
    const repo = GITHUB_REPO;

    const githubCreatePrTool = tool(
        async ({ title, body, head, base }) => {
            console.log(`${TAG} Creating PR: "${title}" (${head} → ${base ?? GIT_DEFAULT_BRANCH})`);
            const octokit = getOctokit();
            const { data } = await octokit.pulls.create({
                owner,
                repo,
                title,
                body: body ?? '',
                head,
                base: base ?? GIT_DEFAULT_BRANCH,
            });
            console.log(`${TAG} PR #${data.number} created: ${data.html_url}`);
            return JSON.stringify({
                prNumber: data.number,
                prUrl: data.html_url,
                state: data.state,
            });
        },
        {
            name: 'github_create_pr',
            description: 'Create a Pull Request on GitHub. Returns the PR number and URL.',
            schema: z.object({
                title: z.string().describe('PR title'),
                body: z.string().optional().describe('PR description (Markdown)'),
                head: z.string().describe('Source branch name'),
                base: z.string().optional().describe('Target branch (default: main/master from config)'),
            }),
        }
    );

    const githubGetPrStatusTool = tool(
        async ({ prNumber }) => {
            console.log(`${TAG} Getting status of PR #${prNumber}`);
            const octokit = getOctokit();
            const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
            const { data: reviews } = await octokit.pulls.listReviews({ owner, repo, pull_number: prNumber });

            const reviewSummary = reviews.map((r: any) => ({
                user: r.user?.login,
                state: r.state,
                submittedAt: r.submitted_at,
            }));

            return JSON.stringify({
                state: pr.state,
                merged: pr.merged,
                mergeable: pr.mergeable,
                title: pr.title,
                reviews: reviewSummary,
            });
        },
        {
            name: 'github_get_pr_status',
            description: 'Get the current status of a PR including review states.',
            schema: z.object({
                prNumber: z.number().describe('Pull request number'),
            }),
        }
    );

    const githubListPrCommentsTool = tool(
        async ({ prNumber }) => {
            console.log(`${TAG} Listing comments on PR #${prNumber}`);
            const octokit = getOctokit();
            const { data: reviewComments } = await octokit.pulls.listReviewComments({
                owner, repo, pull_number: prNumber,
            });
            const { data: issueComments } = await octokit.issues.listComments({
                owner, repo, issue_number: prNumber,
            });

            const comments = [
                ...reviewComments.map((c: any) => ({
                    type: 'review_comment',
                    user: c.user?.login,
                    body: c.body,
                    path: c.path,
                    line: c.line,
                    createdAt: c.created_at,
                })),
                ...issueComments.map((c: any) => ({
                    type: 'issue_comment',
                    user: c.user?.login,
                    body: c.body,
                    createdAt: c.created_at,
                })),
            ];

            return JSON.stringify(comments);
        },
        {
            name: 'github_list_pr_comments',
            description: 'List all review comments and general comments on a PR.',
            schema: z.object({
                prNumber: z.number().describe('Pull request number'),
            }),
        }
    );

    const githubPostPrReviewTool = tool(
        async ({ prNumber, body, event, comments }) => {
            console.log(`${TAG} Posting ${event} review on PR #${prNumber}`);
            const octokit = getOctokit();

            const reviewParams: any = {
                owner,
                repo,
                pull_number: prNumber,
                body: body ?? '',
                event: event,
            };

            if (comments && comments.length > 0) {
                // Get the latest commit SHA for the PR
                const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
                reviewParams.commit_id = pr.head.sha;
                reviewParams.comments = comments.map((c: any) => ({
                    path: c.path,
                    line: c.line ?? 1,
                    body: c.body,
                }));
            }

            const { data } = await octokit.pulls.createReview(reviewParams);
            console.log(`${TAG} Review posted: ${event} (ID: ${data.id})`);
            return JSON.stringify({
                reviewId: data.id,
                state: data.state,
            });
        },
        {
            name: 'github_post_pr_review',
            description: 'Post a review on a PR. Use APPROVE to approve, REQUEST_CHANGES to request changes, or COMMENT for a neutral review.',
            schema: z.object({
                prNumber: z.number().describe('Pull request number'),
                body: z.string().optional().describe('Overall review comment'),
                event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).describe('Review decision'),
                comments: z.array(z.object({
                    path: z.string().describe('File path relative to repo root'),
                    line: z.number().optional().describe('Line number in the diff'),
                    body: z.string().describe('Comment text'),
                })).optional().describe('Inline comments on specific files/lines'),
            }),
        }
    );

    const githubPostPrCommentTool = tool(
        async ({ prNumber, body }) => {
            console.log(`${TAG} Posting comment on PR #${prNumber}`);
            const octokit = getOctokit();
            const { data } = await octokit.issues.createComment({
                owner, repo, issue_number: prNumber, body,
            });
            return JSON.stringify({ commentId: data.id, url: data.html_url });
        },
        {
            name: 'github_post_pr_comment',
            description: 'Post a general comment on a PR (not a code review).',
            schema: z.object({
                prNumber: z.number().describe('Pull request number'),
                body: z.string().describe('Comment text (Markdown)'),
            }),
        }
    );

    const githubMergePrTool = tool(
        async ({ prNumber, mergeMethod }) => {
            const method = mergeMethod ?? 'squash';
            console.log(`${TAG} Merging PR #${prNumber} (method: ${method})`);
            const octokit = getOctokit();
            const { data } = await octokit.pulls.merge({
                owner, repo, pull_number: prNumber,
                merge_method: method,
            });
            console.log(`${TAG} PR #${prNumber} merged: ${data.sha}`);
            return JSON.stringify({
                merged: data.merged,
                sha: data.sha,
                message: data.message,
            });
        },
        {
            name: 'github_merge_pr',
            description: 'Merge a pull request. Use squash for a clean commit history.',
            schema: z.object({
                prNumber: z.number().describe('Pull request number'),
                mergeMethod: z.enum(['merge', 'squash', 'rebase']).optional().describe('Merge method (default: squash)'),
            }),
        }
    );

    return [
        githubCreatePrTool,
        githubGetPrStatusTool,
        githubListPrCommentsTool,
        githubPostPrReviewTool,
        githubPostPrCommentTool,
        githubMergePrTool,
    ];
}
