import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { webpack } = require('next/dist/compiled/webpack/webpack');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// 실제 React 화면만 격리 실행한다. 인증·DB·실제 발송 모듈은 번들에 들어갈 수 없다.
export async function startStatusBrowserHarness({ entry, mocks = {}, css = "", assets = {} }) {
  const tempRoot = path.join(root, '.tmp');
  await mkdir(tempRoot, { recursive: true });
  const outputDir = await mkdtemp(path.join(tempRoot, 'status-browser-'));
  const files = {
    'entry.js': entry,
    'loader.cjs': `const ts = require(${JSON.stringify(require.resolve('typescript'))});
module.exports = function(source) { return ts.transpileModule(source, {fileName:this.resourcePath, compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText; };`,
    'navigation.js': `export function useRouter(){return {refresh(){window.dispatchEvent(new Event('test:refresh'));},push(url){window.dispatchEvent(new CustomEvent('test:navigate',{detail:url}));}};} export function usePathname(){return '/';}`,
    'link.js': `import {createElement} from 'react'; export default function Link({children,...props}){return createElement('a',props,children);}`,
    'dynamic.js': `export default function dynamic(){return function IsolatedUnusedSheet(){return null;};}`,
    // 상태 회귀에서는 Next 이미지 최적화 런타임을 실행하지 않는다. 시각 검증은 원본 로고 mock을 명시한다.
    'image.js': `import {createElement} from 'react'; export default function Image({src,priority,fill,unoptimized,...props}){return createElement('img',{...props,'data-source':src,src:'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA='});}`,
  };
  const aliases = {};
  for (const [module, code] of Object.entries(mocks)) {
    const file = `mock-${Object.keys(files).length}.js`;
    files[file] = code;
    aliases[`${module}$`] = path.join(outputDir, file);
  }
  for (const [moduleName, file] of Object.entries({ 'next/navigation': 'navigation.js', 'next/link': 'link.js', 'next/dynamic': 'dynamic.js', 'next/image': 'image.js' })) {
    aliases[`${moduleName}$`] ??= path.join(outputDir, file);
  }
  aliases['@'] = path.join(root, 'src');
  await Promise.all(Object.entries(files).map(([file, code]) => writeFile(path.join(outputDir, file), code)));
  const compiler = webpack({
    mode: 'development', context: outputDir, target: 'web', devtool: false, cache: false,
    entry: path.join(outputDir, 'entry.js'), output: { path: outputDir, filename: 'bundle.js' },
    resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [path.join(root, 'node_modules')], alias: aliases },
    module: { rules: [{ test: /\.tsx?$/, use: [path.join(outputDir, 'loader.cjs')] }] },
    plugins: [{ apply(current) {
      current.hooks.compilation.tap('IsolatedStatusScreens', compilation => {
        compilation.hooks.finishModules.tap('IsolatedStatusScreens', modules => {
          for (const bundledModule of modules) {
            const resource = bundledModule.resource?.replaceAll('\\', '/');
            if (resource && (/\/src\/app\/actions\//.test(resource) || /\/src\/lib\/(prisma|auth-guard|notification|staff-notifications)/.test(resource))) {
              throw new Error(`격리 화면에 서버 모듈을 포함할 수 없습니다: ${path.relative(root, bundledModule.resource)}`);
            }
          }
        });
      });
    } }],
  });
  try {
    await new Promise((resolve, reject) => compiler.run((error, stats) => error ? reject(error) : stats?.hasErrors() ? reject(new Error(stats.toString({ all: false, errors: true }))) : resolve()));
  } finally {
    await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
  }
  const bundle = await readFile(path.join(outputDir, 'bundle.js'));
  const html = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>학원 화면 격리 검사</title><style>' + css + '</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';
  const server = createServer((request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'");
    response.setHeader('Cache-Control', 'no-store');
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && Object.hasOwn(assets, pathname)) {
      response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(assets[pathname]); return;
    }
    if (request.method !== 'GET' || !['/', '/bundle.js'].includes(pathname)) {
      response.writeHead(404); response.end('격리 검사에는 운영 API가 없습니다.'); return;
    }
    response.writeHead(200, { 'Content-Type': pathname === '/' ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8' });
    response.end(pathname === '/' ? html : bundle);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return { url: `http://127.0.0.1:${server.address().port}`, outputDir,
    async close() { await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); },
  };
}
