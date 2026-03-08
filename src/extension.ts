import * as vscode from 'vscode';
import { ZerlySidebarProvider } from './sidebarProvider';
import { ProjectScanner } from './scanner';
import { DependencyGraph } from './dependencyGraph';
import { RiskAnalyzer } from './riskAnalyzer';
import { FlowAnalyzer } from './flowAnalyzer';
import { AIService } from './aiService';
import { AuthManager } from './authManager';
import { SubscriptionManager } from './subscriptionManager';
import { UsageTracker } from './usageTracker';
import { ZerlyKeyManager, getLogBuffer, zerlyLog } from './zerlyKeyManager';
import { ProviderKeyManager } from './providerKeyManager';
import { RequestRouter } from './requestRouter';

let sidebarProvider: ZerlySidebarProvider;

export async function activate(context: vscode.ExtensionContext) {
  zerlyLog('activate', 'Zerly AI is activating...');

  // ── Key Manager (initialize before anything else) ──────────────────────────
  const keyManager = ZerlyKeyManager.getInstance(context);
  await keyManager.initialize();
  context.subscriptions.push({ dispose: () => keyManager.dispose() });

  // ── Monetization services ──────────────────────────────────────────────────
  const auth = AuthManager.getInstance(context);
  auth.setKeyManager(keyManager);
  const subManager = SubscriptionManager.getInstance(auth);
  const usageTracker = UsageTracker.getInstance(context, auth, subManager);

  // Register the URI handler exactly once — disposed on deactivate.
  // Handles vscode://...?key=... (API key) and vscode://...?token=... (GitHub OAuth).
  const uriHandlerDisposable = vscode.window.registerUriHandler(auth);
  context.subscriptions.push(uriHandlerDisposable);
  zerlyLog('uri-handler-registered', 'Deep-link URI handler registered (single instance)');

  // ── Core services ──────────────────────────────────────────────────────────
  const scanner = new ProjectScanner();
  const depGraph = new DependencyGraph();
  const riskAnalyzer = new RiskAnalyzer();
  const flowAnalyzer = new FlowAnalyzer();
  // ── Provider key manager (BYOK) + Request router ─────────────────────────
  const providerManager = ProviderKeyManager.getInstance(context);
  await providerManager.initialize();
  context.subscriptions.push({ dispose: () => providerManager.dispose() });

  const requestRouter = new RequestRouter();
  requestRouter.setKeyManager(keyManager);
  requestRouter.setProviderManager(providerManager);

  const aiService = new AIService();
  aiService.setExtensionPath(context.extensionUri.fsPath);
  aiService.setKeyManager(keyManager);
  aiService.setProviderManager(providerManager);
  aiService.setRequestRouter(requestRouter);

  sidebarProvider = new ZerlySidebarProvider(
    context.extensionUri,
    context,
    scanner,
    depGraph,
    riskAnalyzer,
    flowAnalyzer,
    aiService,
    keyManager
  );
  sidebarProvider.setProviderManager(providerManager);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('zerly.mainView', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  // ── Reset Session command ─────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.resetSession', async () => {
      const CLEAR_KEY_LABEL = 'Clear caches and sign out';
      const KEEP_KEY_LABEL = 'Clear caches only (keep key)';
      const pick = await vscode.window.showQuickPick(
        [KEEP_KEY_LABEL, CLEAR_KEY_LABEL],
        { placeHolder: 'Zerly: Reset Session — what would you like to clear?' }
      );
      if (!pick) return;

      sidebarProvider.clearAllCaches();
      aiService.invalidateAll();
      zerlyLog('key-changed-cache-cleared', `Session reset (${pick})`);

      if (pick === CLEAR_KEY_LABEL) {
        await keyManager.clearKey();
        vscode.window.showInformationMessage('Zerly: Session cleared and signed out.');
      } else {
        // Notify webview to re-fetch with fresh state
        sidebarProvider.postMessage({ command: 'sessionReset' });
        vscode.window.showInformationMessage('Zerly: Session caches cleared. Ready for fresh analysis.');
      }
    })
  );

  // ── Diagnostics command ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.diagnostics', () => {
      const logs = getLogBuffer();
      const last20 = logs.slice(-20);
      const logText = last20
        .map(e => {
          const time = new Date(e.ts).toISOString().slice(11, 23);
          const rid = e.requestId ? ` [${e.requestId.slice(0, 8)}]` : '';
          const st = e.status !== undefined ? ` HTTP:${e.status}` : '';
          return `${time}${rid} [${e.source}]${st} ${e.message}`;
        })
        .join('\n');

      const lastReq = aiService.getLastRequestInfo();
      const lastReqStr = lastReq
        ? `${lastReq.requestId.slice(0, 8)} HTTP:${lastReq.status ?? '?'} route:${lastReq.routeUsed ?? '?'} @ ${new Date(lastReq.ts).toISOString().slice(11, 23)}`
        : '(none)';

      const lastAuthTs = auth.getLastAuthUriTimestamp();
      const lastAuthStr = lastAuthTs
        ? new Date(lastAuthTs).toISOString()
        : '(never)';

      const cfg = providerManager.getConfig();
      const providerLines = ['openai', 'anthropic', 'gemini'].map(
        p => `  ${p.padEnd(10)}: ${providerManager.hasKey(p as any) ? `✓ ${providerManager.maskedKey(p as any)}` : '✗ (not set)'}`
      ).join('\n');

      const diagnosticInfo = [
        `─── Zerly AI Diagnostics ───`,
        `Key present      : ${keyManager.hasKey()}`,
        `Key (masked)     : ${keyManager.maskedKey()}`,
        `Key version      : ${keyManager.keyVersion}`,
        `Route mode       : ${cfg.routeMode}`,
        `Active provider  : ${cfg.activeProvider}`,
        `Config version   : ${providerManager.configVersion}`,
        `Provider keys    :`,
        providerLines,
        `In-flight count  : ${aiService.getInflightCount()}`,
        `Last request     : ${lastReqStr}`,
        `Listeners (key)  : ${sidebarProvider.getListenerCount()}`,
        `Last auth URI    : ${lastAuthStr}`,
        `─── Recent Logs (last 20) ───`,
        logText || '(no logs yet)',
      ].join('\n');

      // Show in a new text document so the user can copy/paste it
      vscode.workspace.openTextDocument({
        language: 'plaintext',
        content: diagnosticInfo,
      }).then(doc => vscode.window.showTextDocument(doc));
    })
  );
  // ── Auth commands ──────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.login', async () => {
      await auth.login();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.connectZerly', async () => {
      const connectUrl = `https://zerly.tinobritty.me/connect?autoConnect=1&extensionId=${context.extension.id}&setupProviders=1`;
      await vscode.env.openExternal(vscode.Uri.parse(connectUrl));
    })
  );

  // ── Setup AI Providers command (BYOK) ─────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.setupProviders', async () => {
      const providers = ['OpenAI', 'Anthropic', 'Gemini'] as const;
      const providerMap: Record<string, 'openai' | 'anthropic' | 'gemini'> = {
        OpenAI: 'openai', Anthropic: 'anthropic', Gemini: 'gemini',
      };
      const items = providers.map(p => {
        const key = providerMap[p];
        const connected = providerManager.hasKey(key);
        return {
          label: `$(${connected ? 'check' : 'circle-slash'}) ${p}`,
          description: connected ? providerManager.maskedKey(key) : 'Not configured',
          detail: connected ? 'Click to update or remove' : 'Click to add API key',
          provider: key,
        };
      });

      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a provider to configure',
        title: 'Zerly: Setup AI Providers (BYOK)',
      });
      if (!pick) return;

      const action = await vscode.window.showQuickPick(
        providerManager.hasKey(pick.provider)
          ? ['Update key', 'Remove key', 'Cancel']
          : ['Add key', 'Cancel'],
        { placeHolder: `${pick.label.replace(/\$\([^)]+\) /, '')} — choose action` }
      );
      if (!action || action === 'Cancel') return;

      if (action === 'Remove key') {
        await providerManager.removeKey(pick.provider);
        vscode.window.showInformationMessage(`Zerly: ${pick.provider} key removed.`);
        return;
      }

      const key = await vscode.window.showInputBox({
        prompt: `Enter your ${pick.provider} API key`,
        password: true,
        placeHolder: pick.provider === 'openai' ? 'sk-...' : pick.provider === 'anthropic' ? 'sk-ant-...' : 'AIza...',
        validateInput: v => v && v.trim().length > 10 ? null : 'Key too short',
      });
      if (!key) return;

      const result = await providerManager.setKey(pick.provider, key.trim());
      if (result.ok) {
        vscode.window.showInformationMessage(`Zerly: ${pick.provider} key saved. ✓`);
        sidebarProvider.postMessage({ command: 'providerStatus', data: providerManager.getConfig() });
      } else {
        vscode.window.showErrorMessage(`Zerly: ${result.error}`);
      }
    })
  );

  // ── Paste Zerly API key command ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.pasteApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Paste your Zerly API key',
        password: true,
        placeHolder: 'sk_zerly_...',
        validateInput: v => v && v.trim().length > 10 ? null : 'Key too short',
      });
      if (!key) return;
      const result = await keyManager.setKey(key.trim());
      if (result.ok) {
        vscode.window.showInformationMessage('Zerly: API key saved. Account connected! 🟣');
      } else {
        vscode.window.showErrorMessage(`Zerly: ${result.error}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.logout', async () => {
      await auth.logout();
      subManager.invalidateCache();
      sidebarProvider.postMessage({ command: 'authChanged', loggedIn: false });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.upgrade', async () => {
      await subManager.startUpgrade('PRO');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.manageBilling', async () => {
      await subManager.openBillingPortal();
    })
  );

  // ── Refresh command — called after OAuth deep-link ─────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.refresh', async () => {
      subManager.invalidateCache();
      const user = await auth.getMe();
      sidebarProvider.postMessage({
        command: 'authChanged',
        loggedIn: !!user,
        user,
        plan: user?.plan ?? 'FREE',
      });
    })
  );

  // ── Feature commands (gated) ───────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.analyzeProject', async () => {
      // Project scans are tracked and gated
      const allowed = await usageTracker.trackAndGate('SCAN');
      if (!allowed) return;

      sidebarProvider.postMessage({ command: 'navigate', view: 'analyze' });
      await runAnalyzeProject(scanner, depGraph, aiService);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.architectureMap', async () => {
      // Architecture map is free for everyone
      sidebarProvider.postMessage({ command: 'navigate', view: 'architecture' });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.featureFlow', async () => {
      sidebarProvider.postMessage({ command: 'navigate', view: 'featureFlow' });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.riskScanner', async () => {
      // Deep risk analysis is Pro+; basic scanner is free
      const wantsDeep = await subManager.hasFeature('deepRiskAnalysis');
      sidebarProvider.postMessage({
        command: 'navigate',
        view: 'risk',
        mode: wantsDeep ? 'deep' : 'basic',
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.explainCode', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('Zerly: No active editor found.');
        return;
      }
      const selection = editor.selection;
      const code = editor.document.getText(selection);
      if (!code.trim()) {
        vscode.window.showWarningMessage('Zerly: Please select some code first.');
        return;
      }

      // Gate: explanations are tracked per day
      const allowed = await usageTracker.trackAndGate('EXPLANATION');
      if (!allowed) return;

      // Choose model tier based on plan
      const useAdvanced = await subManager.hasFeature('fasterAiModels');

      sidebarProvider.postMessage({
        command: 'explainCode',
        code,
        fileName: editor.document.fileName,
        modelTier: useAdvanced ? 'advanced' : 'basic',
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.learningMode', () => {
      sidebarProvider.postMessage({ command: 'navigate', view: 'learning' });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.chat', async () => {
      // Chat queries are tracked per day
      const allowed = await usageTracker.trackAndGate('CHAT_QUERY');
      if (!allowed) return;

      sidebarProvider.postMessage({ command: 'navigate', view: 'chat' });
    })
  );

  // ── Architecture history (Pro+) ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.architectureHistory', async () => {
      const ok = await subManager.requireFeature('architectureHistory');
      if (!ok) return;
      sidebarProvider.postMessage({ command: 'navigate', view: 'architectureHistory' });
    })
  );

  // ── Team dashboard (Team+) ─────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('zerly.teamDashboard', async () => {
      const ok = await subManager.requireFeature('sharedDashboards');
      if (!ok) return;
      sidebarProvider.postMessage({ command: 'navigate', view: 'teamDashboard' });
    })
  );

  // Show appropriate startup notification based on whether an API key is set
  if (keyManager.hasKey()) {
    vscode.window.showInformationMessage(
      "Hey, I'm Zerly. Give me a moment to understand your codebase. 🧠"
    );
  } else {
    vscode.window.showInformationMessage(
      'Connect your Zerly account to activate AI features.',
      'Connect Zerly'
    ).then(action => {
      if (action === 'Connect Zerly') {
        vscode.env.openExternal(vscode.Uri.parse('https://zerly.tinobritty.me/connect'));
      }
    });
  }

  // Validate key against backend in the background (non-blocking)
  validateKeyOnStartup(keyManager, sidebarProvider);

  zerlyLog('activate', 'Zerly AI activated successfully.');
}

async function runAnalyzeProject(
  scanner: ProjectScanner,
  depGraph: DependencyGraph,
  aiService: AIService
) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    vscode.window.showWarningMessage('Zerly: No workspace folder open.');
    return;
  }

  const rootPath = workspaceFolders[0].uri.fsPath;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Zerly is analyzing your project...',
      cancellable: false,
    },
    async () => {
      const scanResult = await scanner.scan(rootPath);
      const graph = depGraph.build(scanResult);

      sidebarProvider.postMessage({
        command: 'scanComplete',
        data: {
          scanResult,
          graph,
        },
      });
    }
  );
}

export function deactivate() {
  zerlyLog('deactivate', 'Zerly AI deactivated.');
}

/**
 * Validates the stored API key against the Zerly backend on startup.
 * If the key is invalid (401/403), clears dependent caches and shows a reconnect CTA.
 * Runs asynchronously so it never blocks extension activation.
 */
async function validateKeyOnStartup(
  keyManager: ZerlyKeyManager,
  sidebar: ZerlySidebarProvider
): Promise<void> {
  const key = keyManager.getCachedKey();
  if (!key) return;  // No key — user hasn't connected yet

  try {
    const response = await fetch('https://zerly.tinobritty.me/api/status', {
      headers: {
        'Authorization': `Bearer ${key}`,
        'Cache-Control': 'no-store',
      },
      signal: AbortSignal.timeout(10_000),
    });

    zerlyLog('startup-validation', `Status check`, { status: response.status });

    if (response.status === 401 || response.status === 403) {
      // Key is rejected — clear auth-dependent caches and prompt reconnect
      sidebar.clearAllCaches();
      sidebar.postMessage({ command: 'apiStatus', data: { hasKey: false } });
      vscode.window.showWarningMessage(
        'Zerly: Your API key has expired or is invalid. Please reconnect.',
        'Reconnect'
      ).then(action => {
        if (action === 'Reconnect') {
          vscode.env.openExternal(vscode.Uri.parse('https://zerly.tinobritty.me/connect'));
        }
      });
    }
    // 2xx or other non-401 responses: key is fine
  } catch {
    // Network down or endpoint not available — non-fatal, skip validation
    zerlyLog('startup-validation', 'Status check skipped (network/timeout)');
  }
}
