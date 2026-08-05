# C# Best Practices, Guidelines & Conventions

---

## Table of Contents

1. [Coding Conventions](#1-coding-conventions)
   - 1.1 [Naming Conventions](#11-naming-conventions)
   - 1.2 [File & Project Conventions](#12-file--project-conventions)
   - 1.3 [Code Ordering Within a Class](#13-code-ordering-within-a-class)
   - 1.4 [Formatting Conventions](#14-formatting-conventions)
   - 1.5 [XML Documentation Conventions](#15-xml-documentation-conventions)
2. [SOLID Principles](#2-solid-principles)
3. [Dependency Injection](#3-dependency-injection)
4. [Async/Await](#4-asyncawait)
5. [Null Safety](#5-null-safety)
6. [Records & Modern C# Features](#6-records--modern-c-features)
7. [Error Handling](#7-error-handling)
8. [Logging](#8-logging)
9. [Testing](#9-testing)
10. [Performance](#10-performance)
11. [Configuration & Options Pattern](#11-configuration--options-pattern)

---

## 1. Coding Conventions

### 1.1 Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Namespace | PascalCase (dot-separated) | `MyApp.Services.Users` |
| Class / Struct | PascalCase | `UserService` |
| Record | PascalCase | `CreateUserRequest` |
| Interface | `I` + PascalCase | `IUserRepository` |
| Method | PascalCase | `GetUserById()` |
| Async method | PascalCase + `Async` | `GetUserByIdAsync()` |
| Property | PascalCase | `FirstName` |
| Public field | PascalCase (rare) | `MaxCount` |
| Private field | `_camelCase` | `_userRepository` |
| Static readonly | PascalCase | `DefaultTimeout` |
| Parameter | camelCase | `userId` |
| Local variable | camelCase | `userCount` |
| Constant | PascalCase | `MaxRetryCount` |
| Enum type | PascalCase (singular) | `UserStatus` |
| Enum member | PascalCase | `UserStatus.Active` |
| Flags enum | PascalCase (plural) | `FilePermissions` |
| Event | PascalCase | `UserCreated` |
| Delegate | PascalCase + suffix | `EventHandler`, `Predicate` |
| Type parameter | `T` prefix PascalCase | `TEntity`, `TKey` |
| Extension method class | PascalCase + `Extensions` | `StringExtensions` |
| Test class | PascalCase + `Tests` | `UserServiceTests` |

### 1.2 File & Project Conventions

```
src/
├── MyApp.Domain/
│   ├── Entities/
│   │   └── User.cs                 # One top-level type per file
│   ├── ValueObjects/
│   │   └── Email.cs
│   ├── Enums/
│   │   └── UserStatus.cs
│   ├── Interfaces/
│   │   └── IUserRepository.cs
│   └── Exceptions/
│       └── UserNotFoundException.cs
├── MyApp.Application/
│   ├── DTOs/
│   │   └── CreateUserDto.cs
│   ├── Services/
│   │   └── UserService.cs
│   └── Validators/
│       └── CreateUserValidator.cs
├── MyApp.Infrastructure/
│   ├── Data/
│   ├── Repositories/
│   └── External/
├── MyApp.Api/
│   ├── Controllers/
│   ├── Middleware/
│   └── Program.cs
└── tests/
    ├── MyApp.UnitTests/
    └── MyApp.IntegrationTests/
```

### 1.3 Code Ordering Within a Class

```csharp
public class UserService : IUserService
{
    // 1. Constants
    private const int MaxRetryCount = 3;

    // 2. Static fields
    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(30);

    // 3. Instance fields (readonly first)
    private readonly IUserRepository _userRepository;
    private readonly ILogger<UserService> _logger;
    private int _operationCount;

    // 4. Constructors
    public UserService(
        IUserRepository userRepository,
        ILogger<UserService> logger)
    {
        _userRepository = userRepository ?? throw new ArgumentNullException(nameof(userRepository));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    // 5. Properties
    public int OperationCount => _operationCount;

    // 6. Public methods
    public async Task<User?> GetUserAsync(int id, CancellationToken ct = default)
    {
        _logger.LogInformation("Fetching user {UserId}", id);
        return await _userRepository.GetByIdAsync(id, ct);
    }

    // 7. Interface implementations (explicit, if any)

    // 8. Protected / Internal methods

    // 9. Private methods
    private void IncrementCounter() => _operationCount++;

    // 10. Nested types (avoid when possible)
}
```

### 1.4 Formatting Conventions

```csharp
// Braces on new lines (Allman style -- C# standard)
public class UserService
{
    public void DoSomething()
    {
        if (condition)
        {
            // ...
        }
        else
        {
            // ...
        }
    }
}

// Expression-bodied members for single expressions
public string FullName => $"{FirstName} {LastName}";
public override string ToString() => $"User({Id}, {Name})";

// Using declarations (C# 8+)
using var connection = new SqlConnection(connectionString);

// Pattern matching
if (result is { StatusCode: 200, Body: var body })
{
    Process(body);
}

// Switch expressions
var label = status switch
{
    UserStatus.Active => "Active",
    UserStatus.Inactive => "Inactive",
    _ => throw new ArgumentOutOfRangeException(nameof(status)),
};
```

### 1.5 XML Documentation Conventions

```csharp
/// <summary>
/// Retrieves a user by their unique identifier.
/// </summary>
/// <param name="id">The unique user identifier.</param>
/// <param name="ct">Cancellation token for the operation.</param>
/// <returns>
/// The <see cref="User"/> if found; otherwise, <see langword="null"/>.
/// </returns>
/// <exception cref="ArgumentException">
/// Thrown when <paramref name="id"/> is less than or equal to zero.
/// </exception>
/// <example>
/// <code>
/// var user = await service.GetUserAsync(42);
/// </code>
/// </example>
public async Task<User?> GetUserAsync(int id, CancellationToken ct = default)
{
    ArgumentOutOfRangeException.ThrowIfNegativeOrZero(id);
    return await _userRepository.GetByIdAsync(id, ct);
}
```

## 2. SOLID Principles

```csharp
// Dependency Inversion with Interface Segregation
public interface IUserReader
{
    Task<User?> GetByIdAsync(int id);
    Task<IReadOnlyList<User>> GetAllAsync();
}

public interface IUserWriter
{
    Task<User> CreateAsync(CreateUserDto dto);
    Task UpdateAsync(int id, UpdateUserDto dto);
    Task DeleteAsync(int id);
}

public class UserService
{
    private readonly IUserReader _reader;
    private readonly IUserWriter _writer;

    public UserService(IUserReader reader, IUserWriter writer)
    {
        _reader = reader;
        _writer = writer;
    }
}
```

## 3. Dependency Injection

- Use the **built-in DI container** in ASP.NET Core.
- Register services with appropriate lifetimes: **Transient**, **Scoped**, **Singleton**.
- Avoid the **Service Locator** pattern.
- Use **constructor injection**.

## 4. Async/Await

- Use **`async/await`** for I/O-bound operations.
- Suffix async methods with **`Async`**.
- Never use **`async void`** except in event handlers.
- Use **`ConfigureAwait(false)`** in library code.
- Avoid **blocking on async code** (`.Result`, `.Wait()`).

```csharp
public async Task<User?> GetUserAsync(int id, CancellationToken ct = default)
{
    return await _dbContext.Users
        .AsNoTracking()
        .FirstOrDefaultAsync(u => u.Id == id, ct);
}
```

## 5. Null Safety

- Enable **nullable reference types** (`<Nullable>enable</Nullable>`).
- Use **null-conditional** (`?.`) and **null-coalescing** (`??`, `??=`) operators.
- Prefer **pattern matching** for null checks.
- Return **empty collections** instead of `null`.

## 6. Records & Modern C# Features

```csharp
// Record for DTO
public record CreateUserDto(string Name, string Email, int Age);

// Switch expression
public string GetStatusLabel(UserStatus status) => status switch
{
    UserStatus.Active => "Active",
    UserStatus.Inactive => "Inactive",
    UserStatus.Suspended => "Suspended",
    _ => throw new ArgumentOutOfRangeException(nameof(status)),
};
```

## 7. Error Handling

- Use **exceptions for exceptional circumstances**, not flow control.
- Create **custom exception classes** for domain errors.
- Implement **global exception handling middleware**.
- Use the **Result pattern** for expected failures.
- Catch **specific** exception types.

## 8. Logging

```csharp
// Structured logging
_logger.LogInformation("User {UserId} logged in from {IpAddress}", userId, ipAddress);
```

## 9. Testing

```csharp
[Fact]
public async Task GetUserAsync_WithValidId_ReturnsUser()
{
    // Arrange
    var expectedUser = new User { Id = 1, Name = "John" };
    _mockRepo.Setup(r => r.GetByIdAsync(1)).ReturnsAsync(expectedUser);

    // Act
    var result = await _sut.GetUserAsync(1);

    // Assert
    Assert.NotNull(result);
    Assert.Equal("John", result.Name);
}
```

## 10. Performance

- Use **`StringBuilder`** for string concatenation in loops.
- Use **`Span<T>`**, **`Memory<T>`**, and **`ArrayPool<T>`** for high-performance paths.
- Use **`IAsyncEnumerable<T>`** for streaming large data sets.
- Use **`AsNoTracking()`** in EF Core for read-only queries.

## 11. Configuration & Options Pattern

- Use the **Options pattern** (`IOptions<T>`, `IOptionsMonitor<T>`, `IOptionsSnapshot<T>`) for strongly typed configuration.
- Bind configuration sections from **`appsettings.json`** to POCO classes.
- Use **`IOptionsMonitor<T>`** for settings that can change at runtime.
- Validate configuration at startup with **`ValidateDataAnnotations()`** or **`Validate()`**.

```csharp
// Configuration class
public class SmtpSettings
{
    public const string SectionName = "Smtp";

    [Required]
    public string Host { get; init; } = string.Empty;

    [Range(1, 65535)]
    public int Port { get; init; } = 587;

    [Required]
    public string FromAddress { get; init; } = string.Empty;

    public bool UseSsl { get; init; } = true;
}

// Registration in Program.cs
builder.Services
    .AddOptions<SmtpSettings>()
    .Bind(builder.Configuration.GetSection(SmtpSettings.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();

// Usage via DI
public class EmailService
{
    private readonly SmtpSettings _settings;

    public EmailService(IOptions<SmtpSettings> options)
    {
        _settings = options.Value;
    }
}
```

---
