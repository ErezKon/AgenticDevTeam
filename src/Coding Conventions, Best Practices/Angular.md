# Angular Best Practices, Guidelines & Conventions

---

## Table of Contents

1. [Coding Conventions](#1-coding-conventions)
   - 1.1 [Naming Conventions](#11-naming-conventions)
   - 1.2 [File Naming Conventions](#12-file-naming-conventions)
   - 1.3 [Component Conventions](#13-component-conventions)
   - 1.4 [Template Conventions](#14-template-conventions)
2. [Project Architecture](#2-project-architecture)
3. [Components](#3-components)
4. [Services & Dependency Injection](#4-services--dependency-injection)
5. [Reactive Programming (RxJS)](#5-reactive-programming-rxjs)
6. [State Management](#6-state-management)
7. [Forms](#7-forms)
8. [Routing](#8-routing)
9. [Performance](#9-performance)
10. [Testing](#10-testing)
11. [Security](#11-security)
12. [Internationalization (i18n)](#12-internationalization-i18n)
13. [Accessibility (a11y)](#13-accessibility-a11y)

---

## 1. Coding Conventions

### 1.1 Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Component | PascalCase + `Component` | `UserCardComponent` |
| Service | PascalCase + `Service` | `UserService` |
| Module | PascalCase + `Module` | `UserModule` |
| Directive | PascalCase + `Directive` | `HighlightDirective` |
| Pipe | PascalCase + `Pipe` | `DateFormatPipe` |
| Guard | PascalCase + `Guard` | `AuthGuard` |
| Interceptor | PascalCase + `Interceptor` | `AuthInterceptor` |
| Interface / Model | PascalCase | `User`, `ApiResponse` |
| Enum | PascalCase | `UserRole` |
| Component selector | kebab-case + prefix | `app-user-card` |
| Directive selector | camelCase + prefix | `appHighlight` |
| Pipe name | camelCase | `dateFormat` |
| File name | kebab-case + type suffix | `user-card.component.ts` |

### 1.2 File Naming Conventions

```
feature-name.type.ts

Examples:
  user-card.component.ts
  user-card.component.html
  user-card.component.scss
  user-card.component.spec.ts
  user.service.ts
  user.service.spec.ts
  user.model.ts
  user.interface.ts
  user.module.ts
  user-routing.module.ts
  auth.guard.ts
  auth.interceptor.ts
  highlight.directive.ts
  date-format.pipe.ts
  user.resolver.ts
  user.validator.ts
```

### 1.3 Component Conventions

```typescript
// Consistent component structure
@Component({
  // 1. Selector
  selector: 'app-user-card',
  // 2. Template
  templateUrl: './user-card.component.html',
  // 3. Styles
  styleUrls: ['./user-card.component.scss'],
  // 4. Change detection
  changeDetection: ChangeDetectionStrategy.OnPush,
  // 5. Other metadata
  standalone: true,
  imports: [CommonModule, SharedModule],
})
export class UserCardComponent implements OnInit, OnDestroy {
  // 1. Decorators — Inputs
  @Input({ required: true }) user!: User;
  @Input() showActions = false;

  // 2. Decorators — Outputs
  @Output() selected = new EventEmitter<User>();
  @Output() deleted = new EventEmitter<string>();

  // 3. Decorators — View/Content queries
  @ViewChild('avatar') avatarRef!: ElementRef;

  // 4. Public properties
  isExpanded = false;

  // 5. Private properties
  private readonly destroy$ = new Subject<void>();

  // 6. Constructor (DI)
  constructor(
    private readonly userService: UserService,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  // 7. Lifecycle hooks (in execution order)
  ngOnInit(): void { /* ... */ }
  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // 8. Public methods
  onSelect(): void {
    this.selected.emit(this.user);
  }

  // 9. Private methods
  private loadAvatar(): void { /* ... */ }
}
```

### 1.4 Template Conventions

```html
<!-- Attribute ordering in templates -->
<app-user-card
  *ngIf="user"
  #userCard
  class="user-card"
  [class.active]="isActive"
  [user]="user"
  [showActions]="true"
  (selected)="onUserSelected($event)"
  (deleted)="onUserDeleted($event)"
  trackBy: trackByUserId
  data-testid="user-card"
>
</app-user-card>

<!-- Order:
  1. Structural directives (*ngIf, *ngFor)
  2. Template reference (#ref)
  3. Static attributes (class, id)
  4. Class/style bindings ([class.x], [style.x])
  5. Input bindings ([property])
  6. Output bindings ((event))
  7. Two-way bindings ([(ngModel)])
  8. Other directives
  9. Data attributes
-->
```

## 2. Project Architecture

- Follow the **Angular Style Guide** (official).
- Organize by **feature modules**, not by type.
- Use **lazy loading** for feature modules to reduce initial bundle size.
- Implement a **Core Module** (singletons, guards, interceptors) and a **Shared Module** (components, pipes, directives).

```
src/
├── app/
│   ├── core/
│   │   ├── guards/
│   │   ├── interceptors/
│   │   ├── services/
│   │   └── core.module.ts
│   ├── shared/
│   │   ├── components/
│   │   ├── directives/
│   │   ├── pipes/
│   │   └── shared.module.ts
│   ├── features/
│   │   ├── user/
│   │   │   ├── components/
│   │   │   ├── services/
│   │   │   ├── models/
│   │   │   ├── user-routing.module.ts
│   │   │   └── user.module.ts
│   │   └── dashboard/
│   ├── app-routing.module.ts
│   └── app.module.ts
```

## 3. Components

- Keep components **small and focused** -- presentation logic only.
- Use **`OnPush`** change detection strategy for performance.
- Prefer **standalone components** (Angular 14+) for new projects.
- Use **`@Input()`** and **`@Output()`** for parent-child communication.
- Avoid direct DOM manipulation; use **Renderer2** or template bindings.
- Prefix component selectors consistently (e.g., `app-`, `feat-`).

## 4. Services & Dependency Injection

- Provide services at the **narrowest scope** needed.
- Use **`providedIn: 'root'`** for truly app-wide singletons.
- Keep services **stateless** when possible; use a state management pattern for shared state.
- Follow the **single responsibility principle** -- one service, one concern.

## 5. Reactive Programming (RxJS)

- Prefer **reactive patterns** using `Observable` streams over imperative code.
- Always **unsubscribe**: use `async` pipe, `takeUntilDestroyed()`, or `DestroyRef`.
- Use **higher-order mapping operators** (`switchMap`, `mergeMap`, `concatMap`, `exhaustMap`) correctly.
- Avoid **nested subscriptions**.
- Use **`shareReplay`** for multicasted, cacheable streams.

```typescript
// Good: async pipe handles subscription
@Component({
  template: `
    <div *ngIf="user$ | async as user">
      <h2>{{ user.name }}</h2>
    </div>
  `,
})
export class UserProfileComponent {
  user$ = this.route.params.pipe(
    switchMap((params) => this.userService.getById(params['id']))
  );

  constructor(
    private route: ActivatedRoute,
    private userService: UserService,
  ) {}
}
```

## 6. State Management

- For simple apps, use **services with `BehaviorSubject`**.
- For complex apps, use **NgRx**, **NGXS**, or **Elf**.
- Keep state **normalized** and **serializable**.
- Separate **side effects** from state mutations.

## 7. Forms

- Use **Reactive Forms** for complex forms with validation logic.
- Use **Template-Driven Forms** only for very simple forms.
- Create **reusable validators** and custom form controls.
- Show validation errors **consistently** across the app.

## 8. Routing

- Implement **lazy loading** for all feature modules.
- Use **route guards** for access control.
- Implement a **wildcard route** for 404 pages.

## 9. Performance

- Use **`OnPush`** change detection.
- Use **`trackBy`** with `*ngFor`.
- Lazy load **routes** and **components**.
- Use the **`async`** pipe to avoid manual subscriptions.
- Leverage **`@defer`** blocks (Angular 17+) for template-level lazy loading.

## 10. Testing

- Write **unit tests** for services, pipes, and component logic.
- Use **`TestBed`** for integration tests; plain classes for pure unit tests.
- Write **e2e tests** with Cypress or Playwright for critical user flows.

## 11. Security

- Use Angular's **built-in sanitization** -- avoid bypassing it.
- Never use **`innerHTML`** with unsanitized data.
- Use **`HttpInterceptor`** for auth token injection.

## 12. Internationalization (i18n)

- Use Angular's **built-in i18n** system or **`@ngx-translate`** for runtime translations.
- Mark translatable text with the **`i18n`** attribute in templates.
- Extract translation files using **`ng extract-i18n`**.
- Use **ICU message format** for pluralization and gender-aware text.
- Keep translation keys **descriptive and namespaced** (e.g., `user.profile.title`).

```html
<!-- Built-in i18n -->
<h1 i18n="@@userProfileTitle">User Profile</h1>

<span i18n="@@itemCount">{count, plural,
  =0 {No items}
  =1 {One item}
  other {{{count}} items}
}</span>
```

## 13. Accessibility (a11y)

- Use Angular CDK's **`A11yModule`** for focus management and live announcements.
- Add **`aria-*`** attributes in templates for dynamic content.
- Use **semantic HTML** elements (`<nav>`, `<main>`, `<article>`, `<button>`).
- Ensure all interactive elements are **keyboard-navigable**.
- Test with screen readers and **`axe-core`** / Lighthouse accessibility audits.

```typescript
import { LiveAnnouncer } from '@angular/cdk/a11y';

@Component({ /* ... */ })
export class NotificationComponent {
  constructor(private liveAnnouncer: LiveAnnouncer) {}

  announceNotification(message: string): void {
    this.liveAnnouncer.announce(message, 'polite');
  }
}
```

```html
<button
  [attr.aria-expanded]="isExpanded"
  [attr.aria-controls]="'panel-' + panelId"
  (click)="toggle()"
  (keydown.enter)="toggle()"
  (keydown.space)="toggle()"
>
  {{ isExpanded ? 'Collapse' : 'Expand' }}
</button>
```

---
