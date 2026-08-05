# SCSS Best Practices, Guidelines & Conventions

---

## Table of Contents

1. [Coding Conventions](#1-coding-conventions)
   - 1.1 [Naming Conventions](#11-naming-conventions)
   - 1.2 [File Naming & Partials](#12-file-naming--partials)
   - 1.3 [Formatting Rules](#13-formatting-rules)
   - 1.4 [Commenting Conventions](#14-commenting-conventions)
2. [Variables & Design Tokens](#2-variables--design-tokens)
3. [Nesting](#3-nesting)
4. [Mixins](#4-mixins)
5. [Functions](#5-functions)
6. [File Organization (7-1 Pattern)](#6-file-organization-7-1-pattern)
7. [Extends & Placeholders](#7-extends--placeholders)
8. [Responsive Design](#8-responsive-design)
9. [Performance & Output](#9-performance--output)
10. [Linting](#10-linting)
11. [Integration with Frameworks](#11-integration-with-frameworks)

---

## 1. Coding Conventions

### 1.1 Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Variable | `$kebab-case` | `$color-primary`, `$spacing-md` |
| Mixin | kebab-case | `@mixin flex-center`, `@mixin respond-to` |
| Function | kebab-case | `@function rem()`, `@function color-shade()` |
| Placeholder | `%kebab-case` | `%visually-hidden`, `%clearfix` |
| Partial file | `_` prefix kebab-case | `_variables.scss`, `_mixins.scss` |
| Class name | BEM methodology | `.block__element--modifier` |
| Design token variable | category-property-variant | `$color-text-primary`, `$font-size-lg` |
| Breakpoint variable | `$breakpoint-` prefix | `$breakpoint-md`, `$breakpoint-lg` |
| Z-index variable | `$z-` prefix | `$z-modal`, `$z-dropdown` |

### 1.2 File Naming & Partials

SCSS uses the **underscore prefix** convention to denote **partial files** -- files that are meant to be imported into other stylesheets rather than compiled on their own. The Sass compiler will not generate a standalone CSS file for any file whose name begins with `_`.

```
scss/
|-- _variables.scss        # Partial: imported, not compiled alone
|-- _mixins.scss           # Partial: imported, not compiled alone
|-- _buttons.scss          # Partial: component styles
|-- _typography.scss       # Partial: base type styles
|-- main.scss              # Entry point: compiled to main.css
```

- **Partials** (`_filename.scss`) are never compiled to standalone CSS files.
- The **entry point** (`main.scss`) has no underscore; it imports all partials and is compiled to CSS.
- When importing a partial, omit the underscore and extension: `@use 'variables';` resolves to `_variables.scss`.
- Use **kebab-case** for all file names: `_form-elements.scss`, `_color-tokens.scss`.
- Colocate component styles with their component when using a framework, or group by purpose in standalone projects.

### 1.3 Formatting Rules

Follow standard CSS formatting rules, plus these SCSS-specific additions:

- **Indentation**: 2 spaces (consistent with most CSS/SCSS tooling defaults).
- **Nesting**: Maximum **3 levels** deep -- deeper nesting produces overly specific selectors and is a code smell.
- **Declaration order within a rule**:
  1. `@extend` statements
  2. `@include` statements (mixin calls)
  3. Regular property declarations (grouped logically or by type)
  4. Nested selectors and media queries
- **Parent selector (`&`)**: Group all `&` usages together -- pseudo-classes, BEM elements, and modifiers.
- **Comments**: Use `//` for developer comments that should not appear in compiled output. Use `/* */` for comments that must persist in the final CSS.
- **Blank lines**: One blank line between logical groups of declarations and between nested rule blocks.
- **Trailing semicolons**: Always include the semicolon after the last declaration in a block.

```scss
// Well-formatted SCSS example
.card {
  @extend %box-reset;
  @include elevation(2);

  display: flex;
  flex-direction: column;
  padding: $spacing-md;
  border-radius: $border-radius-md;
  background-color: $color-surface;

  // Pseudo-class
  &:hover {
    box-shadow: $shadow-lg;
  }

  &:focus-visible {
    outline: 2px solid $color-focus;
    outline-offset: 2px;
  }

  // BEM elements
  &__header {
    display: flex;
    align-items: center;
    margin-bottom: $spacing-sm;
  }

  &__body {
    flex: 1;
    font-size: $font-size-base;
    line-height: $line-height-relaxed;
  }

  &__footer {
    margin-top: auto;
    padding-top: $spacing-sm;
    border-top: 1px solid $color-border;
  }

  // BEM modifier
  &--featured {
    border-left: 4px solid $color-accent;
  }
}
```

### 1.4 Commenting Conventions

```scss
// ---------------------------------------------------------
// Section: Typography
// ---------------------------------------------------------

// Developer comment -- stripped from compiled CSS output.
// Use these for implementation notes, TODOs, and explanations
// that are only relevant during development.

/* Preserved comment -- appears in compiled CSS output.
   Use these for license headers, attribution, or documentation
   that must ship with the final stylesheet. */

/// Documentation comment for SassDoc.
/// Describes a mixin, function, or variable for auto-generated docs.
/// @param {String} $breakpoint - The breakpoint name from the $breakpoints map.
/// @content Styles to apply within the media query.
/// @example
///   @include respond-to('md') { display: flex; }
@mixin respond-to($breakpoint) {
  // ...
}

// TODO: Refactor color tokens to use OKLCH when browser support improves
// FIXME: The z-index scale has a gap between modal and tooltip layers
// HACK: Override third-party widget styles -- remove after vendor update
```

## 2. Variables & Design Tokens

Define variables for **all** design tokens -- colors, spacing, typography, shadows, borders, breakpoints, and z-index. This centralizes your design decisions and makes global changes trivial.

- Store variables in a dedicated **`_variables.scss`** or **`_tokens.scss`** partial.
- Use **maps** for related groups of values (colors, breakpoints, font sizes).
- Follow the **category-property-variant** naming pattern for clarity.
- Bridge SCSS variables to **CSS custom properties** when runtime theming or JavaScript access is needed.

```scss
// _variables.scss — Centralized design tokens

// ---------------------------------------------------------
// Colors
// ---------------------------------------------------------
$colors: (
  'primary':    #0066cc,
  'secondary':  #6c757d,
  'success':    #28a745,
  'warning':    #ffc107,
  'danger':     #dc3545,
  'info':       #17a2b8,
);

$color-text-primary:   #1a1a2e;
$color-text-secondary: #555770;
$color-text-muted:     #8c8ca1;
$color-background:     #ffffff;
$color-surface:        #f8f9fa;
$color-border:         #dee2e6;
$color-focus:          #0066cc;
$color-accent:         #e63946;

// ---------------------------------------------------------
// Spacing
// ---------------------------------------------------------
$spacing-xs:  0.25rem;   // 4px
$spacing-sm:  0.5rem;    // 8px
$spacing-md:  1rem;      // 16px
$spacing-lg:  1.5rem;    // 24px
$spacing-xl:  2rem;      // 32px
$spacing-2xl: 3rem;      // 48px

// ---------------------------------------------------------
// Typography
// ---------------------------------------------------------
$font-family-base: 'Inter', system-ui, -apple-system, sans-serif;
$font-family-mono: 'JetBrains Mono', 'Fira Code', monospace;

$font-sizes: (
  'xs':  0.75rem,   // 12px
  'sm':  0.875rem,  // 14px
  'base': 1rem,     // 16px
  'lg':  1.125rem,  // 18px
  'xl':  1.25rem,   // 20px
  '2xl': 1.5rem,    // 24px
  '3xl': 2rem,      // 32px
);

$font-weight-regular: 400;
$font-weight-medium:  500;
$font-weight-bold:    700;

$line-height-tight:   1.25;
$line-height-base:    1.5;
$line-height-relaxed: 1.75;

// ---------------------------------------------------------
// Breakpoints
// ---------------------------------------------------------
$breakpoints: (
  'sm': 576px,
  'md': 768px,
  'lg': 992px,
  'xl': 1200px,
  '2xl': 1400px,
);

$breakpoint-sm: 576px;
$breakpoint-md: 768px;
$breakpoint-lg: 992px;
$breakpoint-xl: 1200px;

// ---------------------------------------------------------
// Shadows
// ---------------------------------------------------------
$shadow-sm:  0 1px 2px rgba(0, 0, 0, 0.05);
$shadow-md:  0 4px 6px rgba(0, 0, 0, 0.1);
$shadow-lg:  0 10px 15px rgba(0, 0, 0, 0.1);
$shadow-xl:  0 20px 25px rgba(0, 0, 0, 0.15);

// ---------------------------------------------------------
// Borders
// ---------------------------------------------------------
$border-radius-sm:   0.25rem;
$border-radius-md:   0.5rem;
$border-radius-lg:   1rem;
$border-radius-full: 9999px;

// ---------------------------------------------------------
// Z-Index Scale
// ---------------------------------------------------------
$z-dropdown:  100;
$z-sticky:    200;
$z-overlay:   300;
$z-modal:     400;
$z-popover:   500;
$z-tooltip:   600;
$z-toast:     700;

// ---------------------------------------------------------
// Bridge to CSS custom properties
// ---------------------------------------------------------
:root {
  @each $name, $color in $colors {
    --color-#{$name}: #{$color};
  }

  @each $name, $size in $font-sizes {
    --font-size-#{$name}: #{$size};
  }

  @each $name, $bp in $breakpoints {
    --breakpoint-#{$name}: #{$bp};
  }
}
```

The bridge between SCSS variables and CSS custom properties allows runtime theming (e.g., dark mode via class toggling) while still benefiting from SCSS maps, loops, and compile-time logic.

## 3. Nesting

Nesting is one of the most powerful SCSS features, but it is also the most commonly abused. Overly nested selectors produce long, overly specific CSS selectors that are hard to override and hurt performance.

- **Maximum 3 levels** of nesting -- treat this as a strict rule.
- Use nesting for **pseudo-classes**, **pseudo-elements**, **BEM elements/modifiers**, and **media queries**.
- Avoid nesting **unrelated descendant selectors** -- if a nested selector does not have a direct parent-child relationship, it probably belongs in its own block.
- Use the **`&` parent selector** to build BEM class names and attach pseudo-classes.

```scss
// Good: Nesting within 3 levels, using & for BEM and pseudo-classes
.card {
  padding: $spacing-md;
  background-color: $color-surface;
  border-radius: $border-radius-md;

  // Pseudo-class (level 2)
  &:hover {
    box-shadow: $shadow-md;
  }

  // Pseudo-element (level 2)
  &::after {
    content: '';
    display: block;
    clear: both;
  }

  // BEM element (level 2)
  &__title {
    font-size: map-get($font-sizes, 'lg');
    font-weight: $font-weight-bold;
  }

  &__body {
    margin-top: $spacing-sm;
    color: $color-text-secondary;
  }

  // BEM modifier (level 2)
  &--featured {
    border-left: 4px solid $color-accent;

    // Modifier affecting a child element (level 3 -- maximum)
    .card__title {
      color: $color-accent;
    }
  }

  // Nested media query (level 2)
  @include respond-to('md') {
    display: flex;
    gap: $spacing-md;
  }
}
```

```scss
// Bad: Nesting too deep -- produces overly specific selectors
.page {
  .content {
    .section {
      .card {                   // Level 4 -- already too deep
        .card__title {          // Level 5 -- way too deep
          font-size: 1.25rem;
        }
      }
    }
  }
}
// Compiled output: .page .content .section .card .card__title { ... }
// This is fragile, hard to override, and a specificity nightmare.
```

**Parent selector (`&`) patterns:**

```scss
.button {
  // Concatenation for BEM
  &__icon { }
  &__label { }
  &--primary { }
  &--disabled { }

  // State pseudo-classes
  &:hover { }
  &:focus-visible { }
  &:active { }
  &:disabled { }

  // Context-dependent styling (parent class)
  .dark-theme & {
    background-color: $color-surface-dark;
  }

  // Adjacent sibling
  & + & {
    margin-left: $spacing-sm;
  }
}
```

## 4. Mixins

Mixins encapsulate reusable groups of declarations that can accept parameters, making them ideal for patterns you repeat across your codebase.

- Use mixins for **reusable patterns** with configurable parameters.
- Keep mixins **focused** -- one mixin, one pattern.
- Provide **sensible defaults** for parameters.
- Use **`@content`** blocks for wrapper-style mixins (e.g., media queries, container queries).
- Document mixins with `///` comments describing parameters and usage.

```scss
// _mixins.scss

// ---------------------------------------------------------
// Responsive breakpoints
// ---------------------------------------------------------
/// Apply styles at a given breakpoint and above (mobile-first).
/// @param {String} $breakpoint - Key from the $breakpoints map.
/// @content Styles to apply within the media query.
@mixin respond-to($breakpoint) {
  $value: map-get($breakpoints, $breakpoint);

  @if $value {
    @media (min-width: $value) {
      @content;
    }
  } @else {
    @warn "Unknown breakpoint: #{$breakpoint}. Available: #{map-keys($breakpoints)}";
  }
}

// ---------------------------------------------------------
// Text truncation
// ---------------------------------------------------------
/// Truncate text to a single line or multiple lines with ellipsis.
/// @param {Number} $lines [1] - Number of lines before truncation.
@mixin truncate($lines: 1) {
  @if $lines == 1 {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  } @else {
    display: -webkit-box;
    -webkit-line-clamp: $lines;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
}

// ---------------------------------------------------------
// Flex centering
// ---------------------------------------------------------
/// Center children both horizontally and vertically using flexbox.
/// @param {String} $direction [row] - Flex direction.
@mixin flex-center($direction: row) {
  display: flex;
  flex-direction: $direction;
  align-items: center;
  justify-content: center;
}

// ---------------------------------------------------------
// Visually hidden (accessible)
// ---------------------------------------------------------
/// Hide an element visually while keeping it accessible to screen readers.
@mixin visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

// ---------------------------------------------------------
// Elevation (box-shadow scale)
// ---------------------------------------------------------
/// Apply a consistent box-shadow based on an elevation level.
/// @param {Number} $level [1] - Elevation level (1-4).
@mixin elevation($level: 1) {
  @if $level == 1 { box-shadow: $shadow-sm; }
  @else if $level == 2 { box-shadow: $shadow-md; }
  @else if $level == 3 { box-shadow: $shadow-lg; }
  @else if $level == 4 { box-shadow: $shadow-xl; }
  @else { @warn "Invalid elevation level: #{$level}. Use 1-4."; }
}

// ---------------------------------------------------------
// Aspect ratio container
// ---------------------------------------------------------
/// Create a container with a fixed aspect ratio.
/// @param {Number} $width - Width component of the ratio.
/// @param {Number} $height - Height component of the ratio.
@mixin aspect-ratio($width, $height) {
  aspect-ratio: $width / $height;

  // Fallback for older browsers
  @supports not (aspect-ratio: 1) {
    &::before {
      content: '';
      display: block;
      padding-top: percentage(math.div($height, $width));
    }
  }
}
```

**Usage examples:**

```scss
.hero__title {
  @include truncate(2);
  font-size: map-get($font-sizes, '2xl');
}

.modal__overlay {
  @include flex-center;
  position: fixed;
  inset: 0;
  z-index: $z-overlay;
}

.sr-only {
  @include visually-hidden;
}

.sidebar {
  display: none;

  @include respond-to('lg') {
    display: block;
    width: 280px;
  }
}
```

## 5. Functions

SCSS functions perform **computations** and return a value. Unlike mixins, functions do not output any CSS declarations -- they are pure transformations.

- Use functions for **unit conversion**, **color manipulation**, and **mathematical calculations**.
- Functions should be **pure** -- no side effects, no output, no `@warn` unless validating inputs.
- Name functions descriptively to indicate what they return.

```scss
// _functions.scss
@use 'sass:math';
@use 'sass:color';
@use 'sass:map';

/// Convert a pixel value to rem units.
/// @param {Number} $px - The value in pixels.
/// @param {Number} $base [16] - The base font size in pixels.
/// @return {Number} The value in rem.
@function rem($px, $base: 16) {
  @return math.div($px, $base) * 1rem;
}

/// Convert a pixel value to em units.
/// @param {Number} $px - The value in pixels.
/// @param {Number} $context [16] - The context font size in pixels.
/// @return {Number} The value in em.
@function em($px, $context: 16) {
  @return math.div($px, $context) * 1em;
}

/// Darken a color by mixing it with black.
/// @param {Color} $color - The base color.
/// @param {Number} $percentage - The percentage to darken (0-100).
/// @return {Color} The darkened color.
@function color-shade($color, $percentage) {
  @return mix(black, $color, $percentage);
}

/// Lighten a color by mixing it with white.
/// @param {Color} $color - The base color.
/// @param {Number} $percentage - The percentage to lighten (0-100).
/// @return {Color} The lightened color.
@function color-tint($color, $percentage) {
  @return mix(white, $color, $percentage);
}

/// Retrieve a value from a nested map using a list of keys.
/// @param {Map} $map - The map to search.
/// @param {String...} $keys - One or more keys.
/// @return {*} The retrieved value.
@function map-deep-get($map, $keys...) {
  @each $key in $keys {
    $map: map.get($map, $key);
    @if $map == null {
      @return null;
    }
  }
  @return $map;
}

/// Retrieve a font size from the $font-sizes map.
/// @param {String} $size - The size key (e.g., 'sm', 'lg').
/// @return {Number} The font size value.
@function font-size($size) {
  $value: map.get($font-sizes, $size);
  @if $value == null {
    @warn "Unknown font size key: #{$size}. Available: #{map.keys($font-sizes)}";
  }
  @return $value;
}
```

**Usage examples:**

```scss
.container {
  max-width: rem(1200);     // 75rem
  padding: rem(24) rem(16); // 1.5rem 1rem
}

.badge {
  background-color: color-tint(map-get($colors, 'primary'), 80%);
  color: color-shade(map-get($colors, 'primary'), 20%);
  font-size: font-size('xs');
}
```

## 6. File Organization (7-1 Pattern)

The **7-1 pattern** organizes SCSS files into seven thematic folders plus a single entry-point file. This architecture scales well from medium to large projects.

```
scss/
|-- abstracts/           # Variables, mixins, functions, placeholders
|   |-- _variables.scss
|   |-- _mixins.scss
|   |-- _functions.scss
|   |-- _placeholders.scss
|   |-- _index.scss      # Forwards all abstracts
|
|-- base/                # Reset, typography, base element styles
|   |-- _reset.scss
|   |-- _typography.scss
|   |-- _base.scss
|   |-- _index.scss
|
|-- components/          # Buttons, cards, modals, forms, alerts
|   |-- _buttons.scss
|   |-- _cards.scss
|   |-- _modals.scss
|   |-- _forms.scss
|   |-- _index.scss
|
|-- layout/              # Header, footer, grid, sidebar, navigation
|   |-- _header.scss
|   |-- _footer.scss
|   |-- _grid.scss
|   |-- _sidebar.scss
|   |-- _index.scss
|
|-- pages/               # Page-specific styles
|   |-- _home.scss
|   |-- _about.scss
|   |-- _dashboard.scss
|   |-- _index.scss
|
|-- themes/              # Dark mode, branded themes, seasonal
|   |-- _dark.scss
|   |-- _high-contrast.scss
|   |-- _index.scss
|
|-- vendors/             # Third-party CSS overrides
|   |-- _normalize.scss
|   |-- _datepicker.scss
|   |-- _index.scss
|
|-- main.scss            # Entry point -- imports everything
```

**`main.scss` (entry point):**

```scss
// main.scss
// Import order matters: abstracts first, then base, then specifics.

// 1. Abstracts — no CSS output; only variables, mixins, functions
@use 'abstracts';

// 2. Vendors — third-party resets and overrides
@use 'vendors';

// 3. Base — element-level defaults (html, body, headings, links)
@use 'base';

// 4. Layout — structural page regions
@use 'layout';

// 5. Components — reusable UI components
@use 'components';

// 6. Pages — page-specific overrides
@use 'pages';

// 7. Themes — theme-specific overrides
@use 'themes';
```

**Simplified structure for smaller projects:**

Not every project requires the full 7-1 architecture. Smaller projects can simplify to three or four folders:

```
scss/
|-- _variables.scss
|-- _mixins.scss
|-- _base.scss
|-- _components.scss
|-- _layout.scss
|-- main.scss
```

The key principle is the same: separate concerns, control import order, and keep a single entry point.

## 7. Extends & Placeholders

The `@extend` directive lets one selector inherit the styles of another. **Placeholder selectors** (`%name`) exist solely to be extended and produce no CSS output on their own.

- Prefer **`%placeholder`** selectors over extending concrete classes.
- Be cautious with **`@extend`** -- it can create unexpected selector bloat by grouping every extending selector together in the output.
- **Never extend across different media queries** -- Sass cannot do this and will throw an error.
- Consider using **mixins** as an alternative when `@extend` produces unpredictable or bloated output.

```scss
// Placeholders -- produce no output unless extended
%visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

%clearfix {
  &::after {
    content: '';
    display: table;
    clear: both;
  }
}

%reset-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

%reset-button {
  appearance: none;
  margin: 0;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
```

```scss
// Good: Extending a placeholder
.sr-only {
  @extend %visually-hidden;
}

.skip-link:not(:focus) {
  @extend %visually-hidden;
}

.nav__list {
  @extend %reset-list;
  display: flex;
  gap: $spacing-sm;
}
```

```scss
// Bad: Extending a concrete class -- creates tight coupling
.button {
  padding: $spacing-sm $spacing-md;
  border-radius: $border-radius-md;
  font-weight: $font-weight-medium;
}

// This creates: .button, .submit-button { ... } -- coupling unrelated selectors
.submit-button {
  @extend .button;
  background-color: map-get($colors, 'primary');
}
```

**When to use mixins instead of `@extend`:**

- When you need to pass **parameters** to customize the output.
- When the extending selectors are in **different media queries**.
- When `@extend` produces **unexpected selector groupings** in the compiled output.
- When a pattern is used **many times** across unrelated selectors (mixin output is duplicated but predictable; `@extend` output is deduplicated but can cascade unpredictably).

## 8. Responsive Design

- Use a **mixin-based** approach for breakpoints to keep media queries consistent and maintainable.
- Write **mobile-first** styles using `min-width` breakpoints -- base styles apply to the smallest screens, and wider breakpoints progressively enhance.
- Store breakpoints in a **single map** to keep values in one place.
- **Nest media queries** inside the component selector rather than grouping all breakpoint-specific styles at the bottom of the file. This keeps related styles together.

```scss
// Breakpoints map (defined in _variables.scss)
$breakpoints: (
  'sm': 576px,
  'md': 768px,
  'lg': 992px,
  'xl': 1200px,
  '2xl': 1400px,
);

// Mixin (defined in _mixins.scss)
@mixin respond-to($breakpoint) {
  $value: map-get($breakpoints, $breakpoint);

  @if $value {
    @media (min-width: $value) {
      @content;
    }
  } @else {
    @warn "Unknown breakpoint: #{$breakpoint}";
  }
}

// Optional: max-width mixin for targeting below a breakpoint
@mixin respond-below($breakpoint) {
  $value: map-get($breakpoints, $breakpoint);

  @if $value {
    @media (max-width: ($value - 0.02px)) {
      @content;
    }
  } @else {
    @warn "Unknown breakpoint: #{$breakpoint}";
  }
}

// Optional: between two breakpoints
@mixin respond-between($lower, $upper) {
  $min: map-get($breakpoints, $lower);
  $max: map-get($breakpoints, $upper);

  @if $min and $max {
    @media (min-width: $min) and (max-width: ($max - 0.02px)) {
      @content;
    }
  } @else {
    @warn "Unknown breakpoint(s): #{$lower}, #{$upper}";
  }
}
```

**Usage -- mobile-first component:**

```scss
.grid {
  display: grid;
  gap: $spacing-md;
  grid-template-columns: 1fr;          // Mobile: single column

  @include respond-to('md') {
    grid-template-columns: repeat(2, 1fr);  // Tablet: two columns
  }

  @include respond-to('lg') {
    grid-template-columns: repeat(3, 1fr);  // Desktop: three columns
    gap: $spacing-lg;
  }

  @include respond-to('xl') {
    grid-template-columns: repeat(4, 1fr);  // Wide: four columns
  }
}

.hero {
  padding: $spacing-lg $spacing-md;
  text-align: center;

  @include respond-to('md') {
    padding: $spacing-2xl $spacing-lg;
    text-align: left;
  }

  &__title {
    font-size: map-get($font-sizes, 'xl');

    @include respond-to('md') {
      font-size: map-get($font-sizes, '2xl');
    }

    @include respond-to('lg') {
      font-size: map-get($font-sizes, '3xl');
    }
  }
}
```

## 9. Performance & Output

The goal of SCSS is to produce **clean, minimal CSS**. Every SCSS feature has implications for the compiled output.

- **Avoid deep nesting** -- it produces long, overly specific selectors that are hard to override and increase file size.
- **Be cautious with `@extend`** -- it can increase output size unpredictably by grouping selectors you did not expect.
- **Use `@use` and `@forward`** instead of the deprecated `@import`. The `@import` rule is deprecated in Dart Sass and will eventually be removed. `@use` provides namespacing and prevents duplicate loading.
- **Minimize compiled CSS output** -- regularly inspect the generated CSS to catch bloat, duplicated rules, or unnecessary specificity.
- **Avoid generating unused styles** -- do not include large utility libraries or component styles for components you are not using.

**`@use` vs `@import` comparison:**

```scss
// Deprecated: @import
// - Loads everything into the global scope
// - Can cause duplicate CSS if imported multiple times
// - No namespacing; name collisions are possible
@import 'variables';
@import 'mixins';
.card {
  color: $color-primary;       // Global access, no namespace
  @include flex-center;        // Global access
}
```

```scss
// Preferred: @use (Dart Sass)
// - Loads the module with a namespace (default: file name)
// - Prevents duplicate loading automatically
// - Clear provenance of every variable, mixin, and function
@use 'variables' as vars;
@use 'mixins' as mix;
.card {
  color: vars.$color-primary;  // Namespaced access
  @include mix.flex-center;    // Namespaced access
}

// Use @use with * to load without a namespace (when appropriate)
@use 'variables' as *;
.card {
  color: $color-primary;       // No namespace, but still deduplicated
}
```

**`@forward` for barrel files:**

```scss
// abstracts/_index.scss
// Re-export everything so consumers can @use 'abstracts'
@forward 'variables';
@forward 'mixins';
@forward 'functions';
@forward 'placeholders';
```

**Tips for keeping output lean:**

- Run a CSS analyzer (e.g., `css-stats`, `parker`, or browser DevTools coverage) to identify unused rules.
- Avoid `@extend` chains that pull in selectors you do not need.
- Use placeholder selectors (`%name`) for patterns that should only appear in the output when actually extended.
- Split critical CSS from non-critical CSS when performance is a priority.

## 10. Linting

Consistent linting catches errors early, enforces conventions, and keeps the codebase uniform across contributors.

- Use **Stylelint** with the **`stylelint-config-standard-scss`** plugin for SCSS-aware rules.
- Add **`stylelint-config-recess-order`** (or a similar plugin) to enforce a consistent property declaration order.
- Enforce **nesting depth**, **selector naming patterns**, and **variable naming patterns**.
- Run Stylelint in **CI on every push** to prevent convention drift.
- Integrate Stylelint with your **editor** (VS Code, WebStorm) for real-time feedback.

**`.stylelintrc.json` configuration:**

```json
{
  "extends": [
    "stylelint-config-standard-scss",
    "stylelint-config-recess-order"
  ],
  "rules": {
    "max-nesting-depth": 3,
    "selector-max-compound-selectors": 4,
    "selector-max-id": 0,
    "selector-class-pattern": "^[a-z][a-z0-9]*(__[a-z0-9]+)?(--[a-z0-9]+)?$",
    "scss/dollar-variable-pattern": "^[a-z][a-z0-9-]*$",
    "scss/at-mixin-pattern": "^[a-z][a-z0-9-]*$",
    "scss/percent-placeholder-pattern": "^[a-z][a-z0-9-]*$",
    "scss/no-duplicate-mixins": true,
    "scss/no-global-function-names": true,
    "no-descending-specificity": null,
    "declaration-no-important": true
  }
}
```

**`package.json` scripts:**

```json
{
  "scripts": {
    "lint:scss": "stylelint 'src/**/*.scss'",
    "lint:scss:fix": "stylelint 'src/**/*.scss' --fix"
  },
  "devDependencies": {
    "stylelint": "^16.0.0",
    "stylelint-config-standard-scss": "^13.0.0",
    "stylelint-config-recess-order": "^5.0.0"
  }
}
```

**CI integration (GitHub Actions example):**

```yaml
- name: Lint SCSS
  run: npx stylelint 'src/**/*.scss'
```

## 11. Integration with Frameworks

### Angular

Angular supports SCSS natively. Set the default style extension in `angular.json` and reference SCSS files via `styleUrls` in components.

```json
// angular.json
{
  "projects": {
    "my-app": {
      "schematics": {
        "@schematics/angular:component": {
          "style": "scss"
        }
      },
      "architect": {
        "build": {
          "options": {
            "stylePreprocessorOptions": {
              "includePaths": ["src/scss"]
            }
          }
        }
      }
    }
  }
}
```

```typescript
// Component usage
@Component({
  selector: 'app-card',
  templateUrl: './card.component.html',
  styleUrls: ['./card.component.scss'],
})
export class CardComponent { }
```

The `includePaths` option allows you to `@use` shared partials without long relative paths: `@use 'abstracts' as *;` instead of `@use '../../../scss/abstracts' as *;`.

### React

React projects use SCSS either globally or via **CSS Modules** (`.module.scss` files). CSS Modules scope class names locally to prevent collisions.

```bash
# Install the sass package (Dart Sass)
npm install -D sass
```

```scss
// Button.module.scss
.button {
  padding: $spacing-sm $spacing-md;
  border-radius: $border-radius-md;

  &--primary {
    background-color: $color-primary;
    color: #fff;
  }
}
```

```tsx
// Button.tsx
import styles from './Button.module.scss';

export function Button({ variant = 'primary', children }) {
  return (
    <button className={`${styles.button} ${styles[`button--${variant}`]}`}>
      {children}
    </button>
  );
}
```

For global styles, import SCSS files directly in your entry point: `import './styles/main.scss';`.

### Vue

Vue Single-File Components (SFCs) support SCSS via the `lang` attribute on the `<style>` block. The `scoped` attribute ensures styles are scoped to the component.

```bash
# Install the sass package
npm install -D sass
```

```vue
<template>
  <div class="card">
    <h2 class="card__title">{{ title }}</h2>
    <p class="card__body">{{ body }}</p>
  </div>
</template>

<script setup>
defineProps({ title: String, body: String });
</script>

<style lang="scss" scoped>
@use '@/scss/abstracts' as *;

.card {
  padding: $spacing-md;
  border-radius: $border-radius-md;
  background-color: $color-surface;

  &__title {
    font-size: map-get($font-sizes, 'lg');
    font-weight: $font-weight-bold;
  }

  &__body {
    color: $color-text-secondary;
  }
}
</style>
```

Configure shared SCSS imports in `vite.config.ts` to avoid repeating `@use` in every component:

```typescript
// vite.config.ts
export default defineConfig({
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `@use "@/scss/abstracts" as *;`,
      },
    },
  },
});
```

### Next.js

Next.js supports SCSS out of the box once the `sass` package is installed. Use CSS Modules (`.module.scss`) for component-scoped styles and global SCSS files for app-wide styles.

```bash
npm install -D sass
```

```scss
// components/Card/Card.module.scss
.card {
  padding: 1.5rem;
  border-radius: 0.5rem;
  background-color: var(--color-surface);

  &__title {
    font-size: 1.25rem;
    font-weight: 700;
  }
}
```

```tsx
// components/Card/Card.tsx
import styles from './Card.module.scss';

export function Card({ title, children }) {
  return (
    <div className={styles.card}>
      <h2 className={styles.card__title}>{title}</h2>
      {children}
    </div>
  );
}
```

Configure shared SCSS variables in `next.config.js`:

```javascript
// next.config.js
const nextConfig = {
  sassOptions: {
    includePaths: ['./src/scss'],
    prependData: `@use 'abstracts' as *;`,
  },
};

module.exports = nextConfig;
```

### A note on `sass` vs `node-sass`

Always use the **`sass`** package (Dart Sass). It is the primary, actively maintained implementation of Sass. The `node-sass` package (LibSass wrapper) is **deprecated** and no longer receives new features or bug fixes. Dart Sass supports all modern Sass features including `@use`, `@forward`, the module system, and the latest built-in modules (`sass:math`, `sass:color`, `sass:map`, `sass:list`, `sass:string`).

```bash
# Install Dart Sass
npm install -D sass

# Remove deprecated node-sass if present
npm uninstall node-sass
```

---
