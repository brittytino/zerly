import React, { useMemo } from "react";

interface HomeProps {
  onNavigate: (view: string) => void;
  onAnalyze: () => void;
  onSetApiKey: () => void;
  onConnectZerly: () => void;
  onPasteApiKey: () => void;
  onSetupProviders: () => void;
  apiKeyConfigured: boolean | null;
  routeMode: string;
  activeProvider: string;
}

const features = [
  {
    id: "analyze",
    codicon: "search",
    title: "Analyze Project",
    description: "Scan codebase, detect frameworks and dependencies",
  },
  {
    id: "architecture",
    codicon: "type-hierarchy",
    title: "Architecture Map",
    description: "Visualize dependency graph and project layers",
  },
  {
    id: "featureFlow",
    codicon: "git-branch",
    title: "Feature Flow",
    description: "Trace call chains for any feature or function",
  },
  {
    id: "risk",
    codicon: "warning",
    title: "Risk Scanner",
    description: "Find complex, fragile, or over-coupled modules",
  },
  {
    id: "explain",
    codicon: "lightbulb",
    title: "Explain Code",
    description: "Select code in editor, then open this view",
  },
  {
    id: "learning",
    codicon: "book",
    title: "Learning Mode",
    description: "Guided tour and reading path for new projects",
  },
  {
    id: "chat",
    codicon: "comment-discussion",
    title: "Chat",
    description: "Ask anything about your codebase",
  },
];

export function Home({
  onNavigate,
  onAnalyze,
  onSetApiKey,
  onConnectZerly,
  onPasteApiKey,
  onSetupProviders,
  apiKeyConfigured,
  routeMode,
  activeProvider,
}: HomeProps) {
  const quickOpenOptions = useMemo(
    () => [
      { id: "", label: "Quick Open" },
      { id: "analyze", label: "Analyze Project" },
      { id: "architecture", label: "Architecture Map" },
      { id: "featureFlow", label: "Feature Flow" },
      { id: "risk", label: "Risk Scanner" },
      { id: "explain", label: "Explain Code" },
      { id: "learning", label: "Learning Mode" },
      { id: "chat", label: "Chat" },
    ],
    []
  );

  const handleFeature = (id: string) => {
    if (id === "analyze") onAnalyze();
    else onNavigate(id);
  };

  const onQuickOpenChange = (value: string) => {
    if (!value) return;
    handleFeature(value);
  };

  return (
    <div className="home-view">
      {apiKeyConfigured === false && (
        <div className="api-key-notice">
          <div className="api-key-notice-body">
            <span className="api-key-notice-title">Connect your Zerly account to activate AI features.</span>
          </div>
          <div className="api-key-notice-actions">
            <button className="api-key-notice-btn" onClick={onConnectZerly}>Connect Zerly</button>
            <button className="api-key-notice-btn ghost" onClick={onPasteApiKey}>Paste key</button>
          </div>
        </div>
      )}
      {apiKeyConfigured === true && routeMode !== 'zerly_default' && (
        <div className="provider-status-bar">
          <span className="provider-status-label">
            {routeMode === 'provider_override' ? `✓ Using ${activeProvider}` : `✓ Auto (${activeProvider} → Zerly)`}
          </span>
          <button className="provider-setup-btn" onClick={onSetupProviders} title="Configure AI providers">
            <i className="codicon codicon-settings-gear" /> Providers
          </button>
        </div>
      )}
      <div className="quick-actions">
        <button className="quick-action-btn primary" onClick={onAnalyze} title="Analyze Project (Ctrl+Alt+A)">
          <i className="codicon codicon-search" />
          <span>Analyze</span>
        </button>
        <button className="quick-action-btn" onClick={() => onNavigate("chat")} title="Open Chat (Ctrl+Alt+C)">
          <i className="codicon codicon-comment-discussion" />
          <span>Chat</span>
        </button>
        <button className="icon-btn" onClick={onSetApiKey} title="Configure Zerly API Key">
          <i className="codicon codicon-key" />
        </button>
        <button className="icon-btn" onClick={onSetupProviders} title="Setup AI Providers (BYOK)">
          <i className="codicon codicon-settings-gear" />
        </button>
      </div>

      <div className="quick-open-row">
        <label className="section-label">QUICK OPEN</label>
        <div className="select-wrap">
          <select className="panel-select" defaultValue="" onChange={(e) => onQuickOpenChange(e.target.value)}>
            {quickOpenOptions.map((option) => (
              <option key={option.id || "empty"} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <i className="codicon codicon-chevron-down select-chevron" />
        </div>
      </div>

      <div className="section-label">FEATURES</div>
      <div className="nav-list">
        {features.map((feature) => (
          <button
            key={feature.id}
            className="nav-item"
            onClick={() => handleFeature(feature.id)}
            title={feature.description}
          >
            <i className={`codicon codicon-${feature.codicon} nav-item-icon`} />
            <div className="nav-item-body">
              <span className="nav-item-title">{feature.title}</span>
              <span className="nav-item-desc">{feature.description}</span>
            </div>
            <i className="codicon codicon-chevron-right nav-item-chevron" />
          </button>
        ))}
      </div>
    </div>
  );
}
