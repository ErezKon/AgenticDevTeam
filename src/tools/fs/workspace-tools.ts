/**
 * Workspace-scoped filesystem tools for developer agents.
 *
 * Every path is resolved against and confined to the workspace root.
 * Escaping the workspace via ".." is rejected.
 *
 * Protection modes (Sub-Plan 02 — Gate Integrity):
 *   'off'  — all writes allowed (scaffold agents)
 *   'warn' — writes to protected config files are allowed but logged as warnings
 *   'deny' — writes to protected config files return a REFUSED error string
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { resolveWorkspacePath } from '../../utils/workspace';
import { LogColors, color256 } from '../../utils/log-colors.util';
import { logToolAction, getLogger } from '../../utils/logger';
import { truncateToolResult } from '../_shared/truncate';
import { matchesProtectedGlob, PROTECTED_CONFIG_GLOBS } from '../../conductor/gate-integrity';

const TAG_COLOR = 75;
const TAG = `${color256(TAG_COLOR)}[fs-tools]${LogColors.RESET}`;
const protLog = getLogger('[fs-protect]', 214);

// ─── Protection types ───────────────────────────────────────────────────────

export type ProtectionMode = 'off' | 'warn' | 'deny';

export interface WorkspaceToolOptions {
    /** Which protection mode for config files. Default: 'off'. */
    protectionMode?: ProtectionMode;
    /** Override the set of globs considered protected. Defaults to PROTECTED_CONFIG_GLOBS. */
    protectedGlobs?: string[];
}

/** REFUSED message returned to agents when a write is blocked. */
const REFUSED_MESSAGE = `REFUSED: This is a protected configuration file during a quality-gate repair.
You must fix the source code so the existing build and test commands pass.
If a dependency is genuinely missing, add it to \`dependencies\` ONLY — do not change \`scripts\`.`;

// ─── Elision-placeholder guard (Plan 22, B1) ────────────────────────────────

/**
 * Matches an orchestrator elision placeholder used as the ENTIRE payload of a
 * write. Two shapes are recognised:
 *   - the legacy `[1204 chars elided]` form (still present in checkpoints), and
 *   - the current `⟪ORCHESTRATOR-ELIDED 1204 chars — …⟫` form.
 *
 * Why this exists: `compactHistory` replaces large `write_file` arguments in the
 * agent's *visible* history with such a marker. In the pacmanclaude run the model
 * saw 15 of them, imitated the pattern, and wrote three source files whose entire
 * content was `[770 chars elided]`. Prompting cannot be relied on to prevent
 * that — the write boundary is the only place the check cannot be bypassed.
 */
const ELISION_PLACEHOLDER_RE =
    /^\s*(?:\[\d[\d,]* chars(?:,)? elided\]|⟪[^⟫]*ELIDED[^⟫]*⟫|\[[a-z_]+ -> \d[\d,]* chars, elided\])\s*$/i;

/**
 * Reject writes whose payload is an orchestrator artefact rather than real
 * content. Returns the error string to hand back to the agent, or `null`.
 *
 * Deliberately narrow: only an exact, whole-payload elision marker is rejected.
 * A "minimum plausible source file length" rule was tried and removed — a
 * legitimate `export const x = 2;` is 19 characters, so the heuristic rejected
 * real code while adding nothing: every observed corruption was the exact marker.
 */
export function checkWritePayload(filePath: string, content: string): string | null {
    if (!ELISION_PLACEHOLDER_RE.test(content)) return null;

    protLog.error(`REJECTED elision-placeholder write to ${filePath} (${content.length} chars)`);
    return `REJECTED: the content you passed is an orchestrator elision placeholder, not file content.\n`
        + `That marker means "this text was removed from your message history to save tokens" — it is NEVER `
        + `something to write to disk. The real file content is already on disk (or was never written).\n`
        + `If you need the current content, call read_file("${filePath}"). If this is a new file, write the actual code.`;
}

/**
 * Check if a file path is protected and return the refusal or null.
 */
function checkProtection(
    filePath: string,
    mode: ProtectionMode,
    globs: string[],
): string | null {
    if (mode === 'off') return null;
    if (!matchesProtectedGlob(filePath, globs)) return null;

    if (mode === 'warn') {
        protLog.warn(`Protected file write (warn mode): ${filePath}`);
        return null; // allow, just warn
    }
    // mode === 'deny'
    protLog.warn(`REFUSED write to protected file: ${filePath}`);
    return `${REFUSED_MESSAGE}\nBlocked file: \`${filePath}\``;
}

/**
 * Create workspace-scoped filesystem tools bound to a specific workspace root.
 */
export function createWorkspaceTools(
    workspaceRoot: string,
    opts?: WorkspaceToolOptions,
) {
    const protectionMode = opts?.protectionMode ?? 'off';
    const protectedGlobs = opts?.protectedGlobs ?? PROTECTED_CONFIG_GLOBS;

    const writeFileTool = tool(
        async ({ filePath, content }) => {
            const resolved = resolveWorkspacePath(workspaceRoot, filePath);
            logToolAction(`${TAG} write_file: ${filePath}`);

            // Protection check
            const refusal = checkProtection(filePath, protectionMode, protectedGlobs);
            if (refusal) return refusal;

            // Plan 22 B1: never let an orchestrator elision marker reach disk
            const payloadRefusal = checkWritePayload(filePath, content);
            if (payloadRefusal) return payloadRefusal;

            fs.mkdirSync(path.dirname(resolved), { recursive: true });
            fs.writeFileSync(resolved, content, 'utf-8');
            return `File written: ${filePath} (${content.length} chars)`;
        },
        {
            name: 'write_file',
            description: 'Write content to a file in the project workspace. Creates parent directories automatically. Path must be relative to workspace root.',
            schema: z.object({
                filePath: z.string().describe('Relative path within the workspace (e.g. "src/index.ts")'),
                content: z.string().describe('Full file content to write'),
            }),
        }
    );

    const readFileTool = tool(
        async ({ filePath, offset, limit }) => {
            const resolved = resolveWorkspacePath(workspaceRoot, filePath);
            logToolAction(`${TAG} read_file: ${filePath}${offset ? ` offset=${offset}` : ''}${limit ? ` limit=${limit}` : ''}`);
            if (!fs.existsSync(resolved)) {
                return `Error: File not found: ${filePath}`;
            }
            const raw = fs.readFileSync(resolved, 'utf-8');
            const allLines = raw.split('\n');
            const totalLines = allLines.length;
            if (offset || limit) {
                const start = Math.max((offset ?? 1) - 1, 0);
                const end = limit ? start + limit : totalLines;
                const slice = allLines.slice(start, end).join('\n');
                return `[lines ${start + 1}-${Math.min(end, totalLines)} of ${totalLines}]\n${slice}`;
            }
            return truncateToolResult(raw, `read_file ${filePath}`);
        },
        {
            name: 'read_file',
            description: 'Read the contents of a file in the project workspace. Use offset/limit for large files to read a specific line range.',
            schema: z.object({
                filePath: z.string().describe('Relative path within the workspace'),
                offset: z.number().optional().describe('1-based start line number (default: 1)'),
                limit: z.number().optional().describe('Number of lines to return (default: all)'),
            }),
        }
    );

    const editFileTool = tool(
        async ({ filePath, oldString, newString }) => {
            const resolved = resolveWorkspacePath(workspaceRoot, filePath);
            logToolAction(`${TAG} edit_file: ${filePath}`);

            // Protection check
            const refusal = checkProtection(filePath, protectionMode, protectedGlobs);
            if (refusal) return refusal;

            // Plan 22 B1: an elision marker as the replacement text would corrupt
            // the file just as surely as a full-file write of the same marker.
            const payloadRefusal = checkWritePayload(filePath, newString);
            if (payloadRefusal) return payloadRefusal;

            if (!fs.existsSync(resolved)) {
                return `Error: File not found: ${filePath}`;
            }
            let content = fs.readFileSync(resolved, 'utf-8');
            if (!content.includes(oldString)) {
                return `Error: old_string not found in file. Make sure it matches exactly.`;
            }
            content = content.replace(oldString, newString);
            fs.writeFileSync(resolved, content, 'utf-8');
            return `File edited: ${filePath}`;
        },
        {
            name: 'edit_file',
            description: 'Replace a specific string in a file. The old_string must match exactly (including whitespace).',
            schema: z.object({
                filePath: z.string().describe('Relative path within the workspace'),
                oldString: z.string().describe('Exact string to find and replace'),
                newString: z.string().describe('Replacement string'),
            }),
        }
    );

    const listDirTool = tool(
        async ({ dirPath, recursive }) => {
            const resolved = resolveWorkspacePath(workspaceRoot, dirPath || '.');
            logToolAction(`${TAG} list_dir: ${dirPath || '.'}`);
            if (!fs.existsSync(resolved)) {
                return `Error: Directory not found: ${dirPath}`;
            }
            const entries = listDirectory(resolved, workspaceRoot, recursive ?? false);
            const raw = entries.join('\n') || '(empty directory)';
            return truncateToolResult(raw, 'list_dir');
        },
        {
            name: 'list_dir',
            description: 'List files and directories in the workspace. Returns relative paths.',
            schema: z.object({
                dirPath: z.string().optional().describe('Relative directory path (default: workspace root)'),
                recursive: z.boolean().optional().describe('List recursively (default: false)'),
            }),
        }
    );

    const searchCodeTool = tool(
        async ({ query, filePattern }) => {
            const resolved = resolveWorkspacePath(workspaceRoot, '.');
            logToolAction(`${TAG} search_code: "${query}" pattern=${filePattern || '*'}`);
            const results = searchInFiles(resolved, workspaceRoot, query, filePattern);
            if (results.length === 0) return 'No matches found.';
            const raw = results.slice(0, 50).join('\n');
            return truncateToolResult(raw, 'search_code');
        },
        {
            name: 'search_code',
            description: 'Search for a text pattern across all files in the workspace. Returns matching file:line entries.',
            schema: z.object({
                query: z.string().describe('Text or regex pattern to search for'),
                filePattern: z.string().optional().describe('Glob pattern to filter files (e.g. "*.ts", "*.py")'),
            }),
        }
    );

    return [writeFileTool, readFileTool, editFileTool, listDirTool, searchCodeTool];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function listDirectory(dir: string, root: string, recursive: boolean, depth = 0): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full);
        const prefix = entry.isDirectory() ? 'd ' : 'f ';
        results.push(prefix + rel);
        if (recursive && entry.isDirectory() && depth < 5) {
            results.push(...listDirectory(full, root, true, depth + 1));
        }
    }
    return results;
}

function searchInFiles(dir: string, root: string, query: string, filePattern?: string): string[] {
    const results: string[] = [];
    const regex = new RegExp(query, 'gi');

    function walk(current: string) {
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else {
                if (filePattern && !matchGlob(entry.name, filePattern)) continue;
                try {
                    const content = fs.readFileSync(full, 'utf-8');
                    const lines = content.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        if (regex.test(lines[i])) {
                            const rel = path.relative(root, full);
                            results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
                            if (results.length >= 50) return;
                        }
                        regex.lastIndex = 0;
                    }
                } catch {
                    // Skip binary / unreadable files
                }
            }
            if (results.length >= 50) return;
        }
    }
    walk(dir);
    return results;
}

function matchGlob(filename: string, pattern: string): boolean {
    const ext = pattern.startsWith('*.') ? pattern.slice(1) : null;
    if (ext) return filename.endsWith(ext);
    return filename.includes(pattern.replace(/\*/g, ''));
}
