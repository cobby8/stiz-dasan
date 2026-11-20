import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 2026-11-20 원장 승인 — 수업이 «끝난 줄 알았는데 진행 중»으로 남아 다음 날 다른 수업 시작을 막은 사건.
//   ① 막힌 자리에서 «그 수업 종료하기»  ② 늦은 종료는 리포트 발행 기본 끔 + 종료 거부를 서버 기록에
//   ③ 종료 버튼이 말없이 무시되지 않게
// 판정은 순수 함수(staff-session-rules)로 실행해 보고, 화면·서버가 그 함수를 실제로 쓰는지는 소스로 못박는다.
// 날짜는 전부 인자로 넣는다(실제 시계를 보지 않는다).
const rules = await loadTsModule("src/lib/staff-session-rules.ts");

const actions = readFileSync("src/app/actions/staff-sessions.ts", "utf8");
const home = readFileSync("src/app/staff/StaffHomeClient.tsx", "utf8");
const seasonal = readFileSync("src/app/staff/seasonal/StaffSeasonalClient.tsx", "utf8");
const workspace = readFileSync("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx", "utf8");
const dialog = readFileSync("src/components/staff/BlockingSessionDialog.tsx", "utf8");

/** (export) async function <name> 부터 그 함수가 끝나는 줄까지 — 파일 안 본체(export 없음)도 찾는다 */
function functionBody(source, name) {
  let start = source.indexOf(`export async function ${name}`);
  if (start < 0) start = source.indexOf(`\nasync function ${name}(`);
  assert.ok(start >= 0, `${name} 를 찾아야 한다`);
  const end = source.slice(start).search(/\r?\n\}\r?\n/);
  return source.slice(start, start + end);
}

// ── ② 늦은 종료의 발행 판정 ─────────────────────────────────────────

test("오늘 수업: 화면이 끄지 않았으면 발행한다(값이 없어도 발행 — 기존 규칙 그대로)", () => {
  const today = { sessionYmd: "2026-11-20", todayYmd: "2026-11-20" };
  assert.equal(rules.shouldPublishOnComplete({ ...today, publishReport: true }), true);
  assert.equal(rules.shouldPublishOnComplete({ ...today }), true);
  assert.equal(rules.shouldPublishOnComplete({ ...today, publishReport: false }), false);
});

test("지난 날짜 수업(늦은 종료): 화면이 «보내기»를 켰을 때만 발행한다", () => {
  const late = { sessionYmd: "2026-11-19", todayYmd: "2026-11-20" };
  assert.equal(rules.shouldPublishOnComplete({ ...late }), false, "값이 없으면 발행하지 않는다");
  assert.equal(rules.shouldPublishOnComplete({ ...late, publishReport: false }), false);
  assert.equal(rules.shouldPublishOnComplete({ ...late, publishReport: true }), true, "선생님이 켜면 발행된다");
});

test("늦은 종료 판정의 경계: 월말·연말·윤년, 날짜 뒤에 시각이 붙은 값", () => {
  // 월말 → 다음 달 1일
  assert.equal(rules.shouldPublishOnComplete({ sessionYmd: "2026-11-30", todayYmd: "2026-12-01" }), false);
  // 연말 → 새해 첫날
  assert.equal(rules.shouldPublishOnComplete({ sessionYmd: "2026-12-31", todayYmd: "2027-01-01" }), false);
  // 윤년 2월 29일 → 3월 1일
  assert.equal(rules.shouldPublishOnComplete({ sessionYmd: "2028-02-29", todayYmd: "2028-03-01" }), false);
  assert.equal(rules.shouldPublishOnComplete({ sessionYmd: "2028-02-29", todayYmd: "2028-02-29" }), true);
  // DB 가 날짜 뒤에 시각을 붙여 줘도 앞 10글자로 본다
  assert.equal(rules.shouldPublishOnComplete({ sessionYmd: "2026-11-19T00:00:00.000Z", todayYmd: "2026-11-20" }), false);
  // 수업일이 오늘보다 뒤(있을 수 없는 값)면 늦은 종료가 아니다
  assert.equal(rules.shouldPublishOnComplete({ sessionYmd: "2026-11-21", todayYmd: "2026-11-20" }), true);
});

test("오늘 날짜를 모르면(빈 값·이상한 값) 지난 날로 단정하지 않고 기존 규칙을 따른다", () => {
  assert.equal(rules.shouldPublishOnComplete({ sessionYmd: "2026-11-19", todayYmd: "" }), true);
  assert.equal(rules.shouldPublishOnComplete({ sessionYmd: "2026-11-19", todayYmd: "2026-13-40" }), true);
  assert.equal(rules.shouldPublishOnComplete({ sessionYmd: "", todayYmd: "2026-11-20" }), true);
  assert.equal(rules.shouldPublishOnComplete({ sessionYmd: "2026-11-19", todayYmd: "", publishReport: false }), false);
});

test("종료 창의 «학부모에게 바로 보내기» 기본값: 지난 날짜 수업이면 끔", () => {
  assert.equal(rules.defaultPublishOnComplete("2026-11-19", "2026-11-20"), false);
  assert.equal(rules.defaultPublishOnComplete("2026-11-20", "2026-11-20"), true);
  assert.equal(rules.LATE_COMPLETE_NOTICE, "지난 날짜 수업이라 학부모 알림은 나가지 않습니다.");
  // 화면: 서버가 DB 시계로 준 수업일·오늘로 정한다(휴대폰 시계를 보지 않는다)
  assert.match(workspace, /const lateSession = !defaultPublishOnComplete\(session\.sessionYmd, session\.todayYmd\);/);
  // 체크는 선생님이 만졌을 때만 값이 된다(null = 안 만짐). 화면 표시는 «만진 값, 없으면 기본값»
  assert.match(workspace, /const \[publishChoice, setPublishChoice\] = useState<boolean \| null>\(null\);\s*const publishReport = publishChoice \?\? !lateSession;/);
  assert.match(workspace, /checked=\{publishReport\}\s*onChange=\{\(event\) => setPublishChoice\(event\.target\.checked\)\}/);
  // 보낼 때: 안 만졌으면 값을 보내지 않는다 → 서버가 DB 시계로 정한다(밤새 열어 둔 화면에서도 «늦은 종료는 발행 안 함»)
  assert.match(workspace, /publishReport: publishChoice \?\? undefined,/);
  assert.equal((workspace.match(/completeClassSession\(/g) ?? []).length, 1, "종료를 부르는 곳은 한 곳(홈에 끼운 칸도 같은 함수)");
  // 지난 날짜 수업일 때만 체크 아래에 한 줄, 그리고 «알림이 전송됩니다»라고 말하지 않는다
  assert.match(workspace, /학부모에게 바로 보내기\s*<\/label>\s*\{lateSession && <p[^>]*>\{LATE_COMPLETE_NOTICE\}<\/p>\}/);
  assert.match(workspace, /\{lateSession \? "지난 날짜 수업을 종료합니다\." : "종료하면 학부모에게 수업 종료 알림이 전송됩니다\."\}/);
});

test("서버: 발행 판정은 규칙 함수 + DB 시계의 오늘로 한다", () => {
  const finish = functionBody(actions, "completeSessionCore");
  assert.match(finish, /const sessionYmd = String\(session\.date\)\.slice\(0, 10\);/);
  // 오늘을 못 읽어도(DB 오류) 종료가 실패하지 않는다 — 빈 값이면 일반 종료는 기존 규칙, 정리용 종료는 거부
  assert.match(finish, /const todayYmd = await todayKstFromDb\(\)\.catch\(\(\) => ""\);/);
  assert.match(finish, /const publish = !cleanup && shouldPublishOnComplete\(\{ sessionYmd, todayYmd, publishReport: input\.publishReport \}\);/);
  // 옛 판정(값이 없으면 날짜와 무관하게 발행)이 남아 있으면 안 된다
  assert.doesNotMatch(finish, /const publish = input\.publishReport !== false/);
  // 날짜 금지 패턴을 쓰지 않는다
  assert.doesNotMatch(finish, /toISOString\(\)\.slice\(0, ?10\)|getDay\(\)|getHours\(\)/);
});

// ── ② 종료 거부를 서버 기록에 ───────────────────────────────────────

test("종료 거부 기록에는 수업 id·사유 코드·미확인 인원 수만 담긴다", () => {
  assert.deepEqual(rules.completeRefusalLog({ sessionId: "s1", reason: "GATE" }), { sessionId: "s1", reason: "GATE" });
  assert.deepEqual(
    rules.completeRefusalLog({ sessionId: "s1", reason: "ATTENDANCE_MISSING", missingCount: 3 }),
    { sessionId: "s1", reason: "ATTENDANCE_MISSING", missingCount: 3 },
  );
  // 넘겨도 다른 값(학생 이름 등)은 실리지 않는다
  const leaked = rules.completeRefusalLog({ sessionId: "s1", reason: "STATE_CHANGED", studentName: "홍길동", message: "문구" });
  assert.deepEqual(Object.keys(leaked).sort(), ["reason", "sessionId"]);
  // 숫자가 아닌 인원 수는 버린다
  assert.equal("missingCount" in rules.completeRefusalLog({ sessionId: "s1", reason: "ATTENDANCE_MISSING", missingCount: Number.NaN }), false);
});

test("서버: ok:false 를 돌려주는 모든 길에 «종료 거부» 한 줄이 있다", () => {
  const finish = functionBody(actions, "completeSessionCore");
  for (const reason of ["GATE", "NOT_IN_PROGRESS", "NOT_PAST", "NOT_STARTER", "ATTENDANCE_MISSING", "STATE_CHANGED"]) {
    assert.match(
      finish,
      new RegExp(`console\\.warn\\("\\[completeClassSession\\] 종료 거부", completeRefusalLog\\(\\{ sessionId: input\\.sessionId, reason: "${reason}"`),
      `${reason} 기록이 있어야 한다`,
    );
  }
  // 거부(ok:false)마다 바로 앞에 기록이 있다 — 기록 없이 거부하는 길이 새로 생기면 여기서 걸린다
  const refusals = finish.match(/return \{ ok: false as const/g) ?? [];
  const gateReturn = finish.match(/if \(!gate\.ok\) \{\s*console\.warn\([^\n]*\n\s*return gate;/g) ?? [];
  const logs = finish.match(/console\.warn\("\[completeClassSession\] 종료 거부"/g) ?? [];
  assert.equal(gateReturn.length, 1);
  assert.equal(logs.length, refusals.length + gateReturn.length);
  // 미확인 인원 수는 숫자만(이름을 싣지 않는다)
  assert.match(finish, /reason: "ATTENDANCE_MISSING", missingCount \}\)/);
});

// ── ① 막힌 자리에서 «그 수업 종료하기» ──────────────────────────────

test("정리용 종료는 본인이 시작한 수업만", () => {
  assert.equal(rules.canFinishBlockingSession({ startedByUserId: "u1", userId: "u1" }), true);
  assert.equal(rules.canFinishBlockingSession({ startedByUserId: "u2", userId: "u1" }), false);
  assert.equal(rules.canFinishBlockingSession({ startedByUserId: null, userId: "u1" }), false);
  assert.equal(rules.canFinishBlockingSession({ startedByUserId: undefined, userId: undefined }), false, "둘 다 비어 있으면 같다고 보지 않는다");
  assert.equal(rules.canFinishBlockingSession({ startedByUserId: "", userId: "" }), false);
});

test("정리용 종료는 지난 날짜 수업만 — 오늘·미래·날짜를 모를 때는 받지 않는다", () => {
  assert.equal(rules.canCleanupFinish({ sessionYmd: "2026-11-19", todayYmd: "2026-11-20" }), true);
  assert.equal(rules.canCleanupFinish({ sessionYmd: "2026-11-20", todayYmd: "2026-11-20" }), false, "오늘 수업");
  assert.equal(rules.canCleanupFinish({ sessionYmd: "2026-11-21", todayYmd: "2026-11-20" }), false, "미래 수업");
  // 오늘을 못 읽었거나(빈 값) 값이 이상하면 안전하게 거부
  assert.equal(rules.canCleanupFinish({ sessionYmd: "2026-11-19", todayYmd: "" }), false);
  assert.equal(rules.canCleanupFinish({ sessionYmd: "2026-11-19", todayYmd: null }), false);
  assert.equal(rules.canCleanupFinish({ sessionYmd: "2026-11-19", todayYmd: "2026-13-40" }), false);
  assert.equal(rules.canCleanupFinish({ sessionYmd: "", todayYmd: "2026-11-20" }), false);
  assert.equal(rules.canCleanupFinish({ sessionYmd: undefined, todayYmd: undefined }), false);
  // 경계: 월말·연말·윤년, 날짜 뒤에 시각이 붙은 값
  assert.equal(rules.canCleanupFinish({ sessionYmd: "2026-11-30", todayYmd: "2026-12-01" }), true);
  assert.equal(rules.canCleanupFinish({ sessionYmd: "2026-12-31", todayYmd: "2027-01-01" }), true);
  assert.equal(rules.canCleanupFinish({ sessionYmd: "2028-02-29", todayYmd: "2028-03-01" }), true);
  assert.equal(rules.canCleanupFinish({ sessionYmd: "2028-02-29", todayYmd: "2028-02-29" }), false);
  assert.equal(rules.canCleanupFinish({ sessionYmd: "2026-11-19T00:00:00.000Z", todayYmd: "2026-11-20" }), true);
  assert.equal(rules.BLOCKING_NOT_PAST_MESSAGE, "오늘 수업은 그 수업 화면에서 종료해 주세요.");
});

test("서버: «정리용» 표시는 공개 서버 기능의 인자가 아니다 — 본체(export 없음)에만 있고 공개 함수가 고정해서 넘긴다", () => {
  // 본체는 export 하지 않는다("use server" 파일의 export 는 전부 화면에서 부를 수 있는 서버 기능이다)
  assert.match(actions, /\nasync function completeSessionCore\(\s*input: \{ sessionId: string; report\?: string; publishReport\?: boolean \},\s*cleanup: boolean,\s*\) \{/);
  assert.doesNotMatch(actions, /export async function completeSessionCore/);
  // 공개 종료: cleanup 을 받지 않고, 넘겨받은 객체를 펼치지 않고 아는 칸만 골라 넘긴다
  const open = functionBody(actions, "completeClassSession");
  assert.doesNotMatch(open, /cleanup/);
  assert.doesNotMatch(open, /\.\.\.input/);
  assert.match(open, /return completeSessionCore\(\{ sessionId: input\.sessionId, report: input\.report, publishReport: input\.publishReport \}, false\);/);
  // 정리용 종료: 본체를 cleanup = true 로, 발행 끔, 한 줄(report)은 넘기지 않는다(저장된 값 유지)
  const wrapper = functionBody(actions, "completeBlockingSession");
  assert.match(wrapper, /return completeSessionCore\(\{ sessionId: input\.sessionId, publishReport: false \}, true\);/);
  assert.doesNotMatch(wrapper, /report:|\.\.\.input/);
  // 본체를 부르는 곳은 이 둘뿐
  assert.equal((actions.match(/completeSessionCore\(\{/g) ?? []).length, 2);
});

test("서버: 정리용 종료의 검사 순서 — 권한 → 상태 → 지난 날짜 → 본인이 시작 → 출결 미확인 → 종료", () => {
  const finish = functionBody(actions, "completeSessionCore");
  const order = [
    "await trySessionAccess(input.sessionId)",
    'session.status !== "IN_PROGRESS"',
    "canCleanupFinish({ sessionYmd, todayYmd })",
    "canFinishBlockingSession({ startedByUserId: starter[0]?.startedByUserId, userId: access.staff.appUserId })",
    "출결을 확인하지 않은 학생이 있습니다(보강 온 아이 포함).",
    "SET status = 'COMPLETED'",
  ].map((mark) => finish.indexOf(mark));
  assert.ok(order.every((at) => at > 0), "표시를 모두 찾아야 한다");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "검사 순서가 바뀌면 안 된다");
  // 지난 날짜·본인 확인은 정리용일 때만(평소 종료의 기준은 바꾸지 않는다)
  assert.match(finish, /if \(cleanup\) \{\s*(?:\/\/[^\n]*\s*)*if \(!canCleanupFinish\(\{ sessionYmd, todayYmd \}\)\) \{\s*console\.warn\([^\n]*reason: "NOT_PAST" \}\)\);\s*return \{ ok: false as const, message: BLOCKING_NOT_PAST_MESSAGE \};/);
  assert.match(finish, /if \(cleanup\) \{[\s\S]{0,900}SELECT "startedByUserId" FROM "Session" WHERE id = \$1 LIMIT 1/);
  assert.match(finish, /return \{ ok: false as const, message: BLOCKING_NOT_STARTER_MESSAGE \};/);
  // 오늘 수업은 이 길로 끝낼 수 없다(위 NOT_PAST) — 그래도 정리용 종료에서는 학부모 알림 길을 한 번 더 막아 둔다
  assert.match(finish, /if \(!cleanup && shouldNotifyParentsForSession\(sessionYmd\)\) \{/);
});

test("안내 창: 서버 문구 + 한 줄, 글자 버튼 셋, 실패는 창 안에", () => {
  assert.equal(rules.BLOCKING_FINISH_HINT, "지난 날짜 수업이고 출결이 다 확인됐으면 여기서 바로 끝낼 수 있습니다. 학부모 알림과 리포트 발행은 하지 않습니다.");
  assert.equal(rules.BLOCKING_FINISH_NETWORK_MESSAGE, "연결이 불안정해 종료하지 못했습니다. 다시 눌러 주세요.");
  assert.equal(rules.blockingFinishedNotice("수3반"), "수3반 수업을 종료했습니다. 이제 수업을 시작할 수 있습니다.");
  assert.equal(rules.blockingFinishedNotice(null), "그 수업을 종료했습니다. 이제 수업을 시작할 수 있습니다.");

  // 창 틀은 공용 AdminModal — «뒤로 = 창만 닫기»가 이미 들어 있어 따로 걸지 않는다(이중 금지)
  assert.match(dialog, /import AdminModal, \{ useAdminModalCloseThen \} from "@\/components\/admin\/AdminModal";/);
  assert.doesNotMatch(dialog, /useBackToClose/);
  assert.doesNotMatch(dialog, /window\.(alert|confirm)|askConfirm|UiIcon|material-symbols/);
  assert.match(dialog, /\{target\.message\}/);
  // 여기서 끝낼 수 있는 것은 지난 날짜 수업뿐 — 안내 줄과 «그 수업 종료하기»는 서버 판정(isPast)이 참일 때만 보인다
  assert.match(dialog, /\{target\.isPast && <p[^>]*>\{BLOCKING_FINISH_HINT\}<\/p>\}/);
  assert.match(dialog, /\) : target\.isPast \? \(\s*<button type="button" disabled=\{busy\} aria-busy=\{busy\} onClick=\{\(\) => void finish\(\)\}/);
  // 오늘 수업이면 «그 수업 화면 열기»가 주 버튼
  assert.match(dialog, /className=\{`\$\{target\.isPast \|\| needsLogin \? "academy-button-secondary" : "academy-button-primary"\} min-h-11 w-full`\}>그 수업 화면 열기<\/button>/);
  // 화면은 날짜를 비교해 추측하지 않는다(서버가 준 값만 쓴다)
  assert.doesNotMatch(dialog, /todayKst|activeDate|new Date\(/);
  assert.match(dialog, /\{busy \? "종료하는 중…" : "그 수업 종료하기"\}/);
  assert.match(dialog, />그 수업 화면 열기<\/button>/);
  assert.match(dialog, />닫기<\/button>/);
  // 버튼 셋 모두 터치 44px
  assert.equal((dialog.match(/min-h-11 w-full/g) ?? []).length, 4, "버튼(종료·다시 로그인·화면 열기·닫기) 모두 44px");
  // 종료 요청 → 실패 문구는 창 안에, 예외는 «다시 눌러 주세요», 처리 중에는 닫히지 않는다
  assert.match(dialog, /await completeBlockingSession\(\{ sessionId: target\.sessionId \}\)/);
  assert.match(dialog, /if \(!result\.ok\) \{[\s\S]{0,260}setError\(result\.message\);/);
  assert.match(dialog, /catch \{[\s\S]{0,160}setError\(BLOCKING_FINISH_NETWORK_MESSAGE\);/);
  assert.match(dialog, /const locked = busy && !slow;/);
  assert.match(dialog, /busy=\{locked\}\s*closeOnBackdrop=\{!locked\}\s*onClose=\{\(\) => \{ if \(!locked\) onClose\(\); \}\}/);
  // 응답이 12초 넘게 없으면 안내를 보이고 그때부터 «닫기»가 눌린다(응답이 영영 없어도 창에 갇히지 않는다)
  assert.equal(rules.SLOW_RESPONSE_MS, 12_000);
  assert.equal(rules.BLOCKING_SLOW_MESSAGE, "응답이 늦습니다. 닫고 다시 시도할 수 있습니다.");
  assert.match(dialog, /if \(!busy\) return;\s*const timer = window\.setTimeout\(\(\) => setSlow\(true\), SLOW_RESPONSE_MS\);\s*return \(\) => \{\s*window\.clearTimeout\(timer\);\s*setSlow\(false\);\s*\};\s*\}, \[busy\]\);/);
  assert.match(dialog, /\{slow && \(\s*<p role="status"[^>]*>\{BLOCKING_SLOW_MESSAGE\}<\/p>\s*\)\}/);
  assert.match(dialog, /disabled=\{busy && !slow\} data-admin-modal-initial-focus onClick=\{onClose\}/);
  // «그 수업 화면 열기»는 창의 기록 칸을 먼저 되돌린 뒤 이동한다
  assert.match(dialog, /closeThen\(onOpenSession\);\s*onClose\(\);/);
});

test("홈·특강: 목록에 없는 진행 중 수업이면 확인 창 대신 안내 창을 띄운다(자동 시작 없음)", () => {
  for (const [name, source] of [["홈", home], ["특강", seasonal]]) {
    assert.doesNotMatch(source, /askConfirm\(`\$\{result\.message\}/, `${name}: 옛 확인 창이 남아 있으면 안 된다`);
    assert.match(source, /setBlocking\(\{ sessionId: result\.activeSessionId, message: result\.message, className: result\.activeClassName \?\? null, isPast: result\.activeIsPast === true \}\);/, name);
    assert.match(source, /<BlockingSessionDialog\s+target=\{blocking\}/, name);
    assert.match(source, /onOpenSession=\{\(\) => router\.push\(`\/staff\/sessions\/\$\{blocking\.sessionId\}`\)\}/, name);
    assert.match(source, /blockingFinishedNotice\(blocking\.className\)/, name);
    // 종료에 성공해도 새 수업을 스스로 시작하지 않는다
    const finished = source.slice(source.indexOf("onFinished={"), source.indexOf("onOpenSession={"));
    assert.doesNotMatch(finished, /startClassSession|startLesson/, name);
  }
  // 홈: 목록에 있는 수업(다른 기기에서 먼저 시작)은 예전 그대로 그 줄을 펼친다
  assert.match(home, /if \(here\) \{\s*patchLesson\(here\.scheduleKey, \{ sessionStatus: "IN_PROGRESS" \}\);\s*setExpandedKey\(here\.scheduleKey\);\s*setError\(result\.message\);\s*return;\s*\}/);
  // 홈: 성공 안내는 기존 완료 안내 줄(flash)로, 로그인 풀림은 기존 «다시 로그인» 안내로
  assert.match(home, /onFinished=\{\(\) => \{ setBlocking\(null\); setError\(null\); setFlash\(blockingFinishedNotice\(blocking\.className\)\); \}\}/);
  assert.match(home, /onNeedsLogin=\{\(\) => setNeedsLogin\(true\)\}/);
  // 홈: 이 창도 «홈의 창»으로 센다(수업 뒤로 가드가 창의 기록 칸과 엇갈리지 않게)
  assert.match(home, /const homeWindowOpen = Boolean\(startTarget \|\| noticeTarget \|\| billingTarget \|\| blocking\);/);
});

// ── ③ 종료 버튼이 말없이 끝나지 않게 ────────────────────────────────

test("종료할 수 없는 상태면 이유를 돌려준다(종료할 수 있으면 빈 문자열)", () => {
  const ready = { voiceBusy: false, memoSaving: false, online: true };
  assert.equal(rules.finishBlockedMessage(ready), "");
  assert.equal(rules.finishBlockedMessage({ ...ready, voiceBusy: true }), "음성 입력을 마친 뒤 다시 눌러 주세요.");
  assert.equal(rules.finishBlockedMessage({ ...ready, memoSaving: true }), "메모를 저장하는 중입니다. 잠시 뒤 다시 눌러 주세요.");
  assert.equal(rules.finishBlockedMessage({ ...ready, online: false }), "인터넷 연결이 끊긴 것 같습니다. 연결을 확인한 뒤 다시 눌러 주세요.");
  // 연결 끊김은 한 번만 막는다 — 안내를 보인 뒤 다시 누르면 그대로 보낸다(연결 표시가 틀려 영영 못 끝내는 일 방지)
  assert.equal(rules.finishBlockedMessage({ ...ready, online: false, offlineWarned: true }), "");
  // 음성 입력 중·메모 저장 중은 몇 번을 눌러도 계속 막는다
  assert.equal(rules.finishBlockedMessage({ ...ready, voiceBusy: true, offlineWarned: true }), "음성 입력을 마친 뒤 다시 눌러 주세요.");
  assert.equal(rules.finishBlockedMessage({ ...ready, memoSaving: true, online: false, offlineWarned: true }), "메모를 저장하는 중입니다. 잠시 뒤 다시 눌러 주세요.");
  // 여러 이유가 겹치면 선생님이 지금 끝낼 수 있는 것(음성 입력)부터 말한다
  assert.equal(rules.finishBlockedMessage({ voiceBusy: true, memoSaving: true, online: false }), "음성 입력을 마친 뒤 다시 눌러 주세요.");
});

test("화면: «종료 확인»은 처리 중에만 꺼지고, 못 끝내는 상태에서 누르면 창 안에 이유가 보인다", () => {
  const start = workspace.indexOf("function finishSession()");
  assert.ok(start > 0);
  const finish = workspace.slice(start, workspace.indexOf("const attendanceBillingSheet", start));
  // 말없이 끝나는 옛 첫 줄이 없다
  assert.doesNotMatch(finish, /if \(pending \|\| exiting \|\| voiceBusy \|\| memoStatus === "saving"\) return;/);
  assert.match(finish, /if \(pending \|\| exiting\) return;\s*(?:\/\/[^\n]*\s*)*const blockedMessage = finishBlockedMessage\(\{ voiceBusy, memoSaving: memoStatus === "saving", online, offlineWarned: offlineWarnedRef\.current \}\);\s*if \(blockedMessage\) \{\s*if \(!online\) offlineWarnedRef\.current = true;\s*setFinishError\(blockedMessage\);\s*return;\s*\}/);
  // 연결 끊김 안내는 종료 창을 열 때마다 처음부터
  assert.match(workspace, /function openEndConfirm\(\) \{[\s\S]{0,260}offlineWarnedRef\.current = false;\s*\}/);
  // 서버 거부·예외도 같은 칸에 남는다
  assert.match(finish, /if \(!result\.ok\) \{\s*setFinishError\(result\.message\);/);
  assert.match(finish, /catch \{\s*setFinishError\("수업 종료 처리 중 문제가 발생했습니다\. 잠시 후 다시 시도해 주세요\."\);/);

  // 종료 확인 창: 실패 문구 칸이 버튼 줄 바로 위(창 안)에 있고, 버튼은 처리 중에만 꺼진다
  const dialogStart = workspace.indexOf("{showEndConfirm && (");
  assert.ok(dialogStart > 0);
  const endDialog = workspace.slice(dialogStart);
  assert.match(endDialog, /\{finishError && <p role="alert" aria-live="assertive"[^>]*>\{finishError\}<\/p>\}[\s\S]{0,900}<div className="mt-5 grid grid-cols-2 gap-2">/);
  assert.match(endDialog, /<button type="button" disabled=\{pending \|\| exiting\} aria-busy=\{pending \|\| exiting \|\| memoStatus === "saving"\} onClick=\{finishSession\} className="academy-button-danger-solid">/);
  assert.doesNotMatch(endDialog, /disabled=\{pending \|\| exiting \|\| voiceBusy \|\| memoStatus === "saving" \|\| !online\}/);
  // 응답이 12초 넘게 없으면 창 안에 안내 + «새로 고침»(글자 버튼·44px). 처리가 풀리면 타이머·안내를 정리한다
  assert.equal(rules.FINISH_SLOW_MESSAGE, "응답이 늦습니다. 이 화면을 닫지 말고 잠시 기다려 주세요. 계속 멈춰 있으면 새로 고침 뒤 다시 종료해 주세요.");
  assert.match(workspace, /if \(!pending \|\| !showEndConfirm\) return;\s*const timer = window\.setTimeout\(\(\) => setFinishSlow\(true\), SLOW_RESPONSE_MS\);\s*return \(\) => \{\s*window\.clearTimeout\(timer\);\s*setFinishSlow\(false\);\s*\};\s*\}, \[pending, showEndConfirm\]\);/);
  assert.match(endDialog, /\{finishSlow && \(\s*<div role="status"[^>]*>\s*<p>\{FINISH_SLOW_MESSAGE\}<\/p>\s*<button type="button" onClick=\{\(\) => window\.location\.reload\(\)\} className="academy-button-secondary mt-2 min-h-11 w-full">새로 고침<\/button>/);
  // 실패 문구 칸은 종료 확인 창 안 한 곳뿐이다(창 밖에 그려 창에 가리는 일이 없다)
  assert.equal((workspace.match(/\{finishError && /g) ?? []).length, 1);
  assert.ok(workspace.indexOf("{finishError && ") > dialogStart);
});

test("서버: 시작이 막힐 때 그 수업이 지난 날짜인지 SQL(DB 시계)로 판정해 함께 돌려준다", () => {
  const start = functionBody(actions, "startClassSession");
  // 수업일(무tz 칼럼 «두 번» 변환) < DB 시계의 오늘 — 서버·휴대폰 시계를 쓰지 않는다
  assert.match(start, /\(\$\{sessionKstDateSql\("s"\)\} < \$\{TODAY_KST_SQL\}\) AS "isPast"/);
  assert.match(start, /code: "ACTIVE_SESSION" as const,[\s\S]{0,400}activeIsPast: active\[0\]\.isPast === true,/);
  assert.match(actions, /activeIsPast\?: boolean;/);
});
