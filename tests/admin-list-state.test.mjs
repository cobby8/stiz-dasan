// 관리자 목록의 «보던 상태»를 주소에 싣기(2026-11-18 원장 결정 D).
//  원생 목록의 검색어·필터, 출결의 날짜·주, 청구·수납의 달 — 상세에 다녀와 «뒤로»로 돌아오면 보던 그대로.
//  순수 함수는 실제로 실행하고, 화면 연결은 소스 문자열로 못박는다(실제 날짜·시계에 기대는 단정 없음).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const q = await loadTsModule("src/lib/navigation/listQuery.ts");
const hist = await loadTsModule("src/lib/navigation/inAppHistory.ts");
const read = (p) => readFile(p, "utf8");

test("mergeListQuery — 빈 값은 지우고, 있는 값은 넣고, 다른 쿼리는 그대로 둔다", () => {
  assert.equal(q.mergeListQuery("", { q: "김" }), "q=%EA%B9%80");
  assert.equal(q.mergeListQuery("?studentId=abc", { month: "2026-10" }), "studentId=abc&month=2026-10");
  assert.equal(q.mergeListQuery("studentId=abc&month=2026-10", { month: null }), "studentId=abc");
  assert.equal(q.mergeListQuery("q=a&status=PAUSED", { q: "", status: undefined }), "");
  // 있던 값은 제자리에서 바뀐다(순서 유지)
  assert.equal(q.mergeListQuery("q=a&class=c1", { q: "b" }), "q=b&class=c1");
  // 같은 입력은 같은 결과 — 두 번 적어도 주소가 더 바뀌지 않는다
  const once = q.mergeListQuery("", { q: "a b", status: "ALL" });
  assert.equal(q.mergeListQuery(once, { q: "a b", status: "ALL" }), once);
  assert.equal(q.listHref("/admin/students", ""), "/admin/students");
  assert.equal(q.listHref("/admin/students", "q=a"), "/admin/students?q=a");
});

test("주소에서 읽는 값은 그대로 믿지 않는다 — 허용 목록·길이·달 모양", () => {
  assert.equal(q.pickListValue("PAUSED", ["ACTIVE", "PAUSED"], "ACTIVE"), "PAUSED");
  assert.equal(q.pickListValue("<script>", ["ACTIVE", "PAUSED"], "ACTIVE"), "ACTIVE");
  assert.equal(q.pickListValue(null, ["ACTIVE"], "ACTIVE"), "ACTIVE");
  assert.equal(q.readListText(null), "");
  assert.equal(q.readListText("김민"), "김민");
  assert.equal(q.readListText("x".repeat(500)).length, 100);
  assert.deepEqual(q.parseYearMonth("2026-10"), { year: 2026, month: 10 });
  assert.deepEqual(q.parseYearMonth("2027-01"), { year: 2027, month: 1 });
  for (const bad of [null, undefined, "", "2026-13", "2026-00", "2026-1", "26-10", "2026-10-01", "1999-10", "2099-10", "abcd-ef"]) {
    assert.equal(q.parseYearMonth(bad), null, String(bad));
  }
  assert.equal(q.formatYearMonth(2026, 3), "2026-03");
  assert.equal(q.formatYearMonth(2026, 12), "2026-12");
  // 읽은 달을 다시 적으면 같은 글자
  assert.equal(q.formatYearMonth(...Object.values(q.parseYearMonth("2026-07"))), "2026-07");
});

function fakeWindow(href) {
  const url = new URL(href, "https://stiz.example");
  const calls = [];
  // Next 가 넣어 둔 내부 값 + 우리 표시(창 닫기 칸·수업 가드)
  const state = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ["", {}] }, stizOverlay: "o1", staffSessionGuardBase: "g1" };
  globalThis.window = {
    location: { pathname: url.pathname, search: url.search, hash: url.hash },
    history: {
      state,
      replaceState(s, _title, next) {
        calls.push({ state: s, url: next });
        const moved = new URL(next, "https://stiz.example");
        globalThis.window.location = { pathname: moved.pathname, search: moved.search, hash: moved.hash };
      },
      pushState() { throw new Error("기록을 쌓으면 안 된다"); },
    },
  };
  return { calls, state };
}

test("N-2 — 주소를 바꿀 때 넘기는 state 에서 Next 내부 키만 뺀다(우리 키는 남는다·원본은 그대로)", () => {
  assert.deepEqual([...q.NEXT_INTERNAL_STATE_KEYS], ["__NA", "__PRIVATE_NEXTJS_INTERNALS_TREE", "_N"]);
  const original = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: [] }, _N: true, stizOverlay: "o1", staffSessionGuardBase: "g1", idx: 3 };
  const frozen = Object.freeze({ ...original });
  assert.deepEqual(q.withoutNextInternalState(frozen), { stizOverlay: "o1", staffSessionGuardBase: "g1", idx: 3 });
  assert.deepEqual(frozen, original, "원본을 바꾸지 않는다");
  // 객체가 아니면 빈 객체(절대 throw 하지 않는다)
  for (const odd of [null, undefined, "x", 3, true, []]) assert.deepEqual(q.withoutNextInternalState(odd), {});

  try {
    const { calls, state } = fakeWindow("/admin/inbox");
    q.replaceUrlSyncingNext("/admin/inbox?tab=TRIAL");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/admin/inbox?tab=TRIAL");
    // __NA 가 실려 가면 Next 의 replaceState 가 «자기 호출»로 보고 주소 동기화를 건너뛴다(app-router.js) — 반드시 빠져야 한다
    assert.equal("__NA" in calls[0].state, false);
    assert.equal("__PRIVATE_NEXTJS_INTERNALS_TREE" in calls[0].state, false);
    assert.equal(calls[0].state.stizOverlay, "o1", "창 닫기 표시는 남는다");
    assert.equal(calls[0].state.staffSessionGuardBase, "g1", "수업 가드 표시는 남는다");
    assert.notEqual(calls[0].state, state, "history.state 객체를 그대로 넘기지 않는다");
    assert.equal(state.__NA, true, "지금 state 는 건드리지 않는다");
  } finally {
    delete globalThis.window;
  }
});

test("N-2 — 주소를 손으로 바꾸는 세 곳은 공용 함수 하나만 쓴다(history.state 를 그대로 넘기는 호출이 없다)", async () => {
  const lib = await read("src/lib/navigation/listQuery.ts");
  assert.match(lib, /window\.history\.replaceState\(withoutNextInternalState\(window\.history\.state\), "", url\);/);
  assert.equal((lib.match(/window\.history\.replaceState\(/g) || []).length, 1);
  for (const file of ["src/app/staff/shuttle/NoRunNotice.tsx", "src/app/admin/inbox/InboxClient.tsx"]) {
    const src = await read(file);
    assert.match(src, /replaceUrlSyncingNext\(/, file);
    assert.doesNotMatch(src, /window\.history\.replaceState\(/, file);
  }
  assert.match(await read("src/app/admin/inbox/InboxClient.tsx"), /replaceUrlSyncingNext\(`\$\{pathname\}\?\$\{params\}`\);/);
});

test("replaceListQuery — 지금 칸의 주소만 바꾼다(기록을 쌓지 않고, Next 내부 키를 뺀 state 로 부른다)", () => {
  try {
    const { calls, state } = fakeWindow("/admin/students");
    q.replaceListQuery({ q: "김", status: "PAUSED" }, "/admin/students");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/admin/students?q=%EA%B9%80&status=PAUSED");
    assert.deepEqual(calls[0].state, { stizOverlay: "o1", staffSessionGuardBase: "g1" }, "Next 내부 키는 빼고(Next 가 다시 붙인다) 우리 키는 남긴다");
    assert.equal(state.__NA, true);
    // 바뀐 것이 없으면 다시 쓰지 않는다
    q.replaceListQuery({ q: "김", status: "PAUSED" }, "/admin/students");
    assert.equal(calls.length, 1);
    // 기본값으로 돌아가면 쿼리가 사라진다
    q.replaceListQuery({ q: "", status: null }, "/admin/students");
    assert.equal(calls.at(-1).url, "/admin/students");

    // 화면을 이미 떠났으면(다른 경로) 그 화면의 주소를 고치지 않는다
    const other = fakeWindow("/admin/students/7");
    q.replaceListQuery({ q: "김" }, "/admin/students");
    assert.equal(other.calls.length, 0);

    // 다른 쿼리와 해시는 그대로
    const kept = fakeWindow("/admin/finance?studentId=s1#top");
    q.replaceListQuery({ month: "2026-10" }, "/admin/finance");
    assert.equal(kept.calls[0].url, "/admin/finance?studentId=s1&month=2026-10#top");
  } finally {
    delete globalThis.window;
  }
  // 서버(창 없음)에서는 아무 일도 하지 않는다
  assert.doesNotThrow(() => q.replaceListQuery({ q: "a" }));
});

test("주소의 쿼리만 바뀌면 관리자 이동 기록은 쌓이지 않는다 — 상세 → «뒤로» = 쿼리가 실린 목록", () => {
  // 목록 → (필터를 걸어 주소가 바뀜) → 상세 → 뒤로
  const walk = (...entries) => entries.reduce((stack, e) => hist.nextScopeHistory(stack, e), []);
  assert.deepEqual(
    walk("/admin", "/admin/students", "/admin/students?q=%EA%B9%80", "/admin/students?q=%EA%B9%80&status=PAUSED"),
    ["/admin", "/admin/students?q=%EA%B9%80&status=PAUSED"],
  );
  assert.deepEqual(
    walk("/admin", "/admin/students?status=PAUSED", "/admin/students/7", "/admin/students?status=PAUSED"),
    ["/admin", "/admin/students?status=PAUSED"],
  );
});

test("원생 목록 — 검색어·반·학년·학교·수강 상태를 주소에서 읽고, 바뀌면 주소에 적는다", async () => {
  const src = await read("src/app/admin/students/StudentManagementClient.tsx");
  assert.match(src, /const listQuery = useSearchParams\(\);/);
  assert.match(src, /const \[search, setSearch\] = useState\(\(\) => readListText\(listQuery\.get\("q"\)\)\);/);
  for (const [state, key] of [["filterClass", "class"], ["filterGrade", "grade"], ["filterSchool", "school"]]) {
    assert.ok(src.includes(`useState(() => readListText(listQuery.get("${key}")));`), `${state} ← ?${key}=`);
  }
  // 수강 상태: 쿼리 없음 = 기본값(활성), 화면의 ""(전체)은 주소에서 ALL — 둘을 구분한다. 모르는 값은 기본값
  assert.match(src, /const STATUS_QUERY_ALL = "ALL";/);
  assert.match(src, /pickListValue\(listQuery\.get\("status"\), STATUS_QUERY_VALUES, DEFAULT_STATUS_FILTER\)/);
  assert.match(src, /return fromUrl === STATUS_QUERY_ALL \? "" : fromUrl;/);
  assert.match(src, /status: filterStatus === DEFAULT_STATUS_FILTER \? null : filterStatus === "" \? STATUS_QUERY_ALL : filterStatus,/);
  assert.match(src, /replaceListQuery\(\{\s*q: search,\s*class: filterClass,\s*grade: filterGrade,\s*school: filterSchool,[\s\S]{0,200}\}, STUDENTS_PATH\);\s*\}, \[search, filterClass, filterGrade, filterSchool, filterStatus\]\);/);
  // 필터를 바꿀 때 기록을 쌓거나 서버를 다시 부르지 않는다
  assert.doesNotMatch(src, /router\.(push|replace)\(/);
  // 상세에서 돌아오는 링크는 기록 우선(history.back) — 쿼리가 실린 목록 칸으로 돌아온다
  const detail = await read("src/app/admin/students/[id]/StudentDetailClient.tsx");
  assert.match(detail, /<ScopeBackLink fallbackHref="\/admin\/students"/);
});

test("출결 — 보던 날짜(?day=)·주(?week=)를 주소에서 읽고 적는다. 대시보드의 ?date=&lesson= 은 건드리지 않는다", async () => {
  const src = await read("src/app/admin/attendance/AttendanceClient.tsx");
  // 날짜는 실제 달력 날짜 + 볼 수 있는 기간 안일 때만(공용 KST 모듈)
  assert.match(src, /return raw !== null && isKstYmd\(raw\) && raw >= WEEK_MIN_YMD && raw <= WEEK_MAX_YMD \? raw : null;/);
  assert.match(src, /const \[keptDay\] = useState\(\(\) => readKeptYmd\(keptQuery\.get\("day"\)\)\);/);
  assert.match(src, /const \[keptWeek\] = useState\(\(\) => readKeptYmd\(keptQuery\.get\("week"\)\)\);/);
  assert.match(src, /const \[date, setDate\] = useState\(startDate\);/);
  assert.match(src, /useState\(\(\) => \(keptWeek \? mondayOf\(keptWeek\) : mondayOf\(startDate\)\)\);/);
  // 서버가 넘긴 목록은 기본 날짜 것 — 보던 날짜가 다르면 쓰지 않고(그날 수업도 열지 않고) 새로 받는다
  assert.match(src, /const serverListFits = initialClasses !== undefined && startDate === baseDate;/);
  assert.match(src, /if \(!serverListFits\) return "";/);
  assert.match(src, /useState<ClassItem\[\]>\(serverListFits \? initialClasses \?\? \[\] : \[\]\);/);
  assert.match(src, /const skipFirstClassesLoadRef = useRef\(hasInitialClasses\);/);
  // 적는 쪽: 기본값은 적지 않는다
  assert.match(src, /day: date === baseDate \? null : readKeptYmd\(date\),\s*week: weekStart === mondayOf\(date\) \? null : readKeptYmd\(weekStart\),\s*\}, ATTENDANCE_PATH\);/);
  // 금지 패턴 없음
  assert.doesNotMatch(src, /toISOString\(\)\.slice\(0, ?10\)/);
  // 서버 쪽(화면을 새로 시작하는 key)은 ?date=&lesson= 만 본다 — day·week 를 key 에 넣으면 저장할 때마다 화면이 새로 시작된다
  const page = await read("src/app/admin/attendance/page.tsx");
  assert.doesNotMatch(page, /\bday\b|\bweek\b/);
});

test("청구·수납 — 보던 달(?month=)·검색어·필터를 주소에서 읽고 적는다. 달이 다르면 서버가 준 이번 달 목록을 쓰지 않는다", async () => {
  const src = await read("src/app/admin/finance/FinanceClient.tsx");
  assert.match(src, /const \[keptMonth\] = useState\(\(\) => parseYearMonth\(searchParams\.get\("month"\)\)\);/);
  assert.match(src, /const hasInitialData = Boolean\(initialPayments && initialSummary\) && \(keptMonth === null \|\| \(keptMonth\.year === initialYear && keptMonth\.month === initialMonth\)\);/);
  assert.match(src, /const \[payments, setPayments\] = useState\(hasInitialData \? initialPayments \?\? \[\] : \[\]\);/);
  assert.match(src, /const \[summary, setSummary\] = useState\(hasInitialData \? initialSummary \?\? EMPTY_SUMMARY : EMPTY_SUMMARY\);/);
  assert.match(src, /const \[year, setYear\] = useState\(startYear\);\s*const \[month, setMonth\] = useState\(startMonth\);/);
  assert.match(src, /if \(hasInitialData\) return;[\s\S]{0,120}void loadMonth\(startYear, startMonth\);/);
  assert.match(src, /month: year === initialYear && month === initialMonth \? null : formatYearMonth\(year, month\),\s*q: paymentSearch,\s*status: paymentStatusFilter,\s*class: paymentClassFilter,\s*\}, FINANCE_PATH\);/);
  // 납부 상태는 허용 값만(칩 5종 + 미납·연체)
  assert.match(src, /const PAYMENT_STATUS_QUERY_VALUES: readonly string\[\] = \[\.\.\.PAYMENT_STATUS_ORDER, "UNPAID"\];/);
  assert.match(src, /pickListValue\(searchParams\.get\("status"\), PAYMENT_STATUS_QUERY_VALUES, ""\)/);
  // 원생 상세에서 넘어오는 ?studentId= 는 그대로 읽는다
  assert.match(src, /useState\(searchParams\.get\("studentId"\) \?\? ""\)/);

  // 청구 준비: 달을 바꾸면 주소에도 적는다. «청구·수납으로»는 달을 싣지 않는다 — 수납 화면은 «뒤로»로 돌아갈 때만 보던 달이고,
  // 이 링크로 가면 준비 화면의 달(기본이 다음 달일 수 있다)로 열려 «보던 그대로»와 어긋난다(2026-11-18 검수)
  const prep = await read("src/app/admin/finance/prepare/BillingWorkbench.tsx");
  assert.match(prep, /if \(!initialMonth && month === defaultMonth\) return;\s*replaceListQuery\(\{ month \}, "\/admin\/finance\/prepare"\);/);
  assert.match(prep, /<Link href="\/admin\/finance" className=\{styles\.muted\}>청구·수납으로<\/Link>/);
  assert.doesNotMatch(prep, /\/admin\/finance\?month=/);
});
