// 선생님 «수업 한 화면»(2026-11-15 원장 지시) — 출석 화면으로 이동했다 돌아오지 않고, 한 화면에서 칸을 접었다 편다.
// 순수 규칙은 실제로 실행하고, 화면·서버 연결은 «빠져도 tsc·빌드가 통과하는 약속»을 문자열로 못박는다.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const read = (path) => readFileSync(path, "utf8");
const rules = await loadTsModule("src/components/staff/sessionWorkspaceRules.ts");
const feedRules = await loadTsModule("src/lib/feed/rules.ts");

const workspace = read("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx");
const home = read("src/app/staff/StaffHomeClient.tsx");
const panels = read("src/components/staff/LessonWorkspacePanels.tsx");
const section = read("src/components/staff/WorkspaceSection.tsx");
const mediaBar = read("src/components/staff/SessionMediaBar.tsx");
const editor = read("src/components/staff/LessonTextEditor.tsx");
const actions = read("src/app/actions/staff-sessions.ts");

/** export async function <name> 의 본문(다음 최상위 닫는 중괄호까지) */
function functionBody(source, name) {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} 를 찾아야 한다`);
  const end = source.slice(start).search(/\r?\n\}\r?\n/);
  return source.slice(start, start + end);
}

// ── 칸 순서 ─────────────────────────────────────────────────────────

test("수업 중 칸 순서: 수업 종료 → 경과 시간 → 출석부 → 수업 내용 → 사진·영상 → 메모 → 시작 취소 → 아래 막대", () => {
  const marks = ['id="session-end"', 'id="session-elapsed"', 'id="session-attendance"', 'id="session-lesson"', 'id="session-photos"', 'id="session-memo"', 'id="session-cancel-start"', "<SessionMediaBar"];
  const order = marks.map((mark) => workspace.indexOf(mark));
  assert.ok(order.every((at) => at > 0), "칸 표시를 모두 찾아야 한다");
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  // 종료 버튼이 경과 시간 «위», 시작 취소가 메모 «아래»
  assert.ok(workspace.indexOf(">수업 종료</button>") < workspace.indexOf("수업 경과 시간"));
  assert.ok(workspace.indexOf("메모 지금 저장") < workspace.indexOf("수업 시작 취소 (시작 전으로 되돌리기)"));
  // 화면이 둘(view)로 갈리지 않는다 — 출석 화면으로 «돌아가기»가 없다
  assert.doesNotMatch(workspace, /setView\(|view === "attendance"|수업으로 돌아가기/);
});

test("아래 고정 막대: [사진]=바로 촬영 · [동영상]=바로 촬영 · [갤러리]=여러 장 고르기, 입력칸은 버튼과 같은 부품 안", () => {
  const labels = [...mediaBar.matchAll(/className="academy-button-tonal min-h-12!">([^<]+)<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ["사진", "동영상", "갤러리"]);
  assert.match(mediaBar, /<input ref=\{photoCameraRef\} hidden type="file" accept="image\/jpeg,image\/png,image\/webp" capture="environment"/);
  assert.match(mediaBar, /<input ref=\{videoCameraRef\} hidden type="file" accept="video\/\*" capture="environment"/);
  // 갤러리는 카메라를 열지 않고(capture 없음) 사진·영상을 함께 고른다
  assert.match(mediaBar, /<input ref=\{galleryRef\} hidden type="file" accept="image\/jpeg,image\/png,image\/webp,video\/mp4,video\/quicktime,video\/webm" multiple onChange/);
  // 누른 직후에 열린다(같은 부품의 ref 를 바로 누른다)
  assert.match(mediaBar, /onClick=\{\(\) => \{ setNotice\(""\); photoCameraRef\.current\?\.click\(\); \}\}/);
  // 올리기는 기존 사진·영상 부품의 upload 로 넘긴다(제한·압축·다시 올리기 로직을 다시 만들지 않는다)
  assert.match(mediaBar, /photoRef\.current\?\.upload\(files\)/);
  assert.match(mediaBar, /videoRef\.current\?\.upload\(file\)/);
  assert.doesNotMatch(mediaBar, /fetch\(|uploadImagesWithProgress|XMLHttpRequest/);
  // 수업 화면: 올리기 부품은 버튼만 숨기고(목록·지우기는 그대로) 막대에 손잡이를 넘긴다
  assert.match(workspace, /<SessionPhotoUploader ref=\{photoUploaderRef\} sessionId=\{session\.id\} hideButtons onStateChange=\{setPhotoState\} \/>/);
  assert.match(workspace, /<SessionVideoUploader ref=\{videoUploaderRef\} sessionId=\{session\.id\} hideButtons onStateChange=\{setVideoState\} \/>/);
  // 2026-11-15 원장 점검: 수업 중 아래 탭 숨김·시작 취소 위험 버튼 — 홈에서도 아래 탭이 숨으므로 막대는 늘 화면 바닥(안전 영역만 비움)에 붙는다
  assert.doesNotMatch(workspace, /aboveBottomNav/);
  assert.match(mediaBar, /: "max\(0\.5rem, env\(safe-area-inset-bottom\)\)"/);
});

test("갤러리에서 고른 파일은 사진(여러 장)·영상(1개)으로 나뉜다", () => {
  const files = [
    { type: "image/jpeg", name: "a.jpg" },
    { type: "video/mp4", name: "b.mp4" },
    { type: "image/png", name: "c.png" },
    { type: "video/quicktime", name: "d.mov" },
    { type: "application/pdf", name: "e.pdf" },
    { type: "", name: "f.MOV" },
    { type: "", name: "g.webp" },
  ];
  const split = rules.splitGalleryFiles(files);
  assert.deepEqual(split.images.map((f) => f.name), ["a.jpg", "c.png", "g.webp"]);
  assert.equal(split.video.name, "b.mp4");
  assert.equal(split.extraVideos, 2);
  assert.equal(split.unsupported, 1);
  assert.match(rules.galleryLeftoverNotice(split), /영상은 한 번에 1개만/);
  assert.equal(rules.galleryLeftoverNotice({ extraVideos: 0, unsupported: 0 }), "");
  assert.deepEqual(rules.splitGalleryFiles([]), { images: [], video: null, extraVideos: 0, unsupported: 0 });
});

// ── 통합 글칸 ───────────────────────────────────────────────────────

test("통합 글칸 채움 규칙: 저장된 내용 있음/없음 × 미리 쓴 내용 있음/없음 × 상태 3종", () => {
  const cases = [
    // [status, content, planned] → [value, saveTarget, prefilledFromPlan]
    ["PLANNED", null, null, "", "plannedContent", false],
    ["PLANNED", null, "드리블", "드리블", "plannedContent", false],
    ["PLANNED", "옛 한 줄", null, "옛 한 줄", "plannedContent", false],
    ["PLANNED", "옛 한 줄", "드리블", "드리블", "plannedContent", false],
    ["IN_PROGRESS", null, null, "", "content", false],
    ["IN_PROGRESS", null, "드리블", "드리블", "content", true],
    ["IN_PROGRESS", "잘했어요", null, "잘했어요", "content", false],
    ["IN_PROGRESS", "잘했어요", "드리블", "잘했어요", "content", false],
    ["COMPLETED", null, null, "", "content", false],
    ["COMPLETED", null, "드리블", "드리블", "content", true],
    ["COMPLETED", "잘했어요", null, "잘했어요", "content", false],
    ["COMPLETED", "잘했어요", "드리블", "잘했어요", "content", false],
  ];
  for (const [status, content, plannedContent, value, saveTarget, prefilledFromPlan] of cases) {
    assert.deepEqual(rules.resolveLessonText({ status, content, plannedContent }), { value, saveTarget, prefilledFromPlan }, `${status} / ${content} / ${plannedContent}`);
  }
  // 기록이 아직 없는 수업(상태 없음)은 시작 전이다. 공백뿐인 값은 없는 것으로 본다.
  assert.equal(rules.resolveLessonText({ status: null, content: null, plannedContent: "계획" }).saveTarget, "plannedContent");
  assert.deepEqual(rules.resolveLessonText({ status: "IN_PROGRESS", content: "   ", plannedContent: " 계획 " }), { value: "계획", saveTarget: "content", prefilledFromPlan: true });
  assert.equal(rules.workspacePhase(undefined), "PLANNED");
  assert.equal(rules.workspacePhase("COMPLETED"), "COMPLETED");
  assert.equal(rules.PLAN_PREFILL_NOTICE, "미리 쓴 내용을 불러왔어요. 저장하면 수업 종료 뒤 학부모에게 보입니다");
});

test("통합 글칸: 채운 값은 자동 저장하지 않고, 수업 전은 미리 쓴 내용·수업 중·후는 수업 내용으로 저장한다", () => {
  // 글칸은 저장 버튼을 눌렀을 때만 저장한다(값이 바뀌었다고 저장하지 않는다)
  assert.doesNotMatch(editor, /useEffect/);
  assert.match(editor, /onClick=\{\(\) => void submit\(\)\}/);
  assert.match(editor, /\{prefilledFromPlan && unsaved && \(\s*<p role="status"[^>]*>\{PLAN_PREFILL_NOTICE\}<\/p>/);
  // 수업 중: 채운 상태로 시작 → 저장하면 안내가 사라진다
  assert.match(workspace, /useState<string \| null>\(initialLessonText\.prefilledFromPlan \? initialLessonText\.value : null\)/);
  assert.match(workspace, /const lessonPrefilled = isUntouchedPrefill\(prefillSource, report\);/);
  assert.match(workspace, /prefilledFromPlan=\{lessonPrefilled\}/);
  // 수업 전: 같은 글칸이 미리 쓴 내용(수업 전 전용 서버 기능)으로 저장한다
  assert.match(panels, /<LessonTextEditor inputId=\{`lesson-text-input-\$\{lesson\.classId\}`\} phase="PLANNED" value=\{text\} onChange=\{setText\} save=\{save\} \/>/);
  assert.match(home, /async function savePlanned\(lesson: StaffTodayClass, text: string\)[\s\S]{0,400}await savePlannedClassContent\(\{/);
  // 옛 «수업 내용 미리 작성» 창과 «수업 피드» 시트는 없다(진입이 하나)
  assert.doesNotMatch(home, /수업 내용 미리 작성|SessionFeedPanel|contentTarget|feedTarget/);
  // 서버 기능은 지우지 않았다
  assert.match(actions, /export async function savePlannedClassContent/);
  assert.match(actions, /export async function saveSessionFeedLine/);
});

test("학부모 공개 시점은 그대로 — 수업 전·중에 쓴 내용은 «종료 + 발행» 전에는 보이지 않는다", () => {
  for (const status of ["PLANNED", "IN_PROGRESS"]) {
    assert.equal(feedRules.isParentVisibleSession({ status, published: true }), false, status);
    assert.equal(feedRules.isParentVisibleSession({ status, published: false }), false, status);
  }
  assert.equal(feedRules.isParentVisibleSession({ status: "COMPLETED", published: false }), false);
  assert.equal(feedRules.isParentVisibleSession({ status: "COMPLETED", published: true }), true);
  assert.equal(feedRules.feedVisibleSessionSql("se"), "se.status = 'COMPLETED' AND se.published = true");
  // 수업 내용 저장은 발행 여부를 건드리지 않는다(발행은 수업 종료의 UPDATE 에서만)
  const line = functionBody(actions, "saveSessionFeedLine");
  assert.doesNotMatch(line, /published/);
  assert.doesNotMatch(functionBody(actions, "savePlannedClassContent"), /published|content = /);
});

// ── 접힌 머리줄의 저장 상태 ─────────────────────────────────────────

test("접힌 출석부 머리줄: 저장 중·저장 실패 n 을 보이고, 참고 안내는 실패로 세지 않는다", () => {
  assert.deepEqual(rules.attendanceSaveBadge({ savingCount: 0, errorCount: 0 }), { saving: false, failed: 0, text: "" });
  assert.deepEqual(rules.attendanceSaveBadge({ savingCount: 2, errorCount: 0 }), { saving: true, failed: 0, text: "저장 중" });
  assert.deepEqual(rules.attendanceSaveBadge({ savingCount: 0, errorCount: 3 }), { saving: false, failed: 3, text: "저장 실패 3" });
  assert.deepEqual(rules.attendanceSaveBadge({ savingCount: 1, errorCount: 1 }), { saving: true, failed: 1, text: "저장 중 · 저장 실패 1" });
  // 전체 출석 처리 중도 «저장 중»
  assert.equal(rules.attendanceSaveBadge({ savingCount: 0, errorCount: 0, bulkBusy: true }).text, "저장 중");
  assert.equal(rules.countRowErrors({ a: { tone: "error" }, b: { tone: "notice" }, c: { tone: "error" } }), 2);
  assert.equal(rules.countRowErrors({}), 0);
  assert.equal(rules.attendanceSummaryLine({ PRESENT: 5, LATE: 1, ABSENT: 2, UNCHECKED: 3 }), "출석 5 · 지각 1 · 결석 2 · 미확인 3");
});

test("칸을 접어도 상태가 사라지지 않는다 — 접는 칸은 숨기기만 하고(hidden), 출석부 머리줄에 저장 상태를 넘긴다", () => {
  // 접을 때 안의 내용을 없애지 않는다(조건부로 그리지 않는다)
  assert.match(section, /<div id=\{`\$\{id\}-panel`\} hidden=\{!open\}/);
  assert.doesNotMatch(section, /\{open && /);
  assert.match(section, /aria-expanded=\{open\}\s+aria-controls=\{`\$\{id\}-panel`\}/);
  assert.match(section, /<UiIcon name=\{open \? "expand_less" : "expand_more"\} \/>/);
  // 출석 저장 중·실패는 부품 상태에 그대로 있고, 접힌 머리줄 표시로 들어간다
  assert.match(workspace, /attendanceSaveBadge\(\{ savingCount: Object\.keys\(savingRows\)\.length, errorCount: countRowErrors\(rowNotices\), bulkBusy \}\)/);
  assert.match(workspace, /id="session-attendance"[\s\S]{0,400}badge=\{saveBadge\.text \? <span role="status"/);
  // 메모 저장 실패·사진 올리는 중도 접힌 머리줄에 남는다
  assert.match(workspace, /id="session-memo"[\s\S]{0,300}memoStatus === "error" \? <span role="status"[^>]*>저장 실패<\/span>/);
  assert.match(workspace, /id="session-photos"[\s\S]{0,300}mediaBusy \? <span role="status"[^>]*>올리는 중<\/span>/);
});

// ── 보호 장치 ───────────────────────────────────────────────────────

test("종료 잠금·확인 창·이동 전 저장은 그대로, 홈에서는 접을 때·다른 줄·탭 이동 때 메모를 저장한다", () => {
  // 종료 버튼 잠금: 음성 입력 중·수업 내용 저장 중·메모 저장 중·오프라인 + 사진·영상 올리는 중(검수 8)
  assert.match(workspace, /const endLocked = pending \|\| voiceBusy \|\| feedBusy \|\| memoStatus === "saving" \|\| !online \|\| mediaBusy;/);
  assert.match(workspace, /사진·영상을 올리는 중이에요\./);
  assert.match(workspace, /<button id="session-end" type="button" disabled=\{endLocked\} onClick=\{openEndConfirm\}/);
  // 확인 창: 출결 4칸·미확인 차단·바로 보내기·최종 확정만 위험색
  assert.match(workspace, /출결 미확인 학생 \{counts\.UNCHECKED\}명이 있어 아직 종료할 수 없습니다\./);
  assert.match(workspace, /학부모에게 바로 보내기/);
  assert.match(workspace, /onClick=\{finishSession\} className="academy-button-danger-solid"/);
  assert.match(workspace, /onClick=\{\(\) => \{ setShowEndConfirm\(false\); scrollToRoster\(\); \}\}/);
  // 미확인 출결이 있으면 종료를 거절하는 서버 규칙은 그대로
  assert.match(functionBody(actions, "completeClassSession"), /출결을 확인하지 않은 학생이 있습니다\(보강 온 아이 포함\)\./);
  // 수업 주소 전용: 뒤로 가기 확인. 홈에 끼운 칸은 이력을 건드리지 않는다
  assert.match(workspace, /if \(embedded\) return;\s*const guardKey = `staff-session-\$\{session\.id\}`;/);
  assert.match(workspace, /window\.addEventListener\("staff:prepare-navigation", prepareToLeave\)/);
  // 시작 취소: 확인 창 유지 + 쓰던 메모 먼저 저장
  assert.match(workspace, /window\.confirm\("수업 시작을 취소하고 '시작 전' 상태로 되돌릴까요\? \(기록한 출결은 그대로 유지됩니다\)"\)/);
  assert.match(workspace, /const memoSaved = await persistMemo\(memoRef\.current\);[\s\S]{0,300}await cancelClassSession\(\{ sessionId: session\.id \}\)/);
  // 홈: 줄을 접으면(active → false)·칸이 사라질 때·메모 칸을 접을 때 저장
  assert.match(workspace, /if \(wasActiveRef\.current && !active\) void persistMemo\(memoRef\.current\);/);
  assert.match(workspace, /if \(!embedded\) return;\s*return \(\) => \{ void persistMemo\(memoRef\.current\); \};/);
  assert.match(workspace, /if \(name === "memo" && openSections\.memo\) void persistMemo\(memoRef\.current\);/);
  // 홈: 다른 줄을 펼치기 전·아래 탭으로 옮기기 전에 저장 신호를 보낸다(저장하지 못하면 머문다)
  assert.match(home, /async function toggleLesson[\s\S]{0,500}const ready = await prepareStaffNavigation\(\);\s*if \(!ready\.ok\) \{/);
  const nav = read("src/app/staff/StaffBottomNav.tsx");
  assert.match(nav, /if \(pathname !== "\/staff" \|\| href === "\/staff"\) return;/);
  assert.match(nav, /const result = await prepareStaffNavigation\(\);\s*if \(!result\.ok\) \{[\s\S]{0,160}return;\s*\}\s*router\.push\(href\);/);
  // 진행 중 수업 칸은 줄을 접어도 버리지 않고 숨기기만 한다
  assert.match(home, /if \(!expanded && !\(live && data\?\.state === "ready"\)\) return null;/);
  assert.match(home, /<div id=\{lessonBodyId\(lesson\)\} hidden=\{!expanded\}/);
});

test("시작 전 본문에는 출결 버튼이 없고, 쓰다 만 수업 내용은 시작·접기 전에 저장한다", () => {
  const planned = panels.slice(panels.indexOf("export function PlannedLessonPanel"), panels.indexOf("export function CompletedSessionPanel"));
  assert.doesNotMatch(planned, /StatusChoiceButton|saveStaffAttendance/);
  assert.doesNotMatch(panels, /saveStaffAttendance|completeClassSession|cancelClassSession/);
  assert.match(planned, /if \(textRef\.current !== savedRef\.current\) void saveRef\.current\(textRef\.current\);/);
  assert.match(planned, /const result = await save\(textRef\.current\)[\s\S]{0,300}if \(!result\.ok\) \{ setStartError\(result\.message\); return; \}\s*\}\s*onStart\(\);/);
  // 수업 공지는 대타 반에 넘기지 않는다(f4)
  assert.match(home, /const openNotice = lesson\.substitute \? undefined : /);
});

// ── 새 서버 기능의 권한 ─────────────────────────────────────────────

test("수업 본문 불러오기: 출석 저장·종료와 같은 권한 문을 지난 뒤에만 읽는다", () => {
  const body = functionBody(actions, "loadStaffSessionWorkspace");
  const gate = body.indexOf("await trySessionAccess(sessionId)");
  assert.ok(gate > 0, "권한 검사가 있어야 한다");
  assert.ok(gate < body.indexOf("getStaffSessionDetail(sessionId)"), "권한 검사가 조회보다 먼저다");
  assert.ok(gate < body.indexOf("getStaffSessionStudents(sessionId, session.classId)"));
  assert.match(body, /if \(!gate\.ok\) return gate;/);
  // 로그인 풀림·권한 없음은 던지지 않고 결과로(b5)
  assert.match(body, /const failure = staffAccessFailure\(error\);\s*if \(failure\) return failure;\s*throw error;/);
  // 반 id 는 화면이 아니라 수업 기록에서 가져온다
  assert.doesNotMatch(body, /input\.classId/);
});

test("명단 프로필 사진 버전: 세 갈래 모두 권한 검사 뒤에 읽고, 학생은 화면이 보낸 목록이 아니라 서버가 고른다", () => {
  const body = functionBody(actions, "loadStaffRosterPhotoVersions");
  const query = body.indexOf("prisma.$queryRawUnsafe");
  for (const check of ["await requireSessionAccess(sessionId)", "await requireStaffSeasonalSessionAccess(sessionDateId)", "await requireStaffClassAccess(classId, undefined, { substituteDate: todayKst() })"]) {
    const at = body.indexOf(check);
    assert.ok(at > 0 && at < query, check);
  }
  // 다른 반의 수업 기록·회차 id 를 섞어 넣지 못한다
  assert.match(body, /if \(session\.classId !== classId\) return \{ ok: false/);
  assert.match(body, /if \(seasonal\.linkedClassId !== classId\) return \{ ok: false/);
  assert.doesNotMatch(body, /studentIds/);
  assert.match(body, /e\."classId" = \$1 AND e\.status = 'ACTIVE'/);
  assert.doesNotMatch(body, /findMany|findUnique|\.create\(|\.update\(/);
});

// ── 음성 버튼 ───────────────────────────────────────────────────────

test("음성 버튼: 스토어 앱에서는 말없이 숨지 않고 이유 한 줄을 보인다(판정·녹음 로직은 그대로)", () => {
  const voice = read("src/components/staff/VoiceToTextButton.tsx");
  assert.match(voice, /const appLacksVoice = useStoreAppLacks\("voice"\);/);
  assert.match(voice, /if \(appLacksVoice\) return <p className="[^"]*text-xs[^"]*">음성 입력은 앱 다음 버전부터 됩니다<\/p>;/);
  assert.doesNotMatch(voice, /if \(appLacksVoice\) return null;/);
  // 브라우저에서는 지금처럼 버튼
  assert.match(voice, /\{recording \? "녹음 종료" : transcribing \? "메모 변환 중" : "음성으로 기록"\}/);
  assert.match(voice, /navigator\.mediaDevices\.getUserMedia\(\{ audio: true \}\)/);
  // 수업 화면 메모 칸에 음성 버튼이 있다
  assert.match(workspace, /id="session-memo"[\s\S]*?<VoiceToTextButton\s+onBusyChange=\{setVoiceBusy\}/);
});

// ── 홈: 이동하지 않고 그 자리에서 ───────────────────────────────────

test("홈은 수업 줄을 누르거나 수업을 시작해도 수업 주소로 이동하지 않는다(어제 못 끝낸 수업만 예외)", () => {
  const pushes = [...home.matchAll(/router\.push\(`\/staff\/sessions\/[^`]*`\)/g)].map((m) => m[0]);
  assert.deepEqual(pushes, ["router.push(`/staff/sessions/${result.activeSessionId}`)"], "남는 이동은 «어제 못 끝낸 수업» 하나뿐이다");
  assert.doesNotMatch(home, /view=attendance/);
  // 그 이동도 확인 창을 거친다
  assert.match(home, /window\.confirm\(`\$\{result\.message\}\\n\\n그 수업 화면으로 이동할까요\?`\)\) \{\s*router\.push\(`\/staff\/sessions\/\$\{result\.activeSessionId\}`\);/);
  // 수업 시작 → 그 줄이 «수업 중»으로 바뀌고 출석부 칸이 펼쳐진다
  assert.match(home, /patchLesson\(started\.scheduleKey, \{ sessionId: result\.sessionId, sessionStatus: "IN_PROGRESS", startedAt: result\.startedAt \}\);\s*setJustStartedId\(result\.sessionId\);\s*setExpandedKey\(started\.scheduleKey\);/);
  assert.match(home, /initialView=\{justStartedId === sessionId \? "attendance" : "main"\}/);
  // 본문은 펼칠 때 불러온다(한 번에 하나만 펼침 — 펼친 줄 하나의 열쇠)
  assert.match(home, /if \(expandedSessionId && !expandedLoaded\) loadSession\(expandedSessionId\);/);
  assert.match(home, /void loadStaffSessionWorkspace\(\{ sessionId \}\)/);
  assert.match(home, /useState<string \| null>\(\(\) => initialClasses\.find\(\(lesson\) => lesson\.sessionStatus === "IN_PROGRESS"\)\?\.scheduleKey \?\? null\)/);
  // 홈과 수업 주소가 같은 수업 부품을 쓴다
  assert.match(home, /import SessionWorkspace from "@\/app\/staff\/sessions\/\[sessionId\]\/SessionInProgressClient";/);
  assert.match(read("src/app/staff/sessions/[sessionId]/page.tsx"), /import SessionInProgressClient from "\.\/SessionInProgressClient";/);
  // 특강 탭·머리줄은 수업 주소를 그대로 쓴다(주소 유지)
  assert.match(read("src/app/staff/seasonal/StaffSeasonalClient.tsx"), /router\.push\(`\/staff\/sessions\/\$\{d\.sessionId\}`\)/);
  assert.match(read("src/app/staff/StaffBottomNav.tsx"), /if \(pathname\.startsWith\("\/staff\/sessions\/"\)\) return null;/);
});

// ── 출석부에 통합한 학생 정보 ───────────────────────────────────────

test("출석부 줄의 이름을 누르면 그 자리에서 학생 정보가 펼쳐진다 — 예전 시트의 내용 전부", () => {
  // 학생 정보는 «이름을 눌러 처음 펼칠 때» 한 번 읽는다(검수 10 — 출석부를 열자마자 읽으면 그 조회가 첫 출석 저장보다 먼저 줄을 선다)
  assert.match(workspace, /aria-expanded=\{infoOpen\} aria-controls=\{`roster-info-\$\{student\.id\}`\} aria-label=\{`\$\{student\.name\} 상세 정보`\} onClick=\{\(\) => \{ setPeopleWanted\(true\); setInfoRow\(infoOpen \? null : student\.id\); \}\}/);
  assert.match(workspace, /const \[peopleWanted, setPeopleWanted\] = useState\(false\);/);
  // 2026-11-15 접이식 구조와 병합: 화면이 뜨고 잠시 뒤 또는 첫 이름 누름 때 읽고, 출결 저장 중이면 미룬다(더 보수적인 쪽)
  assert.match(workspace, /useClassPeople\(\{ classId: session\.classId, sessionId: session\.id, sessionDateId: session\.sessionDateId, enabled: peopleWanted, hold: attendanceBusy \}\)/);
  assert.doesNotMatch(workspace, /if \(name === "attendance"\) setPeopleWanted\(true\);/);
  const info = read("src/components/staff/RosterPersonInfo.tsx");
  assert.match(info, /if \(!enabled \|\| hold\) return;/);
  for (const piece of ["<ProfileAvatar decorative name={person.name} src={photoSrc} size={40} />", "학교·학년 미등록", 'label="학생 전화"', 'label="학부모 전화"', 'label="문자" sms', "person.memo &&", "person.recentAttendance.total", "person.guardians.map(", "오늘 {status ? TODAY_LABEL[status] : \"미확인\"}"]) {
    assert.ok(info.includes(piece), piece);
  }
  assert.match(info, /profilePhotoUrl\(\{ kind: "student", id: person\.id \}, photoVersion \?\? null, true\)/);
});

test("출석부 줄과 학생 정보 잇기: 정규는 학생 id, 특강은 전환된 학생 id, 미전환은 이름이 하나뿐일 때만", () => {
  const people = [{ id: "s1", name: "김하나" }, { id: "s2", name: "이둘" }, { id: "item:9", name: "박셋" }, { id: "s4", name: "최넷" }, { id: "s5", name: "최넷" }];
  assert.equal(rules.findRosterPerson({ id: "s1", studentId: "s1", name: "김하나" }, people).id, "s1");
  assert.equal(rules.findRosterPerson({ id: "seat-7", studentId: "s2", name: "이둘" }, people).id, "s2");
  assert.equal(rules.findRosterPerson({ id: "seat-8", studentId: null, name: "박셋" }, people).id, "item:9");
  // 동명이인은 잇지 않는다(다른 아이의 연락처가 보이면 안 된다)
  assert.equal(rules.findRosterPerson({ id: "seat-9", studentId: null, name: "최넷" }, people), null);
  // 보강·체험 아이는 이 반 학생 정보에 없다
  assert.equal(rules.findRosterPerson({ id: "trial:1", studentId: null, name: "없는아이" }, people), null);
});

// ── 펼침 표시는 화살표 아이콘 ───────────────────────────────────────

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

test("선생님 화면의 펼침 표시는 글자(펼치기/접기)·기호(▾)가 아니라 공용 화살표 아이콘이다", () => {
  const files = [...walk("src/app/staff"), ...walk("src/components/staff")];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /[▾▴▼▲]/, `${file}: 펼침 기호가 남아 있다`);
    assert.doesNotMatch(source, /"펼치기"|"접기"|>\s*펼치기\s*<|>\s*접기\s*</, `${file}: «펼치기/접기» 글자가 남아 있다`);
    assert.doesNotMatch(source, /material-symbols-outlined/, `${file}: 아이콘 글꼴을 직접 쓴다`);
    // 이 화면의 아이콘은 펼침 화살표뿐이고, 항상 «펼쳐졌으면 접는 화살표» 순서다
    for (const tag of source.matchAll(/<UiIcon\b[^>]*?\/>/gs)) {
      assert.match(tag[0], /name=(\{\w+(?:Key === \w+\.scheduleKey)? \? "expand_less" : "expand_more"\}|"expand_more")/, `${file}: ${tag[0]}`);
    }
  }
  // 펼치는 버튼은 상태를 알린다
  assert.match(home, /aria-expanded=\{showCompleted\} aria-controls="completed-lessons"/);
  assert.match(home, /aria-expanded=\{expandedKey === focusClass\.scheduleKey\}\s+aria-controls=\{lessonBodyId\(focusClass\)\}/);
  assert.doesNotMatch(home, /<details|<summary/);
  assert.doesNotMatch(workspace, /<details|<summary/);
});

// ── 검수 반영(2026-11-15) ───────────────────────────────────────────

test("필수 1: 미리 쓴 내용을 채운 그대로 종료하려 하면 종료 확인 창 글칸 바로 아래에서 알리고, 지우면 빈 값이 나간다", () => {
  // 채운 그대로일 때만 참 — 한 글자라도 고치거나 지우거나, 저장하면(채운 글 = null) 거짓
  assert.equal(rules.isUntouchedPrefill("드리블 연습", "드리블 연습"), true);
  assert.equal(rules.isUntouchedPrefill("드리블 연습", "드리블 연습!"), false);
  assert.equal(rules.isUntouchedPrefill("드리블 연습", ""), false);
  assert.equal(rules.isUntouchedPrefill(null, "드리블 연습"), false);
  // 종료 때 나가는 값 = 글칸에 보이는 값 그대로(미리 쓴 내용이 따로 따라 나가지 않는다)
  assert.equal(rules.reportForFinish(""), "");
  assert.equal(rules.reportForFinish("   "), "");
  assert.equal(rules.reportForFinish(" 고친 글 "), "고친 글");
  assert.equal(rules.PLAN_PREFILL_END_NOTICE, "미리 쓴 내용을 불러왔어요. 이대로 종료하면 학부모에게 보입니다 — 고치거나 지울 수 있어요");
  // 종료 확인 창: 글칸(session-report) 바로 뒤에 경고가 있고, 그 글칸은 같은 값(report)을 바로 고친다
  assert.match(workspace, /id="session-report"\s+value=\{report\}\s+onChange=\{\(event\) => setReport\(event\.target\.value\)\}[\s\S]{0,700}\{lessonPrefilled && \(\s*<p role="alert"[^>]*>\{PLAN_PREFILL_END_NOTICE\}<\/p>/);
  // 종료는 그 값만 보낸다 — 미리 쓴 내용(plannedContent)을 따로 넣지 않는다
  assert.match(workspace, /completeClassSession\(\{[\s\S]{0,200}report,\s*publishReport,\s*\}\)/);
  assert.doesNotMatch(workspace, /completeClassSession\(\{[\s\S]{0,300}plannedContent/);
  // 서버: 보낸 값이 비면 지움(NULL) — 빈 값으로 종료하면 학부모에게 글이 나가지 않는다
  const finish = functionBody(actions, "completeClassSession");
  assert.match(finish, /const report = \(input\.report \?\? ""\)\.trim\(\)\.slice\(0, 2000\) \|\| null;/);
  assert.match(finish, /content = CASE WHEN \$5 THEN \$3 ELSE content END/);
  // 저장하면 채움 상태가 풀린다
  assert.match(workspace, /setLessonSaveFailed\(false\);[\s\S]{0,80}setPrefillSource\(null\);/);
  // 수업 전 글칸 문구는 사실대로(«선생님만 봐요» 가 아니다)
  assert.match(editor, /수업을 종료하면 이 내용이 학부모에게 보일 수 있어요\(종료할 때 고칠 수 있습니다\)/);
  assert.doesNotMatch(editor, /선생님만 봐요/);
});

test("필수 2: 끝난 수업을 접으면 본문을 버려 다시 펼칠 때 새로 읽는다(저장 → 접기 → 펼치기 후 옛 값이 나오지 않는다)", () => {
  const lessons = [
    { scheduleKey: "regular:a", sessionId: "s-live", sessionStatus: "IN_PROGRESS" },
    { scheduleKey: "regular:b", sessionId: "s-done", sessionStatus: "COMPLETED" },
    { scheduleKey: "regular:c", sessionId: null, sessionStatus: null },
  ];
  // 끝난 수업을 펼쳐 처음 읽은 값(옛 글)
  let data = { "s-live": { content: "수업 중" }, "s-done": { content: "옛 글" } };
  // 펼쳐 있는 동안은 그대로(같은 객체 — 다시 그리지 않는다)
  assert.equal(rules.retainSessionData(data, lessons, "regular:b"), data);
  // 저장한 뒤 접으면 → 끝난 수업 본문은 버린다(진행 중 수업은 남는다)
  data = rules.retainSessionData(data, lessons, null);
  assert.deepEqual(Object.keys(data), ["s-live"]);
  // 다시 펼치면 본문이 없으므로 화면은 서버에서 새로 읽는다(옛 글로 시작하지 않는다)
  assert.equal("s-done" in rules.retainSessionData(data, lessons, "regular:b"), false);
  // 다른 줄을 펼쳐도 같다
  assert.deepEqual(Object.keys(rules.retainSessionData({ "s-live": 1, "s-done": 2 }, lessons, "regular:c")), ["s-live"]);
  // 종료된 뒤(진행 중이 아니게 된 뒤) 접혀 있으면 그 본문도 버린다
  assert.deepEqual(rules.retainSessionData({ "s-live": 1 }, [{ scheduleKey: "regular:a", sessionId: "s-live", sessionStatus: "COMPLETED" }], null), {});
  // 홈이 줄을 접거나 바꿀 때마다 이 규칙을 돌리고, 본문이 없으면 다시 읽는다
  assert.match(home, /setSessionData\(\(current\) => retainSessionData\(current, classes, expandedKey\)\);\s*\}, \[classes, expandedKey\]\);/);
  assert.match(home, /const expandedLoaded = expandedSessionId \? Boolean\(sessionData\[expandedSessionId\]\) : true;/);
  // 수업 전 줄: 저장하면 목록 값을 먼저 고치고(접었다 바로 펼쳐도 방금 쓴 글), 실패하면 되돌린다
  assert.match(home, /const previous = lesson\.plannedContent;\s*patchLesson\(lesson\.scheduleKey, \{ plannedContent: text\.trim\(\) \|\| null \}\);/);
  assert.match(home, /if \(!result\.ok\) \{\s*patchLesson\(lesson\.scheduleKey, \{ plannedContent: previous \}\);/);
});

test("권장 3·4: 펼쳐진 줄 머리의 «시작»은 숨기고, 접힌 줄 머리에 메모·수업 내용 저장 실패도 보인다(저장 중은 중립색)", () => {
  assert.match(home, /\{completed \? <StatusBadge status=\{lesson\.sessionStatus\} \/> : expanded \? null : \(\s*<button/);
  assert.deepEqual(rules.workspaceSaveStatus({ attendance: { saving: false, failed: 0 }, memoStatus: "saved", lessonSaveFailed: false }), { saving: "", failed: "" });
  assert.deepEqual(rules.workspaceSaveStatus({ attendance: { saving: true, failed: 0 }, memoStatus: "saved", lessonSaveFailed: false }), { saving: "저장 중", failed: "" });
  assert.deepEqual(rules.workspaceSaveStatus({ attendance: { saving: false, failed: 0 }, memoStatus: "saving", lessonSaveFailed: false }), { saving: "저장 중", failed: "" });
  assert.deepEqual(rules.workspaceSaveStatus({ attendance: { saving: false, failed: 0 }, memoStatus: "error", lessonSaveFailed: false }), { saving: "", failed: "메모 저장 실패" });
  assert.deepEqual(rules.workspaceSaveStatus({ attendance: { saving: true, failed: 2 }, memoStatus: "error", lessonSaveFailed: true }), { saving: "저장 중", failed: "출석 저장 실패 2 · 메모 저장 실패 · 수업 내용 저장 실패" });
  assert.match(workspace, /workspaceSaveStatus\(\{ attendance: saveBadge, memoStatus, lessonSaveFailed \}\)/);
  assert.match(workspace, /onAttendanceStatus\?\.\(\{ summary: attendanceSummary, saving: saveStatus\.saving, failed: saveStatus\.failed \}\)/);
  // 홈 줄 머리·출석부 머리줄: 저장 중 = 중립, 저장 실패 = 위험색
  assert.match(home, /\{liveStatus\.saving && <span className="[^"]*bg-\[var\(--color-academy-soft\)\][^"]*text-\[var\(--color-academy-muted\)\]">/);
  assert.match(home, /\{liveStatus\.failed && <span className="[^"]*bg-\[var\(--color-academy-danger-soft\)\][^"]*text-\[var\(--color-academy-danger\)\]">/);
  assert.match(workspace, /\{saveBadge\.saving && <span className="rounded bg-\[var\(--color-academy-soft\)\][^"]*">저장 중<\/span>\}\s*\{saveBadge\.failed > 0 && <span className="rounded bg-\[var\(--color-academy-danger-soft\)\][^"]*">저장 실패 \{saveBadge\.failed\}<\/span>\}/);
});

test("권장 5·6·9: 수업 중에도 미리 쓴 내용을 읽을 수 있고, 홈은 막대만큼 끝 여백을 두며, 글칸은 음성·저장을 따로 센다", () => {
  assert.match(workspace, /\{plan && \([\s\S]{0,300}aria-expanded=\{showPlan\} aria-controls="session-plan"[\s\S]{0,500}\{showPlan && \(\s*<div id="session-plan"[^>]*>\s*<p[^>]*>\{plan\}<\/p>/);
  // 2026-11-15 원장 점검: 수업 중 아래 탭 숨김·시작 취소 위험 버튼 — 탭이 숨은 만큼 끝 여백은 줄었다(막대가 마지막 줄을 가리지 않을 만큼)
  assert.match(home, /\{liveLessonOpen && <div aria-hidden="true" className="h-12" \/>\}/);
  assert.match(editor, /busyRef\.current\[kind\] = busy;\s*onBusyChange\?\.\(busyRef\.current\.voice \|\| busyRef\.current\.saving\);/);
  assert.match(editor, /onBusyChange=\{\(busy\) => reportBusy\("voice", busy\)\}/);
  assert.doesNotMatch(editor, /onBusyChange\?\.\((true|false)\)/);
});

test("권장 7: 갤러리에서 고른 것 중 막힌 쪽은 보내지 않고 이유를 알린다", () => {
  const images = [{ name: "a.jpg" }];
  const video = { name: "b.mp4" };
  assert.deepEqual(rules.planGalleryUpload({ images, video, photoAvailable: true, videoAvailable: true }), { images, video, blocked: "" });
  assert.deepEqual(rules.planGalleryUpload({ images, video, photoAvailable: true, videoAvailable: false, videoReason: "영상은 1개까지 올릴 수 있어요." }), { images, video: null, blocked: "영상은 1개까지 올릴 수 있어요." });
  assert.deepEqual(rules.planGalleryUpload({ images, video, photoAvailable: false, videoAvailable: true }), { images: [], video, blocked: "사진은 지금 올릴 수 없어요." });
  // 막힌 쪽 파일을 고르지 않았으면 안내도 없다
  assert.equal(rules.planGalleryUpload({ images: [], video, photoAvailable: false, videoAvailable: true }).blocked, "");
  assert.match(mediaBar, /const plan = planGalleryUpload\(\{[\s\S]{0,600}\}\);[\s\S]{0,200}sendPhotos\(plan\.images\);\s*sendVideo\(plan\.video\);/);
  assert.doesNotMatch(mediaBar, /sendPhotos\(split\.images\)|sendVideo\(split\.video\)/);
});

// ── 2026-11-15 원장 점검: 수업 중 아래 탭 숨김·시작 취소 위험 버튼 ──

test("원장 점검 1: 홈에서 진행 중 수업 칸이 펼쳐져 있는 동안 아래 탭을 숨기고, 접거나 떠나면 푼다", async () => {
  const navigation = read("src/app/staff/staffNavigation.ts");
  const nav = read("src/app/staff/StaffBottomNav.tsx");
  // 신호를 실제로 돌려 본다(브라우저 전역 대역)
  const events = [];
  globalThis.document = { documentElement: { dataset: {} } };
  globalThis.window = { dispatchEvent: (event) => { events.push(event.type); return true; } };
  try {
    const signal = await loadTsModule("src/app/staff/staffNavigation.ts");
    assert.equal(signal.isStaffLiveLessonOpen(), false);
    signal.setStaffLiveLessonOpen(true);
    assert.equal(signal.isStaffLiveLessonOpen(), true);
    signal.setStaffLiveLessonOpen(false);
    assert.equal(signal.isStaffLiveLessonOpen(), false);
    assert.equal("staffLiveLesson" in document.documentElement.dataset, false, "표시가 남지 않는다");
    assert.deepEqual(events, [signal.STAFF_LIVE_LESSON_EVENT, signal.STAFF_LIVE_LESSON_EVENT]);
    // 듣기·그만 듣기
    const calls = [];
    window.addEventListener = (type) => calls.push(`add:${type}`);
    window.removeEventListener = (type) => calls.push(`remove:${type}`);
    signal.subscribeStaffLiveLesson(() => {})();
    assert.deepEqual(calls, ["add:staff:live-lesson", "remove:staff:live-lesson"]);
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
  // 홈: 펼친 줄이 진행 중 수업일 때만 켜고, 줄을 접거나(값이 바뀜)·화면이 사라질 때 끈다. 수업 전·완료 줄은 켜지 않는다
  assert.match(home, /const liveLessonOpen = expandedLesson\?\.sessionStatus === "IN_PROGRESS";\s*useEffect\(\(\) => \{\s*if \(!liveLessonOpen\) return;\s*setStaffLiveLessonOpen\(true\);\s*return \(\) => setStaffLiveLessonOpen\(false\);\s*\}, \[liveLessonOpen\]\);/);
  // 아래 탭: 신호를 듣고(처음 뜰 때도 한 번 읽는다) 홈에서만 숨는다. 수업 주소에서 숨는 것은 그대로
  assert.match(nav, /const liveLessonOpen = useSyncExternalStore\(subscribeStaffLiveLesson, isStaffLiveLessonOpen, \(\) => false\);/);
  assert.match(nav, /if \(liveLessonOpen && pathname === "\/staff"\) return null;/);
  assert.match(nav, /if \(pathname\.startsWith\("\/staff\/sessions\/"\)\) return null;/);
  // 탭 이동 전 메모 저장은 그대로
  assert.match(nav, /const result = await prepareStaffNavigation\(\);/);
  assert.match(navigation, /staff:prepare-navigation/);
  // 탭이 숨은 동안 나가는 길: 펼친 줄 머리 전체가 접기 버튼이다
  assert.match(home, /role="button"\s+tabIndex=\{0\}\s+aria-expanded=\{expandedKey === focusClass\.scheduleKey\}\s+aria-controls=\{lessonBodyId\(focusClass\)\}\s+onClick=\{\(\) => void toggleLesson\(focusClass\)\}/);
});

test("원장 점검 2: «수업 시작 취소»는 빨간 위험 버튼 하나(칸 전체 폭·44px 이상), 확인·메모 먼저 저장은 그대로", () => {
  const block = workspace.slice(workspace.indexOf('<div id="session-cancel-start"'), workspace.indexOf("{showPeople && <ClassPeopleSheet"));
  assert.equal((block.match(/<button/g) ?? []).length, 1, "그 자리의 버튼은 하나");
  assert.doesNotMatch(block, /<a |academy-button-text|academy-button-secondary/);
  assert.match(block, /<button type="button" disabled=\{actionsLocked\} onClick=\{cancelStart\} className="academy-button-danger min-h-12! w-full">\s*수업 시작 취소/);
  // 설명 한 줄은 버튼 위에
  assert.ok(block.indexOf("시작을 취소해도 기록한 출결은 유지됩니다.") < block.indexOf("<button"));
  // 꽉 찬 빨강은 여전히 «종료 확인» 창의 최종 버튼 하나
  assert.equal((workspace.match(/academy-button-danger-solid/g) ?? []).length, 1);
  assert.match(workspace, /window\.confirm\("수업 시작을 취소하고 '시작 전' 상태로 되돌릴까요\? \(기록한 출결은 그대로 유지됩니다\)"\)/);
  assert.match(workspace, /const memoSaved = await persistMemo\(memoRef\.current\);[\s\S]{0,300}await cancelClassSession\(\{ sessionId: session\.id \}\)/);
});

// ── 2026-11-15 원장 점검: 새로고침 직후 아래 탭 깜빡임 ──

test("원장 점검 3: 진행 중 수업이 있으면 서버가 그린 첫 화면부터 아래 탭이 숨어 있다(보였다 사라지지 않는다)", () => {
  // 첫 그림의 값은 서버가 넘긴 오늘 수업 목록에서 바로 나온다 — 진행 중 수업이 있으면 그 줄이 펼쳐진 채로 열리고(초기값), 그때만 참이다
  assert.match(home, /useState<string \| null>\(\(\) => initialClasses\.find\(\(lesson\) => lesson\.sessionStatus === "IN_PROGRESS"\)\?\.scheduleKey \?\? null\)/);
  assert.match(home, /const expandedLesson = classes\.find\(\(lesson\) => lesson\.scheduleKey === expandedKey\) \?\? null;/);
  assert.match(home, /const liveLessonOpen = expandedLesson\?\.sessionStatus === "IN_PROGRESS";/);
  // 효과(화면이 뜬 뒤)가 아니라 «그림 자체»에 탭 숨김 규칙이 들어 있다 → 서버 그림에도 실린다
  assert.match(home, /\{liveLessonOpen && <style>\{"\.academy-app \.academy-staff-nav\{display:none!important\}"\}<\/style>\}/);
  // 규칙이 가리키는 것이 실제 아래 탭과 테마 루트다
  const nav = read("src/app/staff/StaffBottomNav.tsx");
  assert.match(nav, /<nav aria-label="교사용 주요 메뉴" className="academy-staff-nav /);
  assert.match(read("src/components/academy/AcademyTheme.tsx"), /className=\{`academy-app \$\{className\}`\}/);
  // 탭은 서버에서 «보임»으로 그려지고(진행 중 수업이 없는 평소 홈은 처음부터 보인다) 위 규칙이 있을 때만 가려진다 — 반대 방향 깜빡임 없음
  assert.match(nav, /useSyncExternalStore\(subscribeStaffLiveLesson, isStaffLiveLessonOpen, \(\) => false\)/);
  // 끝 여백도 같은 값으로 첫 그림부터 맞는다
  assert.match(home, /\{liveLessonOpen && <div aria-hidden="true" className="h-12" \/>\}/);
  // 새 조회를 더하지 않았다 — 홈 페이지의 오늘 수업 조회 한 번 그대로
  const page = read("src/app/staff/page.tsx");
  assert.equal((page.match(/getTodayStaffClasses\(/g) ?? []).length, 1);
  assert.doesNotMatch(read("src/app/staff/layout.tsx"), /getTodayStaffClasses/);
});

// ── 2026-11-15 원장 점검: [동영상]이 회색인데 이유가 안 보이던 문제 ──

test("원장 점검 4: [사진]·[동영상]이 눌리지 않는 이유를 막대에 항상 보인다(영상만 막힌 경우·조회 실패 포함)", () => {
  const ready = { busy: false, canUpload: true, windowMessage: null, loaded: true, loadError: "" };
  // 사진은 되고 영상만 막힌 상태 → 영상 이유가 나온다(예전엔 사진 쪽 이유만 보였다)
  assert.equal(rules.mediaBlockReason("photo", ready), null);
  assert.deepEqual(rules.mediaBlockReason("video", { ...ready, canUpload: false, windowMessage: "수정 기간이 지났습니다." }), { text: "수정 기간이 지났습니다.", retry: false });
  // 이유 문구가 없어도 빈 줄로 두지 않는다
  assert.deepEqual(rules.mediaBlockReason("video", { ...ready, canUpload: false }), { text: "영상은 지금 올릴 수 없어요.", retry: false });
  // 아직 읽는 중(상태 없음 포함) → 준비 중
  assert.deepEqual(rules.mediaBlockReason("video", null), { text: "영상 올리기 준비 중…", retry: false });
  assert.deepEqual(rules.mediaBlockReason("photo", { ...ready, canUpload: false, loaded: false }), { text: "사진 올리기 준비 중…", retry: false });
  // 조회 실패 → 안내 + 다시 시도
  // (2026-11-15 검수) 서버가 준 문구가 있으면 그것을 보이고, 없을 때만 고정 문구
  assert.deepEqual(rules.mediaBlockReason("video", { ...ready, canUpload: false, loaded: false, loadError: "영상 목록을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요." }), { text: "영상 목록을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.", retry: true });
  assert.deepEqual(rules.mediaBlockReason("video", { ...ready, canUpload: false, loaded: false, loadError: "  " }), { text: "영상 정보를 불러오지 못했어요.", retry: true });
  // 다시 로그인해야 풀리는 문제·권한 문제에는 «다시 시도»를 붙이지 않는다(헛돈다)
  assert.deepEqual(rules.mediaBlockReason("video", { ...ready, canUpload: false, loaded: false, loadError: "로그인이 풀렸습니다. 다시 로그인해 주세요." }), { text: "로그인이 풀렸습니다. 다시 로그인해 주세요.", retry: false });
  assert.equal(rules.mediaBlockReason("photo", { ...ready, canUpload: false, loaded: false, loadError: "담당 수업에만 접근할 수 있습니다. 권한을 확인해 주세요." }).retry, false);
  // 올릴 수 있거나 올리는 중이면 이유 줄이 없다(진행 줄이 따로 있다)
  assert.equal(rules.mediaBlockReason("video", ready), null);
  assert.equal(rules.mediaBlockReason("video", { ...ready, canUpload: false, busy: true }), null);

  // 막대: 두 쪽 이유를 한 줄씩, 다시 시도는 그 부품의 재조회를 부른다
  assert.match(mediaBar, /reason: mediaBlockReason\("photo", photoState\) \}/);
  assert.match(mediaBar, /reason: mediaBlockReason\("video", videoState\) \}/);
  assert.match(mediaBar, /if \(kind === "photo"\) photoRef\.current\?\.reload\(\);\s*else videoRef\.current\?\.reload\(\);/);
  assert.match(mediaBar, /\{reason\.retry && <button type="button" onClick=\{\(\) => retryLoad\(kind\)\} className="[^"]*min-h-11![^"]*">다시 시도<\/button>\}/);
  // 영상 부품: 읽었는가·읽기 실패를 알리고, 다시 읽으면 실패 표시를 지우고 성공하면 «읽음»이 된다
  const video = read("src/components/staff/SessionVideoUploader.tsx");
  assert.match(video, /function reload\(\) \{\s*setLoadError\(""\);\s*void load\(\)\.then\(\(\) => \{\s*setLoaded\(true\);[\s\S]{0,700}setLoadError\(text\);/);
  assert.match(video, /needsAppUpdate, loaded, loadError \}\)/);
  assert.match(read("src/components/staff/SessionPhotoUploader.tsx"), /windowMessage, loaded, loadError \}\)/);
  // 끝난 수업: 칸을 펼치지 않아도 머리줄에 영상 이유
  assert.match(panels, /summary=\{videoBlock \? `영상: \$\{videoBlock\.text\}` : editable \? /);
});

test("원장 점검 5: 옛 안드로이드 앱 안내에 스토어 «업데이트» 링크(앱이 열 수 있는 https 주소만)", async () => {
  assert.match(mediaBar, /const updateUrl = videoState\?\.needsAppUpdate \? appUpdateTarget\(window\.navigator\.userAgent\)\.url : null;/);
  assert.match(mediaBar, /\{updateUrl && <> <a href=\{updateUrl\} className="[^"]*min-h-11[^"]*">업데이트<\/a><\/>\}/);
  assert.doesNotMatch(mediaBar, /market:\/\//);
  const links = await loadTsModule("src/lib/app-install-links.ts");
  const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S911N) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36";
  const withMark = links.appUpdateTarget(`${ANDROID} STIZApp/1.0.2 (android)`).url;
  assert.match(withMark, /^https:\/\/play\.google\.com\//);
  // 표식 없는 옛 앱은 바깥 주소를 못 연다 → 주소 없음(글자 안내만)
  assert.equal(links.appUpdateTarget(ANDROID).url, null);
});

// ── 2026-11-15 검수: 멈춘 조회·멈춘 올리기·막대 높이·라우트 오류 구분 ──

test("검수 1: 목록 조회가 답 없이 멈추면 제한 시간 뒤 실패로 떨어진다(«준비 중…»에 머물지 않는다)", async () => {
  const net = await loadTsModule("src/components/staff/fetchWithTimeout.ts");
  assert.equal(net.LIST_FETCH_TIMEOUT_MS, 10_000);
  // 끝내 답하지 않는 조회(끊으면 그제야 실패) — 20ms 제한으로 돌려 본다
  const hang = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  await assert.rejects(net.fetchWithTimeout("/x", {}, { timeoutMs: 20, fetchImpl: hang }), { message: net.FETCH_TIMEOUT_MESSAGE });
  // 제때 답하면 그대로 돌려주고, 다른 오류는 문구를 바꾸지 않는다
  assert.equal(await net.fetchWithTimeout("/x", {}, { timeoutMs: 1000, fetchImpl: async () => "ok" }), "ok");
  await assert.rejects(net.fetchWithTimeout("/x", {}, { timeoutMs: 1000, fetchImpl: async () => { throw new Error("Failed to fetch"); } }), { message: "Failed to fetch" });
  // 화면이 사라져 바깥 신호가 끊기면 함께 끊긴다(시간 초과 문구가 아니다)
  const outer = new AbortController();
  const pending = net.fetchWithTimeout("/x", {}, { timeoutMs: 1000, signal: outer.signal, fetchImpl: hang });
  outer.abort();
  await assert.rejects(pending, { message: "aborted" });
  // 실패 상태 → 막대에 안내 + 다시 시도
  const failed = rules.mediaBlockReason("video", { busy: false, canUpload: false, windowMessage: null, loaded: false, loadError: net.FETCH_TIMEOUT_MESSAGE });
  assert.deepEqual(failed, { text: net.FETCH_TIMEOUT_MESSAGE, retry: true });
  // 사진·영상 목록 조회 둘 다 이 함수를 쓰고, 화면이 사라지면 끊는다
  for (const file of ["src/components/staff/SessionVideoUploader.tsx", "src/components/staff/SessionPhotoUploader.tsx"]) {
    const source = read(file);
    assert.match(source, /await fetchWithTimeout\([\s\S]{0,120}\{ cache: "no-store" \}, \{ signal: unmountRef\.current\?\.signal \}\)/, file);
    assert.match(source, /unmountRef\.current = controller;\s*return \(\) => controller\.abort\(\);/, file);
    // 다시 시도가 성공하면 앞서 띄운 실패 문구를 지운다
    assert.match(source, /if \(failedText\) setMessage\(\(current\) => \(current === failedText \? "" : current\)\);/, file);
  }
});

test("검수 6: 올리기가 60초 동안 나아가지 않으면 끊고 실패로 알린다(진행이 있으면 시간을 다시 잰다)", async () => {
  const net = await loadTsModule("src/components/staff/fetchWithTimeout.ts");
  assert.equal(net.UPLOAD_STALL_TIMEOUT_MS, 60_000);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let stalls = 0;
  const watch = net.createStallWatch(() => { stalls += 1; }, 40);
  watch.touch();
  await wait(25); watch.touch(); // 진행이 있었다 → 다시 잰다
  await wait(25);
  assert.equal(stalls, 0);
  await wait(40);
  assert.equal(stalls, 1, "무진행이면 한 번 알린다");
  watch.touch(); await wait(60);
  assert.equal(stalls, 1, "한 번 멈춘 뒤에는 다시 알리지 않는다");
  // 끝낸 감시는 알리지 않는다
  let late = 0;
  const done = net.createStallWatch(() => { late += 1; }, 20);
  done.touch(); done.stop(); await wait(40);
  assert.equal(late, 0);
  const video = read("src/components/staff/SessionVideoUploader.tsx");
  assert.match(video, /const watch = createStallWatch\(\(\) => \{ stalled = true; xhr\.abort\(\); \}\);/);
  assert.match(video, /xhr\.upload\.onprogress = \(event\) => \{\s*watch\.touch\(\);/);
  assert.match(video, /reject\(new Error\(stalled \? UPLOAD_STALLED_MESSAGE : "영상 업로드가 취소되었습니다\."\)\)/);
});

test("검수 2: 막대가 안내 줄로 높아지면 그만큼 본문 끝을 더 띄운다", () => {
  assert.equal(rules.MEDIA_BAR_BASE_HEIGHT_PX, 100);
  assert.equal(rules.mediaBarExtraSpace(0), 0, "아직 재지 못함");
  assert.equal(rules.mediaBarExtraSpace(72), 0, "버튼 한 줄");
  assert.equal(rules.mediaBarExtraSpace(100), 0);
  assert.equal(rules.mediaBarExtraSpace(154.2), 55, "옛 앱 안내 + 업데이트 링크");
  assert.equal(rules.mediaBarExtraSpace(170), 70, "사진·영상 둘 다 조회 실패");
  assert.equal(rules.mediaBarExtraSpace(Number.NaN), 0);
  assert.match(mediaBar, /new ResizeObserver\(\(\) => setBarHeight\(bar\.offsetHeight\)\);\s*observer\.observe\(bar\);\s*return \(\) => observer\.disconnect\(\);/);
  assert.match(mediaBar, /<div aria-hidden="true" style=\{\{ height: mediaBarExtraSpace\(barHeight\) \}\} \/>/);
});

test("검수 7: 영상 목록 라우트는 로그인 만료 401 · 권한 403 · 그 밖 500 으로 가르고, 원인은 서버 로그에만 남긴다", () => {
  const route = read("src/app/api/staff/sessions/[sessionId]/videos/route.ts");
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  // 권한 판정은 그대로
  assert.match(get, /const \{ access \} = await requireStaffSessionAccess\(sessionId\);/);
  assert.match(get, /if \(kind === "login" && access\) return NextResponse\.json\(\{ error: access\.message \}, \{ status: 401 \}\);/);
  assert.match(get, /if \(kind === "forbidden" && access\) return NextResponse\.json\(\{ error: access\.message \}, \{ status: 403 \}\);/);
  assert.match(get, /잠시 뒤 다시 시도해 주세요\." \}, \{ status: 500 \}\);/);
  assert.equal((get.match(/status: 403/g) ?? []).length, 1, "403 은 권한 문제 하나뿐");
  // 로그: 수업 id·오류 종류·주소의 물음표 뒤를 지운 짧은 글만(토큰·서명이 섞이지 않게), 화면에는 원문을 보내지 않는다
  assert.match(get, /reason: raw\.replace\(\/\\\?\[\^\\s"'\]\*\/g, "\?…"\)\.slice\(0, 200\),/);
  assert.doesNotMatch(get, /error: raw/);
});
