import React from 'react';

interface ErrorBannerProps {
  message: string;
  onDismiss: () => void;
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  return (
    <div className="error-banner">
      <span className="error-icon">⚠</span>
      <span className="error-msg">{message}</span>
      <button className="error-close" onClick={onDismiss} title="Dismiss">✕</button>
    </div>
  );
}
