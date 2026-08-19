/**
 * CLI input helpers — readline wrapper, requirements gathering, repo target.
 *
 * Extracted from cli.ts in Sub-Plan 25-09 to reduce the 871-line monolith.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { LogColors, color256 } from '../utils/log-colors.util';
import { slugify } from '../utils/branch-naming';
import type { RepoTarget } from '../agents/_shared/base-schemas';

const TAG = `${color256(46)}[CLI]${LogColors.RESET}`;

// ─── Readline setup ─────────────────────────────────────────────────────────

let rl: readline.Interface | null = null;

/** Get (or lazily create) the global readline interface. */
export function getReadline(): readline.Interface {
    if (!rl) {
        rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
    }
    return rl;
}

/** Close the readline interface. */
export function closeReadline(): void {
    if (rl) {
        rl.close();
        rl = null;
    }
}

export function ask(prompt: string): Promise<string> {
    return new Promise((resolve) => {
        getReadline().question(`${TAG} ${prompt}`, (answer) => resolve(answer.trim()));
    });
}

// ─── Requirements input ─────────────────────────────────────────────────────

export async function getRequirements(): Promise<{ systemName: string; requirementsText?: string; requirementsDocPath?: string }> {
    const systemName = await ask('System name: ');
    if (!systemName) {
        console.log(`${TAG} System name is required.`);
        return getRequirements();
    }

    console.log(`${TAG} How to provide requirements?`);
    console.log('  1) File path (.md, .txt, .pdf, .docx)');
    console.log('  2) Type/paste text inline');

    const method = await ask('Choose [1-2]: ');

    if (method === '1') {
        const filePath = await ask('File path: ');
        const resolved = path.resolve(filePath);
        if (!fs.existsSync(resolved)) {
            console.log(`${TAG} File not found: ${resolved}`);
            return getRequirements();
        }
        return { systemName, requirementsDocPath: resolved };
    } else {
        console.log(`${TAG} Enter requirements (type END on a new line to finish):`);
        const lines: string[] = [];
        while (true) {
            const line = await ask('');
            if (line === 'END') break;
            lines.push(line);
        }
        return { systemName, requirementsText: lines.join('\n') };
    }
}

// ─── Repo target selection ──────────────────────────────────────────────────

export async function getRepoTarget(systemName: string): Promise<RepoTarget | undefined> {
    console.log(`\n${TAG} Where should this project be hosted?`);
    console.log('  1) Same repository (AgenticDevTeam)');
    console.log('  2) New GitHub repository');
    console.log('  3) Existing GitHub repository');

    const choice = await ask('Choose [1-3]: ');

    switch (choice) {
        case '1':
            return { type: 'same-repo', isPrivate: true };

        case '2': {
            const defaultName = slugify(systemName);
            const repoName = (await ask(`Repository name [${defaultName}]: `)) || defaultName;
            const privateAnswer = await ask('Private repository? [Y/n]: ');
            const isPrivate = !privateAnswer || privateAnswer.toLowerCase() !== 'n';
            return { type: 'new-repo', repoName, isPrivate };
        }

        case '3': {
            const repoName = await ask('Repository name: ');
            if (!repoName) {
                console.log(`${TAG} Repository name is required.`);
                return getRepoTarget(systemName);
            }
            return { type: 'existing-repo', repoName, isPrivate: true };
        }

        default:
            console.log(`${TAG} Invalid choice. Defaulting to same repository.`);
            return undefined;
    }
}
