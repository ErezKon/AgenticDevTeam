import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subject, BehaviorSubject } from 'rxjs';

export interface AgentEntry {
  id: string;
  name: string;
  tag: string;
  colorCode: number;
  category: string;
}

export interface RepoTarget {
  type: 'same-repo' | 'new-repo' | 'existing-repo';
  repoName?: string;
  isPrivate?: boolean;
}

export interface RunRequest {
  systemName: string;
  requirementsText: string;
  mode: 'autonomous' | 'human';
  runType?: 'greenfield' | 'maintain';
  existingProjectPath?: string;
  repoTarget?: RepoTarget;
}

export interface RunResponse {
  status: string;
  threadId?: string;
  systemName: string;
  mode: string;
  phase?: string;
}

export interface WsMessage {
  event: string;
  data: any;
  timestamp: string;
}

export interface RunEvent {
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private ws: WebSocket | null = null;
  private wsMessages$ = new Subject<WsMessage>();
  private wsConnected$ = new BehaviorSubject<boolean>(false);
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Observable that emits `true` when the WebSocket is connected, `false` when disconnected. */
  get connected$(): Observable<boolean> { return this.wsConnected$.asObservable(); }

  constructor(private http: HttpClient) {}

  getAgents(): Observable<AgentEntry[]> {
    return this.http.get<AgentEntry[]>('/api/agents');
  }

  startRun(req: RunRequest): Observable<RunResponse> {
    return this.http.post<RunResponse>('/api/run', req);
  }

  getRunState(id: string): Observable<any> {
    return this.http.get(`/api/run/${id}`);
  }

  getRecentEvents(limit = 100): Observable<RunEvent[]> {
    return this.http.get<RunEvent[]>(`/api/events?limit=${limit}`);
  }

  approvePhase(id: string, decision: 'approve' | 'deny' | 'enhance', feedback?: string): Observable<any> {
    return this.http.post(`/api/run/${id}/approve`, { decision, feedback });
  }

  getActiveRuns(): Observable<any[]> {
    return this.http.get<any[]>('/api/runs');
  }

  getArtifacts(runId: string): Observable<any[]> {
    return this.http.get<any[]>(`/api/run/${runId}/artifacts`);
  }

  connectWebSocket(): Observable<WsMessage> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.wsMessages$.asObservable();

    // Clear any pending reconnect timer
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);
    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.wsConnected$.next(true);
    };
    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage;
        this.wsMessages$.next(msg);
      } catch {}
    };
    this.ws.onclose = () => {
      this.ws = null;
      this.wsConnected$.next(false);
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30_000);
      this.reconnectAttempt++;
      this.reconnectTimer = setTimeout(() => this.connectWebSocket(), delay);
    };
    this.ws.onerror = () => {
      // onclose will fire after onerror, which handles reconnection
    };

    return this.wsMessages$.asObservable();
  }
}
