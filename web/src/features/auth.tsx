import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { get, post } from '../api/client';
import type { Config } from '../api/types';
import { ErrorNotice, Field, SaveButton } from '../components/ui';

export function Login() {
  const [password, setPassword] = useState(''); const [name, setName] = useState('admin'); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(); const qc = useQueryClient(); const navigate = useNavigate(); const location = useLocation();
  async function submit(e: FormEvent) { e.preventDefault(); setBusy(true); setError(undefined); try { await post('/session', { name, password }); setPassword(''); await qc.invalidateQueries({ queryKey: ['session'] }); const destination=(location.state as { from?: string } | null)?.from; const config=destination?undefined:(await get<Config>('/config')).data; navigate(destination ?? (Array.isArray(config?.upstreams)&&!config.upstreams.length?'/setup/guide':'/overview'), { replace: true }); } catch (err) { setError(err); } finally { setBusy(false); } }
  return <div className="auth-page"><div className="auth-card"><div className="brand"><span className="brand-mark">◈</span><div>model-router<small>管理控制台</small></div></div><h1>登录</h1><p className="muted">使用管理员账号访问。代理访问 Key 无法登录控制台。</p><ErrorNotice error={error}/><form onSubmit={submit}><Field label="用户名"><input required autoComplete="username" value={name} onChange={e => setName(e.target.value)}/></Field><Field label="密码"><input required type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)}/></Field><SaveButton busy={busy}>登录</SaveButton></form></div></div>;
}
export function Setup() {
  const [token, setToken] = useState(''); const [password, setPassword] = useState(''); const [name, setName] = useState('admin'); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(); const navigate = useNavigate(); const qc = useQueryClient();
  async function submit(e: FormEvent) { e.preventDefault(); setBusy(true); setError(undefined); try { await post('/bootstrap', { token, name, password }); setToken(''); setPassword(''); await qc.invalidateQueries(); navigate('/login', { replace: true }); } catch (err) { setError(err); } finally { setBusy(false); } }
  return <div className="auth-page"><div className="auth-card"><div className="brand"><span className="brand-mark">◈</span><div>model-router<small>首次设置</small></div></div><h1>创建管理员</h1><p className="muted">输入本机 CLI 生成的一次性初始化令牌。登录后依次添加上游、路由和访问 Key，再用测试台验证。</p><ErrorNotice error={error}/><form onSubmit={submit}><Field label="初始化令牌"><input required type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)}/></Field><Field label="管理员用户名"><input required value={name} onChange={e => setName(e.target.value)}/></Field><Field label="管理员密码"><input required type="password" minLength={12} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}/></Field><SaveButton busy={busy}>创建管理员</SaveButton></form></div></div>;
}
