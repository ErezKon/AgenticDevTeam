/**
 * Shared JSONL reader for tests that assert on append-only run artifacts
 * (debug/trace.jsonl, debug/errors.jsonl, …).
 */
import * as fs from 'fs';

/** Parse every non-empty line of a JSONL file; `[]` when the file does not exist. */
export function readJsonl(file: string): any[] {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
}
