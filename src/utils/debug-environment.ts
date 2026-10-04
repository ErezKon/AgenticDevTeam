/**
 * Environment fingerprint for the debug bundle (`debug/environment.json`).
 *
 * Captures what is needed to reproduce or explain a run: runtime, app
 * version + git commit, run metadata and the effective configuration.
 * Secret-bearing config values are masked here and redacted again by the
 * trace serializer. Raw `process.env` is never dumped — it holds credentials.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as config from '../config';

/** Config keys whose values are credentials. */
const SECRET_KEY_RE = /(?:_TOKEN|_SECRET|_API_KEY|_CLIENT_ID|PASSWORD)$/;

/** Module-interop keys that are not configuration. */
const INTEROP_KEYS = new Set(['default', '__esModule']);

/** Repository root of AgenticDevTeam itself (src/utils → ../..). */
const APP_ROOT = path.resolve(__dirname, '..', '..');

/** Every exported configuration value, with secrets reduced to `***set***` / `''`. */
export function maskedConfigSnapshot(): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
        if (typeof value === 'function' || INTEROP_KEYS.has(key)) continue;
        if (SECRET_KEY_RE.test(key) && typeof value === 'string') {
            snapshot[key] = value ? '***set***' : '';
        } else {
            snapshot[key] = value === undefined ? null : value;
        }
    }
    return snapshot;
}

/** Read the checked-out commit without spawning git (works in containers without git). */
function readGitHead(root: string): { ref: string | null; commit: string | null } {
    try {
        let gitDir = path.join(root, '.git');
        if (fs.statSync(gitDir).isFile()) {
            const pointer = fs.readFileSync(gitDir, 'utf-8').trim().replace(/^gitdir:\s*/, '');
            gitDir = path.resolve(root, pointer);
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
        if (!head.startsWith('ref:')) return { ref: null, commit: head };
        const ref = head.slice(4).trim();
        const loose = path.join(gitDir, ref);
        if (fs.existsSync(loose)) return { ref, commit: fs.readFileSync(loose, 'utf-8').trim() };
        const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf-8')
            .split('\n').find(line => line.endsWith(` ${ref}`));
        return { ref, commit: packed?.split(' ')[0] ?? null };
    } catch {
        return { ref: null, commit: null };
    }
}

function readPackageInfo(root: string): { name: string | null; version: string | null } {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
        return { name: pkg.name ?? null, version: pkg.version ?? null };
    } catch {
        return { name: null, version: null };
    }
}

/** Build the `environment.json` payload for a debug session. */
export function buildDebugEnvironment(run: Record<string, unknown>): Record<string, unknown> {
    const git = readGitHead(APP_ROOT);
    return {
        generatedAt: new Date().toISOString(),
        run,
        process: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            pid: process.pid,
            cwd: process.cwd(),
            argv: process.argv,
        },
        app: { ...readPackageInfo(APP_ROOT), gitRef: git.ref, gitCommit: git.commit },
        config: maskedConfigSnapshot(),
    };
}
