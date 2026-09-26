import { Component, type ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

/**
 * Last-resort crash guard: without this, any render-time exception unmounts
 * the whole React tree and leaves a dead (blank/black) page — which is what
 * a "JS crash" looks like on a phone. The fallback keeps the app recoverable
 * with a single reload tap.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    console.error("[ErrorBoundary] render crash:", error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div
          className="app"
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "1rem",
            padding: "2rem",
            background: "#000",
            color: "#dcdce6",
            textAlign: "center",
          }}
        >
          <p style={{ fontWeight: 700 }}>Something went wrong playing audio.</p>
          <p style={{ fontSize: "0.85rem", opacity: 0.8 }}>{error.message}</p>
          <button type="button" onClick={this.handleReload}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
