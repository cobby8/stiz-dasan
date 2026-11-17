/**
 * 랠리즈 2026 수업 피드 → 사이트 수업 피드 이관 «순수 규칙» (2026-11-16 원장 결정표 v1~v5).
 *
 * DB·네트워크·파일을 건드리지 않는다 — 입력 → 결과만 계산한다. tests/rallyz-feed-import.test.mjs 가 실제로 돌린다.
 * 실행 스크립트(import-posts.mjs·import-videos.mjs·publish.mjs·rollback.mjs)는 이 파일의 함수만 조립한다.
 *
 * 결정 요약
 *  v1 글·사진 먼저. 피드 순서는 사이트 규칙(수업일 내림차순, src/lib/feed/reportFeedServer.ts)이 정한다 —
 *     그래서 이관은 «정확한 수업일»에 붙이는 것이 정렬의 전부다. 한 수업 안의 여러 글은 쓴 시각 순으로 덧붙인다.
 *  v2 영상은 수업(반·날짜)마다 1개로 묶어 유튜브 일부공개. 최신 수업부터(11월 → 거꾸로).
 *  v4 공개 범위는 사이트와 같다(그 수업 출결·수강 학생 학부모만) — 이 파일은 «누가 보게 되나» 수만 미리 센다.
 *  v5 다산2호점만 — classInfo.instNm 으로 거른다(다산점·평내호평점·슈퍼맥스 제외).
 *
 * 날짜 규칙(전역): 날짜는 "YYYY-MM-DD" 문자열로만 들고 다닌다. 요일은 Date.UTC 로(시간대 개입 없음).
 */
import * as cryptoModule from "node:crypto";

/** Session.importSource 값 — src/lib/feed/importedSession.ts IMPORT_SOURCE_RALLYZ_FEED 와 같아야 한다(테스트가 비교) */
export const IMPORT_SOURCE = "RALLYZ_FEED";
/** 사진 항목에 붙이는 출처 표시 */
export const PHOTO_SOURCE = "RALLYZ_IMPORT";
/** 기본 지점(v5) */
export const DEFAULT_INST = "다산2호점";
/** 비공개 사진 버킷 — src/lib/sessionPhotoEntries.ts PRIVATE_SESSION_PHOTO_BUCKET 과 같다 */
export const PRIVATE_PHOTO_BUCKET = "staff-session-private";
/** 영상 버킷 — src/lib/sessionVideo/rules.ts SESSION_VIDEO_BUCKET 과 같다(사본은 만들지 않고 이름만 쓴다) */
export const VIDEO_BUCKET = "session-videos";
/** 덧붙일 때 기존 내용과 사이 */
export const CONTENT_SEPARATOR = "\n\n";
/** 수업일 보정: 글 쓴 날이 수업 요일이 아니면 며칠 전까지 거슬러 수업일을 찾나 */
export const MAX_BACKTRACK_DAYS = 3;

// ── 날짜 ────────────────────────────────────────────────────────────

const KST_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
const KST_TIME_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

export function isYmd(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 시각(ms) → KST 달력 날짜 */
export function msToKstYmd(ms) {
  return KST_FMT.format(new Date(ms));
}

/**
 * 랠리즈 작성일 값 → { ymd, hms, sortKey } (KST). 모르는 모양이면 null.
 * - "2026-11-12 15:30:22" · "2026.11.12 15:30" · "20261112153022" : 랠리즈는 한국 벽시계로 준다 → 글자 그대로 KST
 * - "2026-11-12T06:30:22Z" · "+09:00" 처럼 시간대가 붙은 ISO : 시각으로 읽어 KST 로 옮긴다
 * - 숫자(초·밀리초) : 시각으로 읽어 KST 로 옮긴다
 */
export function parseRallyzDate(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const ymd = msToKstYmd(ms);
    const hms = KST_TIME_FMT.format(new Date(ms));
    return { ymd, hms, sortKey: `${ymd} ${hms}` };
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^\d{10,13}$/.test(raw)) return parseRallyzDate(Number(raw));
  if (/T\d{2}:\d{2}/.test(raw) && /(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? parseRallyzDate(ms) : null;
  }
  const m = /^(\d{4})[-./]?(\d{2})[-./]?(\d{2})(?:[ T]?(\d{2}):?(\d{2})(?::?(\d{2}))?)?/.exec(raw);
  if (!m) return null;
  const ymd = `${m[1]}-${m[2]}-${m[3]}`;
  if (!isYmd(ymd)) return null;
  const hms = `${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}`;
  return { ymd, hms, sortKey: `${ymd} ${hms}` };
}

const DOW_CODES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];

/** 요일(0=일) — Date.UTC 로만 계산(시간대 개입 없음) */
export function ymdDow(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** Class.dayOfWeek("Mon"·"월"·"Mon,Wed") → 요일 번호 집합. 모르면 빈 집합(= 보정 안 함) */
export function classDows(dayOfWeek) {
  const out = new Set();
  for (const part of String(dayOfWeek ?? "").split(/[,\s/]+/)) {
    const p = part.trim();
    if (!p) continue;
    const en = DOW_CODES.findIndex((code) => code.toLowerCase() === p.slice(0, 3).toLowerCase());
    if (en >= 0) { out.add(en); continue; }
    const ko = DOW_KO.indexOf(p[0]);
    if (ko >= 0) out.add(ko);
  }
  return out;
}

/**
 * 글 쓴 날 → 수업일. 글 쓴 날이 그 반 요일이면 그날, 아니면 최대 3일 전까지 거슬러 반 요일을 찾는다
 * (수업 다음 날 저녁에 올린 글). 반 요일을 모르거나 못 찾으면 글 쓴 날 그대로.
 * @returns {{ ymd: string, shifted: number }} shifted = 며칠 당겼나
 */
export function resolveSessionYmd(postYmd, dows) {
  if (!dows || dows.size === 0 || dows.has(ymdDow(postYmd))) return { ymd: postYmd, shifted: 0 };
  for (let back = 1; back <= MAX_BACKTRACK_DAYS; back += 1) {
    const ymd = addDaysYmd(postYmd, -back);
    if (dows.has(ymdDow(ymd))) return { ymd, shifted: back };
  }
  return { ymd: postYmd, shifted: 0 };
}

// ── 반 이름 ──────────────────────────────────────────────────────────

/**
 * 반 이름 앞의 꼬리표 떼기 — 실제 랠리즈 반 이름은 «1. 월요일 4교시»·«1-6. 토요일 3교시»처럼 요일 순번이 붙고,
 * 사이트의 지난 반은 «[종료] 목요일 2교시 슈팅 클래스»처럼 앞에 꼬리표가 붙는다(2026-11-17 실제 데이터 확인).
 */
function stripClassPrefix(name) {
  return String(name ?? "").normalize("NFC").trim()
    .replace(/^\d+(?:-\d+)*\.\s*/, "") // «1. » · «1-6. » (연도 «2026 여름특강» 은 점이 없어 남는다)
    .replace(/^[[［【][^\]］】]*[\]］】]\s*/, "") // «[종료] »
    .trim();
}

/**
 * 반 이름 비교용 정규화(괄호 «뗀» 이름) — 앞 꼬리표·꼬리 괄호(«(대표팀)»·«(성인반)»)·공백·대소문자 차이를 없앤다.
 * 예: "월4 (대표팀)" → "월4", " 토 7교시 " → "토7교시", "1. 월요일 4교시" → "월요일4교시"
 * 사이트에 닫는 괄호가 빠진 이름(«목요일 8교시(슈팅클래스»)도 괄호를 뗀다.
 */
export function normalizeClassName(name) {
  let s = stripClassPrefix(name);
  // 꼬리 괄호를 여러 번 벗긴다: "월4(대표팀)(B)" → "월4"
  for (let i = 0; i < 3; i += 1) {
    const next = s.replace(/\s*[([{（【][^()[\]{}（）【】]*[)\]}）】]\s*$/, "").replace(/\s*[([{（【][^()[\]{}（）【】]*$/, "").trim();
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, "").toLowerCase();
}

/**
 * 반 이름 비교용 정규화(괄호 «안 뗀» 이름) — 앞 꼬리표·공백·괄호 글자만 지우고 괄호 «안의 말»은 남긴다.
 * 예: "4. 목요일 8교시(슈팅클래스)" → "목요일8교시슈팅클래스" = 사이트 "목요일 8교시(슈팅클래스"
 *     "[종료] 목요일 2교시 슈팅 클래스" → "목요일2교시슈팅클래스"
 */
export function classNameKey(name) {
  return stripClassPrefix(name).replace(/[()[\]{}（）【】［］]/g, "").replace(/\s+/g, "").toLowerCase();
}

/**
 * 랠리즈 반 이름 → 사이트 반. 우선순위:
 *  ① 수동 매핑(classMap: 랠리즈 이름 → 사이트 반 id 또는 이름)
 *  ② «괄호 안의 말까지» 같은 반이 하나 → exact  (슈팅클래스·성인반처럼 같은 교시에 반이 둘인 경우를 먼저 가른다)
 *  ③ 랠리즈 이름의 괄호를 뗀 것이 사이트 반 이름(괄호 포함)과 같은 반이 하나 → suffix
 *     예: «2. 화요일 8교시(성인반)» → 사이트 «화요일 8교시». 계획 출력에 따로 보여 사람이 확인한다.
 *     ⚠️ 사이트 쪽 괄호는 떼지 않는다 — «목요일 8교시(성인반)»이 «목요일 8교시(슈팅클래스»로 붙으면 안 된다.
 *  둘 이상이면 모호(null + reason).
 * @returns {{ classId: string|null, reason: string }}
 */
export function matchClass(rallyzName, classes, classMap = {}) {
  const manual = classMap[rallyzName] ?? classMap[String(rallyzName ?? "").trim()] ?? classMap[normalizeClassName(rallyzName)];
  if (manual) {
    const byId = classes.find((c) => c.id === manual);
    if (byId) return { classId: byId.id, reason: "manual" };
    const byName = classes.filter((c) => classNameKey(c.name) === classNameKey(manual));
    if (byName.length === 1) return { classId: byName[0].id, reason: "manual" };
    return { classId: null, reason: "manual-not-found" };
  }
  const full = classNameKey(rallyzName);
  if (!full) return { classId: null, reason: "no-name" };
  const exact = classes.filter((c) => classNameKey(c.name) === full);
  if (exact.length === 1) return { classId: exact[0].id, reason: "exact" };
  if (exact.length > 1) return { classId: null, reason: "ambiguous" };
  const base = normalizeClassName(rallyzName);
  if (base && base !== full) {
    const hits = classes.filter((c) => classNameKey(c.name) === base);
    if (hits.length === 1) return { classId: hits[0].id, reason: "suffix" };
    if (hits.length > 1) return { classId: null, reason: "ambiguous" };
  }
  return { classId: null, reason: "not-found" };
}

/**
 * 반 요일 — dayOfWeek 칸이 요일이 아니면(지난 반 «Archived») 반 이름의 «○요일»에서 읽는다.
 * 둘 다 없으면 빈 집합(= 수업일 보정 안 함).
 */
export function dowsForClass(cls) {
  const fromField = classDows(cls?.dayOfWeek);
  if (fromField.size) return fromField;
  const m = /([월화수목금토일])요일/.exec(stripClassPrefix(cls?.name));
  return m ? classDows(m[1]) : new Set();
}

/**
 * 반 매칭 요약 — 랠리즈 반 이름마다 «어느 사이트 반에 어떻게 붙었나 · 글·사진·영상 수».
 * 계획 출력에서 «괄호 떼고 맞춤(suffix)»·«못 맞춤»을 사람이 확인하게 한다.
 */
export function summarizeClassMatches(posts, classes, classMap = {}, inst = DEFAULT_INST) {
  const byName = new Map();
  for (const post of posts) {
    if (!isTargetInst(post.instNm, inst)) continue;
    let row = byName.get(post.className);
    if (!row) {
      const m = matchClass(post.className, classes, classMap);
      row = { rallyzName: post.className, classId: m.classId, siteName: classes.find((c) => c.id === m.classId)?.name ?? null, reason: m.reason, posts: 0, photos: 0, videos: 0, from: post.created.ymd, to: post.created.ymd };
      byName.set(post.className, row);
    }
    row.posts += 1;
    row.photos += post.photos.length;
    row.videos += post.videos.length;
    if (post.created.ymd < row.from) row.from = post.created.ymd;
    if (post.created.ymd > row.to) row.to = post.created.ymd;
  }
  return [...byName.values()].sort((a, b) => (a.rallyzName < b.rallyzName ? -1 : 1));
}

// ── 피드 글 정규화 ────────────────────────────────────────────────────

const pick = (obj, keys) => {
  for (const key of keys) {
    const v = key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

const ID_KEYS = ["feedId", "feedSeq", "boardId", "boardSeq", "brdId", "id", "seq"];
const TEXT_KEYS = ["contents", "content", "feedContents", "feedContent", "text", "cont", "body", "boardContents"];
const DATE_KEYS = ["regDt", "regDate", "createDt", "createdAt", "createDate", "insDt", "writeDt", "feedDt", "registDt"];
const CLASS_KEYS = ["classInfo.className", "classInfo.classNm", "classInfo.clsNm", "classInfo.name", "className", "classNm", "clsNm"];
const INST_KEYS = ["classInfo.instNm", "instNm", "classInfo.instName", "instName"];

const IMAGE_RE = /^https?:\/\/[^\s"']+\.(?:jpe?g|png|webp|gif|heic)(?:\?[^\s"']*)?$/i;
const M3U8_RE = /^https?:\/\/[^\s"']+\.m3u8(?:\?[^\s"']*)?$/i;
const VOD_ID_RE = /feed_vod_bc\/([A-Za-z0-9_-]+?)(?:_AVC_[A-Z]+)?\.mp4/;

/** 훑지 않는 칸 — 작성자 프로필 사진·반/지점 정보·댓글이 수업 사진으로 섞이지 않게 */
const SKIP_KEY_RE = /(profile|writer|user|member|author|teacher|classInfo|inst|comment|reply|thumb|emoti|sticker)/i;

/** 글 안의 문자열 값을 훑는다(필드 이름을 몰라도 사진·영상 주소를 찾게) — 위 칸은 건너뛴다 */
function collectStrings(value, out = [], depth = 0) {
  if (depth > 8 || value === null || value === undefined) return out;
  if (typeof value === "string") { out.push(value.trim()); return out; }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out, depth + 1); return out; }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (!SKIP_KEY_RE.test(k)) collectStrings(v, out, depth + 1);
  }
  return out;
}

/** 사진 주소 → 1000px 축소본 주소(랠리즈는 축소본만 열린다) */
export function photoUrl1000(url) {
  const u = new URL(url);
  u.searchParams.set("type", "w");
  u.searchParams.set("w", "1000");
  return u.toString();
}

/** 썸네일·프로필 같은 작은 그림은 수업 사진이 아니다 */
function isLikelyThumb(url) {
  // vod = 영상 미리보기 그림(영상은 따로 옮긴다)
  return /(thumb|profile|avatar|_t\.|_s\.|icon|emoticon|sticker|vod)/i.test(url);
}

/**
 * 랠리즈 원본 글 하나 → 정규화된 글. 필요한 칸이 없으면 null.
 * @returns {{ id, text, created:{ymd,hms,sortKey}, className, instNm, photos: string[], videos: Array<{vodId:string|null, m3u8:string|null}> } | null}
 */
export function normalizeFeedItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = pick(raw, ID_KEYS);
  const created = parseRallyzDate(pick(raw, DATE_KEYS));
  if (id === undefined || !created) return null;
  const textRaw = pick(raw, TEXT_KEYS);
  const text = typeof textRaw === "string" ? cleanText(textRaw) : "";
  const photos = [];
  const videos = [];
  const seenPhoto = new Set();
  const seenVod = new Set();
  const addPhoto = (s) => {
    let base;
    try { const u = new URL(s); u.search = ""; base = u.toString(); } catch { return; }
    if (!seenPhoto.has(base)) { seenPhoto.add(base); photos.push(base); }
  };
  const addVideo = (s) => {
    const vodId = VOD_ID_RE.exec(s)?.[1] ?? null;
    const m3u8 = M3U8_RE.test(s) ? s : null;
    if (!vodId && !m3u8) return;
    const key = vodId ?? s;
    if (!seenVod.has(key)) { seenVod.add(key); videos.push({ vodId, m3u8 }); }
  };
  // ① 실제 내보내기 모양(2026-11-17 확인): media: [{ kind: "photo"|"video", src }] — 종류가 적혀 있으니 그대로 믿는다(정렬 순서 유지)
  const media = Array.isArray(raw.media) ? raw.media.filter((m) => m && typeof m === "object" && typeof m.src === "string" && m.kind) : [];
  if (media.length) {
    for (const m of media) {
      const src = m.src.trim();
      if (m.kind === "photo") addPhoto(src);
      else if (m.kind === "video") addVideo(src);
    }
    return { id: String(id), text, created, className: String(pick(raw, CLASS_KEYS) ?? "").trim(), instNm: String(pick(raw, INST_KEYS) ?? "").trim(), photos, videos };
  }
  // ② 예전 추측 모양(칸 이름을 모를 때) — 글 안의 문자열을 훑어 사진·영상 주소를 찾는다
  const strings = collectStrings(raw);
  for (const s of strings) {
    if (M3U8_RE.test(s)) {
      const vodId = VOD_ID_RE.exec(s)?.[1] ?? null;
      const key = vodId ?? s;
      if (!seenVod.has(key)) { seenVod.add(key); videos.push({ vodId, m3u8: s }); }
      continue;
    }
    const vod = VOD_ID_RE.exec(s);
    if (vod) {
      if (!seenVod.has(vod[1])) { seenVod.add(vod[1]); videos.push({ vodId: vod[1], m3u8: null }); }
      continue;
    }
    if (IMAGE_RE.test(s) && !isLikelyThumb(s)) {
      let base;
      try { const u = new URL(s); u.search = ""; base = u.toString(); } catch { continue; }
      if (!seenPhoto.has(base)) { seenPhoto.add(base); photos.push(base); }
    }
  }
  return {
    id: String(id),
    text,
    created,
    className: String(pick(raw, CLASS_KEYS) ?? "").trim(),
    instNm: String(pick(raw, INST_KEYS) ?? "").trim(),
    photos,
    videos,
  };
}

/** 본문 정리 — HTML 줄바꿈·태그 제거, 앞뒤 공백, NUL 제거 */
export function cleanText(text) {
  return String(text)
    .replace(/\u0000/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 지점 거르기(v5) — 공백 무시하고 포함 비교. 지점 이름이 없는 글은 버린다(섞일 위험) */
export function isTargetInst(instNm, target = DEFAULT_INST) {
  const a = String(instNm ?? "").replace(/\s+/g, "");
  const b = String(target ?? "").replace(/\s+/g, "");
  return a.length > 0 && b.length > 0 && a.includes(b);
}

/**
 * 크롬에서 뽑은 피드 파일(JSON) → 정규화된 글 목록(같은 id 는 한 번만).
 * 파일 모양: { items: [...] } 또는 [...] 또는 { pages: [{ list: [...] }] } 등 — 배열을 찾아 글 모양인 것만 쓴다.
 */
export function readFeedExport(json) {
  const rawItems = [];
  const visit = (v, depth = 0) => {
    if (depth > 5 || !v) return;
    if (Array.isArray(v)) {
      if (v.some((x) => x && typeof x === "object" && pick(x, ID_KEYS) !== undefined && pick(x, DATE_KEYS) !== undefined)) {
        rawItems.push(...v);
      } else {
        for (const x of v) visit(x, depth + 1);
      }
      return;
    }
    if (typeof v === "object") for (const x of Object.values(v)) visit(x, depth + 1);
  };
  visit(json);
  const seen = new Set();
  const posts = [];
  let invalid = 0;
  for (const raw of rawItems) {
    const post = normalizeFeedItem(raw);
    if (!post) { invalid += 1; continue; }
    if (seen.has(post.id)) continue;
    seen.add(post.id);
    posts.push(post);
  }
  return { posts, invalid, rawCount: rawItems.length };
}

// ── 계획 ────────────────────────────────────────────────────────────

/**
 * 글 목록 + 사이트 스냅숏 → 수업별 이관 계획.
 * @param {object} input
 * @param {Array} input.posts            readFeedExport().posts
 * @param {{classes:Array, sessions:Array, imported:Array, enrollStarts?:Array, todayKst:string}} input.snapshot
 * @param {object} [input.options]       { inst, from, to, classFilter, classMap, createMissing, allowPublished }
 * @returns {{ groups: Array, skipped: Array, counts: object }}
 *   groups 는 수업일 «내림차순»(최신 먼저) — 실행 순서·보고 순서. 사이트 피드 정렬과 같은 방향.
 */
export function planPostImport({ posts, snapshot, options = {} }) {
  const inst = options.inst ?? DEFAULT_INST;
  const classMap = options.classMap ?? {};
  const imported = new Set((snapshot.imported ?? []).filter((r) => r.kind === "POST").map((r) => String(r.sourceKey)));
  const classesById = new Map(snapshot.classes.map((c) => [c.id, c]));
  const sessionByKey = new Map();
  for (const s of snapshot.sessions ?? []) {
    const key = `${s.classId}:${s.ymd}`;
    // 같은 반·같은 날 기록이 둘이면 sessionKey 가 있는 쪽(정본) → 먼저 만든 쪽
    const prev = sessionByKey.get(key);
    if (!prev || (!prev.sessionKey && s.sessionKey)) sessionByKey.set(key, s);
  }
  const skipped = [];
  const groupsByKey = new Map();
  const counts = { total: posts.length, otherInst: 0, outOfRange: 0, alreadyImported: 0, noClass: 0, empty: 0, publishedSkipped: 0, noSessionSkipped: 0, planned: 0 };
  for (const post of posts) {
    if (!isTargetInst(post.instNm, inst)) { counts.otherInst += 1; continue; }
    if (imported.has(post.id)) { counts.alreadyImported += 1; continue; }
    if (!post.text && post.photos.length === 0) { counts.empty += 1; continue; }
    const match = matchClass(post.className, snapshot.classes, classMap);
    if (!match.classId) { counts.noClass += 1; skipped.push({ id: post.id, reason: `반 매칭 실패(${match.reason})`, className: post.className, ymd: post.created.ymd }); continue; }
    // 반 하나만: id 또는 이름(괄호 안의 말까지 비교 — «목요일 8교시»가 슈팅클래스까지 잡지 않게)
    if (options.classFilter && match.classId !== options.classFilter
      && classNameKey(classesById.get(match.classId)?.name) !== classNameKey(options.classFilter)) continue;
    const cls = classesById.get(match.classId);
    const dows = dowsForClass(cls);
    const { ymd, shifted } = resolveSessionYmd(post.created.ymd, dows);
    if ((options.from && ymd < options.from) || (options.to && ymd > options.to)) { counts.outOfRange += 1; continue; }
    const key = `${match.classId}:${ymd}`;
    let group = groupsByKey.get(key);
    if (!group) {
      const existing = sessionByKey.get(key) ?? null;
      // offDay = 3일 거슬러도 반 요일을 못 찾아 «반 요일이 아닌 날»로 남음(미리 올린 글·보강·반 요일 변경) → 계획 출력에서 경고
      group = { key, classId: match.classId, className: cls?.name ?? "", ymd, existing, posts: [], shifted: [], offDay: dows.size > 0 && !dows.has(ymdDow(ymd)) };
      groupsByKey.set(key, group);
    }
    group.posts.push(post);
    if (shifted) group.shifted.push({ id: post.id, from: post.created.ymd, back: shifted });
  }
  const groups = [];
  for (const group of groupsByKey.values()) {
    group.posts.sort((a, b) => (a.created.sortKey < b.created.sortKey ? -1 : a.created.sortKey > b.created.sortKey ? 1 : a.id < b.id ? -1 : 1));
    if (group.existing?.published && !options.allowPublished) {
      counts.publishedSkipped += group.posts.length;
      skipped.push(...group.posts.map((p) => ({ id: p.id, reason: "이미 학부모에게 보낸 수업(--allow-published 로만 덧붙임)", className: group.className, ymd: group.ymd })));
      continue;
    }
    if (!group.existing && !options.createMissing) {
      counts.noSessionSkipped += group.posts.length;
      skipped.push(...group.posts.map((p) => ({ id: p.id, reason: "사이트에 그날 수업 기록 없음(--create-missing 으로 만들기)", className: group.className, ymd: group.ymd })));
      continue;
    }
    group.viewers = countViewers(group, snapshot);
    counts.planned += group.posts.length;
    groups.push(group);
  }
  groups.sort(compareGroupsNewestFirst);
  return { groups, skipped, counts };
}

/** 수업일 내림차순, 같은 날이면 반 이름 → 키 (사이트 피드와 같은 «최신 위로») */
export function compareGroupsNewestFirst(a, b) {
  if (a.ymd !== b.ymd) return a.ymd < b.ymd ? 1 : -1;
  if (a.className !== b.className) return a.className < b.className ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * 이 수업을 «볼 수 있게 될» 학생 수(대략) — 사이트 규칙(feedParticipantSql)과 같은 두 갈래:
 *  ① 그 수업에 출결 기록이 있는 학생(스냅숏의 attendanceStudents) ② 그 반에 ACTIVE 수강이고 시작일 ≤ 수업일
 * 0 이면 발행해도 아무 학부모도 못 본다 → 보고서에 경고.
 */
export function countViewers(group, snapshot) {
  const ids = new Set(group.existing?.attendanceStudents ?? []);
  for (const e of snapshot.enrollStarts ?? []) {
    if (e.classId === group.classId && isYmd(e.startYmd) && e.startYmd <= group.ymd) ids.add(e.studentId);
  }
  return ids.size;
}

/** 수업 하나에 덧붙일 글 — 여러 글은 쓴 순서대로 빈 줄로 잇는다. 빈 글은 뺀다 */
export function buildAppendedText(posts) {
  return posts.map((p) => p.text).filter((t) => t && t.trim()).join(CONTENT_SEPARATOR);
}

/** 기존 내용 + 덧붙일 글(덮어쓰지 않는다) — SQL 과 같은 규칙(테스트용) */
export function appendContent(existing, added) {
  if (!added) return existing ?? null;
  if (!existing || !existing.trim()) return added;
  return `${existing}${CONTENT_SEPARATOR}${added}`;
}

/** 덧붙인 글 빼기(되돌림) — SQL 과 같은 규칙(테스트용) */
export function removeAppendedContent(current, added) {
  if (!added || !current) return current ?? null;
  if (current === added) return null;
  const tail = `${CONTENT_SEPARATOR}${added}`;
  if (current.endsWith(tail)) return current.slice(0, -tail.length);
  const idx = current.indexOf(tail);
  if (idx >= 0) return current.slice(0, idx) + current.slice(idx + tail.length);
  const idx2 = current.indexOf(added);
  if (idx2 >= 0) return (current.slice(0, idx2) + current.slice(idx2 + added.length)).trim() || null;
  return current;
}

// ── 사진 항목 ────────────────────────────────────────────────────────

/** 사이트 비공개 사진 경로 — 선생님 업로드와 같은 모양(isValidPrivateSessionPhotoRef 가 이 모양만 연다) */
export function privatePhotoPath(classId, sessionId, photoId) {
  return `staff-sessions/${classId}/${sessionId}/${photoId}.jpg`;
}

/** 학부모 화면이 여는 사진 주소(권한 검사 프록시) */
export function privatePhotoRoute(sessionId, photoId) {
  return `/api/staff/sessions/${sessionId}/photos/${photoId}`;
}

/** SocialPostDraft.mediaJSON 에 넣을 사진 객체(선생님 업로드와 같은 칸 + 출처 표시) */
export function storedPhoto({ classId, sessionId, photoId, rallyzFeedId }) {
  return {
    id: photoId,
    type: "image",
    url: privatePhotoRoute(sessionId, photoId),
    storageBucket: PRIVATE_PHOTO_BUCKET,
    storagePath: privatePhotoPath(classId, sessionId, photoId),
    visibility: "PRIVATE",
    source: PHOTO_SOURCE,
    rallyzFeedId: String(rallyzFeedId),
  };
}

// ── SQL 만들기(값은 전부 리터럴로 안전하게) ─────────────────────────────

/** SQL 문자열 리터럴 — 작은따옴표를 두 번, NUL 제거(standard_conforming_strings=on 기준: 역슬래시는 글자 그대로) */
export function sqlText(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/\u0000/g, "").replace(/'/g, "''")}'`;
}

export function sqlBool(value) {
  return value ? "true" : "false";
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function assertSafeId(value, label) {
  if (!SAFE_ID.test(String(value))) throw new Error(`${label} 모양이 이상합니다: ${value}`);
  return String(value);
}

/**
 * 수업 하나(group) 이관 SQL — DO 블록 하나(그 안에서 글마다 장부 확인 → 없을 때만 덧붙임).
 * 같은 SQL 을 두 번 돌려도 이미 들어간 글은 건너뛴다(장부 UNIQUE + 존재 확인).
 * @param {object} g  { sessionId, createSession, classId, ymd, previousStatus, posts:[{id, text, createdSortKey, className, photos:[storedPhoto]}] }
 * @param {string} batch
 * @param {{publish?: boolean}} opts  publish=true 면 이 수업을 알림 없이 바로 발행(기본 false — 원장 확인 뒤 publish.mjs)
 */
export function buildGroupSql(g, batch, opts = {}) {
  const sid = assertSafeId(g.sessionId, "수업 id");
  const cid = assertSafeId(g.classId, "반 id");
  if (!isYmd(g.ymd)) throw new Error(`수업일 모양이 이상합니다: ${g.ymd}`);
  const lines = [];
  lines.push(`-- ${g.className} ${g.ymd} (${g.posts.length}글) ${g.createSession ? "새 수업 기록" : "기존 수업 기록"} ${sid}`);
  lines.push("DO $rz$");
  // v_*: 이 블록이 손대기 «전» 수업 상태 — 이 블록에서 처음 들어가는 장부 줄에만 적는다(되돌림 기준).
  //      같은 수업의 두 번째 글이 «이미 바뀐 상태»를 이전 상태로 적지 않게.
  lines.push("DECLARE v_status TEXT; v_pub BOOLEAN; v_created BOOLEAN := false; v_first BOOLEAN := true;");
  lines.push("BEGIN");
  lines.push(`  SELECT status, COALESCE(published, false) INTO v_status, v_pub FROM "Session" WHERE id = ${sqlText(sid)};`);
  if (g.createSession) {
    // 같은 반·같은 날 기록이 그사이 생겼으면 sessionKey UNIQUE 로 실패한다 → 전체 취소(조용히 둘로 갈라지지 않게)
    lines.push(`  IF NOT FOUND THEN`);
    lines.push(`    INSERT INTO "Session" (id, "classId", date, "sessionKey", status, published, "importSource", "createdAt", "updatedAt")`);
    lines.push(`    VALUES (${sqlText(sid)}, ${sqlText(cid)}, ${sqlText(g.ymd)}::date, ${sqlText(`${cid}:${g.ymd}`)}, 'COMPLETED', false, ${sqlText(IMPORT_SOURCE)}, NOW(), NOW());`);
    lines.push("    v_created := true;");
    lines.push("  END IF;");
  }
  g.posts.forEach((p) => {
    const photos = p.photos ?? [];
    const routes = photos.map((ph) => ph.url);
    lines.push(`  -- 랠리즈 글 ${p.id} (${p.createdSortKey}) 사진 ${photos.length}`);
    lines.push(`  IF NOT EXISTS (SELECT 1 FROM "RallyzFeedImport" WHERE kind = 'POST' AND "sourceKey" = ${sqlText(p.id)}) THEN`);
    // 이전 상태·발행 여부는 «이 블록 시작 때 DB 값»(스냅숏 뒤에 바뀌었어도 되돌림이 정확하게)
    lines.push(`    INSERT INTO "RallyzFeedImport" (kind, "sourceKey", "sessionId", "createdSession", "previousStatus", "previousPublished", "appendedContent", "photoEntriesJSON", "rallyzCreatedAt", "rallyzClassName", batch)`);
    lines.push(`    VALUES ('POST', ${sqlText(p.id)}, ${sqlText(sid)}, v_created AND v_first, CASE WHEN v_first THEN v_status END, CASE WHEN v_first THEN v_pub END, ${sqlText(p.text || null)}, ${sqlText(JSON.stringify(photos))}, ${sqlText(p.createdSortKey)}, ${sqlText(p.className)}, ${sqlText(batch)});`);
    lines.push("    v_first := false;");
    for (const ph of photos) {
      // 사진 원장(SocialPostDraft) — 학부모 사진 라우트가 여기서 사진을 찾는다. DRAFT = SNS 검토 목록·게시 대기열에 안 뜬다
      lines.push(`    INSERT INTO "SocialPostDraft" (id, "authorUserId", "authorName", "authorRole", status, "mediaJSON", "isPublic", "sessionId", "classId", source, "subjectStudentIdsJSON", memo, "createdAt", "updatedAt")`);
      lines.push(`    VALUES (gen_random_uuid()::text, NULL, '랠리즈 이관', 'ADMIN', 'DRAFT', ${sqlText(JSON.stringify([ph]))}, false, ${sqlText(sid)}, ${sqlText(cid)}, 'SESSION_PHOTO', '[]', ${sqlText(`RALLYZ_IMPORT:${batch}:${p.id}`)}, NOW(), NOW());`);
    }
    const sets = [];
    if (p.text) {
      sets.push(`content = CASE WHEN content IS NULL OR btrim(content) = '' THEN ${sqlText(p.text)} ELSE content || ${sqlText(CONTENT_SEPARATOR)} || ${sqlText(p.text)} END`);
    }
    if (routes.length) {
      sets.push(`"photosJSON" = (COALESCE(NULLIF(btrim("photosJSON"), ''), '[]')::jsonb || ${sqlText(JSON.stringify(routes))}::jsonb)::text`);
    }
    // 지난 수업이 «예정»으로 남아 있으면 «완료»로(피드는 완료 수업만 보인다) — 이전 상태는 장부에 있다
    sets.push(`status = CASE WHEN status = 'PLANNED' THEN 'COMPLETED' ELSE status END`);
    sets.push(`"importSource" = ${sqlText(IMPORT_SOURCE)}`);
    sets.push(`"updatedAt" = NOW()`);
    lines.push(`    UPDATE "Session" SET ${sets.join(",\n        ")}`);
    lines.push(`      WHERE id = ${sqlText(sid)};`);
    lines.push("  END IF;");
  });
  if (opts.publish) lines.push(`  ${publishSql([sid])}`);
  lines.push("END");
  lines.push("$rz$;");
  const sql = lines.join("\n");
  // 블록 구분 글자가 본문에 섞이면 SQL 이 깨진다 → 실행 전에 멈춘다(사실상 없지만 조용히 잘못 들어가는 것보다 낫다)
  if ((sql.match(/\$rz\$/g) ?? []).length !== 2) throw new Error(`글 본문에 $rz$ 가 있어 SQL 을 만들 수 없습니다(수업 ${sid})`);
  return sql;
}

/**
 * 알림 없이 발행 — 관리자·선생님 «발행» 버튼은 알림 경로를 타므로 쓰지 않는다.
 * 이관 표시가 있는 «완료» 수업만, 아직 안 보낸 것만 바꾼다(publishedAt 은 처음 발행일 때만 찍는다).
 */
export function publishSql(sessionIds) {
  const ids = sessionIds.map((id) => sqlText(assertSafeId(id, "수업 id"))).join(", ");
  return `UPDATE "Session" SET published = true, "publishedAt" = COALESCE("publishedAt", NOW()), "updatedAt" = NOW()
     WHERE id IN (${ids}) AND "importSource" = ${sqlText(IMPORT_SOURCE)} AND status = 'COMPLETED' AND published = false;`;
}

/**
 * 실행 묶음(batch) 되돌림 SQL — 장부(RallyzFeedImport)를 보고 정확히 덧붙인 것만 뺀다.
 * 순서: 영상 지움 표시(유튜브 사본은 크론이 지운다) → 사진 원장 삭제·파일 삭제 대기열 → 글·사진 항목 빼기 → 상태 복원
 *       → 이관이 만든 수업(출결이 없을 때만) 삭제 → 장부 삭제 → 남은 이관이 없으면 importSource 비우기.
 */
export function buildRollbackSql(batch) {
  const b = sqlText(batch);
  return `-- 랠리즈 피드 이관 되돌림: batch ${batch}
BEGIN;
-- 1) 이 묶음의 영상: 지움 표시 → youtube-upload 크론이 유튜브 사본을 지운다
UPDATE "SessionVideo" v SET "deletedAt" = NOW(), "updatedAt" = NOW()
  FROM "RallyzFeedImport" l
 WHERE l.batch = ${b} AND l.kind = 'VIDEO' AND l."sessionVideoId" = v.id AND v."deletedAt" IS NULL;
-- 2) 사진 파일 삭제 대기열(크론이 저장소에서 지운다) + 사진 원장 삭제
INSERT INTO "SessionPhotoDeletionJob" (id, "photoId", "storageBucket", "storagePath", status, attempts, "nextAttemptAt", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, e->>'id', e->>'storageBucket', e->>'storagePath', 'PENDING', 0, NOW(), NOW(), NOW()
  FROM "RallyzFeedImport" l, jsonb_array_elements(l."photoEntriesJSON"::jsonb) e
 WHERE l.batch = ${b} AND l.kind = 'POST'
ON CONFLICT ("photoId") DO UPDATE SET status = 'PENDING', "nextAttemptAt" = NOW(), "updatedAt" = NOW();
DELETE FROM "SocialPostDraft" WHERE memo LIKE ${sqlText(`RALLYZ_IMPORT:${batch}:%`)} AND status = 'DRAFT';
-- 3) 글·사진 항목 빼기(장부 한 줄씩 — 한 수업에 글이 여럿일 수 있다)
DO $rz$
DECLARE r RECORD; cur TEXT; tail TEXT;
BEGIN
  FOR r IN SELECT * FROM "RallyzFeedImport" WHERE batch = ${b} AND kind = 'POST' ORDER BY "importedAt" DESC LOOP
    IF r."appendedContent" IS NOT NULL THEN
      SELECT content INTO cur FROM "Session" WHERE id = r."sessionId";
      tail := ${sqlText(CONTENT_SEPARATOR)} || r."appendedContent";
      IF cur = r."appendedContent" THEN cur := NULL;
      ELSIF right(cur, length(tail)) = tail THEN cur := left(cur, length(cur) - length(tail));
      ELSE cur := NULLIF(btrim(replace(cur, tail, '')), '');
      END IF;
      UPDATE "Session" SET content = cur, "updatedAt" = NOW() WHERE id = r."sessionId";
    END IF;
    UPDATE "Session" s SET "photosJSON" = (
        SELECT COALESCE(jsonb_agg(x ORDER BY ord), '[]'::jsonb)::text
          FROM jsonb_array_elements(COALESCE(NULLIF(btrim(s."photosJSON"), ''), '[]')::jsonb) WITH ORDINALITY AS t(x, ord)
         WHERE NOT (x #>> '{}' IN (SELECT e->>'url' FROM jsonb_array_elements(r."photoEntriesJSON"::jsonb) e))
      ), "updatedAt" = NOW()
     WHERE s.id = r."sessionId" AND jsonb_array_length(r."photoEntriesJSON"::jsonb) > 0;
    IF r."previousStatus" IS NOT NULL THEN
      UPDATE "Session" SET status = r."previousStatus", "updatedAt" = NOW() WHERE id = r."sessionId" AND status = 'COMPLETED';
    END IF;
    -- 이관 전에 학부모에게 안 보낸 수업이었으면 다시 «안 보냄»으로(발행 시각은 남겨 다음 발행 때 «처음»이 아니게)
    IF r."previousPublished" IS FALSE THEN
      UPDATE "Session" SET published = false, "updatedAt" = NOW() WHERE id = r."sessionId" AND published = true;
    END IF;
  END LOOP;
END
$rz$;
-- 3-2) 영상 장부도 같은 규칙(영상만 옮긴 수업)
DO $rz$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM "RallyzFeedImport" WHERE batch = ${b} AND kind = 'VIDEO' LOOP
    IF r."previousStatus" IS NOT NULL THEN
      UPDATE "Session" SET status = r."previousStatus", "updatedAt" = NOW() WHERE id = r."sessionId" AND status = 'COMPLETED';
    END IF;
    IF r."previousPublished" IS FALSE THEN
      UPDATE "Session" SET published = false, "updatedAt" = NOW() WHERE id = r."sessionId" AND published = true;
    END IF;
  END LOOP;
END
$rz$;
-- 4) 이관이 만든 수업 기록: 출결·다른 사진·영상이 없을 때만 삭제(장부·영상 행은 CASCADE)
DELETE FROM "Session" s
 WHERE s.id IN (SELECT "sessionId" FROM "RallyzFeedImport" WHERE batch = ${b} AND "createdSession")
   AND NOT EXISTS (SELECT 1 FROM "Attendance" a WHERE a."sessionId" = s.id)
   AND NOT EXISTS (SELECT 1 FROM "RallyzFeedImport" o WHERE o."sessionId" = s.id AND o.batch <> ${b})
   AND NOT EXISTS (SELECT 1 FROM "SocialPostDraft" d WHERE d."sessionId" = s.id);
-- 5) 장부 삭제 → 남은 이관이 없는 수업은 이관 표시 지우기(발행 상태는 그대로 — 필요하면 따로 내린다)
CREATE TEMP TABLE _rz_rb_sessions ON COMMIT DROP AS SELECT DISTINCT "sessionId" AS id FROM "RallyzFeedImport" WHERE batch = ${b};
DELETE FROM "RallyzFeedImport" WHERE batch = ${b};
UPDATE "Session" s SET "importSource" = NULL, "updatedAt" = NOW()
 WHERE s.id IN (SELECT id FROM _rz_rb_sessions)
   AND NOT EXISTS (SELECT 1 FROM "RallyzFeedImport" o WHERE o."sessionId" = s.id);
COMMIT;`;
}

// ── 영상 묶음 계획(v2) ────────────────────────────────────────────────

/**
 * 영상 묶음 계획 — 수업(반·수업일)마다 1개. 한 수업 안에서는 글 쓴 시각 → 글 안 순서로 이어 붙인다.
 * 최신 수업부터(11월 → 거꾸로). 이미 올린 수업(장부 VIDEO)·반 매칭 실패는 뺀다.
 * @returns {{ batches: Array<{key, classId, className, ymd, parts: Array<{feedId, vodId, m3u8}>}>, skipped: Array }}
 */
export function planVideoBatches({ posts, snapshot, options = {} }) {
  const inst = options.inst ?? DEFAULT_INST;
  const classMap = options.classMap ?? {};
  const done = new Set((snapshot.imported ?? []).filter((r) => r.kind === "VIDEO").map((r) => String(r.sourceKey)));
  const classesById = new Map(snapshot.classes.map((c) => [c.id, c]));
  const byKey = new Map();
  const skipped = [];
  const ordered = [...posts].sort((a, b) => (a.created.sortKey < b.created.sortKey ? -1 : a.created.sortKey > b.created.sortKey ? 1 : a.id < b.id ? -1 : 1));
  for (const post of ordered) {
    if (!post.videos.length || !isTargetInst(post.instNm, inst)) continue;
    const match = matchClass(post.className, snapshot.classes, classMap);
    if (!match.classId) { skipped.push({ id: post.id, reason: `반 매칭 실패(${match.reason})`, className: post.className }); continue; }
    const cls = classesById.get(match.classId);
    const { ymd } = resolveSessionYmd(post.created.ymd, dowsForClass(cls));
    if ((options.from && ymd < options.from) || (options.to && ymd > options.to)) continue;
    const key = `${match.classId}:${ymd}`;
    if (done.has(key)) continue;
    let batch = byKey.get(key);
    if (!batch) { batch = { key, classId: match.classId, className: cls?.name ?? "", ymd, parts: [] }; byKey.set(key, batch); }
    for (const v of post.videos) batch.parts.push({ feedId: post.id, vodId: v.vodId, m3u8: v.m3u8 });
  }
  const batches = [...byKey.values()].sort(compareGroupsNewestFirst);
  return { batches, skipped };
}

/**
 * HLS 주소 — 영상 id 와 템플릿이 있으면 «템플릿 우선», 없으면 글에 적힌 m3u8.
 * 실제 피드의 src(tbycidjt8851…/board/feed_vod_bc/…)는 404 다. 재생 주소는 다른 호스트 + 경로 토큰(hls-template.txt)이라
 * 템플릿의 {id} 를 영상 id 로 바꿔야 받아진다(2026-11-17 curl 확인 — Referer 헤더 필요).
 */
export function hlsUrlFor(part, template) {
  if (part.vodId && template && template.includes("{id}")) return template.replace("{id}", encodeURIComponent(part.vodId));
  return part.m3u8 || null;
}

/** 랠리즈 사진·영상은 Referer 가 rallyz.co.kr 이어야 열린다(없으면 403) */
export const RALLYZ_REFERER = "https://rallyz.co.kr/";

/** 내려받은 사진 응답 판정 — 그림이면 ok. heic/heif 는 sharp 가 못 읽어 멈춘다(1000px 축소본은 jpeg 로 온다) */
export function checkPhotoContentType(contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (!ct.startsWith("image/")) return { ok: false, reason: `그림이 아님(${ct || "content-type 없음"})` };
  if (/hei[cf]/.test(ct)) return { ok: false, reason: `HEIC 원본(${ct}) — 축소본 주소(?type=w&w=1000)로 받아야 jpeg 로 온다` };
  return { ok: true, reason: "" };
}

/** ffmpeg concat 목록 파일 내용(경로의 작은따옴표 이스케이프) */
export function ffmpegConcatList(paths) {
  return paths.map((p) => `file '${String(p).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

/** 유튜브 제목 — 사이트 크론과 같은 모양(src/lib/sessionVideo/rules.ts youtubeVideoTitle) */
export function youtubeTitle(className, ymd) {
  const safe = (className || "수업").replace(/[<>]/g, "").replace(/\s+/g, " ").trim() || "수업";
  return Array.from(`[${safe}] ${ymd} 수업`).slice(0, 100).join("");
}

/**
 * 사이트 DB 의 유튜브 refresh token 암호문 풀기 — src/lib/youtube/tokenCrypto.ts openYoutubeToken 과 같은 형식
 * (v1.<iv>.<tag>.<ciphertext>, AES-256-GCM, AAD "stiz-youtube-refresh-v1"). 테스트가 사이트 함수로 잠근 값을 풀어 비교한다.
 * 키는 Vercel 의 YOUTUBE_TOKEN_ENCRYPTION_KEY(43자 base64url).
 */
export function openSealedYoutubeToken(sealed, keyText) {
  const value = String(keyText || "").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("YOUTUBE_TOKEN_ENCRYPTION_KEY 모양이 이상합니다.");
  const key = Buffer.from(value, "base64url");
  const parts = String(sealed || "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("INVALID_SEALED_TOKEN");
  const [iv, tag, ciphertext] = parts.slice(1).map((p) => Buffer.from(p, "base64url"));
  const decipher = cryptoModule.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from("stiz-youtube-refresh-v1"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** 다음 KST 자정(할당량 초과 시 멈춤 끝) — 사이트 quotaBlockedUntil 과 같은 값 */
export function nextKstMidnightIso(nowMs) {
  const today = msToKstYmd(nowMs);
  const next = addDaysYmd(today, 1);
  return `${next}T00:00:00+09:00`;
}

/** 유튜브 오류 분류 — 사이트 classifyYoutubeError 와 같은 규칙 */
export function classifyYoutubeError(httpStatus, reason) {
  const r = String(reason || "").toLowerCase();
  if (["quotaexceeded", "uploadlimitexceeded", "dailylimitexceeded", "ratelimitexceeded"].includes(r)) return "QUOTA";
  if (httpStatus === 401 || ["invalid_grant", "autherror", "unauthorized_client"].includes(r)) return "AUTH";
  if (httpStatus === 429 || httpStatus >= 500 || httpStatus === 0) return "RETRYABLE";
  return "FATAL";
}

/**
 * 영상 기록 SQL — 유튜브에 이미 올린 영상을 «저장소 사본 없이» SessionVideo 로 남긴다.
 * storageDeletedAt = NOW() 라 사이트 크론이 사본 정리·공개 범위 재확인을 하지 않는다.
 * 학부모 화면은 playbackKind 규칙대로 «UPLOADED + unlisted» 면 유튜브(쿠키 없는 임베드)로 재생한다.
 * 수업 기록이 없으면(글 없이 영상만 있던 날) createSession 일 때 만든다.
 */
export function buildVideoRecordSql(v, batch) {
  const sid = assertSafeId(v.sessionId, "수업 id");
  const cid = assertSafeId(v.classId, "반 id");
  const vid = assertSafeId(v.sessionVideoId, "영상 id");
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(v.youtubeVideoId))) throw new Error(`유튜브 영상 id 모양이 이상합니다: ${v.youtubeVideoId}`);
  if (!isYmd(v.ymd)) throw new Error(`수업일 모양이 이상합니다: ${v.ymd}`);
  const unlisted = v.privacy === "unlisted";
  const lines = [
    `-- 영상 ${v.className} ${v.ymd} → youtube ${v.youtubeVideoId} (${v.privacy})`,
    "DO $rz$",
    "DECLARE v_status TEXT; v_pub BOOLEAN; v_created BOOLEAN := false;",
    "BEGIN",
    `  IF EXISTS (SELECT 1 FROM "RallyzFeedImport" WHERE kind = 'VIDEO' AND "sourceKey" = ${sqlText(v.key)}) THEN RETURN; END IF;`,
    `  SELECT status, COALESCE(published, false) INTO v_status, v_pub FROM "Session" WHERE id = ${sqlText(sid)};`,
  ];
  if (v.createSession) {
    lines.push(`  IF NOT FOUND THEN`);
    lines.push(`    INSERT INTO "Session" (id, "classId", date, "sessionKey", status, published, "importSource", "createdAt", "updatedAt")`);
    lines.push(`    VALUES (${sqlText(sid)}, ${sqlText(cid)}, ${sqlText(v.ymd)}::date, ${sqlText(`${cid}:${v.ymd}`)}, 'COMPLETED', false, ${sqlText(IMPORT_SOURCE)}, NOW(), NOW());`);
    lines.push("    v_created := true;");
    lines.push("  END IF;");
  }
  lines.push(`  INSERT INTO "SessionVideo" (id, "sessionId", "storageBucket", "storagePath", "mimeType", "sizeBytes", "durationSec", "uploadedByUserId", "createdAt", "registeredAt",`);
  lines.push(`    "youtubeVideoId", "youtubeStatus", "youtubePrivacy", "youtubeAttempts", "youtubeUploadedAt", "storageDeletedAt", "updatedAt")`);
  lines.push(`  VALUES (${sqlText(vid)}, ${sqlText(sid)}, ${sqlText(VIDEO_BUCKET)}, ${sqlText(`rallyz-import/${sid}/${vid}.mp4`)}, 'video/mp4', ${Math.max(1, Math.floor(Number(v.sizeBytes) || 1))}, NULL, NULL, NOW(), NOW(),`);
  lines.push(`    ${sqlText(v.youtubeVideoId)}, ${sqlText(unlisted ? "UPLOADED" : "PRIVATE_LOCKED")}, ${sqlText(v.privacy)}, 1, NOW(), NOW(), NOW());`);
  lines.push(`  INSERT INTO "RallyzFeedImport" (kind, "sourceKey", "sessionId", "createdSession", "previousStatus", "previousPublished", "sessionVideoId", "youtubeVideoId", "rallyzClassName", batch)`);
  lines.push(`  VALUES ('VIDEO', ${sqlText(v.key)}, ${sqlText(sid)}, v_created, v_status, v_pub, ${sqlText(vid)}, ${sqlText(v.youtubeVideoId)}, ${sqlText(v.className)}, ${sqlText(batch)});`);
  lines.push(`  UPDATE "Session" SET status = CASE WHEN status = 'PLANNED' THEN 'COMPLETED' ELSE status END, "importSource" = ${sqlText(IMPORT_SOURCE)}, "updatedAt" = NOW() WHERE id = ${sqlText(sid)};`);
  lines.push("END");
  lines.push("$rz$;");
  return lines.join("\n");
}

/**
 * 오늘 이 스크립트가 더 올려도 되나 — 사이트 크론과 같은 계수기(YouTubeConnection.quotaUsed)를 나눠 쓴다.
 * @param {{quotaDay:string|null, quotaUsed:number, quotaBlockedUntilMs:number|null}} state
 * @param {{todayKst:string, nowMs:number, totalLimit:number, uploadedThisRun:number, perRun:number}} opts
 */
export function canUploadMore(state, opts) {
  if (opts.uploadedThisRun >= opts.perRun) return { ok: false, reason: `이번 실행 한도 ${opts.perRun}개` };
  if (state.quotaBlockedUntilMs && state.quotaBlockedUntilMs > opts.nowMs) return { ok: false, reason: "유튜브 할당량 초과로 멈춤(내일 자정까지)" };
  const used = state.quotaDay === opts.todayKst ? state.quotaUsed : 0;
  if (used >= opts.totalLimit) return { ok: false, reason: `오늘 업로드 ${used}/${opts.totalLimit}개(사이트 크론 포함) — 내일 다시` };
  return { ok: true, reason: "" };
}
