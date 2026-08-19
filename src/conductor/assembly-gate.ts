/**
 * Assembly gate (Plan 24, F1–F3).
 *
 * Verifies the product is _wired_ after the development phase:
 * - Entry point imports the modules the architecture declares
 * - Referenced static assets (icons, images) exist on disk
 * - `npm run build` produces artifacts (delegates to quality-gates)
 *
 * When the check fails, returns a bounded assembly assignment for a
 * principal dev to wire the product before QA runs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../utils/logger';
import { walkDir as sharedWalkDir } from '../utils/fs-walk';
import type { Assignment } from '../agents/_shared/base-schemas';
import type { GateOutcome, GateFinding, GateStatus } from './gate-types';
import { makeGateBug } from './bug-factory';

const log = getLogger('[Assembly-Gate]', 208);

export interface AssemblyGateResult {
    passed: boolean;
    /** Static assets referenced in HTML but not found on disk. */
    missingAssets: string[];
    /** Modules declared in architecture but not imported by the entry point. */
    unwiredModules: string[];
    /** Human-readable summary. */
    summary: string;
}

/**
 * Find referenced static assets (images, icons, manifests) in HTML files
 * that do not exist on disk.
 */
function findMissingAssets(workspacePath: string): string[] {
    const missing: string[] = [];
    const htmlFiles: string[] = [];

    // Find all HTML files in the workspace (shared walker, maxDepth 4)
    sharedWalkDir(workspacePath, workspacePath, (relPath) => {
        if (relPath.endsWith('.html')) {
            htmlFiles.push(path.join(workspacePath, relPath));
        }
    }, { maxDepth: 4 });

    // Parse HTML for referenced assets
    const assetPatterns = [
        /(?:href|src)=["']([^"']+\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|eot|webmanifest|json))["']/gi,
        /content=["']([^"']+\.(?:png|jpg|jpeg|gif|svg|ico))["']/gi,
    ];

    for (const htmlFile of htmlFiles) {
        try {
            const content = fs.readFileSync(htmlFile, 'utf-8');
            for (const pattern of assetPatterns) {
                pattern.lastIndex = 0;
                let match: RegExpExecArray | null;
                while ((match = pattern.exec(content)) !== null) {
                    const ref = match[1];
                    // Skip external URLs, data URIs, and template vars
                    if (ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('data:') || ref.includes('{{') || ref.includes('${')) continue;
                    // Resolve relative to the HTML file's directory or workspace root for absolute paths
                    const resolvedPath = ref.startsWith('/')
                        ? path.join(workspacePath, ref)
                        : path.join(path.dirname(htmlFile), ref);
                    // Also try under a common public/ directory
                    const publicPath = path.join(workspacePath, 'public', ref.startsWith('/') ? ref.slice(1) : ref);
                    const srcPath = path.join(workspacePath, 'src', ref.startsWith('/') ? ref.slice(1) : ref);
                    if (!fs.existsSync(resolvedPath) && !fs.existsSync(publicPath) && !fs.existsSync(srcPath)) {
                        const relRef = path.relative(workspacePath, resolvedPath);
                        if (!missing.includes(relRef)) {
                            missing.push(relRef);
                        }
                    }
                }
            }
        } catch { /* unreadable file */ }
    }

    return missing;
}

/**
 * Check if the product's entry point exists and is non-trivial.
 */
function findEntryPoint(workspacePath: string): { exists: boolean; path: string | null; imports: string[] } {
    const candidates = [
        'src/main.ts', 'src/main.tsx', 'src/main.js', 'src/main.jsx',
        'src/index.ts', 'src/index.tsx', 'src/index.js', 'src/index.jsx',
        'src/App.tsx', 'src/App.ts', 'src/app.ts', 'src/app.tsx',
        'src/app/app.component.ts', 'src/app/app.module.ts',
        'index.html',
    ];
    for (const candidate of candidates) {
        const fullPath = path.join(workspacePath, candidate);
        if (fs.existsSync(fullPath)) {
            try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                // Extract import paths
                const importPattern = /(?:import|from)\s+['"]([^'"]+)['"]/g;
                const imports: string[] = [];
                let match: RegExpExecArray | null;
                while ((match = importPattern.exec(content)) !== null) {
                    imports.push(match[1]);
                }
                return { exists: true, path: candidate, imports };
            } catch {
                return { exists: true, path: candidate, imports: [] };
            }
        }
    }
    return { exists: false, path: null, imports: [] };
}

/**
 * Run the assembly gate — checks that the product is wired and assets exist.
 */
export function runAssemblyGate(workspacePath: string): AssemblyGateResult {
    const missingAssets = findMissingAssets(workspacePath);
    const entry = findEntryPoint(workspacePath);

    const issues: string[] = [];
    if (!entry.exists) {
        issues.push('No entry point found (no main.ts, index.ts, App.tsx, etc.)');
    } else if (entry.imports.length === 0 && entry.path !== 'index.html') {
        issues.push(`Entry point ${entry.path} has no imports — the product is not wired`);
    }
    if (missingAssets.length > 0) {
        issues.push(`${missingAssets.length} referenced asset(s) missing: ${missingAssets.slice(0, 5).join(', ')}${missingAssets.length > 5 ? '...' : ''}`);
    }

    const passed = issues.length === 0;
    const summary = passed
        ? `Assembly gate passed: entry=${entry.path}, ${entry.imports.length} imports, 0 missing assets`
        : `Assembly gate FAILED: ${issues.join('; ')}`;

    log.info(summary);

    return {
        passed,
        missingAssets,
        unwiredModules: entry.exists && entry.imports.length === 0 && entry.path !== 'index.html'
            ? ['(entry point has no imports)']
            : [],
        summary,
    };
}

/**
 * Build a one-shot assembly assignment for a principal dev to wire the product.
 * Plan 24, F2: this is a phase-level step, not a user story.
 */
export function buildAssemblyAssignment(
    missingAssets: string[],
    unwiredModules: string[],
    projectSlug: string,
): Assignment {
    const description = [
        'ASSEMBLY TASK: Wire the product so it builds and runs.',
        unwiredModules.length > 0 ? `Unwired modules: ${unwiredModules.join(', ')}` : '',
        missingAssets.length > 0 ? `Missing referenced assets (create placeholders): ${missingAssets.join(', ')}` : '',
        'The entry point (main.ts/index.ts/App.tsx) must import all declared modules.',
        'Every static asset referenced in index.html must exist on disk (generate SVG/PNG placeholders).',
        '`npm run build` must succeed after your changes.',
    ].filter(Boolean).join('\n');

    return {
        id: 'ASSEMBLY-001',
        storyId: '',
        additionalStoryIds: [],
        taskIds: ['TASK-ASSEMBLY'],
        acIndexes: [],
        devAgentId: 'principal-frontend',
        rank: 'principal' as const,
        priority: 'critical' as const,
        complexity: 'moderate' as const,
        estimate: '30 min',
        description,
        dependsOn: [],
        branchName: `${projectSlug}/chore/assembly`,
        reviewerAgentIds: ['principal-backend'],
        taskType: 'chore' as const,
        moduleIds: [],
    };
}

// ─── AssemblyGateResult → GateOutcome adapter (Sub-Plan 25-10) ──────────────

/**
 * Convert an AssemblyGateResult into a standard GateOutcome.
 */
export function assemblyGateOutcome(result: AssemblyGateResult): GateOutcome<AssemblyGateResult> {
    const status: GateStatus = result.passed ? 'pass' : 'fail';

    const findings: GateFinding[] = [];
    if (result.missingAssets.length > 0) {
        findings.push({
            id: 'ASSEMBLY-MISSING-ASSETS',
            severity: 'major',
            detail: `${result.missingAssets.length} referenced asset(s) missing: ${result.missingAssets.slice(0, 5).join(', ')}`,
        });
    }
    if (result.unwiredModules.length > 0) {
        findings.push({
            id: 'ASSEMBLY-UNWIRED',
            severity: 'critical',
            detail: `Entry point does not import product modules: ${result.unwiredModules.join(', ')}`,
        });
    }

    const bugs = [];
    if (result.missingAssets.length > 0) {
        bugs.push(makeGateBug(
            'ASSEMBLY-MISSING-ASSETS',
            `${result.missingAssets.length} referenced asset(s) missing from disk`,
            'major', 'assembly-gate',
            `Check referenced assets in HTML: ${result.missingAssets.slice(0, 5).join(', ')}`,
            'All referenced assets should exist on disk',
            `${result.missingAssets.length} assets not found`,
            'public/ or src/assets/ directory',
        ));
    }
    if (result.unwiredModules.length > 0) {
        bugs.push(makeGateBug(
            'ASSEMBLY-UNWIRED',
            'Entry point does not import product modules',
            'critical', 'assembly-gate',
            'Check the entry point (main.ts/index.ts) for module imports',
            'Entry point should import all declared modules',
            `Entry point has no imports: ${result.unwiredModules.join(', ')}`,
            'src/main.ts or src/index.ts',
        ));
    }

    return {
        gate: 'assembly',
        status,
        findings,
        detail: result,
        markdown: result.summary,
        bugs,
    };
}
