# CSS Best Practices, Guidelines & Conventions

---

## Table of Contents

1. [Coding Conventions](#1-coding-conventions)
   - 1.1 [Naming Conventions](#11-naming-conventions)
   - 1.2 [BEM Methodology](#12-bem-methodology)
   - 1.3 [Property Ordering](#13-property-ordering)
   - 1.4 [Formatting Rules](#14-formatting-rules)
   - 1.5 [Commenting Conventions](#15-commenting-conventions)
2. [Selectors & Specificity](#2-selectors--specificity)
3. [Layout](#3-layout)
4. [Responsive Design](#4-responsive-design)
5. [Custom Properties (CSS Variables)](#5-custom-properties-css-variables)
6. [Typography & Colors](#6-typography--colors)
7. [Animations & Transitions](#7-animations--transitions)
8. [Accessibility](#8-accessibility)
9. [Performance](#9-performance)
10. [Browser Compatibility](#10-browser-compatibility)
11. [Tooling](#11-tooling)

---

## 1. Coding Conventions

### 1.1 Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Class | kebab-case (BEM recommended) | `block__element--modifier` |
| ID | kebab-case or camelCase | `main-header`, `sidebarNav` |
| Custom property | `--` prefix, kebab-case | `--color-primary`, `--spacing-md` |
| Animation | kebab-case | `fade-in`, `slide-up` |
| File | kebab-case | `main.css`, `user-card.css` |
| Utility class | short descriptive | `.text-center`, `.mt-4` |
| State class | `is-` / `has-` prefix | `.is-active`, `.has-error` |
| JavaScript hook | `js-` prefix | `.js-toggle`, `.js-modal-trigger` |

### 1.2 BEM Methodology

BEM (Block, Element, Modifier) provides a clear, predictable naming structure that reduces specificity conflicts and makes the relationship between HTML and CSS immediately obvious.

- **Block**: A standalone, reusable component (`.card`, `.nav`, `.form`).
- **Element**: A part of a block that has no standalone meaning, joined with `__` (`.card__title`).
- **Modifier**: A variant or state of a block or element, joined with `--` (`.card--featured`).

```css
/* Block */
.card {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: var(--spacing-md);
}

/* Elements */
.card__title {
  font-size: 1.25rem;
  font-weight: 700;
}

.card__body {
  margin-top: var(--spacing-sm);
  line-height: 1.6;
}

.card__footer {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--spacing-md);
}

/* Modifiers */
.card--featured {
  border-color: var(--color-primary);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.card__title--large {
  font-size: 1.75rem;
}
```

```html
<!-- Usage in HTML -->
<article class="card card--featured">
  <h2 class="card__title card__title--large">Featured Post</h2>
  <div class="card__body">Content goes here.</div>
  <footer class="card__footer">
    <button class="btn btn--primary">Read More</button>
  </footer>
</article>
```

### 1.3 Property Ordering

Maintain a consistent property declaration order, grouped by category. This improves readability and makes it easier to locate specific properties within a rule set.

1. **Layout** -- `display`, `position`, `top`, `right`, `bottom`, `left`, `z-index`, `float`, `clear`
2. **Box model** -- `width`, `height`, `min-*`, `max-*`, `margin`, `padding`, `border`
3. **Typography** -- `font-family`, `font-size`, `font-weight`, `text-align`, `text-transform`, `color`, `line-height`, `letter-spacing`
4. **Visual** -- `background`, `box-shadow`, `opacity`, `border-radius`, `outline`
5. **Animation** -- `transition`, `animation`, `transform`
6. **Misc** -- `cursor`, `pointer-events`, `overflow`, `user-select`

```css
.hero-banner {
  /* Layout */
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  z-index: 1;

  /* Box model */
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  padding: var(--spacing-xl) var(--spacing-md);

  /* Typography */
  font-family: var(--font-heading);
  font-size: 2rem;
  font-weight: 700;
  text-align: center;
  color: var(--color-text-primary);
  line-height: 1.3;

  /* Visual */
  background: linear-gradient(135deg, var(--color-primary), var(--color-secondary));
  border-radius: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);

  /* Animation */
  transition: box-shadow 0.3s ease, transform 0.3s ease;

  /* Misc */
  overflow: hidden;
}
```

### 1.4 Formatting Rules

- **Indentation**: 2 spaces (industry standard) -- stay consistent across the project.
- **One declaration per line**: never combine multiple properties on a single line.
- **Space after colon**: always include a space between the property and value (`color: red`, not `color:red`).
- **Trailing semicolons**: always include a semicolon after the last declaration in a block.
- **Blank line between rule sets**: separate rule sets with one blank line.
- **Opening brace on same line**: place `{` on the same line as the selector with a space before it.
- **Closing brace on its own line**: `}` sits alone on its own line, aligned with the selector.
- **No units on zero values**: write `0` not `0px`, `0em`, or `0rem`.
- **Shorthand properties**: use shorthand when setting all sides or sub-properties (`margin: 1rem 2rem` not four separate `margin-*` declarations).
- **Lowercase hex colors**: use lowercase and shorthand when possible (`#fff` not `#FFFFFF`, `#3a7` not `#33AA77`).
- **Quotes**: use single quotes for strings in `url()`, font family names, and attribute selectors.

```css
/* Good */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding: 0.5rem 1rem;
  font-family: 'Inter', sans-serif;
  font-size: 0.875rem;
  color: #fff;
  background: var(--color-primary);
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}

/* Bad */
.btn{
  display:inline-flex;
    ALIGN-ITEMS: center;
  gap: 0.5rem;
  margin: 0px;
  padding: 0.5rem 1rem;
  font-family: "Inter", sans-serif;
  font-size: 0.875rem;
  color: #FFFFFF;
  background: var(--color-primary);
  border: 0;border-radius: 6px;
  cursor: pointer
}
```

### 1.5 Commenting Conventions

```css
/* ==========================================================================
   Section: Header
   ========================================================================== */

/* Sub-section: Primary Navigation
   ---------------------------------------- */

/**
 * Card component
 *
 * A flexible content container with optional header, body, and footer.
 * Supports --featured and --compact modifiers.
 *
 * Usage:
 *   <div class="card card--featured"> ... </div>
 */
.card {
  /* Offset the border width to maintain alignment with sibling elements */
  margin-left: -1px;
  padding: var(--spacing-md);
  border: 1px solid var(--color-border);
}

/* TODO: Replace magic number with a design token once spacing scale is finalized */
/* FIXME: Collapsed margin causes layout shift on Safari -- needs investigation */
/* HACK: Workaround for Chrome rendering bug with nested transforms */
```

---

## 2. Selectors & Specificity

Keep specificity **low** and **flat**. High specificity leads to fragile stylesheets that require `!important` overrides and become difficult to maintain.

### Specificity Reference

| Selector Type | Specificity | Example |
|---|---|---|
| Inline style | `1,0,0,0` | `style="color: red"` |
| ID | `0,1,0,0` | `#header` |
| Class, attribute, pseudo-class | `0,0,1,0` | `.card`, `[type='text']`, `:hover` |
| Element, pseudo-element | `0,0,0,1` | `div`, `::before` |
| Universal, combinators | `0,0,0,0` | `*`, `>`, `+`, `~` |

### Rules

- Prefer **classes** for styling -- avoid IDs and element selectors.
- Avoid **deeply nested selectors** -- keep nesting to a maximum of 3 levels.
- Never use **`!important`** except for utility classes or overriding third-party styles.
- Avoid **qualifying selectors** with element names (`div.card` should be `.card`).
- Avoid **overly broad selectors** that match more elements than intended.

```css
/* Good: low specificity, flat selectors */
.nav { }
.nav__item { }
.nav__item.is-active { }
.card__title { }

/* Bad: high specificity, deeply nested */
#main-content div.container > ul.nav li a.nav-link { }
header#site-header .nav .nav__item:nth-child(2) > a { }

/* Bad: qualifying class with element */
div.card { }
a.btn { }

/* Good: unqualified class */
.card { }
.btn { }
```

```css
/* Acceptable use of !important: utility classes */
.text-center { text-align: center !important; }
.hidden { display: none !important; }
.sr-only { position: absolute !important; /* ... */ }
```

---

## 3. Layout

### 3.1 Flexbox

Use **Flexbox** for one-dimensional layouts -- aligning items along a single row or column.

```css
/* Centering content */
.flex-center {
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Space-between navigation */
.navbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--spacing-md);
}

/* Wrapping tag list */
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

/* Sticky footer layout */
.page {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.page__content {
  flex: 1;
}
```

### 3.2 Grid

Use **Grid** for two-dimensional layouts -- placing items across both rows and columns.

```css
/* Responsive card grid with auto-fill */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--spacing-lg);
}

/* Holy grail layout */
.layout {
  display: grid;
  grid-template-columns: 240px 1fr 200px;
  grid-template-rows: auto 1fr auto;
  grid-template-areas:
    'header  header  header'
    'sidebar content aside'
    'footer  footer  footer';
  min-height: 100vh;
}

.layout__header  { grid-area: header; }
.layout__sidebar { grid-area: sidebar; }
.layout__content { grid-area: content; }
.layout__aside   { grid-area: aside; }
.layout__footer  { grid-area: footer; }

/* Auto-fit for fully fluid columns */
.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
}
```

### Layout Guidelines

- Prefer **Flexbox** for one-dimensional layouts (rows or columns).
- Prefer **Grid** for two-dimensional layouts (rows and columns simultaneously).
- Avoid using **floats** for layout -- floats are a legacy technique and should only appear when supporting very old browsers.
- Use **`gap`** instead of margin hacks for spacing between flex or grid children.

---

## 4. Responsive Design

- Use a **mobile-first** approach -- start with base styles for small screens and layer on complexity with `min-width` breakpoints.
- Define breakpoints with **custom properties** or preprocessor variables for consistency.
- Use **relative units** (`rem`, `em`, `%`, `vw`, `vh`) over fixed pixels for sizing.
- Use **`clamp()`** for fluid typography and spacing that scales smoothly between breakpoints.
- Avoid fixed widths -- prefer `max-width` combined with `width: 100%`.
- Use **Container Queries** (`@container`) for component-level responsiveness in modern CSS.

```css
/* Breakpoint custom properties (for documentation; use in media queries as raw values) */
:root {
  --bp-sm: 576px;
  --bp-md: 768px;
  --bp-lg: 1024px;
  --bp-xl: 1280px;
}

/* Mobile-first: base styles apply to all screen sizes */
.container {
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 var(--spacing-md);
}

.grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--spacing-md);
}

/* Layer on complexity at larger breakpoints */
@media (min-width: 768px) {
  .grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (min-width: 1024px) {
  .grid {
    grid-template-columns: repeat(3, 1fr);
    gap: var(--spacing-lg);
  }
}

/* Fluid typography with clamp() */
.heading {
  font-size: clamp(1.5rem, 2vw + 1rem, 3rem);
  line-height: 1.2;
}

/* Container queries for component-level responsiveness */
.card-wrapper {
  container-type: inline-size;
  container-name: card;
}

@container card (min-width: 400px) {
  .card {
    display: grid;
    grid-template-columns: 150px 1fr;
    gap: var(--spacing-md);
  }
}
```

---

## 5. Custom Properties (CSS Variables)

- Define **design tokens** as custom properties on `:root` for global access.
- Organize by category: colors, spacing, typography, shadows, borders, z-index.
- Use **semantic names** (`--color-text-primary` not `--black`) so values can change without renaming.
- Scope **component-specific variables** to the component selector for encapsulation.
- Provide **fallback values** where appropriate using the second argument of `var()`.

```css
:root {
  /* Colors -- Palette */
  --color-gray-50: #f9fafb;
  --color-gray-100: #f3f4f6;
  --color-gray-200: #e5e7eb;
  --color-gray-700: #374151;
  --color-gray-900: #111827;
  --color-blue-500: #3b82f6;
  --color-blue-600: #2563eb;
  --color-blue-700: #1d4ed8;
  --color-red-500: #ef4444;
  --color-green-500: #22c55e;

  /* Colors -- Semantic */
  --color-primary: var(--color-blue-600);
  --color-primary-hover: var(--color-blue-700);
  --color-danger: var(--color-red-500);
  --color-success: var(--color-green-500);
  --color-text-primary: var(--color-gray-900);
  --color-text-secondary: var(--color-gray-700);
  --color-bg-primary: #fff;
  --color-bg-secondary: var(--color-gray-50);
  --color-border: var(--color-gray-200);

  /* Spacing */
  --spacing-xs: 0.25rem;
  --spacing-sm: 0.5rem;
  --spacing-md: 1rem;
  --spacing-lg: 1.5rem;
  --spacing-xl: 2rem;
  --spacing-2xl: 3rem;

  /* Typography */
  --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
  --font-mono: 'Fira Code', ui-monospace, monospace;
  --font-heading: var(--font-sans);
  --font-size-xs: 0.75rem;
  --font-size-sm: 0.875rem;
  --font-size-base: 1rem;
  --font-size-lg: 1.125rem;
  --font-size-xl: 1.25rem;
  --font-size-2xl: 1.5rem;
  --font-size-3xl: 2rem;
  --line-height-tight: 1.25;
  --line-height-normal: 1.5;
  --line-height-relaxed: 1.75;

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 10px 24px rgba(0, 0, 0, 0.15);

  /* Borders */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-full: 9999px;

  /* Z-index scale */
  --z-dropdown: 100;
  --z-sticky: 200;
  --z-overlay: 300;
  --z-modal: 400;
  --z-toast: 500;

  /* Transitions */
  --duration-fast: 150ms;
  --duration-normal: 250ms;
  --duration-slow: 400ms;
  --easing-default: cubic-bezier(0.4, 0, 0.2, 1);
}

/* Component-scoped variables */
.btn {
  --btn-padding-x: 1rem;
  --btn-padding-y: 0.5rem;
  --btn-radius: var(--radius-md);
  --btn-bg: var(--color-primary);
  --btn-color: #fff;

  padding: var(--btn-padding-y) var(--btn-padding-x);
  color: var(--btn-color);
  background: var(--btn-bg);
  border-radius: var(--btn-radius);
}

.btn--large {
  --btn-padding-x: 1.5rem;
  --btn-padding-y: 0.75rem;
}
```

---

## 6. Typography & Colors

- Use a **type scale** for consistent font sizes across the project.
- Set `font-size` on `<html>` with a relative unit (typically `100%` or `16px` equivalent) for accessibility -- users can scale with browser settings.
- Use **`rem`** for font sizes to maintain consistent scaling relative to the root.
- Use **`em`** for component-relative spacing (e.g., padding that scales with the element's own font size).
- Define a **color palette** with custom properties and reference semantic tokens in component styles.
- Ensure **WCAG AA contrast ratios**: at least 4.5:1 for normal text and 3:1 for large text (18px bold or 24px regular).

```css
/* Base typography */
html {
  font-size: 100%; /* 16px default -- respects user browser settings */
}

body {
  font-family: var(--font-sans);
  font-size: var(--font-size-base);
  line-height: var(--line-height-normal);
  color: var(--color-text-primary);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* Type scale */
.text-xs   { font-size: var(--font-size-xs); }
.text-sm   { font-size: var(--font-size-sm); }
.text-base { font-size: var(--font-size-base); }
.text-lg   { font-size: var(--font-size-lg); }
.text-xl   { font-size: var(--font-size-xl); }
.text-2xl  { font-size: var(--font-size-2xl); }
.text-3xl  { font-size: var(--font-size-3xl); }

/* Headings */
h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-heading);
  font-weight: 700;
  line-height: var(--line-height-tight);
  color: var(--color-text-primary);
}

h1 { font-size: var(--font-size-3xl); }
h2 { font-size: var(--font-size-2xl); }
h3 { font-size: var(--font-size-xl); }

/* Fluid typography using clamp */
.hero__title {
  font-size: clamp(2rem, 4vw + 1rem, 4rem);
}

/* Component-relative spacing with em */
.alert {
  padding: 0.75em 1em; /* scales with the alert's own font-size */
  font-size: var(--font-size-sm);
  border-radius: var(--radius-md);
}

.alert--large {
  font-size: var(--font-size-lg); /* padding scales up automatically */
}
```

---

## 7. Animations & Transitions

- Use **`transition`** for simple state changes triggered by user interaction (hover, focus, active).
- Use **`@keyframes`** for complex or multi-step animations.
- Animate **only `transform` and `opacity`** whenever possible -- these properties are GPU-accelerated and avoid triggering layout or paint.
- Respect **`prefers-reduced-motion`** to support users who are sensitive to motion.
- Keep UI transition durations between **150ms and 400ms** -- shorter feels instant, longer feels sluggish.

```css
/* Simple transition for hover state */
.btn {
  background: var(--color-primary);
  transition: background var(--duration-fast) var(--easing-default),
              transform var(--duration-fast) var(--easing-default);
}

.btn:hover {
  background: var(--color-primary-hover);
}

.btn:active {
  transform: scale(0.97);
}

/* Keyframe animation */
@keyframes fade-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes slide-up {
  from {
    opacity: 0;
    transform: translateY(100%);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.modal {
  animation: fade-in var(--duration-normal) var(--easing-default) both;
}

.toast {
  animation: slide-up var(--duration-normal) var(--easing-default) both;
}

/* Respect reduced motion preference */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

---

## 8. Accessibility

- Never use `display: none` or `visibility: hidden` on content meant for screen readers -- use a **visually-hidden** class instead.
- Provide visible **focus styles** -- never set `outline: none` without providing an alternative focus indicator.
- Use **`prefers-reduced-motion`** to disable or reduce animations for users who request it.
- Use **`prefers-color-scheme`** to support dark mode based on system preferences.
- Ensure **sufficient color contrast** -- test with tools like axe, Lighthouse, or the browser DevTools contrast checker.
- Do not rely on **color alone** to convey information; pair with icons, text labels, or patterns.

```css
/* Visually hidden -- accessible to screen readers, invisible on screen */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

/* Allow the element to become visible again when focused (e.g., skip links) */
.sr-only--focusable:focus,
.sr-only--focusable:active {
  position: static;
  width: auto;
  height: auto;
  margin: 0;
  overflow: visible;
  clip: auto;
  white-space: normal;
}

/* Focus styles -- visible and consistent */
:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

/* Remove default outline only when :focus-visible is supported */
:focus:not(:focus-visible) {
  outline: none;
}

/* Dark mode support via system preference */
@media (prefers-color-scheme: dark) {
  :root {
    --color-text-primary: #f3f4f6;
    --color-text-secondary: #d1d5db;
    --color-bg-primary: #111827;
    --color-bg-secondary: #1f2937;
    --color-border: #374151;
  }
}
```

---

## 9. Performance

- Minimize the number of **selectors** and avoid the universal selector (`*`) in complex rules -- it forces the browser to evaluate every element.
- Use the **`contain`** property to isolate layout, style, or paint calculations to a subtree.
- Avoid **expensive properties** (`box-shadow`, `filter`, `backdrop-filter`) on elements that are animated -- they trigger paint on every frame.
- Use **`will-change`** sparingly and only on elements that will actually be animated; remove it after the animation completes when possible.
- Reduce **repaints and reflows** by batching DOM style changes and avoiding layout thrashing.
- Inline **critical CSS** (above-the-fold styles) directly in the `<head>` to speed up first contentful paint.
- Avoid **`@import`** in production CSS -- it creates additional network requests. Use build tools to concatenate stylesheets.

```css
/* contain: limit browser recalculations to this subtree */
.widget {
  contain: layout style;
}

/* will-change: hint the browser to optimize for upcoming animation */
.card {
  transition: transform 0.3s ease, box-shadow 0.3s ease;
}

.card:hover {
  will-change: transform;
  transform: translateY(-4px);
  box-shadow: var(--shadow-lg);
}

/* Avoid animating expensive properties */
/* Bad: animating width causes layout recalculation every frame */
.drawer--bad {
  transition: width 0.3s ease;
}

/* Good: animate transform instead */
.drawer--good {
  transition: transform 0.3s ease;
}

.drawer--good.is-open {
  transform: translateX(0);
}

.drawer--good.is-closed {
  transform: translateX(-100%);
}
```

```html
<!-- Critical CSS inlined in <head> -->
<head>
  <style>
    /* Only above-the-fold styles */
    body { margin: 0; font-family: system-ui, sans-serif; }
    .header { display: flex; align-items: center; height: 64px; }
  </style>
  <link rel="stylesheet" href="/styles/main.css" media="print" onload="this.media='all'">
</head>
```

---

## 10. Browser Compatibility

- Use **Autoprefixer** (via PostCSS) instead of writing vendor prefixes by hand -- it adds only the prefixes your target browsers need.
- Define browser support targets in a **`.browserslistrc`** file or in `package.json` so all tools share the same configuration.
- Use **`@supports`** for progressive enhancement -- ship modern CSS to capable browsers and provide a working fallback for older ones.
- Test in your **target browsers** regularly, especially for layout (Grid, Flexbox) and newer features (Container Queries, `:has()`).

```
# .browserslistrc
last 2 versions
> 1%
not dead
not op_mini all
```

```css
/* Progressive enhancement with @supports */
.grid {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}

@supports (display: grid) {
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  }
}

@supports selector(:has(*)) {
  .form-group:has(:invalid) {
    border-color: var(--color-danger);
  }
}

/* Feature query for container queries */
@supports (container-type: inline-size) {
  .card-wrapper {
    container-type: inline-size;
  }
}
```

---

## 11. Tooling

| Tool | Purpose |
|---|---|
| Stylelint | CSS linting -- enforces conventions and catches errors |
| PostCSS | CSS transformation pipeline -- plugin-based processing |
| Autoprefixer | Automatic vendor prefixes based on browserslist targets |
| PurgeCSS / CSS tree-shaking | Remove unused styles from production builds |
| Lightning CSS | Fast CSS minifier, transformer, and bundler |
| CSS Modules | Component-scoped class names to prevent style collisions |

### Stylelint Configuration

```json
// .stylelintrc.json
{
  "extends": [
    "stylelint-config-standard"
  ],
  "plugins": [
    "stylelint-order"
  ],
  "rules": {
    "selector-class-pattern": "^[a-z][a-z0-9]*(__[a-z][a-z0-9]*)?(--[a-z][a-z0-9]*)?$",
    "custom-property-pattern": "^[a-z][a-z0-9]*(-[a-z0-9]+)*$",
    "declaration-block-no-duplicate-properties": true,
    "no-descending-specificity": true,
    "color-named": "never",
    "color-hex-length": "short",
    "length-zero-no-unit": true,
    "shorthand-property-no-redundant-values": true,
    "order/properties-order": [
      "display",
      "position",
      "top", "right", "bottom", "left",
      "z-index",
      "width", "height",
      "margin", "padding",
      "border",
      "font-family", "font-size", "font-weight",
      "color",
      "background",
      "transition",
      "animation"
    ]
  }
}
```

---
