/**
 * Shared artifact file-writing helpers for output-directory artifacts.
 *
 * Consolidates the repeated pattern of writing files to `outputPath`
 * (state.json, traceability.md, run-diagnosis.md, etc.) with consistent
 * directory creation and error handling.
 *
 * NOT for agent mission-report artifacts (those use `agents/_shared/artifact.ts`)
 * or workspace-file writes (those are domain-specific).
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from './logger';

const log = getLogger('[ArtifactWriter]', 244);

/**
 * Write a file to the output directory. Creates parent directories
 * automatically. Never throws — logs a warning and returns `null` on error.
 *
 * @param outputPath  Base output directory (e.g. `state.outputPath`).
 * @param name        File name or relative sub-path (e.g. `'traceability.md'`).
 * @param content     File content to write.
 * @returns           Absolute path written, or `null` on failure.
 */
export function writeOutputFile(
    outputPath: string,
    name: string,
    content: string,
): string | null {
    const dest = path.join(outputPath, name);
    try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content, 'utf-8');
        return dest;
    } catch (err: any) {
        log.warn(`Failed to write ${name}: ${err.message}`);
        return null;
    }
}

/**
 * Append a line to a file in the output directory.
 * Creates parent directories automatically. Never throws.
 *
 * @param outputPath  Base output directory.
 * @param name        File name or relative sub-path (e.g. `'ledger.jsonl'`).
 * @param line        Line to append (a trailing newline is added automatically).
 */
export function appendOutputLine(
    outputPath: string,
    name: string,
    line: string,
): void {
    const dest = path.join(outputPath, name);
    try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.appendFileSync(dest, line.endsWith('\n') ? line : line + '\n', 'utf-8');
    } catch (err: any) {
        log.warn(`Failed to append to ${name}: ${err.message}`);
    }
}
