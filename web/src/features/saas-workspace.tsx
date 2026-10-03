import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import {
  SaasApiError, saasClient, type InvitationResult, type InvitationRole, type Project,
  type SafeIdentity, type SafeSession, type SafeTenant,
  type TenantMemberStatus,
} from '../api/saas-client';
import { Badge, Field, Panel } from '../components/ui';
import {
  canManageWorkspace, readWorkspaceDraft, removeWorkspaceDraft, selectWorkspaceProject,
  selectWorkspaceTenant, workspaceErrorMessage, workspaceInvitationLink, workspaceInvitationRoles,
  workspaceMutationUnknown, workspaceProjectsKey, workspaceRoleLabels, workspaceTenantsKey,
  workspaceMembersKey,
  writeWorkspaceDraft, type WorkspaceDraft, type WorkspaceDraftScope,
} from './saas-workspace-state';

function useMounted() {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return mounted;
}

function useWorkspaceDraft(scope: WorkspaceDraftScope) {
  // Callers key forms by user/tenant/role; never hydrate another tenant's draft.
  const [draft, setDraft] = useState<WorkspaceDraft>(() => readWorkspaceDraft(scope));
  const snapshot = useRef(draft);
  function update(patch: WorkspaceDraft) {
    const next = { ...snapshot.current, ...patch };
    snapshot.current = next;
    // Synchronous write-ahead uncertainty marker before POST, even if the tab
    // reloads while the request is in flight. No secret is part of this snapshot.
    writeWorkspaceDraft(scope, next);
    setDraft(next);
  }
  function clear() { removeWorkspaceDraft(scope); snapshot.current = {}; setDraft({}); }
  return { draft, update, clear };
}

export function WorkspaceErrorNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  return <div className="notice error" role="alert">
    <strong>{workspaceErrorMessage(error)}</strong>
    {retry && <button type="button" onClick={retry}>刷新权限与列表</button>}
  </div>;
}

function WorkspaceState({ loading, error, empty, retry, label, children }: {
  loading: boolean; error: unknown; empty?: string; retry: () => void; label: string; children: ReactNode;
}) {
  if (loading) return <div role="status" aria-label={`正在加载${label}`}>正在加载{label}…</div>;
  if (error) return <WorkspaceErrorNotice error={error} retry={retry} />;
  if (empty) return <p className="muted" role="status">{empty}</p>;
  return <>{children}</>;
}

function UncertainResult({ uncertain, acknowledge }: { uncertain?: boolean; acknowledge: () => void }) {
  if (!uncertain) return null;
  return <div className="notice" role="alert">
    <strong>上次提交结果尚未确认，请勿直接重复提交。</strong>
    <span>请刷新并核对已创建的租户、项目或邀请。邀请令牌无法恢复；重试可能产生冲突。</span>
    <button type="button" onClick={acknowledge}>我已核对上次结果，允许手动重试</button>
  </div>;
}

function TenantCreation({ userId, disabled, onError, onCreated }: {
  userId: string; disabled: boolean; onError: (error: unknown) => void; onCreated: (tenant: SafeTenant) => void;
}) {
  const { draft, update, clear } = useWorkspaceDraft({ userId, kind: 'tenant' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [created, setCreated] = useState<SafeTenant>();
  const flight = useRef(false);
  const mounted = useMounted();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || flight.current || draft.uncertain || !draft.name?.trim()) return;
    flight.current = true; setBusy(true); setError(undefined); setCreated(undefined); update({ uncertain: true });
    try {
      const tenant = await saasClient.createTenant({ name: draft.name.trim(), ...(draft.slug?.trim() ? { slug: draft.slug.trim() } : {}) });
      if (!mounted.current) return;
      clear(); setCreated(tenant); onCreated(tenant);
    } catch (err) {
      if (!mounted.current) return;
      setError(err); update({ uncertain: workspaceMutationUnknown(err) }); onError(err);
    } finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  return <Panel title="创建租户">
    <form onSubmit={submit}>
      <Field label="租户名称"><input required maxLength={120} value={draft.name ?? ''} onChange={e => update({ name: e.target.value })} /></Field>
      <Field label="租户标识（可选）" hint="留空时由服务端生成。"><input maxLength={64} value={draft.slug ?? ''} onChange={e => update({ slug: e.target.value })} /></Field>
      <WorkspaceErrorNotice error={error} />
      <UncertainResult uncertain={!busy && draft.uncertain} acknowledge={() => update({ uncertain: false })} />
      {created && <p role="status">租户已创建：{created.name} · {workspaceRoleLabels[created.role]}</p>}
      <button className="primary" disabled={disabled || busy || draft.uncertain === true}>{busy ? '创建中…' : '创建租户'}</button>
    </form>
    <small>名称和标识草稿仅在当前标签页保留 30 分钟。</small>
  </Panel>;
}

function TenantActions({ userId, tenant, disabled, onError, refreshProjects }: {
  userId: string; tenant: SafeTenant; disabled: boolean; onError: (error: unknown) => void; refreshProjects: () => void;
}) {
  const projectDraft = useWorkspaceDraft({ userId, tenantId: tenant.id, kind: 'project' });
  const inviteDraft = useWorkspaceDraft({ userId, tenantId: tenant.id, kind: 'invitation' });
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [projectError, setProjectError] = useState<unknown>();
  const [inviteError, setInviteError] = useState<unknown>();
  const [createdProject, setCreatedProject] = useState<Project>();
  const [invitation, setInvitation] = useState<InvitationResult>();
  const [copyMessage, setCopyMessage] = useState('');
  const projectFlight = useRef(false);
  const inviteFlight = useRef(false);
  const mounted = useMounted();
  const roles = workspaceInvitationRoles(tenant.role);
  const role = inviteDraft.draft.role && roles.includes(inviteDraft.draft.role) ? inviteDraft.draft.role : 'developer';
  const link = invitation && typeof window !== 'undefined' ? workspaceInvitationLink(invitation.token, window.location.href) : '';

  async function createProject(event: FormEvent) {
    event.preventDefault();
    if (disabled || !canManageWorkspace(tenant.role) || projectFlight.current || projectDraft.draft.uncertain || !projectDraft.draft.name?.trim()) return;
    projectFlight.current = true; setProjectBusy(true); setProjectError(undefined); setCreatedProject(undefined); projectDraft.update({ uncertain: true });
    try {
      const project = await saasClient.createProject(tenant.id, {
        name: projectDraft.draft.name.trim(), ...(projectDraft.draft.slug?.trim() ? { slug: projectDraft.draft.slug.trim() } : {}),
      });
      if (!mounted.current) return;
      projectDraft.clear(); setCreatedProject(project); refreshProjects();
    } catch (err) {
      if (!mounted.current) return;
      setProjectError(err); projectDraft.update({ uncertain: workspaceMutationUnknown(err) }); onError(err);
    } finally { projectFlight.current = false; if (mounted.current) setProjectBusy(false); }
  }

  async function createInvitation(event: FormEvent) {
    event.preventDefault();
    if (disabled || inviteFlight.current || inviteDraft.draft.uncertain || !roles.includes(role)) return;
    inviteFlight.current = true; setInviteBusy(true); setInviteError(undefined); setCopyMessage(''); setInvitation(undefined); inviteDraft.update({ uncertain: true });
    try {
      const result = await saasClient.createInvitation(tenant.id, { email, role });
      if (!mounted.current) return;
      // Never store a response/token in a query/mutation cache or browser storage.
      inviteDraft.clear(); setInvitation(result); setEmail(''); setInviting(false);
    } catch (err) {
      if (!mounted.current) return;
      setInviteError(err); inviteDraft.update({ uncertain: workspaceMutationUnknown(err) }); onError(err);
    } finally { inviteFlight.current = false; if (mounted.current) setInviteBusy(false); }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      if (mounted.current) setCopyMessage('邀请链接已复制');
    } catch { if (mounted.current) setCopyMessage('复制失败，请手动选择并复制链接。'); }
  }

  if (!canManageWorkspace(tenant.role)) return <p className="muted">当前租户角色不能创建项目或邀请成员。</p>;
  return <Panel title="项目与邀请操作">
    <form className="saas-project-form" onSubmit={createProject}>
      <Field label="项目名称"><input required maxLength={120} value={projectDraft.draft.name ?? ''} onChange={e => projectDraft.update({ name: e.target.value })} /></Field>
      <Field label="项目标识（可选）" hint="留空时由服务端生成。"><input maxLength={64} value={projectDraft.draft.slug ?? ''} onChange={e => projectDraft.update({ slug: e.target.value })} /></Field>
      <WorkspaceErrorNotice error={projectError} />
      <UncertainResult uncertain={!projectBusy && projectDraft.draft.uncertain} acknowledge={() => projectDraft.update({ uncertain: false })} />
      {createdProject && <p role="status">项目已创建：{createdProject.name} · {createdProject.slug}</p>}
      <button className="primary" disabled={disabled || projectBusy || projectDraft.draft.uncertain === true}>{projectBusy ? '创建中…' : '创建项目'}</button>
    </form>
    <div className="actions"><button type="button" disabled={disabled || inviteBusy} onClick={() => setInviting(value => !value)}>邀请成员</button></div>
    {inviting && <form className="saas-invite-form" onSubmit={createInvitation}>
      <Field label="成员邮箱" hint="邮箱只保留在内存中，刷新后需重新填写。"><input required type="email" maxLength={254} autoComplete="off" value={email} onChange={e => setEmail(e.target.value)} /></Field>
      <Field label="邀请租户角色"><select value={role} onChange={e => {
        const candidate = e.target.value as InvitationRole;
        if (roles.includes(candidate)) inviteDraft.update({ role: candidate });
      }}>{roles.map(value => <option key={value} value={value}>{workspaceRoleLabels[value]}</option>)}</select></Field>
      <WorkspaceErrorNotice error={inviteError} />
      <UncertainResult uncertain={!inviteBusy && inviteDraft.draft.uncertain} acknowledge={() => inviteDraft.update({ uncertain: false })} />
      <button className="primary" disabled={disabled || inviteBusy || inviteDraft.draft.uncertain === true}>{inviteBusy ? '创建中…' : '创建一次性邀请'}</button>
    </form>}
    {invitation && !disabled && <div className="notice secret saas-invitation" role="status">
      <strong>邀请已创建</strong>
      <span>请立即复制并安全发送；刷新、切换租户或隐藏后无法恢复。过期时间：{new Date(invitation.expiresAt).toLocaleString('zh-CN')}</span>
      <input aria-label="一次性邀请链接" readOnly value={link} onFocus={e => e.currentTarget.select()} />
      <div className="actions">
        <button type="button" onClick={() => { void copyLink(); }}>复制邀请链接</button>
        <a href={link} referrerPolicy="no-referrer">打开接受邀请</a>
        <button type="button" onClick={() => { setInvitation(undefined); setCopyMessage(''); }}>隐藏链接</button>
      </div>
      {copyMessage && <small role="status">{copyMessage}</small>}
    </div>}
    <small>仅项目名称、标识和邀请角色可跨刷新保留。成员变更、移除和 Owner 转移尚未提供。</small>
  </Panel>;
}

const memberStatusLabels: Record<TenantMemberStatus, string> = {
  active: '有效', suspended: '暂停', revoked: '已撤销', disabled: '账户已禁用',
};

function TenantMemberDirectory({ userId, tenant, authorityReady, onError }: {
  userId: string; tenant: SafeTenant; authorityReady: boolean; onError: (error: unknown) => void;
}) {
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const cursor = cursors.at(-1);
  const allowed = canManageWorkspace(tenant.role);
  const members = useQuery({
    queryKey: workspaceMembersKey(userId, tenant.id, cursor),
    queryFn: ({ signal }) => saasClient.getTenantMembers(tenant.id, { limit: 25, cursor, signal }),
    // The selected tenant comes from the authenticated tenant list, but each
    // GET still authorizes at the server. Do not toggle enabled on background
    // refresh: re-enabling an errored query would create an automatic retry loop.
    enabled: allowed, retry: false, staleTime: 0,
  });
  useEffect(() => { if (allowed && members.error) onError(members.error); }, [allowed, members.error, onError]);
  if (!allowed) return <Panel title="租户成员目录"><p className="muted">只有当前有效租户的所有者或管理员可以查看成员目录。</p></Panel>;
  return <Panel title="租户成员目录" action={<button type="button" disabled={!authorityReady || members.isFetching} onClick={() => { void members.refetch(); }}>刷新成员</button>}>
    {!authorityReady ? <p role="status">正在刷新租户权限…</p> : <WorkspaceState label="租户成员" loading={members.isPending || members.isFetching}
      error={members.error} retry={() => { void members.refetch(); }} empty={members.data?.items.length === 0 ? '当前页暂无成员。' : undefined}>
      <table><thead><tr><th>成员</th><th>用户 ID</th><th>租户角色</th><th>状态</th></tr></thead>
        <tbody>{members.data?.items.map(member => <tr key={member.userId}>
          <td>{member.displayName || '未设置姓名'}{member.userId === userId ? '（我）' : ''}</td>
          <td><code>{member.userId}</code></td><td>{workspaceRoleLabels[member.role]}</td>
          <td><Badge tone={member.status === 'active' ? 'good' : 'warn'}>{memberStatusLabels[member.status]} · {member.status}</Badge></td>
        </tr>)}</tbody></table>
    </WorkspaceState>}
    <div className="actions">
      <button type="button" disabled={cursors.length <= 1 || members.isError || members.isFetching || !authorityReady} onClick={() => setCursors(current => current.slice(0, -1))}>上一页成员</button>
      <span>第 {cursors.length} 页 · 每页最多 25 人</span>
      <button type="button" disabled={!members.data?.nextCursor || members.isError || members.isFetching || !authorityReady} onClick={() => {
        const nextCursor = members.data?.nextCursor;
        if (nextCursor) setCursors(current => [...current, nextCursor]);
      }}>下一页成员</button>
    </div>
    <small>只读目录仅显示用户 ID、姓名、租户角色和状态，不提供邮箱、成员变更、移除或 Owner 转移。翻页会重新校验当前权限，不保证跨页数据快照。</small>
  </Panel>;
}

function TenantWorkspace({ session, tenant, authorityReady, onError }: {
  session: SafeSession; tenant: SafeTenant; authorityReady: boolean; onError: (error: unknown) => void;
}) {
  const [params, setParams] = useSearchParams();
  const projects = useQuery({
    queryKey: workspaceProjectsKey(session.userId, tenant.id),
    queryFn: ({ signal }) => saasClient.getProjects(tenant.id, { signal }), retry: false,
  });
  useEffect(() => { if (projects.error) onError(projects.error); }, [projects.error, onError]);
  const project = selectWorkspaceProject(tenant, projects.data ?? [], params.get('projectId'));
  const ready = authorityReady && projects.isSuccess && !projects.isFetching;
  function chooseProject(projectId: string) {
    const next = new URLSearchParams(params); next.set('tenantId', tenant.id); next.set('projectId', projectId); setParams(next);
  }
  return <>
    <Panel title="租户详情">
      <div className="summary-list">
        <div><span>租户名称</span><strong>{tenant.name}</strong></div>
        <div><span>租户 ID</span><code>{tenant.id}</code></div>
        <div><span>租户标识</span><code>{tenant.slug}</code></div>
        <div><span>租户状态</span><Badge tone="good">正常 · active</Badge></div>
        <div><span>我的租户角色</span><Badge>{workspaceRoleLabels[tenant.role]}</Badge></div>
        <div><span>我的租户成员状态</span><strong>有效成员 · active</strong></div>
        <div><span>创建时间</span><strong>{new Date(tenant.createdAt).toLocaleString('zh-CN')}</strong></div>
        <div><span>更新时间</span><strong>{new Date(tenant.updatedAt).toLocaleString('zh-CN')}</strong></div>
      </div>
      <small>有效成员状态来自服务端列表的 active/未禁用过滤；权限仍以每次服务端校验为准。</small>
    </Panel>
    <Panel title="当前租户项目">
      <WorkspaceState loading={projects.isPending} error={projects.error} label="项目" retry={() => { void projects.refetch(); }}
        empty={projects.data?.length === 0 ? '当前租户暂无可访问项目。' : undefined}>
        <p className="muted">只显示当前用户有权访问的项目；项目角色与租户角色分别授权。</p>
        <div className="saas-project-list">{projects.data?.map(item => <button className="row" type="button" key={item.id}
          aria-pressed={project?.id === item.id} onClick={() => chooseProject(item.id)}>
          <span><strong>{item.name}</strong><small>{item.slug}</small></span>
          <Badge>{workspaceRoleLabels[item.role]}{item.id === tenant.defaultProjectId ? ' · 默认' : ''}</Badge>
        </button>)}</div>
        {project ? <div className="summary-list" aria-label="项目详情">
          <div><span>项目名称</span><strong>{project.name}</strong></div>
          <div><span>项目 ID</span><code>{project.id}</code></div>
          <div><span>项目标识</span><code>{project.slug}</code></div>
          <div><span>我的项目角色</span><Badge>{workspaceRoleLabels[project.role]}</Badge></div>
          <div><span>我的项目成员状态</span><strong>有效成员 · active</strong></div>
          <div><span>项目生命周期状态</span><strong>当前 API 未提供</strong></div>
          <div><span>创建时间</span><strong>{new Date(project.createdAt).toLocaleString('zh-CN')}</strong></div>
          <div><span>更新时间</span><strong>{new Date(project.updatedAt).toLocaleString('zh-CN')}</strong></div>
        </div> : params.has('projectId') && <p role="alert">指定项目不在当前租户的可访问列表中。</p>}
      </WorkspaceState>
    </Panel>
    <TenantMemberDirectory key={`${session.userId}:${tenant.id}:${tenant.role}`} userId={session.userId} tenant={tenant}
      authorityReady={authorityReady} onError={onError} />
    <TenantActions key={`${session.userId}:${tenant.id}:${tenant.role}`} userId={session.userId} tenant={tenant}
      disabled={!ready} onError={onError} refreshProjects={() => { void projects.refetch(); }} />
  </>;
}

export function WorkspaceContent({ session, onSessionExpired }: { session: SafeSession; onSessionExpired: () => void }) {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tenants = useQuery({ queryKey: workspaceTenantsKey(session.userId), queryFn: ({ signal }) => saasClient.getTenants({ signal }), retry: false });
  const tenant = selectWorkspaceTenant(tenants.data ?? [], params.get('tenantId'));
  const ready = tenants.isSuccess && !tenants.isFetching;
  // Keep callbacks stable without putting server errors or selectors into persistent state.
  const expireRef = useRef(onSessionExpired); expireRef.current = onSessionExpired;
  const errorHandler = useRef<(error: unknown) => void>(() => {});
  errorHandler.current = error => {
    if (!(error instanceof SaasApiError)) return;
    if (error.status === 401) expireRef.current();
    else if (error.status === 403 || error.status === 404) void queryClient.invalidateQueries({ queryKey: workspaceTenantsKey(session.userId) });
  };
  const onError = useRef((error: unknown) => errorHandler.current(error)).current;
  useEffect(() => { if (tenants.error instanceof SaasApiError && tenants.error.status === 401) expireRef.current(); }, [tenants.error]);
  function chooseTenant(tenantId: string) {
    const next = new URLSearchParams(params); next.set('tenantId', tenantId); next.delete('projectId'); setParams(next);
  }
  return <>
    <div className="grid-two">
      <Panel title="当前身份"><div className="summary-list">
        <div><span>用户 ID</span><code>{session.userId}</code></div>
        <div><span>会话有效期至</span><strong>{new Date(session.expiresAt).toLocaleString('zh-CN')}</strong></div>
        <div><span>可访问租户</span><strong>{tenants.isSuccess ? tenants.data.length : '—'}</strong></div>
      </div></Panel>
      <TenantCreation key={session.userId} userId={session.userId} disabled={!ready} onError={onError} onCreated={created => {
        chooseTenant(created.id);
        void queryClient.invalidateQueries({ queryKey: ['saas-console', 'tenants'] });
      }} />
    </div>
    <Panel title="我的租户" action={<button type="button" onClick={() => { void tenants.refetch(); }}>刷新工作空间</button>}>
      <WorkspaceState loading={tenants.isPending} error={tenants.error} label="租户" retry={() => { void tenants.refetch(); }}
        empty={tenants.data?.length === 0 ? '暂无可访问租户；可创建租户，或通过有效邀请加入。' : undefined}>
        <div className="saas-tenant-list">{tenants.data?.map(item => <button type="button" className="row" key={item.id}
          aria-pressed={tenant?.id === item.id} onClick={() => chooseTenant(item.id)}>
          <span><strong>{item.name}</strong><small>{item.slug}</small></span><Badge>{workspaceRoleLabels[item.role]}</Badge>
        </button>)}</div>
        {!tenant && params.has('tenantId') && <p role="alert">指定租户不可访问；不会自动切换到其他租户。</p>}
      </WorkspaceState>
    </Panel>
    {tenant && !tenants.isError && <TenantWorkspace key={`${session.userId}:${tenant.id}:${tenant.role}`} session={session}
      tenant={tenant} authorityReady={ready} onError={onError} />}
  </>;
}

/** Existing accept route only; no public mint endpoint and no implicit login. */
export function WorkspaceInvitationAcceptance() {
  const location = useLocation();
  const { draft, update, clear } = useWorkspaceDraft({ userId: 'invited-visitor', kind: 'accept' });
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState<SafeIdentity>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const flight = useRef(false);
  const mounted = useMounted();
  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (value && value.length <= 512) setToken(value);
    if (window.location.hash) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  }, [location.hash, location.pathname, location.search]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (flight.current || draft.uncertain || !token || !draft.name?.trim()) return;
    flight.current = true; setBusy(true); setError(undefined); update({ uncertain: true });
    try {
      const identity = await saasClient.acceptInvitation({ token, email, displayName: draft.name.trim(), password });
      if (!mounted.current) return;
      clear(); setAccepted(identity); setToken(''); setEmail(''); setPassword('');
    } catch (err) {
      if (!mounted.current) return;
      setError(err); setPassword(''); update({ uncertain: workspaceMutationUnknown(err) });
    } finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  if (accepted) return <><h1>邀请已接受</h1><p className="muted">{accepted.email} 已加入工作空间。请登录以继续；接受邀请不会自动创建会话。</p>
    <Link className="button-link primary" to="/console/login">前往登录</Link></>;
  return <>
    <h1>接受邀请</h1><p className="muted">填写邀请邮箱和个人信息以加入工作空间。此页面不开放公开注册。</p>
    <WorkspaceErrorNotice error={error} />
    <form onSubmit={submit}>
      <Field label="邀请令牌"><input required type="password" autoComplete="off" maxLength={512} value={token} onChange={e => setToken(e.target.value)} /></Field>
      <Field label="邮箱"><input required type="email" maxLength={254} autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></Field>
      <Field label="姓名"><input required maxLength={120} autoComplete="name" value={draft.name ?? ''} onChange={e => update({ name: e.target.value })} /></Field>
      <Field label="密码" hint="已有账户请使用当前密码；新账户将设置此密码。此流程不会重置已有密码。"><input required type="password" minLength={12} autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} /></Field>
      <UncertainResult uncertain={!busy && draft.uncertain} acknowledge={() => update({ uncertain: false })} />
      <button className="primary" disabled={busy || draft.uncertain === true}>{busy ? '接受中…' : '接受邀请'}</button>
    </form>
    <small>仅姓名草稿可跨刷新保留；邮箱、密码和邀请令牌不持久化，失败后需重新填写密码。</small>
  </>;
}
