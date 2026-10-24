import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { NextRequest, NextResponse } = require("next/server");
const sourceRoot = new URL("../../", import.meta.url);
const apiPath = "/api/admin/finance/monthly-register";

// 운영 Prisma/Supabase 모듈을 가져오지 않고, 지정한 원본 코드만 읽어 실행한다.
function loadSource(relativePath, dependencies, isolatedProcess) {
  const filename = fileURLToPath(new URL(relativePath, sourceRoot));
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  const allowedRequire = id => {
    if (!Object.hasOwn(dependencies, id)) {
      throw new Error(`격리 API 테스트에서 허용하지 않은 의존성: ${id}`);
    }
    return dependencies[id];
  };
  // DB와 Request가 돌려주는 일반 객체까지 같은 Object.prototype을 사용한다.
  // 고정된 저장소 코드만 실행하는 테스트 로더이며 보안 sandbox는 아니다.
  // 모듈 의존성은 계속 허용 목록으로 제한하고 실제 process는 주입하지 않는다.
  vm.compileFunction(outputText, ["require", "exports", "process"], { filename })(
    allowedRequire, exports, isolatedProcess,
  );
  return exports;
}

/**
 * 실제 route → requireAdmin → 장부 service → 주입된 격리 DB를 연결한다.
 * Supabase 응답만 합성한다. 토큰 검증·로그인 쿠키·세션 갱신 E2E는 아니다.
 * database는 실행기가 안전 확인을 마친 임시 PostgreSQL 어댑터여야 한다.
 * 실제 권한 코드의 5분 역할 캐시는 이 인스턴스에 한정해 그대로 유지한다.
 */
export function createMonthlyRegisterApiDbHarness({ database }) {
  if (!database || typeof database.$queryRawUnsafe !== "function"
    || typeof database.$transaction !== "function") {
    throw new Error("격리 DB의 raw query와 transaction 어댑터가 필요합니다.");
  }
  const requestContext = new AsyncLocalStorage();
  const current = () => {
    const value = requestContext.getStore();
    if (!value) throw new Error("격리 API 요청 문맥이 없습니다.");
    return value;
  };
  // process.env를 실제로 바꾸지 않아 병렬 테스트의 권한/저장 설정이 섞이지 않는다.
  const env = Object.freeze(Object.defineProperty({}, "MONTHLY_REGISTER_WRITES_ENABLED", {
    enumerable: true,
    get: () => current().writesEnabled ? "true" : "false",
  }));
  const isolatedProcess = Object.freeze({ env });
  const authProvider = Object.freeze({
    async createClient() {
      const { identity, authMode } = current();
      return {
        auth: {
          async getClaims() {
            if (!identity || authMode === "user") {
              return { data: null, error: new Error("합성 인증 claims 없음") };
            }
            return { data: { claims: {
              sub: identity.id,
              email: identity.email,
              aud: "authenticated",
              role: "authenticated",
              user_metadata: identity.user_metadata ?? {},
              app_metadata: identity.app_metadata ?? {},
            } }, error: null };
          },
          async getUser() {
            return identity
              ? { data: { user: { ...identity, aud: "authenticated", role: "authenticated" } }, error: null }
              : { data: { user: null }, error: new Error("합성 인증 사용자 없음") };
          },
        },
      };
    },
  });
  const model = loadSource("src/lib/billing/monthly-register.ts", {}, isolatedProcess);
  const service = loadSource("src/lib/billing/monthly-register-service.ts", {
    "node:crypto": { randomUUID },
    "./monthly-register": model,
  }, isolatedProcess);
  const auth = loadSource("src/lib/auth-guard.ts", {
    "@/lib/supabase/server": authProvider,
    "@/lib/prisma": { prisma: database },
  }, isolatedProcess);
  const route = loadSource("src/app/api/admin/finance/monthly-register/route.ts", {
    "next/server": { NextRequest, NextResponse },
    "@/lib/auth-guard": auth,
    "@/lib/prisma": { prisma: database },
    "@/lib/billing/monthly-register": model,
    "@/lib/billing/monthly-register-service": service,
  }, isolatedProcess);

  return {
    async handle(request, { identity = null, writesEnabled = true, authMode = "claims" } = {}) {
      if (!(request instanceof Request)) throw new Error("실제 Request가 필요합니다.");
      const url = new URL(request.url);
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || url.pathname !== apiPath || url.username || url.password) {
        throw new Error("월 장부 격리 localhost API 경로만 허용합니다.");
      }
      if (typeof writesEnabled !== "boolean" || !["claims", "user"].includes(authMode)) {
        throw new Error("격리 저장 플래그 또는 인증 응답 모드가 잘못되었습니다.");
      }
      if (identity !== null && (typeof identity !== "object" || !identity.id || typeof identity.id !== "string")) {
        throw new Error("합성 인증 사용자 ID가 필요합니다.");
      }
      if (!["GET", "POST"].includes(request.method)) {
        return new Response(null, { status: 405, headers: { Allow: "GET, POST", "Cache-Control": "no-store" } });
      }
      // 실제 운영 인증/환경 변수 대신 이 요청에만 합성 응답을 묶는다.
      return requestContext.run({ identity: identity === null ? null : structuredClone(identity), writesEnabled, authMode },
        () => route[request.method](request instanceof NextRequest ? request : new NextRequest(request)));
    },
  };
}
