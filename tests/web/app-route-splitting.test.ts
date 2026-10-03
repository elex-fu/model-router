import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as React from 'react';
import { createElement, lazy, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { adminPageKey, RouteLoading, RoutePageBoundary } from '../../web/src/app/route-page-boundary.tsx';

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../../web/src/app/App.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const pages = {
  Login: 'auth', Setup: 'auth', Overview: 'overview', Upstreams: 'upstreams', RoutesPage: 'routes',
  Keys: 'keys', Usage: 'usage', Requests: 'requests', Playground: 'playground', Connect: 'connect',
  Accounts: 'accounts', Settings: 'settings', SetupGuide: 'setup-guide',
  SaasConsoleApp: 'saas-console', SaasPlatformApp: 'saas-platform',
} as const;

function nodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  function visit(node: ts.Node): void {
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root); return result;
}

function withSsrReact<T>(work: () => T): T {
  // The root tsx unit runner uses classic JSX, as in the existing SSR fixtures.
  // Bind only for this synchronous render/assertion scope, including failures.
  const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
  const originalReact = reactGlobal.React;
  reactGlobal.React = React;
  try { return work(); }
  finally {
    if (originalReact === undefined) Reflect.deleteProperty(reactGlobal, 'React');
    else reactGlobal.React = originalReact;
  }
}

// Source graph contracts supplement browser assertions, not built-byte proof.
test('every former static page import is a module-scope lazy native import with its existing named export', () => {
  const imports = nodes(source, ts.isImportDeclaration);
  assert.ok(imports.every(item => !ts.isStringLiteral(item.moduleSpecifier) || !item.moduleSpecifier.text.startsWith('../features/')));
  const topLevel = source.statements.filter(ts.isVariableStatement).flatMap(item => [...item.declarationList.declarations]);
  const lazyNames: string[] = [];
  for (const [name, path] of Object.entries(pages)) {
    const declaration = topLevel.find(item => ts.isIdentifier(item.name) && item.name.text === name);
    const initializer = declaration?.initializer;
    assert.ok(initializer && ts.isCallExpression(initializer));
    assert.ok(ts.isIdentifier(initializer.expression) && initializer.expression.text === 'lazy');
    const factory = initializer.arguments[0]; assert.ok(factory && ts.isArrowFunction(factory));
    const nativeImports = nodes(factory, ts.isCallExpression).filter(item => item.expression.kind === ts.SyntaxKind.ImportKeyword);
    assert.equal(nativeImports.length, 1);
    const specifier = nativeImports[0]?.arguments[0]; assert.ok(specifier && ts.isStringLiteral(specifier));
    assert.equal(specifier.text, `../features/${path}`);
    const defaults = nodes(factory, ts.isPropertyAssignment).filter(item => item.name.getText(source) === 'default');
    assert.equal(defaults.length, 1);
    const selected = defaults[0]?.initializer; assert.ok(selected && ts.isPropertyAccessExpression(selected));
    assert.equal(selected.name.text, name);
    lazyNames.push(name);
  }
  assert.equal(nodes(source, ts.isCallExpression).filter(item => ts.isIdentifier(item.expression) && item.expression.text === 'lazy').length, lazyNames.length,
    'no lazy component declared inside a render/hook or eager extra page load');
});

test('all existing admin route paths and list/detail module identities remain intact', () => {
  const paths = nodes(source, ts.isJsxAttribute).filter(item => item.name.getText(source) === 'path').map(item => {
    assert.ok(item.initializer && ts.isStringLiteral(item.initializer)); return item.initializer.text;
  });
  assert.deepEqual(paths.sort(), [
    '*', '/accounts', '/connect', '/keys', '/login', '/overview', '/playground', '/requests', '/requests/:id',
    '/routes', '/settings', '/setup', '/setup/guide', '/upstreams', '/upstreams/:id', '/usage',
  ].sort());
  assert.equal(adminPageKey('/upstreams'), adminPageKey('/upstreams/example'));
  assert.equal(adminPageKey('/requests'), adminPageKey('/requests/example'));
  assert.equal(adminPageKey('/setup/guide'), 'setup');
  assert.notEqual(adminPageKey('/routes'), adminPageKey('/keys'));
  assert.equal(adminPageKey('/'), 'overview');

  const boundaries = [...nodes(source, ts.isJsxOpeningElement), ...nodes(source, ts.isJsxSelfClosingElement)]
    .filter(item => item.tagName.getText(source) === 'RoutePageBoundary');
  assert.equal(boundaries.length, 4);
  assert.ok(boundaries.every(item => !item.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'key')),
    'navigation must not remount the auth/session shell or healthy SaaS roots');
  for (const namespace of ['console', 'platform']) {
    assert.ok(boundaries.some(item => item.attributes.properties.some(prop => ts.isJsxAttribute(prop)
      && prop.name.getText(source) === 'pageKey' && prop.initializer && ts.isStringLiteral(prop.initializer) && prop.initializer.text === namespace)),
    'SaaS page keys must remain namespace-stable across deep links, tenant selection and query changes');
  }
});

test('a pending page presents only an accessible loading state, never auth/permission success', () => withSsrReact(() => {
  const pending = lazy(() => new Promise<{ default: () => ReactNode }>(() => {}));
  const html = renderToStaticMarkup(createElement(RoutePageBoundary, {
    resetKey: '/routes', pageKey: 'routes', children: createElement(pending),
  }));
  const loading = renderToStaticMarkup(createElement(RouteLoading));
  for (const markup of [html, loading]) {
    assert.match(markup, /role="status"/); assert.match(markup, /aria-live="polite"/);
    assert.match(markup, /aria-busy="true"/); assert.match(markup, /正在加载页面/);
    assert.doesNotMatch(markup, /登录成功|已授权|已保存|Secret|token|password/);
  }
}));

test('load/render failures retain no raw error and offer a manual reload without auto retry or child output', () => withSsrReact(() => {
  const sentinel = 'test-only-chunk-url-body-secret-stack-must-not-render';
  const props = { resetKey: '/keys', pageKey: 'keys', children: createElement('div', null, sentinel) };
  const boundary = new RoutePageBoundary(props);
  const failure = RoutePageBoundary.getDerivedStateFromError(new Error(sentinel));
  assert.deepEqual(failure, { failed: true });
  boundary.state = { ...boundary.state, ...failure };
  const html = renderToStaticMarkup(boundary.render());
  assert.match(html, /role="alert"/); assert.match(html, /页面加载失败/); assert.match(html, /重新加载页面/);
  assert.doesNotMatch(html, new RegExp(sentinel));
  assert.equal(RoutePageBoundary.getDerivedStateFromProps(props, boundary.state), null);
  assert.deepEqual(RoutePageBoundary.getDerivedStateFromProps({ ...props, resetKey: '/routes' }, boundary.state),
    { failed: false, resetKey: '/routes' });
  assert.deepEqual(RoutePageBoundary.getDerivedStateFromProps({ ...props, resetKey: '/keys/detail' }, { failed: false, resetKey: '/keys' }),
    { failed: false, resetKey: '/keys/detail' });
}));

test('loading boundary has no API/client, draft, auth, timer or persistence dependency', () => {
  const text = readFileSync(new URL('../../web/src/app/route-page-boundary.tsx', import.meta.url), 'utf8');
  const boundary = ts.createSourceFile('boundary.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.deepEqual(nodes(boundary, ts.isImportDeclaration).map(item => {
    assert.ok(ts.isStringLiteral(item.moduleSpecifier)); return item.moduleSpecifier.text;
  }), ['react']);
  const identifiers = nodes(boundary, ts.isIdentifier).map(item => item.text);
  for (const forbidden of ['fetch', 'localStorage', 'sessionStorage', 'setTimeout', 'setInterval', 'setCsrfToken', 'setRevision']) {
    assert.ok(!identifiers.includes(forbidden), `presentational boundary must not introduce ${forbidden}`);
  }
});
