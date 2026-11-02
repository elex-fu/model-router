// Web feature modules import their colocated stylesheets; Vite resolves those
// at build time, but node:test loads the same .tsx sources through tsx, which
// passes unknown extensions straight to Node and dies with
// ERR_UNKNOWN_FILE_EXTENSION. Loaded as an extra `--import` after tsx, this
// stub makes every .css specifier load an empty module on all loader paths:
// the synchronous registerHooks resolver covers ESM imports, the classic
// extension entry covers CommonJS requires (tsx compiles some .tsx graphs
// through the CJS transformer), and a _resolveFilename wrapper covers the
// observed load-race where the .css extension entry is consulted before this
// module has finished loading in a spawned test child — Node then falls back
// to the .js handler, which under tsx is the transformer that compiles raw
// CSS as TypeScript. Rewriting the specifier at resolution time means the
// extension table is never consulted for .css at all.
import { fileURLToPath } from 'node:url';
import Module from 'node:module';
import { registerHooks } from 'node:module';

const emptyStylesheetUrl = new URL('./test-css-stub.empty.cjs', import.meta.url).href;
const emptyStylesheetPath = fileURLToPath(emptyStylesheetUrl);

Module._extensions['.css'] = (module) => {
  module._compile('', module.filename);
};

// Wraps tsx's already-installed resolver (this module loads after tsx), so
// non-CSS requests keep tsx's namespace query handling untouched.
const originalResolveFilename = Module._resolveFilename;
if (typeof originalResolveFilename === 'function') {
  Module._resolveFilename = function patchedResolveFilename(request, ...rest) {
    if (typeof request === 'string' && request.endsWith('.css') && !request.startsWith('node:')) {
      request = emptyStylesheetPath;
    }
    return originalResolveFilename.call(this, request, ...rest);
  };
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) {
      return { url: emptyStylesheetUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
