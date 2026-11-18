// googleapis 는 쓸 때만 불러온다(2026-11-19 전 화면 속도 3회차)
//
// 왜: googleapis 는 구글 전체 API(책·지도 등 수백 개)를 한 묶음으로 담아 서버 코드 11MB 다.
//     구글 캘린더 쓰기·시트 정리 파일이 맨 위에서 불러오자, 그 파일을 거치는 수강 신청·체험 신청·대관·학부모 홈까지
//     11MB 가 따라 들어가 서버가 그 화면을 처음 열 때마다 CPU 0.7~0.9초를 썼다(운영 hot 호출 CPU p75, 다른 화면은 0.03~0.16초).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

test("src 어디에서도 googleapis 를 맨 위(정적 import)로 불러오지 않는다", () => {
  const offenders = walk("src").filter((file) =>
    /^\s*import\s[^;]*from\s+["']googleapis["']/m.test(readFileSync(file, "utf8"))
    || /require\(\s*["']googleapis["']\s*\)/.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, [], "await import(\"googleapis\") 로 쓸 때만 불러온다");
});

test("캘린더 쓰기·시트 정리 — 클라이언트를 만들 때 불러오고, 부르는 곳은 기다린다", () => {
  const calendar = readFileSync("src/lib/googleCalendarWrite.ts", "utf8");
  assert.match(calendar, /await loadGoogleapis\(\)/);
  assert.doesNotMatch(calendar, /=\s*getCalendarClient\(\)/, "기다리지 않고 부르면 약속(Promise)을 클라이언트로 착각한다");
  assert.ok((calendar.match(/= await getCalendarClient\(\)/g) ?? []).length >= 5);
  const sheets = readFileSync("src/lib/googleSheetsOperations.ts", "utf8");
  assert.match(sheets, /await loadGoogleapis\(\)/);
  assert.match(sheets, /const sheets = await sheetsClient\(\);/);
  // 불러오는 자리는 한 파일뿐 — 자리마다 두면 빌드가 12MB 묶음을 여러 벌 만든다
  const loaders = walk("src").filter((file) => /import\(\s*["']googleapis["']\s*\)/.test(readFileSync(file, "utf8")));
  assert.deepEqual(loaders.map((file) => file.replace(/\\/g, "/")), ["src/lib/googleapisLoader.ts"]);
});
