# C++ Best Practices, Guidelines & Conventions

---

## Table of Contents

1. [Coding Conventions](#1-coding-conventions)
   - [1.1 Naming Conventions](#11-naming-conventions)
   - [1.2 Header File Conventions](#12-header-file-conventions)
   - [1.3 Source File Conventions](#13-source-file-conventions)
   - [1.4 Formatting Conventions](#14-formatting-conventions)
   - [1.5 Documentation Conventions](#15-documentation-conventions)
2. [General Principles](#2-general-principles)
3. [Memory Management & RAII](#3-memory-management--raii)
4. [Modern C++ Features (C++17 / C++20)](#4-modern-c-features-c17--c20)
5. [Const Correctness](#5-const-correctness)
6. [Containers & Algorithms](#6-containers--algorithms)
7. [Error Handling](#7-error-handling)
8. [Concurrency](#8-concurrency)
9. [Build System](#9-build-system)
10. [Testing](#10-testing)
11. [Linting & Static Analysis](#11-linting--static-analysis)

---

## 1. Coding Conventions

### 1.1 Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Namespace | lowercase (or snake_case) | `my_app::network` |
| Class / Struct | PascalCase | `UserService`, `HttpClient` |
| Abstract class | PascalCase (often `I` prefix or `Base`) | `IRenderer`, `BaseWidget` |
| Method (public) | PascalCase or camelCase | `GetUser()` or `getUser()` |
| Method (private) | Same as public (consistent) | `validateInput()` |
| Member variable | `_camelCase` or `camelCase_` or `m_camelCase` | `name_`, `m_count` |
| Local variable | camelCase or snake_case | `userCount`, `user_count` |
| Function (free) | PascalCase or camelCase | `CalculateArea()` |
| Constant (constexpr) | `k` + PascalCase or UPPER_SNAKE | `kMaxSize`, `MAX_SIZE` |
| Enum class type | PascalCase | `UserStatus` |
| Enum class member | PascalCase | `UserStatus::Active` |
| Template parameter | PascalCase | `typename ValueType` |
| Concept | PascalCase (adjective) | `Printable`, `Hashable` |
| Macro (avoid) | UPPER_SNAKE_CASE | `DEBUG_LOG(...)` |
| File name | snake_case or PascalCase | `user_service.cpp` / `UserService.cpp` |
| Header file | `.h`, `.hpp`, or `.hxx` | `user_service.hpp` |
| Test file | `_test` suffix | `user_service_test.cpp` |
| Header guard | `PROJECT_PATH_FILE_HPP_` | `MYAPP_USER_SERVICE_HPP_` |

### 1.2 Header File Conventions

```cpp
// user_service.hpp
#pragma once  // Or use traditional include guards

// ---- Includes (ordered) ----
// 1. C++ standard library
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

// 2. Third-party libraries
#include <spdlog/spdlog.h>

// 3. Project headers
#include "myapp/user/model.hpp"
#include "myapp/user/repository.hpp"

namespace myapp::user {

// ---- Forward Declarations ----
class EventPublisher;

// ---- Constants ----
inline constexpr int kMaxUsersPerPage = 100;
inline constexpr std::string_view kDefaultRole = "user";

// ---- Type Aliases ----
using UserId = std::string;
using UserList = std::vector<User>;

// ---- Enums ----
enum class UserStatus {
    Active,
    Inactive,
    Suspended,
};

// ---- Class Declarations ----

/// @brief Service for managing user lifecycle operations.
///
/// This class coordinates between the repository layer and
/// the event publisher for domain events.
class UserService final {
public:
    // -- Types --
    struct Config {
        int maxRetries = 3;
        std::chrono::seconds timeout{30};
    };

    // -- Constructors & Destructor --
    explicit UserService(
        std::unique_ptr<IUserRepository> repository,
        std::shared_ptr<spdlog::logger> logger,
        Config config = {}
    );

    ~UserService() = default;

    // Rule of Five: non-copyable, movable
    UserService(const UserService&) = delete;
    UserService& operator=(const UserService&) = delete;
    UserService(UserService&&) noexcept = default;
    UserService& operator=(UserService&&) noexcept = default;

    // -- Public Interface --

    /// @brief Retrieve a user by their unique identifier.
    /// @param id The user's unique ID.
    /// @return The user if found, or std::nullopt.
    [[nodiscard]] std::optional<User> findById(std::string_view id) const;

    /// @brief Create a new user.
    /// @param request The creation parameters.
    /// @return The created user.
    /// @throws ValidationException if the request is invalid.
    [[nodiscard]] User create(const CreateUserRequest& request);

    /// @brief Get the total number of operations performed.
    [[nodiscard]] int operationCount() const noexcept;

private:
    // -- Private Methods --
    void validateRequest(const CreateUserRequest& request) const;
    void incrementCounter() noexcept;

    // -- Data Members --
    std::unique_ptr<IUserRepository> repository_;
    std::shared_ptr<spdlog::logger> logger_;
    Config config_;
    int operationCount_ = 0;
};

}  // namespace myapp::user
```

### 1.3 Source File Conventions

```cpp
// user_service.cpp

// 1. Corresponding header first (catches missing includes)
#include "myapp/user/user_service.hpp"

// 2. C++ standard library
#include <algorithm>
#include <format>
#include <stdexcept>

// 3. Third-party
#include <spdlog/spdlog.h>

// 4. Project headers
#include "myapp/common/validation.hpp"

namespace myapp::user {

// ---- Unnamed Namespace for File-Private Helpers ----
namespace {

bool isValidEmail(std::string_view email) {
    return email.find('@') != std::string_view::npos;
}

}  // namespace

// ---- Constructor ----
UserService::UserService(
    std::unique_ptr<IUserRepository> repository,
    std::shared_ptr<spdlog::logger> logger,
    Config config
)
    : repository_(std::move(repository))
    , logger_(std::move(logger))
    , config_(std::move(config))
{
    if (!repository_) {
        throw std::invalid_argument("repository must not be null");
    }
}

// ---- Public Methods ----
std::optional<User> UserService::findById(std::string_view id) const {
    logger_->info("Finding user by ID: {}", id);
    return repository_->findById(id);
}

User UserService::create(const CreateUserRequest& request) {
    validateRequest(request);
    auto user = repository_->save(request);
    incrementCounter();
    logger_->info("Created user: {}", user.id());
    return user;
}

int UserService::operationCount() const noexcept {
    return operationCount_;
}

// ---- Private Methods ----
void UserService::validateRequest(const CreateUserRequest& request) const {
    if (request.name.empty()) {
        throw ValidationException("Name must not be empty");
    }
    if (!isValidEmail(request.email)) {
        throw ValidationException(
            std::format("Invalid email: {}", request.email)
        );
    }
}

void UserService::incrementCounter() noexcept {
    ++operationCount_;
}

}  // namespace myapp::user
```

### 1.4 Formatting Conventions

```cpp
// Braces: K&R for control structures, optionally Allman for functions
// (Follow your team/project style -- consistency is key)

// K&R style (Google, LLVM):
void process(const std::vector<int>& items) {
    if (items.empty()) {
        return;
    }

    for (const auto& item : items) {
        if (item > threshold) {
            handleOverflow(item);
        } else {
            accumulate(item);
        }
    }
}

// Indentation: 2 spaces (Google) or 4 spaces (LLVM, many teams)
// Line length: 80 (Google) or 120 characters
// Namespace contents not indented (Google style)
namespace myapp {

class Foo {    // No extra indentation for namespace
    // ...
};

}  // namespace myapp

// Pointer/reference binding: attach to type or name -- be consistent
int* ptr;      // Type-attached (Google style)
int *ptr;      // Name-attached (Linux/C style)
int& ref;      // Type-attached
const auto& x = getSomething();

// Constructor initializer lists
UserService::UserService(
    std::unique_ptr<IRepo> repo,
    std::shared_ptr<Logger> logger
)
    : repository_(std::move(repo))
    , logger_(std::move(logger))
    , count_(0)
{}

// Use [[nodiscard]] for functions whose return value should not be ignored
[[nodiscard]] bool isEmpty() const noexcept;

// Use auto judiciously
auto it = container.find(key);          // Type is obvious from context
auto user = std::make_unique<User>();   // RHS makes type clear
auto result = process();                // What type is result? Annotate if unclear
```

### 1.5 Documentation Conventions

```cpp
/// @file user_service.hpp
/// @brief Service layer for user management operations.
/// @author Team Name
/// @date 2024-01-01

/// @class UserService
/// @brief Manages user CRUD operations and lifecycle events.
///
/// @details This service provides a high-level API for user management,
/// coordinating between the repository layer and event publishing.
///
/// Example usage:
/// @code
/// auto repo = std::make_unique<PostgresUserRepo>(db);
/// auto logger = spdlog::default_logger();
/// UserService service(std::move(repo), logger);
///
/// auto user = service.findById("abc-123");
/// if (user) {
///     std::cout << user->name() << "\n";
/// }
/// @endcode
///
/// @note This class is not thread-safe. External synchronization is
///       required for concurrent access.
/// @see IUserRepository

/// @brief Retrieve a user by their unique identifier.
/// @param[in] id The unique user ID (must not be empty).
/// @return The user if found, or std::nullopt if no user matches.
/// @throws std::invalid_argument If id is empty.
/// @pre id must be a valid non-empty string.
/// @post If returned optional has value, the user's id matches the input.
///
/// @par Complexity
/// O(1) amortized for cached lookups, O(log n) for database queries.
[[nodiscard]] std::optional<User> findById(std::string_view id) const;

// TODO(username): Implement batch deletion for admin operations
// FIXME: Memory leak in error recovery path (see issue #456)
// HACK: Workaround for compiler bug in MSVC 19.35 -- remove after upgrade
// NOTE: This function is intentionally not noexcept due to logging
```

## 2. General Principles

- Follow the **C++ Core Guidelines**.
- Use **modern C++** (C++17 or C++20 minimum).
- **RAII** is fundamental -- always.
- Prefer **compile-time safety** over runtime checks.
- Apply the **Rule of Zero**.

## 3. Memory Management & RAII

```cpp
// Modern C++
auto user = std::make_unique<User>("John", "john@example.com");

// Stack allocation preferred
std::vector<int> numbers = {1, 2, 3, 4, 5};
std::string name = "John";

// Never in application code
User* user = new User("John", "john@example.com");
delete user;
```

## 4. Modern C++ Features (C++17 / C++20)

```cpp
// Structured bindings (C++17)
auto [name, age, email] = getUserTuple();

// std::optional (C++17)
std::optional<User> findUser(int id);

// Concepts (C++20)
template <typename T>
concept Printable = requires(T t) {
    { std::cout << t } -> std::same_as<std::ostream&>;
};

// Ranges (C++20)
auto activeNames = users
    | std::views::filter([](const User& u) { return u.isActive; })
    | std::views::transform(&User::name);

// std::format (C++20)
auto msg = std::format("User {} has {} items", user.name, count);
```

## 5. Const Correctness

```cpp
class Circle {
    double radius_;

public:
    explicit constexpr Circle(double r) : radius_(r) {}

    [[nodiscard]] constexpr double area() const noexcept {
        return std::numbers::pi * radius_ * radius_;
    }

    [[nodiscard]] constexpr double radius() const noexcept {
        return radius_;
    }
};
```

## 6. Containers & Algorithms

| Need | Container |
|---|---|
| Dynamic array | `std::vector` (default choice) |
| Key-value lookup | `std::unordered_map` |
| Ordered key-value | `std::map` |
| Unique set | `std::unordered_set` / `std::set` |
| Fixed-size array | `std::array` |
| String | `std::string` / `std::string_view` |

## 7. Error Handling

- Use **exceptions** for errors that cannot be handled locally.
- Mark functions **`noexcept`** when they don't throw.
- Use **`std::optional`** for "no value" cases.
- Never throw in **destructors**.
- Catch exceptions by **`const` reference**.

## 8. Concurrency

```cpp
// scoped_lock for multiple mutexes (deadlock-free)
std::scoped_lock lock(mutex1, mutex2);

// jthread with stop token (C++20)
std::jthread worker([](std::stop_token st) {
    while (!st.stop_requested()) {
        // do work
    }
});
```

## 9. Build System

- Use **CMake** as the standard build system.
- Use **package managers**: **vcpkg**, **Conan**, or **CPM.cmake**.
- Enable **sanitizers** in debug/CI builds.

## 10. Testing

```cpp
TEST(UserServiceTest, FindsExistingUser) {
    // Arrange
    auto mockRepo = std::make_unique<MockUserRepository>();
    EXPECT_CALL(*mockRepo, findById(42))
        .WillOnce(Return(User{42, "John"}));

    UserService service(std::move(mockRepo));

    // Act
    auto result = service.getUser(42);

    // Assert
    ASSERT_TRUE(result.has_value());
    EXPECT_EQ(result->name, "John");
}
```

## 11. Linting & Static Analysis

| Tool | Purpose |
|---|---|
| **clang-tidy** | Comprehensive C++ linter with auto-fix capabilities |
| **cppcheck** | Static analysis for bugs, undefined behavior, and style |
| **Clang Static Analyzer** | Deep path-sensitive analysis |
| **PVS-Studio** | Commercial static analyzer with strong C++ support |
| **SonarQube** | Continuous code quality platform |
| **include-what-you-use (IWYU)** | Optimizes `#include` directives |

```yaml
# .clang-tidy -- example configuration
Checks: >
  -*,
  bugprone-*,
  cert-*,
  cppcoreguidelines-*,
  google-*,
  misc-*,
  modernize-*,
  performance-*,
  readability-*,
  -modernize-use-trailing-return-type,
  -readability-identifier-length

WarningsAsErrors: ''
HeaderFilterRegex: 'src/.*'

CheckOptions:
  - key: readability-identifier-naming.ClassCase
    value: CamelCase
  - key: readability-identifier-naming.FunctionCase
    value: camelBack
  - key: readability-identifier-naming.VariableCase
    value: camelBack
  - key: readability-identifier-naming.PrivateMemberSuffix
    value: '_'
```

- Run **`clang-tidy`** in CI with `--warnings-as-errors=*` for strict enforcement.
- Use **`cppcheck --enable=all --suppress=missingIncludeSystem`** for supplemental checks.
- Enable **compiler warnings**: `-Wall -Wextra -Wpedantic -Werror` (GCC/Clang) or `/W4 /WX` (MSVC).
- Use **sanitizers** in debug/CI builds: `-fsanitize=address,undefined,thread`.
- Generate **`compile_commands.json`** via CMake for tooling integration.

---
