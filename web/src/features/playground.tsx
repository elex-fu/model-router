import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, writeHeaders } from '../api/client';
import type { ProxyKey, Route } from '../api/types';
import { ErrorNotice, Field, Panel } from '../components/ui';
import { readPlaygroundSse, type PlaygroundFrame } from './playground-sse';

export function Playground() {
  const keys=useQuery({queryKey:['keys'],queryFn:async()=>(await get<ProxyKey[]>('/keys')).data}); const routes=useQuery({queryKey:['routes'],queryFn:async()=>(await get<Route[]>('/routes')).data});
  const [keyId,setKeyId]=useState(''); const [model,setModel]=useState(''); const [protocol,setProtocol]=useState('openai'); const [prompt,setPrompt]=useState(''); const [stream,setStream]=useState(false); const [maxTokens,setMaxTokens]=useState('512'); const [temperature,setTemperature]=useState(''); const [output,setOutput]=useState(''); const [summary,setSummary]=useState<unknown>(); const [error,setError]=useState<unknown>(); const [busy,setBusy]=useState(false); const controller=useRef<AbortController|null>(null); const runId=useRef(''); const stopping=useRef(false);
  useEffect(() => () => controller.current?.abort(), []);

  function handleFrame({ event, data }: PlaygroundFrame) {
    if (event === 'error' || data.error !== undefined) {
      const detail = data.error;
      const message = typeof detail === 'string' ? detail : detail && typeof detail === 'object' && 'message' in detail && typeof detail.message === 'string' ? detail.message : '测试流发生错误';
      throw new Error(message);
    }
    if (event === 'started') {
      if (typeof data.runId !== 'string') throw new Error('测试流缺少运行 ID');
      runId.current = data.runId;
    } else if (event === 'delta' || event === 'message') {
      const text = data.delta ?? data.text;
      if (typeof text !== 'string') throw new Error('测试流增量格式无效');
      setOutput(value => value + text);
    } else if (event === 'summary') {
      if (!data.summary || typeof data.summary !== 'object' || Array.isArray(data.summary)) throw new Error('测试流摘要格式无效');
      setSummary(data.summary);
      const result = data.summary as Record<string, unknown>;
      if (result.state === 'failed' || result.state === 'cancelled')
        throw new Error(typeof result.error === 'string' ? result.error : result.state === 'cancelled' ? '测试已取消' : '测试失败');
    }
  }

  async function run(e: FormEvent) {
    e.preventDefault();
    const abort = new AbortController();
    controller.current = abort;
    runId.current = '';
    setBusy(true);
    setError(undefined);
    setOutput('');
    setSummary(undefined);
    try {
      const response = await fetch('/admin/api/v1/playground/runs', {
        method: 'POST', credentials: 'same-origin',
        headers: { ...writeHeaders(), Accept: stream ? 'text/event-stream' : 'application/json' },
        body: JSON.stringify({ keyId, model, protocol, stream, input: prompt, maxOutputTokens: Number(maxTokens), ...(temperature ? { temperature: Number(temperature) } : {}) }),
        signal: abort.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error?.message ?? `请求失败 (${response.status})`);
      }
      if (abort.signal.aborted || controller.current !== abort) return;
      runId.current = response.headers.get('X-Run-Id') ?? '';
      if (stream && response.headers.get('content-type')?.includes('text/event-stream')) {
        if (!response.body) throw new Error('测试流缺少响应正文');
        await readPlaygroundSse(response.body, frame => { if (!abort.signal.aborted) handleFrame(frame); });
      } else {
        const body = await response.json();
        const data = body.data ?? body;
        if (abort.signal.aborted) return;
        runId.current = data.runId ?? runId.current;
        setOutput(data.output ?? data.text ?? '');
        setSummary(data.summary ?? data);
      }
    } catch (err) {
      if (!abort.signal.aborted) setError(err);
    } finally {
      if (controller.current === abort && !stopping.current) { controller.current = null; setBusy(false); }
    }
  }

  async function stop() {
    const active = controller.current;
    if (!active) return;
    stopping.current = true;
    const id = runId.current;
    active.abort();
    try {
      if (id) {
        const response = await fetch(`/admin/api/v1/playground/runs/${encodeURIComponent(id)}/cancel`, {
          method: 'POST', credentials: 'same-origin', headers: writeHeaders(), body: '{}',
        });
        if (!response.ok) throw new Error(`取消测试失败 (${response.status})`);
      }
    } catch (err) { setError(err); }
    finally {
      stopping.current = false;
      if (controller.current === active) controller.current = null;
      setBusy(false);
    }
  }
  const models=[...new Set(routes.data?.flatMap(r=>r.publishedModels)??[])];
  return <><div className="page-title"><div><p className="eyebrow">LAB</p><h1>测试台</h1><p>使用所选访问 Key 的权限与配额；测试流量单独统计</p></div></div><div className="grid-two"><Panel title="请求配置"><form onSubmit={run}><div className="form-grid"><Field label="访问身份"><select required value={keyId} onChange={e=>setKeyId(e.target.value)}><option value="">选择访问 Key</option>{keys.data?.filter(k=>k.enabled).map(k=><option key={k.id} value={k.id}>{k.name}</option>)}</select></Field><Field label="协议"><select value={protocol} onChange={e=>setProtocol(e.target.value)}><option value="openai">OpenAI Chat</option><option value="anthropic">Anthropic Messages</option><option value="responses">Responses</option></select></Field><Field label="客户端模型"><input required list="published-models" value={model} onChange={e=>setModel(e.target.value)}/><datalist id="published-models">{models.map(m=><option key={m} value={m}/>)}</datalist></Field><Field label="最大输出 Token"><input type="number" min="1" value={maxTokens} onChange={e=>setMaxTokens(e.target.value)}/></Field><Field label="Temperature"><input type="number" min="0" max="2" step="0.1" value={temperature} onChange={e=>setTemperature(e.target.value)} placeholder="使用默认值"/></Field></div><Field label="输入"><textarea required rows={8} value={prompt} onChange={e=>setPrompt(e.target.value)}/></Field><label className="check"><input type="checkbox" checked={stream} onChange={e=>setStream(e.target.checked)}/>流式响应</label><div className="actions"><button className="primary" disabled={busy}>{busy?'运行中…':'发送测试'}</button>{busy&&<button type="button" onClick={stop}>停止</button>}</div></form></Panel><Panel title="响应"><ErrorNotice error={error}/>{output?<pre className="response-output">{output}</pre>:<div className="empty">运行测试后在此显示真实响应</div>}{summary!==undefined&&<><h3>路由与用量摘要</h3><pre className="small-code">{JSON.stringify(summary,null,2)}</pre></>}</Panel></div></>;
}
