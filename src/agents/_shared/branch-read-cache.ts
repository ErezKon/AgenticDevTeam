/**
 * Branch-scoped read cache (Plan 24, C6).
 *
 * A module-level cache keyed by `(worktreePath, relPath)` that survives agent
 * instance lifetimes.  When a `read_file` returns the same content as the
 * cached entry, the result is replaced with `[CACHED]` and no budget is
 * consumed.
 *
 * Invalidation: any mutating tool call (`write_file`, `edit_file`, `create_file`,
 * `delete_file`, or a non-read `run_command`) on a given worktree path clears
 * all cached entries for that worktree.
 */
import { getLogger } from '../../utils/logger';

const log = getLogger('[branch-read-cache]', 226);

// ─── Types ──────────────────────────────────────────────────────────────────

interface CacheEntry {
    /** Content hash (simple string length + first/last chars for fast comparison). */
    hash: string;
    /** The full content (for exact match verification). */
    content: string;
}

// ─── Module-level cache ─────────────────────────────────────────────────────

/** Cache keyed by `worktreePath::relPath`. */
const _cache = new Map<string, CacheEntry>();

/** Track known worktree paths for invalidation grouping. */
const _worktreeEntries = new Map<string, Set<string>>();

// ─── Helpers ────────────────────────────────────────────────────────────────

function cacheKey(worktreePath: string, relPath: string): string {
    return `${worktreePath}::${relPath}`;
}

/**
 * Compute a fast hash for content comparison. Uses length + a sample of chars
 * rather than a full crypto hash, since false positives are caught by the
 * exact comparison and the cost of a false negative is just a normal read.
 */
function contentHash(content: string): string {
    const len = content.length;
    if (len === 0) return '0::';
    const head = content.slice(0, 64);
    const tail = content.slice(-64);
    return `${len}::${head}::${tail}`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Check if a read result matches the cache for a given worktree + path.
 * Returns `true` (cache hit) if the content is identical to the cached entry.
 */
export function branchReadCacheHit(worktreePath: string, relPath: string, content: string): boolean {
    const key = cacheKey(worktreePath, relPath);
    const entry = _cache.get(key);
    if (!entry) return false;

    // Fast hash check first, then exact comparison
    const hash = contentHash(content);
    if (hash !== entry.hash) return false;
    return content === entry.content;
}

/**
 * Store a read result in the cache for a given worktree + path.
 */
export function branchReadCacheStore(worktreePath: string, relPath: string, content: string): void {
    const key = cacheKey(worktreePath, relPath);
    _cache.set(key, { hash: contentHash(content), content });

    // Track this entry under its worktree for invalidation
    let entries = _worktreeEntries.get(worktreePath);
    if (!entries) {
        entries = new Set();
        _worktreeEntries.set(worktreePath, entries);
    }
    entries.add(key);
}

/**
 * Invalidate all cached entries for a worktree path.
 * Called when any mutating tool call is made on that worktree.
 */
export function branchReadCacheInvalidate(worktreePath: string): void {
    const entries = _worktreeEntries.get(worktreePath);
    if (!entries || entries.size === 0) return;

    log.debug(`invalidating ${entries.size} cached read(s) for worktree "${worktreePath}"`);
    for (const key of entries) {
        _cache.delete(key);
    }
    entries.clear();
}

/**
 * Invalidate a single file's cached entry (for targeted invalidation).
 */
export function branchReadCacheInvalidateFile(worktreePath: string, relPath: string): void {
    const key = cacheKey(worktreePath, relPath);
    if (_cache.delete(key)) {
        const entries = _worktreeEntries.get(worktreePath);
        entries?.delete(key);
    }
}

/** Get the current cache size (for diagnostics). */
export function branchReadCacheSize(): number {
    return _cache.size;
}

/** Clear the entire cache (for testing). */
export function _resetBranchReadCache(): void {
    _cache.clear();
    _worktreeEntries.clear();
}
