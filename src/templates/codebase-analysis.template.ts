/**
 * Markdown template for rendering a CodebaseAnalysis into a
 * human-readable codebase-analysis.md file.
 */
import type { CodebaseAnalysis } from '../agents/_shared/base-schemas';

/**
 * Render a CodebaseAnalysis object into a structured Markdown string.
 */
export function renderCodebaseAnalysis(analysis: CodebaseAnalysis): string {
    const sections: string[] = [];

    // ── Header ───────────────────────────────────────────────────────────
    sections.push(`# Codebase Analysis: ${analysis.projectName}`);
    sections.push(`> Last analyzed: ${analysis.lastAnalyzedAt}\n`);

    // ── Overview ─────────────────────────────────────────────────────────
    sections.push(`## Overview\n`);
    sections.push(`- **Type:** ${analysis.projectType}`);
    sections.push(`- **Languages:** ${analysis.primaryLanguages.join(', ')}`);
    sections.push(`- **Frameworks:** ${analysis.frameworks.join(', ')}`);

    // ── Architecture ─────────────────────────────────────────────────────
    sections.push(`\n## Architecture\n`);
    sections.push(`**Style:** ${analysis.architecture.style}\n`);
    sections.push(analysis.architecture.description);
    if (analysis.architecture.mermaidDiagram) {
        sections.push(`\n\`\`\`mermaid\n${analysis.architecture.mermaidDiagram}\n\`\`\``);
    }

    // ── Modules ──────────────────────────────────────────────────────────
    sections.push(`\n## Modules (${analysis.modules.length})\n`);
    for (const mod of analysis.modules) {
        sections.push(`### ${mod.name} (\`${mod.path}\`)\n`);
        sections.push(mod.responsibility);
        sections.push(`\n- **Files:** ${mod.files.length}`);
        if (mod.dependencies.length > 0) {
            sections.push(`- **Internal deps:** ${mod.dependencies.join(', ')}`);
        }
        if (mod.externalDependencies.length > 0) {
            sections.push(`- **External deps:** ${mod.externalDependencies.join(', ')}`);
        }
        sections.push('');
        if (mod.files.length > 0) {
            sections.push(`| File | Type | Language | Summary |`);
            sections.push(`|------|------|----------|---------|`);
            for (const f of mod.files) {
                sections.push(`| \`${f.path}\` | ${f.type} | ${f.language} | ${f.summary} |`);
            }
            sections.push('');
        }
    }

    // ── Database ─────────────────────────────────────────────────────────
    sections.push(`## Database\n`);
    if (analysis.database.engine) {
        sections.push(`- **Engine:** ${analysis.database.engine}`);
    } else {
        sections.push(`- **Engine:** Not detected`);
    }
    if (analysis.database.ormOrDriver) {
        sections.push(`- **ORM/Driver:** ${analysis.database.ormOrDriver}`);
    }
    sections.push(`- **Existing migrations:** ${analysis.database.hasExistingMigrations ? 'Yes' : 'No'}`);
    if (analysis.database.schemaDescription) {
        sections.push(`\n${analysis.database.schemaDescription}`);
    }

    // ── Testing ──────────────────────────────────────────────────────────
    sections.push(`\n## Testing\n`);
    sections.push(`- **Has tests:** ${analysis.testing.hasTests ? 'Yes' : 'No'}`);
    if (analysis.testing.frameworks.length > 0) {
        sections.push(`- **Frameworks:** ${analysis.testing.frameworks.join(', ')}`);
    }
    if (analysis.testing.coverage) {
        sections.push(`- **Coverage:** ${analysis.testing.coverage}`);
    }

    // ── Build & Deploy ───────────────────────────────────────────────────
    sections.push(`\n## Build & Deploy\n`);
    if (analysis.buildAndDeploy.buildTool) {
        sections.push(`- **Build tool:** ${analysis.buildAndDeploy.buildTool}`);
    }
    sections.push(`- **Containerized:** ${analysis.buildAndDeploy.containerized ? 'Yes' : 'No'}`);
    if (analysis.buildAndDeploy.ciCd) {
        sections.push(`- **CI/CD:** ${analysis.buildAndDeploy.ciCd}`);
    }

    // ── Entry Points ─────────────────────────────────────────────────────
    if (analysis.entryPoints.length > 0) {
        sections.push(`\n## Entry Points\n`);
        for (const ep of analysis.entryPoints) {
            sections.push(`- **\`${ep.file}\`** — ${ep.description}`);
        }
    }

    // ── Known Issues ─────────────────────────────────────────────────────
    if (analysis.knownIssues.length > 0) {
        sections.push(`\n## Known Issues\n`);
        for (const issue of analysis.knownIssues) {
            sections.push(`- ${issue}`);
        }
    }

    // ── File Tree ────────────────────────────────────────────────────────
    sections.push(`\n## File Tree\n`);
    sections.push('```');
    sections.push(analysis.fileTree);
    sections.push('```');

    return sections.join('\n') + '\n';
}
