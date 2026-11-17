/**
 * Model-id matching shared by pricing and the prompt-cache minimums (Plan 30-06).
 *
 * Providers ship point releases and dated ids (`claude-opus-5-5`,
 * `claude-haiku-4-5-20251001`) faster than any table is updated. An exact-match
 * lookup priced claude-opus-5-5 at $0 in the claudeopus5 run, so neither the
 * report nor the cost caps could see roughly $9.70 of its spend.
 */

/**
 * The longest id in `ids` that `model` equals or extends at a separator:
 * `claude-opus-5` matches `claude-opus-5-5` and `claude-opus-5@20260101`, but
 * never `claude-opus-50`. Null when no id matches.
 */
export function longestIdPrefix(model: string, ids: Iterable<string>): string | null {
    let best: string | null = null;
    for (const id of ids) {
        const matches = model === id || (model.startsWith(id) && !/[a-z0-9]/i.test(model[id.length]));
        if (matches && (best === null || id.length > best.length)) best = id;
    }
    return best;
}
