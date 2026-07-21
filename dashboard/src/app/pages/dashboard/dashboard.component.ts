import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiService, AgentEntry, WsMessage } from '../../services/api.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="dashboard">
      <header class="dash-header">
        <h1>Dashboard</h1>
        <a routerLink="/new-run" class="btn-primary" style="padding: 0.6rem 1.5rem;">+ New Run</a>
      </header>

      <!-- Agent Roster -->
      <section class="card" style="margin-bottom: 1.5rem;">
        <h2 style="margin-bottom: 1rem;">Agent Roster ({{ agents.length }})</h2>
        <div class="agent-grid">
          <div *ngFor="let agent of agents" class="agent-card">
            <span class="agent-tag" [style.color]="getColor(agent.colorCode)">{{ agent.tag }}</span>
            <span class="agent-name">{{ agent.name }}</span>
            <span class="badge" [ngClass]="'badge-' + categoryColor(agent.category)">{{ agent.category }}</span>
          </div>
        </div>
      </section>

      <!-- Live Events -->
      <section class="card">
        <h2 style="margin-bottom: 1rem;">Live Events</h2>
        <div class="event-log">
          <div *ngFor="let msg of events" class="event-entry">
            <span class="event-time">{{ msg.timestamp | date:'HH:mm:ss' }}</span>
            <span class="event-type badge badge-blue">{{ msg.event }}</span>
            <span class="event-data">{{ msg.data | json }}</span>
          </div>
          <div *ngIf="events.length === 0" class="empty-state">
            No events yet. Start a new run to see live updates.
          </div>
        </div>
      </section>
    </div>
  `,
  styles: [`
    .dash-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
    .agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0.75rem; }
    .agent-card {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0.5rem 0.75rem; border-radius: 6px;
      background: var(--bg-primary); font-size: 0.85rem;
    }
    .agent-tag { font-weight: 700; font-family: monospace; }
    .agent-name { flex: 1; }
    .event-log { max-height: 400px; overflow-y: auto; }
    .event-entry { display: flex; gap: 0.75rem; align-items: center; padding: 0.4rem 0; border-bottom: 1px solid var(--border); font-size: 0.85rem; }
    .event-time { color: var(--text-secondary); font-family: monospace; min-width: 70px; }
    .event-data { color: var(--text-secondary); font-family: monospace; word-break: break-all; }
    .empty-state { color: var(--text-secondary); text-align: center; padding: 2rem; }
  `],
})
export class DashboardComponent implements OnInit, OnDestroy {
  agents: AgentEntry[] = [];
  events: WsMessage[] = [];
  private sub?: Subscription;

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.api.getAgents().subscribe(agents => this.agents = agents);
    this.sub = this.api.connectWebSocket().subscribe(msg => {
      this.events.unshift(msg);
      if (this.events.length > 100) this.events.pop();
    });
  }

  ngOnDestroy() { this.sub?.unsubscribe(); }

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
}
