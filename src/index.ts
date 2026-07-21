/**
 * REST + WebSocket server — dashboard backend.
 *
 * Endpoints:
 * - POST /api/run          Start a new run
 * - GET  /api/run/:id       Get run state
 * - POST /api/run/:id/approve  Approve a HITL phase
 * - GET  /api/agents        List all agents
 *
 * WebSocket:
 * - ws://host:port/ws       Real-time transcript + state updates
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { DASHBOARD_PORT } from './config';
import { AGENT_REGISTRY } from './agents/registry';
import { runAutonomous, runHumanInTheLoop, type RunSession } from './conductor/run';
import { parseRequirementsFile } from './tools/requirements/parse-requirements';
import { getLogger } from './utils/logger';
import { LogColors, color256 } from './utils/log-colors.util';
import * as path from 'path';
import * as fs from 'fs';

const TAG = `${color256(33)}[Server]${LogColors.RESET}`;
const log = getLogger('[Server]', 33);

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── In-memory session store ────────────────────────────────────────────────

const sessions = new Map<string, RunSession>();
const states = new Map<string, any>();

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

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get('/api/agents', (_req, res) => {
    res.json(AGENT_REGISTRY);
});

app.post('/api/run', async (req, res) => {
    try {
        const { systemName, requirementsText, requirementsDocPath, mode, runType, existingProjectPath } = req.body;

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
            broadcast('run:started', { systemName, mode: 'autonomous' });

            // Fire and forget — results come via WebSocket
            runAutonomous({ systemName, requirementsText: text, mode: 'autonomous', runType: resolvedRunType, existingProjectPath })
                .then((state) => {
                    states.set(systemName, state);
                    broadcast('run:complete', { systemName, state });
                })
                .catch((err) => {
                    broadcast('run:error', { systemName, error: err.message });
                });

            res.json({ status: 'started', systemName, mode: 'autonomous' });
        } else {
            const session = await runHumanInTheLoop({
                systemName,
                requirementsText: text,
                mode: 'human',
                runType: resolvedRunType,
                existingProjectPath,
            });

            sessions.set(session.threadId, session);
            const state = await session.getState();
            states.set(session.threadId, state);
            broadcast('run:started', { systemName, threadId: session.threadId, mode: 'human' });

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
    const session = sessions.get(req.params.id);
    if (session) {
        const state = await session.getState();
        states.set(req.params.id, state);
        res.json(state);
        return;
    }
    const cached = states.get(req.params.id);
    if (cached) {
        res.json(cached);
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
        const { approved, feedback } = req.body;
        const result = await session.resume(approved !== false, feedback);
        const state = await session.getState();
        states.set(req.params.id, state);
        broadcast('run:phase-complete', { threadId: req.params.id, phase: state.phase });
        res.json({ phase: state.phase, state });
    } catch (err: any) {
        log.error(`POST /api/run/:id/approve failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// ─── Serve Angular dashboard (static build) ─────────────────────────────────

const dashboardPath = path.join(__dirname, '..', 'dashboard', 'dist', 'dashboard', 'browser');
if (fs.existsSync(dashboardPath)) {
    app.use(express.static(dashboardPath));
    app.get('*', (_req, res) => {
        res.sendFile(path.join(dashboardPath, 'index.html'));
    });
    log.info(`Serving Angular dashboard from ${dashboardPath}`);
}

// ─── Start ──────────────────────────────────────────────────────────────────

httpServer.listen(DASHBOARD_PORT, () => {
    log.info(`Server listening on http://localhost:${DASHBOARD_PORT}`);
    log.info(`WebSocket on ws://localhost:${DASHBOARD_PORT}/ws`);
    log.info(`Agents registered: ${AGENT_REGISTRY.length}`);
});
