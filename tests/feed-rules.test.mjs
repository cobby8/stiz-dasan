// 2026-11-14 수업 피드(원장 결정) — 순수 규칙을 실제로 돌리고, 사진 보기 라우트의 IDOR 를 실행으로 못박는다.
//  - 참여 판정·업로드/한 줄 가능 시간(자정 경계)·홈 카드 고르기·볼 수 있는 사진 거르기
//  - 사진 보기 라우트: 동의·«나온 학생» 태그 없이 «참여한 아이의 보호자»만, 남의 sessionId·photoId 는 403/404
//  - 선생님: 한 줄 저장은 당일 자정까지·알림 없음, 사진 올리기 시간 = 영상과 같은 규칙
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { loadTsModule } from "./_ts-module.mjs";

const r = await loadTsModule("src/lib/feed/rules.ts");
const k = await loadTsModule("src/lib/datetime/kst.ts");
const read = (path) => readFileSync(path, "utf8");
const kstMs = (iso) => new Date(`${iso}+09:00`).getTime();

// ── 순수 규칙 ─────────────────────────────────────────────────────────

test("학부모 공개 수업 = 끝났고(COMPLETED) 발행된(published) 수업만", () => {
  assert.equal(r.isParentVisibleSession({ status: "COMPLETED", published: true }), true);
  assert.equal(r.isParentVisibleSession({ status: "COMPLETED", published: false }), false);
  assert.equal(r.isParentVisibleSession({ status: "IN_PROGRESS", published: true }), false);
  assert.equal(r.isParentVisibleSession({ status: "PLANNED", published: null }), false);
  // SQL 조각도 같은 문장
  assert.equal(r.feedVisibleSessionSql("se"), "se.status = 'COMPLETED' AND se.published = true");
});

test("참여 판정 — 출결 기록 또는 ACTIVE 수강(시작일 ≤ 수업일, 시작일 = 개시일 없으면 등록일). 동의는 보지 않는다", () => {
  const base = { hasAttendance: false, enrollment: null, sessionYmd: "2026-11-14" };
  const en = (startsOnYmd, createdYmd = "2026-03-02", status = "ACTIVE") => ({ status, startsOnYmd, createdYmd });
  assert.equal(r.isFeedParticipant({ ...base, hasAttendance: true }), true, "출결 기록이 있으면 참여");
  assert.equal(r.isFeedParticipant(base), false, "출결도 수강도 없으면 아님");
  assert.equal(r.isFeedParticipant({ ...base, enrollment: en(null) }), true, "개시일 없는 기존 수강 — 등록일(3/2) 이후 수업");
  assert.equal(r.isFeedParticipant({ ...base, enrollment: en("2026-11-14") }), true, "개시일 = 수업일");
  assert.equal(r.isFeedParticipant({ ...base, enrollment: en("2026-11-15") }), false, "수업 뒤에 들어온 아이는 지난 수업을 못 본다");
  assert.equal(r.isFeedParticipant({ ...base, enrollment: en(null, null, "PAUSED") }), false);
  assert.equal(r.isFeedParticipant({ ...base, enrollment: en("2026-02-30") }), false, "잘못된 날짜는 닫는다");
  assert.equal(r.isFeedParticipant({ ...base, enrollment: en(null, null) }), false, "시작일을 모르면 닫는다");
});

test("보안 HIGH — 개시일 없음 + 수업일 < 등록일 → 거부(입학 전 수업 사진·소식·영상이 열리지 않는다)", () => {
  const en = { status: "ACTIVE", startsOnYmd: null, createdYmd: "2026-11-10" };
  assert.equal(r.isFeedParticipant({ hasAttendance: false, enrollment: en, sessionYmd: "2026-11-07" }), false, "등록 전 수업");
  assert.equal(r.isFeedParticipant({ hasAttendance: false, enrollment: en, sessionYmd: "2026-11-10" }), true, "등록한 날 수업");
  assert.equal(r.isFeedParticipant({ hasAttendance: false, enrollment: en, sessionYmd: "2026-11-12" }), true);
  // SQL: 개시일이 비면 등록일(무tz createdAt «두 번» 변환)로 막는다 — «IS NULL 이면 통과» 문장이 없어야 한다
  const sql = r.feedParticipantSql("st", "se");
  assert.match(sql, /COALESCE\(fe\."startsOn", \(\(fe\."createdAt" AT TIME ZONE 'UTC'\) AT TIME ZONE 'Asia\/Seoul'\)::date\) <= \(\(se\.date AT TIME ZONE 'UTC'\) AT TIME ZONE 'Asia\/Seoul'\)::date/);
  assert.doesNotMatch(sql, /"startsOn" IS NULL OR/);
  // createdAt 은 UTC 벽시계 — KST 자정 직후(UTC 전날 15:xx) 등록도 KST 날짜로
  assert.equal(k.toKstYmd(new Date("2026-11-09T15:30:00Z")), "2026-11-10");
});

test("보안 HIGH — 되살린 수강 → 쉬는 동안 수업 거부(되살리는 곳이 개시일을 «되살린 날»로 적는다)", () => {
  // 3월 등록 → 6월 그만둠 → 11/10 되살림: 개시일 = 11/10
  const revived = { status: "ACTIVE", startsOnYmd: "2026-11-10", createdYmd: "2026-03-02" };
  assert.equal(r.isFeedParticipant({ hasAttendance: false, enrollment: revived, sessionYmd: "2026-09-15" }), false, "쉬는 동안 수업");
  assert.equal(r.isFeedParticipant({ hasAttendance: false, enrollment: revived, sessionYmd: "2026-11-10" }), true);
  // 다닐 때(출결 기록 있음) 수업은 그대로 본다
  assert.equal(r.isFeedParticipant({ hasAttendance: true, enrollment: revived, sessionYmd: "2026-04-06" }), true);
  // 개시일 없이 ACTIVE 를 만들던/되살리던 4곳 — 되살리기는 개시일 = 오늘(KST), 이미 ACTIVE 면 유지
  const revive = /"startsOn" = CASE WHEN "Enrollment"\.status = 'ACTIVE' THEN "Enrollment"\."startsOn" ELSE \(NOW\(\) AT TIME ZONE 'Asia\/Seoul'\)::date END/g;
  const admin = read("src/app/actions/admin.ts");
  assert.equal((admin.match(revive) ?? []).length, 3, "enrollStudent·대기자 등록·시트 가져오기");
  assert.equal((read("src/app/api/admin/seasonal/route.ts").match(revive) ?? []).length, 1, "특강 전환");
  // 새 등록: 수강 추가·대기자 등록은 오늘(KST)부터
  assert.equal((admin.match(/VALUES \(gen_random_uuid\(\)::text, \$1, \$2, 'ACTIVE', \(NOW\(\) AT TIME ZONE 'Asia\/Seoul'\)::date, NOW\(\), NOW\(\)\)/g) ?? []).length, 2);
  // 개시일 없이 ACTIVE 로 되살리는 문장이 남아 있지 않다
  for (const file of ["src/app/actions/admin.ts", "src/app/api/admin/seasonal/route.ts"]) {
    assert.doesNotMatch(read(file), /DO UPDATE SET status = 'ACTIVE', "updatedAt" = NOW\(\)/, file);
  }
});

test("보안 HIGH — 퇴원 후 재원 → 빠져 있던 기간 수업 거부(관리자 상태 변경이 개시일을 효력일로 다시 적는다)", () => {
  // 3월 등록·개시 → 6월 퇴원 → 11/12 재원(효력일 11/12): 개시일 = 11/12
  const rejoined = { status: "ACTIVE", startsOnYmd: "2026-11-12", createdYmd: "2026-03-02" };
  assert.equal(r.isFeedParticipant({ hasAttendance: false, enrollment: rejoined, sessionYmd: "2026-08-20" }), false, "빠져 있던 기간");
  assert.equal(r.isFeedParticipant({ hasAttendance: false, enrollment: rejoined, sessionYmd: "2026-11-12" }), true, "재원 효력일 수업");
  // 옛 개시일(3/2)이 남았다면 열렸을 수업 — 이 차이가 HIGH 였다
  assert.equal(r.isFeedParticipant({ hasAttendance: false, enrollment: { ...rejoined, startsOnYmd: "2026-03-02" }, sessionYmd: "2026-08-20" }), true);
  const admin = read("src/app/actions/admin.ts");
  const start = admin.indexOf("export async function updateEnrollmentStatus");
  const body = admin.slice(start, admin.indexOf("export async function", start + 10));
  assert.match(body, /const rejoin = before\.previousStatus === "WITHDRAWN" && status === "ACTIVE";/);
  assert.match(body, /"startsOn" = CASE WHEN \$3::boolean THEN \$4::date ELSE "startsOn" END/);
  assert.match(body, /status, enrollmentId, rejoin, effectiveFrom,/);
  // 효력일은 KST 달력 + 미래 금지 검증을 거친 값
  assert.match(body, /if \(!isKstYmd\(effectiveFrom\)\) throw/);
  assert.match(body, /if \(effectiveFrom > todayKst\(\)\) throw/);
});

test("보안 HIGH — ACTIVE 로 바꾸는 다른 경로 전수: 운영 동기화는 휴원·퇴원만, 수강 변경 복귀는 휴원→재원만", () => {
  const ops = read("src/app/actions/operations-sync.ts");
  assert.match(ops, /if \(!\['PAUSE', 'WITHDRAW'\]\.includes\(command\.kind\)\)/);
  assert.match(ops, /const nextStatus = command\.kind === "PAUSE" \? "PAUSED" : "WITHDRAWN";/);
  assert.match(read("src/lib/enrollment/due-change-plan.ts"), /RESUME: \{ from: \["PAUSED"\], to: "ACTIVE"/);
  // Enrollment 를 status 만 바꾸는 UPDATE 는 이 목록뿐이다(새로 생기면 이 테스트가 알린다 — 재원이면 개시일도 적을 것)
  const files = ["src/app/actions/admin.ts", "src/app/actions/operations-sync.ts", "src/lib/enrollment/admin-change-request.ts", "src/app/actions/enrollment-admin-edit.ts", "src/lib/seasonal/auto-end.ts"];
  const counts = Object.fromEntries(files.map((f) => [f, (read(f).match(/UPDATE "Enrollment" SET status/g) ?? []).length]));
  assert.deepEqual(counts, {
    "src/app/actions/admin.ts": 1, "src/app/actions/operations-sync.ts": 1, "src/lib/enrollment/admin-change-request.ts": 1,
    "src/app/actions/enrollment-admin-edit.ts": 1, "src/lib/seasonal/auto-end.ts": 1,
  });
});

test("참여 SQL 조각 모양", () => {
  // SQL 조각: 출결 EXISTS 또는 ACTIVE 수강 + 개시일 ≤ 수업일(두 번 변환), 동의 표는 없다
  const sql = r.feedParticipantSql("st", "se");
  assert.match(sql, /"Attendance" fa WHERE fa\."sessionId" = se\.id AND fa\."studentId" = st\.id/);
  assert.match(sql, /fe\."classId" = se\."classId" AND fe\.status = 'ACTIVE'/);
  assert.match(sql, /::date\) <= \(\(se\.date AT TIME ZONE 'UTC'\) AT TIME ZONE 'Asia\/Seoul'\)::date/);
  assert.doesNotMatch(sql, /StudentMediaConsent|subjectStudentIds/);
});

test("수업일 SQL = 무tz 칼럼 «두 번» 변환 — 새 기록(자정)·옛 기록(전날 15:00) 모두 같은 KST 날짜", () => {
  assert.equal(r.sessionKstDateSql("se"), "((se.date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')::date");
  assert.equal(r.TODAY_KST_SQL, "(NOW() AT TIME ZONE 'Asia/Seoul')::date");
  // (ts AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul' = «그 벽시계 값을 UTC 시각으로 읽어 서울 날짜로» — JS 로 같은 계산
  const asStored = (wall) => k.toKstYmd(new Date(`${wall}Z`));
  assert.equal(asStored("2026-11-14T00:00:00"), "2026-11-14", "새 기록: KST 날짜 자정");
  assert.equal(asStored("2026-11-13T15:00:00"), "2026-11-14", "옛 기록: KST 자정의 UTC 시각(전날 15:00)");
  assert.equal(asStored("2026-12-31T15:00:00"), "2027-01-01", "연말 경계");
  // 한 번만 자르면(::date) 옛 기록이 하루 밀린다 — 새로 쓴 SQL 에 date::date 가 없어야 한다
  for (const file of [
    "src/lib/feed/server.ts",
    "src/app/api/staff/sessions/[sessionId]/photos/route.ts",
    "src/lib/sessionVideo/server.ts",
  ]) assert.doesNotMatch(read(file), /\bdate::date::text AS "sessionYmd"|date::date::text AS ymd/, file);
});

test("사진·영상 올리기 가능 시간 = 수업 중 또는 끝난 당일 KST 자정까지(영상과 같은 함수)", () => {
  assert.deepEqual(r.canManageSessionMedia({ status: "IN_PROGRESS", sessionYmd: "2026-11-14", todayYmd: "2026-11-14" }), { ok: true });
  assert.deepEqual(r.canManageSessionMedia({ status: "COMPLETED", sessionYmd: "2026-11-14", todayYmd: "2026-11-14" }), { ok: true });
  assert.deepEqual(r.canManageSessionMedia({ status: "COMPLETED", sessionYmd: "2026-11-14", todayYmd: "2026-11-15" }), { ok: false, reason: "NOT_TODAY" });
  assert.deepEqual(r.canManageSessionMedia({ status: "PLANNED", sessionYmd: "2026-11-14", todayYmd: "2026-11-14" }), { ok: false, reason: "NOT_STARTED" });
  // 자정 경계 — 오늘은 한국 날짜
  const at = (iso) => r.canManageSessionMedia({ status: "COMPLETED", sessionYmd: "2026-11-14", todayYmd: k.todayKst(kstMs(iso)) }).ok;
  assert.equal(at("2026-11-14T23:59:59"), true);
  assert.equal(at("2026-11-15T00:00:00"), false);
  assert.match(r.photoWindowMessage("NOT_TODAY"), /자정/);
  assert.match(r.photoWindowMessage("NOT_STARTED"), /시작한 뒤/);
});

test("«오늘 수업 한 줄» = 수업 전·중·후 모두, 수업 당일 자정까지", () => {
  for (const status of ["PLANNED", "IN_PROGRESS", "COMPLETED"]) {
    assert.deepEqual(r.canEditFeedLine({ status, sessionYmd: "2026-11-14", todayYmd: "2026-11-14" }), { ok: true }, status);
    assert.deepEqual(r.canEditFeedLine({ status, sessionYmd: "2026-11-14", todayYmd: "2026-11-15" }), { ok: false, reason: "NOT_TODAY" }, status);
  }
  assert.equal(r.canEditFeedLine({ status: "CANCELLED", sessionYmd: "2026-11-14", todayYmd: "2026-11-14" }).ok, false);
  assert.equal(r.canEditFeedLine({ status: "COMPLETED", sessionYmd: "bad", todayYmd: "2026-11-14" }).ok, false);
  // 저장 값: 앞뒤 공백 제거·빈 값은 null(지우기)·2000자 상한
  assert.equal(r.normalizeFeedLine("  드리블  "), "드리블");
  assert.equal(r.normalizeFeedLine("   "), null);
  assert.equal(r.normalizeFeedLine(undefined), null);
  assert.equal(Array.from(r.normalizeFeedLine("가".repeat(2100))).length, r.FEED_LINE_MAX);
});

test("볼 수 있는 사진만 — 이 수업 주소 + 사진 원장에 있는 비공개 사진, 옛 공개 주소는 그대로, 중복 제거", () => {
  const ok = new Set(["p1", "p2"]);
  const views = r.selectViewablePhotos([
    "/api/staff/sessions/s1/photos/p1",
    "/api/staff/sessions/s1/photos/p1", // 중복
    "/api/staff/sessions/s1/photos/gone", // 원장에서 지워짐 → 404 헛요청
    "/api/staff/sessions/OTHER/photos/p2", // 다른 수업 주소 → 403 헛요청
    "/uploads/legacy.jpg",
    "/api/admin/backup", // 사진이 아닌 내부 주소
    "",
  ], "s1", ok);
  assert.deepEqual(views.map((v) => v.src), ["/api/staff/sessions/s1/photos/p1", "/uploads/legacy.jpg"]);
});

test("홈 피드 카드 고르기 — 고른 아이의 최신 수업 1건, 사진 최대 3장, 없으면 null", () => {
  const c = (extra) => ({ studentId: "a", sessionId: "s", ymd: "2026-11-10", publishedAtMs: 1, className: "반", coachName: null, content: " 본문 ", topic: null, photos: [], videoCount: 0, ...extra });
  assert.equal(r.pickFeedCard([], "a"), null);
  assert.equal(r.pickFeedCard([c({ studentId: "b" })], "a"), null, "형제 것은 고르지 않는다");
  const latest = r.pickFeedCard([
    c({ sessionId: "old", ymd: "2026-11-01" }),
    c({ sessionId: "same-day-early", ymd: "2026-11-12", publishedAtMs: 10 }),
    c({ sessionId: "same-day-late", ymd: "2026-11-12", publishedAtMs: 20, photos: [1, 2, 3, 4].map((n) => ({ src: `/p${n}` })), videoCount: 2 }),
    c({ studentId: "b", sessionId: "sibling", ymd: "2026-11-13" }),
  ], "a");
  assert.equal(latest.sessionId, "same-day-late");
  assert.equal(latest.photos.length, r.FEED_CARD_PHOTO_LIMIT);
  assert.equal(latest.photoCount, 4);
  assert.equal(latest.videoCount, 2);
  assert.equal(latest.content, "본문");
  assert.equal(r.pickFeedCard([c({ content: "   ", topic: " 주제 " })], "a").content, null);
  // 소식 목록 행 표시
  assert.equal(r.feedMediaCountLabel({ photoCount: 2, videoCount: 1 }), "사진 2 · 영상 1");
  assert.equal(r.feedMediaCountLabel({ photoCount: 0, videoCount: 3 }), "영상 3");
  assert.equal(r.feedMediaCountLabel({ photoCount: 0, videoCount: 0 }), "");
});

test("실패한 사진만 다시 올리기 — 성공한 파일은 다시 올리지 않는다", () => {
  assert.deepEqual(r.failedUploadsOnly(["a", "b", "c"], [true, false, true]), ["b"]);
  assert.deepEqual(r.failedUploadsOnly(["a", "b"], [true, true]), []);
  assert.deepEqual(r.failedUploadsOnly(["a", "b"], []), ["a", "b"]);
  // 화면은 업로드 도우미가 돌려준 «실패한 파일»로 다시 올린다
  assert.match(read("src/lib/clientImageUpload.ts"), /return \{ items, failedNames, failedFiles, skippedCount, total: selected\.length \}/);
  const uploader = read("src/components/staff/SessionPhotoUploader.tsx");
  assert.match(uploader, /onClick=\{\(\) => void upload\(failedFiles\)\}/);
  assert.match(uploader, /실패한 \{failedFiles\.length\}장 다시 올리기/);
  // «나온 학생» 선택은 없다
  assert.doesNotMatch(uploader, /subjectStudentIds|toggleSubject|updatePhotoSubjects|학생 수정/);
});

// ── 사진 보기 라우트 IDOR(실행) ─────────────────────────────────────

const require = createRequire(import.meta.url);
const ts = require("typescript");
function compile(file, mocks = {}) {
  const code = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  const req = (name) => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    throw new Error(`검사에서 의존성 접근 금지: ${name}`);
  };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { Response, URL }, { filename: file })(req, mod, mod.exports);
  return mod.exports;
}
const photoEntries = compile("src/lib/sessionPhotoEntries.ts");

function photoRoute({ staff = false, parentCanView = false, sessionClass = "class-1" }) {
  const downloads = [];
  const viewChecks = [];
  const stored = (id, session) => ({ id, type: "image", url: "", storageBucket: "staff-session-private", storagePath: `staff-sessions/${sessionClass}/${session}/${id}.jpg`, visibility: "PRIVATE" });
  const drafts = { "session-1": [{ mediaJSON: JSON.stringify([stored("photo-1", "session-1")]) }], "session-2": [{ mediaJSON: JSON.stringify([stored("photo-2", "session-2")]) }] };
  const route = compile("src/app/api/staff/sessions/[sessionId]/photos/[photoId]/route.ts", {
    "@/lib/user-facing-error": { userFacingError: (_e, fallback) => fallback },
    "next/server": { NextResponse: { json: (body, init) => ({ status: init?.status ?? 200, body }) } },
    "@/lib/prisma": { prisma: { $queryRawUnsafe: async (sql, sessionId) => {
      if (sql.includes('FROM "Session"')) return drafts[sessionId] ? [{ classId: sessionClass, status: "COMPLETED", date: "2026-11-14" }] : [];
      if (sql.includes('FROM "SocialPostDraft"')) return drafts[sessionId] ?? []; // 주소의 수업 것만
      throw new Error(sql);
    } } },
    "@/lib/supabase/admin": { createAdminClient: () => ({ storage: { from: () => ({ download: async (path) => { downloads.push(path); return { data: new Blob(["jpg"], { type: "image/jpeg" }), error: null }; } }) } }) },
    "@/lib/staff-class-access": { requireStaffClassAccess: async () => { if (!staff) throw new Error("NO_STAFF"); }, requireStaffSessionAccess: async () => ({}) },
    "@/lib/sessionPhotoStorage": { ...photoEntries, isValidPrivateSessionPhotoRef: (m, { classId, sessionId }) => m.storagePath === `staff-sessions/${classId}/${sessionId}/${m.id}.jpg` },
    "@/lib/auth-guard": { requireVerifiedParent: async () => ({ appUserId: "parent-1" }) },
    "@/lib/feed/server": { parentCanViewSession: async (appUserId, sessionId) => { viewChecks.push([appUserId, sessionId]); return parentCanView === true || parentCanView === sessionId; } },
    "@/lib/feed/rules": { canManageSessionMedia: () => ({ ok: true }), photoWindowMessage: () => "", sessionKstDateSql: () => "d", TODAY_KST_SQL: "t" },
    "@/lib/sessionPhotoManagement": {},
    "@/lib/sessionPhotoDeletionQueue": {},
    "@/lib/sessionPhotoManagementPolicy": {},
  });
  const get = (sessionId, photoId) => route.GET(new Request("http://x"), { params: Promise.resolve({ sessionId, photoId }) });
  return { get, downloads, viewChecks };
}

test("사진 보기(학부모) — 참여한 아이의 보호자면 동의·태그 없이 열린다", async () => {
  const r1 = photoRoute({ parentCanView: "session-1" });
  const res = await r1.get("session-1", "photo-1");
  assert.ok(res instanceof Response, "사진 응답");
  assert.equal(res.headers.get("Cache-Control"), "private, no-store, max-age=0");
  assert.deepEqual(r1.downloads, ["staff-sessions/class-1/session-1/photo-1.jpg"]);
  assert.deepEqual(r1.viewChecks, [["parent-1", "session-1"]], "판정은 로그인한 보호자 + 주소의 수업으로");
});

test("사진 보기 IDOR — 남의 수업 sessionId 는 403, 다른 수업의 photoId 는 404(파일을 읽지 않는다)", async () => {
  const notMine = photoRoute({ parentCanView: false });
  const denied = await notMine.get("session-1", "photo-1");
  assert.equal(denied.status, 403);
  assert.equal(notMine.downloads.length, 0);
  // 내 수업(session-1) 주소에 남의 수업(session-2) 사진 id 를 넣어도 그 수업 사진 원장에서만 찾는다 → 404
  const mine = photoRoute({ parentCanView: "session-1" });
  const swapped = await mine.get("session-1", "photo-2");
  assert.equal(swapped.status, 404);
  assert.equal(mine.downloads.length, 0);
  // 없는 수업 → 404
  assert.equal((await mine.get("nope", "photo-1")).status, 404);
  // 선생님(그 반 권한)은 보호자 판정 없이 본다
  const staff = photoRoute({ staff: true });
  assert.ok((await staff.get("session-2", "photo-2")) instanceof Response);
  assert.equal(staff.viewChecks.length, 0);
});

test("사진 보기 라우트에는 동의·«나온 학생» 검사가 없고, 공용 판정 하나만 쓴다", () => {
  const src = read("src/app/api/staff/sessions/[sessionId]/photos/[photoId]/route.ts");
  assert.doesNotMatch(src, /FROM "StudentMediaConsent"|"subjectStudentIdsJSON" FROM "SocialPostDraft" WHERE "sessionId"|사진 열람 동의를 확인할 수 없습니다/);
  assert.match(src, /if \(!await parentCanViewSession\(parent\.appUserId, sessionId\)\) throw/);
  assert.doesNotMatch(src, /export async function PATCH/, "«나온 학생» 수정 API 는 없앴다");
  // 지우기는 영상과 같은 시간 규칙(잠근 뒤 한 번 더)
  assert.match(src, /const lockedWindow = sessionRows\[0\] \? canManageSessionMedia\(sessionRows\[0\]\) : null;/);
});

// ── 선생님: 사진 올리기·한 줄 저장 ───────────────────────────────────

test("사진 올리기 — 학생 선택 필수 없음, 영상과 같은 시간 규칙(잠근 뒤 재확인), 알림 없음", () => {
  const src = read("src/app/api/staff/sessions/[sessionId]/photos/route.ts");
  assert.doesNotMatch(src, /사진에 나온 학생을 한 명 이상/);
  assert.match(src, /subjectStudentIds: \[\],/);
  assert.match(src, /const window = canManageSessionMedia\(session\);\s*if \(!window\.ok\) return NextResponse\.json\(\{ error: photoWindowMessage\(window\.reason\) \}, \{ status: 409 \}\);/);
  assert.match(src, /const lockedWindow = locked\[0\] \? canManageSessionMedia\(locked\[0\]\) : null;/);
  assert.doesNotMatch(src, /deliverParentNotification|notifyParents/, "끝난 뒤 추가해도 학부모 알림은 다시 보내지 않는다");
  assert.doesNotMatch(read("src/app/api/staff/sessions/[sessionId]/videos/route.ts"), /deliverParentNotification|notifyParents/);
});

test("한 줄 저장 — 권한 함수 + 당일 자정 조건을 UPDATE 에도 걸고, 알림을 보내지 않는다", () => {
  const src = read("src/app/actions/staff-sessions.ts");
  const start = src.indexOf("export async function saveSessionFeedLine");
  const end = src.slice(start).search(/\r?\n\}\r?\n/);
  const body = src.slice(start, start + end);
  assert.match(body, /await trySessionAccess\(input\.sessionId\)/);
  assert.match(body, /canEditFeedLine\(rows\[0\]\)/);
  assert.match(body, /status IN \('PLANNED', 'IN_PROGRESS', 'COMPLETED'\)/);
  assert.match(body, /AND \$\{sessionKstDateSql\('"Session"'\)\} = \$\{TODAY_KST_SQL\}/);
  assert.doesNotMatch(body, /deliverParentNotification|runAfterResponse/);
  // 수업 화면 «수업 피드» 칸과 종료 확인 창이 같은 값을 쓴다(이미 저장한 한 줄로 시작)
  const client = read("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx");
  assert.match(client, /useState\(session\.content \|\| ""\)/);
  assert.match(client, /<FeedLineEditor sessionId=\{session\.id\} value=\{report\} onChange=\{setReport\}/);
  // 오늘 수업 홈: 시작 전·끝난 수업에서 «수업 피드»를 연다
  const home = read("src/app/staff/StaffHomeClient.tsx");
  assert.match(home, /else if \(action === "feed"\) openFeed\(lesson\);/);
  assert.match(home, /수업 피드 쓰기·사진 추가/);
});

test("동의 UI 제거 — 학생 상세 링크·동의 화면·등록 창 질문이 없다(기록 표는 그대로)", () => {
  assert.doesNotMatch(read("src/app/admin/students/[id]/StudentDetailClient.tsx"), /media-consent|사진 사용 동의<\/|>\s*사진 사용 동의/);
  const modal = read("src/app/admin/students/StudentRegisterModal.tsx");
  assert.doesNotMatch(modal, /사진·영상 활용 동의를 받았어요|mediaChecked/);
  assert.match(modal, /mediaConsent: null,/);
  let exists = true;
  try { read("src/app/admin/students/[id]/media-consent/page.tsx"); } catch { exists = false; }
  assert.equal(exists, false);
  // 동의 기록 표는 지우지 않는다(스키마 유지)
  assert.match(read("prisma/schema.prisma"), /model StudentMediaConsent \{/);
});
