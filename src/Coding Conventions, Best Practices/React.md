# React Best Practices, Guidelines & Conventions

---

## Table of Contents

1. [Coding Conventions](#1-coding-conventions)
   - 1.1 [Naming Conventions](#11-naming-conventions)
   - 1.2 [Component File Structure](#12-component-file-structure)
   - 1.3 [Prop Conventions](#13-prop-conventions)
   - 1.4 [JSX Conventions](#14-jsx-conventions)
2. [Project Structure](#2-project-structure)
3. [Hooks Best Practices](#3-hooks-best-practices)
4. [State Management](#4-state-management)
5. [Effects & Side Effects](#5-effects--side-effects)
6. [Performance](#6-performance)
7. [Error Handling](#7-error-handling)
8. [Testing](#8-testing)
9. [Accessibility (a11y)](#9-accessibility-a11y)
10. [Server Components & React 19+](#10-server-components--react-19)
11. [Styling Approaches](#11-styling-approaches)

---

## 1. Coding Conventions

### 1.1 Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Component | PascalCase | `UserCard`, `LoginForm` |
| Component file | PascalCase + `.tsx` | `UserCard.tsx` |
| Hook | camelCase with `use` prefix | `useAuth`, `useDebounce` |
| Hook file | camelCase + `.ts` | `useAuth.ts` |
| Context | PascalCase + `Context` | `AuthContext` |
| Provider | PascalCase + `Provider` | `AuthProvider` |
| HOC | `with` prefix | `withAuth`, `withLoading` |
| Prop types | PascalCase + `Props` | `UserCardProps` |
| Event handler (prop) | `on` prefix | `onClick`, `onSubmit` |
| Event handler (internal) | `handle` prefix | `handleClick`, `handleSubmit` |
| Utility function | camelCase | `formatDate`, `parseQuery` |
| Constant | UPPER_SNAKE_CASE | `MAX_PAGE_SIZE` |
| CSS module class | camelCase | `styles.userCard` |
| Test file | `.test.tsx` / `.spec.tsx` | `UserCard.test.tsx` |

### 1.2 Component File Structure

```tsx
// Consistent component file ordering

// 1. Imports
import { useState, useCallback, type FC } from 'react';
import { clsx } from 'clsx';
import { useUserStore } from '@/stores/user';
import { Button } from '@/components/ui';
import type { User } from '@/types';
import styles from './UserCard.module.css';

// 2. Types / Interfaces
interface UserCardProps {
  user: User;
  variant?: 'compact' | 'full';
  isHighlighted?: boolean;
  onSelect: (user: User) => void;
  onDelete?: (userId: string) => void;
}

// 3. Constants
const DEFAULT_AVATAR = '/images/default-avatar.png';

// 4. Helper functions (pure, outside component)
function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase();
}

// 5. Component
export function UserCard({
  user,
  variant = 'compact',
  isHighlighted = false,
  onSelect,
  onDelete,
}: UserCardProps) {
  // 5a. Hooks (always at the top)
  const [isExpanded, setIsExpanded] = useState(false);
  const store = useUserStore();

  // 5b. Derived state
  const initials = getInitials(user.name);
  const cardClass = clsx(
    styles.card,
    styles[variant],
    { [styles.highlighted]: isHighlighted },
  );

  // 5c. Event handlers
  const handleSelect = useCallback(() => {
    onSelect(user);
  }, [user, onSelect]);

  const handleToggleExpand = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  // 5d. Render
  return (
    <div className={cardClass} onClick={handleSelect}>
      <Avatar src={user.avatar ?? DEFAULT_AVATAR} alt={initials} />
      <h3>{user.name}</h3>
      {isExpanded && <p>{user.bio}</p>}
      <Button onClick={handleToggleExpand}>
        {isExpanded ? 'Less' : 'More'}
      </Button>
    </div>
  );
}
```

### 1.3 Prop Conventions

```tsx
// Props interface conventions
interface ModalProps {
  // Required props first
  title: string;
  children: React.ReactNode;
  onClose: () => void;

  // Optional props second
  size?: 'sm' | 'md' | 'lg';
  isOpen?: boolean;
  showOverlay?: boolean;
  className?: string;

  // Render props / slots
  renderHeader?: () => React.ReactNode;
  renderFooter?: (onClose: () => void) => React.ReactNode;
}

// Spread remaining props to root element
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
}

function Button({
  variant = 'primary',
  size = 'md',
  isLoading = false,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={clsx(styles.button, styles[variant], styles[size], className)}
      disabled={disabled || isLoading}
      {...rest}
    >
      {isLoading ? <Spinner /> : children}
    </button>
  );
}
```

### 1.4 JSX Conventions

```tsx
// Self-close tags without children
<UserAvatar />
<input type="text" />

// Multi-line JSX -- parentheses for readability
return (
  <div className={styles.container}>
    <Header title={pageTitle} />
    <main>{children}</main>
    <Footer />
  </div>
);

// Conditional rendering patterns
// Short-circuit (simple)
{isLoggedIn && <UserMenu />}

// Ternary (binary choice)
{isLoading ? <Spinner /> : <Content />}

// Early return (guard clause -- preferred for complex conditions)
if (!user) {
  return <EmptyState message="No user found" />;
}

// Avoid nested ternaries in JSX
{isLoading ? <Spinner /> : hasError ? <Error /> : <Content />}  // Hard to read
```

## 2. Project Structure

```
src/
├── assets/
├── components/
│   ├── ui/
│   └── layout/
├── features/
│   ├── auth/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── services/
│   │   ├── types.ts
│   │   └── index.ts
│   └── dashboard/
├── hooks/
├── lib/
├── services/
├── store/
├── types/
├── App.tsx
└── main.tsx
```

## 3. Hooks Best Practices

- Follow the **Rules of Hooks** -- only call at the top level, only in React functions.
- Extract **reusable logic** into custom hooks prefixed with `use`.
- Keep hooks **focused** -- prefer multiple small hooks over one monolithic hook.
- Use **`useCallback`** and **`useMemo`** only when there is a **measured performance need**.
- Always specify correct **dependency arrays**.

```tsx
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}
```

## 4. State Management

- Use **`useState`** for local component state.
- Use **`useReducer`** for complex state with multiple sub-values.
- Use **Context** sparingly -- it triggers re-renders for all consumers.
- Use external stores (**Zustand**, **Jotai**, **Redux Toolkit**) for global state.
- Keep state as **close to where it's used** as possible (colocation).
- Derive state whenever possible -- **don't duplicate** what you can compute.

## 5. Effects & Side Effects

- Keep **`useEffect`** focused -- one effect per concern.
- Always return a **cleanup function** when setting up subscriptions or timers.
- Move data fetching to **libraries** like TanStack Query or SWR.
- Don't use `useEffect` to **synchronize state** -- it's usually a sign of bad state design.

## 6. Performance

- Use **React.memo** for expensive pure components that re-render with the same props.
- Use **code splitting** with `React.lazy()` and `Suspense`.
- Virtualize **long lists** with `react-window` or `@tanstack/react-virtual`.
- Use **React DevTools Profiler** to identify bottlenecks.

## 7. Error Handling

- Use **Error Boundaries** (`react-error-boundary` library).
- Provide **fallback UI** for error states.
- Handle **async errors** in data-fetching layers.

## 8. Testing

- Use **React Testing Library** (test behavior, not implementation).
- Test **user interactions** and **rendered output**.
- Avoid testing **internal state** or implementation details.
- Use **MSW (Mock Service Worker)** for API mocking.

## 9. Accessibility (a11y)

- Use **semantic HTML** elements (`<button>`, `<nav>`, `<main>`, `<form>`) over generic `<div>`.
- Add **`aria-*`** attributes for dynamic content and custom widgets.
- Ensure all interactive elements are **keyboard-navigable** and have visible **focus indicators**.
- Use **`eslint-plugin-jsx-a11y`** to catch accessibility issues at lint time.
- Manage **focus programmatically** with `useRef` and `focus()` for modals and route changes.
- Provide **alt text** for all images; use `alt=""` for decorative images.
- Test with screen readers (VoiceOver, NVDA) and **axe-core** / Lighthouse.

```tsx
// Accessible button (not a div!)
<button onClick={handleClick} aria-label="Close dialog">
  <CloseIcon aria-hidden="true" />
</button>

// Skip navigation link
<a href="#main-content" className={styles.skipLink}>
  Skip to main content
</a>

// Live region for dynamic updates
<div role="status" aria-live="polite" aria-atomic="true">
  {statusMessage}
</div>
```

## 10. Server Components & React 19+

- Understand the distinction between **Server Components** (default in App Router) and **Client Components** (`'use client'`).
- Keep **data fetching** in Server Components; push **interactivity** to Client Components.
- Use **`'use server'`** for Server Actions (form handling, mutations).
- Minimize the **client boundary** -- only mark components as `'use client'` when they use hooks, event handlers, or browser APIs.
- Prefer **streaming** and **Suspense** for progressive loading.

```tsx
// Server Component (default -- no directive needed)
async function UserProfile({ userId }: { userId: string }) {
  const user = await fetchUser(userId);  // Runs on the server
  return (
    <div>
      <h1>{user.name}</h1>
      <UserActions user={user} />  {/* Client boundary */}
    </div>
  );
}

// Client Component
'use client';

import { useState } from 'react';

function UserActions({ user }: { user: User }) {
  const [isFollowing, setIsFollowing] = useState(false);
  return (
    <button onClick={() => setIsFollowing(!isFollowing)}>
      {isFollowing ? 'Unfollow' : 'Follow'}
    </button>
  );
}
```

## 11. Styling Approaches

| Approach | Best For | Trade-offs |
|---|---|---|
| **CSS Modules** | Component-scoped styles, zero runtime | No dynamic styles based on props |
| **Tailwind CSS** | Rapid prototyping, utility-first | Verbose class lists, learning curve |
| **styled-components / Emotion** | Dynamic theming, CSS-in-JS | Runtime overhead, bundle size |
| **Vanilla Extract** | Type-safe, zero-runtime CSS-in-TS | Build-time setup, less flexible |
| **CSS-in-JS (zero-runtime)** | Type safety + performance | Newer ecosystem |

- **Pick one** approach per project and use it consistently.
- Colocate styles with components.
- Use **design tokens** (CSS custom properties or theme objects) for colors, spacing, and typography.
- Avoid **inline styles** except for truly dynamic values (e.g., calculated positions).

---
