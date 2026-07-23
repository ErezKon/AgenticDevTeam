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

/**
 * Resolve a workspace-relative path, ensuring it stays within the workspace.
 * Throws if the resolved path escapes the workspace root.
 */
export function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
    const resolved = path.resolve(workspaceRoot, relativePath);
    if (!resolved.startsWith(path.resolve(workspaceRoot))) {
        throw new Error(`Path escape detected: ${relativePath} resolves outside workspace`);
    }
    return resolved;
}
