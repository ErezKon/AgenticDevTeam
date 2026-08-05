# JavaScript Best Practices, Guidelines & Conventions

---

## Table of Contents

1. [Coding Conventions](#1-coding-conventions)
   - 1.1 [Naming Conventions](#11-naming-conventions)
   - 1.2 [Formatting Rules](#12-formatting-rules)
   - 1.3 [Ordering & File Structure](#13-ordering--file-structure)
   - 1.4 [Commenting Conventions](#14-commenting-conventions)
   - 1.5 [Declaration Conventions](#15-declaration-conventions)
2. [General Principles](#2-general-principles)
3. [Code Style & Tooling](#3-code-style--tooling)
4. [Variables & Data Types](#4-variables--data-types)
5. [Functions](#5-functions)
6. [Asynchronous Code](#6-asynchronous-code)
7. [Error Handling](#7-error-handling)
8. [Modules & Imports](#8-modules--imports)
9. [Performance](#9-performance)
10. [Security](#10-security)
11. [Testing](#11-testing)

---

## 1. Coding Conventions

### 1.1 Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Variable | camelCase | `userName`, `isActive` |
| Constant | UPPER_SNAKE_CASE | `MAX_RETRIES`, `API_BASE_URL` |
| Function | camelCase (verb-prefixed) | `getUser()`, `calculateTotal()` |
| Class | PascalCase | `UserService`, `HttpClient` |
| Private method/prop | `_camelCase` or `#camelCase` | `_internalState`, `#privateField` |
| Boolean | `is`/`has`/`can`/`should` prefix | `isVisible`, `hasPermission` |
| Event handler | `handle` or `on` prefix | `handleClick`, `onSubmit` |
| File name | camelCase or kebab-case | `userService.js` / `user-service.js` |
| Test file | `.test.js` or `.spec.js` suffix | `userService.test.js` |

### 1.2 Formatting Rules

- **Indentation**: 2 spaces (industry standard) or 4 spaces — stay consistent.
- **Semicolons**: Always use them, or configure your tooling for consistent omission.
- **Quotes**: Prefer single quotes (`'`) for strings; backticks (`` ` ``) for interpolation.
- **Trailing commas**: Always use trailing commas in multi-line structures (reduces diff noise).
- **Line length**: Limit to 80–120 characters.
- **Braces**: Opening brace on the **same line** (1TBS / K&R style).
- **Blank lines**: One blank line between logical blocks; two between top-level declarations.

```javascript
// Correct formatting
const MAX_RETRIES = 3;

function getUserDisplayName(user) {
  const { firstName, lastName } = user;
  return `${firstName} ${lastName}`;
}

const users = [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },  // trailing comma
];
```

### 1.3 Ordering & File Structure

```javascript
// 1. Imports (grouped and ordered)
import fs from 'node:fs';                    // Built-in modules
import express from 'express';               // External dependencies
import { authMiddleware } from '@/middleware'; // Internal aliases
import { formatDate } from './utils.js';     // Relative imports

// 2. Constants / Configuration
const DEFAULT_PAGE_SIZE = 20;

// 3. Type/Class definitions (if any)
class UserService { /* ... */ }

// 4. Helper / Private functions
function _validateInput(data) { /* ... */ }

// 5. Exported functions / Public API
export function getUsers() { /* ... */ }
export function createUser(data) { /* ... */ }
```

### 1.4 Commenting Conventions

```javascript
/**
 * Retrieves a user by their unique identifier.
 *
 * @param {string} userId - The unique user ID.
 * @returns {Promise<User|null>} The user object, or null if not found.
 * @throws {ValidationError} If userId is empty.
 *
 * @example
 * const user = await getUserById('abc-123');
 */
async function getUserById(userId) {
  // Validate input before making the API call
  if (!userId?.trim()) {
    throw new ValidationError('userId', 'User ID is required');
  }

  // NOTE: The cache TTL is 5 minutes — see config.js for details
  return cache.getOrSet(`user:${userId}`, () => api.fetchUser(userId));
}

// TODO: Refactor this to use batch fetching for performance
// FIXME: Race condition when called concurrently with deleteUser
// HACK: Workaround for upstream API bug — remove after v2.1 release
```

### 1.5 Declaration Conventions

```javascript
// Use const by default; let only when reassignment is needed
const name = 'Alice';
let counter = 0;

// One declaration per line
const firstName = 'John';
const lastName = 'Doe';
const age = 30;

// Avoid multiple declarations in one statement
const firstName = 'John', lastName = 'Doe', age = 30;

// Declare variables at the narrowest scope
function processItems(items) {
  for (const item of items) {
    const result = transform(item); // scoped to loop
    save(result);
  }
}
```

## 2. General Principles

- Always use **strict mode** (`'use strict';`) or rely on ES modules which enable it by default.
- Prefer `const` over `let`. Avoid `var` entirely.
- Use **meaningful, descriptive** variable and function names.

## 3. Code Style & Tooling

- Use a consistent style guide such as **Airbnb**, **StandardJS**, or **Google JavaScript Style Guide**.
- Enforce formatting with tools like **Prettier** and linting with **ESLint**.
- Configure **`.editorconfig`** for cross-editor consistency.
- Use **Husky** + **lint-staged** for pre-commit hooks.

```json
// .prettierrc
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

## 4. Variables & Data Types

- Use `const` for values that won't be reassigned; `let` for those that will.
- Avoid **global variables**; encapsulate in modules or closures.
- Use **template literals** instead of string concatenation.
- Prefer **destructuring** for objects and arrays.

```javascript
// Destructuring
const { name, age } = user;
const [first, second] = items;

// Template literals
const greeting = `Hello, ${name}! You are ${age} years old.`;
```

## 5. Functions

- Prefer **arrow functions** for short, non-method functions.
- Keep functions **small and single-purpose** (Single Responsibility Principle).
- Use **default parameters** instead of manually checking for `undefined`.
- Avoid **side effects** where possible; prefer pure functions.
- Limit function parameters to **3 or fewer**; use an options object for more.

```javascript
// Good: Options object pattern
function createUser({ name, age, email, role = 'user' }) {
  // ...
}

// Bad: Too many parameters
function createUser(name, age, email, role, isActive, createdAt) {
  // ...
}
```

## 6. Asynchronous Code

- Prefer **`async/await`** over raw Promises and callbacks.
- Always handle errors with **`try/catch`** blocks in async functions.
- Avoid **callback hell**; refactor into named functions or use Promises.
- Use **`Promise.all()`** for concurrent independent operations.
- Use **`Promise.allSettled()`** when you need results regardless of individual failures.

```javascript
// Good
async function fetchUserData(userId) {
  try {
    const [profile, orders] = await Promise.all([
      fetchProfile(userId),
      fetchOrders(userId),
    ]);
    return { profile, orders };
  } catch (error) {
    logger.error('Failed to fetch user data', { userId, error });
    throw new AppError('USER_FETCH_FAILED', error);
  }
}
```

## 7. Error Handling

- Never silently swallow errors.
- Create **custom error classes** for domain-specific errors.
- Provide **meaningful error messages** with context.
- Use **error boundaries** or global handlers for uncaught exceptions.

```javascript
class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}
```

## 8. Modules & Imports

- Use **ES Modules** (`import/export`) over CommonJS (`require/module.exports`).
- Organize imports: **built-in -> external -> internal -> relative**.
- Avoid **circular dependencies**.
- Use **named exports** over default exports for better refactoring and auto-imports.

## 9. Performance

- Avoid unnecessary **DOM manipulation**; batch updates.
- Use **debounce/throttle** for frequent events (scroll, resize, keypress).
- Prefer **`Map`** and **`Set`** over plain objects/arrays for frequent lookups.
- Avoid memory leaks: clean up **event listeners**, **timers**, and **subscriptions**.
- Use **lazy loading** and **code splitting** where appropriate.

## 10. Security

- **Never trust user input**; sanitize and validate on both client and server.
- Avoid `eval()`, `innerHTML`, and `document.write()`.
- Use **Content Security Policy (CSP)** headers.
- Store sensitive data server-side; never expose secrets in client-side code.
- Use **parameterized queries** to prevent injection attacks.

## 11. Testing

- Write **unit tests** for pure functions and business logic.
- Use frameworks like **Jest**, **Vitest**, or **Mocha**.
- Aim for meaningful coverage, not arbitrary percentages.
- Follow the **Arrange-Act-Assert (AAA)** pattern.
- Mock external dependencies; test behavior, not implementation.

---
