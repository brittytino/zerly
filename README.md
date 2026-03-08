# Zerly AI — VS Code Extension

> **"Understand your code. Not just generate it."**

Zerly AI is an open-source developer intelligence assistant for VS Code. It helps you understand codebases, visualize architecture, detect risks, explain selected code, and navigate unfamiliar projects — powered by [Zerlino](https://zerly.tinobritty.me), a purpose-built AI model.

**Developer:** [Tino Britty](https://github.com/brittytino)  
**License:** MIT — free to fork, use, and build on  
**Issues / Feature requests:** [Open an issue](https://github.com/brittytino/zerly/issues)

---

## Features

| Feature | Description |
|---|---|
| **Project Intelligence Scan** | Scans your entire codebase — files, imports, dependencies, frameworks |
| **Architecture Map** | Visual dependency graph with Mermaid diagrams |
| **Feature Flow Explorer** | Trace call chains for any feature or function |
| **Risk Scanner** | Find complex, fragile, or over-coupled modules — 100% local |
| **Explain Code** | Select any code in the editor → instant AI explanation |
| **Learning Mode** | Guided reading roadmap for navigating unfamiliar projects |
| **Chat** | Ask anything about your codebase |

---

## Getting Started

1. Install from the VS Code Marketplace (search **Zerly AI**)
2. Open any project in VS Code
3. Click the **Zerly AI** icon in the Activity Bar
4. Click **Connect Zerly** to activate AI features (free account)

> **No API key required to get started.** Static features (Architecture Map, Risk Scanner, Feature Flow) work 100% locally with no account needed.

---

## BYOK — Bring Your Own Key

Zerly supports your own API keys for OpenAI, Anthropic, and Google Gemini:

1. Open the Command Palette → **Zerly: Setup AI Providers**
2. Select the provider and paste your API key
3. Choose your routing mode: **Zerly default**, **Provider override**, or **Auto fallback**

All keys are stored in VS Code's built-in **SecretStorage** (OS keychain-backed) — never written to disk in plaintext, never logged, never sent to third parties.

---

## Commands

| Command | Description |
|---|---|
| `Zerly: Analyze Project` | Scan and summarize the codebase |
| `Zerly: Architecture Map` | Generate dependency graph |
| `Zerly: Feature Flow Explorer` | Trace a feature call chain |
| `Zerly: Risk Scanner` | Find fragile/complex modules |
| `Zerly: Explain Code` | Explain selected code (requires editor selection) |
| `Zerly: Learning Mode` | Generate a guided learning roadmap |
| `Zerly: Chat with Zerly` | Ask anything about the codebase |
| `Zerly: Connect Zerly Account` | Open browser to connect your Zerly account |
| `Zerly: Setup AI Providers` | Configure BYOK keys (OpenAI / Anthropic / Gemini) |
| `Zerly: Paste Zerly API Key` | Paste an API key directly |
| `Zerly: Reset Session and Cache` | Clear all caches and optionally sign out |
| `Zerly: Open Connection Diagnostics` | View key status and recent request logs |

---

## Supported Editors

| Editor | Status |
|---|---|
| VS Code | ✅ Primary |
| VSCodium | ✅ Compatible |
| Cursor AI | ✅ Compatible |
| Windsurf | ✅ Compatible |

---

## Privacy & Security

- All API keys stored in VS Code **SecretStorage** (OS keychain) — never plaintext on disk
- No keys are ever logged or included in telemetry
- Static analysis (scan, architecture, risk) runs **100% locally** — no data leaves your machine
- All AI requests carry cache-busting headers

---

## Project Structure

```
zerly/
├── src/                        # Extension TypeScript source
│   ├── extension.ts            # Activation, command wiring
│   ├── aiService.ts            # Prompt building + AI orchestration
│   ├── requestRouter.ts        # Multi-provider HTTP routing
│   ├── providerKeyManager.ts   # BYOK key storage (SecretStorage)
│   ├── zerlyKeyManager.ts      # Zerly account key lifecycle
│   ├── authManager.ts          # GitHub OAuth + deep-link handler
│   ├── sidebarProvider.ts      # Webview bridge
│   ├── scanner.ts              # Codebase file scanner
│   ├── dependencyGraph.ts      # Dependency graph builder
│   ├── riskAnalyzer.ts         # Risk detection heuristics
│   ├── flowAnalyzer.ts         # Feature flow tracer
│   └── test/                   # Jest unit + integration tests (61 tests)
├── webview/                    # React UI (rendered in sidebar panel)
│   ├── App.tsx
│   ├── views/                  # Home, Analyze, Architecture, Risk…
│   └── components/
├── backend/                    # Optional self-hosted auth/billing API
│   ├── src/                    # Express + Prisma server
├── assets/                     # Icons and SVGs
├── esbuild.config.js           # Extension bundler config
├── esbuild.webview.config.js   # Webview bundler config
└── package.json
```

---

## Local Development

```bash
# 1. Clone the repo
git clone https://github.com/brittytino/zerly.git
cd zerly

# 2. Install dependencies
npm install

# 3. Build extension + webview
npm run build:all

# 4. Run tests
npm test

# 5. Press F5 in VS Code to launch the Extension Development Host
```

### Backend (optional)

The `backend/` directory is a self-hosted Express + Prisma server used for optional account authentication and usage tracking. You only need this if you want to run your own auth/billing stack.

```bash
cd backend
npm install
npx prisma migrate dev
npm run dev
```

Configure the backend via environment variables on your server or deployment platform (database URL, GitHub OAuth, Stripe keys). No env files are committed to this repo.

---

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

- **Bug reports / feature requests:** [Open an issue](https://github.com/brittytino/zerly/issues)
- **Pull requests:** Fork the repo, make your changes on a feature branch, then submit a PR against `main`

---

## License

GPL-3.0-only — see [LICENSE](LICENSE)

This is copyleft software: any derivative work must also be released under the GPL-3.0.

Made with ❤️ by [Tino Britty](https://github.com/brittytino)

