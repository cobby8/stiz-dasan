import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const migration = readFileSync("prisma/migrations/20260827234500_add_regular_shuttle_location_links/migration.sql", "utf8");
const service = readFileSync("src/lib/shuttle/regularLocationLink.ts", "utf8");
const adminApi = readFileSync("src/app/api/admin/shuttle/regular-location-links/route.ts", "utf8");
const publicApi = readFileSync("src/app/api/shuttle/regular-location/[token]/route.ts", "utf8");

// 외부 DB 없이 실제 위치 validator만 원본 TypeScript에서 실행한다.
const validatorBlock = service.slice(service.indexOf("export class RegularLocationLinkError"), service.indexOf("function serializeLocations"))
  .replace(/const defaultDb = prisma as unknown as LocationDb;/, "");
const js = ts.transpileModule(`const LOCATION_SOURCES = new Set(["MAP_PIN", "SEARCH", "CURRENT_LOCATION"]);\n${validatorBlock.replace(/export class/, "class")}`, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace("export function validateRegularLocation", "export function validateRegularLocation");
const { validateRegularLocation } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

async function loadSubmitModule() {
  const body = service
    .replace(/^import .*$/gm, "")
    .replace("const defaultDb = prisma as unknown as LocationDb;", "const defaultDb = null as unknown as LocationDb;")
    .replace(/export async function createRegularLocationLink[\s\S]*?export async function revokeRegularLocationLink/, "export async function revokeRegularLocationLink")
    .replace(/export async function revokeRegularLocationLink[\s\S]*?export async function listRegularLocationLinks/, "export async function listRegularLocationLinks")
    .replace(/export async function listRegularLocationLinks[\s\S]*?export async function getRegularLocationLink/, "export async function getRegularLocationLink")
    .replace(/export async function getRegularLocationLink[\s\S]*?export async function submitRegularLocations/, "export async function submitRegularLocations")
    .replace(/createHash\("sha256"\)/g, "createHash(\"sha256\")");
  const transpiled = ts.transpileModule(`import { createHash } from "node:crypto"; const SHUTTLE_LOCATION_CONSENT_VERSION="2026-07-21"; ${body}`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

test("좌표 링크는 학생·보호자·용도를 고정하고 원문 토큰을 저장하지 않는다", () => {
  const linkModel = schema.slice(schema.indexOf("model RegularShuttleLocationLink {"), schema.indexOf("model RegularShuttleLocationLinkAudit {"));
  assert.match(schema, /model RegularShuttleLocationLink/);
  assert.match(schema, /studentId\s+String/);
  assert.match(schema, /parentId\s+String/);
  assert.match(schema, /purpose\s+String\s+@default\("REGULAR_SHUTTLE_LOCATION"\)/);
  assert.match(schema, /tokenHash\s+String\s+@unique/);
  assert.doesNotMatch(linkModel, /\btoken\s+String/);
  assert.match(migration, /CHECK \(purpose = 'REGULAR_SHUTTLE_LOCATION'\)/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("관리자 링크는 32바이트 난수·SHA-256·기본 7일과 1~30일 제한을 사용한다", () => {
  assert.match(service, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(service, /createHash\("sha256"\)/);
  assert.match(service, /expiresInDays = 7/);
  assert.match(service, /expiresInDays < 1 \|\| expiresInDays > 30/);
  assert.match(adminApi, /requireAdmin\(\)/);
  assert.match(adminApi, /path: `\/shuttle\/location\/\$\{link\.token\}`/);
});

test("공개 링크는 만료·취소·학생 보호자 관계·용도를 검증한다", () => {
  assert.match(service, /s\."parentId"=l\."parentId"/);
  assert.match(service, /l\.purpose=\$2/);
  assert.match(service, /if \(link\.revokedAt\)/);
  assert.match(service, /link\.expiresAt\.getTime\(\) <= Date\.now\(\)/);
  assert.match(service, /purpose !== REGULAR_LOCATION_PURPOSE/);
  assert.match(publicApi, /getRegularLocationLink\(token\)/);
  assert.match(publicApi, /submitRegularLocations\(token/);
});

test("위치 validator는 좌표 범위·source·accuracy를 fail-closed 검증한다", () => {
  const valid = validateRegularLocation({ address: "다산 정문", latitude: 37.6, longitude: 127.1, source: "MAP_PIN", accuracyMeters: 5 });
  assert.equal(valid.latitude, 37.6);
  assert.throws(() => validateRegularLocation({ address: "A", latitude: 91, longitude: 127, source: "MAP_PIN" }));
  assert.throws(() => validateRegularLocation({ address: "A", latitude: 37, longitude: 181, source: "MAP_PIN" }));
  assert.throws(() => validateRegularLocation({ address: "A", latitude: 37, longitude: 127, source: "ADMIN_PIN" }));
  assert.throws(() => validateRegularLocation({ address: "A", latitude: 37, longitude: 127, source: "MAP_PIN", accuracyMeters: -1 }));
});

test("재제출은 같은 학생 kind를 upsert하고 저장 후 서버에서 재조회한다", () => {
  assert.match(service, /ON CONFLICT \("studentId",kind\) DO UPDATE/);
  assert.match(service, /"submissionCount"="submissionCount"\+1/);
  assert.match(service, /return readLocations\(tx/);
  assert.match(service, /LOCATIONS_SUBMITTED/);
  assert.match(service, /SHUTTLE_LOCATION_CONSENT_VERSION/);
});

test("관리자 목록은 토큰 없이 상태·시각만 반환하고 재발급은 기존 활성 링크를 취소한다", () => {
  assert.match(adminApi, /export async function GET/);
  assert.match(service, /status: row\.revokedAt \? "REVOKED"[\s\S]*"EXPIRED"[\s\S]*"SUBMITTED"[\s\S]*"ACTIVE"/);
  assert.doesNotMatch(service.slice(service.indexOf("export async function listRegularLocationLinks")), /tokenHash/);
  assert.match(service, /reason: "REISSUED"/);
  assert.match(service, /FOR UPDATE/);
  assert.match(service, /purpose=\$2 AND "revokedAt" IS NULL AND "expiresAt">now\(\)/);
});

test("공개 응답은 note를 제외하고 no-store/noindex로 반환한다", () => {
  const serializer = service.slice(service.indexOf("function serializeLocations"), service.indexOf("async function readLocations"));
  assert.doesNotMatch(serializer, /\.\.\.row|note:/);
  assert.match(serializer, /latitude: row\.latitude/);
  assert.match(publicApi, /Cache-Control": "no-store, max-age=0"/);
  assert.match(publicApi, /X-Robots-Tag": "noindex, nofollow"/);
});

test("fake DB roundtrip은 저장 후 재조회하고 동일 payload 재시도 부작용을 만들지 않는다", async () => {
  const { submitRegularLocations } = await loadSubmitModule();
  const state = { locations: [], lastPayloadHash: null, inserts: 0, audits: 0 };
  const link = { id: "link-1", studentId: "student-1", studentName: "홍길동", parentId: "parent-1", expiresAt: new Date(Date.now() + 60_000), revokedAt: null };
  const db = {
    async $transaction(fn) { return fn(this); },
    async $queryRawUnsafe(query) {
      if (query.includes("JOIN \"Student\"")) return [link];
      if (query.includes("lastPayloadHash")) return [{ id: link.id, lastPayloadHash: state.lastPayloadHash }];
      if (query.includes("FROM \"StudentShuttleLocation\"")) return state.locations;
      return [];
    },
    async $executeRawUnsafe(query, ...values) {
      if (query.includes("INSERT INTO \"StudentShuttleLocation\"")) {
        state.inserts += 1;
        const [studentId, kind, name, address, roadAddress, latitude, longitude, placeId, source, accuracyMeters] = values;
        const row = { kind, name, address, roadAddress, latitude, longitude, placeId, source, accuracyMeters, confirmedAt: new Date(), note: null };
        state.locations = [...state.locations.filter((item) => item.kind !== kind), row];
      } else if (query.includes("lastPayloadHash")) state.lastPayloadHash = values[2];
      else if (query.includes("LOCATIONS_SUBMITTED")) state.audits += 1;
      return 1;
    },
  };
  const payload = { purpose: "REGULAR_SHUTTLE_LOCATION", consentVersion: "2026-07-21", pickup: { address: "정문", latitude: 37.6, longitude: 127.1, source: "MAP_PIN" } };
  const first = await submitRegularLocations("token", payload, db);
  const second = await submitRegularLocations("token", payload, db);
  assert.equal(first.locations.PICKUP.address, "정문");
  assert.equal(second.locations.PICKUP.address, "정문");
  assert.equal(state.inserts, 1);
  assert.equal(state.audits, 1);
});

test("tx 직전 취소·만료되면 저장하지 않는다", async () => {
  const { submitRegularLocations } = await loadSubmitModule();
  let writes = 0;
  const db = {
    async $transaction(fn) { return fn(this); },
    async $queryRawUnsafe(query) {
      if (query.includes("JOIN \"Student\"")) return [{ id: "l", studentId: "s", studentName: "홍길동", parentId: "p", expiresAt: new Date(Date.now() + 60_000), revokedAt: null }];
      if (query.includes("lastPayloadHash")) return [];
      return [];
    },
    async $executeRawUnsafe() { writes += 1; return 1; },
  };
  await assert.rejects(() => submitRegularLocations("token", { purpose: "REGULAR_SHUTTLE_LOCATION", consentVersion: "2026-07-21", pickup: { address: "정문", latitude: 37.6, longitude: 127.1, source: "MAP_PIN" } }, db), /만료되었거나 취소/);
  assert.equal(writes, 0);
});
