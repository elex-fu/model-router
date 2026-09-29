import type { ReactNode, FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { ApiError, getRevision } from '../api/client';
import type { SeriesPoint } from '../api/types';

export const formatNumber = (n?: number | null) => n == null ? '未知' : new Intl.NumberFormat('zh-CN').format(n);
export const formatDate = (s?: string | null) => s ? new Date(s).toLocaleString('zh-CN') : '—';
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'bad' | 'warn' }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : '请求失败';
  return <div className="notice error" role="alert"><strong>{error instanceof ApiError && error.status === 412 ? '配置版本冲突' : '操作失败'}</strong><span>{message}</span>{onRetry && <button type="button" onClick={onRetry}>重试</button>}</div>;
}
export function State({ loading, error, empty, children, retry, emptyAction }: { loading?: boolean; error?: unknown; empty?: boolean; children: ReactNode; retry?: () => void; emptyAction?: ReactNode }) {
  if (loading) return <div className="skeleton" aria-label="加载中"><i/><i/><i/></div>;
  if (error) return <ErrorNotice error={error} onRetry={retry}/>;
  if (empty) return <div className="empty"><p>暂无数据</p>{emptyAction}</div>;
  return <>{children}</>;
}
export function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) { return <section className="panel"><div className="panel-head"><h2>{title}</h2>{action}</div>{children}</section>; }
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function SaveButton({ busy, children = '保存' }: { busy?: boolean; children?: ReactNode }) { return <button className="primary" type="submit" disabled={busy}>{busy ? '处理中…' : children}</button>; }
export function useDraftGuard(dirty: boolean) { useEffect(() => { const listener = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); }; window.addEventListener('beforeunload', listener); return () => window.removeEventListener('beforeunload', listener); }, [dirty]); }
export function JsonEditor<T>({ initial, onSave, busy, label }: { initial: T; onSave: (data: T) => Promise<void>; busy?: boolean; label: string }) {
  const [text, setText] = useState(JSON.stringify(initial, null, 2)); const [error, setError] = useState(''); const dirty = text !== JSON.stringify(initial, null, 2); useDraftGuard(dirty);
  useEffect(() => { if (!dirty) setText(JSON.stringify(initial, null, 2)); }, [initial, dirty]);
  async function submit(e: FormEvent) { e.preventDefault(); try { const value = JSON.parse(text) as T; setError(''); await onSave(value); } catch (err) { setError(err instanceof Error ? err.message : 'JSON 无效'); } }
  return <form onSubmit={submit}><Field label={label}><textarea className="code" rows={17} spellCheck={false} value={text} onChange={e => setText(e.target.value)}/></Field>{error && <p className="form-error" role="alert">{error}</p>}<div className="actions"><SaveButton busy={busy}/><small>当前配置版本：{getRevision() ?? '未知'}</small></div></form>;
}
export function Chart({ points, keyName }: { points: SeriesPoint[]; keyName: 'requests' | 'tokens' | 'errors' }) {
  const values = points.map(p => Number(p[keyName] ?? 0)); const max = Math.max(1, ...values); const path = values.map((v, i) => `${i ? 'L' : 'M'}${(i / Math.max(1, values.length - 1)) * 600},${120 - v / max * 110}`).join(' ');
  return values.length ? <svg className="chart" viewBox="0 0 600 130" preserveAspectRatio="none" role="img" aria-label={`${keyName} 趋势，共 ${values.length} 个数据点`}><path d={path} fill="none" stroke="currentColor" strokeWidth="3"/><path d="M0 125H600" stroke="currentColor" opacity=".2"/></svg> : <div className="empty">此时间范围没有趋势数据</div>;
}
