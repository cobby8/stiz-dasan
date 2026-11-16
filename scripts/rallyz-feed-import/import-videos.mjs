#!/usr/bin/env node
/**
 * 랠리즈 피드 «영상» → 수업(반·날짜)별 1개로 묶어 유튜브 일부공개 → 사이트 수업 피드 (2026-11-16 원장 결정 v2).
 * 원장 PC 에서 실행(ffmpeg 필요). 최신 수업부터(11월 → 거꾸로). 진행 상태 파일로 몇 번이고 이어서 돌린다.
 *
 *   계획만:        node scripts/rallyz-feed-import/import-videos.mjs --feed feed.json --hls-template "<주소>"
 *   미리 내려받기:  ... --download 10            (유튜브 한도와 무관 — 최신 수업 10개를 mp4 로 합쳐 둔다)
 *   올리기:        ... --upload                 (하루 한도 안에서 --per-run 개, 기본 1)
 *   잠금 풀기:     ... --fix-locked             (유튜브 심사 통과 뒤: 비공개로 잠긴 이관 영상을 일부공개로)
 *
 * 하루 한도: 사이트 크론과 «같은 계수기»(YouTubeConnection.quotaUsed, KST 날짜)를 나눠 쓴다.
 *   --total-limit(기본 5 = 사이트 크론과 같음) 안에서만 한 칸씩 먼저 차지하고 올린다. 할당량 초과 응답이면 다음 KST 자정까지 사이트도 함께 멈춘다.
 * 유튜브 연결: 사이트와 같은 채널. DB 의 refresh token 암호문을 YOUTUBE_TOKEN_ENCRYPTION_KEY 로 풀어 쓴다
 *   (.env.rallyz-import 에 YOUTUBE_OAUTH_CLIENT_ID·YOUTUBE_OAUTH_CLIENT_SECRET·YOUTUBE_TOKEN_ENCRYPTION_KEY — Vercel 값, 작업 끝나면 파일 삭제).
 * 안전: 랠리즈에는 쓰지 않는다(HLS 내려받기만). 학부모 알림 없음. 첫 업로드가 «비공개로 잠김»이면 바로 멈춘다(심사 전 — 학부모가 못 봄).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { loadEnv, parseArgs, readJson, writeJson, workDir, newBatchId, connectDb, loadSnapshot, loadClassMap, ymdArg, monthRange } from "./common.mjs";
import {
  readFeedExport, planVideoBatches, hlsUrlFor, ffmpegConcatList, youtubeTitle, canUploadMore, openSealedYoutubeToken,
  classifyYoutubeError, nextKstMidnightIso, buildVideoRecordSql, msToKstYmd, IMPORT_SOURCE,
} from "./lib.mjs";

loadEnv();
const args = parseArgs();
if (!args.feed) {
  console.error("사용법: import-videos.mjs --feed <피드.json> [--hls-template <주소>] [--download N | --upload | --fix-locked]");
  process.exit(1);
}
const range = args.month ? monthRange(args.month) : { from: ymdArg(args, "from"), to: ymdArg(args, "to") };
const dir = workDir(args);
const videoDir = path.join(dir, "videos");
fs.mkdirSync(videoDir, { recursive: true });
const statePath = path.join(dir, "videos-state.json");
const state = fs.existsSync(statePath) ? readJson(statePath) : { batch: newBatchId("rz-video"), items: {} };
const saveState = () => writeJson(statePath, state);
const perRun = Math.max(1, Number(args["per-run"] ?? 1) | 0);
const totalLimit = Math.max(1, Number(args["total-limit"] ?? 5) | 0);
const DESCRIPTION = "STIZ 농구교실 수업 영상입니다. 학부모 화면에서만 공유됩니다.";

const feed = readFeedExport(readJson(args.feed));
const snapshot = await loadSnapshot(args);
const plan = planVideoBatches({ posts: feed.posts, snapshot, options: { inst: args.inst || undefined, from: range.from, to: range.to, classMap: loadClassMap(args) } });
const template = typeof args["hls-template"] === "string" ? args["hls-template"] : process.env.RALLYZ_HLS_TEMPLATE || "";
const partTotal = plan.batches.reduce((n, b) => n + b.parts.length, 0);
console.log(`영상 묶음: 수업 ${plan.batches.length}개 · 원본 영상 ${partTotal}개 · 반 매칭 실패 ${plan.skipped.length}`);
const doneCount = Object.values(state.items).filter((i) => i.status === "recorded").length;
console.log(`진행 상태: 기록 끝 ${doneCount}개 · batch ${state.batch}`);
for (const b of plan.batches.slice(0, 15)) {
  const s = state.items[b.key]?.status ?? "대기";
  console.log(`  ${b.ymd} ${b.className}: 영상 ${b.parts.length}개 → 1개 · ${s}`);
}
if (plan.batches.length > 15) console.log(`  … 외 ${plan.batches.length - 15}개`);

const sessionByKey = new Map((snapshot.sessions ?? []).map((s) => [`${s.classId}:${s.ymd}`, s]));

// ── ffmpeg: HLS 여러 개 → mp4 하나(재인코딩 없이, 안 되면 재인코딩) ──
function ffmpeg(argv) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...argv], { stdio: ["ignore", "inherit", "inherit"] });
  return r.status === 0;
}
function ensureFfmpeg() {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (r.status !== 0) throw new Error("ffmpeg 가 없습니다. PowerShell 에서: winget install Gyan.FFmpeg  (설치 뒤 새 창)");
}
async function downloadBatch(b) {
  const item = state.items[b.key] ?? (state.items[b.key] = { status: "pending" });
  if (item.file && fs.existsSync(item.file)) return item;
  const safe = b.key.replace(/[^A-Za-z0-9_-]/g, "_");
  const parts = [];
  for (let i = 0; i < b.parts.length; i += 1) {
    const url = hlsUrlFor(b.parts[i], template);
    if (!url) throw new Error(`영상 주소를 만들 수 없습니다(--hls-template 필요): 글 ${b.parts[i].feedId}`);
    const out = path.join(videoDir, `${safe}_part${i}.mp4`);
    if (!fs.existsSync(out)) {
      const ok = ffmpeg(["-headers", "Referer: https://rallyz.co.kr/\r\n", "-i", url, "-c", "copy", "-bsf:a", "aac_adtstoasc", out]);
      if (!ok) throw new Error(`HLS 내려받기 실패: 글 ${b.parts[i].feedId}`);
    }
    parts.push(out);
  }
  const file = path.join(videoDir, `${safe}.mp4`);
  if (parts.length === 1) {
    fs.copyFileSync(parts[0], file);
  } else {
    const list = path.join(videoDir, `${safe}_list.txt`);
    fs.writeFileSync(list, ffmpegConcatList(parts), "utf8");
    let ok = ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", file]);
    // 조각마다 화질 설정이 달라 그대로 못 합치면 한 번 다시 인코딩한다
    if (!ok) ok = ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-movflags", "+faststart", file]);
    if (!ok) throw new Error(`영상 합치기 실패: ${b.key}`);
  }
  for (const p of parts) fs.rmSync(p, { force: true });
  item.file = file;
  item.sizeBytes = fs.statSync(file).size;
  item.status = "downloaded";
  saveState();
  return item;
}

// ── 유튜브 ──
async function googleError(res, label) {
  const body = await res.json().catch(() => null);
  const reason = typeof body?.error === "string" ? body.error : body?.error?.errors?.[0]?.reason || body?.error?.status || null;
  const err = new Error(`${label}: HTTP ${res.status} ${reason ?? ""}`.trim());
  err.httpStatus = res.status;
  err.reason = reason;
  return err;
}
async function accessToken(db) {
  const { rows } = await db.query(`SELECT "refreshTokenEncrypted" FROM "YouTubeConnection" WHERE id = 'default'`);
  if (!rows[0]) throw new Error("사이트에 유튜브 연결이 없습니다(/admin/youtube).");
  const refresh = openSealedYoutubeToken(rows[0].refreshTokenEncrypted, process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refresh, client_id: process.env.YOUTUBE_OAUTH_CLIENT_ID || "", client_secret: process.env.YOUTUBE_OAUTH_CLIENT_SECRET || "", grant_type: "refresh_token" }),
  });
  if (!res.ok) throw await googleError(res, "유튜브 토큰 갱신 실패");
  return (await res.json()).access_token;
}
/** 하루 한 칸 먼저 차지 — 사이트 reserveYoutubeQuotaSlot 과 같은 한 문장 UPDATE */
async function reserveSlot(db) {
  const today = msToKstYmd(Date.now());
  const { rows } = await db.query(
    `UPDATE "YouTubeConnection"
        SET "quotaUsed" = CASE WHEN "quotaDay" = $1 THEN "quotaUsed" + 1 ELSE 1 END, "quotaDay" = $1, "updatedAt" = NOW()
      WHERE id = 'default' AND ("quotaBlockedUntil" IS NULL OR "quotaBlockedUntil" <= NOW())
        AND ("quotaDay" IS DISTINCT FROM $1 OR "quotaUsed" < $2)
      RETURNING "quotaUsed"`, [today, totalLimit]);
  return rows.length === 1;
}
async function quotaState(db) {
  const { rows } = await db.query(`SELECT "quotaDay", "quotaUsed", "quotaBlockedUntil" FROM "YouTubeConnection" WHERE id = 'default'`);
  const r = rows[0] ?? {};
  return { quotaDay: r.quotaDay ?? null, quotaUsed: Number(r.quotaUsed ?? 0), quotaBlockedUntilMs: r.quotaBlockedUntil ? new Date(r.quotaBlockedUntil).getTime() : null };
}
/** resumable 업로드 — 업로드 주소를 상태 파일에 남겨, 끊기면 다음 실행에서 이어 올린다 */
async function uploadResumable(token, item, title) {
  const size = item.sizeBytes;
  if (!item.uploadUri) {
    const start = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(size), "X-Upload-Content-Type": "video/mp4" },
      body: JSON.stringify({ snippet: { title, description: DESCRIPTION, categoryId: "17" }, status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false, embeddable: true } }),
    });
    if (!start.ok) throw await googleError(start, "유튜브 업로드 시작 실패");
    item.uploadUri = start.headers.get("location");
    if (!item.uploadUri || !/^https:\/\/[^/]*googleapis\.com\//.test(item.uploadUri)) throw new Error("유튜브 업로드 주소를 받지 못했습니다.");
    item.status = "uploading";
    saveState();
  }
  // 어디까지 받았는지 묻는다(처음이면 0)
  let offset = 0;
  const probe = await fetch(item.uploadUri, { method: "PUT", headers: { "Content-Length": "0", "Content-Range": `bytes */${size}` } });
  if (probe.status === 200 || probe.status === 201) return probe.json();
  if (probe.status === 308) {
    const range = probe.headers.get("range");
    offset = range ? Number(range.split("-")[1]) + 1 : 0;
  } else if (probe.status === 404 || probe.status === 410) {
    item.uploadUri = null; saveState();
    throw new Error("업로드 주소가 만료돼 처음부터 다시 올립니다(다음 실행).");
  }
  const body = Readable.toWeb(fs.createReadStream(item.file, { start: offset }));
  const put = await fetch(item.uploadUri, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "Content-Length": String(size - offset), ...(offset > 0 ? { "Content-Range": `bytes ${offset}-${size - 1}/${size}` } : {}) },
    body, duplex: "half",
  });
  if (!put.ok) throw await googleError(put, "유튜브 영상 전송 실패");
  return put.json();
}

if (args.download) {
  ensureFfmpeg();
  const n = Math.max(1, Number(args.download) | 0);
  const todo = plan.batches.filter((b) => !["recorded"].includes(state.items[b.key]?.status) && !state.items[b.key]?.file).slice(0, n);
  for (const b of todo) {
    await downloadBatch(b);
    console.log(`  내려받음 ${b.ymd} ${b.className} (${(state.items[b.key].sizeBytes / 1048576).toFixed(1)}MB)`);
  }
}

if (args.upload) {
  ensureFfmpeg();
  const db = await connectDb();
  try {
    let uploadedThisRun = 0;
    for (const b of plan.batches) {
      const item = state.items[b.key] ?? (state.items[b.key] = { status: "pending" });
      if (item.status === "recorded") continue;
      // 이미 올렸는데 DB 기록만 못 했으면 기록부터(다시 올리지 않는다)
      if (!item.youtubeVideoId) {
        const gate = canUploadMore(await quotaState(db), { todayKst: msToKstYmd(Date.now()), nowMs: Date.now(), totalLimit, uploadedThisRun, perRun });
        if (!gate.ok) { console.log(`멈춤: ${gate.reason}`); break; }
        await downloadBatch(b);
        if (!item.uploadUri && !(await reserveSlot(db))) { console.log("멈춤: 오늘 한도(사이트 크론과 공유)가 찼습니다."); break; }
        try {
          const video = await uploadResumable(await accessToken(db), item, youtubeTitle(b.className, b.ymd));
          item.youtubeVideoId = video.id;
          item.privacy = video.status?.privacyStatus ?? "unknown";
          item.status = "uploaded";
          saveState();
          uploadedThisRun += 1;
        } catch (error) {
          if (classifyYoutubeError(error.httpStatus ?? 0, error.reason) === "QUOTA") {
            await db.query(`UPDATE "YouTubeConnection" SET "quotaBlockedUntil" = $1::timestamptz, "updatedAt" = NOW() WHERE id = 'default'`, [nextKstMidnightIso(Date.now())]);
            console.log("멈춤: 유튜브 할당량 초과 — 다음 KST 자정까지 사이트도 함께 멈춥니다.");
            break;
          }
          throw error;
        }
      }
      const existing = sessionByKey.get(b.key);
      const sessionId = existing?.id ?? item.sessionId ?? randomUUID();
      item.sessionId = sessionId;
      item.sessionVideoId = item.sessionVideoId ?? randomUUID();
      saveState();
      const sql = buildVideoRecordSql({
        key: b.key, sessionId, classId: b.classId, className: b.className, ymd: b.ymd, createSession: !existing,
        previousStatus: existing?.status ?? null, sessionVideoId: item.sessionVideoId, youtubeVideoId: item.youtubeVideoId,
        privacy: item.privacy, sizeBytes: item.sizeBytes,
      }, state.batch);
      await db.query(sql);
      item.status = "recorded";
      saveState();
      fs.rmSync(item.file, { force: true }); // 올린 mp4 는 지운다(디스크 보호) — 원본은 랠리즈·유튜브에 있다
      console.log(`  올림 ${b.ymd} ${b.className} → youtube ${item.youtubeVideoId} (${item.privacy})`);
      if (item.privacy !== "unlisted") {
        console.log("⚠️ 유튜브가 «비공개»로 잠갔습니다(API 심사 전). 학부모가 볼 수 없으니 여기서 멈춥니다. 심사 통과 뒤 --fix-locked.");
        break;
      }
    }
  } finally {
    await db.end();
  }
}

if (args["fix-locked"]) {
  // 심사 통과 뒤: 이관 영상 중 비공개로 잠긴 것을 일부공개로(videos.update 50 units/개)
  const db = await connectDb();
  try {
    const { rows } = await db.query(
      `SELECT v.id, v."youtubeVideoId" FROM "SessionVideo" v JOIN "Session" s ON s.id = v."sessionId"
        WHERE s."importSource" = $1 AND v."youtubeStatus" = 'PRIVATE_LOCKED' AND v."youtubeVideoId" IS NOT NULL AND v."deletedAt" IS NULL
        LIMIT 50`, [IMPORT_SOURCE]);
    const token = rows.length ? await accessToken(db) : null;
    for (const r of rows) {
      const res = await fetch("https://www.googleapis.com/youtube/v3/videos?part=status", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.youtubeVideoId, status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false, embeddable: true } }),
      });
      if (!res.ok) { console.log(`  실패 ${r.youtubeVideoId}: ${(await googleError(res, "공개 범위 변경")).message}`); continue; }
      const privacy = (await res.json()).status?.privacyStatus ?? "unknown";
      await db.query(`UPDATE "SessionVideo" SET "youtubeStatus" = CASE WHEN $2 = 'unlisted' THEN 'UPLOADED' ELSE 'PRIVATE_LOCKED' END, "youtubePrivacy" = $2, "updatedAt" = NOW() WHERE id = $1`, [r.id, privacy]);
      console.log(`  ${r.youtubeVideoId} → ${privacy}`);
    }
  } finally {
    await db.end();
  }
}
