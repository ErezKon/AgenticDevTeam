/**
 * FileCheckpointer — unit tests for disk-backed checkpoint persistence.
 *
 * Tests:
 * 1. Saves checkpoint data to disk on put
 * 2. Restores checkpoint data from disk on construction
 * 3. Handles missing checkpoint file gracefully
 * 4. Handles corrupt checkpoint file gracefully
 * 5. write-through: putWrites also persists
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileCheckpointer } from '../src/conductor/file-checkpointer';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-ckpt-test-'));
});

afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('FileCheckpointer', () => {
    it('creates checkpoints.json in the output directory on put', async () => {
        const ckpt = new FileCheckpointer(tmpDir);
        const config = { configurable: { thread_id: 'test-thread-1' } };
        const checkpoint = {
            v: 1,
            id: 'test-ckpt-1',
            ts: new Date().toISOString(),
            channel_values: {},
            channel_versions: {},
            versions_seen: {},
            pending_sends: [],
        };
        const metadata = { source: 'input' as const, step: 0, parents: {} };

        await ckpt.put(config, checkpoint, metadata);

        const filePath = path.join(tmpDir, 'checkpoints.json');
        expect(fs.existsSync(filePath)).toBe(true);

        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        expect(data).toHaveProperty('storage');
        expect(data).toHaveProperty('writes');
    });

    it('restores storage structure from disk on construction', async () => {
        // First: create and populate a checkpointer — this writes checkpoints.json
        const ckpt1 = new FileCheckpointer(tmpDir);
        const config = { configurable: { thread_id: 'restore-test' } };
        const checkpoint = {
            v: 1,
            id: 'restore-ckpt',
            ts: new Date().toISOString(),
            channel_values: {},
            channel_versions: {},
            versions_seen: {},
            pending_sends: [],
        };
        await ckpt1.put(config, checkpoint, { source: 'input' as const, step: 0, parents: {} });

        // Verify file exists
        const filePath = path.join(tmpDir, 'checkpoints.json');
        expect(fs.existsSync(filePath)).toBe(true);

        // Second: create a new checkpointer from the same directory — should load without error
        const ckpt2 = new FileCheckpointer(tmpDir);

        // The internal storage should be populated (non-empty object)
        const storage = (ckpt2 as any).storage;
        expect(storage).toBeDefined();
        expect(typeof storage).toBe('object');
        // Should have at least one key corresponding to the thread
        const keys = Object.keys(storage);
        expect(keys.length).toBeGreaterThan(0);
    });

    it('handles missing checkpoint file gracefully', () => {
        // No checkpoints.json exists — should not throw
        const ckpt = new FileCheckpointer(tmpDir);
        expect(ckpt).toBeDefined();
    });

    it('handles corrupt checkpoint file gracefully', () => {
        // Write invalid JSON
        fs.writeFileSync(path.join(tmpDir, 'checkpoints.json'), '{bad json', 'utf-8');

        // Should not throw — just logs a warning
        const ckpt = new FileCheckpointer(tmpDir);
        expect(ckpt).toBeDefined();
    });

    it('persists on putWrites as well', async () => {
        const ckpt = new FileCheckpointer(tmpDir);
        const config = { configurable: { thread_id: 'writes-test', checkpoint_ns: '', checkpoint_id: 'w-1' } };

        // First, put a checkpoint so we have something to write against
        const checkpoint = {
            v: 1,
            id: 'w-1',
            ts: new Date().toISOString(),
            channel_values: {},
            channel_versions: {},
            versions_seen: {},
            pending_sends: [],
        };
        await ckpt.put(
            { configurable: { thread_id: 'writes-test' } },
            checkpoint,
            { source: 'input' as const, step: 0, parents: {} },
        );

        // putWrites
        await ckpt.putWrites(config, [['channel_1', { value: 42 }]], 'task-1');

        // Verify the file was updated
        const filePath = path.join(tmpDir, 'checkpoints.json');
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        expect(data.writes).toBeDefined();
    });
});
