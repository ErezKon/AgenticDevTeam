import { Component, OnInit, OnDestroy, ElementRef, ViewChild, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiService, WsMessage } from '../../services/api.service';
import { MarkdownViewerComponent } from '../../components/markdown-viewer/markdown-viewer.component';
import { EventLogComponent } from '../../components/event-log/event-log.component';
import { FileChangesTableComponent } from '../../components/file-changes-table/file-changes-table.component';
import { PrBadgeComponent } from '../../components/pr-badge/pr-badge.component';
import { TokenChartsComponent, type TokenChartData } from '../../components/token-charts/token-charts.component';

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
  imports: [CommonModule, FormsModule, RouterLink, MarkdownViewerComponent, EventLogComponent, FileChangesTableComponent, PrBadgeComponent, TokenChartsComponent],
  templateUrl: './run-session.component.html',
  styleUrls: ['./run-session.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
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
  totalInputTokens = 0;
  totalOutputTokens = 0;
  totalCacheReadTokens = 0;
  totalCacheCreationTokens = 0;
  cacheHitRate = 0;
  estimatedCost = 0;
  budgetLevel = 'ok';
  budgetUtilisation = 0;

  // Chart data (Plan 28: token usage charts)
  tokenChartData: TokenChartData | null = null;

  // Precomputed fields (Plan 25-11: avoid getter recalculation on every CD cycle)
  visiblePhases: PhaseStep[] = [];
  transcriptMessages: any[] = [];
  recentEvents: WsMessage[] = [];
  prettyState = '';

  private sub?: Subscription;

  constructor(private api: ApiService, private route: ActivatedRoute, private cdr: ChangeDetectorRef) {}

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
      this.recomputeRecentEvents();

      if (msg.event === 'hitl:waiting' || msg.event === 'run:phase-complete') {
        this.refreshState();
      }
      if (msg.event === 'phase:start' && data.phase) {
        this.phase = data.phase;
        this.recomputeVisiblePhases();
      }
      if (msg.event === 'tokens:update') {
        this.totalTokens = data.totalTokens ?? this.totalTokens;
        this.totalCalls = data.totalCalls ?? this.totalCalls;
        this.totalInputTokens = data.totalInputTokens ?? this.totalInputTokens;
        this.totalOutputTokens = data.totalOutputTokens ?? this.totalOutputTokens;
        this.totalCacheReadTokens = data.totalCacheReadTokens ?? this.totalCacheReadTokens;
        this.totalCacheCreationTokens = data.totalCacheCreationTokens ?? this.totalCacheCreationTokens;
        this.cacheHitRate = data.cacheHitRate ?? this.cacheHitRate;
        this.recomputeChartData();
      }
      if (msg.event === 'budget:level') {
        this.budgetLevel = data.level ?? 'ok';
        this.budgetUtilisation = data.utilisation ?? 0;
      }

      this.cdr.markForCheck();
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
          this.totalInputTokens = res.tokenUsage.reduce(
            (sum: number, r: any) => sum + (r.inputTokens ?? 0), 0
          );
          this.totalOutputTokens = res.tokenUsage.reduce(
            (sum: number, r: any) => sum + (r.outputTokens ?? 0), 0
          );
          this.totalCacheReadTokens = res.tokenUsage.reduce(
            (sum: number, r: any) => sum + (r.cacheReadTokens ?? 0), 0
          );
          this.totalCacheCreationTokens = res.tokenUsage.reduce(
            (sum: number, r: any) => sum + (r.cacheCreationTokens ?? 0), 0
          );
          this.cacheHitRate = this.totalInputTokens > 0
            ? this.totalCacheReadTokens / this.totalInputTokens
            : 0;
          this.recomputeChartData();
        }

        // Recompute precomputed fields (Plan 25-11)
        this.recomputeVisiblePhases();
        this.recomputeTranscript();
        this.prettyState = this.formatJson(res);

        // Auto-select the best tab for the current phase
        this.autoSelectTab();

        // Load artifacts with content
        this.loadArtifacts();
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.error = err?.error?.error ?? err.message ?? 'Failed to load run state';
        this.cdr.markForCheck();
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
        this.cdr.markForCheck();
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

  /** Recompute chart data when token stats change (Plan 28). */
  private recomputeChartData(): void {
    if (this.totalInputTokens > 0 || this.totalOutputTokens > 0) {
      this.tokenChartData = {
        totalInputTokens: this.totalInputTokens,
        totalOutputTokens: this.totalOutputTokens,
        totalCacheReadTokens: this.totalCacheReadTokens,
        totalCacheCreationTokens: this.totalCacheCreationTokens,
        cacheHitRate: this.cacheHitRate,
      };
    }
  }

  /** Recompute visible phases when state or phase changes (Plan 25-11). */
  private recomputeVisiblePhases(): void {
    const isGreenfield = this.state?.input?.runType === 'greenfield';
    this.visiblePhases = PIPELINE_PHASES.filter(p => !(p.maintainOnly && isGreenfield));
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

  /** Recompute transcript messages when state changes (Plan 25-11). */
  private recomputeTranscript(): void {
    this.transcriptMessages = (this.state?.transcript ?? []).slice(-20);
  }

  /** Recompute recent events slice (Plan 25-11). */
  private recomputeRecentEvents(): void {
    this.recentEvents = this.events.slice().reverse().slice(0, 50);
  }

  private scrollTranscript() {
    setTimeout(() => {
      const el = this.transcriptContainer?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    }, 50);
  }

  // ── Formatting helpers ─────────────────────────────────────────────────

  /** Format JSON once and cache in prettyState (Plan 25-11). */
  private formatJson(obj: any): string {
    try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
  }

  /** Kept for one-off template usage where precompute isn't practical. */
  prettyJson(obj: any): string {
    try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
  }

  // ── trackBy functions (Plan 25-11) ─────────────────────────────────────
  trackByPhase(_i: number, step: PhaseStep): string { return step.id; }
  trackByTab(_i: number, tab: { id: string }): string { return tab.id; }
  trackByIndex(i: number): number { return i; }
  trackByFilePath(_i: number, item: any): string { return item.filePath ?? _i; }
  trackByEvent(_i: number, msg: WsMessage): string | number { return msg.timestamp ?? _i; }
  trackById(_i: number, item: any): string { return item.id ?? _i; }

  acceptanceStatusClass(): string {
    const status = this.state?.acceptance?.status;
    switch (status) {
      case 'accepted': return 'status-ok';
      case 'partial': return 'status-partial';
      case 'inconclusive': return 'status-inconclusive';
      case 'failed': return 'status-failed';
      default: return '';
    }
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
