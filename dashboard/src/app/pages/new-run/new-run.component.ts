import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService, type RepoTarget } from '../../services/api.service';

@Component({
  selector: 'app-new-run',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './new-run.component.html',
  styleUrls: ['./new-run.component.scss'],
})
export class NewRunComponent {
  systemName = '';
  requirements = '';
  mode: 'autonomous' | 'human' = 'human';
  runType: 'greenfield' | 'maintain' = 'greenfield';
  existingProjectPath = '';
  repoTargetType: 'same-repo' | 'new-repo' | 'existing-repo' = 'same-repo';
  repoName = '';
  repoIsPrivate = true;
  loading = false;
  error = '';
  success = false;
  threadId = '';

  constructor(private api: ApiService, private router: Router) {}

  private buildRepoTarget(): RepoTarget | undefined {
    if (this.runType !== 'greenfield' || this.repoTargetType === 'same-repo') {
      return undefined;
    }
    return {
      type: this.repoTargetType,
      ...(this.repoName ? { repoName: this.repoName } : {}),
      ...(this.repoTargetType === 'new-repo' ? { isPrivate: this.repoIsPrivate } : {}),
    };
  }

  startRun() {
    this.loading = true;
    this.error = '';
    this.success = false;

    const repoTarget = this.buildRepoTarget();

    this.api.startRun({
      systemName: this.systemName,
      requirementsText: this.requirements,
      mode: this.mode,
      runType: this.runType,
      ...(this.runType === 'maintain' ? { existingProjectPath: this.existingProjectPath } : {}),
      ...(repoTarget ? { repoTarget } : {}),
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
