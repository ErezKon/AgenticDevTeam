# C Best Practices, Guidelines & Conventions

---

## Table of Contents

1. [Coding Conventions](#1-coding-conventions)
   - [1.1 Naming Conventions](#11-naming-conventions)
   - [1.2 Header File Conventions](#12-header-file-conventions)
   - [1.3 Source File Conventions](#13-source-file-conventions)
   - [1.4 Formatting Conventions](#14-formatting-conventions)
   - [1.5 Comment Conventions](#15-comment-conventions)
2. [General Principles](#2-general-principles)
3. [Memory Management](#3-memory-management)
4. [Pointers](#4-pointers)
5. [Strings & Buffers](#5-strings--buffers)
6. [Error Handling](#6-error-handling)
7. [Preprocessor](#7-preprocessor)
8. [Concurrency](#8-concurrency)
9. [Testing](#9-testing)
10. [Build System & Tooling](#10-build-system--tooling)

---

## 1. Coding Conventions

### 1.1 Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Function | snake_case (verb-prefixed) | `user_create()`, `list_add()` |
| Module-scoped function | module prefix + snake_case | `user_get_by_id()` |
| Static (file-private) func | snake_case (no module prefix) | `validate_input()` |
| Variable | snake_case | `user_count`, `buffer_size` |
| Global variable (avoid) | `g_` prefix snake_case | `g_config`, `g_instance_count` |
| Constant / Macro | UPPER_SNAKE_CASE | `MAX_BUFFER_SIZE`, `PI` |
| Type (typedef) | PascalCase or `_t` suffix | `UserList` or `user_list_t` |
| Struct tag | snake_case | `struct user_data` |
| Enum type | PascalCase or `_e`/`_t` suffix | `UserStatus` or `user_status_e` |
| Enum value | MODULE_PREFIX_UPPER | `USER_STATUS_ACTIVE` |
| Header guard | `PROJECT_PATH_FILE_H` | `MYAPP_USER_SERVICE_H` |
| File name | snake_case | `user_service.c`, `user_service.h` |
| Test file | `test_` prefix or `_test` suffix | `test_user_service.c` |

### 1.2 Header File Conventions

```c
/* user.h -- Public API for user management */

#ifndef MYAPP_USER_H
#define MYAPP_USER_H

#ifdef __cplusplus
extern "C" {
#endif

/* ---- Includes ---- */
#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

/* ---- Constants ---- */
#define USER_NAME_MAX_LEN  128
#define USER_EMAIL_MAX_LEN 256

/* ---- Type Definitions ---- */
typedef struct user user_t;

typedef enum {
    USER_STATUS_ACTIVE   = 0,
    USER_STATUS_INACTIVE = 1,
    USER_STATUS_BANNED   = 2,
} user_status_e;

typedef enum {
    USER_OK             =  0,
    USER_ERR_NOMEM      = -1,
    USER_ERR_INVALID    = -2,
    USER_ERR_NOT_FOUND  = -3,
    USER_ERR_DUPLICATE  = -4,
} user_error_t;

/* ---- Public API ---- */

/**
 * Create a new user.
 *
 * @param name   User's display name (must not be NULL).
 * @param email  User's email address (must not be NULL).
 * @return Pointer to the new user, or NULL on allocation failure.
 *         Caller is responsible for calling user_destroy().
 */
user_t *user_create(const char *name, const char *email);

/**
 * Destroy a user and free associated resources.
 *
 * @param user  Pointer to the user to destroy. Safe to call with NULL.
 */
void user_destroy(user_t *user);

/** Get the user's name. Returns a pointer to internal storage. */
const char *user_get_name(const user_t *user);

/** Get the user's email. Returns a pointer to internal storage. */
const char *user_get_email(const user_t *user);

/** Set the user's status. Returns USER_OK on success. */
user_error_t user_set_status(user_t *user, user_status_e status);

#ifdef __cplusplus
}
#endif

#endif /* MYAPP_USER_H */
```

### 1.3 Source File Conventions

```c
/* user.c -- Implementation of user management */

/* ---- Includes ---- */
/* 1. Own header first */
#include "user.h"

/* 2. Standard library headers */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* 3. Third-party headers */
/* #include <jansson.h> */

/* 4. Project headers */
#include "logging.h"
#include "memory.h"

/* ---- Private Constants ---- */
static const size_t DEFAULT_CAPACITY = 16;

/* ---- Private Types ---- */
struct user {
    char name[USER_NAME_MAX_LEN];
    char email[USER_EMAIL_MAX_LEN];
    user_status_e status;
    uint64_t id;
};

/* ---- Private Function Declarations ---- */
static bool validate_name(const char *name);
static bool validate_email(const char *email);

/* ---- Public Function Implementations ---- */
user_t *user_create(const char *name, const char *email)
{
    if (name == NULL || email == NULL) {
        return NULL;
    }

    if (!validate_name(name) || !validate_email(email)) {
        return NULL;
    }

    user_t *user = calloc(1, sizeof(*user));
    if (user == NULL) {
        return NULL;
    }

    snprintf(user->name, sizeof(user->name), "%s", name);
    snprintf(user->email, sizeof(user->email), "%s", email);
    user->status = USER_STATUS_ACTIVE;

    return user;
}

void user_destroy(user_t *user)
{
    free(user);  /* free(NULL) is safe per C standard */
}

const char *user_get_name(const user_t *user)
{
    return (user != NULL) ? user->name : "";
}

/* ---- Private Function Implementations ---- */
static bool validate_name(const char *name)
{
    size_t len = strlen(name);
    return (len > 0 && len < USER_NAME_MAX_LEN);
}

static bool validate_email(const char *email)
{
    return (strchr(email, '@') != NULL);
}
```

### 1.4 Formatting Conventions

```c
/* Braces: Allman or K&R -- pick one and be consistent */

/* K&R (Linux Kernel style) -- functions get braces on new line */
static int
process_item(const item_t *item)
{
    if (item == NULL) {
        return -1;
    }

    for (size_t i = 0; i < item->count; i++) {
        if (item->values[i] > THRESHOLD) {
            handle_overflow(item, i);
        } else {
            accumulate(item->values[i]);
        }
    }

    return 0;
}

/* Formatting rules:
 * - Indentation: 4 spaces (or tabs for Linux Kernel style)
 * - Line length: 80 characters (strict in many C projects)
 * - Space after keywords: if (, for (, while (, switch (
 * - No space after function name: func(args)
 * - One space around binary operators: a + b, x = y
 * - No space for unary: !flag, *ptr, &var, ++i
 * - Blank line between function definitions
 * - Align related declarations for readability
 */

/* Aligned declarations */
int         result     = 0;
size_t      count      = 0;
const char *name       = NULL;
user_t     *current    = NULL;
```

### 1.5 Comment Conventions

```c
/*
 * Multi-line block comment for file headers,
 * complex explanations, or function documentation.
 *
 * Follows the C89-compatible comment style.
 */

/* Single-line block comment for brief notes */

// C99+ single-line comment (also widely accepted)

/**
 * Doxygen-style documentation comment.
 *
 * @brief  Create a new user from the given parameters.
 * @param  name   The user's display name (non-NULL, non-empty).
 * @param  email  The user's email address (non-NULL, must contain '@').
 * @return Pointer to new user on success, NULL on failure.
 * @note   Caller must call user_destroy() to free the returned user.
 * @see    user_destroy
 */

/* TODO(username): Add input sanitization before v2.0 */
/* FIXME: Memory leak in error path when realloc fails */
/* HACK: Workaround for kernel bug #12345 */
/* WARNING: Not thread-safe -- caller must hold the mutex */
```

## 2. General Principles

- Follow a consistent style guide: **Linux Kernel Style**, **GNU**, or **MISRA C**.
- Compile with **maximum warnings**: `-Wall -Wextra -Wpedantic -Werror`.
- Target a specific **standard**: C11, C17, or C23.
- Use **static analysis tools**: `cppcheck`, `Clang Static Analyzer`.

## 3. Memory Management

- **Every `malloc` must have a matching `free`.**
- Always check the **return value** of allocation functions.
- Set pointers to **`NULL`** after freeing.
- Use **Valgrind** or **AddressSanitizer** to detect leaks.

```c
char *buffer = malloc(BUFFER_SIZE);
if (buffer == NULL) {
    fprintf(stderr, "Memory allocation failed\n");
    return ERROR_NOMEM;
}

/* ... use buffer ... */

free(buffer);
buffer = NULL;
```

## 4. Pointers

- Always **initialize** pointers.
- Validate pointers **before dereferencing**.
- Use **`const`** to indicate non-modifiable data.
- Prefer **`size_t`** for sizes and indices.

## 5. Strings & Buffers

- Always ensure **null termination**.
- Use **`snprintf`** instead of `sprintf`.
- Always specify **buffer sizes** explicitly.

## 6. Error Handling

```c
error_t process_file(const char *path)
{
    FILE *file = NULL;
    char *buffer = NULL;
    error_t result = ERR_OK;

    file = fopen(path, "r");
    if (file == NULL) {
        result = ERR_IO;
        goto cleanup;
    }

    buffer = malloc(BUFFER_SIZE);
    if (buffer == NULL) {
        result = ERR_NOMEM;
        goto cleanup;
    }

    /* Process file... */

cleanup:
    free(buffer);
    if (file != NULL) {
        fclose(file);
    }
    return result;
}
```

## 7. Preprocessor

- Minimize **macro usage**; prefer `const`, `enum`, and `inline`.
- Wrap macro parameters in **parentheses**.
- Use **`_Static_assert`** (C11) for compile-time checks.

## 8. Concurrency

- Protect shared data with **mutexes**.
- Minimize **critical section** size.
- Use **`_Atomic`** types (C11) for simple shared counters/flags.

## 9. Testing

- Use **Unity**, **Check**, **CMocka**, or **CUnit**.
- Test **edge cases**: null pointers, empty inputs, boundary values, overflow.
- Use **sanitizers** in CI: ASan, UBSan, TSan.
- Use **fuzzing** for input-heavy code.

## 10. Build System & Tooling

- Use **CMake** (de facto standard) or **Meson** for cross-platform builds.
- Use **`compile_commands.json`** for IDE integration and static analysis tools.
- Organize build targets logically: **libraries**, **executables**, **tests**.
- Use **`pkg-config`** or CMake's **`find_package()`** for dependency management.
- Run **sanitizers** (ASan, UBSan, TSan, MSan) in CI builds.

```cmake
# CMakeLists.txt -- minimal example
cmake_minimum_required(VERSION 3.20)
project(myapp C)

set(CMAKE_C_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Compiler warnings
add_compile_options(-Wall -Wextra -Wpedantic -Werror)

# Main library
add_library(myapp_lib
    src/user.c
    src/logging.c
)
target_include_directories(myapp_lib PUBLIC include)

# Executable
add_executable(myapp src/main.c)
target_link_libraries(myapp PRIVATE myapp_lib)

# Tests
enable_testing()
add_executable(test_user tests/test_user.c)
target_link_libraries(test_user PRIVATE myapp_lib)
add_test(NAME test_user COMMAND test_user)

# Sanitizer build type
option(ENABLE_SANITIZERS "Enable ASan and UBSan" OFF)
if(ENABLE_SANITIZERS)
    add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
    add_link_options(-fsanitize=address,undefined)
endif()
```

---
