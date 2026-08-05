# Java Best Practices, Guidelines & Conventions

---

## Table of Contents

1. [Coding Conventions](#1-coding-conventions)
   - [1.1 Naming Conventions](#11-naming-conventions)
   - [1.2 Class Structure Order](#12-class-structure-order)
   - [1.3 Formatting Conventions](#13-formatting-conventions)
   - [1.4 Import Conventions](#14-import-conventions)
   - [1.5 Javadoc Conventions](#15-javadoc-conventions)
2. [Object-Oriented Design](#2-object-oriented-design)
3. [Modern Java Features (Java 17+)](#3-modern-java-features-java-17)
4. [Collections & Streams](#4-collections--streams)
5. [Null Safety](#5-null-safety)
6. [Exception Handling](#6-exception-handling)
7. [Concurrency](#7-concurrency)
8. [Logging](#8-logging)
9. [Build & Dependency Management](#9-build--dependency-management)
10. [Testing](#10-testing)
11. [Configuration & Profiles](#11-configuration--profiles)
12. [REST API Design](#12-rest-api-design)

## 1. Coding Conventions

### 1.1 Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Package | lowercase, dot-separated, reverse domain | `com.myapp.service.user` |
| Class | PascalCase (noun) | `UserService` |
| Abstract class | `Abstract` prefix or PascalCase | `AbstractRepository` |
| Interface | PascalCase (adjective or noun) | `Serializable`, `UserRepository` |
| Implementation | PascalCase (descriptive or `Impl`) | `JpaUserRepository` |
| Method | camelCase (verb-prefixed) | `getUserById()`, `isActive()` |
| Variable | camelCase | `userName`, `orderCount` |
| Constant | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT` |
| Enum type | PascalCase (singular) | `UserStatus` |
| Enum constant | UPPER_SNAKE_CASE | `UserStatus.ACTIVE` |
| Generic type | Single uppercase (simple) | `<T>`, `<K, V>`, `<E>` |
| Annotation | PascalCase | `@Transactional`, `@Nullable` |
| Test class | PascalCase + `Test` | `UserServiceTest` |
| Test method | camelCase (descriptive) | `shouldReturnUser_whenIdIsValid()` |
| Builder | PascalCase + `Builder` | `UserBuilder` |
| Factory | PascalCase + `Factory` | `ConnectionFactory` |
| Exception | PascalCase + `Exception` | `UserNotFoundException` |
| File name | Matches public class | `UserService.java` |

### 1.2 Class Structure Order

```java
public class UserService implements IUserService {

    // 1. Static constants
    private static final Logger log = LoggerFactory.getLogger(UserService.class);
    private static final int MAX_RETRIES = 3;

    // 2. Static fields
    private static int instanceCount = 0;

    // 3. Instance fields (final first, then mutable)
    private final UserRepository userRepository;
    private final EventPublisher eventPublisher;
    private int operationCount;

    // 4. Constructors
    public UserService(UserRepository userRepository, EventPublisher eventPublisher) {
        this.userRepository = Objects.requireNonNull(userRepository);
        this.eventPublisher = Objects.requireNonNull(eventPublisher);
    }

    // 5. Public methods
    public Optional<User> getUserById(long id) {
        log.info("Fetching user {}", id);
        return userRepository.findById(id);
    }

    // 6. Package-private methods

    // 7. Protected methods

    // 8. Private methods
    private void validateId(long id) {
        if (id <= 0) {
            throw new IllegalArgumentException("ID must be positive: " + id);
        }
    }

    // 9. equals, hashCode, toString
    @Override
    public String toString() {
        return "UserService{operationCount=" + operationCount + "}";
    }

    // 10. Inner classes / enums (avoid when possible)
}
```

### 1.3 Formatting Conventions

```java
// Braces: K&R / 1TBS style (opening brace on same line)
public class UserService {

    public void process(List<User> users) {
        if (users.isEmpty()) {
            return;
        }

        for (User user : users) {
            if (user.isActive()) {
                activate(user);
            } else {
                deactivate(user);
            }
        }
    }
}

// Indentation: 4 spaces
// Line length: 120 characters max
// Blank line between methods
// No blank line after opening brace or before closing brace
// One blank line between logical sections within a method
```

### 1.4 Import Conventions

```java
// Import order (separated by blank lines)
// 1. java.* (standard library)
import java.time.Instant;
import java.util.List;
import java.util.Optional;

// 2. javax.* / jakarta.*
import jakarta.validation.constraints.NotNull;

// 3. Third-party libraries
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

// 4. Project imports
import com.myapp.domain.User;
import com.myapp.repository.UserRepository;

// Never use wildcard imports
import java.util.*;     // Bad
```

### 1.5 Javadoc Conventions

```java
/**
 * Service for managing user lifecycle operations.
 *
 * <p>This service provides CRUD operations for users, including
 * validation, persistence, and event publishing.</p>
 *
 * @author Team Name
 * @since 1.0.0
 * @see UserRepository
 */
@Service
public class UserService {

    /**
     * Retrieves a user by their unique identifier.
     *
     * @param id the unique user ID; must be positive
     * @return an {@link Optional} containing the user, or empty if not found
     * @throws IllegalArgumentException if {@code id} is not positive
     *
     * @since 1.0.0
     */
    public Optional<User> getUserById(long id) {
        // ...
    }
}
```

## 2. Object-Oriented Design

- Follow **SOLID** principles rigorously.
- Favor **composition over inheritance**.
- Design classes to be **immutable** when possible.
- Make classes **`final`** if not designed for extension.

## 3. Modern Java Features (Java 17+)

```java
// Record
public record CreateUserRequest(String name, String email, int age) {}

// Sealed class
public sealed interface Shape permits Circle, Rectangle, Triangle {}
public record Circle(double radius) implements Shape {}
public record Rectangle(double width, double height) implements Shape {}

// Pattern matching switch
public double area(Shape shape) {
    return switch (shape) {
        case Circle c -> Math.PI * c.radius() * c.radius();
        case Rectangle r -> r.width() * r.height();
        case Triangle t -> 0.5 * t.base() * t.height();
    };
}
```

## 4. Collections & Streams

- Prefer **interface types** for declarations (`List`, `Map`, `Set`).
- Use **`List.of()`, `Map.of()`, `Set.of()`** for immutable collections.
- Use **Streams** for declarative transformations; avoid side effects.
- Don't overuse streams — simple `for` loops can be clearer for simple iterations.

```java
List<String> activeUserNames = users.stream()
    .filter(User::isActive)
    .map(User::getName)
    .sorted()
    .toList();
```

## 5. Null Safety

- Use **`Optional<T>`** for return types that may have no value.
- Never use `Optional` as a **field type** or **method parameter**.
- Use **`Objects.requireNonNull()`** for parameter validation.
- Return **empty collections** instead of `null`.

## 6. Exception Handling

- Use **checked exceptions** for recoverable conditions.
- Use **unchecked exceptions** for programming errors.
- Create **custom exception hierarchies**.
- Use **try-with-resources** for all `AutoCloseable` resources.

## 7. Concurrency

- Prefer **`ExecutorService`** and **`CompletableFuture`** over raw threads.
- Use **Virtual Threads** (Java 21+) for I/O-bound concurrency.
- Use **thread-safe collections** from `java.util.concurrent`.
- Minimize **shared mutable state**.

## 8. Logging

```java
// Parameterized logging
logger.info("User {} logged in from {}", userId, ipAddress);

// String concatenation (avoid)
logger.info("User " + userId + " logged in from " + ipAddress);
```

## 9. Build & Dependency Management

- Use **Maven** or **Gradle** consistently.
- Pin **dependency versions** explicitly.
- Keep dependencies **up to date**.

## 10. Testing

```java
@Test
void shouldReturnUser_whenIdIsValid() {
    // Given
    when(userRepository.findById(1L)).thenReturn(Optional.of(testUser));

    // When
    User result = userService.getUserById(1L);

    // Then
    assertThat(result)
        .isNotNull()
        .extracting(User::getName)
        .isEqualTo("John Doe");
}
```

## 11. Configuration & Profiles

- Use **Spring Profiles** (`@Profile`, `application-{profile}.yml`) for environment-specific settings.
- Use **`@ConfigurationProperties`** for type-safe configuration binding.
- Externalize all environment-specific values — never hardcode URLs, credentials, or feature flags.
- Validate configuration at startup with **`@Validated`** and Jakarta Bean Validation annotations.

```java
@Validated
@ConfigurationProperties(prefix = "app.smtp")
public record SmtpProperties(
    @NotBlank String host,
    @Min(1) @Max(65535) int port,
    @Email String fromAddress,
    boolean useSsl
) {}

// Usage
@Service
public class EmailService {
    private final SmtpProperties smtp;

    public EmailService(SmtpProperties smtp) {
        this.smtp = smtp;
    }
}
```

## 12. REST API Design

- Follow **RESTful naming conventions**: plural nouns for resources (`/users`, `/orders`).
- Use appropriate **HTTP methods**: `GET` (read), `POST` (create), `PUT` (full update), `PATCH` (partial update), `DELETE` (remove).
- Return proper **HTTP status codes**: `200`, `201`, `204`, `400`, `404`, `409`, `500`.
- Use **DTOs** (Data Transfer Objects) to decouple API contracts from domain models.
- Version APIs via **URL path** (`/api/v1/users`) or **header** (`Accept: application/vnd.myapp.v1+json`).
- Document APIs with **OpenAPI/Swagger** annotations.

```java
@RestController
@RequestMapping("/api/v1/users")
@Tag(name = "Users", description = "User management operations")
public class UserController {

    private final UserService userService;

    @GetMapping("/{id}")
    @Operation(summary = "Get user by ID")
    public ResponseEntity<UserDto> getById(@PathVariable long id) {
        return userService.findById(id)
            .map(ResponseEntity::ok)
            .orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public UserDto create(@Valid @RequestBody CreateUserRequest request) {
        return userService.create(request);
    }
}
```

---
