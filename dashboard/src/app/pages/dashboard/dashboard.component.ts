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
