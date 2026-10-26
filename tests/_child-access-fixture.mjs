import ts from "typescript";
import { readFileSync } from "node:fs";
/** 기존 화면 회귀에서도 새 권한 헬퍼 자체를 실행한다. DB는 호출부가 제공한 합성 경계다. */
export function loadChildAccess(prisma = {}) {
  const code = ts.transpileModule(readFileSync("src/lib/account/child-access.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)(name => {
    if (name === "@/lib/prisma") return { prisma };
    throw new Error(`Unexpected dependency ${name}`);
  }, exports);
  return exports;
}
