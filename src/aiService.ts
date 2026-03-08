import * as vscode from 'vscode';
import { ScanResult } from './scanner';
import { ZerlyKeyManager, zerlyLog, generateRequestId } from './zerlyKeyManager';
import { ProviderKeyManager } from './providerKeyManager';
import { RequestRouter, RouterMessage } from './requestRouter';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ZerlyMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type TaskType =
  | 'code_explanation'
  | 'architecture_analysis'
  | 'feature_flow'
  | 'risk_analysis'
  | 'developer_chat'
  | 'quick_summary'
  | 'learning_roadmap';

// ─── AI Service ──────────────────────────────────────────────────────────────

export class AIService {
  private _extensionPath: string = '';
  private _keyManager: ZerlyKeyManager | null = null;
  private _providerManager: ProviderKeyManager | null = null;
  private _requestRouter: RequestRouter | null = null;

  setExtensionPath(extPath: string) {
    this._extensionPath = extPath;
  }

  /** Wire ZerlyKeyManager — key changes abort all in-flight requests. */
  setKeyManager(km: ZerlyKeyManager): void {
    this._keyManager = km;
    km.onKeyChanged.event(() => {
      zerlyLog('key-changed-cache-cleared', 'Key changed — aborting all in-flight AI requests');
      this.invalidateAll();
    });
  }

  /** Wire ProviderKeyManager — config changes abort all in-flight requests. */
  setProviderManager(pm: ProviderKeyManager): void {
    this._providerManager = pm;
    pm.onConfigChanged.event(() => {
      zerlyLog('provider-config-cache-cleared', 'Provider config changed — aborting in-flight requests');
      this.invalidateAll();
    });
  }

  /** Wire the RequestRouter that handles provider-specific HTTP calls. */
  setRequestRouter(r: RequestRouter): void {
    this._requestRouter = r;
  }

  /** Abort every in-flight request immediately (called on key / config rotation). */
  invalidateAll(): void {
    for (const controller of this._taskControllers.values()) {
      controller.abort();
    }
    this._taskControllers.clear();
  }

  /** Number of task slots currently tracking an AbortController. */
  getInflightCount(): number {
    return this._taskControllers.size;
  }

  /** Last request metadata, for diagnostics. */
  getLastRequestInfo(): { requestId: string; status?: number; ts: number; routeUsed?: string; modelUsed?: string } | null {
    return this._lastRequestInfo;
  }

  /** Synchronous Zerly key accessor (for sidebar getApiStatus, backward compat). */
  getApiKey(): string {
    return this._keyManager?.getCachedKey() ?? '';
  }

  // ── Request management ──

  /** Tracks one AbortController per task type so new requests cancel stale ones. */
  private readonly _taskControllers = new Map<string, AbortController>();

  /** Updated after every completed request — feeds into diagnostics. */
  private _lastRequestInfo: {
    requestId: string; status?: number; ts: number;
    routeUsed?: string; modelUsed?: string;
  } | null = null;

  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Core API call ──

  /**
   * Routes a chat-completion request through RequestRouter.
   *
   * Invariants:
   *  - taskKey: cancels any previous request for the same task.
   *  - capturedKeyVersion + capturedConfigVersion: stale responses after key/
   *    provider-config rotation are discarded before surfacing to the UI.
   *  - Retries up to 2x with 1 s / 2 s exponential back-off on 5xx / network errors.
   *  - 401 / 403 / 429 are not retried; 401/403 prompt reconnect in the UI.
   *  - Raw API keys are NEVER written to any log.
   */
  private async _call(
    messages: ZerlyMessage[],
    maxTokens: number = 2048,
    taskKey?: string
  ): Promise<string> {
    if (!this._requestRouter) {
      return '⚠️ Request router not initialised. Please reload VS Code.';
    }

    // Guard: ensure we have at least one usable key before going to the network.
    const config = this._providerManager?.getConfig();
    const routeMode = config?.routeMode ?? 'zerly_default';
    const zerlyKey = this._keyManager?.getCachedKey() ?? '';
    const provider = config?.activeProvider ?? 'openai';
    const providerKey = this._providerManager?.getCachedKey(provider) ?? '';

    if (routeMode === 'zerly_default' && !zerlyKey) {
      return '⚠️ Connect your Zerly account to activate AI features.';
    }
    if (routeMode === 'provider_override' && !providerKey) {
      return `⚠️ No API key configured for ${provider}. Add it via "Zerly: Setup AI Providers".`;
    }
    if (routeMode === 'auto_fallback' && !providerKey && !zerlyKey) {
      return '⚠️ No API keys configured. Connect Zerly or add a provider key.';
    }

    const capturedKeyVersion = this._keyManager?.keyVersion ?? 0;
    const capturedConfigVersion = this._providerManager?.configVersion ?? 0;
    const requestId = generateRequestId();

    zerlyLog('request-start', `Task: ${taskKey ?? 'ad-hoc'} mode: ${routeMode} keyVersion: ${capturedKeyVersion}`, {
      requestId,
      meta: { taskKey: taskKey ?? 'ad-hoc', keyVersion: capturedKeyVersion, configVersion: capturedConfigVersion, routeMode },
    });

    // Cancel the stale request for the same task and register this one.
    if (taskKey) {
      this._taskControllers.get(taskKey)?.abort();
      this._taskControllers.set(taskKey, new AbortController());
    }
    const taskSignal = taskKey ? this._taskControllers.get(taskKey)!.signal : null;

    const TIMEOUT_MS = 30_000;
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (taskSignal?.aborted) {
        zerlyLog('ignored-stale-response', 'Task superseded — cancelled before attempt', { requestId });
        return '⚠️ Request was cancelled.';
      }

      if (attempt > 0) {
        await this._sleep(1_000 * attempt);
        if (taskSignal?.aborted) return '⚠️ Request was cancelled.';
      }

      const attemptController = new AbortController();
      const timeoutId = setTimeout(() => attemptController.abort(), TIMEOUT_MS);

      let onTaskAbort: (() => void) | null = null;
      if (taskSignal) {
        onTaskAbort = () => attemptController.abort();
        taskSignal.addEventListener('abort', onTaskAbort, { once: true });
      }

      const cleanup = () => {
        clearTimeout(timeoutId);
        if (taskSignal && onTaskAbort) {
          taskSignal.removeEventListener('abort', onTaskAbort);
        }
      };

      try {
        const result = await this._requestRouter.execute({
          messages: messages as RouterMessage[],
          maxTokens,
          requestId,
          signal: attemptController.signal,
        });

        cleanup();

        // Stale-response gate — discard if key or provider config changed mid-flight.
        const keyRotated = this._keyManager && this._keyManager.keyVersion !== capturedKeyVersion;
        const cfgChanged = this._providerManager && this._providerManager.configVersion !== capturedConfigVersion;
        if (keyRotated || cfgChanged) {
          zerlyLog('ignored-stale-response', 'Key or config changed mid-request — discarding response', { requestId });
          return '⚠️ Request cancelled due to configuration change. Please retry.';
        }

        this._lastRequestInfo = {
          requestId, status: result.status, ts: Date.now(),
          routeUsed: result.routeUsed, modelUsed: result.modelUsed,
        };
        zerlyLog('request-end', `Task: ${taskKey ?? 'ad-hoc'} route: ${result.routeUsed} model: ${result.modelUsed}`, {
          requestId,
          status: result.status,
          meta: { keyVersion: this._keyManager?.keyVersion ?? 0, routeUsed: result.routeUsed, modelUsed: result.modelUsed },
        });

        if (result.status === 401 || result.status === 403) {
          vscode.window.showWarningMessage(
            'Zerly: API key rejected. Please reconnect your account.',
            'Connect Zerly'
          ).then(action => {
            if (action === 'Connect Zerly') {
              vscode.env.openExternal(vscode.Uri.parse('https://zerly.tinobritty.me/connect'));
            }
          });
          return '⚠️ Invalid or unauthorized API key. Reconnect your account to continue.';
        }
        if (result.status === 429) {
          return '⚠️ Rate limit exceeded. Please wait a moment and try again.';
        }
        if (result.status >= 500 && attempt < MAX_RETRIES) {
          continue;
        }
        if (result.status >= 400) {
          return `⚠️ API error (${result.status}).`;
        }
        if (!result.content?.trim()) {
          return '⚠️ Empty response received. Please try again.';
        }

        return result.content;
      } catch (err: any) {
        cleanup();

        if (err.name === 'AbortError') {
          if (taskSignal?.aborted) {
            zerlyLog('ignored-stale-response', 'Task superseded mid-request', { requestId });
            return '⚠️ Request was cancelled.';
          }
          if (attempt < MAX_RETRIES) continue;
          return '⚠️ Request timed out (30 s). Check your connection and try again.';
        }

        if (attempt < MAX_RETRIES) continue;
        return '⚠️ Network error. Check your connection and try again.';
      }
    }

    return '⚠️ Zerly AI is temporarily unavailable. Please try again shortly.';
  }

  // ─── Public Feature Methods ────────────────────────────────────────────────

  async summarizeProject(scanResult: ScanResult): Promise<string> {
    const context = this._buildProjectContext(scanResult);
    const messages: ZerlyMessage[] = [
      {
        role: 'system',
        content: `You are Zerly, a developer intelligence assistant. You are confident, helpful, concise, and slightly playful. Analyze the project structure and provide a brief, useful summary. Focus on architecture, frameworks, and key modules. Keep it to 3-4 sentences.`,
      },
      {
        role: 'user',
        content: `Analyze this project and give me a concise summary:\n\n${context}`,
      },
    ];
    return this._call(messages, 1024, 'summarize');
  }

  async explainCode(code: string, fileName: string): Promise<string> {
    const messages: ZerlyMessage[] = [
      {
        role: 'system',
        content: `You are Zerly, a developer intelligence assistant. Explain code clearly and concisely. Include:
1. What the code does (plain English)
2. Key logic flow
3. Potential bugs or issues
4. Optimization suggestions (if any)

Be confident and helpful. Don't be verbose. Use markdown formatting.`,
      },
      {
        role: 'user',
        content: `Explain this code from "${fileName}":\n\n\`\`\`\n${code}\n\`\`\``,
      },
    ];
    return this._call(messages, 2048, 'explain');
  }

  async generateLearningRoadmap(scanResult: ScanResult): Promise<string> {
    const context = this._buildProjectContext(scanResult);
    const messages: ZerlyMessage[] = [
      {
        role: 'system',
        content: `You are Zerly, a developer intelligence assistant helping someone learn an unfamiliar codebase. Create a learning roadmap: ordered list of files to read, with brief explanation of each file's role. Start with entry points, then core logic, then utilities. Use numbered list format. Be concise.`,
      },
      {
        role: 'user',
        content: `Create a learning roadmap for this project:\n\n${context}`,
      },
    ];
    return this._call(messages, 2048, 'learning');
  }

  async chat(userMessage: string, scanResult: ScanResult | null): Promise<string> {
    const contextStr = scanResult
      ? '\n\nProject context:\n' + this._buildProjectContext(scanResult)
      : '';
    const messages: ZerlyMessage[] = [
      {
        role: 'system',
        content: `You are Zerly, a developer intelligence assistant. You are confident, helpful, concise, and slightly playful. Answer questions about the codebase based on the project analysis provided. If you don't have enough info, say so honestly. Use markdown formatting.${contextStr}`,
      },
      {
        role: 'user',
        content: userMessage,
      },
    ];
    return this._call(messages, 2048, 'chat');
  }

  async analyzeFeatureFlow(query: string, scanResult: ScanResult): Promise<string> {
    const context = this._buildProjectContext(scanResult);
    const messages: ZerlyMessage[] = [
      {
        role: 'system',
        content: `You are Zerly, a developer intelligence assistant. Analyze the code flow for a feature. Describe the call chain from entry point to data layer. Be specific about which functions and files are involved. Use markdown formatting.`,
      },
      {
        role: 'user',
        content: `How does "${query}" work in this project?\n\n${context}`,
      },
    ];
    return this._call(messages, 2048, 'featureFlow');
  }

  async analyzeRisks(scanResult: ScanResult, riskSummary: string): Promise<string> {
    const context = this._buildProjectContext(scanResult);
    const messages: ZerlyMessage[] = [
      {
        role: 'system',
        content: `You are Zerly, a developer intelligence assistant. Analyze the risk report for a codebase. Provide actionable recommendations for the highest-risk modules. Be specific and concise. Use markdown.`,
      },
      {
        role: 'user',
        content: `Here's the static risk analysis:\n\n${riskSummary}\n\nProject context:\n${context}\n\nGive me specific recommendations.`,
      },
    ];
    return this._call(messages, 1536, 'risks');
  }

  async analyzeArchitecture(scanResult: ScanResult): Promise<string> {
    const context = this._buildProjectContext(scanResult);
    const messages: ZerlyMessage[] = [
      {
        role: 'system',
        content: `You are Zerly, a developer intelligence assistant. Analyze the project architecture. Describe the layers, key modules, and how they connect. Identify potential architectural issues. Be concise. Use markdown.`,
      },
      {
        role: 'user',
        content: `Analyze the architecture of this project:\n\n${context}`,
      },
    ];
    return this._call(messages, 2048, 'architecture');
  }

  // ─── Context Builder ───────────────────────────────────────────────────────

  private _buildProjectContext(scanResult: ScanResult): string {
    const parts: string[] = [];

    parts.push(`## Project Overview`);
    parts.push(`- Total files: ${scanResult.totalFiles}`);
    parts.push(`- Total lines: ${scanResult.totalLines}`);
    parts.push(`- Frameworks: ${scanResult.frameworks.join(', ') || 'None detected'}`);
    parts.push(
      `- Languages: ${Object.entries(scanResult.languages)
        .map(([l, c]) => `${l} (${c} lines)`)
        .join(', ')}`
    );

    if (Object.keys(scanResult.dependencies).length > 0) {
      parts.push(`\n## Dependencies`);
      parts.push(Object.keys(scanResult.dependencies).join(', '));
    }

    parts.push(`\n## File Structure`);
    for (const file of scanResult.files.slice(0, 50)) {
      const funcs = file.functions.map((f) => f.name).join(', ');
      parts.push(
        `- ${file.relativePath} (${file.lineCount} lines)${funcs ? ` — functions: ${funcs}` : ''}`
      );
    }
    if (scanResult.files.length > 50) {
      parts.push(`... and ${scanResult.files.length - 50} more files`);
    }

    parts.push(`\n## Import Map (key files)`);
    for (const file of scanResult.files.slice(0, 30)) {
      if (file.imports.length > 0) {
        parts.push(`- ${file.relativePath} imports: ${file.imports.join(', ')}`);
      }
    }

    return parts.join('\n');
  }
}
