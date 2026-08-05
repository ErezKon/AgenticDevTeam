# TypeScript Best Practices, Guidelines & Conventions

---

## Table of Contents

1. [Coding Conventions](#1-coding-conventions)
   - 1.1 [Naming Conventions](#11-naming-conventions)
   - 1.2 [Type Annotation Conventions](#12-type-annotation-conventions)
   - 1.3 [File & Module Conventions](#13-file--module-conventions)
   - 1.4 [Interface & Type Declaration Order](#14-interface--type-declaration-order)
2. [tsconfig Best Practices](#2-tsconfig-best-practices)
3. [Types vs Interfaces](#3-types-vs-interfaces)
4. [Avoid `any` -- Use Safe Alternatives](#4-avoid-any--use-safe-alternatives)
5. [Generics](#5-generics)
6. [Enums & Constant Objects](#6-enums--constant-objects)
7. [Utility Types](#7-utility-types)
8. [Type Guards & Narrowing](#8-type-guards--narrowing)
9. [Null Safety](#9-null-safety)
10. [Tooling](#10-tooling)
11. [Project References & Monorepos](#11-project-references--monorepos)
12. [Branded / Opaque Types](#12-branded--opaque-types)

---

## 1. Coding Conventions

### 1.1 Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Interface | PascalCase (no `I` prefix*) | `UserProfile`, `ApiResponse` |
| Type alias | PascalCase | `UserId`, `HttpMethod` |
| Enum | PascalCase | `UserRole` |
| Enum member | PascalCase | `UserRole.Admin` |
| Generic (simple) | Single uppercase | `<T>`, `<K, V>` |
| Generic (descriptive) | `T` prefix PascalCase | `<TItem>`, `<TResponse>` |
| Type guard | `is` prefix | `isUser()`, `isValidEmail()` |
| Type file | `.types.ts` or `types.ts` | `user.types.ts` |
| Declaration file | `.d.ts` | `global.d.ts` |

> \* The `I` prefix for interfaces is a C# convention. The TypeScript community generally omits it. Follow your team's convention.

### 1.2 Type Annotation Conventions

```typescript
// Let TypeScript infer when obvious
const name = 'Alice';                    // inferred as string
const count = 42;                        // inferred as number
const users = ['Alice', 'Bob'];          // inferred as string[]

// Annotate when inference is unclear or public API
function getUser(id: string): Promise<User | null> { /* ... */ }

// Annotate function parameters — always
function greet(name: string, age: number): string {
  return `Hello, ${name}! You are ${age}.`;
}

// Annotate complex return types
function parseConfig(raw: string): Record<string, unknown> { /* ... */ }

// Don't over-annotate obvious cases
const name: string = 'Alice';           // redundant
const items: number[] = [1, 2, 3];      // redundant
```

### 1.3 File & Module Conventions

```
src/
├── types/                    # Shared types
│   ├── user.types.ts
│   ├── api.types.ts
│   └── index.ts             # Re-exports
├── interfaces/               # Or colocate with feature
│   └── repositories.ts
├── utils/
│   ├── date.utils.ts
│   └── string.utils.ts
├── constants/
│   └── config.constants.ts
```

```typescript
// Export/Import conventions
// Named exports — preferred for discoverability
export interface User { /* ... */ }
export type UserId = string;
export function createUser(dto: CreateUserDto): User { /* ... */ }

// Barrel files (index.ts) for clean imports
export { User, UserId } from './user.types';
export { createUser } from './user.service';

// Import type separately when only used for types
import type { User } from './user.types';
```

### 1.4 Interface & Type Declaration Order

```typescript
// Consistent property ordering in interfaces
interface User {
  // 1. Identifiers
  readonly id: string;

  // 2. Required properties (alphabetical or logical grouping)
  email: string;
  name: string;
  role: UserRole;

  // 3. Optional properties
  avatar?: string;
  bio?: string;
  phone?: string;

  // 4. Timestamps
  readonly createdAt: Date;
  updatedAt: Date;

  // 5. Methods (if any)
  getDisplayName(): string;
}
```

## 2. tsconfig Best Practices

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  }
}
```

## 3. Types vs Interfaces

- Use **`interface`** for object shapes that may be extended or implemented.
- Use **`type`** for unions, intersections, mapped types, and computed types.
- Be **consistent** within a project: pick a convention and document it.

```typescript
// Interface: extendable object shapes
interface User {
  readonly id: string;
  name: string;
  email: string;
}

interface AdminUser extends User {
  permissions: Permission[];
}

// Type: unions, intersections, utilities
type Result<T> = Success<T> | Failure;
type Nullable<T> = T | null;
type UserKeys = keyof User;
```

## 4. Avoid `any` -- Use Safe Alternatives

| Instead of `any` | Use |
|---|---|
| Unknown shape | `unknown` |
| Any object | `Record<string, unknown>` |
| Function args | Proper generics |
| Third-party lib | Write or install `@types/*` |
| Temporary escape | `// @ts-expect-error` with comment |

```typescript
// Good
function parseJson(input: string): unknown {
  return JSON.parse(input);
}

// Bad
function parseJson(input: string): any {
  return JSON.parse(input);
}
```

## 5. Generics

- Use **descriptive generic names** for complex generics: `TItem`, `TResponse`, `TKey`.
- Single-letter generics (`T`, `U`, `K`, `V`) are acceptable for simple, conventional uses.
- Add **constraints** with `extends` to narrow generic types.
- Avoid overly complex generic chains; extract sub-types for readability.

```typescript
// Constrained generic with a descriptive name
function getProperty<TObj, TKey extends keyof TObj>(
  obj: TObj,
  key: TKey
): TObj[TKey] {
  return obj[key];
}
```

## 6. Enums & Constant Objects

- Prefer **`const` objects with `as const`** over `enum` for most cases.
- If using enums, prefer **string enums** for readability and debugging.

```typescript
// Preferred: const object
const Status = {
  Active: 'ACTIVE',
  Inactive: 'INACTIVE',
  Pending: 'PENDING',
} as const;

type Status = (typeof Status)[keyof typeof Status];
```

## 7. Utility Types

Leverage built-in utility types to avoid duplication:

```typescript
// Derive types from existing ones
type CreateUserDto = Omit<User, 'id' | 'createdAt'>;
type UpdateUserDto = Partial<CreateUserDto>;
type UserSummary = Pick<User, 'id' | 'name'>;
```

## 8. Type Guards & Narrowing

```typescript
// Discriminated union
type ApiResult<T> =
  | { status: 'success'; data: T }
  | { status: 'error'; error: string; code: number };

function handleResult<T>(result: ApiResult<T>) {
  switch (result.status) {
    case 'success':
      console.log(result.data);
      break;
    case 'error':
      console.error(result.error);
      break;
  }
}

// Custom type guard
function isUser(value: unknown): value is User {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'name' in value
  );
}
```

## 9. Null Safety

- Enable `strictNullChecks` (included in `strict: true`).
- Use **optional chaining** (`?.`) and **nullish coalescing** (`??`).
- Avoid **non-null assertions** (`!`) except when you are provably certain.
- Model nullable data explicitly with `T | null` or `T | undefined`.

## 10. Tooling

- Use **ESLint** with `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin`.
- Enable rules like `no-explicit-any`, `no-floating-promises`, `no-misused-promises`.
- Use **Prettier** for formatting.
- Run `tsc --noEmit` in CI to catch type errors without compiling.

## 11. Project References & Monorepos

```typescript
// tsconfig.json for monorepo root
{
  "references": [
    { "path": "./packages/shared" },
    { "path": "./packages/api" },
    { "path": "./packages/web" }
  ],
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "declarationMap": true
  }
}

// Package tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "references": [
    { "path": "../shared" }
  ]
}
```

- Use **`composite: true`** and **`declaration: true`** in all referenced projects.
- Use **`tsc --build`** (`tsc -b`) for incremental multi-project builds.
- Share a **base `tsconfig.json`** for consistent compiler options across packages.
- Use **path aliases** (`paths`) in the base config for clean cross-package imports.

## 12. Branded / Opaque Types

- Use **branded types** to prevent accidental misuse of structurally identical types (e.g., `UserId` vs `OrderId`).
- This is a compile-time-only safety net -- zero runtime overhead.

```typescript
// Branded type pattern
type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };

type UserId = Brand<string, 'UserId'>;
type OrderId = Brand<string, 'OrderId'>;

// Constructor functions
function createUserId(id: string): UserId {
  return id as UserId;
}

function createOrderId(id: string): OrderId {
  return id as OrderId;
}

// Usage — prevents mixing up IDs
function getUser(id: UserId): User { /* ... */ }
function getOrder(id: OrderId): Order { /* ... */ }

const userId = createUserId('user-123');
const orderId = createOrderId('order-456');

getUser(userId);    // OK
getUser(orderId);   // Type error — OrderId is not assignable to UserId
```

---
