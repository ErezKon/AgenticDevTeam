/**
 * Agent respawn — deterministic handoff summary for fresh-context continuation.
 *
 * When a dev agent hits the tool-call ceiling, instead of poisoning all tools
 * and flailing with a maximal history, we extract a compact handoff summary
 * from the completed invocation and spawn a fresh agent with clean context.
 *
 * The handoff is built DETERMINISTICALLY from the message history — no extra
 * LLM call, so the summary itself is free. Generation 2 starts at ~4k input
 * tokens with better signal than generation 1 had at 15k.
 *
 * Sub-Plan 08 §4: enhanced with worktree-verified file lists, progress-gated
 * respawn (zero-write generations are not respawned), and richer handoff.
 */

import {
    isAIMessage,
    isToolMessage,
    type BaseMessage,
} from '@langchain/core/messages';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HandoffFile {
    path: string;
    action: string;
    /** File size in bytes (from worktree verification). */
    bytes?: number;
}

export interface HandoffSummary {
    generation: number;
    filesWritten: HandoffFile[];
    commandsRun: { command: string; exitCode: number; tailOutput?: string }[];
    keyFindings: string[];
    remainingWork: string;
    /** True when the handoff was verified against the worktree. */
    worktreeVerified: boolean;
    /**
     * Files the previous generation already inspected (Plan 22, C2).
     *
     * Without this, every respawn generation restarts reconnaissance from zero:
     * dumps 019/020/021 of the pacmanclaude run each re-read the same 24 files
     * and two of them exhausted their budget before writing anything.
     */
    filesRead: string[];
    /** `git ls-files` snapshot of the worktree, so the successor never has to
     *  spend read calls discovering the tree (Plan 22, C2). */
    treeSnapshot: string[];
    /** Tool budget the previous generation consumed (Plan 22, C2). */
    budgetSpent?: { reads: number; writes: number; shell: number; turns: number };
}

// ─── Tool-call argument extractors ──────────────────────────────────────────

/** Tool names that produce file writes. */
const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'create_file']);

/** Tool names that run shell commands. */
const COMMAND_TOOLS = new Set(['run_command']);

/** Tool names whose targets are worth listing as "already inspected". */
const READ_TOOLS = new Set(['read_file', 'list_dir', 'search_code']);

/** Max entries in the tree snapshot handed to the successor generation. */
const MAX_TREE_SNAPSHOT_ENTRIES = 200;

/** Max entries in the already-inspected list handed to the successor. */
const MAX_FILES_READ_ENTRIES = 60;

/**
 * Parse the exit code from a run_command tool result.
 * The shell tool typically formats output as "Exit code: N\n..." or includes
 * "exit code N" somewhere in the result.
 */
function parseExitCode(resultContent: string): number {
    // Try "Exit code: N" pattern
    const exitMatch = resultContent.match(/[Ee]xit\s*code[:\s]+(\d+)/);
    if (exitMatch) return parseInt(exitMatch[1], 10);
    // Try "exited with N" pattern
    const exitedMatch = resultContent.match(/exited\s+with\s+(\d+)/);
    if (exitedMatch) return parseInt(exitedMatch[1], 10);
    // Default: assume success if no error indicators
    if (resultContent.includes('Error') || resultContent.includes('FAIL') || resultContent.includes('error')) {
        return 1;
    }
    return 0;
}

// ─── Core functions ─────────────────────────────────────────────────────────

/**
 * Build a compact handoff brief from a completed (or ceiling-terminated)
 * agent invocation. Derived DETERMINISTICALLY from the message history —
 * no extra LLM call, so the summary itself is free.
 *
 * Sub-Plan 08 §4: when `worktreeDir` is provided, filesWritten is derived
 * from `git status --short` + `git diff --name-only <base>..HEAD` (ground
 * truth), not from the agent's claims.  A generation with zero verified
 * writes should not be respawned.
 *
 * @param messages     The agent's message history
 * @param generation   Current generation number (1-based for the handoff target)
 * @param worktreeDir  Optional: worktree path for ground-truth file verification
 * @param baseBranch   Optional: base branch for diff comparison
 */
export function buildHandoff(
    messages: BaseMessage[],
    generation: number,
    worktreeDir?: string,
    baseBranch?: string,
    budgetSpent?: HandoffSummary['budgetSpent'],
): HandoffSummary {
    const filesWritten: HandoffFile[] = [];
    const commandsRun: { command: string; exitCode: number; tailOutput?: string }[] = [];
    const keyFindings: string[] = [];
    const filesReadSet = new Set<string>();
    let treeSnapshot: string[] = [];
    let remainingWork = '';
    let worktreeVerified = false;

    // Build a map of tool_call_id -> ToolMessage content for result lookup
    const toolResults = new Map<string, string>();
    for (const m of messages) {
        if (isToolMessage(m)) {
            const callId = (m as any).tool_call_id;
            if (callId) {
                const content = typeof m.content === 'string'
                    ? m.content
                    : JSON.stringify(m.content);
                toolResults.set(callId, content);
            }
        }
    }

    // Walk AIMessages to extract tool calls
    for (const m of messages) {
        if (!isAIMessage(m) || !m.tool_calls?.length) continue;

        for (const tc of m.tool_calls) {
            const toolName = tc.name;
            const args = tc.args ?? {};

            if (FILE_WRITE_TOOLS.has(toolName)) {
                const filePath = args.filePath ?? '(unknown)';
                const action = toolName === 'edit_file' ? 'edited' : 'created';
                // Deduplicate by path — keep the last action
                const existingIdx = filesWritten.findIndex(f => f.path === filePath);
                if (existingIdx >= 0) {
                    filesWritten[existingIdx].action = action;
                } else {
                    filesWritten.push({ path: filePath, action });
                }
            }

            // Plan 22 C2: record what the previous generation already inspected.
            if (READ_TOOLS.has(toolName)) {
                const target = args.filePath ?? args.path ?? args.dirPath ?? args.query ?? null;
                if (typeof target === 'string' && target.length > 0) {
                    filesReadSet.add(toolName === 'search_code' ? `search: ${target}` : target);
                }
            }

            if (COMMAND_TOOLS.has(toolName)) {
                const command = args.command ?? args.cmd ?? '(unknown)';
                const resultContent = toolResults.get(tc.id ?? '') ?? '';
                const exitCode = parseExitCode(resultContent);
                // Include tail of output for context
                const tailOutput = resultContent.length > 200
                    ? resultContent.slice(-200)
                    : resultContent;
                commandsRun.push({ command, exitCode, tailOutput });
            }
        }
    }

    // Extract key findings from the agent's last non-empty text content
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (isAIMessage(m)) {
            const textContent = typeof m.content === 'string'
                ? m.content
                : (Array.isArray(m.content)
                    ? m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
                    : '');

            if (textContent.trim().length > 0) {
                keyFindings.push(textContent.trim().slice(0, 800));
                break;
            }
        }
    }

    // Derive remaining work: if any command had a non-zero exit code, note it
    const failedCommands = commandsRun.filter(c => c.exitCode !== 0);
    if (failedCommands.length > 0) {
        const lastFailed = failedCommands[failedCommands.length - 1];
        remainingWork = `Fix failing command: \`${lastFailed.command}\` (exit ${lastFailed.exitCode}), then re-run tests and report.`;
    } else if (filesWritten.length === 0) {
        remainingWork = 'No files written yet. Complete the implementation, write tests, and verify.';
    } else {
        remainingWork = 'Continue implementation if incomplete. Run tests, fix failures, then report.';
    }

    // Sub-Plan 08 §4: when worktreeDir is provided, verify files against disk
    if (worktreeDir) {
        try {
            const actualFiles = new Set<string>();
            // git diff for committed changes
            try {
                const ref = baseBranch ? `${baseBranch}..HEAD` : 'HEAD';
                const diff = execSync(`git diff --name-only ${ref}`, {
                    cwd: worktreeDir, encoding: 'utf-8', timeout: 5000,
                }).trim();
                for (const f of diff.split('\n').filter(Boolean)) actualFiles.add(f);
            } catch { /* no commits yet */ }
            // git status for uncommitted changes.
            //
            // `--untracked-files=all` is load-bearing: plain `git status --short`
            // collapses a wholly-untracked directory into a single `?? src/` entry,
            // so a generation that created `src/a.ts`, `src/b.ts`, … was recorded as
            // having written the directory `src/`. That was invisible until Plan 22
            // C1 actually enabled worktree verification.
            try {
                const status = execSync('git status --porcelain --untracked-files=all', {
                    cwd: worktreeDir, encoding: 'utf-8', timeout: 5000,
                }).trim();
                for (const line of status.split('\n').filter(Boolean)) {
                    let filePath = line.slice(3).trim();
                    // Renames/copies are reported as `old -> new`; keep the new path.
                    const arrow = filePath.indexOf(' -> ');
                    if (arrow >= 0) filePath = filePath.slice(arrow + 4).trim();
                    // Quoted paths (non-ASCII / spaces) come wrapped in double quotes.
                    if (filePath.startsWith('"') && filePath.endsWith('"')) {
                        filePath = filePath.slice(1, -1);
                    }
                    if (filePath && !filePath.endsWith('/')) actualFiles.add(filePath);
                }
            } catch { /* ignore */ }

            // Replace agent-claimed files with verified files
            if (actualFiles.size > 0) {
                filesWritten.length = 0;
                for (const f of actualFiles) {
                    const fullPath = path.join(worktreeDir, f);
                    let bytes: number | undefined;
                    try {
                        bytes = fs.statSync(fullPath).size;
                    } catch { /* deleted file */ }
                    filesWritten.push({ path: f, action: 'modified', bytes });
                }
                worktreeVerified = true;
            }

            // Plan 22 C2: a deterministic tree snapshot removes the successor's
            // reconnaissance phase entirely. `git ls-files` is cheap and already
            // excludes ignored build output.
            try {
                const listed = execSync('git ls-files', {
                    cwd: worktreeDir, encoding: 'utf-8', timeout: 5000,
                }).trim();
                treeSnapshot = listed.split('\n').filter(Boolean).slice(0, MAX_TREE_SNAPSHOT_ENTRIES);
            } catch { /* not a git worktree — no snapshot */ }
        } catch { /* worktree verification failed, use agent-claimed files */ }
    }

    return {
        generation,
        filesWritten,
        commandsRun,
        keyFindings,
        remainingWork,
        worktreeVerified,
        filesRead: [...filesReadSet].slice(0, MAX_FILES_READ_ENTRIES),
        treeSnapshot,
        budgetSpent,
    };
}

/**
 * Render a HandoffSummary as the prompt section for the successor agent.
 *
 * Sub-Plan 08 §4: enhanced to show file sizes (from worktree verification),
 * verified status, and remaining work derived from failed commands.
 */
export function renderHandoff(h: HandoffSummary): string {
    const sections: string[] = [];

    sections.push(`## Handoff from generation ${h.generation}`);

    // Files written
    if (h.filesWritten.length > 0) {
        const verifiedLabel = h.worktreeVerified ? ' (verified on disk, do not rewrite from scratch)' : '';
        const fileList = h.filesWritten
            .map(f => {
                const size = f.bytes ? ` (${f.bytes.toLocaleString()} bytes)` : '';
                return `- ${f.path}${size} — ${f.action}`;
            })
            .join('\n');
        sections.push(`### Files you already wrote${verifiedLabel}\n${fileList}`);
    } else {
        sections.push('### Files you already wrote\n(none)');
    }

    // Commands run
    if (h.commandsRun.length > 0) {
        // Show only the last 5 commands to keep it compact
        const recentCmds = h.commandsRun.slice(-5);
        const cmdList = recentCmds
            .map(c => `- \`${c.command}\` → exit ${c.exitCode}`)
            .join('\n');
        sections.push(`### Commands you already ran and their outcome\n${cmdList}`);
    }

    // Key findings
    if (h.keyFindings.length > 0) {
        sections.push(`### Notes from your previous generation\n${h.keyFindings.join(' ')}`);
    }

    // Plan 22 C2: already-inspected list + tree snapshot. Together these remove
    // the reconnaissance phase that consumed the whole budget of three
    // generations in the pacmanclaude run.
    if (h.filesRead.length > 0) {
        sections.push(
            '### Already inspected by the previous generation (do NOT re-read unless you intend to change them)\n'
            + h.filesRead.map(f => `- ${f}`).join('\n'),
        );
    }

    if (h.treeSnapshot.length > 0) {
        sections.push(
            `### Files tracked in this worktree (${h.treeSnapshot.length} shown — this IS the tree, do not list_dir to discover it)\n`
            + h.treeSnapshot.map(f => `- ${f}`).join('\n'),
        );
    }

    if (h.budgetSpent) {
        const b = h.budgetSpent;
        sections.push(
            `### Tool budget already spent by the previous generation\n`
            + `reads ${b.reads}, writes ${b.writes}, shell ${b.shell}, turns ${b.turns}. `
            + 'Reconnaissance is already paid for — spend your budget on writing code.',
        );
    }

    // Remaining work
    sections.push(`### What remains\n${h.remainingWork}`);

    // Instruction to avoid redundant work
    sections.push('Do NOT re-read files you already wrote unless you need to change them.');

    return sections.join('\n');
}

/**
 * Did a generation make progress worth another respawn? (Plan 22, C3)
 *
 * The old gate was `filesWritten.length > 0`. Two problems: (a) `filesWritten`
 * was the agent's *claim* because `buildHandoff` was called without a worktree
 * (C1), and (b) a generation that got the build green without writing files had
 * plainly made progress yet was terminated. A successful build/test/lint command
 * now counts.
 */
export function madeProgress(h: HandoffSummary): boolean {
    if (h.filesWritten.length > 0) return true;
    return h.commandsRun.some(c =>
        c.exitCode === 0 && /\b(test|build|tsc|lint|vitest|jest|pytest|gradle|mvn|go\s+build)\b/i.test(c.command),
    );
}
