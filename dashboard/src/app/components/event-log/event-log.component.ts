import { Component, Input, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WsMessage } from '../../services/api.service';

@Component({
  selector: 'app-event-log',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="event-log">
      <div *ngFor="let msg of events; trackBy: trackByEvent" class="event-entry">
        <span class="event-time">{{ msg.timestamp | date:'HH:mm:ss' }}</span>
        <span class="event-type badge" [ngClass]="eventBadgeClass(msg.event)">{{ msg.event }}</span>
        <span class="event-data">{{ msg.data | json }}</span>
      </div>
      <div *ngIf="events.length === 0" class="empty-state">
        {{ emptyMessage }}
      </div>
    </div>
  `,
  styles: [`
    .event-log { max-height: 400px; overflow-y: auto; }
    .event-entry {
      display: flex; gap: 0.75rem; align-items: center;
      padding: 0.4rem 0; border-bottom: 1px solid var(--border); font-size: 0.85rem;
    }
    .event-time { color: var(--text-secondary); font-family: monospace; min-width: 70px; }
    .event-data { color: var(--text-secondary); font-family: monospace; word-break: break-all; }
    .empty-state { color: var(--text-secondary); text-align: center; padding: 2rem; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EventLogComponent {
  @Input() events: WsMessage[] = [];
  @Input() emptyMessage = 'No events yet.';

  trackByEvent(_i: number, msg: WsMessage): number { return msg.timestamp as any ?? _i; }

  eventBadgeClass(eventType: string): string {
    if (eventType.startsWith('phase:')) return 'badge-purple';
    if (eventType.startsWith('agent:')) return 'badge-blue';
    if (eventType.startsWith('pr:')) return 'badge-green';
    if (eventType.startsWith('gate:')) return 'badge-yellow';
    if (eventType.startsWith('budget:')) return 'badge-red';
    if (eventType.startsWith('tokens:')) return 'badge-cyan';
    if (eventType.startsWith('hitl:')) return 'badge-purple';
    if (eventType.startsWith('run:')) return 'badge-green';
    return 'badge-blue';
  }
}
