import { Component, OnInit, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiService, AgentEntry, WsMessage } from '../../services/api.service';
import { EventLogComponent } from '../../components/event-log/event-log.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink, EventLogComponent],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardComponent implements OnInit, OnDestroy {
  agents: AgentEntry[] = [];
  events: WsMessage[] = [];
  activeRuns: any[] = [];
  currentPhase = '';
  budgetLevel = 'ok';
  budgetUtilisation = 0;
  totalTokens = 0;
  totalCalls = 0;
  private sub?: Subscription;

  constructor(private api: ApiService, private cdr: ChangeDetectorRef) {}

  ngOnInit() {
    this.api.getAgents().subscribe(agents => { this.agents = agents; this.cdr.markForCheck(); });
    this.api.getActiveRuns().subscribe(runs => { this.activeRuns = runs; this.cdr.markForCheck(); });

    // Backfill recent events so the dashboard isn't empty on page load / reconnect
    this.api.getRecentEvents(200).subscribe({
      next: (events) => {
        this.events = events.map(e => ({ event: e.type, data: e.payload, timestamp: e.ts } as WsMessage));
        this.cdr.markForCheck();
      },
      error: () => { /* events endpoint may not be available yet */ },
    });

    this.sub = this.api.connectWebSocket().subscribe(msg => {
      this.events = [msg, ...this.events].slice(0, 200);

      // Track derived state from event types
      if (msg.event === 'phase:start' && msg.data?.phase) {
        this.currentPhase = msg.data.phase;
      }
      if (msg.event === 'budget:level' && msg.data) {
        this.budgetLevel = msg.data.level ?? 'ok';
        this.budgetUtilisation = msg.data.utilisation ?? 0;
      }
      if (msg.event === 'tokens:update' && msg.data) {
        this.totalTokens = msg.data.totalTokens ?? this.totalTokens;
        this.totalCalls = msg.data.totalCalls ?? this.totalCalls;
      }
      // Refresh active runs on HITL events
      if (msg.event === 'hitl:waiting' || msg.event === 'run:started') {
        this.api.getActiveRuns().subscribe(runs => { this.activeRuns = runs; this.cdr.markForCheck(); });
      }
      this.cdr.markForCheck();
    });
  }

  ngOnDestroy() { this.sub?.unsubscribe(); }

  // ── trackBy functions (Plan 26-11) ─────────────────────────────────────
  trackByAgent(_i: number, agent: AgentEntry): string { return agent.tag; }
  trackByRun(_i: number, run: any): string { return run.threadId; }
  getColor(code: number): string {
    return `hsl(${(code * 17) % 360}, 70%, 60%)`;
  }

  categoryColor(category: string): string {
    switch (category) {
      case 'management': return 'purple';
      case 'development': return 'blue';
      case 'quality': return 'yellow';
      case 'operations': return 'green';
      default: return 'blue';
    }
  }

  budgetLevelClass(): string {
    switch (this.budgetLevel) {
      case 'warn': return 'status-warn';
      case 'degrade': return 'status-degrade';
      case 'stop': return 'status-stop';
      default: return 'status-ok';
    }
  }
}
