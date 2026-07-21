import { z } from 'zod';

// ─── Codebase Analysis (for maintain mode) ──────────────────────────────────

export const CodebaseFileEntrySchema = z.object({
    path: z.string().describe('Relative file path'),
    type: z.enum(['source', 'config', 'test', 'doc', 'migration', 'asset', 'other'])
        .describe('File category'),
    language: z.string().describe('Programming language or file type'),
    summary: z.string().describe('One-line summary of what this file does'),
    linesOfCode: z.number().describe('Approximate line count'),
});

export const CodebaseModuleSchema = z.object({
    name: z.string().describe('Module/package/directory name'),
    path: z.string().describe('Relative directory path'),
    responsibility: z.string().describe('What this module is responsible for'),
    files: z.array(CodebaseFileEntrySchema).describe('Files in this module'),
    dependencies: z.array(z.string()).describe('Other modules this depends on'),
    externalDependencies: z.array(z.string()).describe('External packages used'),
});

export const CodebaseAnalysisSchema = z.object({
    projectName: z.string().describe('Inferred project name'),
    projectType: z.string().describe('e.g. "web app", "API", "CLI tool", "library"'),
    primaryLanguages: z.array(z.string()).describe('Main languages used'),
    frameworks: z.array(z.string()).describe('Frameworks detected (e.g. React, Express, Spring)'),
    architecture: z.object({
        style: z.string().describe('Detected architecture style'),
        description: z.string().describe('How the system is structured'),
        mermaidDiagram: z.string().describe('Component diagram of the existing system'),
    }),
    modules: z.array(CodebaseModuleSchema).describe('Major modules/packages'),
    database: z.object({
        engine: z.string().optional().describe('Detected DB engine if any'),
        ormOrDriver: z.string().optional().describe('ORM or DB driver used'),
        hasExistingMigrations: z.boolean().describe('Whether migration files exist'),
        schemaDescription: z.string().optional().describe('Summary of the data model'),
    }),
    testing: z.object({
        hasTests: z.boolean().describe('Whether tests exist'),
        frameworks: z.array(z.string()).describe('Test frameworks detected'),
        coverage: z.string().optional().describe('Estimated or configured coverage'),
    }),
    buildAndDeploy: z.object({
        buildTool: z.string().optional().describe('e.g. webpack, vite, maven, go build'),
        containerized: z.boolean().describe('Whether Docker/container files exist'),
        ciCd: z.string().optional().describe('Detected CI/CD setup'),
    }),
    knownIssues: z.array(z.string()).describe('Issues detected during analysis (e.g. outdated deps, missing types, no tests)'),
    entryPoints: z.array(z.object({
        file: z.string().describe('Entry point file path'),
        description: z.string().describe('What this entry point does'),
    })).describe('Main entry points of the application'),
    lastAnalyzedAt: z.string().describe('ISO timestamp of this analysis'),
    fileTree: z.string().describe('Compact file tree representation of the project'),
});

export type CodebaseAnalysis = z.infer<typeof CodebaseAnalysisSchema>;
