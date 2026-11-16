// «내 캘린더에 연동»(2026-11-16 원장 승인) — 캘린더 구독 파일과 개인 일정 주소의 약속을 못박는다.
//  ① 구독 파일 만들기(ics.ts)는 실제로 실행해서 본다 — 날짜가 하루 밀리거나 줄이 깨지면 캘린더가 일정을 통째로 버린다
//  ② 무엇을 내보낼지(feedEvents.ts)도 실행해서 본다 — 역할 거르기·수업일·자정 경계
//  ③ 개인 일정 주소는 소스 글자로 본다 — 해시로만 찾기·저장 금지·역할 재검증·404 통일
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const read = (path) => readFileSync(path, "utf8");
const ics = await loadTsModule("src/lib/calendar/ics.ts");
const feed = await loadTsModule("src/lib/calendar/feedEvents.ts");
const kst = await loadTsModule("src/lib/datetime/kst.ts");

const NOW = Date.UTC(2026, 10, 16, 3, 0, 0); // 2026-11-16 12:00 KST
const build = (events, name = "스티즈 농구교실 일정") => ics.buildIcsCalendar({ name, events, nowMs: NOW });
/** 접힌 줄을 다시 펴서 «논리 줄» 목록으로 */
const unfold = (text) => text.replace(/\r\n /g, "").split("\r\n");

test("글자 이스케이프: 역슬래시·쉼표·세미콜론·줄바꿈", () => {
  assert.equal(ics.escapeIcsText("a\\b"), "a\\\\b");
  assert.equal(ics.escapeIcsText("가,나;다"), "가\\,나\\;다");
  assert.equal(ics.escapeIcsText("첫 줄\n둘째 줄\r\n셋째 줄"), "첫 줄\\n둘째 줄\\n셋째 줄");
  // 역슬래시를 먼저 바꿔야 뒤에서 붙인 역슬래시가 또 바뀌지 않는다
  assert.equal(ics.escapeIcsText("\\,"), "\\\\\\,");
  assert.equal(ics.escapeIcsText(null), "");

  const lines = unfold(build([{ uid: "u1", title: "개강, 종강; 안내", description: "첫 줄\n둘째 줄", location: "다산2호점, 3층", allDay: true, startYmd: "2026-11-16" }]));
  assert.ok(lines.includes("SUMMARY:개강\\, 종강\\; 안내"));
  assert.ok(lines.includes("DESCRIPTION:첫 줄\\n둘째 줄"));
  assert.ok(lines.includes("LOCATION:다산2호점\\, 3층"));
});

test("줄 접기: 한 줄은 75바이트 이하 · 이어지는 줄은 빈칸으로 시작 · 한글을 반으로 자르지 않는다 · 펴면 원문 그대로", () => {
  const bytes = (s) => Buffer.byteLength(s, "utf8");
  assert.equal(ics.foldIcsLine("SUMMARY:짧은 줄"), "SUMMARY:짧은 줄");

  const long = `SUMMARY:${"겨울방학 특강 안내 ".repeat(12)}끝`;
  const folded = ics.foldIcsLine(long);
  const parts = folded.split("\r\n");
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(bytes(part) <= 75, `${bytes(part)}바이트`);
  for (const part of parts.slice(1)) assert.ok(part.startsWith(" "));
  // 한글이 잘리면 다시 폈을 때 깨진 글자(U+FFFD)가 생긴다
  assert.equal(folded.replace(/\r\n /g, ""), long);
  assert.doesNotMatch(Buffer.from(folded, "utf8").toString("utf8"), /�/);

  // 정확히 75바이트는 접지 않고, 76바이트는 접는다
  const exact = "X".repeat(75);
  assert.equal(ics.foldIcsLine(exact), exact);
  assert.equal(ics.foldIcsLine(`${exact}Y`), `${exact}\r\n Y`);

  // 캘린더 전체에서도 모든 줄이 75바이트 이하
  const text = build([{ uid: "u-long", title: "가".repeat(120), allDay: true, startYmd: "2026-11-16" }]);
  for (const line of text.split("\r\n")) assert.ok(bytes(line) <= 75);
});

test("캘린더 뼈대: CRLF 줄바꿈 · 이름 · 다시 받아 오는 간격(6시간)", () => {
  const text = build([{ uid: "u1", title: "개강", allDay: true, startYmd: "2026-11-16" }]);
  assert.ok(text.endsWith("END:VCALENDAR\r\n"));
  assert.doesNotMatch(text.replace(/\r\n/g, ""), /[\r\n]/, "CRLF 가 아닌 줄바꿈이 섞이면 안 된다");
  const lines = unfold(text);
  assert.equal(lines[0], "BEGIN:VCALENDAR");
  assert.ok(lines.includes("VERSION:2.0"));
  assert.ok(lines.includes("X-WR-CALNAME:스티즈 농구교실 일정"));
  assert.ok(lines.includes("REFRESH-INTERVAL;VALUE=DURATION:PT6H"));
  assert.ok(lines.includes("X-PUBLISHED-TTL:PT6H"));
  assert.ok(lines.includes("DTSTAMP:20261116T030000Z"));
});

test("종일 일정: 시작은 그날 · 끝은 «마지막 날 다음 날»(월말·연말·윤년)", () => {
  const range = (startYmd, endYmd) => {
    const lines = unfold(build([{ uid: "u", title: "휴무", allDay: true, startYmd, endYmd }]));
    return [lines.find((l) => l.startsWith("DTSTART")), lines.find((l) => l.startsWith("DTEND"))];
  };
  // 하루짜리
  assert.deepEqual(range("2026-11-16"), ["DTSTART;VALUE=DATE:20261116", "DTEND;VALUE=DATE:20261117"]);
  // 월말
  assert.deepEqual(range("2026-11-28", "2026-11-30"), ["DTSTART;VALUE=DATE:20261128", "DTEND;VALUE=DATE:20261201"]);
  // 연말
  assert.deepEqual(range("2026-12-30", "2026-12-31"), ["DTSTART;VALUE=DATE:20261230", "DTEND;VALUE=DATE:20270101"]);
  // 윤년 2028-02-29 — 끝나는 날이 2/29 면 다음 날은 3/1, 2/28 이면 2/29
  assert.deepEqual(range("2028-02-27", "2028-02-29"), ["DTSTART;VALUE=DATE:20280227", "DTEND;VALUE=DATE:20280301"]);
  assert.deepEqual(range("2028-02-28", "2028-02-28"), ["DTSTART;VALUE=DATE:20280228", "DTEND;VALUE=DATE:20280229"]);
  // 평년 2027-02-28 다음 날은 3/1
  assert.deepEqual(range("2027-02-28"), ["DTSTART;VALUE=DATE:20270228", "DTEND;VALUE=DATE:20270301"]);
  // 끝이 시작보다 앞서게 잘못 들어와도 하루짜리로 나간다
  assert.deepEqual(range("2026-11-16", "2026-11-10"), ["DTSTART;VALUE=DATE:20261116", "DTEND;VALUE=DATE:20261117"]);

  assert.equal(ics.icsNextDate("2028-02-29"), "20280301");
  assert.equal(ics.icsDate("2027-02-29"), "", "없는 날짜");
  // 없는 날짜의 일정은 통째로 건너뛴다(깨진 줄을 내보내지 않는다)
  assert.doesNotMatch(build([{ uid: "bad", title: "없는 날", allDay: true, startYmd: "2026-02-30" }]), /BEGIN:VEVENT/);
});

test("시간 일정: KST 시각이 UTC 로 나간다 — 자정 경계(KST 00:00 = 전날 UTC 15:00)", () => {
  const cls = { id: "k1", name: "초등 저학년반", dayOfWeek: "Mon", startTime: "16:00", endTime: "17:30", location: "다산2호점" };
  const [ev] = feed.classSessionsToIcs({ cls, dates: ["2026-11-16"], title: cls.name, uidScope: "teach-u1" });
  const lines = unfold(build([ev]));
  assert.ok(lines.includes("DTSTART:20261116T070000Z"), "KST 16:00 = UTC 07:00");
  assert.ok(lines.includes("DTEND:20261116T083000Z"));
  assert.ok(lines.includes("SUMMARY:초등 저학년반"));
  assert.ok(lines.includes("LOCATION:다산2호점"));

  // 자정: KST 2027-01-01 00:00 은 UTC 로 전날(2026-12-31) 15:00 — 해가 넘어간다
  assert.equal(ics.icsUtcStamp(kst.kstAt("2027-01-01", "00:00")), "20261231T150000Z");
  // 이른 아침 수업(KST 08:30)은 UTC 로 전날 23:30
  const early = feed.classSessionsToIcs({ cls: { ...cls, startTime: "08:30", endTime: "09:30" }, dates: ["2028-03-01"], title: "아침반", uidScope: "t" });
  const earlyLines = unfold(build(early));
  assert.ok(earlyLines.includes("DTSTART:20280229T233000Z"), "윤년 2/29 로 넘어간다");
  assert.ok(earlyLines.includes("DTEND:20280301T003000Z"));

  // 끝이 시작보다 앞서면 1시간짜리로
  const broken = unfold(build([{ uid: "b", title: "x", allDay: false, startMs: kst.kstAt("2026-11-16", "10:00"), endMs: kst.kstAt("2026-11-16", "09:00") }]));
  assert.ok(broken.includes("DTEND:20261116T020000Z"));
  // 수업 시간이 비어 있으면 그날 종일 일정으로(일정을 잃지 않는다)
  const noTime = feed.classSessionsToIcs({ cls: { ...cls, startTime: "", endTime: "" }, dates: ["2026-11-16"], title: "x", uidScope: "t" });
  assert.equal(noTime[0].allDay, true);
});

test("UID 는 안정적이다 — 같은 일정은 매번 같은 값, 다른 일정은 다른 값, 겹치는 UID 는 한 번만", () => {
  assert.equal(ics.icsUid("class", "abc-123", "2026-11-16"), "class-abc-123-2026-11-16@stiz-dasan.kr");
  assert.equal(ics.icsUid("class", "abc-123", "2026-11-16"), ics.icsUid("class", "abc-123", "2026-11-16"));
  assert.notEqual(ics.icsUid("class", "abc-123", "2026-11-16"), ics.icsUid("class", "abc-123", "2026-11-23"));
  assert.equal(ics.icsUid("a b", "한글/id"), "a_b-__/id@stiz-dasan.kr".replace("/", "_"));

  const cls = { id: "k1", name: "반", dayOfWeek: "Mon", startTime: "16:00", endTime: "17:00" };
  const once = feed.classSessionsToIcs({ cls, dates: ["2026-11-16", "2026-11-23"], title: "반", uidScope: "child-s1" });
  const again = feed.classSessionsToIcs({ cls, dates: ["2026-11-16", "2026-11-23"], title: "반", uidScope: "child-s1" });
  assert.deepEqual(once.map((e) => e.uid), again.map((e) => e.uid));
  // 같은 반이라도 아이가 다르면 UID 가 달라 서로 덮어쓰지 않는다
  const sibling = feed.classSessionsToIcs({ cls, dates: ["2026-11-16"], title: "반", uidScope: "child-s2" });
  assert.notEqual(once[0].uid, sibling[0].uid);
  // 만든 시각이 달라도 UID 줄은 같다
  const uidLines = (nowMs) => unfold(ics.buildIcsCalendar({ name: "n", events: once, nowMs })).filter((l) => l.startsWith("UID:"));
  assert.deepEqual(uidLines(NOW), uidLines(NOW + 86_400_000));
  // 같은 UID 가 두 번 들어오면 한 번만 내보낸다
  assert.equal((build([...once, ...again]).match(/BEGIN:VEVENT/g) ?? []).length, 2);
});

test("학원 일정 변환: 종일 일정은 KST 달력 날짜 그대로 · 끝 날짜 포함 · 시간 일정은 저장된 시각", () => {
  const events = feed.academyEventsToIcs([
    { id: "g1", source: "google", title: "학원 휴무 (추석)", date: "2026-11-04T00:00:00.000Z", endDate: "2026-11-05T00:00:00.000Z", isAllDay: true },
    { id: "d1", source: "db", title: "12월 개강", date: "2026-11-30T00:00:00.000Z", isAllDay: true },
    { id: "g2", source: "google", title: "학부모 간담회", date: "2026-11-20T10:00:00.000Z", endDate: "2026-11-20T11:00:00.000Z", isAllDay: false },
    { id: "bad", source: "db", title: "날짜 없음", date: "없는 값", isAllDay: true },
  ]);
  assert.equal(events.length, 3, "날짜가 깨진 일정은 뺀다");
  const lines = unfold(build(events));
  // 이틀 휴무 = 11/4 ~ 11/5(포함) → 끝은 11/6(배타)
  assert.ok(lines.includes("DTSTART;VALUE=DATE:20261104"));
  assert.ok(lines.includes("DTEND;VALUE=DATE:20261106"));
  assert.ok(lines.includes("DTSTART;VALUE=DATE:20261130"));
  assert.ok(lines.includes("DTEND;VALUE=DATE:20261201"));
  assert.ok(lines.includes("DTSTART:20261120T100000Z"));
  assert.ok(lines.includes("UID:academy-google-g1@stiz-dasan.kr"));
  assert.ok(lines.includes("UID:academy-db-d1@stiz-dasan.kr"));
});

test("항목 거르기: 아는 항목만 · 역할로 허용된 것만 · 셔틀은 항목에 없다", () => {
  assert.deepEqual([...feed.CALENDAR_KINDS], ["academy", "teaching", "children"]);
  assert.deepEqual(feed.parseCalendarKinds("children, academy,shuttle,,academy"), ["academy", "children"]);
  assert.deepEqual(feed.parseCalendarKinds(["teaching", "admin"]), ["teaching"]);
  assert.deepEqual(feed.parseCalendarKinds(null), []);

  assert.deepEqual(feed.allowedCalendarKinds(null), ["academy"], "비로그인은 학원 일정만");
  assert.deepEqual(feed.allowedCalendarKinds({ teacher: true, parent: false }), ["academy", "teaching"]);
  assert.deepEqual(feed.allowedCalendarKinds({ teacher: false, parent: true }), ["academy", "children"]);

  // 주소를 만들 때는 선생님이었지만 지금은 아니면 그 항목은 빠진다
  const stored = feed.parseCalendarKinds("academy,teaching");
  assert.deepEqual(feed.filterCalendarKinds(stored, feed.allowedCalendarKinds({ teacher: false, parent: false })), ["academy"]);
  assert.deepEqual(feed.filterCalendarKinds(feed.parseCalendarKinds("teaching"), feed.allowedCalendarKinds({ teacher: false, parent: true })), []);

  assert.equal(feed.hasPersonalKind(["academy"]), false);
  assert.equal(feed.hasPersonalKind(["academy", "children"]), true);
});

test("내보내는 범위와 수업일: 지난달~다다음달 · 연말 넘김 · 수강 시작일 이전 제외 · 겹친 날짜는 한 번", () => {
  assert.deepEqual(feed.feedMonths("2026-11-16"), ["2026-10", "2026-11", "2026-12", "2027-01"]);
  assert.deepEqual(feed.feedMonths("2027-01-01"), ["2026-12", "2027-01", "2027-02", "2027-03"]);

  // 수강월 수업일은 실제 달과 어긋날 수 있다(12월 개강이 11/30) — 달마다 모아 겹친 날짜는 한 번만
  const plan = {
    "2026-11": ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"],
    "2026-12": ["2026-11-30T00:00:00.000Z", "2026-12-07", "2026-11-23"],
  };
  const monthly = (ym, dow) => (dow === "Mon" ? plan[ym] ?? [] : []);
  const months = feed.feedMonths("2026-11-16");
  assert.deepEqual(feed.classDatesInRange(months, "Mon", null, monthly), ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07"]);
  assert.deepEqual(feed.classDatesInRange(months, "Mon", "2026-11-16", monthly), ["2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07"]);
  assert.deepEqual(feed.classDatesInRange(months, "Tue", null, monthly), []);
});

test("개인 일정 주소: 해시로만 찾고 원문은 저장하지 않는다", () => {
  const server = read("src/lib/calendar/feedServer.ts");
  assert.match(server, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(server, /createHash\("sha256"\)/);
  // 찾기 = tokenHash 로만
  assert.match(server, /FROM "CalendarFeedToken" WHERE "tokenHash" = \$1/);
  // 저장 = 해시만(원문 변수 token 을 INSERT 값으로 넘기지 않는다)
  assert.match(server, /INSERT INTO "CalendarFeedToken" \(id, "userId", "tokenHash", kinds\) VALUES \(\$1, \$2, \$3, \$4\)[\s\S]{0,80}randomUUID\(\),\s*userId,\s*hashFeedToken\(token\),/);
  // 표가 아직 없으면 «없음»으로(42P01) — 죽지 않는다
  assert.match(server, /42P01/);
  assert.equal((server.match(/isMissingFeedTable\(error\)/g) ?? []).length, 4, "찾기·세기·만들기·끊기 모두 표 없음에 대비");
  // 사용자당 최대 10개
  assert.match(server, /MAX_FEED_TOKENS_PER_USER = 10/);
  // ORM 기본 메서드를 쓰지 않는다(PgBouncer)
  assert.doesNotMatch(server, /prisma\.\w+\.(findMany|findFirst|findUnique|create|update|upsert|delete|deleteMany)\(/);
  // 확인 값을 로그에 남기지 않는다
  for (const file of ["src/lib/calendar/feedServer.ts", "src/app/api/calendar/feed/[token]/route.ts", "src/app/actions/calendar-sync.ts"]) {
    for (const line of read(file).split("\n").filter((l) => /console\./.test(l))) {
      assert.doesNotMatch(line, /token|hash|url|request/i, `${file}: ${line.trim()}`);
    }
  }
});

test("개인 일정 주소 라우트: 저장 금지 · 지금 역할로 다시 거르기 · 없으면 모두 404", () => {
  const route = read("src/app/api/calendar/feed/[token]/route.ts");
  assert.match(route, /const NO_STORE = "private, no-store"/);
  assert.match(route, /"Content-Type": "text\/calendar; charset=utf-8"/);
  assert.match(route, /export const dynamic = "force-dynamic"/);
  // 순서: 해시로 찾기 → 지금 역할 → 항목 거르기 → 일정 모으기. 앞 단계가 비면 모두 같은 404
  assert.match(route, /findFeedToken\(token\);\s*if \(!row\) return notFound\(\);[\s\S]*?getFeedAccessForUser\(row\.userId\);\s*if \(!access\) return notFound\(\);\s*const kinds = kindsAllowedNow\(row\.kinds, access\);\s*if \(kinds\.length === 0\) return notFound\(\);[\s\S]*?loadPersonalIcsEvents\(row\.userId, kinds\)/);
  assert.match(route, /new Response\("Not Found", \{ status: 404/);
  // 404 는 한 곳에서만 만든다(이유별로 다른 응답을 주지 않는다) · 403/401 로 «있다»는 걸 알려 주지 않는다
  assert.equal((route.match(/status: 404/g) ?? []).length, 1);
  assert.doesNotMatch(route, /status: 40[13]/);
  // 모든 응답이 저장 금지
  assert.equal((route.match(/"Cache-Control": NO_STORE/g) ?? []).length, 3);

  // 역할 재검증은 탈퇴 계정을 빼고, 승인된(ACTIVE) 추가 역할만 센다
  const server = read("src/lib/calendar/feedServer.ts");
  assert.match(server, /FROM "User" WHERE id = \$1 AND "withdrawnAt" IS NULL/);
  assert.match(server, /FROM "UserRoleGrant" WHERE "userId" = \$1 AND status = 'ACTIVE'/);
  // 아이 수업 = 그 학부모의 아이만 · 병합된 학생 제외 · 수강 중인 반만
  assert.match(server, /e\.status = 'ACTIVE'[\s\S]{0,200}childAccessSql\("s", "\$1"\)\} AND \$\{notMergedStudent\("s"\)\}/);
  // 날짜는 KST 공용 모듈로만
  for (const file of ["src/lib/calendar/feedServer.ts", "src/lib/calendar/feedEvents.ts", "src/lib/calendar/ics.ts"]) {
    assert.doesNotMatch(read(file), /toISOString\(\)\.slice|\.getDay\(\)|\.getDate\(\)|\.getHours\(\)/, file);
  }
});

test("선생님 수업: userId 기준 판정이 화면 문지기(담당 반)와 같은 규칙이다", () => {
  const access = read("src/lib/staff-class-access.ts");
  const condition = /WHERE \(\s*c\."slotKey" IS NOT NULL\s*AND \(\s*ss\."coachId" = \$1\s*OR cso\."coachId" = \$1\s*OR ccs\."coachId" = \$1\s*\)\s*\)\s*OR \(\s*c\."slotKey" IS NULL\s*AND c\."instructorId" = \$2\s*\)/g;
  // getAccessibleClassIds(선생님 갈래)와 getCoachLinkedClassesForUser 두 곳이 같은 조건
  assert.equal((access.match(condition) ?? []).length, 2);
  const fn = access.slice(access.indexOf("export async function getCoachLinkedClassesForUser"));
  // 원장·부원장도 전체 반이 아니라 코치로 연결된 반만 — 이 함수에는 «전체 반» 갈래가 없다
  assert.doesNotMatch(fn, /canAccessAllClasses|SELECT id FROM "Class" ORDER BY id/);
  assert.match(fn, /if \(!coachId\) return \[\];/);
});

test("공개 학원 일정 주소와 서버 기능: 5분 캐시 · 주소는 고정 상수 · 화면이 보낸 항목을 다시 거른다", () => {
  const academy = read("src/app/api/calendar/academy/route.ts");
  assert.match(academy, /"public, max-age=300, s-maxage=300, stale-while-revalidate=600"/);
  assert.match(academy, /status: 503, headers: \{ "Cache-Control": "no-store" \}/, "실패 응답은 캐시하지 않는다");
  assert.match(academy, /"Content-Type": "text\/calendar; charset=utf-8"/);
  assert.doesNotMatch(academy, /requireAuth|requireStaff|findFeedToken/, "로그인 없이 열린다");

  const action = read("src/app/actions/calendar-sync.ts");
  assert.match(action, /^"use server";/);
  // 사이트 주소는 요청 헤더가 아니라 고정 상수
  assert.match(action, /import \{ PUBLIC_SITE_URL \} from "@\/lib\/publicMetadata"/);
  assert.doesNotMatch(action, /headers\(\)|x-forwarded-host|process\.env/);
  assert.match(action, /filterCalendarKinds\(parseCalendarKinds\(kinds\), viewer\.allowed\)/);
  assert.match(action, /calendar\.google\.com\/calendar\/render\?cid=\$\{encodeURIComponent\(webcalUrl\)\}/);
  // 문지기가 던져도 받아 낸다(비로그인도 학원 일정은 연동)
  assert.match(action, /requireStaff\(\)\.catch\(\(\) => null\)/);
  assert.match(action, /getVerifiedParentState\(\)\.catch\(\(\) => null\)/);
});

test("화면: 연동 버튼이 달력 화면에 붙어 있고, 바깥 링크 규칙·화면 안 확인창을 쓴다", () => {
  const button = read("src/components/calendar/CalendarSyncButton.tsx");
  assert.match(button, /^"use client";/);
  assert.match(button, /data-outside-link/);
  assert.match(button, /target="_blank" rel="noopener noreferrer"/);
  assert.match(button, /askConfirm\(/);
  assert.doesNotMatch(button, /window\.confirm|\balert\(/);
  assert.match(button, /이 주소를 아는 사람은 일정을 볼 수 있어요\. 남에게 보내지 마세요\./);
  // 색은 토큰만(직접 색·흰/검정 클래스 금지) · 굵기는 네 단계만
  assert.doesNotMatch(button, /\bbg-(white|black)\b|#[0-9a-fA-F]{3,8}\b|font-(black|extrabold)/);
  // 사용자에게 보이는 글에 개발 용어를 쓰지 않는다
  const visible = [...button.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n").matchAll(/["'`>]([^"'`<>{}]*[가-힣][^"'`<>{}]*)/g)].map((m) => m[1]);
  for (const text of visible) assert.doesNotMatch(text, /토큰|ICS|URL|webcal/i, text);

  assert.match(read("src/app/annual/AnnualEventsClient.tsx"), /<CalendarSyncButton theme="public" \/>/);
  assert.match(read("src/app/mypage/history/page.tsx"), /calendarAction=\{<CalendarSyncButton theme="academy"/);
  assert.match(read("src/app/mypage/history/ScheduleHub.tsx"), /\{calendarAction\}/);
  assert.match(read("src/app/mypage/annual/page.tsx"), /<CalendarSyncButton theme="academy"/);
  assert.match(read("src/app/mypage/classes/ClassesClient.tsx"), /<CalendarSyncButton theme="academy"/);
});

test("마이그레이션: 표·인덱스·브라우저 키 접근 차단, 그리고 schema.prisma 와 같은 칸", () => {
  const sql = read("prisma/migrations/20261116400000_calendar_feed_token/migration.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\."CalendarFeedToken"/);
  for (const column of ['id TEXT PRIMARY KEY', '"userId" TEXT NOT NULL', '"tokenHash" TEXT NOT NULL', 'kinds TEXT NOT NULL', '"createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()', '"lastUsedAt" TIMESTAMPTZ(6)']) {
    assert.ok(sql.includes(column), column);
  }
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "CalendarFeedToken_tokenHash_key"/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "CalendarFeedToken_userId_idx"/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\."CalendarFeedToken" FROM anon, authenticated/);
  assert.match(sql, /DROP TABLE IF EXISTS public\."CalendarFeedToken"/, "되돌림 SQL 을 적어 둔다");
  const schema = read("prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model CalendarFeedToken {"));
  for (const field of ["userId", "tokenHash", "kinds", "createdAt", "lastUsedAt"]) assert.match(model.slice(0, model.indexOf("}")), new RegExp(`\\b${field}\\b`));
});

test("개인 일정의 고유값에 회원·학생 번호 원문을 싣지 않는다(해시 앞부분만)", () => {
  const server = readFileSync("src/lib/calendar/feedServer.ts", "utf8");
  assert.match(server, /uidScope: `teach-\$\{opaqueId\(userId\)\}`/);
  assert.match(server, /uidScope: `child-\$\{opaqueId\(row\.studentId\)\}`/);
  assert.doesNotMatch(server, /uidScope: `(?:teach|child)-\$\{(?:userId|row\.studentId)\}`/);
});
