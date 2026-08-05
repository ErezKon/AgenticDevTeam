# HTML Best Practices, Guidelines & Conventions

---

## Table of Contents

1. [Coding Conventions](#1-coding-conventions)
   - 1.1 [Naming Conventions](#11-naming-conventions)
   - 1.2 [Attribute Ordering](#12-attribute-ordering)
   - 1.3 [Formatting Rules](#13-formatting-rules)
   - 1.4 [Document Structure](#14-document-structure)
   - 1.5 [Commenting Conventions](#15-commenting-conventions)
2. [Semantic HTML](#2-semantic-html)
3. [Accessibility (a11y)](#3-accessibility-a11y)
4. [Forms](#4-forms)
5. [SEO & Meta Tags](#5-seo--meta-tags)
6. [Performance](#6-performance)
7. [Security](#7-security)
8. [Images & Media](#8-images--media)
9. [Validation & Tooling](#9-validation--tooling)
10. [Testing](#10-testing)

---

## 1. Coding Conventions

### 1.1 Naming Conventions

| Element | Convention | Example |
|---|---|---|
| File name | kebab-case, `.html` extension | `user-profile.html`, `contact-us.html` |
| `id` attribute | camelCase or kebab-case | `userId` or `user-id` |
| `class` attribute | kebab-case (BEM preferred) | `user-card__title--active` |
| `data-*` attribute | kebab-case | `data-user-id`, `data-toggle-target` |
| Custom element | kebab-case with prefix | `<app-user-card>`, `<ui-modal>` |
| Template / partial | `_` prefix or folder-based | `_header.html`, `partials/header.html` |
| Test selector | `data-testid` attribute | `data-testid="submit-button"` |

> Be consistent within a project. If the team uses camelCase for `id` attributes, use it everywhere. Document the choice and enforce it with linting.

### 1.2 Attribute Ordering

Write attributes in a consistent order to improve readability and reduce diff noise:

1. `class`
2. `id`, `name`
3. `data-*`
4. `src`, `for`, `type`, `href`, `value`
5. `title`, `alt`
6. `role`, `aria-*`
7. `tabindex`
8. Event handlers (`onclick`, etc. -- prefer JavaScript listeners)

```html
<!-- Attribute ordering example -->
<input
  class="form-input form-input--large"
  id="emailAddress"
  name="email"
  data-validate="email"
  type="email"
  value=""
  title="Enter your email address"
  aria-describedby="email-help"
  tabindex="0"
/>

<a
  class="nav-link nav-link--active"
  id="homeLink"
  data-section="hero"
  href="/home"
  title="Go to homepage"
  role="menuitem"
  aria-current="page"
>
  Home
</a>
```

### 1.3 Formatting Rules

- **Indentation**: 2 spaces (consistent with most front-end tooling).
- **Quotes**: Double quotes for all attribute values.
- **Self-closing tags**: Use trailing slash for void elements (`<img />`, `<br />`, `<input />`).
- **Boolean attributes**: Write without a value (`disabled`, `checked`, `required`).
- **Line length**: Wrap long lines; place each attribute on its own line when an element has more than 3 attributes.
- **Lowercase**: All tag names and attribute names in lowercase.

```html
<!-- Correct formatting -->
<section class="hero">
  <h1>Welcome to Our Platform</h1>
  <p>Build something great today.</p>

  <form class="signup-form" action="/signup" method="post">
    <label for="fullName">Full Name</label>
    <input
      class="form-input"
      id="fullName"
      name="fullName"
      type="text"
      placeholder="Jane Doe"
      required
    />

    <label for="email">Email</label>
    <input
      class="form-input"
      id="email"
      name="email"
      type="email"
      placeholder="jane@example.com"
      required
    />

    <button class="btn btn--primary" type="submit">
      Sign Up
    </button>
  </form>
</section>

<!-- Incorrect formatting -->
<SECTION CLASS='hero'>
<H1>Welcome to Our Platform</H1>
<P>Build something great today.</P>
<FORM CLASS='signup-form' ACTION="/signup" METHOD="post">
<LABEL FOR="fullName">Full Name</LABEL>
<INPUT CLASS="form-input" ID="fullName" NAME="fullName" TYPE="text" PLACEHOLDER="Jane Doe" REQUIRED="required">
</FORM>
</SECTION>
```

### 1.4 Document Structure

Every HTML5 document should follow a consistent boilerplate. Include essential meta tags and organize the body with semantic landmark elements.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <!-- Character encoding — must be within the first 1024 bytes -->
  <meta charset="UTF-8" />
  <!-- Responsive viewport -->
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <!-- Page title — unique per page, under 60 characters -->
  <title>Page Title | Site Name</title>
  <!-- Meta description for SEO -->
  <meta name="description" content="A concise description of the page content." />
  <!-- Preconnect to critical third-party origins -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <!-- Stylesheet -->
  <link rel="stylesheet" href="/css/main.css" />
  <!-- Favicon -->
  <link rel="icon" href="/favicon.ico" type="image/x-icon" />
</head>
<body>
  <!-- Skip navigation for accessibility -->
  <a class="skip-link" href="#main-content">Skip to main content</a>

  <header>
    <nav aria-label="Primary navigation">
      <!-- Navigation links -->
    </nav>
  </header>

  <main id="main-content">
    <!-- Primary page content -->
  </main>

  <footer>
    <!-- Footer content -->
  </footer>

  <!-- Scripts — placed before closing body tag or use defer -->
  <script src="/js/main.js" defer></script>
</body>
</html>
```

### 1.5 Commenting Conventions

```html
<!-- Single-line comment for brief notes -->

<!--
  Multi-line comment for longer explanations.
  Describe why a pattern is used, not what the markup does.
-->

<!-- Section: Hero Banner -->
<section class="hero">
  <!-- ... -->
</section>
<!-- /Section: Hero Banner -->

<!-- TODO: Replace placeholder image with dynamic user avatar -->
<!-- FIXME: Heading hierarchy skips h3 — restructure after redesign -->
<!-- HACK: Extra wrapper div required for IE11 flex bug — remove when dropping IE support -->
```

- Use **section markers** (`<!-- Section: ... -->` / `<!-- /Section: ... -->`) in large files to delineate regions.
- Use **TODO**, **FIXME**, and **HACK** prefixes consistently so they are searchable.
- Avoid commenting obvious markup. Comments should explain **why**, not **what**.

---

## 2. Semantic HTML

Use semantic elements to convey meaning and structure. Screen readers, search engines, and future developers all benefit from meaningful markup.

### Semantic Element Reference

| Pattern | Correct Element | Avoid |
|---|---|---|
| Page header / banner | `<header>` | `<div class="header">` |
| Navigation links | `<nav>` | `<div class="nav">` |
| Primary content | `<main>` | `<div class="main">` |
| Self-contained content | `<article>` | `<div class="article">` |
| Thematic grouping | `<section>` | `<div class="section">` |
| Tangentially related content | `<aside>` | `<div class="sidebar">` |
| Page footer | `<footer>` | `<div class="footer">` |
| Image with caption | `<figure>` + `<figcaption>` | `<div class="image-wrapper">` |
| Date/time | `<time datetime="...">` | `<span class="date">` |
| Highlighted / relevant text | `<mark>` | `<span class="highlight">` |
| Expandable disclosure | `<details>` + `<summary>` | Custom JS accordion |
| Abbreviation | `<abbr title="...">` | `<span>` with tooltip |

### Good vs Bad Example

```html
<!-- Bad: div soup with no semantic meaning -->
<div class="header">
  <div class="nav">
    <div class="nav-item"><a href="/">Home</a></div>
    <div class="nav-item"><a href="/about">About</a></div>
  </div>
</div>
<div class="content">
  <div class="article">
    <div class="title">Understanding Semantic HTML</div>
    <div class="date">June 15, 2025</div>
    <div class="text">Semantic HTML improves accessibility...</div>
  </div>
  <div class="sidebar">
    <div class="widget">Related Articles</div>
  </div>
</div>
<div class="footer">
  <div class="copyright">2025 Example Corp</div>
</div>

<!-- Good: semantic elements convey structure and meaning -->
<header>
  <nav aria-label="Primary navigation">
    <ul>
      <li><a href="/">Home</a></li>
      <li><a href="/about">About</a></li>
    </ul>
  </nav>
</header>
<main>
  <article>
    <h1>Understanding Semantic HTML</h1>
    <time datetime="2025-06-15">June 15, 2025</time>
    <p>Semantic HTML improves accessibility...</p>
  </article>
  <aside aria-label="Related articles">
    <h2>Related Articles</h2>
    <!-- ... -->
  </aside>
</main>
<footer>
  <p>&copy; 2025 Example Corp</p>
</footer>
```

---

## 3. Accessibility (a11y)

Follow **WCAG 2.1 AA** guidelines as the minimum standard. Accessibility is not optional; it is a core quality requirement.

### Key Principles

- **Heading hierarchy**: Use `<h1>` through `<h6>` in order. Never skip levels (e.g., `<h1>` then `<h3>`). Use only one `<h1>` per page.
- **Alt text**: Every `<img>` must have an `alt` attribute. Use an empty `alt=""` for decorative images.
- **ARIA**: Use ARIA attributes only when native HTML semantics are insufficient. Prefer native elements first.
- **Color contrast**: Text must meet a minimum contrast ratio of 4.5:1 (normal text) or 3:1 (large text) against its background.
- **Skip navigation**: Provide a skip link as the first focusable element on the page.
- **Labels**: Every form control must have an associated `<label>` using the `for` attribute.
- **Keyboard navigation**: All interactive elements must be reachable and operable via keyboard alone.

### Code Examples

```html
<!-- Skip navigation link -->
<a class="skip-link" href="#main-content">Skip to main content</a>

<!-- Proper heading hierarchy -->
<main id="main-content">
  <h1>Dashboard</h1>
  <section>
    <h2>Recent Activity</h2>
    <h3>Today</h3>
    <!-- content -->
    <h3>Yesterday</h3>
    <!-- content -->
  </section>
  <section>
    <h2>Statistics</h2>
    <!-- content -->
  </section>
</main>

<!-- Image alt text -->
<img src="/photos/team.jpg" alt="The engineering team at the 2025 company retreat" />
<img src="/icons/decorative-divider.svg" alt="" /> <!-- decorative: empty alt -->

<!-- ARIA attributes for custom components -->
<div
  role="alert"
  aria-live="assertive"
  aria-atomic="true"
>
  Your changes have been saved.
</div>

<button
  aria-label="Close dialog"
  aria-expanded="false"
  aria-controls="settings-panel"
>
  X
</button>

<nav aria-labelledby="breadcrumb-heading">
  <h2 id="breadcrumb-heading" class="visually-hidden">Breadcrumb</h2>
  <ol>
    <li><a href="/">Home</a></li>
    <li><a href="/products">Products</a></li>
    <li aria-current="page">Widget Pro</li>
  </ol>
</nav>
```

### ARIA Roles Reference

| Role | Usage | Example |
|---|---|---|
| `alert` | Important, time-sensitive message | Error notifications, save confirmations |
| `dialog` | Modal or dialog window | `<div role="dialog" aria-modal="true">` |
| `tablist` / `tab` / `tabpanel` | Tabbed interface | Custom tab components |
| `menu` / `menuitem` | Application-style menus | Dropdown action menus |
| `navigation` | Navigation landmark | Already implied by `<nav>` |
| `banner` | Site header | Already implied by `<header>` |
| `main` | Primary content | Already implied by `<main>` |
| `complementary` | Supporting content | Already implied by `<aside>` |
| `contentinfo` | Site footer | Already implied by `<footer>` |
| `status` | Non-urgent status update | Progress indicators, character counts |
| `tooltip` | Descriptive tooltip | `<div role="tooltip">` shown on hover/focus |
| `search` | Search landmark | `<form role="search">` |

> Avoid redundant ARIA. Do not add `role="navigation"` to a `<nav>` element -- the role is already implicit.

---

## 4. Forms

Well-structured forms are usable, accessible, and validate input before submission.

### Key Principles

- Always associate `<label>` elements with their form controls using the `for` attribute.
- Use the most specific `type` attribute for inputs (`email`, `tel`, `url`, `number`, `date`, `search`, `password`).
- Group related fields with `<fieldset>` and `<legend>`.
- Provide clear, inline validation messages connected via `aria-describedby`.
- Use `autocomplete` attributes for common fields to assist autofill.
- Ensure forms are fully keyboard-navigable.

### Well-Structured Form Example

```html
<form class="registration-form" action="/register" method="post" novalidate>
  <fieldset>
    <legend>Personal Information</legend>

    <div class="form-group">
      <label for="firstName">First Name</label>
      <input
        class="form-input"
        id="firstName"
        name="firstName"
        type="text"
        autocomplete="given-name"
        required
        aria-describedby="firstName-error"
      />
      <span class="form-error" id="firstName-error" role="alert" hidden>
        First name is required.
      </span>
    </div>

    <div class="form-group">
      <label for="lastName">Last Name</label>
      <input
        class="form-input"
        id="lastName"
        name="lastName"
        type="text"
        autocomplete="family-name"
        required
      />
    </div>

    <div class="form-group">
      <label for="emailField">Email Address</label>
      <input
        class="form-input"
        id="emailField"
        name="email"
        type="email"
        autocomplete="email"
        required
        aria-describedby="email-help"
      />
      <span class="form-hint" id="email-help">
        We will never share your email with third parties.
      </span>
    </div>
  </fieldset>

  <fieldset>
    <legend>Preferences</legend>

    <div class="form-group">
      <label for="language">Preferred Language</label>
      <select class="form-select" id="language" name="language" autocomplete="language">
        <option value="">-- Select --</option>
        <option value="en">English</option>
        <option value="es">Spanish</option>
        <option value="fr">French</option>
      </select>
    </div>

    <div class="form-group">
      <input type="checkbox" id="newsletter" name="newsletter" />
      <label for="newsletter">Subscribe to the newsletter</label>
    </div>
  </fieldset>

  <button class="btn btn--primary" type="submit">Register</button>
</form>
```

---

## 5. SEO & Meta Tags

### Essential Meta Tags

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Product Overview | Example Corp</title>
  <meta name="description" content="Explore our product features, pricing, and customer reviews." />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="https://example.com/products" />
</head>
```

### Open Graph Tags (Social Sharing)

```html
<meta property="og:title" content="Product Overview | Example Corp" />
<meta property="og:description" content="Explore our product features, pricing, and customer reviews." />
<meta property="og:image" content="https://example.com/images/og-product.jpg" />
<meta property="og:url" content="https://example.com/products" />
<meta property="og:type" content="website" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Product Overview | Example Corp" />
<meta name="twitter:description" content="Explore our product features, pricing, and customer reviews." />
<meta name="twitter:image" content="https://example.com/images/og-product.jpg" />
```

### Structured Data (JSON-LD)

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Example Corp",
  "url": "https://example.com",
  "logo": "https://example.com/images/logo.png",
  "contactPoint": {
    "@type": "ContactPoint",
    "telephone": "+1-800-555-0199",
    "contactType": "customer service"
  }
}
</script>
```

### Canonical URLs

Use canonical URLs to prevent duplicate content issues when the same page is reachable at multiple URLs.

```html
<!-- On https://example.com/products?ref=homepage -->
<link rel="canonical" href="https://example.com/products" />
```

---

## 6. Performance

### Lazy Loading

```html
<!-- Lazy load images below the fold -->
<img
  src="/images/feature.jpg"
  alt="Feature overview screenshot"
  loading="lazy"
  width="800"
  height="450"
/>

<!-- Lazy load iframes -->
<iframe
  src="https://www.youtube.com/embed/dQw4w9WgXcQ"
  title="Product demo video"
  loading="lazy"
  width="560"
  height="315"
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope"
  allowfullscreen
></iframe>
```

### Script Loading

```html
<!-- defer: download in parallel, execute after HTML parsing (preserves order) -->
<script src="/js/main.js" defer></script>

<!-- async: download in parallel, execute as soon as available (no order guarantee) -->
<script src="/js/analytics.js" async></script>

<!-- Module scripts are deferred by default -->
<script type="module" src="/js/app.js"></script>
```

### Resource Hints

```html
<!-- Preconnect: establish early connection to critical third-party origins -->
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://cdn.example.com" crossorigin />

<!-- Preload: fetch critical resources early -->
<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="/css/critical.css" as="style" />

<!-- DNS prefetch: resolve DNS for origins used later -->
<link rel="dns-prefetch" href="https://api.example.com" />
```

### Responsive Images

```html
<!-- srcset with width descriptors for responsive sizing -->
<img
  src="/images/hero-800.jpg"
  srcset="
    /images/hero-400.jpg 400w,
    /images/hero-800.jpg 800w,
    /images/hero-1200.jpg 1200w
  "
  sizes="(max-width: 600px) 100vw, (max-width: 1024px) 50vw, 800px"
  alt="Hero banner showing the product in action"
  width="800"
  height="450"
  loading="lazy"
/>
```

### General Guidelines

- Minimize **DOM depth** and total node count. Deep nesting hurts rendering performance.
- Inline **critical CSS** in the `<head>` for above-the-fold content.
- Place `<script>` tags at the end of `<body>` or use `defer` / `async`.
- Avoid render-blocking resources in `<head>` where possible.

---

## 7. Security

- **Content Security Policy (CSP)**: Set via HTTP header (preferred) or `<meta>` tag to restrict resource origins and prevent XSS.

```html
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"
/>
```

- **External links**: Always add `rel="noopener noreferrer"` to links that open in a new tab to prevent reverse tabnapping.

```html
<a href="https://external-site.com" target="_blank" rel="noopener noreferrer">
  Visit External Site
</a>
```

- **Inline event handlers**: Avoid `onclick`, `onmouseover`, and `javascript:` URLs. Attach event listeners in JavaScript instead.

```html
<!-- Bad: inline handler -->
<button onclick="handleSubmit()">Submit</button>

<!-- Good: attach in JavaScript -->
<button class="btn-submit" data-testid="submit-button">Submit</button>
```

- **User-generated content**: Always sanitize user input before rendering it in the DOM. Use a trusted sanitization library (e.g., DOMPurify) rather than manual escaping.
- **Iframes**: Use the `sandbox` attribute for untrusted content to restrict capabilities.

```html
<iframe
  src="https://untrusted-widget.com/embed"
  sandbox="allow-scripts allow-same-origin"
  title="Third-party widget"
  loading="lazy"
></iframe>
```

---

## 8. Images & Media

### Alt Text

- Provide **descriptive** `alt` text that conveys the image's purpose or content.
- Use `alt=""` for purely **decorative** images so screen readers skip them.
- Do not begin alt text with "Image of" or "Photo of" -- screen readers already announce images.

### Layout Shift Prevention

Always specify `width` and `height` attributes to reserve space and prevent Cumulative Layout Shift (CLS).

```html
<img src="/photos/profile.jpg" alt="Jane Doe" width="200" height="200" />
```

### Modern Formats with Fallback

```html
<picture>
  <source srcset="/images/hero.avif" type="image/avif" />
  <source srcset="/images/hero.webp" type="image/webp" />
  <img
    src="/images/hero.jpg"
    alt="Product hero image"
    width="1200"
    height="675"
    loading="lazy"
  />
</picture>
```

### Video and Audio

```html
<video
  controls
  width="640"
  height="360"
  poster="/images/video-poster.jpg"
  preload="metadata"
>
  <source src="/video/demo.mp4" type="video/mp4" />
  <source src="/video/demo.webm" type="video/webm" />
  <track
    src="/captions/demo-en.vtt"
    kind="captions"
    srclang="en"
    label="English"
    default
  />
  Your browser does not support the video element.
</video>

<audio controls preload="metadata">
  <source src="/audio/podcast.mp3" type="audio/mpeg" />
  <source src="/audio/podcast.ogg" type="audio/ogg" />
  <track
    src="/captions/podcast-en.vtt"
    kind="captions"
    srclang="en"
    label="English"
  />
  Your browser does not support the audio element.
</audio>
```

- Always provide **captions or subtitles** using `<track>` for video and audio content.
- Use the `poster` attribute on `<video>` to display a preview frame before playback.
- Set `preload="metadata"` to load only metadata initially, reducing bandwidth usage.

---

## 9. Validation & Tooling

### Recommended Tools

| Tool | Purpose |
|---|---|
| [W3C Markup Validation Service](https://validator.w3.org/) | Validate HTML syntax against the specification |
| [HTMLHint](https://htmlhint.com/) | Configurable HTML linter for common issues |
| [axe-core](https://github.com/dequelabs/axe-core) | Automated accessibility testing engine |
| [Lighthouse](https://developer.chrome.com/docs/lighthouse/) | Comprehensive quality audit (performance, a11y, SEO, best practices) |
| [html-validate](https://html-validate.org/) | Offline, configurable HTML linter with rule-based validation |

### Guidelines

- **Validate HTML regularly** as part of CI/CD pipelines. Catch syntax errors, missing attributes, and deprecated elements before they reach production.
- Use an **`.editorconfig`** file to enforce consistent formatting (indentation, charset, end-of-line) across editors and contributors.

```ini
# .editorconfig
root = true

[*.html]
indent_style = space
indent_size = 2
charset = utf-8
end_of_line = lf
trim_trailing_whitespace = true
insert_final_newline = true
```

- Integrate **HTMLHint** or **html-validate** into pre-commit hooks or CI to enforce linting rules automatically.
- Run **Lighthouse** audits on key pages and track scores over time.

---

## 10. Testing

### Test Selectors

- Use **`data-testid`** attributes for test selectors. Do not rely on CSS classes, IDs, or tag structure, as these are fragile and may change for styling or refactoring reasons.

```html
<!-- Good: stable test selector -->
<button class="btn btn--primary" data-testid="submit-button">Submit</button>

<!-- Bad: relying on class or tag hierarchy -->
<!-- document.querySelector('.btn--primary') -->
<!-- document.querySelector('form > div:nth-child(3) > button') -->
```

### Testing Strategies

- **Rendered HTML structure**: Verify that components render the expected HTML output in unit and integration tests. Assert on the presence of semantic elements and correct attribute values.
- **Accessibility testing**: Use **axe-core** (via `jest-axe`, `cypress-axe`, or `@axe-core/playwright`) or **pa11y** to catch accessibility violations automatically.
- **Form validation**: Test that required fields display validation messages, that invalid inputs are rejected, and that successful submissions produce the correct outcome.
- **Cross-browser testing**: Test on major browsers (Chrome, Firefox, Safari, Edge) and devices. Use tools like BrowserStack, Playwright, or Cypress for automated cross-browser coverage.
- **Visual regression**: Use tools like Percy, Chromatic, or Playwright screenshots to catch unintended visual changes.

```javascript
// Example: accessibility test with jest-axe
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

test('registration form has no accessibility violations', async () => {
  const { container } = render(<RegistrationForm />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

---
