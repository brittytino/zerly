# Contributing to Zerly AI

Thank you for your interest in contributing! This document covers everything you need to get the project running locally and submit a good pull request.

---

## Prerequisites

- **Node.js** 18 or later
- **npm** 9 or later
- **VS Code** (to run the extension in development)
- **Git**

---

## Setup

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/brittytino/zerly.git
cd zerly

# 2. Install all dependencies
npm install

# 3. Build the extension and webview bundles
npm run build:all

# 4. Run the test suite to confirm everything works
npm test
```

---

## Running the Extension Locally

1. Open the `zerly` folder in VS Code
2. Press **F5** (or go to **Run → Start Debugging**)
3. A new **Extension Development Host** window opens with Zerly loaded
4. Make changes in `src/` or `webview/`, then press **Ctrl+Shift+F5** to rebuild and reload

> The webview is bundled separately. If you modify files under `webview/`, run `npm run build:all` again before reloading.

---

## Project Scripts

| Script | What it does |
|---|---|
| `npm run build:all` | Build extension + webview (production) |
| `npm run build` | Build extension only |
| `npm run build:webview` | Build webview only |
| `npm run watch` | Rebuild extension on file changes |
| `npm test` | Run all Jest tests |

---

## Testing

Tests live in `src/test/`. Run them with:

```bash
npm test
```

Expected output: **5 test suites, 61 tests, all passing.**

When adding a feature or fixing a bug, add or update relevant tests. Do not submit PRs that break the existing test suite.

---

## Backend (Optional)

The `backend/` directory is a self-hosted Express + Prisma server for account auth and usage tracking. You only need it if your change touches auth/billing flows.

```bash
cd backend
npm install
npx prisma migrate dev
npm run dev
```

Set the required environment variables on your server or deployment platform (database URL, GitHub OAuth, Stripe keys). No env files are committed to this repo — do not create `.env` files and commit them.

The extension talks to the backend via `ZERLY_BACKEND_URL` (defaults to `https://zerly.tinobritty.me`).

---

## Pull Request Guidelines

1. **Branch naming:** `feat/short-description`, `fix/short-description`, `docs/short-description`
2. **Keep PRs focused** — one feature or fix per PR
3. **Tests first** — confirm `npm test` passes before submitting
4. **No secrets** — never commit real API keys, credentials, or `.env` files
5. **Describe your change** in the PR description: what, why, and how to test it

---

## Reporting Bugs

Use the [Bug Report template](https://github.com/brittytino/zerly/issues/new?template=bug_report.md).

Include:
- Clear steps to reproduce
- Expected vs. actual behavior
- Your VS Code version and OS
- Any error messages from the Output panel (Zerly channel)

---

## Requesting Features

Use the [Feature Request template](https://github.com/brittytino/zerly/issues/new?template=feature_request.md).

---

## Code Style

- TypeScript throughout — no untyped `any` without a comment explaining why
- No console.log in production code — use the VS Code output channel
- Keep functions small and focused
- Follow the existing module pattern — each capability in its own file under `src/`

---

## Author

Zerly AI is created and maintained by [Tino Britty](https://github.com/brittytino).
