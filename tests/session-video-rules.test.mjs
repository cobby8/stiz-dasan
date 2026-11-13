// 2026-11-14 수업 영상 — 업로드 가능 시간(수업 당일 KST 자정까지)·유튜브 할당량·«비공개 강제» 해석을
// 실제 실행으로 못박는다. 자정 경계와 시간대는 눈으로 읽어서는 틀린 걸 못 찾는다.
// 아래쪽은 API 권한(IDOR) 소스 검사 — 주소의 sessionId 로만 범위를 좁히는지, 보호자 판정을 거치는지.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const r = await loadTsModule("src/lib/sessionVideo/rules.ts");
const c = await loadTsModule("src/lib/youtube/tokenCrypto.ts");
const cfg = await loadTsModule("src/lib/youtube/config.ts");
const read = (path) => readFileSync(path, "utf8");

// KST 시각 → epoch ms (테스트 입력 전용)
const kst = (iso) => new Date(`${iso}+09:00`).getTime();

test("업로드 가능: 수업 중·끝난 수업 + 수업일 = 오늘(KST)", () => {
  assert.deepEqual(r.canManageSessionVideo({ status: "IN_PROGRESS", sessionYmd: "2026-11-14", todayYmd: "2026-11-14" }), { ok: true });
  // 수업이 끝나도 그날 자정 전까지는 추가 가능(원장 결정)
  assert.deepEqual(r.canManageSessionVideo({ status: "COMPLETED", sessionYmd: "2026-11-14", todayYmd: "2026-11-14" }), { ok: true });
  // 다음 날(자정 넘음)은 불가
  assert.deepEqual(r.canManageSessionVideo({ status: "COMPLETED", sessionYmd: "2026-11-14", todayYmd: "2026-11-15" }), { ok: false, reason: "NOT_TODAY" });
  // 시작 전 수업은 불가
  assert.deepEqual(r.canManageSessionVideo({ status: "PLANNED", sessionYmd: "2026-11-14", todayYmd: "2026-11-14" }), { ok: false, reason: "NOT_STARTED" });
  assert.equal(r.canManageSessionVideo({ status: "COMPLETED", sessionYmd: "2026-02-30", todayYmd: "2026-02-30" }).ok, false);
  assert.match(r.uploadWindowMessage("NOT_TODAY"), /자정/);
});

test("자정 경계 — 오늘(KST)은 서버(UTC) 날짜가 아니라 한국 날짜", async () => {
  const k = await loadTsModule("src/lib/datetime/kst.ts");
  // KST 23:59 = UTC 14:59 같은 날 / KST 00:00 = UTC 전날 15:00 → 한국 날짜는 이미 다음 날
  assert.equal(k.todayKst(kst("2026-11-14T23:59:59")), "2026-11-14");
  assert.equal(k.todayKst(kst("2026-11-15T00:00:00")), "2026-11-15");
  const at = (iso) => r.canManageSessionVideo({ status: "COMPLETED", sessionYmd: "2026-11-14", todayYmd: k.todayKst(kst(iso)) }).ok;
  assert.equal(at("2026-11-14T23:59:59"), true);
  assert.equal(at("2026-11-15T00:00:00"), false);
  // 서버가 SQL 로 오늘을 정한다 — 서버 시계로 «오늘»을 만들지 않는다
  assert.match(read("src/lib/sessionVideo/server.ts"), /\(NOW\(\) AT TIME ZONE 'Asia\/Seoul'\)::date::text AS "todayYmd"/);
  assert.match(read("src/lib/sessionVideo/server.ts"), /s\.date::date::text AS "sessionYmd"/);
});

test("파일 검사: 형식 화이트리스트·크기 상한·친절한 안내", () => {
  const max = 50 * 1024 * 1024;
  assert.deepEqual(r.checkSessionVideoFile({ mimeType: "video/mp4", sizeBytes: 10, maxBytes: max }), { ok: true, mimeType: "video/mp4" });
  assert.deepEqual(r.checkSessionVideoFile({ mimeType: "", fileName: "IMG_1.MOV", sizeBytes: 10, maxBytes: max }), { ok: true, mimeType: "video/quicktime" });
  assert.equal(r.checkSessionVideoFile({ mimeType: "video/3gpp", sizeBytes: 10, maxBytes: max }).ok, false);
  assert.equal(r.checkSessionVideoFile({ mimeType: "image/jpeg", fileName: "a.mp4", sizeBytes: 10, maxBytes: max }).ok, false);
  const big = r.checkSessionVideoFile({ mimeType: "video/webm", sizeBytes: max + 1, maxBytes: max });
  assert.equal(big.ok, false);
  assert.match(big.message, /1분 이내/);
  assert.match(big.message, /50MB/);
  assert.equal(r.checkSessionVideoFile({ mimeType: "video/mp4", sizeBytes: 0, maxBytes: max }).ok, false);
});

test("저장 경로는 우리 모양만 — 다른 버킷·다른 수업·경로 탈출 거절", () => {
  const videoId = "123e4567-e89b-42d3-a456-426614174000";
  const path = r.sessionVideoStoragePath({ classId: "cls1", sessionId: "ses1", videoId, mimeType: "video/quicktime" });
  assert.equal(path, `classes/cls1/ses1/${videoId}.mov`);
  const ok = { storageBucket: r.SESSION_VIDEO_BUCKET, storagePath: path, classId: "cls1", sessionId: "ses1", videoId };
  assert.equal(r.isValidSessionVideoRef(ok), true);
  assert.equal(r.isValidSessionVideoRef({ ...ok, storageBucket: "uploads" }), false);
  assert.equal(r.isValidSessionVideoRef({ ...ok, sessionId: "ses2" }), false);
  assert.equal(r.isValidSessionVideoRef({ ...ok, storagePath: `classes/cls1/ses1/../x/${videoId}.mov` }), false);
  assert.equal(r.isValidSessionVideoRef({ ...ok, classId: "c.*" }), false);
});

test("유튜브 상태·형식 상수 = DB CHECK 집합(마이그레이션과 같은 목록)", () => {
  const sql = read("prisma/migrations/20261114120000_session_video/migration.sql");
  const list = (name) => {
    const m = sql.match(new RegExp(`${name}"\\s*\\n\\s*CHECK \\("[a-zA-Z]+" IN \\(([^)]*)\\)\\)`));
    assert.ok(m, name);
    return m[1].split(",").map((x) => x.trim().replace(/'/g, "")).sort();
  };
  assert.deepEqual(list("SessionVideo_youtubeStatus_check"), [...r.SESSION_VIDEO_YOUTUBE_STATUSES].sort());
  assert.deepEqual(list("SessionVideo_mimeType_check"), [...r.SESSION_VIDEO_MIME_TYPES].sort());
  assert.match(sql, /ALTER TABLE public\."SessionVideo" FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE public\."YouTubeConnection" FORCE ROW LEVEL SECURITY/);
  // 시간 칼럼은 전부 timestamptz(무tz timestamp 금지 — AT TIME ZONE 두 번 함정)
  assert.doesNotMatch(sql, /TIMESTAMP(\(\d\))?\s+(NOT NULL|DEFAULT|,)/);
});

test("상태 전이표", () => {
  assert.equal(r.canTransitionYoutubeStatus("PENDING", "UPLOADING"), true);
  assert.equal(r.canTransitionYoutubeStatus("UPLOADING", "PRIVATE_LOCKED"), true);
  assert.equal(r.canTransitionYoutubeStatus("PRIVATE_LOCKED", "PENDING"), true);
  assert.equal(r.canTransitionYoutubeStatus("UPLOADED", "PENDING"), false);
  assert.equal(r.canTransitionYoutubeStatus("SKIPPED", "PENDING"), false);
  assert.equal(r.canTransitionYoutubeStatus("NOPE", "PENDING"), false);
});

test("유튜브 응답 해석 — 일부공개만 UPLOADED, 비공개 강제는 PRIVATE_LOCKED(사이트 사본 유지)", () => {
  assert.deepEqual(r.interpretYoutubePrivacy("unlisted"), { status: "UPLOADED", privacy: "unlisted" });
  assert.deepEqual(r.interpretYoutubePrivacy("private"), { status: "PRIVATE_LOCKED", privacy: "private" });
  assert.equal(r.interpretYoutubePrivacy(undefined).status, "PRIVATE_LOCKED");
  assert.equal(r.interpretYoutubePrivacy("public").status, "PRIVATE_LOCKED");
  // 재생: 일부공개 완료만 유튜브, 나머지는 사이트 사본, 사본도 없으면 none
  assert.equal(r.playbackKind({ youtubeStatus: "UPLOADED", youtubeVideoId: "abcdefghijk", youtubePrivacy: "unlisted", storageDeletedAt: null }), "youtube");
  assert.equal(r.playbackKind({ youtubeStatus: "PRIVATE_LOCKED", youtubeVideoId: "abcdefghijk", youtubePrivacy: "private", storageDeletedAt: null }), "file");
  assert.equal(r.playbackKind({ youtubeStatus: "PENDING", youtubeVideoId: null, youtubePrivacy: null, storageDeletedAt: null }), "file");
  assert.equal(r.playbackKind({ youtubeStatus: "FAILED", youtubeVideoId: null, youtubePrivacy: null, storageDeletedAt: new Date() }), "none");
  assert.equal(r.youtubeNocookieEmbedUrl("abcdefghijk").startsWith("https://www.youtube-nocookie.com/embed/abcdefghijk?"), true);
  assert.throws(() => r.youtubeNocookieEmbedUrl("x\"><script>"));
});

test("유튜브 오류 분류·실패 횟수 — 할당량·인증은 횟수로 세지 않는다, 3회면 FAILED", () => {
  assert.equal(r.classifyYoutubeError(403, "quotaExceeded"), "QUOTA");
  assert.equal(r.classifyYoutubeError(400, "uploadLimitExceeded"), "QUOTA");
  assert.equal(r.classifyYoutubeError(400, "invalid_grant"), "AUTH");
  assert.equal(r.classifyYoutubeError(401, null), "AUTH");
  assert.equal(r.classifyYoutubeError(503, null), "RETRYABLE");
  assert.equal(r.classifyYoutubeError(400, "invalidTitle"), "FATAL");
  assert.deepEqual(r.nextStatusAfterFailure({ attempts: 0, kind: "QUOTA" }), { status: "PENDING", attempts: 0 });
  assert.deepEqual(r.nextStatusAfterFailure({ attempts: 0, kind: "RETRYABLE" }), { status: "PENDING", attempts: 1 });
  assert.deepEqual(r.nextStatusAfterFailure({ attempts: 2, kind: "RETRYABLE" }), { status: "FAILED", attempts: 3 });
  assert.deepEqual(r.nextStatusAfterFailure({ attempts: 0, kind: "FATAL" }), { status: "FAILED", attempts: 1 });
});

test("하루 할당량(KST) — 5건, 날짜 바뀌면 0부터, 초과 응답 뒤엔 다음 KST 자정까지 0", () => {
  const now = kst("2026-11-14T10:00:00");
  assert.equal(r.remainingQuota({ quotaDay: null, quotaUsed: 0, quotaBlockedUntilMs: null }, now), 5);
  assert.equal(r.remainingQuota({ quotaDay: "2026-11-14", quotaUsed: 3, quotaBlockedUntilMs: null }, now), 2);
  assert.equal(r.remainingQuota({ quotaDay: "2026-11-14", quotaUsed: 5, quotaBlockedUntilMs: null }, now), 0);
  // 어제 다 썼어도 오늘은 새로
  assert.equal(r.remainingQuota({ quotaDay: "2026-11-13", quotaUsed: 5, quotaBlockedUntilMs: null }, now), 5);
  // KST 00:30 은 UTC 로는 전날이지만 한국 날짜로 새 날
  assert.equal(r.remainingQuota({ quotaDay: "2026-11-14", quotaUsed: 5, quotaBlockedUntilMs: null }, kst("2026-11-15T00:30:00")), 5);
  // 할당량 초과 응답 → 다음 KST 자정까지 막힘
  const until = r.quotaBlockedUntil(kst("2026-11-14T23:10:00"));
  assert.equal(until, kst("2026-11-15T00:00:00"));
  assert.equal(r.remainingQuota({ quotaDay: null, quotaUsed: 0, quotaBlockedUntilMs: until }, kst("2026-11-14T23:59:00")), 0);
  assert.equal(r.remainingQuota({ quotaDay: null, quotaUsed: 0, quotaBlockedUntilMs: until }, kst("2026-11-15T00:00:00")), 5);
  // 연말 경계
  assert.equal(r.quotaBlockedUntil(kst("2026-12-31T23:00:00")), kst("2027-01-01T00:00:00"));
  // DB 예약 문장도 같은 한도·KST 날짜를 쓴다
  const conn = read("src/lib/youtube/connection.ts");
  assert.match(conn, /todayKst\(nowMs\)/);
  assert.match(conn, /"quotaUsed" < \$2/);
});

test("저장소 사본 삭제 시점 — 일부공개 성공 7일 뒤만", () => {
  const up = kst("2026-11-01T12:00:00");
  assert.equal(r.storageCopyExpired({ youtubeStatus: "UPLOADED", youtubeUploadedAtMs: up, nowMs: up + 6 * 86_400_000 }), false);
  assert.equal(r.storageCopyExpired({ youtubeStatus: "UPLOADED", youtubeUploadedAtMs: up, nowMs: up + 7 * 86_400_000 }), true);
  assert.equal(r.storageCopyExpired({ youtubeStatus: "PRIVATE_LOCKED", youtubeUploadedAtMs: up, nowMs: up + 30 * 86_400_000 }), false);
});

test("유튜브 제목 «[반이름] YYYY-MM-DD 수업» — < > 제거·100자", () => {
  assert.equal(r.youtubeVideoTitle("화목 초등 A", "2026-11-14"), "[화목 초등 A] 2026-11-14 수업");
  assert.equal(r.youtubeVideoTitle("<b>반</b>", "2026-11-14"), "[b반/b] 2026-11-14 수업");
  assert.equal(Array.from(r.youtubeVideoTitle("가".repeat(200), "2026-11-14")).length, 100);
  assert.equal(r.youtubeVideoTitle("", "2026-11-14"), "[수업] 2026-11-14 수업");
});

test("refresh token 암호화 — 키 없으면 꺼짐, 풀기·위조 거절", () => {
  assert.equal(c.readYoutubeTokenKey(""), null);
  assert.equal(c.readYoutubeTokenKey("short"), null);
  const keyText = Buffer.alloc(32, 7).toString("base64url");
  const key = c.readYoutubeTokenKey(keyText);
  assert.ok(key);
  const sealed = c.sealYoutubeToken("1//refresh-token", key);
  assert.ok(!sealed.includes("refresh-token"));
  assert.equal(c.openYoutubeToken(sealed, key), "1//refresh-token");
  const other = c.readYoutubeTokenKey(Buffer.alloc(32, 8).toString("base64url"));
  assert.throws(() => c.openYoutubeToken(sealed, other));
  const parts = sealed.split(".");
  parts[3] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => c.openYoutubeToken(parts.join("."), key));
  // 설정: 셋 중 하나라도 없으면 «설정 대기»
  assert.deepEqual(cfg.readYoutubeConfig({}).ready, false);
  assert.deepEqual(cfg.readYoutubeConfig({ YOUTUBE_OAUTH_CLIENT_ID: "a", YOUTUBE_OAUTH_CLIENT_SECRET: "b" }).missing, ["YOUTUBE_TOKEN_ENCRYPTION_KEY"]);
  const ready = cfg.readYoutubeConfig({ YOUTUBE_OAUTH_CLIENT_ID: "a", YOUTUBE_OAUTH_CLIENT_SECRET: "b", YOUTUBE_TOKEN_ENCRYPTION_KEY: keyText, NEXT_PUBLIC_SITE_URL: "https://x.kr/" });
  assert.equal(ready.ready, true);
  assert.equal(ready.redirectUri, "https://x.kr/api/admin/youtube/callback");
});

test("OAuth 주소·state — offline+consent, 업로드 권한, state 비교", () => {
  const url = new URL(cfg.buildYoutubeAuthUrl({ clientId: "cid", redirectUri: "https://x.kr/cb", state: "s".repeat(43) }));
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("state"), "s".repeat(43));
  assert.ok(url.searchParams.get("scope").split(" ").includes("https://www.googleapis.com/auth/youtube.upload"));
  assert.equal(cfg.youtubeStateMatches("a".repeat(43), "a".repeat(43)), true);
  assert.equal(cfg.youtubeStateMatches("a".repeat(43), "b".repeat(43)), false);
  assert.equal(cfg.youtubeStateMatches("a".repeat(43), null), false);
  assert.equal(cfg.youtubeStateMatches("short", "short"), false);
  assert.equal(cfg.grantedUploadScope("https://www.googleapis.com/auth/youtube.readonly"), false);
  assert.equal(cfg.grantedUploadScope("https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly"), true);
});

// ── API 권한(IDOR) 소스 검사 ─────────────────────────────────────────

test("학부모 영상 API — 휴대폰 인증 보호자 + 그 수업 참여 학생의 보호자만(IDOR)", () => {
  const route = read("src/app/api/sessions/[sessionId]/videos/route.ts");
  assert.match(route, /requireVerifiedParent\(\)/);
  assert.match(route, /parentCanViewSessionVideos\(parent\.appUserId, sessionId, session\.classId\)/);
  assert.match(route, /status !== "COMPLETED"/);
  const server = read("src/lib/sessionVideo/server.ts");
  // 보호자 판정은 childAccessSql(연결 표 포함) + 합쳐진 학생 제외, 참여 = 출결 기록 또는 ACTIVE 수강
  assert.match(server, /childAccessSql\("st", 'u\."id"'\)/);
  assert.match(server, /notMergedStudent\("st"\)/);
  assert.match(server, /"Attendance" a WHERE a\."sessionId" = \$2 AND a\."studentId" = st\.id/);
  assert.match(server, /e\."classId" = \$3 AND e\.status = 'ACTIVE'/);
  // 지운·미등록 영상은 목록에서 제외
  assert.match(server, /"registeredAt" IS NOT NULL AND "deletedAt" IS NULL/);
});

test("선생님 영상 API — 수업 권한 함수 + 주소의 수업으로 범위 고정(IDOR)", () => {
  const files = [
    "src/app/api/staff/sessions/[sessionId]/videos/route.ts",
    "src/app/api/staff/sessions/[sessionId]/videos/upload-url/route.ts",
    "src/app/api/staff/sessions/[sessionId]/videos/[videoId]/route.ts",
  ];
  for (const file of files) {
    const src = read(file);
    assert.match(src, /requireStaffSessionAccess\(sessionId\)/, file);
  }
  const register = read(files[0]);
  assert.match(register, /WHERE id = \$1 AND "sessionId" = \$2 AND "registeredAt" IS NULL/);
  // 브라우저가 보낸 크기·형식이 아니라 저장소 파일 정보로 다시 검사
  assert.match(register, /\.info\(video\.storagePath\)/);
  assert.match(read(files[2]), /WHERE id = \$1 AND "sessionId" = \$2 AND "deletedAt" IS NULL/);
  // 올리기·지우기는 업로드 가능 시간 판정을 거친다
  for (const file of files) assert.match(read(file), /uploadWindowError\(session\)/, file);
  // 영상 본문은 서버로 받지 않는다(Vercel 4.5MB) — 서명 업로드 주소만
  const uploadUrl = read(files[1]);
  assert.match(uploadUrl, /createSignedUploadUrl\(storagePath, \{ upsert: false \}\)/);
  assert.doesNotMatch(uploadUrl, /formData\(\)/);
});

test("유튜브 관리 API — 원장 전용, state 쿠키, cron 은 CRON_SECRET", () => {
  for (const file of ["connect", "callback", "disconnect", "retry"]) {
    assert.match(read(`src/app/api/admin/youtube/${file}/route.ts`), /requireOwner\(\)/, file);
  }
  const callback = read("src/app/api/admin/youtube/callback/route.ts");
  assert.match(callback, /youtubeStateMatches\(params\.get\("state"\), req\.cookies\.get\(YOUTUBE_STATE_COOKIE\)\?\.value\)/);
  const cron = read("src/app/api/cron/youtube-upload/route.ts");
  assert.match(cron, /Bearer \$\{secret\}/);
  const vercel = JSON.parse(read("vercel.json"));
  assert.ok(vercel.crons.some((job) => job.path === "/api/cron/youtube-upload"));
  assert.equal(vercel.functions["src/app/api/cron/youtube-upload/route.ts"].maxDuration, 300);
  // 연결 토큰은 암호문으로만 저장
  assert.match(read("src/lib/youtube/connection.ts"), /sealYoutubeToken\(input\.refreshToken, input\.encryptionKey\)/);
});

test("수업 진행 화면에 영상 칸 — 사진 칸 바로 아래", () => {
  const page = read("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx");
  const photo = page.indexOf('id="session-photos"');
  const video = page.indexOf('id="session-videos"');
  const memo = page.indexOf('id="session-memo"');
  assert.ok(photo > 0 && video > photo && memo > video);
  const uploader = read("src/components/staff/SessionVideoUploader.tsx");
  assert.match(uploader, /accept="video\/\*" capture="environment"/);
  const player = read("src/components/parent/SessionVideoPlayer.tsx");
  assert.match(player, /youtubeNocookieEmbedUrl/);
  assert.match(player, /sandbox="allow-scripts allow-same-origin allow-presentation"/);
  assert.match(player, /playsInline/);
});
