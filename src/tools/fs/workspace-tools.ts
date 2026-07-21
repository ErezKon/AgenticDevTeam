/**
 * Workspace-scoped filesystem tools for developer agents.
 *
 * Every path is resolved against and confined to the workspace root.
 * Escaping the workspace via ".." is rejected.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { resolveWorkspacePath } from '../../utils/workspace';
import { LogColors, color256 } from '../../utils/log-colors.util';

const TAG_COLOR = 75;
const TAG = `${color256(TAG_COLOR)}[fs-tools]${LogColors.RESET}`;

/**
 * Create workspace-scoped filesystem tools bound to a specific workspace root.
 */
export function createWorkspaceTools(workspaceRoot: string) {
    const writeFileTool = tool(
        async ({ filePath, content }) => {
            const resolved = resolveWorkspacePath(workspaceRoot, filePath);
            console.log(`${TAG} write_file: ${filePath}`);
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
        async ({ filePath }) => {
            const resolved = resolveWorkspacePath(workspaceRoot, filePath);
            console.log(`${TAG} read_file: ${filePath}`);
            if (!fs.existsSync(resolved)) {
                return `Error: File not found: ${filePath}`;
            }
            const content = fs.readFileSync(resolved, 'utf-8');
            return content;
        },
        {
            name: 'read_file',
            description: 'Read the contents of a file in the project workspace.',
            schema: z.object({
                filePath: z.string().describe('Relative path within the workspace'),
            }),
        }
    );

    const editFileTool = tool(
        async ({ filePath, oldString, newString }) => {
            const resolved = resolveWorkspacePath(workspaceRoot, filePath);
            console.log(`${TAG} edit_file: ${filePath}`);
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
            console.log(`${TAG} list_dir: ${dirPath || '.'}`);
            if (!fs.existsSync(resolved)) {
                return `Error: Directory not found: ${dirPath}`;
            }
            const entries = listDirectory(resolved, workspaceRoot, recursive ?? false);
            return entries.join('\n') || '(empty directory)';
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
            console.log(`${TAG} search_code: "${query}" pattern=${filePattern || '*'}`);
            const results = searchInFiles(resolved, workspaceRoot, query, filePattern);
            if (results.length === 0) return 'No matches found.';
            return results.slice(0, 50).join('\n');
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
