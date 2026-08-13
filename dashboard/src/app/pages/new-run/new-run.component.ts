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

  isDragOver = false;
  droppedFileName = '';

  private static readonly ALLOWED_EXTENSIONS = [
    '.txt', '.md', '.json', '.yaml', '.yml', '.xml', '.csv', '.html',
  ];

  constructor(private api: ApiService, private router: Router) {}

  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = true;
  }

  onDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

    if (!NewRunComponent.ALLOWED_EXTENSIONS.includes(ext)) {
      this.error = `Unsupported file type "${ext}". Allowed: ${NewRunComponent.ALLOWED_EXTENSIONS.join(', ')}`;
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      this.requirements = reader.result as string;
      this.droppedFileName = file.name;
      this.error = '';
    };
    reader.onerror = () => {
      this.error = 'Failed to read file.';
    };
    reader.readAsText(file);
  }

  clearFile() {
    this.droppedFileName = '';
    this.requirements = '';
  }

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
        // Navigate to run session page for HITL runs
        if (res.mode === 'human' && res.threadId) {
          this.router.navigate(['/run', res.threadId]);
        }
      },
      error: (err) => {
        this.loading = false;
        this.error = err?.error?.error ?? err.message ?? 'Unknown error';
      },
    });
  }
}
