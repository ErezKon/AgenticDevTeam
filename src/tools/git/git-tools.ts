/**
 * Workspace-scoped Git CLI tools for developer agents.
 *
 * Each tool wraps a git command executed via child_process with cwd
 * set to the workspace root. Used by developers (commit workflow)
 * and reviewers (diff inspection).
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { LogColors, color256 } from '../../utils/log-colors.util';
import { logToolAction } from '../../utils/logger';
import { GIT_DEFAULT_BRANCH } from '../../config';
import type { GitContext } from '../../agents/_shared/base-schemas';
import { truncateToolResult } from '../_shared/truncate';
import { gitExec, gitPush as sharedGitPush } from '../../utils/git-exec';

const TAG_COLOR = 202;
const TAG = `${color256(TAG_COLOR)}[git]${LogColors.RESET}`;

/**
 * Files excluded from merge-base diffs to prevent token-limit blowouts.
 * These are generated / vendored files that add noise without review value.
 */
const DIFF_EXCLUDE_PATTERNS = [
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
    'composer.lock',
    'Gemfile.lock',
    'Pipfile.lock',
    'poetry.lock',
    'go.sum',
    'Cargo.lock',
    '*.min.js',
    '*.min.css',
    '*.map',
    '*.snap',
    'dist/*',
    'build/*',
    '.next/*',
];

/** Max characters for a diff tool response before switching to stat-only mode. */
const MAX_DIFF_RESPONSE_CHARS = 25_000;

/**
 * Run a git command in the workspace and return stdout.
 * Delegates to the shared gitExec helper (which uses execFileSync,
 * preventing shell injection via user-controlled arguments).
 */
function git(workspaceRoot: string, args: string): string {
    return gitExec(workspaceRoot, args);
}

/**
 * Create workspace-scoped Git CLI tools.
 */
export function createGitTools(
    workspaceRoot: string,
    gitContext?: GitContext | null,
    defaultBaseBranch?: string,
) {
    /**
     * Resolve the base branch for merge-base diffs.
     *
     * Priority: explicit tool argument → the branch this PR actually targets
     * (defaultBaseBranch) → gitContext.defaultBranch → GIT_DEFAULT_BRANCH.
     * If the resolved ref does not exist locally, fall back to `origin/<ref>`.
     * Runs 5 & 6 wasted whole review iterations on `diff master...HEAD`
     * because `master` does not exist in generated repos.
     */
    const resolveBase = (arg?: string): string => {
        const candidates = [
            arg,
            defaultBaseBranch,
            gitContext?.defaultBranch,
            GIT_DEFAULT_BRANCH,
        ].filter(Boolean) as string[];
        for (const c of candidates) {
            if (!git(workspaceRoot, `rev-parse --verify --quiet ${c}`).startsWith('Error')) return c;
            const remote = `origin/${c}`;
            if (!git(workspaceRoot, `rev-parse --verify --quiet ${remote}`).startsWith('Error')) return remote;
        }
        return candidates[0] ?? GIT_DEFAULT_BRANCH;
    };

    const gitCheckoutBranchTool = tool(
        async ({ branchName, fromBranch }) => {
            const base = resolveBase(fromBranch);
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
                fromBranch: z.string().optional().describe('Base branch to branch from. LEAVE EMPTY — the correct PR base branch is used automatically.'),
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
            // Use the shared gitPush which authenticates via http.extraHeader
            // (never embeds the token in a URL visible to the LLM).
            const result = sharedGitPush(workspaceRoot, branch, gitContext);
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
            return truncateToolResult(result || '(working tree clean)', 'git_status');
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
            return truncateToolResult(result || '(no diff)', 'git_diff');
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
            const base = resolveBase(baseBranch);
            const excludeArgs = DIFF_EXCLUDE_PATTERNS.map(p => `':!${p}'`).join(' ');
            logToolAction(`${TAG} diff ${base}...HEAD (excluding generated files)`);
            const result = git(workspaceRoot, `diff ${base}...HEAD -- . ${excludeArgs}`);
            if (!result || result === '') {
                return '(no differences from base branch)';
            }
            // If the diff is small enough, return it directly (with truncation safety net)
            if (result.length <= MAX_DIFF_RESPONSE_CHARS) {
                return truncateToolResult(result, 'git_merge_base_diff');
            }
            // Diff is too large — return a stat summary and instruct to use per-file tool
            logToolAction(`${TAG} diff too large (${result.length} chars), falling back to stat summary`);
            const stat = git(workspaceRoot, `diff --stat ${base}...HEAD -- . ${excludeArgs}`);
            const fallback = [
                `## Diff too large for a single response (${result.length} chars). Showing file summary instead.\n`,
                stat,
                `\n## To review specific files, use the "git_diff_file" tool with the file path.`,
                `## To see all changed file names, use the "git_diff_stat" tool.`,
            ].join('\n');
            return truncateToolResult(fallback, 'git_merge_base_diff');
        },
        {
            name: 'git_merge_base_diff',
            description: 'Show the diff between the current branch and the base branch (main/master), excluding generated files (lock files, dist/, etc.). If the diff is too large, returns a stat summary instead — use git_diff_file to review individual files.',
            schema: z.object({
                baseBranch: z.string().optional().describe('Base branch to compare against. LEAVE EMPTY — the correct PR base branch is used automatically.'),
            }),
        }
    );

    const gitDiffFileTool = tool(
        async ({ baseBranch, filePath }) => {
            const base = resolveBase(baseBranch);
            logToolAction(`${TAG} diff ${base}...HEAD -- ${filePath}`);
            const result = git(workspaceRoot, `diff ${base}...HEAD -- "${filePath}"`);
            if (!result || result === '') {
                return `(no differences in ${filePath})`;
            }
            return truncateToolResult(result, `git_diff_file ${filePath}`);
        },
        {
            name: 'git_diff_file',
            description: 'Show the diff for a SINGLE file between the current branch and the base branch. Use this to review files one at a time when the full diff is too large.',
            schema: z.object({
                filePath: z.string().describe('Path of the file to diff (e.g. "src/App.tsx")'),
                baseBranch: z.string().optional().describe('Base branch to compare against. LEAVE EMPTY — the correct PR base branch is used automatically.'),
            }),
        }
    );

    const gitDiffStatTool = tool(
        async ({ baseBranch }) => {
            const base = resolveBase(baseBranch);
            logToolAction(`${TAG} diff --stat ${base}...HEAD`);
            const result = git(workspaceRoot, `diff --stat ${base}...HEAD`);
            return truncateToolResult(result || '(no differences from base branch)', 'git_diff_stat');
        },
        {
            name: 'git_diff_stat',
            description: 'Show a summary of changed files (names and line counts) between the current branch and the base branch. Useful for understanding the scope of changes before reviewing individual files.',
            schema: z.object({
                baseBranch: z.string().optional().describe('Base branch to compare against. LEAVE EMPTY — the correct PR base branch is used automatically.'),
            }),
        }
    );

    const gitLogTool = tool(
        async ({ count }) => {
            const n = count ?? 10;
            logToolAction(`${TAG} log --oneline -${n}`);
            return truncateToolResult(git(workspaceRoot, `log --oneline -${n}`), 'git_log');
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
        gitDiffFileTool,
        gitDiffStatTool,
        gitLogTool,
    ];
}
