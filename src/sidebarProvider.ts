import * as vscode from 'vscode';
import { ProjectScanner } from './scanner';
import { DependencyGraph } from './dependencyGraph';
import { RiskAnalyzer } from './riskAnalyzer';
import { FlowAnalyzer } from './flowAnalyzer';
import { AIService } from './aiService';
import { ZerlyKeyManager, zerlyLog } from './zerlyKeyManager';
import { ProviderKeyManager, Provider } from './providerKeyManager';

const CACHE_KEY = 'zerly.cachedScanData';
const CACHE_TIMESTAMP_KEY = 'zerly.cachedScanTimestamp';
const ARCH_CACHE_KEY = 'zerly.cachedArchitecture';
const ARCH_CACHE_TIMESTAMP_KEY = 'zerly.cachedArchitectureTimestamp';
const RISK_CACHE_KEY = 'zerly.cachedRisk';
const RISK_CACHE_TIMESTAMP_KEY = 'zerly.cachedRiskTimestamp';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export class ZerlySidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _pendingMessages: any[] = [];
  /** Disposable for the onKeyChanged subscription — cleaned up on dispose. */
  private _keyChangedDisposable: vscode.Disposable;
  /** Disposable for the onConfigChanged subscription — cleaned up on dispose. */
  private _configChangedDisposable: vscode.Disposable | null = null;
  /** How many key-change listeners are currently registered (always 1 after construction). */
  private _listenerCount = 0;
  private _providerManager: ProviderKeyManager | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
    private readonly _scanner: ProjectScanner,
    private readonly _depGraph: DependencyGraph,
    private readonly _riskAnalyzer: RiskAnalyzer,
    private readonly _flowAnalyzer: FlowAnalyzer,
    private readonly _aiService: AIService,
    private readonly _keyManager: ZerlyKeyManager
  ) {
    // When the API key changes, immediately clear caches and notify the webview
    // so it re-renders with the new auth state and fresh (empty) data.
    this._keyChangedDisposable = _keyManager.onKeyChanged.event((key) => {
      zerlyLog('cache-invalidated', 'All caches cleared after key change', {
        meta: { keyVersion: _keyManager.keyVersion, hasKey: Boolean(key) },
      });
      this.clearAllCaches();
      // Tell webview to wipe rendered results immediately so nothing stale shows.
      this.postMessage({ command: 'clearResults' });
      this.postMessage({
        command: 'apiStatus',
        data: { hasKey: Boolean(key) },
      });
      this.postMessage({ command: 'apiKeySet', success: Boolean(key) });
    });
    this._listenerCount = 1;
  }

  /** Wire in the provider key manager after construction. */
  setProviderManager(pm: ProviderKeyManager): void {
    this._providerManager = pm;
    this._configChangedDisposable = pm.onConfigChanged.event((cfg) => {
      this.postMessage({ command: 'providerStatus', data: cfg });
    });
  }

  /** Number of onKeyChanged listeners currently registered. */
  getListenerCount(): number {
    return this._listenerCount;
  }

  /** Clears every persisted cache entry. Safe to call at any time. */
  public clearAllCaches(): void {
    const keys = [
      CACHE_KEY, CACHE_TIMESTAMP_KEY,
      ARCH_CACHE_KEY, ARCH_CACHE_TIMESTAMP_KEY,
      RISK_CACHE_KEY, RISK_CACHE_TIMESTAMP_KEY,
    ];
    for (const k of keys) {
      this._context.workspaceState.update(k, undefined);
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Abort all in-flight AI requests when the webview panel is destroyed.
    webviewView.onDidDispose(() => {
      this._view = undefined;
      zerlyLog('webview-disposed', 'Webview closed — aborting all in-flight requests');
      this._aiService.invalidateAll();
      this._keyChangedDisposable.dispose();
      this._configChangedDisposable?.dispose();
      this._configChangedDisposable = null;
    });

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      await this._handleMessage(message);
    });

    // Send any pending messages
    for (const msg of this._pendingMessages) {
      webviewView.webview.postMessage(msg);
    }
    this._pendingMessages = [];
  }

  public postMessage(message: any) {
    if (this._view) {
      this._view.webview.postMessage(message);
    } else {
      this._pendingMessages.push(message);
    }
  }

  private async _handleMessage(message: any) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const rootPath = workspaceFolders?.[0]?.uri.fsPath;

    switch (message.command) {
      case 'getCachedScan': {
        const cached = this._getCachedData<any>(CACHE_KEY, CACHE_TIMESTAMP_KEY);
        if (cached) {
          this.postMessage({ command: 'cachedScanData', data: cached });
        }
        break;
      }

      case 'analyzeProject': {
        if (!rootPath) {
          this.postMessage({ command: 'error', message: 'No workspace folder open.' });
          return;
        }

        this.postMessage({ command: 'loading', feature: 'analyze' });
        try {
          const scanData = await this._getScanData(rootPath, message.forceRefresh === true);

          this.postMessage({
            command: 'scanComplete',
            data: scanData,
            isCached: scanData.fromCache,
          });
        } catch (err: any) {
          this.postMessage({ command: 'error', message: err.message });
        }
        break;
      }

      case 'architectureMap': {
        if (!rootPath) return;
        if (!vscode.workspace.getConfiguration('zerly').get<boolean>('enableArchitectureMap')) {
          this.postMessage({ command: 'error', message: 'Architecture Map is disabled in settings.' });
          return;
        }
        const cached = this._getCachedData<any>(ARCH_CACHE_KEY, ARCH_CACHE_TIMESTAMP_KEY);
        if (cached) {
          this.postMessage({ command: 'architectureResult', data: cached });
          return;
        }
        this.postMessage({ command: 'loading', feature: 'architecture' });
        try {
          const scanData = await this._getScanData(rootPath, false);
          const graph = scanData.graph || this._depGraph.build(scanData.scanResult);
          const mermaidDiagram = this._depGraph.toMermaid(graph);
          const data = { graph, mermaidDiagram };
          await this._context.workspaceState.update(ARCH_CACHE_KEY, data);
          await this._context.workspaceState.update(ARCH_CACHE_TIMESTAMP_KEY, Date.now());
          this.postMessage({
            command: 'architectureResult',
            data,
          });
        } catch (err: any) {
          this.postMessage({ command: 'error', message: err.message });
        }
        break;
      }

      case 'riskScan': {
        if (!rootPath) return;
        if (!vscode.workspace.getConfiguration('zerly').get<boolean>('enableRiskScanner')) {
          this.postMessage({ command: 'error', message: 'Risk Scanner is disabled in settings.' });
          return;
        }
        const cached = this._getCachedData<any>(RISK_CACHE_KEY, RISK_CACHE_TIMESTAMP_KEY);
        if (cached) {
          this.postMessage({ command: 'riskResult', data: cached });
          return;
        }
        this.postMessage({ command: 'loading', feature: 'risk' });
        try {
          const scanData = await this._getScanData(rootPath, false);
          const risks = this._riskAnalyzer.analyze(scanData.scanResult);
          const data = { risks };
          await this._context.workspaceState.update(RISK_CACHE_KEY, data);
          await this._context.workspaceState.update(RISK_CACHE_TIMESTAMP_KEY, Date.now());
          this.postMessage({
            command: 'riskResult',
            data,
          });
        } catch (err: any) {
          this.postMessage({ command: 'error', message: err.message });
        }
        break;
      }

      case 'featureFlow': {
        if (!rootPath) return;
        this.postMessage({ command: 'loading', feature: 'featureFlow' });
        try {
          const scanData = await this._getScanData(rootPath, false);
          const flow = this._flowAnalyzer.analyzeFlow(scanData.scanResult, message.query || '');
          this.postMessage({
            command: 'featureFlowResult',
            data: { flow, query: message.query },
          });
        } catch (err: any) {
          this.postMessage({ command: 'error', message: err.message });
        }
        break;
      }

      case 'explainCode': {
        this.postMessage({ command: 'loading', feature: 'explain' });
        try {
          const explanation = await this._aiService.explainCode(
            message.code,
            message.fileName || ''
          );
          this.postMessage({
            command: 'explainResult',
            data: { explanation, code: message.code },
          });
        } catch (err: any) {
          this.postMessage({ command: 'error', message: err.message });
        }
        break;
      }

      case 'learningMode': {
        if (!rootPath) return;
        this.postMessage({ command: 'loading', feature: 'learning' });
        try {
          const scanData = await this._getScanData(rootPath, false);
          const roadmap = await this._aiService.generateLearningRoadmap(scanData.scanResult);
          this.postMessage({
            command: 'learningResult',
            data: { roadmap, scanResult: scanData.scanResult },
          });
        } catch (err: any) {
          this.postMessage({ command: 'error', message: err.message });
        }
        break;
      }

      case 'chat': {
        this.postMessage({ command: 'loading', feature: 'chat' });
        try {
          let scanResult = null;
          if (rootPath) {
            const scanData = await this._getScanData(rootPath, false);
            scanResult = scanData.scanResult;
          }
          const reply = await this._aiService.chat(message.userMessage, scanResult);
          this.postMessage({
            command: 'chatResponse',
            data: { reply, userMessage: message.userMessage },
          });
        } catch (err: any) {
          this.postMessage({ command: 'error', message: err.message });
        }
        break;
      }

      case 'openFile': {
        if (message.filePath) {
          const uri = vscode.Uri.file(message.filePath);
          vscode.window.showTextDocument(uri);
        }
        break;
      }

      case 'setApiKey': {
        const key = await vscode.window.showInputBox({
          prompt: 'Enter your Zerly API key from zerly.tinobritty.me',
          password: true,
          placeHolder: 'sk_zerly_...',
        });
        if (key) {
          const result = await this._keyManager.setKey(key);
          if (!result.ok) {
            vscode.window.showWarningMessage(`Zerly: ${result.error}`);
            break;
          }
          vscode.window.showInformationMessage('Zerly: API key saved! AI features are ready.');
        }
        break;
      }

      case 'connectZerly': {
        const extId = vscode.extensions.getExtension('zerly.zerly-ai')?.id ?? 'zerly.zerly-ai';
        const connectUrl = `https://zerly.tinobritty.me/connect?autoConnect=1&extensionId=${extId}&setupProviders=1`;
        await vscode.env.openExternal(vscode.Uri.parse(connectUrl));
        break;
      }

      case 'pasteApiKey': {
        const clipboardText = (await vscode.env.clipboard.readText()).trim();
        if (!clipboardText) {
          vscode.window.showWarningMessage('Zerly: Clipboard is empty. Copy your API key and try again.');
          break;
        }
        const result = await this._keyManager.setKey(clipboardText);
        if (!result.ok) {
          vscode.window.showWarningMessage(`Zerly: ${result.error}`);
          break;
        }
        vscode.window.showInformationMessage('Zerly: API key saved from clipboard. AI features are ready.');
        break;
      }

      case 'getApiStatus': {
        const hasKey = this._keyManager.hasKey();
        this.postMessage({
          command: 'apiStatus',
          data: { hasKey, isDefault: !hasKey },
        });
        // Also send provider config if available
        if (this._providerManager) {
          this.postMessage({ command: 'providerStatus', data: this._providerManager.getConfig() });
        }
        break;
      }

      case 'getProviderStatus': {
        if (this._providerManager) {
          this.postMessage({ command: 'providerStatus', data: this._providerManager.getConfig() });
        }
        break;
      }

      case 'setProviderKey': {
        if (!this._providerManager) break;
        const { provider, key } = message as { provider: Provider; key: string };
        const r = await this._providerManager.setKey(provider, key);
        this.postMessage({ command: 'setProviderKeyResult', ok: r.ok, provider, error: r.error });
        if (r.ok) {
          this.postMessage({ command: 'providerStatus', data: this._providerManager.getConfig() });
        }
        break;
      }

      case 'removeProviderKey': {
        if (!this._providerManager) break;
        const { provider } = message as { provider: Provider };
        await this._providerManager.removeKey(provider);
        this.postMessage({ command: 'providerStatus', data: this._providerManager.getConfig() });
        break;
      }

      case 'setRouteMode': {
        if (!this._providerManager) break;
        await this._providerManager.setConfig({ routeMode: message.routeMode });
        this.postMessage({ command: 'providerStatus', data: this._providerManager.getConfig() });
        break;
      }

      case 'setupProviders': {
        vscode.commands.executeCommand('zerly.setupProviders');
        break;
      }
    }
  }

  private _isCacheValid(timestamp?: number): boolean {
    return !!timestamp && Date.now() - timestamp < CACHE_TTL_MS;
  }

  private _getCachedData<T>(key: string, tsKey: string): T | null {
    const cached = this._context.workspaceState.get<T>(key);
    const timestamp = this._context.workspaceState.get<number>(tsKey);
    if (cached && this._isCacheValid(timestamp)) {
      return cached;
    }
    return null;
  }

  private async _getScanData(rootPath: string, forceRefresh: boolean): Promise<any> {
    if (!forceRefresh) {
      const cached = this._getCachedData<any>(CACHE_KEY, CACHE_TIMESTAMP_KEY);
      if (cached) {
        return { ...cached, fromCache: true };
      }
    } else {
      await this._context.workspaceState.update(ARCH_CACHE_KEY, undefined);
      await this._context.workspaceState.update(ARCH_CACHE_TIMESTAMP_KEY, undefined);
      await this._context.workspaceState.update(RISK_CACHE_KEY, undefined);
      await this._context.workspaceState.update(RISK_CACHE_TIMESTAMP_KEY, undefined);
    }

    const scanResult = await this._scanner.scan(rootPath);
    const graph = this._depGraph.build(scanResult);

    let aiSummary = '';
    try {
      aiSummary = await this._aiService.summarizeProject(scanResult);
    } catch {
      aiSummary = '';
    }

    const data = { scanResult, graph, aiSummary };
    await this._context.workspaceState.update(CACHE_KEY, data);
    await this._context.workspaceState.update(CACHE_TIMESTAMP_KEY, Date.now());
    return { ...data, fromCache: false };
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.css')
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com;
    script-src 'nonce-${nonce}';
    font-src ${webview.cspSource} https://fonts.gstatic.com;
    img-src ${webview.cspSource} https: data:;
    connect-src https://zerly.tinobritty.me;
  ">
  <link rel="stylesheet" href="${styleUri}">
  <title>Zerly AI</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
