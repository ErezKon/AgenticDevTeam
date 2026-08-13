import { Component, OnInit, OnDestroy, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiService, WsMessage } from '../../services/api.service';
import { MarkdownViewerComponent } from '../../components/markdown-viewer/markdown-viewer.component';

interface PhaseStep {
  id: string;
  label: string;
  maintainOnly?: boolean;
}

const PIPELINE_PHASES: PhaseStep[] = [
  { id: 'intake', label: 'Intake' },
  { id: 'codebase-analyzer', label: 'Analyzer', maintainOnly: true },
  { id: 'architect', label: 'Architect' },
  { id: 'product-manager', label: 'Product Mgr' },
  { id: 'dba', label: 'DBA' },
  { id: 'team-leader', label: 'Team Leader' },
  { id: 'development', label: 'Development' },
  { id: 'qa', label: 'QA' },
  { id: 'devops', label: 'DevOps' },
  { id: 'e2e', label: 'E2E' },
  { id: 'finalize', label: 'Finalize' },
];

@Component({
  selector: 'app-run-session',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, MarkdownViewerComponent],
  templateUrl: './run-session.component.html',
  styleUrls: ['./run-session.component.scss'],
})
export class RunSessionComponent implements OnInit, OnDestroy {
  @ViewChild('transcriptContainer') transcriptContainer?: ElementRef;

  threadId = '';
  phase = '';
  state: any = null;
  loading = false;
  events: WsMessage[] = [];
  feedbackText = '';
  error = '';
  completed = false;
  activeTab = 'raw';

  // Artifacts
  artifacts: { agentId: string; title: string; filePath: string; content: string }[] = [];
  currentArtifact: { agentId: string; title: string; filePath: string; content: string } | null = null;

  // Stats
  totalTokens = 0;
  totalCalls = 0;
  budgetLevel = 'ok';
  budgetUtilisation = 0;

  private sub?: Subscription;

  constructor(private api: ApiService, private route: ActivatedRoute) {}

  ngOnInit() {
    this.threadId = this.route.snapshot.paramMap.get('id') ?? '';
    if (!this.threadId) {
      this.error = 'No thread ID provided';
      return;
    }

    this.refreshState();

    this.sub = this.api.connectWebSocket().subscribe(msg => {
      const data = msg.data ?? {};

      // Filter events for this run
      if (data.threadId && data.threadId !== this.threadId) return;

      this.events.push(msg);
      if (this.events.length > 200) this.events.splice(0, this.events.length - 200);

      if (msg.event === 'hitl:waiting' || msg.event === 'run:phase-complete') {
        this.refreshState();
      }
      if (msg.event === 'phase:start' && data.phase) {
        this.phase = data.phase;
      }
      if (msg.event === 'tokens:update') {
        this.totalTokens = data.totalTokens ?? this.totalTokens;
        this.totalCalls = data.totalCalls ?? this.totalCalls;
      }
      if (msg.event === 'budget:level') {
        this.budgetLevel = data.level ?? 'ok';
        this.budgetUtilisation = data.utilisation ?? 0;
      }

      this.scrollTranscript();
    });
  }

  ngOnDestroy() { this.sub?.unsubscribe(); }

  refreshState() {
    this.api.getRunState(this.threadId).subscribe({
      next: (res) => {
        this.state = res;
        this.phase = res.phase ?? '';
        this.completed = res.phase === 'finalize';
        this.error = '';

        // Derive token stats from state
        if (res.tokenUsage?.length) {
          this.totalCalls = res.tokenUsage.length;
          this.totalTokens = res.tokenUsage.reduce(
            (sum: number, r: any) => sum + (r.totalTokens ?? 0), 0
          );
        }

        // Auto-select the best tab for the current phase
        this.autoSelectTab();

        // Load artifacts with content
        this.loadArtifacts();
      },
      error: (err) => {
        this.error = err?.error?.error ?? err.message ?? 'Failed to load run state';
      },
    });
  }

  private loadArtifacts() {
    this.api.getArtifacts(this.threadId).subscribe({
      next: (artifacts) => {
        this.artifacts = artifacts;
        // Auto-select the latest artifact (for the current/most recent phase)
        if (artifacts.length > 0) {
          this.currentArtifact = artifacts[artifacts.length - 1];
        }
      },
      error: () => { /* artifacts may not exist yet */ },
    });
  }

  selectArtifact(artifact: any) {
    this.currentArtifact = artifact;
  }

  compareArtifacts(a1: any, a2: any): boolean {
    return a1 && a2 && a1.agentId === a2.agentId && a1.filePath === a2.filePath;
  }

  // Check if current phase is a development phase (shows code changes / PRs)
  get isDevPhase(): boolean {
    return this.phase === 'development' || this.phase === 'qa' || this.phase === 'devops' || this.phase === 'e2e';
  }

  approve() {
    this.loading = true;
    this.error = '';
    this.api.approvePhase(this.threadId, 'approve').subscribe({
      next: () => { this.loading = false; this.refreshState(); },
      error: (err) => {
        this.loading = false;
        this.error = err?.error?.error ?? err.message ?? 'Approve failed';
      },
    });
  }

  deny() {
    this.loading = true;
    this.error = '';
    this.api.approvePhase(this.threadId, 'deny', this.feedbackText || 'Denied by user').subscribe({
      next: () => { this.loading = false; this.feedbackText = ''; this.refreshState(); },
      error: (err) => {
        this.loading = false;
        this.error = err?.error?.error ?? err.message ?? 'Deny failed';
      },
    });
  }

  enhance() {
    if (!this.feedbackText.trim()) {
      this.error = 'Feedback is required for enhance';
      return;
    }
    this.loading = true;
    this.error = '';
    this.api.approvePhase(this.threadId, 'enhance', this.feedbackText).subscribe({
      next: () => { this.loading = false; this.feedbackText = ''; this.refreshState(); },
      error: (err) => {
        this.loading = false;
        this.error = err?.error?.error ?? err.message ?? 'Enhance failed';
      },
    });
  }

  // ── Pipeline timeline helpers ──────────────────────────────────────────

  get visiblePhases(): PhaseStep[] {
    const isGreenfield = this.state?.input?.runType === 'greenfield';
    return PIPELINE_PHASES.filter(p => !(p.maintainOnly && isGreenfield));
  }

  phaseStatus(step: PhaseStep): 'completed' | 'current' | 'pending' {
    const phases = this.visiblePhases.map(p => p.id);
    const currentIdx = phases.indexOf(this.phase);
    const stepIdx = phases.indexOf(step.id);

    if (stepIdx < 0) return 'pending';
    if (this.completed && step.id === 'finalize') return 'completed';
    if (stepIdx < currentIdx) return 'completed';
    if (stepIdx === currentIdx) return 'current';
    return 'pending';
  }

  // ── Tab helpers ────────────────────────────────────────────────────────

  get availableTabs(): { id: string; label: string }[] {
    const tabs: { id: string; label: string }[] = [];
    if (!this.state) return [{ id: 'raw', label: 'Raw JSON' }];

    if (this.state.architecture) tabs.push({ id: 'architecture', label: 'Architecture' });
    if (this.state.techStack?.length) tabs.push({ id: 'techStack', label: 'Tech Stack' });
    if (this.state.epics?.length) tabs.push({ id: 'epics', label: 'Epics' });
    if (this.state.userStories?.length) tabs.push({ id: 'stories', label: 'User Stories' });
    if (this.state.tasks?.length) tabs.push({ id: 'tasks', label: 'Tasks' });
    if (this.state.assignments?.length) tabs.push({ id: 'assignments', label: 'Assignments' });
    if (this.state.dbDesign) tabs.push({ id: 'dbDesign', label: 'DB Design' });
    if (this.state.fileChanges?.length) tabs.push({ id: 'fileChanges', label: 'File Changes' });
    if (this.state.testReports?.length) tabs.push({ id: 'testReports', label: 'Test Reports' });
    if (this.state.bugs?.length) tabs.push({ id: 'bugs', label: 'Bugs' });
    if (this.state.pullRequests?.length) tabs.push({ id: 'pullRequests', label: 'PRs' });
    if (this.state.devopsPlan) tabs.push({ id: 'devops', label: 'DevOps' });
    tabs.push({ id: 'raw', label: 'Raw JSON' });
    return tabs;
  }

  private autoSelectTab() {
    const phaseTabMap: Record<string, string> = {
      'architect': 'architecture',
      'product-manager': 'stories',
      'dba': 'dbDesign',
      'team-leader': 'assignments',
      'development': 'fileChanges',
      'qa': 'testReports',
      'devops': 'devops',
      'e2e': 'testReports',
    };
    const preferred = phaseTabMap[this.phase];
    if (preferred && this.availableTabs.some(t => t.id === preferred)) {
      this.activeTab = preferred;
    } else if (!this.availableTabs.some(t => t.id === this.activeTab)) {
      this.activeTab = this.availableTabs[0]?.id ?? 'raw';
    }
  }

  // ── Transcript helpers ─────────────────────────────────────────────────

  get transcriptMessages(): any[] {
    return (this.state?.transcript ?? []).slice(-20);
  }

  private scrollTranscript() {
    setTimeout(() => {
      const el = this.transcriptContainer?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    }, 50);
  }

  // ── Formatting helpers ─────────────────────────────────────────────────

  prettyJson(obj: any): string {
    try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
  }

  budgetLevelClass(): string {
    switch (this.budgetLevel) {
      case 'warn': return 'status-warn';
      case 'degrade': return 'status-degrade';
      case 'stop': return 'status-stop';
      default: return 'status-ok';
    }
  }

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
