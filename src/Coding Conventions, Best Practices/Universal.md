# Universal Best Practices (All Languages)

---

## Table of Contents

1. [Coding Conventions -- General Principles](#coding-conventions--general-principles)
2. [Version Control](#version-control)
3. [Code Reviews](#code-reviews)
4. [Documentation](#documentation)
5. [CI/CD](#cicd)
6. [Security](#security)
7. [Universal File & Folder Conventions](#universal-file--folder-conventions)
8. [Universal Comment Tags](#universal-comment-tags)

---

## Coding Conventions -- General Principles

| Principle | Guideline |
|---|---|
| **Consistency** | Pick a style and enforce it everywhere -- inconsistency is worse than any "wrong" style |
| **Readability** | Code is read 10x more than it's written -- optimize for the reader |
| **Self-documenting** | Good names > comments; comments explain *why*, code shows *what* |
| **Single Responsibility** | Each function/class/module does one thing well |
| **DRY** | Don't Repeat Yourself -- but don't over-abstract prematurely |
| **KISS** | Keep It Simple -- prefer boring, obvious code over clever tricks |
| **YAGNI** | You Aren't Gonna Need It -- don't build features speculatively |
| **Fail fast** | Validate inputs early; surface errors immediately |
| **Least surprise** | Code should behave as readers expect |
| **Boy Scout Rule** | Leave code cleaner than you found it |

## Version Control

- Use **Git** with a branching strategy (**Git Flow**, **GitHub Flow**, or **Trunk-Based Development**).
- Write **meaningful commit messages** (conventional commits: `feat:`, `fix:`, `chore:`).
- Keep commits **atomic** -- one logical change per commit.
- Use **pull requests** with code reviews.
- Protect **main/production branches** with required reviews and CI checks.

## Code Reviews

- Review for **correctness**, **readability**, **security**, and **maintainability**.
- Be **constructive** and **kind** -- critique code, not people.
- Automate what you can (**linting**, **formatting**, **type checking**).
- Keep PRs **small** (under ~400 lines changed when possible).

## Documentation

- Write **self-documenting code** first -- clear names, simple logic.
- Document **why**, not **what**.
- Maintain **README** files with setup instructions and architecture overview.
- Use **ADRs** (Architecture Decision Records) for significant decisions.
- Keep documentation **close to code** and **up to date**.

## CI/CD

- Run **linting**, **type checking**, **tests**, and **security scans** on every push.
- Automate **deployment** to staging and production.
- Use **infrastructure as code** (Terraform, Pulumi, etc.).
- Implement **rollback mechanisms** for failed deployments.

## Security

- Follow the **OWASP Top 10** guidelines.
- Never commit **secrets or credentials** -- use environment variables or secret managers.
- Keep dependencies **updated** and scan for vulnerabilities.
- Validate and sanitize **all inputs**.
- Apply the **principle of least privilege** everywhere.

## Universal File & Folder Conventions

```
project-root/
├── .github/                  # CI/CD workflows
│   └── workflows/
├── .vscode/ or .idea/        # Editor config (optional, team-agreed)
├── docs/                     # Documentation, ADRs
├── scripts/                  # Build, deploy, utility scripts
├── src/                      # Source code
├── tests/                    # Test code
├── .editorconfig             # Cross-editor formatting
├── .gitignore
├── .prettierrc / .clang-format / rustfmt.toml  # Formatter config
├── eslintrc / .golangci.yml  # Linter config
├── README.md
├── LICENSE
├── CHANGELOG.md
└── Makefile / Taskfile.yml   # Task runner
```

## Universal Comment Tags

| Tag | Purpose | Example |
|---|---|---|
| `TODO` | Planned improvement | `// TODO: Add pagination support` |
| `FIXME` | Known bug | `// FIXME: Race condition on concurrent access` |
| `HACK` | Temporary workaround | `// HACK: Workaround for API bug #123` |
| `NOTE` | Important context | `// NOTE: Cache TTL is 5 minutes` |
| `WARNING` | Potential pitfall | `// WARNING: Not thread-safe` |
| `DEPRECATED` | Scheduled for removal | `// DEPRECATED: Use newMethod() instead` |
| `REVIEW` | Needs review | `// REVIEW: Is this the right approach?` |
| `PERF` | Performance concern | `// PERF: O(n^2) -- consider indexing` |

---
