#!/usr/bin/env node
/**
 * 랠리즈 피드 «글·사진» → 사이트 수업 피드 (2026-11-16 원장 결정 v1·v4·v5). 원장 PC 에서 실행.
 *
 * 기본 = 계획만(아무것도 쓰지 않음). 쓰려면 아래 둘 중 하나를 붙인다.
 *   --emit-sql 파일.sql  사진을 비공개 버킷에 올리고, DB 반영 SQL 을 파일로 쓴다(PM 이 Supabase MCP 로 적용)
 *   --apply              사진을 올리고 DB 에 바로 반영(원장 PC .env.local 의 DATABASE_URL)
 *
 * 예) 계획:   node scripts/rallyz-feed-import/import-posts.mjs --feed feed.json --month 2026-11 --class "월4"
 *     표본:   ... --month 2026-11 --class "월4" --emit-sql .tmp/rallyz-feed-import/sample.sql
 *     전체:   ... --from 2026-01-01 --to 2026-11-30 --create-missing --apply
 *
 * 옵션: --snapshot 파일(MCP 로 뽑은 사이트 스냅숏) · --class-map 파일 · --inst 다산2호점 · --create-missing(그날 수업 기록이 없으면 만든다)
 *       --allow-published(이미 보낸 수업에도 덧붙임) · --publish(알림 없이 바로 발행 — 기본은 안 함, 원장 확인 뒤 publish.mjs)
 *       --batch 이름(이어하기·되돌림 단위) · --work 폴더 · --no-photos(글만)
 *
 * 안전: 랠리즈에는 쓰지 않는다(사진 내려받기만). 학부모 알림 경로를 부르지 않는다. 기존 내용은 덮지 않고 뒤에 덧붙인다.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnv, parseArgs, readJson, writeJson, workDir, newBatchId, connectDb, loadSnapshot, loadClassMap, ymdArg, monthRange } from "./common.mjs";
import {
  readFeedExport, planPostImport, photoUrl1000, storedPhoto, buildGroupSql, summarizeClassMatches, checkPhotoContentType,
  PRIVATE_PHOTO_BUCKET, IMPORT_SOURCE, RALLYZ_REFERER,
} from "./lib.mjs";

loadEnv();
const args = parseArgs();
if (!args.feed) {
  console.error("사용법: node scripts/rallyz-feed-import/import-posts.mjs --feed <크롬에서 뽑은 피드.json> [--month 2026-11] [--class 반이름] [--emit-sql out.sql | --apply]");
  process.exit(1);
}
const range = args.month ? monthRange(args.month) : { from: ymdArg(args, "from"), to: ymdArg(args, "to") };
const writeMode = args.apply ? "apply" : args["emit-sql"] ? "sql" : "plan";
const dir = workDir(args);

const feed = readFeedExport(readJson(args.feed));
const snapshot = await loadSnapshot(args);
const plan = planPostImport({
  posts: feed.posts,
  snapshot,
  options: {
    inst: args.inst || undefined,
    from: range.from,
    to: range.to,
    classFilter: typeof args.class === "string" ? args.class : undefined,
    classMap: loadClassMap(args),
    createMissing: Boolean(args["create-missing"]),
    allowPublished: Boolean(args["allow-published"]),
  },
});

// ── 반 매칭 요약(기간과 무관하게 피드 전체) — «괄호 떼고 맞춤»·«못 맞춤»은 사람이 확인 ──
const classRows = summarizeClassMatches(feed.posts, snapshot.classes, loadClassMap(args), args.inst || undefined);
const REASON_KO = { exact: "이름 같음", suffix: "괄호 떼고 맞춤(확인)", manual: "매핑 파일" };
console.log(`반 매칭: 랠리즈 반 ${classRows.length}개 중 맞음 ${classRows.filter((r) => r.classId).length} · 못 맞춤 ${classRows.filter((r) => !r.classId).length}`);
for (const r of classRows) {
  if (r.reason === "exact") continue; // 이름이 같은 반은 줄이 길어지니 생략
  console.log(`  ${r.rallyzName} → ${r.siteName ?? "(없음)"} [${REASON_KO[r.reason] ?? r.reason}] 글 ${r.posts} · 사진 ${r.photos} · 영상 ${r.videos} · ${r.from}~${r.to}`);
}

// ── 계획 보고(최신 수업이 위 — 사이트 피드와 같은 순서) ──
const photoTotal = plan.groups.reduce((n, g) => n + g.posts.reduce((m, p) => m + p.photos.length, 0), 0);
console.log(`피드 파일: 원본 ${feed.rawCount}건 · 글 ${feed.posts.length}개(모양이 이상한 ${feed.invalid}건 제외)`);
console.log(`거름: 다른 지점 ${plan.counts.otherInst} · 기간 밖 ${plan.counts.outOfRange} · 이미 옮김 ${plan.counts.alreadyImported} · 빈 글 ${plan.counts.empty} · 반 매칭 실패 ${plan.counts.noClass} · 보낸 수업 ${plan.counts.publishedSkipped} · 수업 기록 없음 ${plan.counts.noSessionSkipped}`);
console.log(`이관 예정: 수업 ${plan.groups.length}개 · 글 ${plan.counts.planned}개 · 사진 ${photoTotal}장`);
for (const g of plan.groups) {
  const photos = g.posts.reduce((m, p) => m + p.photos.length, 0);
  const warn = g.viewers === 0 ? "  ⚠️ 볼 수 있는 학생 0명(출결·수강 기록 없음 — 발행해도 아무도 못 봄)" : "";
  const shifted = g.shifted.length ? `  (글 쓴 날에서 수업일로 당김 ${g.shifted.length})` : "";
  const offDay = g.offDay ? "  ⚠️ 반 요일이 아닌 날(미리 올린 글·보강·요일 변경?) — 확인" : "";
  console.log(`  ${g.ymd} ${g.className}: 글 ${g.posts.length} · 사진 ${photos} · ${g.existing ? `기존 기록(${g.existing.status}${g.existing.hasContent ? "·내용 있음" : ""})` : "새 기록"} · 볼 학생 ${g.viewers}${shifted}${warn}${offDay}`);
}
const offDayCount = plan.groups.filter((g) => g.offDay).length;
const zeroCount = plan.groups.filter((g) => g.viewers === 0).length;
console.log(`요약: 볼 학생 0명 수업 ${zeroCount}개 · 반 요일이 아닌 날 ${offDayCount}개`);
if (plan.skipped.length) {
  const file = path.join(dir, "skipped.json");
  writeJson(file, plan.skipped);
  console.log(`건너뛴 글 ${plan.skipped.length}개 → ${file}`);
}
if (writeMode === "plan") {
  console.log("\n(계획만 봤습니다. 쓰려면 --emit-sql 파일 또는 --apply 를 붙이세요.)");
  process.exit(0);
}
if (plan.groups.length === 0) { console.log("옮길 것이 없습니다."); process.exit(0); }

// ── 쓰기: 수업 id 정하기 → 사진 올리기 → SQL ──
const batch = typeof args.batch === "string" ? args.batch : newBatchId();
const statePath = path.join(dir, `posts-state-${batch}.json`);
// 이어하기: 같은 batch 로 다시 돌리면 이미 올린 사진·정한 수업 id 를 다시 쓴다(두 번 올리지 않게)
const state = fs.existsSync(statePath) ? readJson(statePath) : { batch, sessions: {}, photos: {} };
const saveState = () => writeJson(statePath, state);

let storage = null;
let sharp = null;
if (!args["no-photos"]) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("사진을 올리려면 .env.local 에 NEXT_PUBLIC_SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY 가 필요합니다(글만이면 --no-photos).");
  const { createClient } = await import("@supabase/supabase-js");
  storage = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }).storage.from(PRIVATE_PHOTO_BUCKET);
  sharp = (await import("sharp")).default;
}

/** 랠리즈 1000px 사진 내려받기 → 선생님 업로드와 같은 규칙으로 다시 저장(EXIF·GPS 제거, 최대 1600px JPEG) → 비공개 버킷 */
async function uploadPhoto(srcUrl, ref) {
  const done = state.photos[srcUrl];
  if (done) return done;
  const photoId = randomUUID();
  const entry = storedPhoto({ ...ref, photoId });
  // Referer 없으면 403. .heic 원본도 축소본 주소로 받으면 jpeg 로 온다 — content-type 으로 확인
  const res = await fetch(photoUrl1000(srcUrl), { headers: { Referer: RALLYZ_REFERER } });
  if (!res.ok) throw new Error(`사진 내려받기 실패 ${res.status}: ${srcUrl}`);
  const typeCheck = checkPhotoContentType(res.headers.get("content-type"));
  if (!typeCheck.ok) throw new Error(`사진 형식 이상 ${typeCheck.reason}: ${srcUrl}`);
  const input = Buffer.from(await res.arrayBuffer());
  const encoded = await sharp(input, { limitInputPixels: 40_000_000 }).rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  const { error } = await storage.upload(entry.storagePath, encoded, { contentType: "image/jpeg", cacheControl: "31536000", upsert: false });
  if (error) throw new Error(`사진 올리기 실패: ${error.message}`);
  state.photos[srcUrl] = entry;
  saveState();
  return entry;
}

const sqlBlocks = [];
let uploaded = 0;
let photoPostsHeld = 0;
for (const g of plan.groups) {
  // --no-photos(글만): 사진 있는 글은 건너뛴다 — 장부에 «옮김»으로 남으면 나중에 사진을 못 넣는다
  const groupPosts = storage ? g.posts : g.posts.filter((p) => {
    if (p.photos.length === 0) return true;
    photoPostsHeld += 1;
    return false;
  });
  if (groupPosts.length === 0) continue;
  // 기존 기록이면 그 id, 없으면 새 id(이어하기면 지난번에 정한 id)
  const sessionId = g.existing?.id ?? state.sessions[g.key] ?? randomUUID();
  state.sessions[g.key] = sessionId;
  saveState();
  const posts = [];
  for (const p of groupPosts) {
    const photos = [];
    if (storage) {
      for (const src of p.photos) {
        photos.push(await uploadPhoto(src, { classId: g.classId, sessionId, rallyzFeedId: p.id }));
        uploaded += 1;
      }
    }
    posts.push({ id: p.id, text: p.text, createdSortKey: p.created.sortKey, className: p.className, photos });
  }
  sqlBlocks.push({
    group: g,
    sessionId,
    sql: buildGroupSql({
      sessionId, createSession: !g.existing, classId: g.classId, className: g.className, ymd: g.ymd,
      previousStatus: g.existing?.status ?? null, posts,
    }, batch, { publish: Boolean(args.publish) }),
  });
  process.stdout.write(`  준비 ${g.ymd} ${g.className} (사진 누적 ${uploaded})\n`);
}
if (photoPostsHeld) console.log(`--no-photos: 사진이 있는 글 ${photoPostsHeld}개는 이번에 넣지 않았습니다(사진과 함께 다음에).`);
if (sqlBlocks.length === 0) { console.log("옮길 것이 없습니다."); process.exit(0); }

const header = `-- 랠리즈 피드 글·사진 이관 SQL — batch ${batch}
-- 만든 시각: ${new Date().toISOString()} · 수업 ${sqlBlocks.length}개 · importSource=${IMPORT_SOURCE} · 발행 ${args.publish ? "함(알림 없음)" : "안 함(published=false)"}
-- 블록마다 따로 실행돼도 안전하다(같은 글은 장부로 건너뜀). 되돌림: node scripts/rallyz-feed-import/rollback.mjs --batch ${batch}
`;
const allSql = header + sqlBlocks.map((b) => b.sql).join("\n\n") + "\n";
const sqlFile = path.resolve(writeMode === "sql" ? args["emit-sql"] : path.join(dir, `posts-${batch}.sql`));
fs.mkdirSync(path.dirname(sqlFile), { recursive: true });
fs.writeFileSync(sqlFile, allSql, "utf8");
state.sqlFile = sqlFile;
saveState();
console.log(`SQL → ${sqlFile}`);

if (writeMode === "apply") {
  const client = await connectDb();
  try {
    for (const b of sqlBlocks) {
      await client.query(b.sql);
      console.log(`  반영 ${b.group.ymd} ${b.group.className}`);
    }
  } finally {
    await client.end();
  }
  console.log(`반영 끝 — batch ${batch}. 확인: 관리자 «수업 피드»(/admin/attendance/feed) 에서 «안 보냄» 수업으로 보입니다.`);
} else {
  console.log(`SQL 파일만 만들었습니다(사진 ${uploaded}장은 이미 올림). PM 이 Supabase MCP 로 적용 → batch ${batch}`);
}
