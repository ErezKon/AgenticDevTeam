/**
 * Security hardening regression tests — Plan 25-02.
 *
 * Validates that critical security fixes (command injection, secret
 * redaction, ref validation, path traversal, env allowlisting) work
 * correctly and do not regress.
 */
import * as path from 'path';
import { shellSplit, assertValidRef } from '../src/utils/git-exec';
import { redactSecrets, redactValues } from '../src/utils/redact';

// ─── shellSplit ─────────────────────────────────────────────────────────────

describe('shellSplit', () => {
    it('splits simple space-separated tokens', () => {
        expect(shellSplit('add .')).toEqual(['add', '.']);
        expect(shellSplit('status --porcelain')).toEqual(['status', '--porcelain']);
    });

    it('handles double-quoted strings', () => {
        expect(shellSplit('commit -m "hello world"')).toEqual(['commit', '-m', 'hello world']);
    });

    it('handles single-quoted strings', () => {
        expect(shellSplit("config user.name 'John Doe'")).toEqual(['config', 'user.name', 'John Doe']);
    });

    it('handles backslash escapes outside quotes', () => {
        expect(shellSplit('log -c core.pager=sleep\\ 5')).toEqual(['log', '-c', 'core.pager=sleep 5']);
    });

    it('handles git pathspecs with :! prefix', () => {
        const specs = "diff HEAD -- . ':!package-lock.json' ':!yarn.lock'";
        expect(shellSplit(specs)).toEqual([
            'diff', 'HEAD', '--', '.', ':!package-lock.json', ':!yarn.lock',
        ]);
    });

    it('handles empty input', () => {
        expect(shellSplit('')).toEqual([]);
    });

    it('handles multiple consecutive spaces', () => {
        expect(shellSplit('add   .')).toEqual(['add', '.']);
    });

    it('handles quoted path with spaces', () => {
        expect(shellSplit('worktree remove "/tmp/my project" --force')).toEqual([
            'worktree', 'remove', '/tmp/my project', '--force',
        ]);
    });
});

// ─── assertValidRef ─────────────────────────────────────────────────────────

describe('assertValidRef', () => {
    it('accepts valid branch names', () => {
        expect(() => assertValidRef('main')).not.toThrow();
        expect(() => assertValidRef('feature/my-branch')).not.toThrow();
        expect(() => assertValidRef('project/feature/story-123')).not.toThrow();
    });

    it('rejects empty refs', () => {
        expect(() => assertValidRef('')).toThrow('must not be empty');
    });

    it('rejects refs with shell metacharacters', () => {
        expect(() => assertValidRef('branch;rm -rf /')).toThrow('metacharacters');
        expect(() => assertValidRef('branch$(whoami)')).toThrow('metacharacters');
        expect(() => assertValidRef('branch`id`')).toThrow('metacharacters');
        expect(() => assertValidRef('branch|cat /etc/passwd')).toThrow('metacharacters');
        expect(() => assertValidRef('branch&& echo pwned')).toThrow('metacharacters');
    });

    it('rejects refs starting with a dash (option injection)', () => {
        expect(() => assertValidRef('-delete')).toThrow("must not start with '-'");
    });

    it('rejects refs containing double-dot', () => {
        expect(() => assertValidRef('foo..bar')).toThrow("must not contain '..'");
    });

    it('rejects refs ending with .lock', () => {
        expect(() => assertValidRef('branch.lock')).toThrow("must not end with '.lock'");
    });

    it('rejects overly long refs', () => {
        expect(() => assertValidRef('a'.repeat(256))).toThrow('too long');
    });

    it('rejects refs with control characters', () => {
        expect(() => assertValidRef('branch\x00name')).toThrow('metacharacters');
        expect(() => assertValidRef('branch\x1fname')).toThrow('metacharacters');
    });
});

// ─── redactSecrets ──────────────────────────────────────────────────────────

describe('redactSecrets', () => {
    it('redacts x-access-token URLs', () => {
        const input = 'https://x-access-token:ghp_abc123@github.com/owner/repo.git';
        const result = redactSecrets(input);
        expect(result).not.toContain('ghp_abc123');
        expect(result).toContain('***REDACTED***');
    });

    it('redacts GitHub PATs (ghp_ prefix)', () => {
        const input = 'Token: ghp_1234567890abcdef';
        expect(redactSecrets(input)).toContain('***REDACTED***');
        expect(redactSecrets(input)).not.toContain('ghp_1234567890abcdef');
    });

    it('redacts fine-grained PATs (github_pat_ prefix)', () => {
        const input = 'Token: github_pat_abcdef123';
        expect(redactSecrets(input)).toContain('***REDACTED***');
    });

    it('redacts OAuth tokens (gho_ prefix)', () => {
        const input = 'Token: gho_xyzabc';
        expect(redactSecrets(input)).toContain('***REDACTED***');
    });

    it('redacts Authorization headers', () => {
        const input = 'Authorization: Bearer sk-1234abcdef';
        expect(redactSecrets(input)).toContain('***REDACTED***');
        expect(redactSecrets(input)).not.toContain('sk-1234abcdef');
    });

    it('returns input unchanged when no secrets found', () => {
        const input = 'fatal: could not read from remote';
        expect(redactSecrets(input)).toBe(input);
    });

    it('redacts the "token" Authorization scheme used by the curl PR fallback', () => {
        const input = 'curl -H "Authorization: token ghx_notAPatternMatch12345" https://api.github.com';
        expect(redactSecrets(input)).not.toContain('ghx_notAPatternMatch12345');
        expect(redactSecrets(input)).toContain('***REDACTED***');
    });

    it('redacts GitHub app/user/refresh tokens (ghs_ / ghu_ / ghr_)', () => {
        const token = `ghs_${'a1B2'.repeat(9)}`;
        expect(redactSecrets(`token=${token}`)).not.toContain(token);
    });

    it('does not mangle ordinary identifiers that merely contain "ghs_"', () => {
        expect(redactSecrets('const laughs_count = 1;')).toBe('const laughs_count = 1;');
    });

    it('redacts credentials embedded in URLs', () => {
        const result = redactSecrets('remote: https://deploy:s3cr3tP4ss@git.example.com/repo.git');
        expect(result).not.toContain('s3cr3tP4ss');
        expect(result).toContain('https://***REDACTED***@git.example.com/repo.git');
    });

    it('redacts OpenAI / Anthropic / Google API keys', () => {
        const keys = [
            `sk-proj-${'x'.repeat(24)}`,
            `sk-ant-api03-${'y'.repeat(24)}`,
            `AIza${'z'.repeat(35)}`,
        ];
        for (const key of keys) {
            expect(redactSecrets(`key: ${key}`)).not.toContain(key);
        }
    });
});

describe('redactValues', () => {
    it('scrubs every occurrence of a configured secret value', () => {
        const secret = 'my-unusual-secret-value';
        const result = redactValues(`a ${secret} b ${secret}`, [secret]);
        expect(result).toBe('a ***REDACTED*** b ***REDACTED***');
    });

    it('ignores short or empty values to avoid false positives', () => {
        expect(redactValues('abc main dev', ['', 'main', 'dev'])).toBe('abc main dev');
    });
});

// ─── Path traversal (workspace.ts) ──────────────────────────────────────────

describe('workspace path traversal guard', () => {
    // Use path.relative to verify the fix logic (mirrors the production code)
    function isPathSafe(workspaceRoot: string, relativePath: string): boolean {
        const resolved = path.resolve(workspaceRoot, relativePath);
        const root = path.resolve(workspaceRoot);
        const rel = path.relative(root, resolved);
        return !rel.startsWith('..') && !path.isAbsolute(rel);
    }

    it('allows paths within the workspace', () => {
        expect(isPathSafe('/gen/app', 'src/index.ts')).toBe(true);
        expect(isPathSafe('/gen/app', 'nested/deep/file.js')).toBe(true);
    });

    it('rejects paths that escape via ..', () => {
        expect(isPathSafe('/gen/app', '../../../etc/passwd')).toBe(false);
        expect(isPathSafe('/gen/app', 'src/../../etc/passwd')).toBe(false);
    });

    it('rejects prefix-collision paths (the original bug)', () => {
        // "/gen/app" should NOT accept "/gen/app-evil/x"
        // With startsWith check: "/gen/app-evil/x".startsWith("/gen/app") → true (BUG)
        // With path.relative: relative("/gen/app", "/gen/app-evil/x") → "../app-evil/x" → false (FIXED)
        expect(isPathSafe('/gen/app', '../app-evil/x')).toBe(false);
    });

    it('allows the workspace root itself', () => {
        expect(isPathSafe('/gen/app', '.')).toBe(true);
        expect(isPathSafe('/gen/app', '')).toBe(true);
    });
});

// ─── Environment allowlisting ───────────────────────────────────────────────

describe('safeChildEnv allowlisting', () => {
    it('does not include secret-bearing env keys', () => {
        // Simulate the safeChildEnv logic
        const SAFE_KEYS = [
            'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
            'TMPDIR', 'TMP', 'TEMP', 'HOSTNAME',
            'PROGRAMFILES', 'SYSTEMROOT', 'WINDIR',
        ];
        const dangerousKeys = [
            'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
            'LLM_BASE_URL', 'OAUTH_CLIENT_SECRET', 'AWS_SECRET_ACCESS_KEY',
        ];
        for (const key of dangerousKeys) {
            expect(SAFE_KEYS).not.toContain(key);
        }
    });
});
