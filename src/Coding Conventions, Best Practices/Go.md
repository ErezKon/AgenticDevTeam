# Go Best Practices, Guidelines & Conventions

---

## Table of Contents

1. [Coding Conventions](#1-coding-conventions)
   - [1.1 Naming Conventions](#11-naming-conventions)
   - [1.2 File Structure & Ordering](#12-file-structure--ordering)
   - [1.3 Struct Tag Conventions](#13-struct-tag-conventions)
   - [1.4 Comment Conventions](#14-comment-conventions)
   - [1.5 Formatting (Non-Negotiable)](#15-formatting-non-negotiable)
2. [Project Layout](#2-project-layout)
3. [Error Handling](#3-error-handling)
4. [Interfaces](#4-interfaces)
5. [Goroutines & Concurrency](#5-goroutines--concurrency)
6. [Structs & Methods](#6-structs--methods)
7. [Testing](#7-testing)
8. [Modules & Performance](#8-modules--performance)
9. [Linting & Static Analysis](#9-linting--static-analysis)
10. [HTTP & API Patterns](#10-http--api-patterns)

## 1. Coding Conventions

### 1.1 Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Package | short, lowercase, no underscores | `user`, `http`, `strconv` |
| Exported (public) | PascalCase | `GetUser`, `UserService`, `ErrNotFound` |
| Unexported (private) | camelCase | `getUserFromDB`, `defaultTimeout` |
| Interface (1 method) | Method name + `er` | `Reader`, `Writer`, `Stringer` |
| Interface (multi) | Descriptive PascalCase | `UserRepository`, `FileSystem` |
| Struct | PascalCase (noun) | `User`, `HttpClient` |
| Method | PascalCase (exported) | `(u *User) FullName()` |
| Function | PascalCase (exported) | `NewUserService()` |
| Constructor | `New` + Type | `NewUserService()` |
| Getter | Property name (NO `Get` prefix) | `Name()` not `GetName()` |
| Setter | `Set` + Property | `SetName(name string)` |
| Acronyms | ALL CAPS | `UserID`, `HTTPClient`, `URL` |
| Error variable | `Err` prefix | `ErrNotFound`, `ErrTimeout` |
| Error type | PascalCase + `Error` | `NotFoundError`, `ValidationError` |
| Constants (exported) | PascalCase | `MaxRetries`, `DefaultPort` |
| Constants (unexported) | camelCase | `maxRetries`, `defaultPort` |
| File name | snake_case | `user_service.go`, `http_handler.go` |
| Test file | `_test.go` suffix | `user_service_test.go` |
| Test function | `Test` + FuncName | `TestGetUser` |
| Benchmark | `Benchmark` prefix | `BenchmarkGetUser` |
| Example | `Example` prefix | `ExampleGetUser` |

### 1.2 File Structure & Ordering

```go
// 1. Package declaration
package user

// 2. Imports (grouped with blank lines)
import (
    // Standard library
    "context"
    "errors"
    "fmt"
    "time"

    // Third-party
    "github.com/google/uuid"
    "go.uber.org/zap"

    // Internal packages
    "myapp/internal/config"
    "myapp/internal/database"
)

// 3. Package-level constants
const (
    defaultTimeout = 30 * time.Second
    maxRetries     = 3
)

// 4. Package-level variables (minimize these)
var (
    ErrNotFound   = errors.New("user: not found")
    ErrDuplicate  = errors.New("user: duplicate entry")
)

// 5. Type definitions (interfaces, structs, type aliases)
type User struct {
    ID        string    `json:"id"        db:"id"`
    Name      string    `json:"name"      db:"name"`
    Email     string    `json:"email"     db:"email"`
    CreatedAt time.Time `json:"createdAt" db:"created_at"`
}

type Service struct {
    repo   Repository
    logger *zap.Logger
}

// 6. Constructor functions
func NewService(repo Repository, logger *zap.Logger) *Service {
    return &Service{
        repo:   repo,
        logger: logger,
    }
}

// 7. Methods (grouped by receiver)
func (s *Service) GetByID(ctx context.Context, id string) (*User, error) {
    // ...
}

func (s *Service) Create(ctx context.Context, req CreateRequest) (*User, error) {
    // ...
}

// 8. Package-level helper functions
func validateEmail(email string) error {
    // ...
}
```

### 1.3 Struct Tag Conventions

```go
// Aligned struct tags for readability
type User struct {
    ID        string    `json:"id"        db:"id"         validate:"required,uuid"`
    Name      string    `json:"name"      db:"name"       validate:"required,min=2"`
    Email     string    `json:"email"     db:"email"      validate:"required,email"`
    Role      string    `json:"role"      db:"role"       validate:"oneof=admin user"`
    IsActive  bool      `json:"isActive"  db:"is_active"`
    CreatedAt time.Time `json:"createdAt" db:"created_at"`
    UpdatedAt time.Time `json:"updatedAt" db:"updated_at"`
}

// Tag order: json -> db/bson -> validate -> other
```

### 1.4 Comment Conventions

```go
// Package user provides user management functionality.
//
// This package implements CRUD operations for users,
// including validation, persistence, and event publishing.
package user

// Service manages user lifecycle operations.
//
// It coordinates between the repository layer and the
// event publisher for domain events.
type Service struct { /* ... */ }

// GetByID retrieves a user by their unique identifier.
// It returns ErrNotFound if no user exists with the given ID.
//
// The context is used for cancellation and timeout control.
func (s *Service) GetByID(ctx context.Context, id string) (*User, error) {
    // ...
}

// TODO: Add batch fetching for performance optimization.
// FIXME: Race condition when called concurrently with Delete.
// NOTE: Cache TTL is configured via environment variable USER_CACHE_TTL.
```

### 1.5 Formatting (Non-Negotiable)

```go
// Go formatting is enforced by gofmt — there is no debate.

// Tabs for indentation (gofmt default)
// Braces on same line (K&R)
// No trailing semicolons
// Imports are auto-grouped by goimports
// Exported identifiers are PascalCase
// No parentheses around if/for conditions

if err != nil {
    return fmt.Errorf("get user %s: %w", id, err)
}

for _, item := range items {
    process(item)
}

switch status {
case Active:
    activate()
case Inactive:
    deactivate()
default:
    return ErrInvalidStatus
}
```

## 2. Project Layout

```
myapp/
├── cmd/
│   └── myapp/
│       └── main.go
├── internal/
│   ├── user/
│   │   ├── handler.go
│   │   ├── service.go
│   │   ├── repository.go
│   │   └── model.go
│   └── config/
├── pkg/                      # Public libraries (optional)
├── api/                      # API definitions (protobuf, OpenAPI)
├── go.mod
├── go.sum
└── Makefile
```

## 3. Error Handling

```go
// Custom error type
type NotFoundError struct {
    Resource string
    ID       string
}

func (e *NotFoundError) Error() string {
    return fmt.Sprintf("%s with ID %s not found", e.Resource, e.ID)
}

// Wrapping errors with context
func (s *Service) GetUser(ctx context.Context, id string) (*User, error) {
    user, err := s.repo.FindByID(ctx, id)
    if err != nil {
        return nil, fmt.Errorf("get user %s: %w", id, err)
    }
    if user == nil {
        return nil, &NotFoundError{Resource: "user", ID: id}
    }
    return user, nil
}
```

## 4. Interfaces

- Define **small interfaces**.
- Define interfaces **where they are consumed**.
- Accept **interfaces**, return **concrete types**.

## 5. Goroutines & Concurrency

- Always use **`context.Context`** for cancellation and timeouts.
- Use **`sync.WaitGroup`** or **`errgroup.Group`** to manage goroutine lifecycles.
- Never start a goroutine without knowing **when and how it stops**.

```go
func processItems(ctx context.Context, items []Item) error {
    g, ctx := errgroup.WithContext(ctx)

    for _, item := range items {
        item := item
        g.Go(func() error {
            return processItem(ctx, item)
        })
    }

    return g.Wait()
}
```

## 6. Structs & Methods

- Use **functional options** pattern for complex configuration.
- Use **pointer receivers** when mutating or for large structs.
- Be **consistent** with receiver types.

```go
type ServerOption func(*Server)

func WithPort(port int) ServerOption {
    return func(s *Server) { s.port = port }
}

func NewServer(opts ...ServerOption) *Server {
    s := &Server{port: 8080, timeout: 30 * time.Second}
    for _, opt := range opts {
        opt(s)
    }
    return s
}
```

## 7. Testing

```go
func TestGetUser(t *testing.T) {
    tests := []struct {
        name    string
        id      string
        want    *User
        wantErr bool
    }{
        {
            name: "valid user",
            id:   "123",
            want: &User{ID: "123", Name: "John"},
        },
        {
            name:    "not found",
            id:      "999",
            wantErr: true,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel()
            got, err := service.GetUser(context.Background(), tt.id)
            if (err != nil) != tt.wantErr {
                t.Errorf("GetUser() error = %v, wantErr %v", err, tt.wantErr)
                return
            }
            if !reflect.DeepEqual(got, tt.want) {
                t.Errorf("GetUser() = %v, want %v", got, tt.want)
            }
        })
    }
}
```

## 8. Modules & Performance

- Use **Go Modules** (`go.mod` / `go.sum`).
- Run **`go mod tidy`** regularly.
- Benchmark with **`testing.B`** before optimizing.
- Profile with **`pprof`**.

## 9. Linting & Static Analysis

- Use **`golangci-lint`** as the unified linting tool — it runs 50+ linters efficiently.
- Configure via **`.golangci.yml`** in the project root.
- Run **`golangci-lint run ./...`** in CI on every push.
- Enable at minimum: **`govet`**, **`errcheck`**, **`staticcheck`**, **`gosimple`**, **`unused`**.

```yaml
# .golangci.yml
linters:
  enable:
    - govet
    - errcheck
    - staticcheck
    - gosimple
    - unused
    - ineffassign
    - gocritic
    - revive
    - misspell
    - prealloc

linters-settings:
  gocritic:
    enabled-tags:
      - diagnostic
      - performance
      - style

issues:
  max-issues-per-linter: 0
  max-same-issues: 0
```

## 10. HTTP & API Patterns

- Use **`http.Handler`** / **`http.HandlerFunc`** as the core abstraction.
- Implement **middleware** as functions that wrap handlers.
- Use **`context.Context`** to pass request-scoped values, deadlines, and cancellation.
- Return **structured JSON error responses** with consistent formatting.
- Use a **router** like `chi`, `gorilla/mux`, or the standard `http.ServeMux` (Go 1.22+).

```go
// Middleware pattern
func loggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        next.ServeHTTP(w, r)
        log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start))
    })
}

// Handler with structured error response
type apiError struct {
    Code    int    `json:"code"`
    Message string `json:"message"`
}

func getUserHandler(svc *UserService) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")
        user, err := svc.GetByID(r.Context(), id)
        if err != nil {
            writeJSON(w, http.StatusNotFound, apiError{
                Code:    http.StatusNotFound,
                Message: "user not found",
            })
            return
        }
        writeJSON(w, http.StatusOK, user)
    }
}
```

---
