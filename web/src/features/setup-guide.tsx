import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '../api/client';
import type { ProxyKey, Route, Upstream } from '../api/types';
import { Badge, Panel, State } from '../components/ui';

const steps = [
  { title: '选择供应商', help: '选择 Kimi 开放平台、Kimi Code、DeepSeek、自定义服务或 Ollama 本地服务。', href: '/upstreams', action: '配置上游' },
  { title: '设置认证', help: '添加加密凭证或环境变量；Ollama 本地服务可选择「无需认证」。', href: '/upstreams', action: '管理凭证' },
  { title: '确认模型', help: '发现模型或手动输入；发现结果不会自动标记为能力已验证。', href: '/upstreams', action: '配置模型' },
  { title: '发布路由', help: '填写客户端模型别名、协议与候选上游，并预览匹配。', href: '/routes', action: '配置路由' },
  { title: '创建访问 Key', help: '设置模型权限与额度。明文 Key 只在创建时显示一次。', href: '/keys', action: '创建 Key' },
  { title: '验证调用', help: '先在上游详情测试连接，再在测试台使用访问 Key 发起受限请求。', href: '/playground', action: '打开测试台' },
];
export function SetupGuide() {
  const [params,setParams]=useSearchParams(); const index=Math.max(0,Math.min(steps.length-1,Number(params.get('step')??'0')||0));
  const upstreams=useQuery({queryKey:['upstreams'],queryFn:async()=>(await get<Upstream[]>('/upstreams')).data});
  const routes=useQuery({queryKey:['routes'],queryFn:async()=>(await get<Route[]>('/routes')).data});
  const keys=useQuery({queryKey:['keys'],queryFn:async()=>(await get<ProxyKey[]>('/keys')).data});
  const playground=useQuery({queryKey:['playground','status'],queryFn:async()=>(await get<{completed:boolean}>('/playground/status')).data});
  const complete=[!!upstreams.data?.length, !!upstreams.data?.some(u=>u.auth.mode==='none'||u.credentials.some(c=>c.enabled)), !!upstreams.data?.some(u=>u.models.some(m=>m.enabled)), !!routes.data?.some(r=>r.enabled), !!keys.data?.some(k=>k.enabled), playground.data?.completed===true];
  return <><div className="page-title"><div><p className="eyebrow">GET STARTED</p><h1>初始引导</h1><p>从空实例接入一个可用模型</p></div></div><div className="split"><Panel title="配置步骤"><ol className="setup-steps">{steps.map((s,i)=><li key={s.title}><button className={i===index?'selected':''} onClick={()=>setParams({step:String(i)})}>{s.title}</button><Badge tone={complete[i]?'good':'neutral'}>{complete[i]?'已配置':'待完成'}</Badge></li>)}</ol></Panel><Panel title={`${index+1} / ${steps.length} · ${steps[index].title}`}><State loading={upstreams.isPending||routes.isPending||keys.isPending||playground.isPending} error={upstreams.error||routes.error||keys.error||playground.error} retry={()=>{upstreams.refetch();routes.refetch();keys.refetch();playground.refetch();}}><p>{steps[index].help}</p>{index===0&&<p className="muted">本地验证：自定义 OpenAI 兼容 · <code>http://127.0.0.1:11434/v1</code> · <code>qwen2.5-coder:7b</code> · 无需认证。</p>}<p className="muted">当前：{upstreams.data?.length??0} 个上游、{routes.data?.length??0} 条路由、{keys.data?.length??0} 个访问 Key。</p><div className="actions"><Link className="button-link primary" to={steps[index].href}>{steps[index].action} →</Link>{index>0&&<button onClick={()=>setParams({step:String(index-1)})}>上一步</button>}{index<steps.length-1&&<button onClick={()=>setParams({step:String(index+1)})}>下一步</button>}</div></State></Panel></div></>;
}
