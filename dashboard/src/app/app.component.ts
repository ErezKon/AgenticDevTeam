import { Component } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink],
  template: `
    <nav class="navbar">
      <a routerLink="/" class="nav-brand">
        <span class="brand-icon">⚡</span>
        AgenticDevTeam
      </a>
      <div class="nav-links">
        <a routerLink="/" class="nav-link">Dashboard</a>
        <a routerLink="/new-run" class="nav-link">New Run</a>
      </div>
    </nav>
    <main class="main-content">
      <router-outlet></router-outlet>
    </main>
  `,
  styles: [`
    .navbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 2rem;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
    }
    .nav-brand {
      font-weight: 700;
      font-size: 1.25rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .brand-icon { font-size: 1.5rem; }
    .nav-links { display: flex; gap: 1.5rem; }
    .nav-link {
      color: var(--text-secondary);
      font-weight: 500;
      font-size: 0.9rem;
      transition: color 0.15s;
    }
    .nav-link:hover { color: var(--text-primary); text-decoration: none; }
    .main-content { padding: 2rem; max-width: 1400px; margin: 0 auto; }
  `],
})
export class AppComponent {}
