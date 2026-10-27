'use strict';
// Compile ONLY test assembly; every production import uses the ordinary dist.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
for (const name of ['seed', 'runtime']) {
  const file = `tests/saas/gateway/fast/native-http-${name}-fixture.ts`;
  const source = fs.readFileSync(file, 'utf8').replaceAll('../../../../src/', `${path.resolve('dist')}/`);
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } });
  fs.writeFileSync(`scripts/performance/fixed-cpu/${name}.cjs`, compiled.outputText);
}
