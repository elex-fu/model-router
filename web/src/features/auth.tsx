import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { get, post } from '../api/client';
import type { Config } from '../api/types';
import { ErrorNotice, Field, SaveButton } from '../components/ui';
import { RouterBrand, RouterMark } from '../components/router-brand';
import './auth.css';

function AuthPortal({
  active,
  children,
}: {
  active: 'login' | 'register';
  children: ReactNode;
}) {
  useEffect(() => {
    const previous = document.title;
    document.title = `${active === 'login' ? '登录' : '首次注册'} · ModelRouter`;
    return () => {
      document.title = previous;
    };
  }, [active]);
  return (
    <div className="auth-portal">
      <header className="portal-header">
        <RouterBrand />
        <a className="portal-home-link" href="/admin/">
          回到首页 <span aria-hidden="true">↗</span>
        </a>
      </header>
      <main className="portal-main">
        <section className="portal-story" aria-label="你的个人 AI 网关">
          <span className="portal-eyebrow">YOUR PERSONAL AI GATEWAY</span>
          <h2>
            {active === 'login' ? (
              <>
                欢迎回来。
                <br />
                <span>继续你的创造。</span>
              </>
            ) : (
              <>
                从这里，
                <br />
                <span>连接更多可能。</span>
              </>
            )}
          </h2>
          <p>
            你的模型，你的工作流。
            <br />
            在同一个入口，找到合适的下一步。
          </p>
          <div className="portal-art" aria-hidden="true">
            <div className="portal-ring ring-one" />
            <div className="portal-ring ring-two" />
            <div className="portal-ring ring-three" />
            <div className="portal-art-mark">
              <RouterMark />
            </div>
            <span className="portal-art-node art-node-one">{'{ }'}</span>
            <span className="portal-art-node art-node-two">✳</span>
            <span className="portal-art-node art-node-three">›_</span>
            <span className="portal-art-label">
              ONE CONNECTION. YOUR POSSIBILITIES.
            </span>
          </div>
          <div className="portal-story-foot">
            <span /> 本地部署 · 密钥由你掌控
          </div>
        </section>
        <section
          className="portal-card"
          aria-label={active === 'login' ? '账号登录' : '首次管理员注册'}
        >
          <nav className="portal-tabs" aria-label="账号入口">
            <Link
              to="/login"
              aria-current={active === 'login' ? 'page' : undefined}
            >
              登录
            </Link>
            <Link
              to="/register"
              aria-current={active === 'register' ? 'page' : undefined}
            >
              首次注册
            </Link>
          </nav>
          {children}
        </section>
      </main>
      <footer className="portal-footer">
        <span>© {new Date().getFullYear()} ModelRouter</span>
        <span>由你部署，为你服务。</span>
      </footer>
    </div>
  );
}

export function Login({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const [password, setPassword] = useState('');
  const [name, setName] = useState('admin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    onBusyChange?.(true);
    setError(undefined);
    try {
      await post('/session', { name, password });
      setPassword('');
      const destination = (location.state as { from?: string } | null)?.from;
      const config = destination
        ? undefined
        : (await get<Config>('/config')).data;
      // Resolve the target before refreshing the session can redirect /login.
      await qc.invalidateQueries({ queryKey: ['session'] });
      navigate(
        destination ??
          (Array.isArray(config?.upstreams) && !config.upstreams.length
            ? '/setup/guide'
            : '/overview'),
        { replace: true },
      );
    } catch (err) {
      setError(err);
      onBusyChange?.(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthPortal active="login">
      <span className="portal-card-kicker">WELCOME BACK</span>
      <h1>登录</h1>
      <p className="portal-description">
        进入你的模型工作台，继续上一次的灵感。
      </p>
      <ErrorNotice error={error} />
      <form onSubmit={submit}>
        <Field label="用户名">
          <input
            required
            autoComplete="username"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="密码">
          <input
            required
            type="password"
            autoComplete="current-password"
            placeholder="输入你的管理员密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <SaveButton busy={busy}>登录</SaveButton>
      </form>
      <p className="portal-form-note">
        使用当前实例的管理员账号登录。访问 Key 用于模型调用。
      </p>
      <div className="portal-card-bottom">
        <span>第一次使用新实例？</span>
        <Link to="/register">
          首次注册 <span aria-hidden="true">↗</span>
        </Link>
      </div>
    </AuthPortal>
  );
}
export function Setup({ initialized = false }: { initialized?: boolean }) {
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('admin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await post('/bootstrap', { token, name, password });
      setToken('');
      setPassword('');
      await qc.invalidateQueries();
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  if (initialized)
    return (
      <AuthPortal active="register">
        <span className="portal-card-kicker">YOU ARE ALREADY CONNECTED</span>
        <h1>实例已完成注册</h1>
        <p className="portal-description">
          这台实例已经有管理员账号，直接登录即可开始使用。
        </p>
        <div className="portal-registered">
          <span aria-hidden="true">✓</span>
          <div>
            <strong>你的个人工作台已就绪</strong>
            <p>首次注册用于新实例初始化，已有账号和配置会继续保留。</p>
          </div>
        </div>
        <Link className="portal-login-link" to="/login">
          前往登录 <span aria-hidden="true">→</span>
        </Link>
        <p className="portal-form-note">请使用当前实例的管理员用户名和密码。</p>
      </AuthPortal>
    );
  return (
    <AuthPortal active="register">
      <span className="portal-card-kicker">LET'S GET YOU CONNECTED</span>
      <h1>创建管理员</h1>
      <p className="portal-description">为这台新实例创建你的第一个账号。</p>
      <ErrorNotice error={error} />
      <form onSubmit={submit}>
        <Field label="初始化令牌">
          <input
            required
            type="password"
            autoComplete="off"
            placeholder="输入本机启动时提供的令牌"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        <Field label="管理员用户名">
          <input
            required
            autoComplete="username"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="管理员密码">
          <input
            required
            type="password"
            minLength={12}
            autoComplete="new-password"
            placeholder="至少 12 个字符"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <SaveButton busy={busy}>创建管理员</SaveButton>
      </form>
      <p className="portal-form-note">
        初始化令牌由本机服务提供，仅用于首次创建管理员。
      </p>
    </AuthPortal>
  );
}
