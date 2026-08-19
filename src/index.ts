/**
 * REST + WebSocket server — dashboard backend.
 *
 * Endpoints:
 * - POST /api/run              Start a new run
 * - GET  /api/runs             List all active HITL sessions
 * - GET  /api/run/:id          Get run state
 * - POST /api/run/:id/approve  Approve a HITL phase
 * - GET  /api/run/:id/artifact/:agentId  Get a single artifact with content
 * - GET  /api/run/:id/artifacts          List all artifacts with content
 * - GET  /api/run/:id/prs      List PRs for a run
 * - GET  /api/agents           List all agents
 * - GET  /api/events           Recent run events (ring buffer backfill)
 * - GET  /api/runs/stoppable   List runs that can be continued (Plan 23)
 * - POST /api/run/continue     Continue a stopped run (Plan 23)
 *
 * WebSocket:
 * - ws://host:port/ws       Real-time transcript + state updates
 */

// Polyfill globalThis.crypto for Node 18 (required by @langchain/core uuid)
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) {
  (globalThis as any).crypto = webcrypto;
}

// TLS: honour NODE_EXTRA_CA_CERTS for corporate CAs instead of disabling
// certificate validation globally. Only disable TLS verification if the
// operator explicitly sets NODE_TLS_REJECT_UNAUTHORIZED=0 in their .env file.
// (Plan 25-02, D1: removed default '0' assignment)
import './env';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { DASHBOARD_PORT } from './config';
import { AGENT_REGISTRY } from './agents/registry';
import { runAutonomous, runHumanInTheLoop, continueRun, type RunSession } from './conductor/run';
import { listStoppedRuns, collectRunState, reconstructState } from './conductor/continue';
import { parseRequirementsFile } from './tools/requirements/parse-requirements';
import { getLogger } from './utils/logger';
import { tokenTracker } from './utils/token-tracker';
import { redactState } from './utils/run-snapshot';
import { installProcessHandlers } from './utils/crash-handlers';
import { onRunEvent, getRecentEvents } from './utils/event-bus';
import * as path from 'path';
import * as fs from 'fs';

const log = getLogger('[Server]', 33);

/** API token for bearer-token authentication (optional but recommended). */
const API_TOKEN = process.env.API_TOKEN ?? '';

const app = express();
// Restrict CORS to the dashboard origin (localhost dev server).
app.use(cors({ origin: API_TOKEN ? ['http://localhost:4200', `http://127.0.0.1:${DASHBOARD_PORT}`] : undefined }));
app.use(express.json({ limit: '10mb' }));

// ─── Bearer-token auth middleware (when API_TOKEN is set) ────────────────────
if (API_TOKEN) {
    app.use('/api', (req, res, next) => {
        const auth = req.headers.authorization;
        if (!auth || auth !== `Bearer ${API_TOKEN}`) {
            res.status(401).json({ error: 'Unauthorized: provide Authorization: Bearer <API_TOKEN>' });
            return;
        }
        next();
    });
    log.info('API_TOKEN is set — API endpoints require Bearer authentication');
}

// ─── In-memory session store (Sub-Plan 25-14: fix key-space collision) ──────
//
// Both sessions and states are now keyed consistently by threadId.
// A secondary index maps systemName → threadId for autonomous run lookup.
// LRU eviction prevents unbounded growth in long-running server processes.

const MAX_CACHED_RUNS = 200;

const sessions = new Map<string, RunSession>();
const states = new Map<string, any>();
/** systemName → threadId alias for backward-compat lookup of autonomous runs. */
const _systemNameIndex = new Map<string, string>();

/** Evict oldest entries when maps exceed MAX_CACHED_RUNS. */
function _evictIfNeeded(): void {
    while (states.size > MAX_CACHED_RUNS) {
        const oldest = states.keys().next().value;
        if (oldest === undefined) break;
        states.delete(oldest);
        sessions.delete(oldest);
    }
    while (_systemNameIndex.size > MAX_CACHED_RUNS) {
        const oldest = _systemNameIndex.keys().next().value;
        if (oldest === undefined) break;
        _systemNameIndex.delete(oldest);
    }
}

// ─── WebSocket broadcast ────────────────────────────────────────────────────

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

const wsClients = new Set<WebSocket>();

wss.on('connection', (ws) => {
    wsClients.add(ws);
    log.info('WebSocket client connected');
    ws.on('close', () => wsClients.delete(ws));
});

function broadcast(event: string, data: any) {
    const msg = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
    for (const client of wsClients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    }
}

// ─── Event bus → WebSocket bridge ───────────────────────────────────────────

onRunEvent((event) => {
    broadcast(event.type, { ...event.payload, ts: event.ts });
});

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get('/api/agents', (_req, res) => {
    res.json(AGENT_REGISTRY);
});

app.get('/api/events', (_req, res) => {
    const limit = parseInt(String(_req.query.limit ?? '100'), 10);
    res.json(getRecentEvents(limit));
});

app.get('/api/runs', async (_req, res) => {
    const runs: any[] = [];
    for (const [threadId, session] of sessions.entries()) {
        try {
            const state = await session.getState();
            runs.push({
                threadId,
                systemName: state.input?.systemName,
                phase: state.phase,
                mode: state.input?.mode,
                runType: state.input?.runType,
                cancelled: state.cancelled,
            });
        } catch { /* session may be stale */ }
    }
    res.json(runs);
});

app.post('/api/run', async (req, res) => {
    try {
        const { systemName, requirementsText, requirementsDocPath, mode, runType, existingProjectPath, repoTarget } = req.body;

        if (!systemName) {
            res.status(400).json({ error: 'systemName is required' });
            return;
        }

        let text = requirementsText;
        if (requirementsDocPath && !text) {
            text = await parseRequirementsFile(requirementsDocPath);
        }

        if (!text) {
            res.status(400).json({ error: 'requirementsText or requirementsDocPath is required' });
            return;
        }

        // Validate maintain mode
        const resolvedRunType = runType === 'maintain' ? 'maintain' : 'greenfield';
        if (resolvedRunType === 'maintain') {
            if (!existingProjectPath) {
                res.status(400).json({ error: 'existingProjectPath is required for maintain mode' });
                return;
            }
            if (!fs.existsSync(existingProjectPath)) {
                res.status(400).json({ error: `existingProjectPath not found: ${existingProjectPath}` });
                return;
            }
        }

        const runMode = mode === 'autonomous' ? 'autonomous' : 'human';

        if (runMode === 'autonomous') {
            // Sub-Plan 25-14: generate a threadId and use it as the key (fixes key-space collision)
            const autoThreadId = `run-${systemName}-${Date.now()}`;
            broadcast('run:started', { systemName, threadId: autoThreadId, mode: 'autonomous' });

            // Fire and forget — results come via WebSocket
            runAutonomous({ systemName, requirementsText: text, mode: 'autonomous', runType: resolvedRunType, existingProjectPath, repoTarget })
                .then((state) => {
                    states.set(autoThreadId, state);
                    _systemNameIndex.set(systemName, autoThreadId);
                    _evictIfNeeded();
                    const acceptance = state.acceptance;
                    const status = state.cancelled ? 'cancelled'
                        : acceptance?.status === 'accepted' ? 'completed'
                        : acceptance?.status === 'partial' ? 'partial'
                        : acceptance?.status === 'inconclusive' ? 'inconclusive'
                        : 'failed';
                    broadcast('run:complete', { systemName, threadId: autoThreadId, state, status, blockers: acceptance?.blockers ?? [] });
                })
                .catch((err) => {
                    // run.ts already flushes the token report on failure,
                    // but broadcast the output path so the client can find it
                    log.error(`Autonomous run error: ${err?.message ?? err}`);
                    const reportPath = tokenTracker.getOutputPath();
                    broadcast('run:error', {
                        systemName,
                        threadId: autoThreadId,
                        error: err.message,
                        tokenReportPath: reportPath ? `${reportPath}/token-usage-report.html` : null,
                    });
                });

            res.json({ status: 'started', threadId: autoThreadId, systemName, mode: 'autonomous' });
        } else {
            const session = await runHumanInTheLoop({
                systemName,
                requirementsText: text,
                mode: 'human',
                runType: resolvedRunType,
                existingProjectPath,
                repoTarget,
            });

            sessions.set(session.threadId, session);
            const state = await session.getState();
            states.set(session.threadId, state);
            _evictIfNeeded();
            broadcast('run:started', { systemName, threadId: session.threadId, mode: 'human' });
            // With interruptAfter, the first HITL phase has already completed.
            // Notify the dashboard that the phase output is ready for review.
            broadcast('hitl:waiting', {
                threadId: session.threadId,
                phase: state.phase,
                systemName,
                latestArtifact: state.artifacts?.[state.artifacts.length - 1] ?? null,
            });

            res.json({
                status: 'started',
                threadId: session.threadId,
                systemName,
                mode: 'human',
                phase: state.phase,
            });
        }
    } catch (err: any) {
        log.error(`POST /api/run failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/run/:id', async (req, res) => {
    // Sub-Plan 25-14: resolve systemName alias to threadId for backward compat
    const resolvedId = _systemNameIndex.get(req.params.id) ?? req.params.id;
    const session = sessions.get(resolvedId);
    if (session) {
        const state = await session.getState();
        states.set(resolvedId, state);
        res.json(redactState(state));
        return;
    }
    const cached = states.get(resolvedId);
    if (cached) {
        res.json(redactState(cached));
        return;
    }
    res.status(404).json({ error: 'Run not found' });
});

app.post('/api/run/:id/approve', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) {
        res.status(404).json({ error: 'Run session not found' });
        return;
    }
    try {
        // Accept both new { decision, feedback } and legacy { approved, feedback } payloads
        const { decision, approved, feedback } = req.body;
        let hitlDecision: 'approve' | 'deny' | 'enhance';
        if (decision === 'deny' || decision === 'enhance' || decision === 'approve') {
            hitlDecision = decision;
        } else {
            // Legacy: approved boolean (default true)
            hitlDecision = approved === false ? 'deny' : 'approve';
        }
        await session.resume(hitlDecision, feedback);
        const state = await session.getState();
        states.set(req.params.id, state);
        broadcast('run:phase-complete', { threadId: req.params.id, phase: state.phase, decision: hitlDecision });
        // With interruptAfter, the next phase has already completed.
        // Notify the dashboard that the newly completed phase output is ready for review.
        if (state.phase !== 'finalize') {
            broadcast('hitl:waiting', {
                threadId: req.params.id,
                phase: state.phase,
                latestArtifact: state.artifacts?.[state.artifacts.length - 1] ?? null,
            });
        }
        res.json({ phase: state.phase, decision: hitlDecision, state: redactState(state), waiting: state.phase !== 'finalize' });
    } catch (err: any) {
        log.error(`POST /api/run/:id/approve failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// ─── Artifact endpoints ──────────────────────────────────────────────────────

app.get('/api/run/:id/artifact/:agentId', async (req, res) => {
    const session = sessions.get(req.params.id);
    const state = session ? await session.getState() : states.get(req.params.id);
    if (!state) { res.status(404).json({ error: 'Run not found' }); return; }

    const artifact = (state.artifacts ?? []).find(
        (a: any) => a.agentId === req.params.agentId
    );
    if (!artifact) { res.status(404).json({ error: 'Artifact not found' }); return; }

    // Validate that artifact.filePath stays within the workspace (path traversal guard).
    const filePath = path.resolve(state.workspacePath, artifact.filePath);
    const wsRoot = path.resolve(state.workspacePath);
    const rel = path.relative(wsRoot, filePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        res.status(400).json({ error: 'Artifact path escapes workspace' });
        return;
    }
    if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: 'Artifact file not found on disk' });
        return;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ agentId: artifact.agentId, title: artifact.title, filePath: artifact.filePath, content });
});

app.get('/api/run/:id/artifacts', async (req, res) => {
    const session = sessions.get(req.params.id);
    const state = session ? await session.getState() : states.get(req.params.id);
    if (!state) { res.status(404).json({ error: 'Run not found' }); return; }

    const artifacts = (state.artifacts ?? []).map((a: any) => {
        const filePath = path.join(state.workspacePath, a.filePath);
        let content = '';
        try { content = fs.readFileSync(filePath, 'utf-8'); } catch {}
        return { ...a, content };
    });
    res.json(artifacts);
});

// ─── PR endpoints ────────────────────────────────────────────────────────────

app.get('/api/run/:id/prs', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (session) {
        const state = await session.getState();
        res.json(state.pullRequests ?? []);
        return;
    }
    const cached = states.get(req.params.id);
    if (cached) {
        res.json(cached.pullRequests ?? []);
        return;
    }
    res.status(404).json({ error: 'Run not found' });
});

// ─── Continue Run endpoints (Plan 23, Sub-Plan 07) ──────────────────────────

/**
 * GET /api/runs/stoppable
 *
 * List all runs in the outputs directory that can be continued (status != 'completed').
 * Returns an array sorted by timestamp descending (newest first).
 */
app.get('/api/runs/stoppable', (_req, res) => {
    try {
        const runs = listStoppedRuns();
        res.json(runs);
    } catch (err: any) {
        log.error(`GET /api/runs/stoppable failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/run/continue
 *
 * Continue a previously stopped run from the last completed phase.
 *
 * Body: {
 *   outputPath: string,                       // Path to the stopped run's output directory
 *   mode?: 'autonomous' | 'human',            // Override run mode (default: 'autonomous')
 *   threadId?: string,                        // Optional thread ID
 * }
 *
 * In autonomous mode: fires and sends results via WebSocket.
 * In HITL mode: returns a session that can be driven via /api/run/:id/approve.
 */
app.post('/api/run/continue', async (req, res) => {
    try {
        const { outputPath, mode, threadId } = req.body;

        if (!outputPath) {
            res.status(400).json({ error: 'outputPath is required' });
            return;
        }

        if (!fs.existsSync(outputPath)) {
            res.status(400).json({ error: `outputPath not found: ${outputPath}` });
            return;
        }

        // Collect and reconstruct to provide the response summary
        let collected;
        try {
            collected = collectRunState(outputPath);
        } catch (err: any) {
            res.status(400).json({ error: `Failed to collect run state: ${err.message}` });
            return;
        }

        if (!collected.workspaceExists) {
            res.status(400).json({
                error: `Workspace not found: "${collected.workspacePath || '(unknown)'}". ` +
                    `The generated project must exist on disk to continue.`,
            });
            return;
        }

        let reconstructed;
        try {
            reconstructed = reconstructState(collected);
        } catch (err: any) {
            res.status(400).json({ error: `Failed to reconstruct state: ${err.message}` });
            return;
        }

        const { resumePhase, confidence, warnings } = reconstructed;
        const systemName = reconstructed.state.input?.systemName ?? 'unknown';
        const resolvedMode = mode === 'human' ? 'human' : 'autonomous';
        const resolvedThreadId = threadId ?? `continue-${Date.now()}`;

        if (resolvedMode === 'autonomous') {
            broadcast('run:started', { systemName, mode: 'autonomous', continuing: true, resumePhase });

            // Fire and forget — results come via WebSocket
            continueRun({ outputPath, mode: 'autonomous', threadId: resolvedThreadId })
                .then((state) => {
                    const finalState = state as any;
                    states.set(resolvedThreadId, finalState);
                    _systemNameIndex.set(systemName, resolvedThreadId);
                    _evictIfNeeded();
                    const acceptance = finalState.acceptance;
                    const status = finalState.cancelled ? 'cancelled'
                        : acceptance?.status === 'accepted' ? 'completed'
                        : acceptance?.status === 'partial' ? 'partial'
                        : acceptance?.status === 'inconclusive' ? 'inconclusive'
                        : 'failed';
                    broadcast('run:complete', { systemName, state: finalState, status, blockers: acceptance?.blockers ?? [] });
                })
                .catch((err) => {
                    log.error(`Continued autonomous run error: ${err?.message ?? err}`);
                    const reportPath = tokenTracker.getOutputPath();
                    broadcast('run:error', {
                        systemName,
                        error: err.message,
                        tokenReportPath: reportPath ? `${reportPath}/token-usage-report.html` : null,
                    });
                });

            res.json({
                status: 'continuing',
                threadId: resolvedThreadId,
                systemName,
                resumePhase,
                confidence,
                warnings,
                mode: 'autonomous',
            });
        } else {
            // HITL mode
            const result = await continueRun({ outputPath, mode: 'human', threadId: resolvedThreadId });
            const session = result as RunSession;

            sessions.set(session.threadId, session);
            const state = await session.getState();
            states.set(session.threadId, state);
            _evictIfNeeded();
            broadcast('run:started', { systemName, threadId: session.threadId, mode: 'human', continuing: true, resumePhase });
            broadcast('hitl:waiting', {
                threadId: session.threadId,
                phase: state.phase,
                systemName,
                latestArtifact: state.artifacts?.[state.artifacts.length - 1] ?? null,
            });

            res.json({
                status: 'continuing',
                threadId: session.threadId,
                systemName,
                resumePhase,
                confidence,
                warnings,
                mode: 'human',
                phase: state.phase,
            });
        }
    } catch (err: any) {
        log.error(`POST /api/run/continue failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// ─── Serve Angular dashboard (static build) ─────────────────────────────────

const dashboardPath = path.join(__dirname, '..', 'dashboard', 'dist', 'dashboard', 'browser');
if (fs.existsSync(dashboardPath)) {
    app.use(express.static(dashboardPath));
    app.get('*path', (_req, res) => {
        res.sendFile(path.join(dashboardPath, 'index.html'));
    });
    log.info(`Serving Angular dashboard from ${dashboardPath}`);
}

// ─── Signal handlers — flush token report on unexpected exit ─────────────────
installProcessHandlers((msg) => log.error(msg));

// ─── Exports for testability (Sub-Plan 25-09) ───────────────────────────────
// Importing index.ts no longer starts the server — call createApp() / createHttpServer()
// and listen() explicitly in tests or alternative entry points.
export { app, httpServer, wss, broadcast, sessions, states };

/**
 * Convenience factory — returns the fully-configured Express app.
 * Useful for supertest or custom server setups.
 */
export function createApp() { return app; }

/**
 * Convenience factory — returns the HTTP server (Express + WebSocket).
 */
export function createHttpServer() { return httpServer; }

// ─── Start (guarded so index.ts is importable without side effects) ──────────

if (require.main === module) {
    // Bind to loopback by default — only expose to the network if explicitly requested.
    const BIND_HOST = process.env.BIND_HOST ?? '127.0.0.1';
    httpServer.listen(DASHBOARD_PORT, BIND_HOST, () => {
        log.info(`Server listening on http://${BIND_HOST}:${DASHBOARD_PORT}`);
        log.info(`WebSocket on ws://${BIND_HOST}:${DASHBOARD_PORT}/ws`);
        log.info(`Agents registered: ${AGENT_REGISTRY.length}`);
    });
}
