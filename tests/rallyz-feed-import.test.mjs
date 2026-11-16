// 2026-11-16 랠리즈 2026 수업 피드(다산2호점) → 사이트 수업 피드 이관(원장 결정표 v1~v5).
//  - 이관 스크립트 순수 규칙(scripts/rallyz-feed-import/lib.mjs)을 실제로 돌린다:
//    반 매칭(꼬리 «(대표팀)» 제거) · 작성일 KST(자정·월말·연말·윤년) · 수업일 보정 · 지점 거르기 · 최신 위로 정렬 · 영상 묶음 · 한도
//  - SQL 문장: 덮어쓰지 않고 덧붙임 · 장부로 중복 방지 · 기본 미발행 · 되돌림
//  - 사이트 쪽 연결: importSource 상수 = DB CHECK = 스크립트 상수, 발행 두 경로(관리자·선생님) 모두 알림 건너뛰기
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";
import * as L from "../scripts/rallyz-feed-import/lib.mjs";

const read = (p) => readFileSync(p, "utf8");

// ── 반 이름 ──────────────────────────────────────────────────────────

const CLASSES = [
  { id: "c-mon4", name: "월4", dayOfWeek: "Mon" },
  { id: "c-sat7", name: "토 7교시", dayOfWeek: "Sat" },
  { id: "c-thu3", name: "목3", dayOfWeek: "Thu" },
  { id: "c-dup1", name: "금5", dayOfWeek: "Fri" },
  { id: "c-dup2", name: "금 5", dayOfWeek: "Fri" },
];

test("반 이름 정규화: 꼬리 괄호·공백·대소문자", () => {
  assert.equal(L.normalizeClassName("월4(대표팀)"), "월4");
  assert.equal(L.normalizeClassName(" 월4 (성인반) "), "월4");
  assert.equal(L.normalizeClassName("월4(대표팀)(B)"), "월4");
  assert.equal(L.normalizeClassName("토 7교시"), "토7교시");
  assert.equal(L.normalizeClassName("U12 Elite"), "u12elite");
  assert.equal(L.normalizeClassName(null), "");
});

test("반 매칭: 정확히 하나 · 모호 · 없음 · 수동 매핑", () => {
  assert.deepEqual(L.matchClass("월4(대표팀)", CLASSES), { classId: "c-mon4", reason: "exact" });
  assert.deepEqual(L.matchClass("토7교시", CLASSES), { classId: "c-sat7", reason: "exact" });
  assert.equal(L.matchClass("금5", CLASSES).reason, "ambiguous");
  assert.equal(L.matchClass("화2", CLASSES).reason, "not-found");
  assert.equal(L.matchClass("", CLASSES).reason, "no-name");
  assert.deepEqual(L.matchClass("금5", CLASSES, { 금5: "c-dup2" }), { classId: "c-dup2", reason: "manual" });
  assert.deepEqual(L.matchClass("엘리트", CLASSES, { 엘리트: "목3" }), { classId: "c-thu3", reason: "manual" });
  assert.equal(L.matchClass("엘리트", CLASSES, { 엘리트: "없는반" }).reason, "manual-not-found");
});

// ── 날짜 ────────────────────────────────────────────────────────────

test("작성일 → KST: 벽시계 글자는 그대로, 시간대 붙은 값은 옮긴다(자정·연말·윤년)", () => {
  assert.deepEqual(L.parseRallyzDate("2026-11-12 15:30:22"), { ymd: "2026-11-12", hms: "15:30:22", sortKey: "2026-11-12 15:30:22" });
  assert.equal(L.parseRallyzDate("2026.11.12 15:30").ymd, "2026-11-12");
  assert.equal(L.parseRallyzDate("20261112153022").sortKey, "2026-11-12 15:30:22");
  // UTC 15:30 = KST 다음 날 00:30 (새벽에 «어제»가 나오는 사고 방지)
  assert.equal(L.parseRallyzDate("2026-11-11T15:30:00Z").ymd, "2026-11-12");
  assert.equal(L.parseRallyzDate("2026-12-31T15:00:00Z").ymd, "2027-01-01");
  assert.equal(L.parseRallyzDate("2026-12-31T14:59:59Z").ymd, "2026-12-31");
  assert.equal(L.parseRallyzDate("2026-11-12T00:10:00+09:00").ymd, "2026-11-12");
  // 숫자(초·밀리초)
  assert.equal(L.parseRallyzDate(Date.UTC(2026, 10, 11, 15, 30) / 1000).ymd, "2026-11-12");
  assert.equal(L.parseRallyzDate(Date.UTC(2026, 10, 11, 15, 30)).ymd, "2026-11-12");
  assert.equal(L.parseRallyzDate(String(Date.UTC(2026, 10, 11, 15, 30))).ymd, "2026-11-12");
  // 없는 날짜·모르는 모양
  assert.equal(L.parseRallyzDate("2026-02-29 10:00"), null);
  assert.equal(L.parseRallyzDate("2028-02-29 10:00").ymd, "2028-02-29");
  assert.equal(L.parseRallyzDate("어제"), null);
  assert.equal(L.parseRallyzDate(""), null);
  assert.equal(L.parseRallyzDate(undefined), null);
});

test("요일·날짜 더하기는 시간대와 무관(월말·연말·윤년)", () => {
  assert.equal(L.ymdDow("2026-11-16"), 1); // 월
  assert.equal(L.ymdDow("2027-01-01"), 5); // 금
  assert.equal(L.addDaysYmd("2026-12-01", -1), "2026-11-30");
  assert.equal(L.addDaysYmd("2027-01-01", -1), "2026-12-31");
  assert.equal(L.addDaysYmd("2028-03-01", -1), "2028-02-29");
  assert.deepEqual([...L.classDows("Mon,Wed")].sort(), [1, 3]);
  assert.deepEqual([...L.classDows("토")], [6]);
  assert.equal(L.classDows("").size, 0);
});

test("수업일 보정: 반 요일이 아니면 최대 3일 전까지 거슬러(월말·연말 넘어)", () => {
  const mon = L.classDows("Mon");
  assert.deepEqual(L.resolveSessionYmd("2026-11-16", mon), { ymd: "2026-11-16", shifted: 0 }); // 월요일 당일
  assert.deepEqual(L.resolveSessionYmd("2026-11-17", mon), { ymd: "2026-11-16", shifted: 1 }); // 화요일에 올린 글
  assert.deepEqual(L.resolveSessionYmd("2026-12-01", mon), { ymd: "2026-11-30", shifted: 1 }); // 월말
  assert.deepEqual(L.resolveSessionYmd("2027-01-01", L.classDows("Thu")), { ymd: "2026-12-31", shifted: 1 }); // 연말
  assert.deepEqual(L.resolveSessionYmd("2026-11-20", mon), { ymd: "2026-11-20", shifted: 0 }); // 4일 넘게 떨어지면 그대로
  assert.deepEqual(L.resolveSessionYmd("2026-11-17", new Set()), { ymd: "2026-11-17", shifted: 0 }); // 요일 모름
});

// ── 피드 정규화 ───────────────────────────────────────────────────────

const RAW = {
  data: {
    list: [
      {
        feedId: 101, regDt: "2026-11-16 18:10:00", contents: "드리블 연습<br>잘했어요 &amp; 수고!",
        classInfo: { className: "월4(대표팀)", instNm: "스티즈 다산2호점", classId: "rz-c1" },
        writer: { profileImg: "https://cdn.rallyz.co.kr/profile/a.jpg" },
        fileList: [
          { fileType: "image", fileUrl: "https://cdn.rallyz.co.kr/board/feed/p1.jpg?type=w&w=300" },
          { fileType: "image", fileUrl: "https://cdn.rallyz.co.kr/board/feed/p2.png" },
          { fileType: "image", fileUrl: "https://cdn.rallyz.co.kr/board/feed/p1.jpg" },
          { fileType: "video", filePath: "board/feed_vod_bc/v9_AVC_HD.mp4", thumb: "https://cdn.rallyz.co.kr/board/feed_vod/v9.jpg" },
        ],
      },
      { feedId: 102, regDt: "2026-11-17 09:00:00", contents: "어제 수업 사진", classInfo: { className: "월4", instNm: "다산2호점" },
        fileList: [{ fileUrl: "https://cdn.rallyz.co.kr/board/feed/p3.jpeg" }] },
      { feedId: 103, regDt: "2026-11-16 17:00:00", contents: "평내 소식", classInfo: { className: "월4", instNm: "평내호평점" } },
      { feedId: 104, regDt: "2026-11-14 11:00:00", contents: "토요일", classInfo: { className: "토 7교시", instNm: "다산2호점" },
        media: ["https://x.rallyz.co.kr/hls/TOKEN/board/feed_vod_bc/v7_AVC_HD.mp4/index.m3u8"] },
      { feedId: 105, regDt: "2026-10-05 10:00:00", contents: "10월", classInfo: { className: "월4", instNm: "다산2호점" } },
      { feedId: 106, regDt: "2026-11-16 19:00:00", contents: "", classInfo: { className: "월4", instNm: "다산2호점" } },
      { feedId: 107, regDt: "2026-11-16 20:00:00", contents: "모르는 반", classInfo: { className: "수9", instNm: "다산2호점" } },
      { feedId: 101, regDt: "2026-11-16 18:10:00", contents: "중복", classInfo: { className: "월4", instNm: "다산2호점" } },
      { feedId: 108, contents: "날짜 없음" },
    ],
  },
};

test("피드 파일 읽기: 글 배열 찾기·중복 제거·본문 정리·사진(프로필·썸네일 제외)·영상 id", () => {
  const { posts, invalid, rawCount } = L.readFeedExport(RAW);
  assert.equal(rawCount, 9);
  assert.equal(invalid, 1); // 날짜 없음
  assert.deepEqual(posts.map((p) => p.id), ["101", "102", "103", "104", "105", "106", "107"]);
  const p = posts[0];
  assert.equal(p.text, "드리블 연습\n잘했어요 & 수고!");
  assert.equal(p.className, "월4(대표팀)");
  assert.equal(p.instNm, "스티즈 다산2호점");
  assert.deepEqual(p.photos, ["https://cdn.rallyz.co.kr/board/feed/p1.jpg", "https://cdn.rallyz.co.kr/board/feed/p2.png"]);
  assert.deepEqual(p.videos, [{ vodId: "v9", m3u8: null }]);
  assert.deepEqual(posts[3].videos, [{ vodId: "v7", m3u8: "https://x.rallyz.co.kr/hls/TOKEN/board/feed_vod_bc/v7_AVC_HD.mp4/index.m3u8" }]);
  assert.equal(L.photoUrl1000("https://cdn.rallyz.co.kr/board/feed/p1.jpg"), "https://cdn.rallyz.co.kr/board/feed/p1.jpg?type=w&w=1000");
});

test("지점 거르기(v5): 다산2호점만, 이름 없는 글은 버린다", () => {
  assert.equal(L.isTargetInst("스티즈 다산2호점"), true);
  assert.equal(L.isTargetInst("다산 2호점"), true);
  assert.equal(L.isTargetInst("다산점"), false);
  assert.equal(L.isTargetInst("평내호평점"), false);
  assert.equal(L.isTargetInst("슈퍼맥스"), false);
  assert.equal(L.isTargetInst(""), false);
});

// ── 계획 ────────────────────────────────────────────────────────────

const SNAP = {
  todayKst: "2026-11-16",
  classes: CLASSES,
  sessions: [
    { id: "s-mon4-1116", classId: "c-mon4", ymd: "2026-11-16", sessionKey: "c-mon4:2026-11-16", status: "COMPLETED", published: false, hasContent: true, attendanceStudents: ["st1", "st2"] },
    { id: "s-sat7-1114", classId: "c-sat7", ymd: "2026-11-14", sessionKey: null, status: "PLANNED", published: false, hasContent: false, attendanceStudents: [] },
    { id: "s-mon4-1005", classId: "c-mon4", ymd: "2026-10-05", sessionKey: "c-mon4:2026-10-05", status: "COMPLETED", published: true, attendanceStudents: ["st1"] },
  ],
  enrollStarts: [
    { classId: "c-sat7", studentId: "st9", startYmd: "2026-09-01" },
    { classId: "c-sat7", studentId: "st8", startYmd: "2026-12-01" },
    { classId: "c-mon4", studentId: "st1", startYmd: "2026-03-02" },
  ],
  imported: [],
};

test("계획: 다산2호점·기간·반 매칭으로 거르고, 수업별로 묶어 «최신 수업 위로», 수업 안은 쓴 순서", () => {
  const { posts } = L.readFeedExport(RAW);
  const plan = L.planPostImport({ posts, snapshot: SNAP, options: { from: "2026-11-01", to: "2026-11-30" } });
  assert.equal(plan.counts.otherInst, 1);
  assert.equal(plan.counts.empty, 1);
  assert.equal(plan.counts.noClass, 1);
  assert.equal(plan.counts.outOfRange, 1); // 10월 글
  assert.deepEqual(plan.groups.map((g) => `${g.ymd} ${g.className}`), ["2026-11-16 월4", "2026-11-14 토 7교시"]);
  const mon = plan.groups[0];
  // 화요일(11/17)에 올린 «어제 수업 사진»은 월요일 수업으로 당겨지고, 쓴 순서(16일 → 17일)로 붙는다
  assert.deepEqual(mon.posts.map((p) => p.id), ["101", "102"]);
  assert.deepEqual(mon.shifted, [{ id: "102", from: "2026-11-17", back: 1 }]);
  assert.equal(mon.existing.id, "s-mon4-1116");
  assert.equal(mon.viewers, 2); // 출결 st1·st2 (+ 수강 st1 중복)
  assert.equal(plan.groups[1].viewers, 1); // 수강 시작 9/1 인 st9 만(12/1 시작은 아직)
  assert.equal(plan.counts.planned, 3);
});

test("계획: 수업 기록 없음·이미 보낸 수업·이미 옮긴 글·반 거르기", () => {
  const { posts } = L.readFeedExport(RAW);
  // 10월 수업은 이미 발행됨 → 기본은 건너뜀, --allow-published 면 포함
  const oct = L.planPostImport({ posts, snapshot: SNAP, options: { from: "2026-10-01", to: "2026-10-31" } });
  assert.equal(oct.groups.length, 0);
  assert.equal(oct.counts.publishedSkipped, 1);
  assert.equal(L.planPostImport({ posts, snapshot: SNAP, options: { from: "2026-10-01", to: "2026-10-31", allowPublished: true } }).groups.length, 1);
  // 그날 수업 기록이 없으면 기본은 건너뜀, --create-missing 이면 새 기록
  const noSessions = { ...SNAP, sessions: [] };
  const skip = L.planPostImport({ posts, snapshot: noSessions, options: { from: "2026-11-01", to: "2026-11-30" } });
  assert.equal(skip.groups.length, 0);
  assert.equal(skip.counts.noSessionSkipped, 3);
  const create = L.planPostImport({ posts, snapshot: noSessions, options: { from: "2026-11-01", to: "2026-11-30", createMissing: true } });
  assert.equal(create.groups.length, 2);
  assert.equal(create.groups[0].existing, null);
  // 이미 옮긴 글은 다시 넣지 않는다
  const again = L.planPostImport({ posts, snapshot: { ...SNAP, imported: [{ kind: "POST", sourceKey: "101" }, { kind: "POST", sourceKey: "102" }] }, options: { from: "2026-11-01", to: "2026-11-30" } });
  assert.equal(again.counts.alreadyImported, 2);
  assert.deepEqual(again.groups.map((g) => g.className), ["토 7교시"]);
  // 반 하나만(이름·id 둘 다)
  assert.deepEqual(L.planPostImport({ posts, snapshot: SNAP, options: { from: "2026-11-01", to: "2026-11-30", classFilter: "월4" } }).groups.map((g) => g.classId), ["c-mon4"]);
  assert.deepEqual(L.planPostImport({ posts, snapshot: SNAP, options: { from: "2026-11-01", to: "2026-11-30", classFilter: "c-sat7" } }).groups.map((g) => g.classId), ["c-sat7"]);
});

test("정렬: 수업일 내림차순 → 같은 날은 반 이름(사이트 피드와 같은 «최신 위로»)", () => {
  const groups = [
    { ymd: "2026-03-02", className: "월4", key: "a" },
    { ymd: "2026-11-14", className: "토7", key: "b" },
    { ymd: "2026-11-14", className: "토1", key: "c" },
    { ymd: "2026-12-31", className: "목3", key: "d" },
  ].sort(L.compareGroupsNewestFirst);
  assert.deepEqual(groups.map((g) => g.key), ["d", "c", "b", "a"]);
});

test("내용 덧붙이기·되돌리기: 기존 내용을 덮지 않고, 되돌리면 정확히 원래대로", () => {
  assert.equal(L.appendContent(null, "새 글"), "새 글");
  assert.equal(L.appendContent("  ", "새 글"), "새 글");
  assert.equal(L.appendContent("선생님 한 줄", "새 글"), "선생님 한 줄\n\n새 글");
  assert.equal(L.appendContent("선생님 한 줄", ""), "선생님 한 줄");
  assert.equal(L.removeAppendedContent("선생님 한 줄\n\n새 글", "새 글"), "선생님 한 줄");
  assert.equal(L.removeAppendedContent("새 글", "새 글"), null);
  assert.equal(L.removeAppendedContent("앞\n\n새 글\n\n뒤", "새 글"), "앞\n\n뒤");
  assert.equal(L.buildAppendedText([{ text: "하나" }, { text: "" }, { text: "둘" }]), "하나\n\n둘");
});

// ── SQL ─────────────────────────────────────────────────────────────

test("이관 SQL: 장부로 중복 방지 · 덧붙임 · 사진은 선생님 업로드와 같은 경로 · 기본 미발행", () => {
  const photo = L.storedPhoto({ classId: "c-mon4", sessionId: "s-new", photoId: "11111111-2222-4333-8444-555555555555", rallyzFeedId: 101 });
  assert.equal(photo.storagePath, "staff-sessions/c-mon4/s-new/11111111-2222-4333-8444-555555555555.jpg");
  assert.equal(photo.url, "/api/staff/sessions/s-new/photos/11111111-2222-4333-8444-555555555555");
  assert.equal(photo.storageBucket, "staff-session-private");
  assert.equal(photo.visibility, "PRIVATE");
  const sql = L.buildGroupSql({
    sessionId: "s-new", createSession: true, classId: "c-mon4", className: "월4", ymd: "2026-11-16", previousStatus: null,
    posts: [{ id: "101", text: "it's 좋아요 \\ 끝", createdSortKey: "2026-11-16 18:10:00", className: "월4(대표팀)", photos: [photo] }],
  }, "rz-feed-20261116-1530");
  assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM "RallyzFeedImport" WHERE kind = 'POST' AND "sourceKey" = '101'\)/);
  assert.match(sql, /INSERT INTO "Session" \(id, "classId", date, "sessionKey", status, published, "importSource"/);
  assert.match(sql, /'c-mon4:2026-11-16', 'COMPLETED', false, 'RALLYZ_FEED'/);
  assert.match(sql, /'it''s 좋아요 \\ 끝'/); // 작은따옴표는 두 번, 역슬래시는 글자 그대로
  assert.match(sql, /content = CASE WHEN content IS NULL OR btrim\(content\) = '' THEN .* ELSE content \|\| '\n\n' \|\| /);
  assert.match(sql, /'DRAFT', .*'SESSION_PHOTO', '\[\]', 'RALLYZ_IMPORT:rz-feed-20261116-1530:101'/);
  assert.match(sql, /"photosJSON" = \(COALESCE\(NULLIF\(btrim\("photosJSON"\), ''\), '\[\]'\)::jsonb \|\| '\["\/api\/staff\/sessions\/s-new\/photos\/11111111-2222-4333-8444-555555555555"\]'::jsonb\)::text/);
  assert.doesNotMatch(sql, /published = true/); // 기본은 발행하지 않는다
  assert.doesNotMatch(sql, /Notification|deliverParent/);
  assert.match(L.buildGroupSql({ sessionId: "s1", createSession: false, classId: "c1", className: "x", ymd: "2026-11-16", posts: [] }, "b", { publish: true }), /published = true, "publishedAt" = COALESCE\("publishedAt", NOW\(\)\)/);
  // 이상한 id·날짜·블록 구분 글자는 멈춘다
  assert.throws(() => L.buildGroupSql({ sessionId: "x'; DROP", createSession: false, classId: "c1", ymd: "2026-11-16", posts: [] }, "b"));
  assert.throws(() => L.buildGroupSql({ sessionId: "s1", createSession: false, classId: "c1", ymd: "2026-02-30", posts: [] }, "b"));
  assert.throws(() => L.buildGroupSql({ sessionId: "s1", createSession: false, classId: "c1", className: "x", ymd: "2026-11-16", posts: [{ id: "1", text: "$rz$", photos: [] }] }, "b"));
});

test("알림 없는 발행·되돌림 SQL", () => {
  const pub = L.publishSql(["s1", "s2"]);
  assert.match(pub, /WHERE id IN \('s1', 's2'\) AND "importSource" = 'RALLYZ_FEED' AND status = 'COMPLETED' AND published = false/);
  const rb = L.buildRollbackSql("rz-feed-1");
  assert.match(rb, /^-- 랠리즈 피드 이관 되돌림/);
  assert.match(rb, /BEGIN;[\s\S]*COMMIT;$/);
  assert.match(rb, /INSERT INTO "SessionPhotoDeletionJob"/);
  assert.match(rb, /DELETE FROM "SocialPostDraft" WHERE memo LIKE 'RALLYZ_IMPORT:rz-feed-1:%' AND status = 'DRAFT'/);
  assert.match(rb, /NOT EXISTS \(SELECT 1 FROM "Attendance" a WHERE a."sessionId" = s.id\)/); // 출결 있는 수업은 지우지 않는다
  assert.match(rb, /UPDATE "SessionVideo" v SET "deletedAt" = NOW\(\)/);
  assert.match(L.buildRollbackSql("a'b"), /batch = 'a''b'/);
  // 미발행이던 수업은 되돌리면 다시 미발행, 예정이던 수업은 다시 예정
  assert.match(rb, /IF r\."previousPublished" IS FALSE THEN\s+UPDATE "Session" SET published = false/);
  assert.match(rb, /UPDATE "Session" SET status = r\."previousStatus"/);
  // 이전 상태는 블록 시작 때 한 번만 읽어 «첫 장부 줄»에만 적는다(두 번째 글이 바뀐 상태를 적지 않게)
  const g = L.buildGroupSql({ sessionId: "s1", createSession: false, classId: "c1", className: "x", ymd: "2026-11-16",
    posts: [{ id: "1", text: "a", photos: [] }, { id: "2", text: "b", photos: [] }] }, "b");
  assert.match(g, /SELECT status, COALESCE\(published, false\) INTO v_status, v_pub FROM "Session" WHERE id = 's1';/);
  assert.equal((g.match(/CASE WHEN v_first THEN v_status END/g) ?? []).length, 2);
  assert.equal((g.match(/v_first := false;/g) ?? []).length, 2);
  assert.match(read("prisma/migrations/20261116500000_rallyz_feed_import/migration.sql"), /"previousPublished" BOOLEAN/);
});

// ── 영상 ────────────────────────────────────────────────────────────

test("영상 묶음: 수업(반·날짜)마다 1개, 최신 수업부터, 이미 올린 수업 제외", () => {
  const raw = [
    { feedId: 1, regDt: "2026-11-16 18:00:00", classInfo: { className: "월4", instNm: "다산2호점" }, f: ["x/board/feed_vod_bc/a1_AVC_HD.mp4"] },
    { feedId: 2, regDt: "2026-11-16 17:00:00", classInfo: { className: "월4", instNm: "다산2호점" }, f: ["x/board/feed_vod_bc/a0_AVC_HD.mp4", "x/board/feed_vod_bc/a2.mp4"] },
    { feedId: 3, regDt: "2026-11-14 12:00:00", classInfo: { className: "토 7교시", instNm: "다산2호점" }, f: ["x/board/feed_vod_bc/b1_AVC_HD.mp4"] },
    { feedId: 4, regDt: "2026-03-07 12:00:00", classInfo: { className: "토 7교시", instNm: "다산2호점" }, f: ["x/board/feed_vod_bc/c1_AVC_HD.mp4"] },
    { feedId: 5, regDt: "2026-11-16 12:00:00", classInfo: { className: "월4", instNm: "다산점" }, f: ["x/board/feed_vod_bc/z_AVC_HD.mp4"] },
  ];
  const { posts } = L.readFeedExport(raw);
  const { batches } = L.planVideoBatches({ posts, snapshot: SNAP });
  assert.deepEqual(batches.map((b) => `${b.ymd} ${b.className} ${b.parts.map((p) => p.vodId).join("+")}`), [
    "2026-11-16 월4 a0+a2+a1", // 쓴 순서(17시 글 → 18시 글), 글 안 순서
    "2026-11-14 토 7교시 b1",
    "2026-03-07 토 7교시 c1",
  ]);
  const done = L.planVideoBatches({ posts, snapshot: { ...SNAP, imported: [{ kind: "VIDEO", sourceKey: "c-mon4:2026-11-16" }] } });
  assert.equal(done.batches.length, 2);
  assert.equal(L.hlsUrlFor({ vodId: "a1", m3u8: null }, "https://h/hls/T/board/feed_vod_bc/{id}_AVC_HD.mp4/index.m3u8"), "https://h/hls/T/board/feed_vod_bc/a1_AVC_HD.mp4/index.m3u8");
  assert.equal(L.hlsUrlFor({ vodId: "a1", m3u8: "https://direct.m3u8" }, ""), "https://direct.m3u8");
  assert.equal(L.hlsUrlFor({ vodId: "a1", m3u8: null }, ""), null);
  assert.equal(L.ffmpegConcatList(["C:\\v\\a.mp4", "it's.mp4"]), "file 'C:/v/a.mp4'\nfile 'it'\\''s.mp4'\n");
});

test("하루 한도: 사이트 크론과 같은 계수기(KST 날짜)를 나눠 쓴다", () => {
  const base = { todayKst: "2026-11-16", nowMs: Date.UTC(2026, 10, 16, 3), totalLimit: 5, uploadedThisRun: 0, perRun: 1 };
  assert.equal(L.canUploadMore({ quotaDay: "2026-11-16", quotaUsed: 4, quotaBlockedUntilMs: null }, base).ok, true);
  assert.equal(L.canUploadMore({ quotaDay: "2026-11-16", quotaUsed: 5, quotaBlockedUntilMs: null }, base).ok, false);
  assert.equal(L.canUploadMore({ quotaDay: "2026-11-15", quotaUsed: 5, quotaBlockedUntilMs: null }, base).ok, true); // 어제 기록은 0
  assert.equal(L.canUploadMore({ quotaDay: null, quotaUsed: 0, quotaBlockedUntilMs: base.nowMs + 1000 }, base).ok, false);
  assert.equal(L.canUploadMore({ quotaDay: null, quotaUsed: 0, quotaBlockedUntilMs: null }, { ...base, uploadedThisRun: 1 }).ok, false);
  // 다음 KST 자정(UTC 15:00 직후는 이미 KST 다음 날)
  assert.equal(L.nextKstMidnightIso(Date.UTC(2026, 10, 16, 14, 59)), "2026-11-17T00:00:00+09:00");
  assert.equal(L.nextKstMidnightIso(Date.UTC(2026, 11, 31, 15, 1)), "2027-01-02T00:00:00+09:00");
});

test("영상 기록 SQL: 저장소 사본 없이 UPLOADED/unlisted, 잠기면 PRIVATE_LOCKED, 장부로 중복 방지", () => {
  const v = { key: "c-mon4:2026-11-16", sessionId: "s1", classId: "c-mon4", className: "월4", ymd: "2026-11-16", createSession: false,
    sessionVideoId: "11111111-2222-4333-8444-555555555555", youtubeVideoId: "abcDEF123_-", privacy: "unlisted", sizeBytes: 1234 };
  const sql = L.buildVideoRecordSql(v, "rz-video-1");
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM "RallyzFeedImport" WHERE kind = 'VIDEO' AND "sourceKey" = 'c-mon4:2026-11-16'\) THEN RETURN;/);
  assert.match(sql, /'session-videos', 'rallyz-import\/s1\/11111111-2222-4333-8444-555555555555.mp4', 'video\/mp4', 1234/);
  assert.match(sql, /'abcDEF123_-', 'UPLOADED', 'unlisted', 1, NOW\(\), NOW\(\), NOW\(\)\)/); // storageDeletedAt = NOW()
  assert.doesNotMatch(sql, /INSERT INTO "Session"/);
  assert.match(L.buildVideoRecordSql({ ...v, privacy: "private" }, "b"), /'PRIVATE_LOCKED', 'private'/);
  assert.match(L.buildVideoRecordSql({ ...v, createSession: true }, "b"), /INSERT INTO "Session"/);
  assert.throws(() => L.buildVideoRecordSql({ ...v, youtubeVideoId: "bad id" }, "b"));
  assert.equal(L.classifyYoutubeError(403, "quotaExceeded"), "QUOTA");
  assert.equal(L.classifyYoutubeError(401, null), "AUTH");
  assert.equal(L.classifyYoutubeError(503, null), "RETRYABLE");
  assert.equal(L.classifyYoutubeError(400, "invalidTitle"), "FATAL");
});

// ── 사이트와 같은 값인지 ────────────────────────────────────────────────

test("사이트 규칙과 같다: 유튜브 제목·토큰 암호 형식·재생 규칙", async () => {
  const rules = await loadTsModule("src/lib/sessionVideo/rules.ts");
  assert.equal(L.youtubeTitle("월4  <대표>", "2026-11-16"), rules.youtubeVideoTitle("월4  <대표>", "2026-11-16"));
  assert.equal(L.youtubeTitle("", "2026-11-16"), rules.youtubeVideoTitle("", "2026-11-16"));
  // 이관 영상 기록 모양이면 학부모 화면이 유튜브로 재생한다(사본 없음 + 일부공개)
  assert.equal(rules.playbackKind({ youtubeStatus: "UPLOADED", youtubeVideoId: "abcDEF123_-", youtubePrivacy: "unlisted", storageDeletedAt: new Date() }), "youtube");
  assert.equal(rules.playbackKind({ youtubeStatus: "PRIVATE_LOCKED", youtubeVideoId: "abcDEF123_-", youtubePrivacy: "private", storageDeletedAt: new Date() }), "none");
  assert.equal(L.VIDEO_BUCKET, rules.SESSION_VIDEO_BUCKET);
  const crypto = await loadTsModule("src/lib/youtube/tokenCrypto.ts");
  const keyText = Buffer.alloc(32, 7).toString("base64url");
  const sealed = crypto.sealYoutubeToken("1//refresh-token-value", crypto.readYoutubeTokenKey(keyText));
  assert.equal(L.openSealedYoutubeToken(sealed, keyText), "1//refresh-token-value");
  assert.throws(() => L.openSealedYoutubeToken(sealed, Buffer.alloc(32, 8).toString("base64url")));
  const entries = await loadTsModule("src/lib/sessionPhotoEntries.ts");
  assert.equal(L.PRIVATE_PHOTO_BUCKET, entries.PRIVATE_SESSION_PHOTO_BUCKET);
  assert.equal(L.privatePhotoRoute("s1", "p1"), entries.privateSessionPhotoUrl("s1", "p1"));
  // 이관 사진 객체는 사이트 파서가 그대로 받아들인다
  const photo = L.storedPhoto({ classId: "c1", sessionId: "s1", photoId: "11111111-2222-4333-8444-555555555555", rallyzFeedId: "9" });
  assert.equal(entries.parseStoredSessionPhotos(JSON.stringify([photo])).length, 1);
  assert.deepEqual(entries.toSessionReportPhotoViews(JSON.stringify([photo.url]), "s1"), [{ index: 0, src: photo.url, isPrivate: true }]);
});

test("이관 표시 값 = DB CHECK = 스크립트 상수, 발행 두 경로 모두 알림 건너뛰기", () => {
  const mod = read("src/lib/feed/importedSession.ts");
  assert.match(mod, /export const IMPORT_SOURCE_RALLYZ_FEED = "RALLYZ_FEED";/);
  assert.equal(L.IMPORT_SOURCE, "RALLYZ_FEED");
  const migration = read("prisma/migrations/20261116500000_rallyz_feed_import/migration.sql");
  assert.match(migration, /CHECK \("importSource" IS NULL OR "importSource" IN \('RALLYZ_FEED'\)\)/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "RallyzFeedImport_kind_sourceKey_key"/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(read("prisma/schema.prisma"), /importSource\s+String\?/);
  // 관리자 발행: 이관 수업이면 받는 사람 조회 자체를 비운다
  const admin = read("src/app/actions/admin.ts");
  const pub = admin.slice(admin.indexOf("export async function publishSessionReport"), admin.indexOf("export async function publishSessionReport") + 2500);
  assert.match(pub, /await isImportedSessionForNotice\(sessionId\) \? \[\] :/);
  // 선생님 발행: 처음 발행이어도 이관 수업이면 알림 없음
  const staff = read("src/app/actions/staff-sessions.ts");
  assert.match(staff, /const notifyParents = firstPublish && !\(await isImportedSessionForNotice\(input\.sessionId\)\);/);
  assert.match(staff, /if \(notifyParents\) \{\s*const ymd/);
  // 판정은 조회 실패 시 «이관 아님»(마이그레이션 전에도 사이트가 그대로 동작)
  assert.match(mod, /catch \{\s*return false;/);
});

test("순수 판정 skipsPublishNotice", async () => {
  // importedSession.ts 는 prisma 를 import 해서 로더에 가짜 모듈을 쓴다
  const src = read("src/lib/feed/importedSession.ts");
  const fn = src.slice(src.indexOf("export function skipsPublishNotice"), src.indexOf("/** 이 수업이 이관 수업인가"));
  assert.match(fn, /SESSION_IMPORT_SOURCES as readonly string\[\]\)\.includes\(importSource\)/);
});
