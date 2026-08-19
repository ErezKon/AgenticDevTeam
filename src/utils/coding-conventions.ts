/**
 * Coding Conventions — Mapping, Deployment & Prompt Generation.
 *
 * Maps language/framework names (from the dev registry and Architect tech
 * stack decisions) to convention `.md` file names, copies them into the
 * project workspace under `.conventions/`, and generates the prompt snippet
 * that instructs agents to read them before writing code.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TechDecision } from '../agents/_shared/base-schemas';
import { logToolAction } from './logger';
import { LogColors } from './log-colors.util';
import { CONVENTIONS_INLINE_DIGEST } from '../config';
import { buildConventionsDigest } from './conventions-digest';

const TAG = `${LogColors.BRIGHT_BLUE}[conventions]${LogColors.RESET}`;

// ─── Source directory ────────────────────────────────────────────────────────

/** Absolute path to the convention source files bundled with the project. */
const CONVENTIONS_SOURCE_DIR = path.resolve(
    __dirname, '..', 'Coding Conventions, Best Practices',
);

// ─── Language → file mapping ─────────────────────────────────────────────────

/**
 * Maps a language/framework identifier (case-insensitive key) to the list of
 * convention `.md` files that apply.  Keys are stored lower-cased; look-ups
 * normalise the input the same way.
 */
const LANGUAGE_FILE_MAP: Map<string, string[]> = new Map([
    ['react',                   ['React.md', 'JavaScript.md', 'TypeScript.md']],
    ['angular',                 ['Angular.md', 'TypeScript.md']],
    ['vue',                     ['Vue.md', 'JavaScript.md', 'TypeScript.md']],
    ['vue.js',                  ['Vue.md', 'JavaScript.md', 'TypeScript.md']],
    ['typescript',              ['TypeScript.md', 'JavaScript.md']],
    ['javascript',              ['JavaScript.md']],
    ['c#/.net',                 ['CSharp.md']],
    ['c#',                      ['CSharp.md']],
    ['java/spring',             ['Java.md']],
    ['java',                    ['Java.md']],
    ['go',                      ['Go.md']],
    ['python',                  ['Python.md']],
    ['python/fastapi/django',   ['Python.md']],
    ['node.js/express',         ['JavaScript.md', 'TypeScript.md']],
    ['node.js',                 ['JavaScript.md', 'TypeScript.md']],
    ['html/css',                ['HTML.md', 'CSS.md']],
    ['html',                    ['HTML.md']],
    ['css',                     ['CSS.md']],
    ['sass',                    ['SCSS.md', 'CSS.md']],
    ['scss',                    ['SCSS.md', 'CSS.md']],
    ['tailwind',                ['CSS.md']],
    ['svelte',                  ['JavaScript.md', 'TypeScript.md']],
    ['c',                       ['C.md']],
    ['c++',                     ['CPlusPlus.md']],
]);

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve the set of convention file names an agent should read.
 *
 * Combines two sources and deduplicates:
 *  1. Static agent languages (from the dev registry).
 *  2. Dynamic tech-stack choices (from the Architect).
 *
 * `Universal.md` is always included.
 *
 * @returns Sorted, deduplicated array of `.md` file names.
 */
export function resolveConventionFiles(
    agentLanguages: string[],
    techStack: TechDecision[] = [],
): string[] {
    const files = new Set<string>(['Universal.md']);

    // 1. Agent languages
    for (const lang of agentLanguages) {
        const mapped = LANGUAGE_FILE_MAP.get(lang.toLowerCase());
        if (mapped) mapped.forEach((f) => files.add(f));
    }

    // 2. Tech-stack choices (use the `choice` field)
    for (const decision of techStack) {
        const mapped = LANGUAGE_FILE_MAP.get(decision.choice.toLowerCase());
        if (mapped) mapped.forEach((f) => files.add(f));
    }

    return [...files].sort();
}

/**
 * Copy the specified convention files from the source directory into
 * `<workspace>/.conventions/`.
 *
 * @returns Array of workspace-relative paths (e.g. `.conventions/React.md`).
 */
export function deployConventionsToWorkspace(
    workspacePath: string,
    fileNames: string[],
): string[] {
    const targetDir = path.join(workspacePath, '.conventions');
    fs.mkdirSync(targetDir, { recursive: true });

    const deployed: string[] = [];

    for (const fileName of fileNames) {
        const src = path.join(CONVENTIONS_SOURCE_DIR, fileName);
        const dst = path.join(targetDir, fileName);

        if (!fs.existsSync(src)) {
            logToolAction(`${TAG} Convention file not found, skipping: ${fileName}`);
            continue;
        }

        fs.copyFileSync(src, dst);
        deployed.push(path.join('.conventions', fileName));
    }

    logToolAction(`${TAG} Deployed ${deployed.length} convention file(s) to ${targetDir}`);
    return deployed;
}

/**
 * Generate the prompt snippet that instructs an agent to read its convention
 * files before writing any code.
 *
 * @param fileNames  Convention file names (e.g. `['Universal.md', 'React.md']`).
 * @returns XML-tagged instruction block to embed in the agent's system prompt.
 */
export function getConventionReadInstructions(fileNames: string[]): string {
    if (fileNames.length === 0) return '';

    if (!CONVENTIONS_INLINE_DIGEST) {
        // Fallback: tell agents to read_file each convention file at runtime.
        const fileList = fileNames
            .map((f) => `    - .conventions/${f}`)
            .join('\n');

        return `<coding_conventions>
    BEFORE writing any code, you MUST read the following coding convention files
    using the read_file tool. These contain mandatory coding standards you must follow:
${fileList}
    Follow ALL rules in these files. They define naming conventions, code structure,
    error handling patterns, testing standards, and more for your technology stack.
    If you are making changes across multiple assignments, re-read the relevant
    convention file before starting each new assignment.
</coding_conventions>`;
    }

    // Inline digest: inject extracted imperative rules directly into the prompt.
    return `<coding_conventions>\n${buildConventionsDigest(fileNames)}\n` +
        `Full references exist at .conventions/*.md - read one ONLY if you need ` +
        `detail beyond the rules above.\n</coding_conventions>`;
}
