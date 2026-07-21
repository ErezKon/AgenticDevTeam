/**
 * Writes the CodebaseAnalysis markdown to both the project workspace
 * and the run output directory.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { CodebaseAnalysis } from '../agents/_shared/base-schemas';
import { renderCodebaseAnalysis } from '../templates/codebase-analysis.template';
import { getLogger } from './logger';

const log = getLogger('[AnalysisWriter]', 147);

const ANALYSIS_FILENAME = 'codebase-analysis.md';

/**
 * Persist the codebase analysis markdown to both locations:
 * 1. `<workspacePath>/docs/codebase-analysis.md` (persistent in the project)
 * 2. `<outputPath>/codebase-analysis.md` (snapshot for this run)
 */
export function writeCodebaseAnalysis(
    analysis: CodebaseAnalysis,
    workspacePath: string,
    outputPath: string,
): void {
    const markdown = renderCodebaseAnalysis(analysis);

    // Write to project workspace (persistent)
    const docsDir = path.join(workspacePath, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    const projectFilePath = path.join(docsDir, ANALYSIS_FILENAME);
    fs.writeFileSync(projectFilePath, markdown, 'utf-8');
    log.info(`Wrote analysis to project: ${projectFilePath}`);

    // Write to run output directory (snapshot)
    fs.mkdirSync(outputPath, { recursive: true });
    const outputFilePath = path.join(outputPath, ANALYSIS_FILENAME);
    fs.writeFileSync(outputFilePath, markdown, 'utf-8');
    log.info(`Wrote analysis snapshot to: ${outputFilePath}`);
}

/**
 * Read an existing codebase-analysis.md from the project, if present.
 * Returns the markdown string or null if not found.
 */
export function readExistingAnalysis(workspacePath: string): string | null {
    const filePath = path.join(workspacePath, 'docs', ANALYSIS_FILENAME);
    if (fs.existsSync(filePath)) {
        log.info(`Found existing analysis: ${filePath}`);
        return fs.readFileSync(filePath, 'utf-8');
    }
    return null;
}
