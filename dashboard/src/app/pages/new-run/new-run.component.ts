import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-new-run',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="new-run">
      <h1 style="margin-bottom: 1.5rem;">Start New Run</h1>

      <div class="card form-card">
        <div class="form-group">
          <label for="runType">Run Type</label>
          <select id="runType" [(ngModel)]="runType">
            <option value="greenfield">Greenfield (new project)</option>
            <option value="maintain">Maintain (existing project)</option>
          </select>
        </div>

        <div class="form-group" *ngIf="runType === 'maintain'">
          <label for="existingProjectPath">Existing Project Path</label>
          <input id="existingProjectPath" [(ngModel)]="existingProjectPath"
            placeholder="e.g. C:\\Code\\MyProject or /home/user/myproject" />
          <small class="hint">Absolute path to the existing project directory</small>
        </div>

        <div class="form-group">
          <label for="systemName">System Name</label>
          <input id="systemName" [(ngModel)]="systemName" placeholder="e.g. Task Management App" />
        </div>

        <div class="form-group">
          <label for="mode">Run Mode</label>
          <select id="mode" [(ngModel)]="mode">
            <option value="human">Human-in-the-Loop (recommended)</option>
            <option value="autonomous">Autonomous</option>
          </select>
        </div>

        <div class="form-group">
          <label for="requirements">{{ runType === 'maintain' ? 'Specs / Demands' : 'Requirements' }}</label>
          <textarea id="requirements" [(ngModel)]="requirements" rows="12"
            [placeholder]="runType === 'maintain'
              ? 'Describe the changes, fixes, or features you want...'
              : 'Paste your system requirements here...'"></textarea>
        </div>

        <div class="form-actions">
          <button class="btn-primary" (click)="startRun()"
            [disabled]="loading || !systemName || !requirements || (runType === 'maintain' && !existingProjectPath)">
            {{ loading ? 'Starting...' : (runType === 'maintain' ? 'Start Maintain Run' : 'Start Run') }}
          </button>
        </div>

        <div *ngIf="error" class="error-msg">{{ error }}</div>
        <div *ngIf="success" class="success-msg">
          Run started successfully!
          <span *ngIf="threadId">Thread ID: {{ threadId }}</span>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .form-card { max-width: 700px; }
    .form-group { margin-bottom: 1.25rem; }
    .form-group label { display: block; margin-bottom: 0.4rem; font-weight: 600; font-size: 0.9rem; color: var(--text-secondary); }
    .form-actions { margin-top: 1.5rem; }
    .error-msg { margin-top: 1rem; color: var(--accent-red); font-size: 0.9rem; }
    .success-msg { margin-top: 1rem; color: var(--accent-green); font-size: 0.9rem; }
    textarea { resize: vertical; min-height: 200px; }
    .hint { display: block; margin-top: 0.25rem; font-size: 0.8rem; color: var(--text-secondary); opacity: 0.7; }
  `],
})
export class NewRunComponent {
  systemName = '';
  requirements = '';
  mode: 'autonomous' | 'human' = 'human';
  runType: 'greenfield' | 'maintain' = 'greenfield';
  existingProjectPath = '';
  loading = false;
  error = '';
  success = false;
  threadId = '';

  constructor(private api: ApiService, private router: Router) {}

  startRun() {
    this.loading = true;
    this.error = '';
    this.success = false;

    this.api.startRun({
      systemName: this.systemName,
      requirementsText: this.requirements,
      mode: this.mode,
      runType: this.runType,
      ...(this.runType === 'maintain' ? { existingProjectPath: this.existingProjectPath } : {}),
    }).subscribe({
      next: (res) => {
        this.loading = false;
        this.success = true;
        this.threadId = res.threadId ?? '';
      },
      error: (err) => {
        this.loading = false;
        this.error = err?.error?.error ?? err.message ?? 'Unknown error';
      },
    });
  }
}
