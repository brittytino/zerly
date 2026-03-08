import * as vscode from 'vscode';
import { ScanResult } from './scanner';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ZerlyMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ZerlyResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
    code?: number;
  };
}

export type TaskType =
  | 'code_explanation'
  | 'architecture_analysis'
  | 'feature_flow'
  | 'risk_analysis'
  | 'developer_chat'
  | 'quick_summary'
  | 'learning_roadmap';

// ─── Constants ───────────────────────────────────────────────────────────────

const ZERLY_API_ENDPOINT = 'https://zerly.tinobritty.me/api/v1/chat/completions';
const ZERLY_DEFAULT_MODEL = 'zerly/zerlino-32b';

// ─── AI Service ──────────────────────────────────────────────────────────────

export class AIService {
  private _extensionPath: string = '';

  setExtensionPath(extPath: string) {
    this._extensionPath = extPath;
  }

  // ── API Key Resolution (priority: user zerlyApiKey setting > customModelApiKey) ──

  getApiKey(): string {
    const cfg = vscode.workspace.getConfiguration('zerly');
    const zerlyKey = cfg.get<string>('zerlyApiKey');
    if (zerlyKey && zerlyKey.trim().length > 0) {
      return zerlyKey.trim();
    }
    return '';
  }

  /** Returns the model to use: custom override if set, otherwise the Zerly default. */
  private _getModel(): string {
    const cfg = vscode.workspace.getConfiguration('zerly');
    const customModelKey = cfg.get<string>('customModelApiKey');
    if (customModelKey && customModelKey.trim().length > 0) {
      // When a custom key is provided, honour the custom model setting
      const customModel = cfg.get<string>('customModel');
      if (customModel && customModel.trim()) {
        return customModel.trim();
      }
    }
    return ZERLY_DEFAULT_MODEL;
  }

  /** Returns the API key and endpoint to use based on config. */
  private _getApiConfig(): { apiKey: string; endpoint: string } {
    const cfg = vscode.workspace.getConfiguration('zerly');
    const customModelKey = cfg.get<string>('customModelApiKey');
    if (customModelKey && customModelKey.trim().length > 0) {
      const customEndpoint = cfg.get<string>('customApiEndpoint') || ZERLY_API_ENDPOINT;
      return { apiKey: customModelKey.trim(), endpoint: customEndpoint };
    }
    return { apiKey: this.getApiKey(), endpoint: ZERLY_API_ENDPOINT };
  }

  // ── Core API call ──

  private async _call(
    messages: ZerlyMessage[],
    maxTokens: number = 2048
  ): Promise<string> {
    const { apiKey, endpoint } = this._getApiConfig();

    if (!apiKey) {
      return '⚠️ Connect your Zerly account to activate AI features. Add your API key in Settings → Zerly AI → Zerly API Key.';
    }

    const model = this._getModel();
    console.log(`[Zerly] Calling model: ${model}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'X-Title': 'Zerly AI',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.3,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown error');
        if (response.status === 401 || response.status === 403) {
          return '⚠️ Invalid or unauthorized Zerly API key. Check your key in Settings → Zerly AI → Zerly API Key.';
        }
        if (response.status === 429) {
          return '⚠️ Rate limit exceeded. Please wait a moment and try again.';
        }
        return `⚠️ Zerly API error (${response.status}): ${errText}`;
      }

      const data = (await response.json()) as ZerlyResponse;

      if (data.error) {
        return `⚠️ API error: ${data.error.message || 'Unknown error'}`;
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content || content.trim().length === 0) {
        return '⚠️ Empty response received. Please try again.';
      }

      return content;
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        return '⚠️ Request timed out (30s). Check your connection and try again.';
      }
      return '⚠️ Network error. Check your connection and try again.';
    }
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
    return this._call(messages, 1024);
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
    return this._call(messages, 2048);
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
    return this._call(messages, 2048);
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
    return this._call(messages, 2048);
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
    return this._call(messages, 2048);
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
    return this._call(messages, 1536);
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
    return this._call(messages, 2048);
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
