// zip 만들기 — 개발자센터 «개발 배포 → 개발용 파일 추가»에 올릴 파일.
//   dist/stiz-pos-worker.zip  (안에 stiz-pos-worker/main.js)
//   dist/stiz-pos-tab.zip     (안에 stiz-pos-tab/index.html …)
// Windows 에는 zip 명령이 없어 Node 내장 zlib 로 표준 zip(Deflate)을 직접 쓴다(추가 패키지 없음).
// 비밀값이 섞이지 않았는지 마지막에 검사한다(토큰 모양 문자열·Bearer 원문).
import { crc32, deflateRawSync } from "node:zlib";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

/** 폴더 안 파일을 모두 모은다(zip 안 경로는 / 구분) */
function walk(dir, base) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push({ abs: p, rel: relative(base, p).split("\\").join("/") });
  }
  return out;
}

/** 고정 날짜(2026-01-01 00:00) — 같은 코드면 같은 zip 이 나오게 */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const data = readFileSync(f.abs);
    const comp = deflateRawSync(data, { level: 9 });
    const name = Buffer.from(f.rel, "utf8");
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 필요한 버전
    local.writeUInt16LE(0x0800, 6); // 파일 이름 UTF-8
    local.writeUInt16LE(8, 8); // Deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** 비밀값 검사: «Bearer 실제값»이나 긴 토큰 모양 문자열 대입이 있으면 멈춘다 */
function assertNoSecrets(files) {
  for (const f of files) {
    const text = readFileSync(f.abs, "utf8");
    if (/Bearer [A-Za-z0-9._~-]{20,}/.test(text) || /stiz_site_token["']?\s*[:=]\s*["'][A-Za-z0-9._~-]{20,}/.test(text)) {
      throw new Error(`비밀값으로 보이는 문자열이 있어요: ${f.rel}`);
    }
  }
}

for (const [kind, folder] of [["worker", "stiz-pos-worker"], ["tab", "stiz-pos-tab"]]) {
  const base = join(dist, kind);
  const files = walk(join(base, folder), base);
  if (files.length === 0) throw new Error(`${kind} 빌드 결과가 없어요. npm run build 먼저.`);
  assertNoSecrets(files);
  const out = join(dist, `${folder}.zip`);
  writeFileSync(out, makeZip(files));
  console.log(`zip 생성: ${out} (${files.map((f) => f.rel).join(", ")})`);
}
