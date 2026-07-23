/**
 * Workspace-scoped Git CLI tools for developer agents.
 *
 * Each tool wraps a git command executed via child_process with cwd
 * set to the workspace root. Used by developers (commit workflow)
 * and reviewers (diff inspection).
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { execSync } from 'child_process';
import { LogColors, color256 } from '../../utils/log-colors.util';
import { logToolAction } from '../../utils/logger';
import { GIT_DEFAULT_BRANCH, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } from '../../config';

const TAG_COLOR = 202;
const TAG = `${color256(TAG_COLOR)}[git]${LogColors.RESET}`;

/**
 * Run a git command in the workspace and return stdout.
 * Throws on non-zero exit (caught by the tool wrapper).
 */
function git(workspaceRoot: string, args: string): string {
    try {
        const result = execSync(`git ${args}`, {
            cwd: workspaceRoot,
            encoding: 'utf-8',
            timeout: 30_000,
            maxBuffer: 1024 * 1024 * 5,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        });
        return result.trim();
    } catch (err: any) {
        const stderr = err.stderr?.toString() ?? '';
        const stdout = err.stdout?.toString() ?? '';
        return `Error (exit ${err.status ?? 1}):\n${stderr}\n${stdout}`.trim();
    }
}

/**
 * Create workspace-scoped Git CLI tools.
 */
export function createGitTools(workspaceRoot: string) {
    const gitCheckoutBranchTool = tool(
        async ({ branchName, fromBranch }) => {
            const base = fromBranch ?? GIT_DEFAULT_BRANCH;
            logToolAction(`${TAG} checkout -b ${branchName} from ${base}`);
            // Ensure we're on the base branch and up to date first
            git(workspaceRoot, `checkout ${base}`);
            git(workspaceRoot, `pull origin ${base} --ff-only`);
            const result = git(workspaceRoot, `checkout -b ${branchName}`);
            return result || `Switched to new branch '${branchName}'`;
        },
        {
            name: 'git_checkout_branch',
            description: 'Create and switch to a new feature branch from the default branch (or a specified base). Pulls the latest base branch first.',
            schema: z.object({
                branchName: z.string().describe('Name of the new branch (e.g. "feature/US-001-user-auth")'),
                fromBranch: z.string().optional().describe('Base branch to branch from (default: main/master from config)'),
            }),
        }
    );

    const gitSwitchBranchTool = tool(
        async ({ branchName }) => {
            logToolAction(`${TAG} checkout ${branchName}`);
            const result = git(workspaceRoot, `checkout ${branchName}`);
            return result || `Switched to branch '${branchName}'`;
        },
        {
            name: 'git_switch_branch',
            description: 'Switch to an existing branch.',
            schema: z.object({
                branchName: z.string().describe('Name of the branch to switch to'),
            }),
        }
    );

    const gitAddTool = tool(
        async ({ paths }) => {
            const target = paths ?? '.';
            logToolAction(`${TAG} add ${target}`);
            const result = git(workspaceRoot, `add ${target}`);
            return result || `Staged: ${target}`;
        },
        {
            name: 'git_add',
            description: 'Stage files for commit. Use "." to stage all changes.',
            schema: z.object({
                paths: z.string().optional().describe('File paths to stage, space-separated (default: "." for all)'),
            }),
        }
    );

    const gitCommitTool = tool(
        async ({ message }) => {
            logToolAction(`${TAG} commit -m "${message.slice(0, 60)}..."`);
            const result = git(workspaceRoot, `commit -m "${message.replace(/"/g, '\\"')}"`);
            return result;
        },
        {
            name: 'git_commit',
            description: 'Commit staged changes. Use project commit format: [PROJECT-NAME]-[STORY-ID]-TYPE: description (e.g. "[simple-calculator]-[US-001]-feat: implement auth service").',
            schema: z.object({
                message: z.string().describe('Commit message in project format (e.g. "[simple-calculator]-[US-001]-feat: implement user authentication service")'),
            }),
        }
    );

    const gitPushTool = tool(
        async ({ branchName }) => {
            const branch = branchName ?? git(workspaceRoot, 'rev-parse --abbrev-ref HEAD');
            logToolAction(`${TAG} push ${branch}`);
            const authUrl = `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`;
            const result = git(workspaceRoot, `push ${authUrl} HEAD:refs/heads/${branch}`);
            return result || `Pushed branch '${branch}' to origin`;
        },
        {
            name: 'git_push',
            description: 'Push the current branch to origin. Automatically sets upstream tracking.',
            schema: z.object({
                branchName: z.string().optional().describe('Branch name to push (default: current branch)'),
            }),
        }
    );

    const gitStatusTool = tool(
        async () => {
            logToolAction(`${TAG} status --short`);
            const result = git(workspaceRoot, 'status --short');
            return result || '(working tree clean)';
        },
        {
            name: 'git_status',
            description: 'Show the current git status (modified, staged, untracked files).',
            schema: z.object({}),
        }
    );

    const gitDiffTool = tool(
        async ({ cached, filePath }) => {
            const args = ['diff'];
            if (cached) args.push('--cached');
            if (filePath) args.push('--', filePath);
            logToolAction(`${TAG} ${args.join(' ')}`);
            const result = git(workspaceRoot, args.join(' '));
            return result || '(no diff)';
        },
        {
            name: 'git_diff',
            description: 'Show file differences. Use cached=true to see staged changes.',
            schema: z.object({
                cached: z.boolean().optional().describe('Show staged (cached) changes instead of unstaged'),
                filePath: z.string().optional().describe('Limit diff to a specific file'),
            }),
        }
    );

    const gitCurrentBranchTool = tool(
        async () => {
            logToolAction(`${TAG} rev-parse --abbrev-ref HEAD`);
            return git(workspaceRoot, 'rev-parse --abbrev-ref HEAD');
        },
        {
            name: 'git_current_branch',
            description: 'Return the name of the current branch.',
            schema: z.object({}),
        }
    );

    const gitMergeBaseDiffTool = tool(
        async ({ baseBranch }) => {
            const base = baseBranch ?? GIT_DEFAULT_BRANCH;
            logToolAction(`${TAG} diff ${base}...HEAD`);
            const result = git(workspaceRoot, `diff ${base}...HEAD`);
            return result || '(no differences from base branch)';
        },
        {
            name: 'git_merge_base_diff',
            description: 'Show the full diff between the current branch and the base branch (main/master). Useful for reviewing all changes in a PR.',
            schema: z.object({
                baseBranch: z.string().optional().describe('Base branch to compare against (default: main/master from config)'),
            }),
        }
    );

    const gitLogTool = tool(
        async ({ count }) => {
            const n = count ?? 10;
            logToolAction(`${TAG} log --oneline -${n}`);
            return git(workspaceRoot, `log --oneline -${n}`);
        },
        {
            name: 'git_log',
            description: 'Show recent commit history (one line per commit).',
            schema: z.object({
                count: z.number().optional().describe('Number of commits to show (default: 10)'),
            }),
        }
    );

    return [
        gitCheckoutBranchTool,
        gitSwitchBranchTool,
        gitAddTool,
        gitCommitTool,
        gitPushTool,
        gitStatusTool,
        gitDiffTool,
        gitCurrentBranchTool,
        gitMergeBaseDiffTool,
        gitLogTool,
    ];
}
