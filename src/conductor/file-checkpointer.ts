/**
 * File-backed checkpoint saver — extends MemorySaver with write-through
 * persistence so a HITL or crashed run can survive a server restart.
 *
 * Serialises the in-memory storage maps to `<outputPath>/checkpoints.json`
 * on every `put`, and rehydrates from disk on construction. This is a
 * minimal wrapper, not a production database; it is fine for single-process
 * use but must not be shared across concurrent processes.
 *
 * Gated behind CHECKPOINT_PERSIST (default false).
 */
import { MemorySaver } from '@langchain/langgraph';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../utils/logger';

const log = getLogger('[FileCheckpointer]', 183);

export class FileCheckpointer extends MemorySaver {
    private readonly filePath: string;

    constructor(outputPath: string) {
        super();
        this.filePath = path.join(outputPath, 'checkpoints.json');
        this._loadFromDisk();
    }

    // ── Write-through on put ────────────────────────────────────────────

    async put(
        config: Parameters<MemorySaver['put']>[0],
        checkpoint: Parameters<MemorySaver['put']>[1],
        metadata: Parameters<MemorySaver['put']>[2],
    ): ReturnType<MemorySaver['put']> {
        const result = await super.put(config, checkpoint, metadata);
        this._saveToDisk();
        return result;
    }

    async putWrites(
        config: Parameters<MemorySaver['putWrites']>[0],
        writes: Parameters<MemorySaver['putWrites']>[1],
        taskId: Parameters<MemorySaver['putWrites']>[2],
    ): ReturnType<MemorySaver['putWrites']> {
        const result = await super.putWrites(config, writes, taskId);
        this._saveToDisk();
        return result;
    }

    // ── Serialisation helpers ────────────────────────────────────────────

    /** Persist in-memory storage to disk. Never throws. */
    private _saveToDisk(): void {
        try {
            const storage = (this as any).storage;
            const writes = (this as any).writes;
            const data = {
                storage: this._deepClone(storage),
                writes: this._deepClone(writes),
            };
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(this.filePath, JSON.stringify(data), 'utf-8');
        } catch (err: any) {
            log.warn(`Failed to persist checkpoints: ${err.message}`);
        }
    }

    /** Rehydrate from disk if the file exists. Never throws. */
    private _loadFromDisk(): void {
        try {
            if (!fs.existsSync(this.filePath)) return;
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            const data = JSON.parse(raw);
            if (data.storage) {
                (this as any).storage = data.storage;
            }
            if (data.writes) {
                (this as any).writes = data.writes;
            }
            log.info(`Restored checkpoints from ${this.filePath}`);
        } catch (err: any) {
            log.warn(`Failed to load checkpoints from disk: ${err.message}`);
        }
    }

    /** Deep-clone a value for JSON serialisation. */
    private _deepClone(value: any): any {
        return JSON.parse(JSON.stringify(value));
    }
}
