import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// 학부모 화면 이름 통일 가드 (2026-11-14 원장 결정 d2).
//   결석 알리기 · 셔틀 변경 · 보강 예약 — 같은 기능을 화면마다 다른 이름으로 부르면 학부모가 «다른 기능인가» 하고 헷갈린다.
//   한 번 통일해도 새 화면을 만들 때 옛 이름이 다시 들어온다(문서만으로는 안 지켜진다) → 금지 목록을 테스트로 못박는다.
//
// 보는 것: 학부모 화면(/mypage/**)과 학부모용 부품·학부모에게 그대로 보이는 서버 안내 글.
// 안 보는 것:
//   - 주석(설명 글에는 옛 이름을 적을 수 있다)
//   - 결제 화면(src/app/mypage/payments/**) — 돈 문구는 이번 범위가 아니다
//   - 선생님·관리자·기사 화면, 카카오 대화, 기사님·관리자에게 가는 알림 제목(«셔틀 당일 변경» 등 — 그쪽 문구는 그대로)
//   - 코드 식별자(resumeNotice 의 verb 값 "신고" 같은 한 낱말) — 금지어는 «결석 신고»처럼 화면에 보이는 이름 단위다

const ROOT = process.cwd();

/** 폴더 아래 .ts/.tsx 파일 전부(테스트 파일 제외) */
function walk(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return walk(rel);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [rel] : [];
  });
}

/** 주석을 지운 소스 — 블록 주석(JSX 주석 포함)과 줄 주석. 주소(https://)의 «//»는 건드리지 않는다 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const PARENT_FILES = [
  ...walk("src/app/mypage").filter((file) => !file.startsWith("src/app/mypage/payments/")),
  ...walk("src/components/parent").filter((file) => !file.startsWith("src/components/parent/billing/")),
  "src/components/account/EmptyParentState.tsx",
  "src/lib/parent/classCards.ts",
  "src/lib/requests/parent-timeline.ts",
  "src/lib/requests/parent-timeline-rules.ts",
  // 학부모에게 그대로 보이는 서버 안내 글
  ...walk("src/app/api/mypage/regular-absence"),
  ...walk("src/app/api/mypage/seasonal-absence"),
  ...walk("src/app/api/mypage/shuttle-exception"),
];

// 옛 이름 → 지금 이름
const FORBIDDEN = [
  ["결석 신고", "결석 알리기(이름) · 결석 알림(낸 것)"],
  ["결석 미리 알리기", "결석 알리기"],
  ["결석 미리 신고", "결석 알리기"],
  ["결석 사전 신고", "결석 알리기"],
  ["셔틀 당일 변경", "셔틀 변경"],
  ["이날 안 타요", "셔틀 변경(링크 이름) · 안 타요(고르는 칩)"],
  ["오늘 안 타요", "안 타요"],
];

test("가드가 실제로 학부모 화면을 보고 있다(목록이 비면 아무것도 못 잡는다)", () => {
  assert.ok(PARENT_FILES.length >= 40, `학부모 파일 ${PARENT_FILES.length}개`);
  for (const must of [
    "src/app/mypage/MyPageClient.tsx",
    "src/app/mypage/shuttle/ShuttleExceptionClient.tsx",
    "src/app/mypage/regular-absence/RegularAbsenceClient.tsx",
    "src/app/mypage/seasonal/SeasonalMakeupClient.tsx",
    "src/app/mypage/ParentShuttleDetail.tsx",
    "src/app/mypage/record/ChildProfileSections.tsx",
    "src/app/api/mypage/regular-absence/route.ts",
  ]) assert.ok(PARENT_FILES.includes(must), must);
  assert.ok(!PARENT_FILES.some((file) => file.startsWith("src/app/mypage/payments/")), "결제 화면은 범위 밖");
  // 주석 지우기가 화면 글자까지 지우지 않는다
  assert.equal(withoutComments('const a = "결석 신고"; // 결석 신고\n{/* 결석 신고 */}<p>셔틀 당일 변경</p>').match(/결석 신고|셔틀 당일 변경/g).length, 2);
  assert.match(withoutComments('const url = "https://example.com/a"; // 주석'), /https:\/\/example\.com\/a/);
});

test("학부모 화면에 옛 이름이 다시 들어오지 않는다 — 결석 알리기 · 셔틀 변경", () => {
  const found = [];
  for (const file of PARENT_FILES) {
    const source = withoutComments(fs.readFileSync(path.join(ROOT, file), "utf8"));
    for (const [old, now] of FORBIDDEN) {
      if (source.includes(old)) found.push(`${file}: «${old}» → «${now}»`);
    }
  }
  assert.deepEqual(found, [], "옛 이름이 남아 있다");
});

test("정규 보강은 «보강 예약» — 방학특강만 «보강 신청»(학원 승인 절차가 따로 있다)", () => {
  // 정규 보강 화면·결석 알리기 화면·홈·수업 탭·아이 기록에는 «보강 신청»이 없다
  const regularScreens = [
    ...walk("src/app/mypage/makeup"),
    ...walk("src/app/mypage/regular-absence"),
    ...walk("src/app/mypage/classes"),
    ...walk("src/app/mypage/record"),
    "src/app/mypage/MyPageClient.tsx",
    "src/lib/parent/classCards.ts",
  ];
  for (const file of regularScreens) {
    assert.ok(!withoutComments(fs.readFileSync(path.join(ROOT, file), "utf8")).includes("보강 신청"), `${file}: «보강 신청» → «보강 예약»`);
  }
  // 홈 빠른 실행 이름 = 결석 알리기 · 보강 예약 · 셔틀 변경 · 문의
  const home = fs.readFileSync(path.join(ROOT, "src/app/mypage/MyPageClient.tsx"), "utf8");
  for (const label of ['label: "결석 알리기"', 'label: "보강 예약"', 'label: "셔틀 변경"', ">문의</span>"]) assert.ok(home.includes(label), label);
});

test("학부모용 셔틀 라벨은 따로 둔다 — 관리자·카카오·기사님 알림이 쓰는 라벨은 그대로", () => {
  const rules = fs.readFileSync(path.join(ROOT, "src/lib/shuttle/dayExceptionRules.ts"), "utf8");
  // 공용 라벨(관리자 화면·카카오 대화·기사님 알림 글)은 바꾸지 않았다
  assert.match(rules, /SHUTTLE_DIRECTION_LABEL: Record<ShuttleDirection, string> = \{\s*PICKUP: "등원\(타러 갈 때\)",\s*DROPOFF: "하원\(데려다줄 때\)",/);
  assert.match(rules, /SHUTTLE_EXCEPTION_KIND_LABEL: Record<ShuttleExceptionKind, string> = \{\s*SKIP: "오늘 안 타요",/);
  // 학부모용은 짧게
  assert.match(rules, /PARENT_SHUTTLE_DIRECTION_LABEL: Record<ShuttleDirection, string> = \{\s*PICKUP: "등원",\s*DROPOFF: "하원",/);
  assert.match(rules, /PARENT_SHUTTLE_EXCEPTION_KIND_LABEL: Record<ShuttleExceptionKind, string> = \{\s*SKIP: "안 타요",/);
  // 학부모 화면(셔틀 변경·신청 내역)은 학부모용 라벨만 쓴다
  for (const file of ["src/app/mypage/shuttle/ShuttleExceptionClient.tsx", "src/lib/requests/parent-timeline.ts"]) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.match(source, /PARENT_SHUTTLE_DIRECTION_LABEL/, file);
    assert.doesNotMatch(source, /(?<!PARENT_)SHUTTLE_DIRECTION_LABEL|(?<!PARENT_)SHUTTLE_EXCEPTION_KIND_LABEL/, `${file}: 공용 라벨을 직접 쓰지 않는다`);
  }
  // 관리자 화면은 공용 라벨 그대로
  assert.match(fs.readFileSync(path.join(ROOT, "src/app/admin/shuttle/regular-dispatch/ShuttleDayExceptionAdminPanel.tsx"), "utf8"), /[^_]SHUTTLE_DIRECTION_LABEL\[/);
});
