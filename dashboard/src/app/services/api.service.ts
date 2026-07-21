import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subject } from 'rxjs';

export interface AgentEntry {
  id: string;
  name: string;
  tag: string;
  colorCode: number;
  category: string;
}

export interface RunRequest {
  systemName: string;
  requirementsText: string;
  mode: 'autonomous' | 'human';
  runType?: 'greenfield' | 'maintain';
  existingProjectPath?: string;
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

@Injectable({ providedIn: 'root' })
export class ApiService {
  private ws: WebSocket | null = null;
  private wsMessages$ = new Subject<WsMessage>();

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

  approvePhase(id: string, approved: boolean, feedback?: string): Observable<any> {
    return this.http.post(`/api/run/${id}/approve`, { approved, feedback });
  }

  connectWebSocket(): Observable<WsMessage> {
    if (this.ws) return this.wsMessages$.asObservable();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);
    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage;
        this.wsMessages$.next(msg);
      } catch {}
    };
    this.ws.onclose = () => {
      this.ws = null;
      setTimeout(() => this.connectWebSocket(), 3000);
    };

    return this.wsMessages$.asObservable();
  }
}
