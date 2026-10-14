import { useEffect, useState } from 'react';
import { RouterBrand, RouterMark } from '../components/router-brand';
import './landing.css';

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={diagonal ? 'M6 18 18 6M6 6h12v12' : 'M4 12h15m-6-6 6 6-6 6'}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FeatureIcon({ kind }: { kind: 'connect' | 'route' | 'chart' }) {
  const paths = {
    connect:
      'M8 5H5v6h3V5Zm11 0h-3v6h3V5ZM6.5 11v4a5.5 5.5 0 0 0 11 0v-4M12 20v3',
    route: 'M5 5v14h14M5 12h7a7 7 0 0 0 7-7M16 5h3v3M16 16l3 3-3 3',
    chart: 'M4 19h16M6 15v-4m6 4V5m6 10V9',
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={paths[kind]}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ConnectionVisual() {
  return (
    <figure
      className="connection-visual"
      aria-label="连接示意：开发工具通过 ModelRouter 统一连接 Kimi、DeepSeek 与 Ollama"
    >
      <div className="connection-label">
        <span className="connection-dot" /> YOUR AI, CONNECTED
      </div>
      <span className="connection-caption">连接示意</span>
      <div className="connection-orbit orbit-one" />
      <div className="connection-orbit orbit-two" />
      <svg
        className="connection-lines"
        viewBox="0 0 500 390"
        fill="none"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          d="M90 96v35q0 30 30 30h130M250 96v65M410 96v35q0 30-30 30H250M250 220v31q0 26-26 26H90v29M250 220v86M250 277h134q26 0 26 26v3"
          stroke="#b9d5c6"
          strokeWidth="1.3"
        />
        <path
          className="connection-trace"
          d="M250 96v210"
          stroke="#4aa68b"
          strokeWidth="2"
          strokeDasharray="4 11"
        />
      </svg>
      <div className="connection-node source-node source-one">
        <span className="client-symbol">⌘</span>
        <span>Claude Code</span>
      </div>
      <div className="connection-node source-node source-two">
        <span className="client-symbol brackets-symbol">{`{ }`}</span>
        <span>OpenAI SDK</span>
      </div>
      <div className="connection-node source-node source-three">
        <span className="client-symbol terminal-symbol">›_</span>
        <span>Codex CLI</span>
      </div>
      <div className="connection-hub">
        <RouterMark />
        <span>ModelRouter</span>
        <small>ONE ENDPOINT</small>
      </div>
      <div className="connection-node model-node model-one">
        <span className="model-symbol kimi-symbol">K</span>
        <span>Kimi</span>
      </div>
      <div className="connection-node model-node model-two">
        <span className="model-symbol deepseek-symbol">≈</span>
        <span>DeepSeek</span>
      </div>
      <div className="connection-node model-node model-three">
        <span className="model-symbol ollama-symbol">◎</span>
        <span>Ollama</span>
      </div>
      <div className="connection-bottom">
        <span>
          <i /> ONE CONNECTION. MORE POSSIBILITIES.
        </span>
        <span>↗</span>
      </div>
    </figure>
  );
}

const snippets = {
  openai: {
    label: 'OpenAI SDK',
    language: 'Python',
    code: 'from openai import OpenAI\n\nclient = OpenAI(\n    base_url="http://127.0.0.1:15005/v1",\n    api_key="YOUR_PROXY_KEY"\n)\n\nresponse = client.chat.completions.create(\n    model="YOUR_MODEL",\n    messages=[{"role": "user", "content": "Hello!"}]\n)',
  },
  claude: {
    label: 'Claude Code',
    language: 'Shell',
    code: 'export ANTHROPIC_BASE_URL="http://127.0.0.1:15005"\nexport ANTHROPIC_API_KEY="YOUR_PROXY_KEY"\n\n# 使用控制台中配置的模型与路由\nclaude',
  },
  curl: {
    label: 'cURL',
    language: 'Shell',
    code: 'curl http://127.0.0.1:15005/v1/chat/completions \\\n  -H "Authorization: Bearer YOUR_PROXY_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d \'{\n    "model": "YOUR_MODEL",\n    "messages": [{"role": "user", "content": "Hello!"}]\n  }\'',
  },
} as const;

type Client = keyof typeof snippets;

function ConnectExample() {
  const [client, setClient] = useState<Client>('openai');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  useEffect(() => {
    if (copyState === 'idle') return;
    const timeout = window.setTimeout(() => setCopyState('idle'), 2500);
    return () => window.clearTimeout(timeout);
  }, [copyState]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(snippets[client].code);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }
  return (
    <div className="landing-code-window">
      <div className="landing-code-toolbar">
        <div
          className="landing-code-tabs"
          role="group"
          aria-label="选择接入客户端"
        >
          {(Object.keys(snippets) as Client[]).map((key) => (
            <button
              type="button"
              key={key}
              aria-pressed={client === key}
              onClick={() => {
                setClient(key);
                setCopyState('idle');
              }}
            >
              {snippets[key].label}
            </button>
          ))}
        </div>
        <button
          className="landing-copy"
          type="button"
          onClick={() => void copy()}
          aria-label="复制代码"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect
              x="8"
              y="8"
              width="11"
              height="12"
              rx="2"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
          {copyState === 'copied' ? '已复制' : '复制'}
        </button>
      </div>
      <div className="landing-code-meta">
        <span>
          <i />
          <i />
          <i />
        </span>
        <span>{snippets[client].language}</span>
      </div>
      <pre aria-label={`${snippets[client].label} 接入示例`}>
        <code>{snippets[client].code}</code>
      </pre>
      <div className="landing-code-note" role="status" aria-live="polite">
        {copyState === 'failed'
          ? '当前浏览器无法复制，请选择代码后手动复制。'
          : copyState === 'copied'
            ? '代码已复制到剪贴板。请替换访问 Key 与模型名。'
            : '示例使用默认本地地址；请替换访问 Key、模型名及自定义端口。'}
      </div>
    </div>
  );
}

const questions = [
  [
    'ModelRouter 可以帮我做什么？',
    '把多个模型服务连接到一个入口，在熟悉的开发工具中按需选择模型。登录后，你可以管理上游、配置路由、创建访问 Key，并查看调用记录与用量。',
  ],
  [
    '我需要先购买模型服务吗？',
    '云端模型需要你提供相应供应商的凭证。也可以接入本机 Ollama，从本地模型开始体验；实际可用模型取决于你的上游配置。',
  ],
  [
    '第一次使用，怎么注册？',
    '点击右上角登录，再选择首次注册，使用本机启动时提供的初始化令牌创建管理员。已经完成初始化的实例，使用现有管理员账号登录即可。',
  ],
  [
    '现有应用需要重新开发吗？',
    '支持的客户端通常只需修改 Base URL 和访问 Key。先在控制台配置对应模型与路由，再按接入指南连接；不同上游的具体能力以实际验证结果为准。',
  ],
];

export function Landing() {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const previous = document.title;
    document.title = 'ModelRouter · 让模型各尽其能';
    return () => {
      document.title = previous;
    };
  }, []);
  return (
    <div className="landing-page">
      <a className="landing-skip" href="#landing-main">
        跳至主内容
      </a>
      <header className="landing-header">
        <div className="landing-header-inner">
          <RouterBrand />
          <nav
            className={`landing-nav${menuOpen ? ' is-open' : ''}`}
            id="landing-navigation"
            aria-label="首页导航"
          >
            <a href="#features" onClick={() => setMenuOpen(false)}>
              产品能力
            </a>
            <a href="#connect" onClick={() => setMenuOpen(false)}>
              快速接入
            </a>
            <a href="#faq" onClick={() => setMenuOpen(false)}>
              常见问题
            </a>
          </nav>
          <div className="landing-header-actions">
            <a className="landing-login" href="/admin/login">
              登录 <Arrow />
            </a>
            <button
              className="landing-menu"
              type="button"
              aria-label={menuOpen ? '收起导航' : '展开导航'}
              aria-expanded={menuOpen}
              aria-controls="landing-navigation"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <span />
              <span />
            </button>
          </div>
        </div>
      </header>

      <main id="landing-main" className="landing-main">
        <section className="landing-hero" aria-labelledby="landing-hero-title">
          <div className="landing-hero-copy">
            <span className="landing-pill">
              <span /> 为你的 AI 工作流而生 <Arrow diagonal />
            </span>
            <h1 id="landing-hero-title">
              让每个模型，
              <br />
              <span>各尽其能。</span>
              <svg
                className="hero-spark"
                viewBox="0 0 48 48"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M24 3v42M3 24h42M9 9l30 30M9 39 39 9"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
            </h1>
            <p>
              一个入口，连接你的模型世界。
              <br />
              从云端到本地，把选择留给你，把连接交给我们。
            </p>
            <div className="landing-hero-actions">
              <a className="landing-button" href="/admin/login">
                开始使用 <Arrow />
              </a>
              <a className="landing-text-link" href="#connect">
                看看如何接入 <Arrow diagonal />
              </a>
            </div>
            <div className="landing-hero-points">
              <span>
                <i /> 本地部署
              </span>
              <span>
                <i /> 灵活路由
              </span>
              <span>
                <i /> 密钥由你掌控
              </span>
            </div>
          </div>
          <ConnectionVisual />
        </section>

        <section className="landing-tools" aria-label="兼容的开发工具">
          <p>与你熟悉的工具，一起工作</p>
          <div>
            <span className="tool-claude">
              <i>✳</i> Claude Code
            </span>
            <span className="tool-openai">
              <i>{'{ }'}</i> OpenAI SDK
            </span>
            <span className="tool-codex">
              <i>›_</i> Codex CLI
            </span>
            <span className="tool-ollama">
              <i>◎</i> Ollama
            </span>
          </div>
        </section>

        <section
          className="landing-features"
          id="features"
          aria-labelledby="features-title"
        >
          <div className="landing-section-intro">
            <span className="landing-eyebrow">01 / MADE FOR YOUR WORKFLOW</span>
            <h2 id="features-title">
              少一点配置。
              <br />
              多一点创造。
            </h2>
            <p>
              从连接到管理，让模型调用
              <br />
              成为工作流里自然的一部分。
            </p>
            <a className="landing-text-link" href="/admin/login">
              探索你的工作台 <Arrow diagonal />
            </a>
          </div>
          <div className="landing-feature-list">
            <article>
              <span className="landing-feature-icon">
                <FeatureIcon kind="connect" />
              </span>
              <div>
                <h3>一个入口，多种选择</h3>
                <p>
                  兼容 Anthropic 与 OpenAI
                  协议，连接云端服务和本地模型。熟悉的客户端，保持熟悉的用法。
                </p>
              </div>
              <span className="landing-feature-number">01</span>
            </article>
            <article>
              <span className="landing-feature-icon">
                <FeatureIcon kind="route" />
              </span>
              <div>
                <h3>让路由跟上你的节奏</h3>
                <p>
                  配置模型映射、多个上游与访问
                  Key。把复杂的连接规则留在幕后，把合适的模型带到面前。
                </p>
              </div>
              <span className="landing-feature-number">02</span>
            </article>
            <article>
              <span className="landing-feature-icon">
                <FeatureIcon kind="chart" />
              </span>
              <div>
                <h3>每次调用，都有迹可循</h3>
                <p>
                  在同一处查看请求、Token
                  用量与错误记录。从日常使用到排查问题，让每一步都更清楚。
                </p>
              </div>
              <span className="landing-feature-number">03</span>
            </article>
          </div>
        </section>

        <section
          className="landing-connect"
          id="connect"
          aria-labelledby="connect-title"
        >
          <div className="landing-connect-copy">
            <span className="landing-eyebrow">02 / READY WHEN YOU ARE</span>
            <h2 id="connect-title">
              熟悉的工具，
              <br />
              <span>简单连接。</span>
            </h2>
            <p>
              配置好上游与模型路由，
              <br />
              替换地址和访问 Key，即可开始调用。
            </p>
            <ol>
              <li>
                <span>01</span> 登录控制台，添加你的上游
              </li>
              <li>
                <span>02</span> 发布模型路由，创建访问 Key
              </li>
              <li>
                <span>03</span> 复制接入配置，开始创造
              </li>
            </ol>
            <a className="landing-connect-link" href="/admin/login">
              去配置我的连接 <Arrow />
            </a>
          </div>
          <ConnectExample />
        </section>

        <section className="landing-faq" id="faq" aria-labelledby="faq-title">
          <div className="landing-section-intro">
            <span className="landing-eyebrow">03 / A LITTLE CLARITY</span>
            <h2 id="faq-title">
              开始之前，
              <br />
              你可能想知道。
            </h2>
            <p>
              一些简单的答案，
              <br />
              帮你更快开始。
            </p>
          </div>
          <div className="landing-faq-list">
            {questions.map(([question, answer]) => (
              <details key={question}>
                <summary>
                  {question}
                  <span aria-hidden="true">+</span>
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="landing-last-call">
          <span className="landing-eyebrow">YOUR MODELS. YOUR RULES.</span>
          <h2>
            你的 AI，<span>由你连接。</span>
          </h2>
          <p>从一个入口，开启更多可能。</p>
          <a className="landing-button" href="/admin/login">
            进入我的工作台 <Arrow />
          </a>
          <div className="last-call-orbit" aria-hidden="true" />
        </section>
      </main>
      <footer className="landing-footer">
        <RouterBrand />
        <span>由你部署，为你服务。</span>
        <small>© {new Date().getFullYear()} ModelRouter</small>
        <a href="#landing-main">回到顶部 ↑</a>
      </footer>
    </div>
  );
}
