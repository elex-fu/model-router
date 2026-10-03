import { lazy, useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { focusManager, onlineManager, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiStateEvent, del, get, setCsrfToken, setRevision } from '../api/client';
import type { ApiState } from '../api/client';
import type { System } from '../api/types';
import { Badge, ErrorNotice } from '../components/ui';
import { adminPageKey, RoutePageBoundary } from './route-page-boundary';
import { clearSafeDraft } from './safe-drafts';

// Stable component identities; native imports run only when their existing
// route/auth branch renders. No preload, new auth gate, or feature-state cache.
const Login = lazy(() => import('../features/auth').then(module => ({ default: module.Login })));
const Setup = lazy(() => import('../features/auth').then(module => ({ default: module.Setup })));
const Overview = lazy(() => import('../features/overview').then(module => ({ default: module.Overview })));
const Upstreams = lazy(() => import('../features/upstreams').then(module => ({ default: module.Upstreams })));
const RoutesPage = lazy(() => import('../features/routes').then(module => ({ default: module.RoutesPage })));
const Keys = lazy(() => import('../features/keys').then(module => ({ default: module.Keys })));
const Usage = lazy(() => import('../features/usage').then(module => ({ default: module.Usage })));
const Requests = lazy(() => import('../features/requests').then(module => ({ default: module.Requests })));
const Playground = lazy(() => import('../features/playground').then(module => ({ default: module.Playground })));
const Connect = lazy(() => import('../features/connect').then(module => ({ default: module.Connect })));
const Accounts = lazy(() => import('../features/accounts').then(module => ({ default: module.Accounts })));
const Settings = lazy(() => import('../features/settings').then(module => ({ default: module.Settings })));
const SetupGuide = lazy(() => import('../features/setup-guide').then(module => ({ default: module.SetupGuide })));
const SaasConsoleApp = lazy(() => import('../features/saas-console').then(module => ({ default: module.SaasConsoleApp })));
const SaasPlatformApp = lazy(() => import('../features/saas-platform').then(module => ({ default: module.SaasPlatformApp })));

const nav = [['/overview', '总览'], ['/upstreams', '上游'], ['/routes', '模型与路由'], ['/keys', '访问 Key'], ['/usage', '用量分析'], ['/requests', '请求日志'], ['/playground', '测试台'], ['/connect', '接入指南'], ['/accounts', '账号授权'], ['/settings', '系统设置'], ['/setup/guide', '初始引导']];
const returnRoutes = /^\/(?:overview|upstreams(?:\/[^/]+)?|routes|keys|usage|requests(?:\/[^/]+)?|playground|connect|accounts|settings|setup\/guide)$/;
function safeReturnPath(pathname: string) { return returnRoutes.test(pathname) ? pathname : '/overview'; }
export function App() {
  const { pathname } = useLocation();
  const isSaasConsole = pathname === '/console' || pathname === '/console/keys' || pathname.startsWith('/console/');
  const isSaasPlatform = pathname === '/platform' || pathname.startsWith('/platform/');
  if (isSaasConsole) return <RoutePageBoundary pageKey="console" resetKey={pathname}><SaasConsoleApp/></RoutePageBoundary>;
  if (isSaasPlatform) return <RoutePageBoundary pageKey="platform" resetKey={pathname}><SaasPlatformApp/></RoutePageBoundary>;
  return <AdminApp/>;
}

function AdminApp() {
  const location = useLocation(); const navigate = useNavigate(); const qc = useQueryClient();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [conflict, setConflict] = useState(false);
  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: async () => (await get<{ initialized: boolean }>('/bootstrap')).data, retry: false });
  const session = useQuery({ queryKey: ['session'], queryFn: async () => (await get<{ userId: string }>('/session')).data, retry: false, enabled: boot.data?.initialized === true });

  useEffect(() => {
    const sync = () => {
      const connected = navigator.onLine;
      const wasOnline = onlineManager.isOnline();
      setOnline(connected);
      onlineManager.setOnline(connected);
      focusManager.setFocused(connected && document.visibilityState === 'visible');
      if (connected && !wasOnline) void qc.invalidateQueries({ refetchType: 'active' });
    };
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [qc]);

  useEffect(() => {
    const onApiState = (event: Event) => {
      const state = (event as CustomEvent<ApiState>).detail;
      if (state === 'config-conflict') { setConflict(true); return; }
      if (state !== 'unauthorized' || location.pathname === '/login') return;
      const initialized = qc.getQueryData<{ initialized: boolean }>(['bootstrap']);
      qc.clear();
      if (initialized) qc.setQueryData(['bootstrap'], initialized);
      qc.setQueryData(['session'], null);
      setConflict(false);
      navigate('/login', { replace: true, state: { from: safeReturnPath(location.pathname) } });
    };
    window.addEventListener(apiStateEvent, onApiState);
    return () => window.removeEventListener(apiStateEvent, onApiState);
  }, [location.pathname, navigate, qc]);

  let content;
  if (boot.isPending) content = <div className="center">正在连接管理服务…</div>;
  else if (boot.error) content = <div className="center"><ErrorNotice error={boot.error} onRetry={() => boot.refetch()}/></div>;
  else if (!boot.data?.initialized) content = location.pathname === '/setup' ? <Setup/> : <Navigate to="/setup" replace/>;
  else if (location.pathname === '/login') content = session.data?.userId ? <Navigate to={safeReturnPath((location.state as { from?: string } | null)?.from ?? '/overview')} replace/> : <Login/>;
  else if (session.isPending) content = <div className="center">正在检查会话…</div>;
  else if (session.error || !session.data?.userId) content = <Navigate to="/login" replace state={{ from: safeReturnPath(location.pathname) }}/>;
  else content = <Routes><Route path="/login" element={<Navigate to="/overview" replace/>}/><Route path="/setup" element={<Navigate to="/setup/guide" replace/>}/><Route element={<Shell online={online}/> }><Route path="/overview" element={<Overview/>}/><Route path="/upstreams" element={<Upstreams/>}/><Route path="/upstreams/:id" element={<Upstreams/>}/><Route path="/routes" element={<RoutesPage/>}/><Route path="/keys" element={<Keys/>}/><Route path="/usage" element={<Usage/>}/><Route path="/requests" element={<Requests/>}/><Route path="/requests/:id" element={<Requests/>}/><Route path="/playground" element={<Playground/>}/><Route path="/connect" element={<Connect/>}/><Route path="/accounts" element={<Accounts/>}/><Route path="/settings" element={<Settings/>}/><Route path="/setup/guide" element={<SetupGuide/>}/><Route path="*" element={<Navigate to="/overview" replace/>}/></Route></Routes>;
  return <>{!online && <div className="notice error" role="alert">浏览器已离线，自动刷新已暂停。重连后会更新页面数据。</div>}{conflict && <div className="notice" role="status"><strong>配置已更新</strong><span>请保留当前编辑内容，查看最新配置并核对差异后再保存。</span><button type="button" onClick={() => setConflict(false)}>关闭</button></div>}<RoutePageBoundary resetKey={location.pathname}>{content}</RoutePageBoundary></>;
}
function Shell({ online }: { online: boolean }) {
  const { pathname } = useLocation();
  const qc = useQueryClient(); const navigate = useNavigate(); const [menu, setMenu] = useState(false); const [params, setParams] = useSearchParams(); const sys = useQuery({ queryKey: ['system'], queryFn: async () => (await get<System>('/system')).data, refetchInterval: online && document.visibilityState === 'visible' ? 5000 : false });
  useEffect(() => { if (sys.data?.persistedRevision !== undefined) setRevision(sys.data.persistedRevision); }, [sys.data?.persistedRevision]);
  useEffect(() => {
    if (!online) return;
    const stream = new EventSource('/admin/api/v1/events');
    let connectionOpen = false;
    let resyncPending = true;
    const refreshActive = () => { void qc.invalidateQueries({ refetchType: 'active' }); };
    const onOpen = () => { connectionOpen = true; };
    const onResync = () => {
      if (!connectionOpen || !resyncPending) return;
      resyncPending = false;
      refreshActive();
    };
    stream.addEventListener('open', onOpen);
    stream.addEventListener('resync', onResync);
    ['request.completed', 'upstream.changed', 'config.applied', 'job.progress'].forEach(name => stream.addEventListener(name, refreshActive));
    return () => stream.close();
  }, [online, qc]);
  async function logout() { try { await del('/session'); } finally { clearSafeDraft(); setCsrfToken(undefined); setRevision(undefined); const initialized = qc.getQueryData(['bootstrap']); qc.clear(); qc.setQueryData(['bootstrap'], initialized); qc.setQueryData(['session'], null); navigate('/login'); } }
  return <div className="shell"><a className="skip" href="#main">跳至内容</a><aside className={menu ? 'sidebar open' : 'sidebar'}><div className="brand"><span className="brand-mark">◈</span><div>model-router<small>管理控制台</small></div></div><nav aria-label="主导航">{nav.map(([to, name]) => <NavLink key={to} to={to} onClick={() => setMenu(false)} className={({ isActive }) => isActive ? 'active' : ''}>{name}</NavLink>)}</nav><button className="quiet logout" onClick={logout}>退出登录</button></aside><div className="workspace"><header className="topbar"><button className="menu-toggle" aria-label="切换导航" aria-expanded={menu} onClick={() => setMenu(!menu)}>☰</button><div className="instance"><strong>{sys.data?.instanceId ?? 'model-router'}</strong> <Badge tone={sys.error ? 'bad' : 'good'}>{sys.error ? '连接异常' : sys.data?.status ?? '运行中'}</Badge> <span className="revision">配置 v{sys.data?.persistedRevision ?? '—'}</span></div><div className="toolbar"><select aria-label="时间范围" value={params.get('range') ?? '24h'} onChange={e => { const next = new URLSearchParams(params); next.set('range', e.target.value); setParams(next); }}><option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option></select><button onClick={() => qc.invalidateQueries()}>刷新</button></div></header><main id="main"><RoutePageBoundary pageKey={adminPageKey(pathname)} resetKey={pathname}><Outlet/></RoutePageBoundary></main></div></div>;
}
