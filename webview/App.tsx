import React, { useState, useEffect, useCallback } from 'react';
import { Home } from './views/Home';
import { AnalyzeView } from './views/AnalyzeView';
import { ArchitectureView } from './views/ArchitectureView';
import { RiskView } from './views/RiskView';
import { FeatureFlowView } from './views/FeatureFlowView';
import { ExplainView } from './views/ExplainView';
import { LearningView } from './views/LearningView';
import { ChatView } from './views/ChatView';
import { LoadingOverlay } from './components/LoadingOverlay';
import { ErrorBanner } from './components/ErrorBanner';
import './styles.css';

type View = 'home' | 'analyze' | 'architecture' | 'risk' | 'featureFlow' | 'explain' | 'learning' | 'chat';

// Declare VS Code API
declare function acquireVsCodeApi(): {
  postMessage(msg: any): void;
  getState(): any;
  setState(state: any): void;
};

const vscode = acquireVsCodeApi();

export function App() {
  const [currentView, setCurrentView] = useState<View>('home');
  const [loading, setLoading] = useState(false);
  const [loadingFeature, setLoadingFeature] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);
  const [scanData, setScanData] = useState<any>(null);
  const [scanIsCached, setScanIsCached] = useState(false);
  const [architectureData, setArchitectureData] = useState<any>(null);
  const [riskData, setRiskData] = useState<any>(null);
  const [flowData, setFlowData] = useState<any>(null);
  const [explainData, setExplainData] = useState<any>(null);
  const [learningData, setLearningData] = useState<any>(null);
  const [chatMessages, setChatMessages] = useState<Array<{ role: string; content: string }>>([]);

  const handleMessage = useCallback((event: MessageEvent) => {
    const message = event.data;

    switch (message.command) {
      case 'navigate':
        setCurrentView(message.view);
        setError(null);
        break;

      case 'loading':
        setLoading(true);
        setLoadingFeature(message.feature || '');
        setError(null);
        break;

      case 'scanComplete':
        setLoading(false);
        setScanData(message.data);
        setScanIsCached(message.isCached || false);
        setCurrentView('analyze');
        break;

      case 'cachedScanData':
        if (message.data) {
          setScanData(message.data);
          setScanIsCached(true);
        }
        break;

      case 'architectureResult':
        setLoading(false);
        setArchitectureData(message.data);
        setCurrentView('architecture');
        break;

      case 'riskResult':
        setLoading(false);
        setRiskData(message.data);
        setCurrentView('risk');
        break;

      case 'featureFlowResult':
        setLoading(false);
        setFlowData(message.data);
        setCurrentView('featureFlow');
        break;

      case 'explainCode':
        setCurrentView('explain');
        setExplainData({ code: message.code, fileName: message.fileName, explanation: null });
        // Trigger AI explanation
        vscode.postMessage({
          command: 'explainCode',
          code: message.code,
          fileName: message.fileName,
        });
        break;

      case 'explainResult':
        setLoading(false);
        setExplainData(message.data);
        break;

      case 'learningResult':
        setLoading(false);
        setLearningData(message.data);
        setCurrentView('learning');
        break;

      case 'chatResponse':
        setLoading(false);
        setChatMessages((prev) => [
          ...prev,
          { role: 'assistant', content: message.data.reply },
        ]);
        break;

      case 'error':
        setLoading(false);
        setError(message.message);
        break;

      case 'apiKeySet':
        setError(null);
        setApiKeyConfigured(true);
        break;

      case 'apiStatus':
        setApiKeyConfigured(message.data?.hasKey === true);
        break;
    }
  }, []);

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    // Request cached data and API key status on mount
    vscode.postMessage({ command: 'getCachedScan' });
    vscode.postMessage({ command: 'getApiStatus' });
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);

  const sendMessage = (command: string, data?: any) => {
    vscode.postMessage({ command, ...data });
  };

  const navigateTo = (view: string) => {
    setCurrentView(view as View);
    setError(null);
  };

  const renderView = () => {
    switch (currentView) {
      case 'analyze':
        return (
          <AnalyzeView
            data={scanData}
            onNavigate={navigateTo}
            onRefresh={() => {
              setScanIsCached(false);
              sendMessage('analyzeProject', { forceRefresh: true });
            }}
            isCached={scanIsCached}
          />
        );
      case 'architecture':
        return (
          <ArchitectureView
            data={architectureData}
            onRequest={() => sendMessage('architectureMap')}
            onNavigate={navigateTo}
          />
        );
      case 'risk':
        return (
          <RiskView
            data={riskData}
            onRequest={() => sendMessage('riskScan')}
            onNavigate={navigateTo}
          />
        );
      case 'featureFlow':
        return (
          <FeatureFlowView
            data={flowData}
            onRequest={(query: string) => sendMessage('featureFlow', { query })}
            onNavigate={navigateTo}
          />
        );
      case 'explain':
        return <ExplainView data={explainData} onNavigate={navigateTo} />;
      case 'learning':
        return (
          <LearningView
            data={learningData}
            onNavigate={navigateTo}
          />
        );
      case 'chat':
        return (
          <ChatView
            messages={chatMessages}
            onSend={(msg: string) => {
              setChatMessages((prev) => [...prev, { role: 'user', content: msg }]);
              sendMessage('chat', { userMessage: msg });
            }}
            onNavigate={navigateTo}
          />
        );
      default:
        return (
          <Home
            onNavigate={navigateTo}
            onAnalyze={() => sendMessage('analyzeProject')}
            onSetApiKey={() => sendMessage('setApiKey')}
            onConnectZerly={() => sendMessage('connectZerly')}
            onPasteApiKey={() => sendMessage('pasteApiKey')}
            apiKeyConfigured={apiKeyConfigured}
          />
        );
    }
  };

  return (
    <div className="zerly-app">
      {loading && <LoadingOverlay feature={loadingFeature} />}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {renderView()}
    </div>
  );
}
