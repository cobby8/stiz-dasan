// 빌드: TypeScript → 토스 POS 가 읽는 형태로 묶는다.
//   dist/worker/stiz-pos-worker/main.js       ← 웹 워커(문서 umd.html: «디렉토리/main.js», 메인 파일 이름은 반드시 main.js)
//   dist/tab/stiz-pos-tab/index.html · tab.js · tab.css · iframe-manifest.json ← 탭 화면(iframe-package.html)
// 공식 템플릿(webpack)은 SDK 가 쓰는 `process` 를 브라우저용으로 대체해 주므로, 여기서도 같은 대체를 넣는다.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });

// SDK 안의 process.env 참조가 워커·iframe 에서 터지지 않게 하는 최소 대체
const processShim = "var process = globalThis.process || { env: {}, browser: true, nextTick: function (f) { Promise.resolve().then(f); } };";

const common = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2019",
  minify: false, // 검수·장애 확인 때 읽을 수 있게 압축하지 않는다
  sourcemap: false,
  legalComments: "none",
  banner: { js: processShim },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
};

const workerDir = join(dist, "worker", "stiz-pos-worker");
mkdirSync(workerDir, { recursive: true });
await build({ ...common, entryPoints: [join(root, "src/worker/main.ts")], outfile: join(workerDir, "main.js") });

const tabDir = join(dist, "tab", "stiz-pos-tab");
mkdirSync(tabDir, { recursive: true });
await build({ ...common, entryPoints: [join(root, "src/tab/main.ts")], outfile: join(tabDir, "tab.js") });
for (const f of ["index.html", "tab.css", "iframe-manifest.json"]) {
  cpSync(join(root, "src/tab", f), join(tabDir, f));
}

console.log("빌드 완료:", workerDir, tabDir);
