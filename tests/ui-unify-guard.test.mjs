import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// UI 통일 가드 (2026-11-13 원장 «UI가 개발 단계처럼 어설프다 · 흑백이다 · 아이콘 빼자 · 글자가 두껍다»)
// 규칙 문서만으로는 안 지켜져서(실측: 공용 버튼 등급을 만들고도 관리자 화면 사용률 15%) 숫자로 막는다.
// 아래 «빚» 숫자는 지금 남아 있는 옛 방식의 개수다. 화면을 고칠 때마다 줄이고, 줄였으면 이 숫자도 같이 내린다.
// 🚫 숫자를 올려서 통과시키지 마라 — 새 코드는 공용 부품(academy-button-*, AdminPageHeader)을 쓰면 늘지 않는다.

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const count = (dirs, re) =>
  dirs.flatMap((d) => walk(d)).reduce((n, f) => n + (readFileSync(f, "utf8").match(re) || []).length, 0);

// 학원 앱(관리자·학부모·선생님) 화면과 그 공용 부품
const ACADEMY_DIRS = [
  "src/app/admin",
  "src/app/mypage",
  "src/app/staff",
  "src/app/driver",
  "src/components/admin",
  "src/components/parent",
  "src/components/staff",
  "src/components/academy",
  "src/components/shuttle",
];

// 갚아야 할 빚(2026-11-13 1단계 시점 804·645·54 → 2단계 «원생» 화면 정리 뒤 766·612·51). 줄어들기만 해야 한다.
// 이력: 1단계 804·645·54 → 2단계(원생) 766·612·51 → 전 화면 정리 뒤 0·127·6 (2026-11-13).
// 남은 아이콘 = 닫기·뒤로·펼침·정렬·끌기 손잡이·지도/GPS·출결 상태처럼 글자를 둘 자리가 없거나 뜻을 전하는 기호.
const DEBT = {
  heavyWeight: 0, // font-black · font-extrabold · font-[800] · fontWeight: 800 — 화면에서는 테마가 700 으로 낮춰 그리지만 코드에서도 걷어낸다
  // icons 칸은 2026-11-15 에 없앴다 — 개수 대신 «허용된 아이콘만 쓴다»로 막는다(아래 ICON_RULE)
  adminRawH1: 6, // 관리자 화면의 직접 쓴 <h1> — AdminPageHeader 로 옮긴다
};

test("굵은 글자(font-black·font-extrabold)가 늘지 않는다", () => {
  const n = count(ACADEMY_DIRS, /\bfont-(black|extrabold)\b|\bfont-\[[89]00\]|fontWeight:\s*[89]00/g);
  assert.ok(n <= DEBT.heavyWeight, `font-black/extrabold ${n}개 — 기준 ${DEBT.heavyWeight}개보다 늘었다. 굵기는 400·500·600·700 네 단계만 쓴다.`);
});

// ── 아이콘: «허용된 것만 쓴다» (2026-11-15 원장 지정 예외) ─────────────────────────────
// 이 사이트는 «아이콘 없이 글자»가 원칙이고, 예외는 넷뿐이다: 펼침 화살표 · 알림 종 · 설정 톱니 · «빠른작업» ⚡.
// 앞의 셋은 공용 부품 UiIcon 하나로만 그린다(이름 5종). 선생님 화면(src/app/staff)도 같은 부품을 쓴다.
const ICON_RULE = "2026-11-15 원장 지정 예외: 펼침 화살표·알림 종·설정 톱니·⚡. 그 밖에는 아이콘을 넣지 않는다(닫기·뒤로·삭제·로그아웃·메뉴는 글자).";
const UI_ICON_FILE = "src/components/common/UiIcon.tsx";
const ALLOWED_ICON_NAMES = ["expand_less", "expand_more", "notifications", "notifications_off", "settings"];
// 아이콘 글꼴을 직접 써도 되는 파일 — 화면에 보이는 것은 공용 부품과 ⚡ 버튼 둘뿐이다.
// 나머지는 «아이콘을 그리는 화면»이 아니라서 사유와 함께 적어 둔다. 🚫 화면 파일을 여기에 넣어 통과시키지 마라.
const RAW_ICON_FILES = new Map([
  [UI_ICON_FILE, "허용 아이콘 5종을 그리는 공용 부품"],
  ["src/components/admin/AdminQuickActionMenu.tsx", "관리자 «빠른작업» ⚡ — 원장 지정 예외"],
  ["src/components/DeferredFontStyles.tsx", "아이콘을 그리지 않는다 — 화면에 아이콘이 있는지 찾아 글꼴을 불러오는 코드(선택자 문자열)"],
  ["src/components/builder/nodes/DynamicWidgets.tsx", "홈페이지 편집기 부품 — 지금 쓰지 않는 코드(되살릴 때 글자로 바꾼다)"],
  ["src/components/builder/nodes/ImageNode.tsx", "홈페이지 편집기 부품 — 지금 쓰지 않는 코드(되살릴 때 글자로 바꾼다)"],
]);
// 폴더째 허용: 인스타그램 게시물 «미리보기 모형» — 인스타 화면을 흉내 낸 그림이라 그쪽 아이콘(하트·댓글 등)을 그대로 둔다
const RAW_ICON_DIRS = ["src/components/instagram/"];
// 검사 범위 = src 전체(공개 화면·학부모·관리자·기사·선생님·공용 부품)
const ICON_SCAN_DIRS = ["src"];
const posix = (p) => p.replaceAll("\\", "/");

/** 소스에서 <UiIcon … name=…> 의 이름 값들을 꺼낸다. 글자 값이 아니면(변수 등) "?" 를 넣어 실패하게 한다 */
function uiIconNames(source) {
  const names = [];
  for (const tag of source.matchAll(/<UiIcon\b[^>]*?\/>/gs)) {
    const attr = tag[0].match(/\bname=(?:"([^"]*)"|\{([^}]*)\})/);
    if (!attr) { names.push("?"); continue; }
    if (attr[1] !== undefined) { names.push(attr[1]); continue; }
    // name={조건 ? "a" : "b"} — 중괄호 안의 글자 값을 전부 본다. 글자 값이 하나도 없으면 무엇이 그려질지 알 수 없다
    const literals = [...attr[2].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    names.push(...(literals.length ? literals : ["?"]));
  }
  return names;
}

test("아이콘 글꼴은 공용 부품(UiIcon)과 ⚡ 버튼에서만 직접 쓴다 — 메뉴·버튼·탭은 글자로 말한다", () => {
  const found = [];
  for (const file of ICON_SCAN_DIRS.flatMap((d) => walk(d)).map(posix)) {
    if (RAW_ICON_FILES.has(file) || RAW_ICON_DIRS.some((dir) => file.startsWith(dir))) continue;
    const n = (readFileSync(file, "utf8").match(/material-symbols-outlined|<FontFreeIcon\b|<SymbolIcon\b/g) || []).length;
    if (n) found.push(`${file} (${n})`);
  }
  assert.deepEqual(found, [], `아이콘 글꼴을 직접 쓴 파일:\n${found.join("\n")}\n${ICON_RULE} 허용된 아이콘은 UiIcon 부품으로 그린다.`);
  // ⚡ 버튼은 지금처럼 한 곳
  const quick = readFileSync("src/components/admin/AdminQuickActionMenu.tsx", "utf8");
  assert.equal((quick.match(/material-symbols-outlined/g) || []).length, 1, `«빠른작업» 아이콘은 ⚡ 하나다. ${ICON_RULE}`);
});

test("UiIcon 의 이름은 허용 5종뿐이다 — 타입과 모든 사용처(선생님 화면 포함)", () => {
  const source = readFileSync(UI_ICON_FILE, "utf8");
  const union = source.match(/export type UiIconName =([^;]+);/)?.[1] ?? "";
  const typed = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(typed, ALLOWED_ICON_NAMES, `UiIconName 이 허용 5종과 다르다. ${ICON_RULE}`);
  assert.match(source, /aria-hidden="true"/, "아이콘은 보여 주기만 한다 — 이름은 글자나 aria-label 이 준다");
  assert.match(source, /name: UiIconName;/, "이름은 타입으로 제한한다(아무 글자나 받지 않는다)");
  // 사용처: src 전체(공개 화면·학부모·관리자·기사·선생님)
  const bad = [];
  let uses = 0;
  for (const file of walk("src").map(posix)) {
    if (file === UI_ICON_FILE) continue;
    for (const name of uiIconNames(readFileSync(file, "utf8"))) {
      uses += 1;
      if (!ALLOWED_ICON_NAMES.includes(name)) bad.push(`${file}: name="${name}"`);
    }
  }
  assert.ok(uses > 0, "UiIcon 사용처를 하나도 못 찾았다 — 검사식이 깨졌다");
  assert.deepEqual(bad, [], `허용되지 않은 아이콘 이름:\n${bad.join("\n")}\n${ICON_RULE}`);
});

test("가드 자체 확인 — UiIcon 이름 꺼내기(글자 값·조건식·변수)", () => {
  assert.deepEqual(uiIconNames(`<UiIcon name="settings" size={24} />`), ["settings"]);
  assert.deepEqual(uiIconNames(`<UiIcon name={open ? "expand_less" : "expand_more"} />`), ["expand_less", "expand_more"]);
  assert.deepEqual(uiIconNames(`<UiIcon\n  name="home"\n/>`), ["home"], "허용 밖 이름도 그대로 꺼내 실패시킨다");
  assert.deepEqual(uiIconNames(`<UiIcon name={icon} />`), ["?"], "변수로 넘기면 무엇이 그려질지 몰라 실패시킨다");
  assert.deepEqual(uiIconNames(`<UiIcon size={24} />`), ["?"]);
});

test("펼침·알림·설정 버튼은 아이콘만 있어도 이름이 있다 (2026-11-15 아이콘 예외)", () => {
  // 글자가 없는 버튼 = aria-label 로 이름을 준다. 누르는 영역은 44px
  const parentLayout = readFileSync("src/app/mypage/layout.tsx", "utf8");
  assert.match(parentLayout, /aria-label="설정"[\s\S]{0,200}?className="inline-flex size-11[\s\S]{0,300}?<UiIcon name="settings" size=\{24\} \/>/);
  const parentBell = readFileSync("src/app/mypage/ParentNotificationBell.tsx", "utf8");
  assert.match(parentBell, /aria-label=\{badge \? `알림, 안 읽은 알림 \$\{unreadCount\}건` : "알림"\}[\s\S]{0,500}?min-h-11 min-w-11[\s\S]{0,400}?<UiIcon name="notifications" size=\{24\} \/>/);
  const adminBell = readFileSync("src/app/admin/AdminNotificationBell.tsx", "utf8");
  assert.match(adminBell, /min-h-11! min-w-11![\s\S]{0,200}?aria-label=\{unreadCount > 0 \? `알림, 안 읽은 알림 \$\{unreadCount\}건` : "알림"\}[\s\S]{0,120}?<UiIcon name="notifications" size=\{24\} \/>/);
  const staffPush = readFileSync("src/components/push/StaffPushControls.tsx", "utf8");
  assert.match(staffPush, /const stateLabel = pushEnabled \? "휴대폰 알림 켜짐" : "휴대폰 알림 꺼짐 — 누르면 켜기";/, "이름은 스위치 상태를 말한다");
  assert.match(staffPush, /role="switch"\s*aria-checked=\{pushEnabled\}\s*aria-label=\{stateLabel\}[\s\S]{0,200}?title=\{stateLabel\}/, "이름과 툴팁은 같은 문장");
  assert.match(staffPush, /size-11[\s\S]{0,400}?<UiIcon name=\{pushEnabled \? "notifications" : "notifications_off"\} size=\{24\} \/>/, "꺼짐은 모양이 다른 종 — 색만으로 알리지 않는다");
  const inbox = readFileSync("src/app/admin/inbox/InboxClient.tsx", "utf8");
  assert.match(inbox, /href="\/admin\/inbox\/settings"[^>]*min-h-11! min-w-11![^>]*aria-label="신청 설정\([^"]+\)"[^>]*>\s*\{\/\*[^*]*\*\/\}\s*<UiIcon name="settings" size=\{24\} \/>/);
  // 글자만 있던 펼침 버튼(약관) = 아이콘 + «○○ 펼치기/접기» 이름 + aria-expanded
  const terms = readFileSync("src/app/apply/enroll/EnrollApplicationLaterSteps.tsx", "utf8");
  assert.match(terms, /aria-expanded=\{isOpen\} aria-label=\{`\$\{title\} \$\{isOpen \? "접기" : "펼치기"\}`\} className="flex size-11/);
  // 접힘 = expand_more, 펼침 = expand_less (거꾸로 쓰지 않는다)
  for (const file of walk("src").map(posix)) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /\? "expand_more" : "expand_less"/, `${file}: 펼친 상태가 expand_less(위 화살표)다 — 조건을 «펼쳤는가»로 쓴다`);
  }
});

test("관리자 화면에 직접 쓴 <h1> 이 늘지 않는다 — AdminPageHeader 를 쓴다", () => {
  const n = count(["src/app/admin"], /<h1\b/g);
  assert.ok(n <= DEBT.adminRawH1, `관리자 <h1> ${n}개 — 기준 ${DEBT.adminRawH1}개보다 늘었다.`);
});

test("관리자 옆 메뉴 항목은 아이콘 없이 글자만(묶음 펼침 화살표만 예외), 지금 있는 메뉴는 보조 색으로 표시한다", () => {
  const shell = readFileSync("src/app/admin/AdminShellClient.tsx", "utf8");
  assert.doesNotMatch(shell, /material-symbols-outlined/, "옆 메뉴에 아이콘 글꼴이 다시 들어갔다");
  assert.doesNotMatch(shell, /NAV_SYMBOLS/, "이모지→아이콘 표가 다시 생겼다");
  const navItem = shell.slice(shell.indexOf("function NavItem"));
  assert.match(navItem, /color-academy-secondary-soft/, "활성 메뉴 바탕은 보조 색(하늘색)이다");
  assert.match(navItem, /aria-current=\{active \? "page" : undefined\}/, "색만으로 알리지 않는다 — aria-current 를 유지한다");
});

test("테마가 굵기 네 단계와 주 색·보조 색을 정한다", () => {
  const css = readFileSync("src/app/academy-theme.css", "utf8");
  // Tailwind v4 는 font-bold 등을 var(--font-weight-*) 로 그린다 — .academy-app 안에서 이 변수를 낮춰 한 번에 가볍게 한다
  for (const [name, value] of [["medium", 500], ["semibold", 600], ["bold", 600], ["extrabold", 700], ["black", 700]]) {
    assert.match(css, new RegExp(`--font-weight-${name}:\\s*${value};`), `--font-weight-${name} 은 ${value} 여야 한다`);
  }
  // 테마 파일 자체에도 700 보다 굵은 값을 두지 않는다
  const heavier = [...css.matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1])).filter((w) => w > 700);
  assert.deepEqual(heavier, [], `700 보다 굵은 font-weight: ${heavier.join(", ")}`);
  for (const token of ["secondary", "secondary-strong", "secondary-soft", "secondary-ink"]) {
    assert.match(css, new RegExp(`--color-academy-${token}:\\s*#[0-9a-f]{6};`), `--color-academy-${token} 토큰이 없다`);
  }
  // 고른 칩은 보조 색 — 꽉 찬 주 색은 주 버튼만
  const choice = css.slice(css.indexOf('.academy-choice[aria-pressed="true"]'));
  assert.match(choice.slice(0, 400), /border: 2px solid var\(--color-academy-secondary-strong\)/);
});

test("학원 앱 CSS(전역·모듈)에 700 보다 굵은 글자를 숫자로 박지 않는다", () => {
  // 테마 변수 덮어쓰기는 font-* 클래스에만 닿는다 — 숫자로 직접 적은 굵기는 여기서 막는다
  const files = [
    "src/app/admin/finance/prepare/workbench.module.css",
    "src/components/shuttle/DriverWorkspace.module.css",
    "src/components/shuttle/DriverGpsIndicator.module.css",
  ];
  for (const file of files) {
    const heavier = [...readFileSync(file, "utf8").matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1])).filter((w) => w > 700);
    assert.deepEqual(heavier, [], `${file}: 700 보다 굵은 font-weight ${heavier.join(", ")}`);
  }
  const globals = readFileSync("src/app/globals.css", "utf8");
  assert.match(globals, /\.admin-table-scope th \{[^}]*font-weight:\s*600/, "관리자 표 머리글은 600(옛 900)");
});

test("보기 전환의 고른 칸은 옅은 바탕만이 아니라 테두리로도 구분된다", () => {
  const toggle = readFileSync("src/components/admin/list/ListViewToggle.tsx", "utf8");
  assert.match(toggle, /aria-pressed=\{selected\}/);
  assert.match(toggle, /ring-1 ring-inset ring-\[var\(--color-academy-secondary-strong\)\]/);
});

test("페이지 머리말 부품이 제목 모양 한 곳(.academy-page-title)을 쓴다", () => {
  const header = readFileSync("src/components/admin/AdminPageHeader.tsx", "utf8");
  assert.match(header, /<h1 className="academy-page-title">/);
  assert.doesNotMatch(header, /font-(black|extrabold|bold)/, "굵기는 테마 클래스가 정한다");
  const css = readFileSync("src/app/academy-theme.css", "utf8");
  assert.match(css, /\.academy-app \.academy-page-title \{[^}]*font-weight: 700;/);
  assert.match(css, /\.academy-app \.academy-button-sm \{[^}]*min-height: 2\.25rem;/);
  assert.match(css, /@media \(any-pointer: coarse\) \{\s*\.academy-app \.academy-button-sm \{ min-height: 2\.75rem; \}/, "터치 화면에서는 작은 버튼도 44px");
});
