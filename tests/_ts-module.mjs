import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

// 순수 TS 모듈을 **실제로 실행**해서 검증하기 위한 로더.
//
// 이 프로젝트의 테스트는 소스 문자열 매칭 대신 모듈을 돌려본다 — 날짜·시간대 계산처럼
// 눈으로 읽어서는 틀린 걸 못 찾는 코드가 있기 때문이다(요일이 하루 밀린 버그가 그렇게 살아남았다).
// 그런데 transpileModule + data URL 방식은 `@/` 별칭을 못 풀어서, 검증하려면 모듈이
// 의존성 0 이어야 했다. 그 제약 때문에 같은 날짜 헬퍼가 파일마다 복사되고 있었다.
// 여기서 import 를 따라가 주면 순수 모듈끼리 **조립**할 수 있다.
//
// ⚠️ 순수 모듈 전용이다. prisma·next 등 런타임 의존이 있는 파일에는 쓰지 않는다.

const SRC = "src";
const cache = new Map();

function resolveSpec(spec, fromFile) {
  const base = spec.startsWith("@/")
    ? path.join(SRC, spec.slice(2))
    : path.join(path.dirname(fromFile), spec);
  return base;
}

async function readFirst(base) {
  for (const ext of ["", ".ts", ".tsx", "/index.ts"]) {
    try {
      const p = `${base}${ext}`;
      return { path: p.replace(/\\/g, "/"), code: await readFile(p, "utf8") };
    } catch { /* 다음 확장자 */ }
  }
  throw new Error(`모듈을 찾을 수 없습니다: ${base}`);
}

/**
 * TS 파일을 data URL 모듈로 올리고 그 URL 을 돌려준다.
 * `@/…` 와 상대경로 import 를 재귀적으로 따라간다.
 */
async function toDataUrl(file, stack = [], scope = { cache, overrides: null }) {
  const key = file.replace(/\\/g, "/");
  const cache = scope.cache;
  if (cache.has(key)) return cache.get(key);
  if (stack.includes(key)) throw new Error(`순환 import: ${[...stack, key].join(" → ")}`);

  const { path: resolved, code } = await readFirst(file);
  let out = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  // import/export ... from "<spec>" 의 spec 만 골라 바꾼다.
  const specs = [...out.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
  for (const spec of new Set(specs)) {
    // 바꿔 끼울 모듈(overrides)이 있으면 그 주소를 그대로 쓴다 — DB·외부 의존이 있는 모듈을 이미 조립해 둔 것으로 대신할 때
    const override = scope.overrides && Object.hasOwn(scope.overrides, spec) ? scope.overrides[spec] : null;
    if (!override && !spec.startsWith("@/") && !spec.startsWith(".")) continue; // node: 등 외부는 그대로
    const url = override ?? await toDataUrl(resolveSpec(spec, resolved), [...stack, key], scope);
    out = out.split(`"${spec}"`).join(`"${url}"`).split(`'${spec}'`).join(`'${url}'`);
  }

  const url = `data:text/javascript;base64,${Buffer.from(out).toString("base64")}`;
  cache.set(key, url);
  return url;
}

/**
 * 예: `await loadTsModule("src/lib/datetime/kst.ts")`
 *
 * options.overrides = { "@/lib/어떤/모듈": "data:…주소" } 를 주면 그 import 만 준 주소로 바꿔 끼운다
 * (prisma·외부 일정처럼 그대로 올릴 수 없는 모듈을 테스트가 이미 조립해 둔 것으로 대신할 때).
 * 바꿔 끼운 조립은 공용 캐시와 섞이지 않게 그 호출만의 캐시를 쓴다.
 */
export async function loadTsModule(file, options = {}) {
  if (options.overrides) return import(await toDataUrl(file, [], { cache: new Map(), overrides: options.overrides }));
  return import(await toDataUrl(file));
}
