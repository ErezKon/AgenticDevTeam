import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiService, AgentEntry, WsMessage } from '../../services/api.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
})
export class DashboardComponent implements OnInit, OnDestroy {
  agents: AgentEntry[] = [];
  events: WsMessage[] = [];
  currentPhase = '';
  budgetLevel = 'ok';
  budgetUtilisation = 0;
  totalTokens = 0;
  totalCalls = 0;
  private sub?: Subscription;

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.api.getAgents().subscribe(agents => this.agents = agents);
    this.sub = this.api.connectWebSocket().subscribe(msg => {
      this.events.unshift(msg);
      if (this.events.length > 200) this.events.length = 200;

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

  eventBadgeClass(eventType: string): string {
    if (eventType.startsWith('phase:')) return 'badge-purple';
    if (eventType.startsWith('agent:')) return 'badge-blue';
    if (eventType.startsWith('pr:')) return 'badge-green';
    if (eventType.startsWith('gate:')) return 'badge-yellow';
    if (eventType.startsWith('budget:')) return 'badge-red';
    if (eventType.startsWith('tokens:')) return 'badge-cyan';
    return 'badge-blue';
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
