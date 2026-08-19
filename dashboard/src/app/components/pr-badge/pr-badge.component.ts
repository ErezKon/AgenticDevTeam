import { Component, Input, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-pr-badge',
  standalone: true,
  imports: [CommonModule],
  template: `
    <span class="badge"
      [ngClass]="{
        'badge-green': status === 'merged',
        'badge-yellow': status === 'open',
        'badge-red': status === 'closed'
      }">{{ status }}</span>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PrBadgeComponent {
  @Input() status = 'open';
}
