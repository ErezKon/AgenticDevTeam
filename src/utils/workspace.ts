import * as fs from 'fs';
import * as path from 'path';
import { GENERATED_PROJECTS_DIR, OUTPUTS_DIR } from '../config';
import { LogColors } from './log-colors.util';
import {logToolAction} from './logger';

const TAG = `${LogColors.BRIGHT_BLUE}[workspace]${LogColors.RESET}`;

/**
 * Sanitize a string for use as a directory name.
 * Preserves alphanumeric, Hebrew, spaces (→ hyphens), and hyphens.
 */
export function sanitizeFolderName(name: string): string {
    return name
        .replace(/[^a-zA-Z0-9\u0590-\u05FF\s-]/g, '')
        .replace(/\s+/g, '-')
        .toLowerCase()
        .slice(0, 80);
}

/**
 * Create the generated-project workspace directory.
 * Returns the absolute path to the new project dir.
 */
export function createProjectWorkspace(systemName: string): string {
    const folderName = sanitizeFolderName(systemName) || `project-${Date.now()}`;
    const projectDir = path.join(GENERATED_PROJECTS_DIR, folderName);

    fs.mkdirSync(projectDir, { recursive: true });
    // Create standard subdirectories
    fs.mkdirSync(path.join(projectDir, 'docs', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });

    logToolAction(`${TAG} Created project workspace: ${projectDir}`);
    return projectDir;
}

/**
 * Create the run-specific output directory.
 * Returns the absolute path to the output dir.
 */
export function createRunOutputDir(systemName: string): string {
    const folderName = sanitizeFolderName(systemName) || `run-${Date.now()}`;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir = path.join(OUTPUTS_DIR, `${folderName}-${timestamp}`);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(path.join(outputDir, 'test-reports'), { recursive: true });

    logToolAction(`${TAG} Created run output dir: ${outputDir}`);
    return outputDir;
}

// ─── Gitignore management ────────────────────────────────────────────────────

const GITIGNORE_MARKER_START = '# ─── AgenticDevTeam (do not edit this block) ───';
const GITIGNORE_MARKER_END   = '# ─── /AgenticDevTeam ───';

/**
 * Ensure the project's `.gitignore` contains a managed block with the given
 * entries (e.g. `.conventions/`, `.worktrees/`).
 *
 * - Creates the file if it does not exist.
 * - Appends the block if the marker is absent.
 * - Replaces the block in-place if it already exists (idempotent).
 * - Preserves all other content the project may have.
 */
export function ensureProjectGitignore(
    workspacePath: string,
    entries: string[],
): void {
    const gitignorePath = path.join(workspacePath, '.gitignore');
    const block = [
        GITIGNORE_MARKER_START,
        ...entries,
        GITIGNORE_MARKER_END,
    ].join('\n');

    let existing = '';
    if (fs.existsSync(gitignorePath)) {
        existing = fs.readFileSync(gitignorePath, 'utf-8');
    }

    // Already contains the marker — replace the managed block
    if (existing.includes(GITIGNORE_MARKER_START)) {
        const re = new RegExp(
            escapeRegex(GITIGNORE_MARKER_START) +
            '[\\s\\S]*?' +
            escapeRegex(GITIGNORE_MARKER_END),
        );
        const updated = existing.replace(re, block);
        fs.writeFileSync(gitignorePath, updated, 'utf-8');
        return;
    }

    // No marker yet — append (with a leading newline if the file is non-empty)
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : existing.length > 0 ? '\n' : '';
    fs.writeFileSync(gitignorePath, existing + separator + block + '\n', 'utf-8');
    logToolAction(`${TAG} Added managed .gitignore block to ${gitignorePath}`);
}

/** Escape special regex characters in a string. */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Path resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a workspace-relative path, ensuring it stays within the workspace.
 * Throws if the resolved path escapes the workspace root.
 */
export function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
    // B7: Strip doubled generated-projects prefix (agents sometimes use the full repo path
    // from architecture docs even though their CWD is already the project root)
    let sanitized = relativePath;
    const gpPrefix = 'generated-projects/';
    if (sanitized.startsWith(gpPrefix)) {
        const projectSlug = path.basename(workspaceRoot);
        const doubledPrefix = `${gpPrefix}${projectSlug}/`;
        if (sanitized.startsWith(doubledPrefix)) {
            sanitized = sanitized.slice(doubledPrefix.length);
            logToolAction(`${TAG} Sanitized doubled path: "${relativePath}" → "${sanitized}"`);
        } else if (workspaceRoot.includes(gpPrefix)) {
            // CWD is already inside generated-projects — strip the prefix
            sanitized = sanitized.slice(gpPrefix.length);
            // Also strip the project slug if present
            if (sanitized.startsWith(projectSlug + '/')) {
                sanitized = sanitized.slice(projectSlug.length + 1);
            }
            logToolAction(`${TAG} Sanitized project path: "${relativePath}" → "${sanitized}"`);
        }
    }
    const resolved = path.resolve(workspaceRoot, sanitized);
    if (!resolved.startsWith(path.resolve(workspaceRoot))) {
        throw new Error(`Path escape detected: ${relativePath} resolves outside workspace`);
    }
    return resolved;
}
