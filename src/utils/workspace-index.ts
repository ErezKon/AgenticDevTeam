/**
 * WorkspaceIndex — pre-built file index for a workspace.
 *
 * Sub-Plan 25-10: Eliminates 8+ redundant filesystem walks by building
 * the index once per workspace+iteration and passing it to all gates.
 *
 * Uses the shared fs-walk utility for consistent prune/filter behavior.
 */
import * as path from 'path';
import { collectFiles, isTestFile, isSourceFile, isProductSourceFile, PRUNE_DIRS, type WalkOptions } from './fs-walk';
import { getLogger } from './logger';
import type { WorkspaceIndex } from '../conductor/gate-types';

const log = getLogger('[WorkspaceIndex]', 244);

/**
 * Build a WorkspaceIndex for a workspace directory.
 *
 * Walks the filesystem once and classifies every file into
 * allFiles, sourceFiles, testFiles, productSourceFiles, and byExt.
 *
 * @param workspacePath  Absolute path to the workspace root.
 * @param opts           Walk options (maxDepth, maxFiles, pruneDirs).
 */
export function buildWorkspaceIndex(
    workspacePath: string,
    opts?: WalkOptions,
): WorkspaceIndex {
    const start = Date.now();

    // Collect all files in a single walk
    const allFiles = collectFiles(workspacePath, () => true, opts);

    const sourceFiles: string[] = [];
    const testFiles: string[] = [];
    const productSourceFiles: string[] = [];
    const byExt = new Map<string, string[]>();

    for (const relPath of allFiles) {
        // Classify by extension
        const ext = path.extname(relPath).toLowerCase();
        if (ext) {
            let bucket = byExt.get(ext);
            if (!bucket) {
                bucket = [];
                byExt.set(ext, bucket);
            }
            bucket.push(relPath);
        }

        // Classify source vs test vs product
        if (isSourceFile(relPath)) {
            sourceFiles.push(relPath);
            if (isTestFile(relPath)) {
                testFiles.push(relPath);
            } else {
                productSourceFiles.push(relPath);
            }
        } else if (isTestFile(relPath)) {
            // Test file with non-source extension (e.g. test_foo.py)
            testFiles.push(relPath);
        }
    }

    const elapsed = Date.now() - start;
    log.info(`Built workspace index: ${allFiles.length} files, ${sourceFiles.length} source, ${testFiles.length} test, ${productSourceFiles.length} product in ${elapsed}ms`);

    return {
        workspacePath,
        allFiles,
        sourceFiles,
        testFiles,
        productSourceFiles,
        byExt,
    };
}
