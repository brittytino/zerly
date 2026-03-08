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

let sidebarProvider: ZerlySidebarProvider;

export function activate(context: vscode.ExtensionContext) {
  console.log('Zerly AI is activating...');

  // ── Monetization services ──────────────────────────────────────────────────
  const auth = AuthManager.getInstance(context);
  const subManager = SubscriptionManager.getInstance(auth);
  const usageTracker = UsageTracker.getInstance(context, auth, subManager);

  // Register the URI handler so GitHub OAuth deep-links arrive back here:
  // vscode://zerlyai.zerly/auth?token=...
  context.subscriptions.push(
    vscode.window.registerUriHandler(auth)
  );

  // ── Core services ──────────────────────────────────────────────────────────
  const scanner = new ProjectScanner();
  const depGraph = new DependencyGraph();
  const riskAnalyzer = new RiskAnalyzer();
  const flowAnalyzer = new FlowAnalyzer();
  const aiService = new AIService();
  aiService.setExtensionPath(context.extensionUri.fsPath);

  sidebarProvider = new ZerlySidebarProvider(
    context.extensionUri,
    context,
    scanner,
    depGraph,
    riskAnalyzer,
    flowAnalyzer,
    aiService
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('zerly.mainView', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
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
      await vscode.env.openExternal(vscode.Uri.parse('https://zerly.tinobritty.me/connect'));
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

  // Show welcome message
  vscode.window.showInformationMessage(
    "Hey, I'm Zerly. Give me a moment to understand your codebase. 🧠"
  );

  console.log('Zerly AI activated successfully.');
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
  console.log('Zerly AI deactivated.');
}
