import { Component, Input, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-file-changes-table',
  standalone: true,
  imports: [CommonModule],
  template: `
    <table class="data-table" *ngIf="changes?.length">
      <thead><tr><th>File Path</th><th>Action</th></tr></thead>
      <tbody>
        <tr *ngFor="let fc of changes; trackBy: trackByFilePath">
          <td><code>{{ fc.filePath }}</code></td>
          <td>
            <span class="badge"
              [ngClass]="{
                'badge-green': fc.action === 'add',
                'badge-blue': fc.action === 'modify',
                'badge-red': fc.action === 'delete'
              }">{{ fc.action }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  `,
  styles: [`
    .data-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    .data-table th, .data-table td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid var(--border); }
    .data-table th { color: var(--text-secondary); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; background: var(--bg-primary); }
    .data-table td code { font-size: 0.8rem; color: var(--accent-blue); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FileChangesTableComponent {
  @Input() changes: any[] = [];

  trackByFilePath(_i: number, item: any): string { return item.filePath ?? _i; }
}
