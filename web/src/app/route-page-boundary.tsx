import { Component, Suspense, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  resetKey: string;
  pageKey?: string;
}
interface State { failed: boolean; resetKey: string }

// A list and its detail share one page module. Query changes do not enter this
// key at all. Do not key healthy SaaS roots by their path, tenant or session.
export function adminPageKey(pathname: string): string {
  return pathname.split('/')[1] || 'overview';
}

export function RouteLoading() {
  return <div className="center" role="status" aria-live="polite" aria-busy="true">正在加载页面…</div>;
}

/** Presentational boundary only: no API, storage, redirects or automatic retry. */
export class RoutePageBoundary extends Component<Props, State> {
  state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(props: Props, state: State): State | null {
    // Reset a failed page on navigation without remounting a healthy subtree.
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(_cause: unknown): Pick<State, 'failed'> {
    // Never store/render an import URL, error body/stack or feature secret.
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <div className="center">
      <div className="notice error" role="alert">
        <strong>页面加载失败</strong>
        <span>页面暂时无法加载，请重新加载。不会自动重复提交操作。</span>
        <button type="button" onClick={() => window.location.reload()}>重新加载页面</button>
      </div>
    </div>;
    // Reset Suspense only across different modules so a transition has an
    // accessible loading state. Same-module list/detail edits retain identity.
    return <Suspense key={this.props.pageKey} fallback={<RouteLoading/>}>{this.props.children}</Suspense>;
  }
}
