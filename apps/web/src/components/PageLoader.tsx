import { Component, type ReactNode, Suspense } from "react";
import { RequestFeedback } from "./RequestFeedback.js";

/** A stale tab may request a chunk removed by deployment. Reload the shell. */
export class PageLoader extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <RequestFeedback
          error="页面加载失败，请重新加载。"
          retry={() => window.location.reload()}
          retryLabel="重新加载"
        />
      );
    }
    return (
      <Suspense fallback={<RequestFeedback pending />}>
        {this.props.children}
      </Suspense>
    );
  }
}
