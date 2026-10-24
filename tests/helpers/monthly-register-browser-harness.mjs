import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const { webpack } = require("next/dist/compiled/webpack/webpack");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// 실제 화면과 순수 계산 모델만 복사한다. Next 서버·인증·DB 모듈은 실행하지 않는다.
async function transpile(sourcePath, targetPath) {
  const source = await readFile(sourcePath, "utf8");
  const result = ts.transpileModule(source, {
    fileName: sourcePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  const errors = result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }));
  }
  await writeFile(targetPath, result.outputText);
}

async function buildBundle(outputDir) {
  await Promise.all([
    transpile(path.join(root, "src/app/admin/finance/monthly-register/MonthlyRegisterClient.tsx"), path.join(outputDir, "MonthlyRegisterClient.js")),
    transpile(path.join(root, "src/lib/billing/monthly-register.ts"), path.join(outputDir, "monthly-register.js")),
    writeFile(path.join(outputDir, "link.js"), `import { createElement } from "react";
export default function Link({ href, children, ...props }) {
  return createElement("a", { ...props, href }, children);
}
`),
    writeFile(path.join(outputDir, "entry.js"), `import { createElement } from "react";
import { createRoot } from "react-dom/client";
import MonthlyRegisterClient from "./MonthlyRegisterClient.js";
const query = new URLSearchParams(window.location.search);
createRoot(document.getElementById("root")).render(createElement(MonthlyRegisterClient, {
  initialStudentId: query.get("studentId") ?? "student-1",
  initialMonth: query.get("month") ?? "2026-09",
}));
`),
  ]);

  const allowedRoots = [outputDir, ...["react", "react-dom", "scheduler"].map((name) => path.dirname(require.resolve(`${name}/package.json`)))];
  const compiler = webpack({
    mode: "development",
    context: outputDir,
    target: "web",
    entry: path.join(outputDir, "entry.js"),
    output: { path: outputDir, filename: "bundle.js" },
    devtool: false,
    cache: false,
    optimization: { minimize: false },
    resolve: {
      modules: [path.join(root, "node_modules")],
      alias: {
        "next/link$": path.join(outputDir, "link.js"),
        "@/lib/billing/monthly-register$": path.join(outputDir, "monthly-register.js"),
      },
    },
    plugins: [{
      apply(currentCompiler) {
        currentCompiler.hooks.compilation.tap("IsolatedMonthlyRegister", (compilation) => {
          compilation.hooks.finishModules.tap("IsolatedMonthlyRegister", (modules) => {
            for (const compiledModule of modules) {
              if (!compiledModule.resource) continue;
              const resource = path.resolve(compiledModule.resource);
              if (!allowedRoots.some((allowed) => resource.startsWith(`${allowed}${path.sep}`))) {
                throw new Error(`격리 화면에서 허용하지 않은 모듈: ${path.relative(root, resource)}`);
              }
            }
          });
        });
      },
    }],
  });
  try {
    await new Promise((resolve, reject) => {
      compiler.run((error, stats) => {
        if (error) reject(error);
        else if (!stats || stats.hasErrors()) reject(new Error(stats?.toString({ all: false, errors: true }) || "화면 번들 생성 실패"));
        else resolve();
      });
    });
  } finally {
    await new Promise((resolve, reject) => compiler.close((error) => error ? reject(error) : resolve()));
  }
}

// 기능 검사용 최소 스타일이다. 운영 화면의 시각적 일치 검사는 이 실행기의 범위가 아니다.
const styles = `:root { --color-brand-orange-500: #df6500; --color-text: #222; --color-surface: #fff; --color-border: #bbb; }
* { box-sizing: border-box; } body { margin: 0; padding: 16px; color: var(--color-text); background: var(--color-surface); font: 16px sans-serif; }
main { max-width: 1100px; margin: auto; } input, select, textarea, button { font: inherit; max-width: 100%; }
input, select, textarea, button { padding: 8px; border: 1px solid var(--color-border); border-radius: 4px; }
button, a, select { cursor: pointer; } button:disabled, fieldset:disabled { opacity: .6; } textarea { min-height: 60px; }
fieldset { min-width: 0; } label { display: grid; gap: 4px; } .grid { display: grid; } .flex { display: flex; } .flex-wrap { flex-wrap: wrap; }
.gap-1 { gap: 4px; } .gap-3 { gap: 12px; } .items-end { align-items: end; } .items-center { align-items: center; }
.justify-between { justify-content: space-between; } .border, .border-2 { border: 1px solid var(--color-border); } .border-2 { border-width: 2px; }
.rounded { border-radius: 4px; } .p-4 { padding: 16px; } .p-3 { padding: 12px; } .p-2 { padding: 8px; }
.space-y-5 > * + *, .space-y-4 > * + * { margin-top: 16px; } .space-y-3 > * + * { margin-top: 12px; } .space-y-2 > * + * { margin-top: 8px; }
.break-all { overflow-wrap: anywhere; } .min-w-0 { min-width: 0; } .font-bold { font-weight: bold; }
@media (min-width: 640px) { .sm\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); } .sm\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); } .sm\\:grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); } }`;

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><title>월 운영 장부 격리 검사</title><style>${styles}</style></head><body><main id="root"></main><script src="/bundle.js" defer></script></body></html>`;
const ledgerHtml = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><title>격리 장부 목록</title></head><body><h1>격리 장부 목록</h1><p>운영 데이터가 없는 이동 확인용 페이지입니다.</p></body></html>`;

/** API는 테스트가 가짜 응답으로 가로채야 한다. 이 서버에는 API 구현이 없다. */
export async function startMonthlyRegisterHarness() {
  const tempRoot = path.join(root, ".tmp");
  await mkdir(tempRoot, { recursive: true });
  const outputDir = await mkdtemp(path.join(tempRoot, "monthly-register-browser-"));
  await buildBundle(outputDir);
  await writeFile(path.join(outputDir, "index.html"), html);
  const bundle = await readFile(path.join(outputDir, "bundle.js"));
  const server = createServer((request, response) => {
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    let pathname;
    try { pathname = new URL(request.url, "http://127.0.0.1").pathname; }
    catch { response.writeHead(400); response.end(); return; }
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(404); response.end("격리 서버에는 API가 없습니다."); return;
    }
    const routes = {
      "/": ["text/html; charset=utf-8", html],
      "/admin/finance/monthly-register": ["text/html; charset=utf-8", html],
      "/admin/finance/monthly-ledger": ["text/html; charset=utf-8", ledgerHtml],
      "/bundle.js": ["text/javascript; charset=utf-8", bundle],
    };
    const route = Object.hasOwn(routes, pathname) ? routes[pathname] : null;
    if (!route) { response.writeHead(404); response.end("격리 서버에서 허용하지 않은 경로입니다."); return; }
    response.writeHead(200, { "Content-Type": route[0] });
    response.end(request.method === "HEAD" ? undefined : route[1]);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  let closePromise;
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    outputDir,
    close() {
      // 검사 증거는 보존하며, 이 함수가 만든 서버 연결만 종료한다.
      closePromise ??= new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}
