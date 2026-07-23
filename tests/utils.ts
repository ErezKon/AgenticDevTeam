/**
 * Shared test utilities for CLI integration tests.
 */
import * as fs from 'fs';
import * as path from 'path';
import { GENERATED_PROJECTS_DIR } from '../src/config';
import { sanitizeFolderName } from '../src/utils/workspace';

export interface SpecEntry {
    systemName: string;
    filePath: string;
}

/**
 * Discover spec files (*.txt, *.md) in a directory
 * and return them as { systemName, filePath } entries.
 */
export function discoverSpecs(dir: string): SpecEntry[] {
    const absDir = path.resolve(dir);
    if (!fs.existsSync(absDir)) return [];

    return fs
        .readdirSync(absDir)
        .filter((f) => /\.(txt|md)$/i.test(f))
        .map((f) => ({
            systemName: toSystemName(f),
            filePath: path.join(absDir, f),
        }));
}

/**
 * Convert a spec filename to a PascalCase system name.
 * e.g. "simple-calculator.txt" → "SimpleCalculator"
 */
export function toSystemName(filename: string): string {
    const base = path.basename(filename).replace(/\.[^.]+$/, '');
    return base
        .split(/[-_\s]+/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join('');
}

/**
 * Find the generated project directory for a given system name.
 */
export function findGeneratedProject(systemName: string): string {
    const folderName = sanitizeFolderName(systemName);
    return path.join(GENERATED_PROJECTS_DIR, folderName);
}
