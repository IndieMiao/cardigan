import { type FormEvent, useState } from "react";
import { type CardiganClient, describeError } from "../api.js";
import { RequestFeedback } from "../components/RequestFeedback.js";

/**
 * Login page (M5 plan §4 M5.1/M5.3, §3.2).
 *
 * The password goes to `POST /api/login` once; the session arrives as an
 * HttpOnly cookie the browser keeps, so nothing is stored in the page. On
 * success the app shell reloads `/api/session` instead of trusting the response
 * body.
 */

export interface LoginPageProps {
  readonly client: CardiganClient;
  readonly passwordConfigured: boolean;
  readonly onLoggedIn: () => void | Promise<void>;
}

export function LoginPage({
  client,
  passwordConfigured,
  onLoggedIn,
}: LoginPageProps) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await client.login(password);
      setPassword("");
      await onLoggedIn();
    } catch (failed) {
      setError(describeError(failed));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login">
      <h1 className="brand">Cardigan</h1>
      <p className="login-subtitle">登录 Workbench</p>
      {!passwordConfigured && (
        <p className="notice">
          还没有设置密码。先在终端运行 <code>cardigan web set-password</code>
          ，再回到这里登录。
        </p>
      )}
      <form onSubmit={submit} className="login-form">
        <label htmlFor="password">密码</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="submit" disabled={submitting || password.length === 0}>
          登录
        </button>
      </form>
      <RequestFeedback
        interactive
        pending={submitting}
        pendingMessage="登录中…"
        error={error}
      />
      <p className="hint">
        这个页面只在本机回环地址上提供；从别的设备访问请用 ssh -L 隧道。
      </p>
    </main>
  );
}
