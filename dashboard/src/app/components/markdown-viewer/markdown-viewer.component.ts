import { Component, Input, OnChanges, SimpleChanges, ElementRef, ViewChild, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';

@Component({
  selector: 'app-markdown-viewer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './markdown-viewer.component.html',
  styleUrls: ['./markdown-viewer.component.scss'],
})
export class MarkdownViewerComponent implements OnChanges, AfterViewChecked {
  @Input() content = '';
  @ViewChild('mdContainer') mdContainer?: ElementRef;

  renderedHtml: SafeHtml = '';
  private pendingMermaid = false;
  private mermaidModule: any = null;

  constructor(private sanitizer: DomSanitizer) {}

  ngOnChanges(changes: SimpleChanges) {
    if (changes['content']) {
      this.renderMarkdown();
    }
  }

  ngAfterViewChecked() {
    if (this.pendingMermaid && this.mdContainer) {
      this.pendingMermaid = false;
      this.renderMermaidDiagrams();
    }
  }

  private renderMarkdown() {
    if (!this.content) {
      this.renderedHtml = '';
      return;
    }

    try {
      const rawHtml = marked.parse(this.content, { async: false }) as string;
      this.renderedHtml = this.sanitizer.bypassSecurityTrustHtml(rawHtml);
      this.pendingMermaid = true;
    } catch {
      this.renderedHtml = this.sanitizer.bypassSecurityTrustHtml(
        `<pre>${this.escapeHtml(this.content)}</pre>`
      );
    }
  }

  private async renderMermaidDiagrams() {
    const container = this.mdContainer?.nativeElement;
    if (!container) return;

    const codeBlocks = container.querySelectorAll('code.language-mermaid, code.language-mmd');
    if (codeBlocks.length === 0) return;

    // Lazy-load mermaid only when needed
    if (!this.mermaidModule) {
      try {
        const mod = await import('mermaid');
        this.mermaidModule = mod.default;
        this.mermaidModule.initialize({
          startOnLoad: false,
          theme: 'dark',
          themeVariables: {
            darkMode: true,
            background: '#1e293b',
            primaryColor: '#a855f7',
            primaryTextColor: '#f1f5f9',
            primaryBorderColor: '#334155',
            lineColor: '#94a3b8',
            secondaryColor: '#3b82f6',
            tertiaryColor: '#0f172a',
          },
        });
      } catch {
        return; // mermaid not available, leave code blocks as-is
      }
    }

    for (let i = 0; i < codeBlocks.length; i++) {
      const codeEl = codeBlocks[i] as HTMLElement;
      const preEl = codeEl.parentElement;
      if (!preEl || preEl.tagName !== 'PRE') continue;

      const diagramText = codeEl.textContent ?? '';
      if (!diagramText.trim()) continue;

      try {
        const id = `mermaid-diagram-${Date.now()}-${i}`;
        const { svg } = await this.mermaidModule.render(id, diagramText);
        const wrapper = document.createElement('div');
        wrapper.className = 'mermaid-rendered';
        wrapper.innerHTML = svg;
        preEl.replaceWith(wrapper);
      } catch {
        // Leave the code block as-is if mermaid rendering fails
      }
    }
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
