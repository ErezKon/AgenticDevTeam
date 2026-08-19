import {
  Component,
  Input,
  OnChanges,
  OnDestroy,
  AfterViewInit,
  ElementRef,
  ViewChild,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);

export interface TokenChartData {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  cacheHitRate: number;
}

@Component({
  selector: 'app-token-charts',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="token-charts-grid">
      <div class="chart-box">
        <h3>Token Distribution</h3>
        <canvas #doughnutCanvas></canvas>
      </div>
      <div class="chart-box">
        <h3>Cache Efficiency</h3>
        <canvas #barCanvas></canvas>
      </div>
    </div>
  `,
  styles: [`
    .token-charts-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }
    .chart-box {
      background: var(--bg-primary, #0f172a);
      border: 1px solid var(--border, #334155);
      border-radius: 8px;
      padding: 1rem;
    }
    .chart-box h3 {
      font-size: 0.8rem;
      color: var(--text-secondary, #94a3b8);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin: 0 0 0.75rem 0;
    }
    canvas {
      max-height: 220px;
    }
    @media (max-width: 700px) {
      .token-charts-grid {
        grid-template-columns: 1fr;
      }
    }
  `],
})
export class TokenChartsComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() data: TokenChartData | null = null;

  @ViewChild('doughnutCanvas') doughnutRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('barCanvas') barRef!: ElementRef<HTMLCanvasElement>;

  private doughnutChart: Chart<any> | null = null;
  private barChart: Chart<any> | null = null;
  private viewReady = false;

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.rebuildCharts();
  }

  ngOnChanges(_changes: SimpleChanges): void {
    if (this.viewReady) this.rebuildCharts();
  }

  ngOnDestroy(): void {
    this.doughnutChart?.destroy();
    this.barChart?.destroy();
  }

  private rebuildCharts(): void {
    if (!this.data) return;
    const d = this.data;
    const uncachedInput = Math.max(0, d.totalInputTokens - d.totalCacheReadTokens - d.totalCacheCreationTokens);

    // ── Doughnut: token distribution ─────────────────────────────────
    const doughnutData = {
      labels: ['Uncached Input', 'Cache Read', 'Cache Write', 'Output'],
      datasets: [{
        data: [uncachedInput, d.totalCacheReadTokens, d.totalCacheCreationTokens, d.totalOutputTokens],
        backgroundColor: ['#3b82f6', '#00bcd4', '#ff9800', '#ef4444'],
        borderWidth: 0,
      }],
    };

    if (this.doughnutChart) {
      this.doughnutChart.data = doughnutData;
      this.doughnutChart.update();
    } else {
      this.doughnutChart = new Chart(this.doughnutRef.nativeElement, {
        type: 'doughnut',
        data: doughnutData,
        options: {
          responsive: true,
          plugins: {
            legend: {
              position: 'right',
              labels: { boxWidth: 12, padding: 8, color: '#94a3b8', font: { size: 11 } },
            },
          },
        },
      });
    }

    // ── Bar: cache efficiency ────────────────────────────────────────
    const barData = {
      labels: ['Input Tokens'],
      datasets: [
        { label: 'Cache Read', data: [d.totalCacheReadTokens], backgroundColor: '#00bcd4' },
        { label: 'Cache Write', data: [d.totalCacheCreationTokens], backgroundColor: '#ff9800' },
        { label: 'Uncached', data: [uncachedInput], backgroundColor: '#3b82f6' },
      ],
    };

    if (this.barChart) {
      this.barChart.data = barData;
      this.barChart.update();
    } else {
      this.barChart = new Chart(this.barRef.nativeElement, {
        type: 'bar',
        data: barData,
        options: {
          responsive: true,
          indexAxis: 'y',
          scales: {
            x: {
              stacked: true,
              beginAtZero: true,
              ticks: { color: '#94a3b8' },
              grid: { color: '#334155' },
            },
            y: {
              stacked: true,
              ticks: { color: '#94a3b8' },
              grid: { display: false },
            },
          },
          plugins: {
            legend: {
              position: 'top',
              labels: { boxWidth: 12, padding: 8, color: '#94a3b8', font: { size: 11 } },
            },
          },
        },
      });
    }
  }
}
