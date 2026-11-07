import { prisma } from "@/lib/prisma";
import { classifyParentUtterance, type KakaoQuickReply } from "@/lib/kakao-chatbot-contract";
import { cancelRegularAbsence, getUpcomingRegularClassDates, reportRegularAbsence } from "@/lib/regular/parent-regular-absence";
import { REASON_LABEL, VALID_REASONS, type AbsenceReason } from "@/lib/regular/regularAbsenceRules";
import { kstLabel, todayKst } from "@/lib/datetime/kst";
import {
  answerOf, clipText, createFlowStore, FLOW_MENU_TEXT, flowReply, MAIN_MENU, numberQuickReplies,
  parseKoreanDateYmd, parseNumberPick, pickChild, YES,
  type BaseFlowState, type FlowChild, type FlowRow, type Reply, type WebLink,
} from "@/lib/kakao-flow-store";

// ── 카카오 「정규수업 결석 신청·취소」 대화 흐름 (연결된 학부모 전용) ───────────────
//
// 왜 대화 안에서 하나: 지금까지는 결석 화면 링크만 줬다. 사이트 오픈 전에는 학부모가 마이페이지를
// 못 쓰므로, 보강 흐름(kakao-makeup-flow)과 같은 방식으로 카톡 대화만으로 끝낸다. 링크는 보조 버튼.
//
// 흐름: 자녀 → 다가오는 수업일 번호 → 사유 → 확정 → reportRegularAbsence
//       결석 취소: 예정 결석 목록 → 번호 → 확정 → cancelRegularAbsence
//
// ★ 규칙은 새로 만들지 않는다. 미래 날짜·요일 일치·관리자 확정건 보호·원장/코치/기사 알림은 전부
//   parent-regular-absence.ts(웹과 같은 함수)가 한다. 그래서 웹과 결과가 같다.
// ★ IDOR: 학부모는 번호만 보낸다. 반 id·결석 id 는 서버가 만든 목록(대화 상태)에서만 꺼내고,
//   저장 함수가 다시 "이 보호자 자녀의 ACTIVE 수강인가"를 SQL 로 확인한다(이중 방어).
// ★ 오늘 결석은 이 흐름에서 받지 않는다(웹과 같은 규칙 — 미래 수업일만). 원장님께 바로 알리는 버튼을 준다.

export const ABSENCE_FLOW_STATUS = "ABSENCE_FLOW";
/** 수업일 목록을 계산할 주 수, 한 번에 보여 주는 후보 수(바로가기 10개 = 번호 8 + 오늘 결석 + 그만) */
export const ABSENCE_WEEKS = 4;
export const ABSENCE_MAX_CANDIDATES = 8;

export type AbsenceCandidate = { classId: string; date: string; label: string };
type AbsenceRecord = { id: string; studentName: string; date: string; label: string };

type AbsenceState = BaseFlowState & {
  mode: "REPORT" | "CANCEL";
  step: "DATE" | "REASON" | "CONFIRM" | "SAVING" | "CANCEL_PICK" | "CANCEL_CONFIRM" | "CANCELING";
  studentName: string | null;
  dates?: AbsenceCandidate[];
  chosen?: AbsenceCandidate;
  reason?: AbsenceReason;
  records?: AbsenceRecord[];
  record?: AbsenceRecord;
};

const store = createFlowStore<AbsenceState>({ status: ABSENCE_FLOW_STATUS, kind: "REGULAR_ABSENCE" });

// 바로가기가 보내는 문장. 모두 '결석'을 품고 있어서, 30분이 지나 상태가 사라진 뒤 눌러도
// 엉뚱한 접수로 새지 않고 결석 흐름을 처음부터 다시 시작한다.
const PICK_DATE = "결석 날짜";
const PICK_REASON = "결석 사유";
const PICK_RECORD = "결석 취소";
const CONFIRM_REPORT = "결석 신청 확정";
const CONFIRM_CANCEL = "결석 취소 확정";
const STOP = "결석 그만";
const STOP_REPLY = { label: "그만하기", messageText: STOP };
// 「원장님」이 들어 있어 상담원 연결(HUMAN) 접수로 간다 — 오늘 결석은 원장님이 직접 확인한다.
const TODAY_ABSENCE = { label: "오늘 결석 알리기", messageText: "원장님께 오늘 결석 알릴게요" };

const REPORT_YES = /^((네|넵|예|좋아요) ?)?(신청|신청할게요|신청해 ?주세요|결석할게요)$/;
const CANCEL_YES = /^((네|넵|예) ?)?(취소할게요|취소해 ?주세요)$/;
const ABORT = /^(그만|그만하기|그만할게요|아니요|아니오|취소|취소할게요|결석 그만)$/;
const SHORT_ANSWER = /^(\d{1,2}\s*번?|네|예|확인|맞아요|진행|신청|신청할게요)$/;
const STALE_CONTROL = /^결석 (날짜 \d{1,2}번|사유 .{1,10}|취소 \d{1,2}번|신청 확정|취소 확정)$/;

/** 사유 바로가기(라벨 그대로) — 순서는 VALID_REASONS */
const REASON_REPLIES: KakaoQuickReply[] = VALID_REASONS.map((code) => ({ label: REASON_LABEL[code], messageText: `${PICK_REASON} ${REASON_LABEL[code]}` }));

/**
 * 사유 말을 코드로 바꾼다(순수 함수 — 테스트 대상). 「결석 사유 질병/부상」 버튼, 번호, 흔한 표현을 읽는다.
 * 못 읽으면 null(엉뚱한 말을 「기타」로 삼키지 않는다).
 */
export function parseAbsenceReason(text: string): AbsenceReason | null {
  const value = answerOf(text.replace(new RegExp(`^${PICK_REASON}\\s*`), ""));
  const byLabel = VALID_REASONS.find((code) => REASON_LABEL[code] === value);
  if (byLabel) return byLabel;
  const pick = /^(\d)\s*번?$/.exec(value);
  if (pick) return VALID_REASONS[Number(pick[1]) - 1] ?? null;
  if (/아프|아파|아픈|병원|감기|열이|열나|독감|다쳐|다친|부상|질병|장염|코로나|몸살/.test(value)) return "ILLNESS_INJURY";
  if (/여행|가족\s*여행|놀러/.test(value)) return "FAMILY_TRIP";
  if (/학교|행사|시험|소풍|수련회|체험학습/.test(value)) return "SCHOOL_EVENT";
  if (/개인|사정|집안|일정|약속|경조사/.test(value)) return "PERSONAL";
  if (/^기타$/.test(value)) return "ETC";
  return null;
}

/**
 * parent-regular-absence 가 준 반별 수업일을 「날짜·시간 순 후보」로 펼친다(순수 함수 — 테스트 대상).
 * 이미 결석 신청된 날은 뺀다. 최대 8개.
 */
export function buildAbsenceCandidates(
  classes: Array<{ classId: string; className: string; startTime: string; dates: Array<{ date: string; reported: boolean }> }>,
  limit = ABSENCE_MAX_CANDIDATES,
): AbsenceCandidate[] {
  const flat = classes.flatMap((item) => item.dates
    .filter((date) => !date.reported)
    .map((date) => ({
      classId: item.classId,
      date: date.date,
      startTime: item.startTime,
      label: `${kstLabel(date.date)} ${item.startTime} ${clipText(item.className)}`,
    })));
  flat.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  return flat.slice(0, limit).map(({ classId, date, label }) => ({ classId, date, label }));
}

/** 저장 함수의 오류 코드를 학부모가 알아듣는 말로 */
function absenceErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "NOT_REPORTABLE_DATE") return "지난 날짜이거나 그 반 수업 요일이 아니에요.";
  if (code === "NOT_OWNER") return "지금 다니는 반의 수업이 아니에요.";
  if (code === "ABSENCE_NOT_CANCELABLE") return "원장님이 이미 확인(확정)한 결석이라 카톡으로는 바꿀 수 없어요.";
  return "잠시 처리가 원활하지 않았어요.";
}

// ── DB 읽기(모두 보호자 소유 조건 포함) ─────────────────────────────────────

/** 이 보호자 자녀의 예정 결석(REPORTED, 내일 이후). 오늘 결석은 원장님께 직접 연락하도록 뺀다. */
async function upcomingAbsences(parentUserId: string, studentId: string | null, today: string): Promise<AbsenceRecord[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; studentName: string; date: string; className: string | null; startTime: string | null }>>(
    `SELECT ra.id, s.name AS "studentName", to_char(ra.date,'YYYY-MM-DD') AS "date", c.name AS "className", c."startTime"
       FROM "RegularAbsence" ra
       JOIN "Student" s ON s.id=ra."studentId" AND s."parentId"=$1 AND s."mergedIntoStudentId" IS NULL
       LEFT JOIN "Class" c ON c.id=ra."classId"
      WHERE ra.status='REPORTED' AND ra.date>$2::date AND ($3::text IS NULL OR ra."studentId"=$3)
      ORDER BY ra.date ASC, c."startTime" ASC LIMIT ${ABSENCE_MAX_CANDIDATES}`,
    parentUserId, today, studentId,
  );
  return rows.map((row) => ({
    id: row.id,
    studentName: row.studentName,
    date: row.date,
    label: `${kstLabel(row.date)} ${row.startTime ?? ""} ${clipText(row.className)}`.replace(/\s+/g, " ").trim(),
  }));
}

// ── 말풍선 ─────────────────────────────────────────────────────────────

function dateListReply(state: AbsenceState, webLink: WebLink | null, lead = ""): Reply {
  const dates = state.dates ?? [];
  const lines = dates.map((item, index) => `${index + 1}. ${item.label}`).join("\n");
  return flowReply(
    `${lead}${state.studentName} 학생의 다가오는 수업이에요. 결석할 날 번호를 골라 주세요.\n\n${lines}\n\n오늘 수업 결석은 「오늘 결석 알리기」로 원장님께 바로 알려 주세요.`,
    [...numberQuickReplies(dates.length, PICK_DATE), TODAY_ABSENCE, STOP_REPLY],
    webLink,
  );
}

function reasonReply(state: AbsenceState, lead = ""): Reply {
  return flowReply(
    `${lead}${state.studentName} 학생 ${state.chosen?.label} 결석이에요. 사유를 골라 주세요.`,
    [...REASON_REPLIES, STOP_REPLY],
  );
}

function confirmReply(state: AbsenceState, lead = ""): Reply {
  return flowReply(
    `${lead}${state.studentName} 학생 결석 신청 내용이에요.\n\n· 수업: ${state.chosen?.label}\n· 사유: ${state.reason ? REASON_LABEL[state.reason] : ""}\n\n이대로 결석 신청할까요? 그날 셔틀도 함께 빠져요.`,
    [{ label: "신청할게요", messageText: CONFIRM_REPORT }, { label: "다른 날", messageText: state.studentName ? `${state.studentName} 결석 신청` : "결석 신청" }, STOP_REPLY],
  );
}

function recordListReply(state: AbsenceState, webLink: WebLink | null, lead = ""): Reply {
  const items = state.records ?? [];
  const many = new Set(items.map((item) => item.studentName)).size > 1;
  const lines = items.map((item, index) => `${index + 1}. ${many ? `${item.studentName} · ` : ""}${item.label}`).join("\n");
  return flowReply(
    `${lead}신청된 결석이에요. 취소할 번호를 골라 주세요.\n\n${lines}`,
    [...numberQuickReplies(items.length, PICK_RECORD), STOP_REPLY],
    webLink,
  );
}

function cancelConfirmReply(state: AbsenceState, lead = ""): Reply {
  const item = state.record!;
  return flowReply(
    `${lead}${item.studentName} 학생 ${item.label} 결석 신청을 취소할까요? 취소하면 그날 수업에 오는 것으로 바뀌어요.`,
    [{ label: "취소할게요", messageText: CONFIRM_CANCEL }, STOP_REPLY],
  );
}

function renderStep(state: AbsenceState, webLink: WebLink | null, lead = ""): Reply {
  switch (state.step) {
    case "DATE": return dateListReply(state, webLink, lead);
    case "REASON": return reasonReply(state, lead);
    case "CONFIRM": return confirmReply(state, lead);
    case "CANCEL_PICK": return recordListReply(state, webLink, lead);
    case "CANCEL_CONFIRM": return cancelConfirmReply(state, lead);
    default: return flowReply("방금 요청을 처리하고 있어요. 잠시 후 「결석 신청」이라고 다시 말씀해 주세요.", ["메뉴"]);
  }
}

// ── 단계별 처리 ─────────────────────────────────────────────────────────

export type AbsenceFlowInput = {
  identityId: string;
  parentUserId: string;
  children: FlowChild[];
  text: string;
  webLink: WebLink | null;
};

async function startReport(input: AbsenceFlowInput, child: FlowChild, lead: string): Promise<Reply> {
  const today = todayKst();
  const upcoming = await getUpcomingRegularClassDates(input.parentUserId, ABSENCE_WEEKS);
  const mine = upcoming.find((item) => item.studentId === child.id);
  const dates = buildAbsenceCandidates(mine?.classes ?? []);
  if (dates.length === 0) {
    await store.open(input.identityId, input.text, null);
    return flowReply(
      `${lead}${child.name} 학생은 앞으로 ${ABSENCE_WEEKS}주 안에 결석 신청할 수 있는 정규 수업이 없어요(이미 신청했거나 수강 중인 반이 없어요). 오늘 수업 결석이면 원장님께 바로 알려 주세요.`,
      [TODAY_ABSENCE, "결석 취소", "메뉴"],
      input.webLink,
    );
  }
  const base: AbsenceState = { v: 1, parentUserId: input.parentUserId, mode: "REPORT", step: "DATE", studentId: child.id, studentName: child.name, dates };
  // 문장에 날짜가 있고(「내일 결석할게요」「11/20 결석」) 그날 수업이 하나뿐이면 날짜 고르기를 건너뛴다.
  const said = parseKoreanDateYmd(input.text, today);
  const sameDay = said ? dates.filter((item) => item.date === said) : [];
  const state: AbsenceState = sameDay.length === 1 ? { ...base, step: "REASON", chosen: sameDay[0] } : base;
  const flowId = await store.open(input.identityId, input.text, state);
  if (!flowId) return flowReply("결석 신청을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.", ["결석 신청"]);
  if (state.step === "REASON") return reasonReply(state, lead);
  const todayLead = said === today ? "오늘 수업은 여기서 신청할 수 없어요(내일 수업부터). 오늘 결석은 「오늘 결석 알리기」를 눌러 주세요.\n\n" : "";
  return dateListReply(state, input.webLink, `${lead}${todayLead}`);
}

async function startCancel(input: AbsenceFlowInput, child: FlowChild | null, lead: string): Promise<Reply> {
  const today = todayKst();
  const records = await upcomingAbsences(input.parentUserId, child?.id ?? null, today);
  if (records.length === 0) {
    await store.open(input.identityId, input.text, null);
    return flowReply(`${lead}${child ? `${child.name} 학생은 ` : ""}취소할 수 있는 결석 신청이 없어요(내일 이후 신청분만 카톡으로 취소돼요). 오늘 결석을 취소하려면 원장님께 알려 주세요.`, ["결석 신청", "메뉴"]);
  }
  const state: AbsenceState = { v: 1, parentUserId: input.parentUserId, mode: "CANCEL", step: "CANCEL_PICK", studentId: child?.id ?? null, studentName: child?.name ?? null, records };
  const flowId = await store.open(input.identityId, input.text, state);
  if (!flowId) return flowReply("결석 취소를 시작하지 못했어요. 잠시 후 다시 시도해 주세요.", ["결석 취소"]);
  return recordListReply(state, input.webLink, lead);
}

/** 확정 → 실제 결석 신청(reportRegularAbsence — 웹과 같은 함수) */
async function confirmReport(flow: FlowRow<AbsenceState>): Promise<Reply> {
  const state = flow.state;
  const chosen = state.chosen;
  if (!chosen || !state.reason || !state.studentId) return renderStep({ ...state, step: "DATE" }, null);
  // 선점: CONFIRM → SAVING. 같은 확정이 두 번 와도 신청은 한 번만 시도한다.
  if (!(await store.advance(flow.id, "CONFIRM", { ...state, step: "SAVING" }))) {
    return flowReply("이미 처리 중이거나 처리된 신청이에요.", ["결석 취소", "메뉴"]);
  }
  try {
    // ★ 서버 재검증: 소유권·ACTIVE 수강·미래·요일은 reportRegularAbsence 가 다시 본다(대화 상태를 믿지 않는다).
    await reportRegularAbsence(state.parentUserId, { studentId: state.studentId, classId: chosen.classId, date: chosen.date, reason: state.reason });
  } catch (error) {
    await store.close(flow.id, "CANCELED");
    return flowReply(`결석 신청을 못 했어요: ${absenceErrorMessage(error)} 「결석 신청」으로 다시 확인해 주세요.`, ["결석 신청", "메뉴"]);
  }
  await store.close(flow.id, "APPLIED", { ...state, step: "SAVING" });
  return flowReply(
    `결석 신청 완료: ${state.studentName} 학생 ${chosen.label} (${REASON_LABEL[state.reason]})\n\n그날 셔틀은 자동으로 빠지고 원장님·코치님께 전달됐어요. 보강은 결석 처리 후 「보강 신청」으로 하실 수 있어요.`,
    ["결석 취소", "메뉴"],
  );
}

/** 확정 → 실제 취소(cancelRegularAbsence — 웹과 같은 함수) */
async function confirmCancel(flow: FlowRow<AbsenceState>, today: string): Promise<Reply> {
  const item = flow.state.record;
  if (!item) return renderStep({ ...flow.state, step: "CANCEL_PICK" }, null);
  // 날짜가 바뀌어 오늘이 됐을 수 있다 — 확정 순간에도 다시 본다.
  if (item.date <= today) {
    await store.close(flow.id, "CANCELED");
    return flowReply(`${item.label} 결석은 오늘이라 카톡으로 취소할 수 없어요. 오시게 되면 원장님께 알려 주세요.`, [{ label: "원장님께 알리기", messageText: "원장님께 오늘 결석 취소 알릴게요" }, "메뉴"]);
  }
  if (!(await store.advance(flow.id, "CANCEL_CONFIRM", { ...flow.state, step: "CANCELING" }))) {
    return flowReply("이미 처리 중이거나 처리된 취소예요.", ["결석 취소", "메뉴"]);
  }
  try {
    // ★ cancelRegularAbsence 가 "이 보호자 자녀의 REPORTED 건"인지 다시 확인한다(확정건은 0행 → 거절).
    await cancelRegularAbsence(flow.state.parentUserId, { id: item.id });
  } catch (error) {
    await store.close(flow.id, "CANCELED");
    return flowReply(`결석 취소를 못 했어요: ${absenceErrorMessage(error)}`, [{ label: "원장님께 문의", messageText: "원장님께 결석 취소 문의할게요" }, "메뉴"]);
  }
  await store.close(flow.id, "APPLIED", { ...flow.state, step: "CANCELING" });
  return flowReply(`결석 신청을 취소했어요: ${item.studentName} 학생 ${item.label}\n\n그날 수업에 오는 것으로 원장님·코치님께 전달됐어요.`, ["결석 신청", "메뉴"]);
}

/** 분류가 없거나(날짜·번호만) 결석 자신의 말인가 — 다른 업무 문장의 날짜를 결석 날짜로 삼키지 않으려고 쓴다 */
function isOwnOrPlainText(text: string): boolean {
  const kind = classifyParentUtterance(text);
  return kind === "UNKNOWN" || kind === "REGULAR_ABSENCE";
}

/** 대화 중 6자 이하의 어떤 업무로도 분류되지 않는 짧은 말(「ㅇㅋ」 등) — 지금 단계를 다시 보여 준다. */
function isStrayShortReply(text: string): boolean {
  return [...text].length <= 6 && !FLOW_MENU_TEXT.test(text) && classifyParentUtterance(text) === "UNKNOWN";
}

async function continueFlow(input: AbsenceFlowInput, flow: FlowRow<AbsenceState>): Promise<Reply | null> {
  const { text, webLink } = input;
  const state = flow.state;
  const today = todayKst();
  const answer = answerOf(text);

  // 「원장님께 …」(오늘 결석 알리기 등)는 원장님 접수로 보낸다 — 「오늘」을 날짜로 읽어 붙잡지 않는다.
  if (classifyParentUtterance(text) === "HUMAN") return null;

  // 취소 확정 단계의 「취소」·「취소할게요」는 그만두기가 아니다.
  if (ABORT.test(answer) && !(state.step === "CANCEL_CONFIRM" && /^취소(할게요)?$/.test(answer))) {
    await store.close(flow.id, "CANCELED");
    return flowReply(state.mode === "REPORT" ? "결석 신청을 그만했어요. 필요하면 언제든 「결석 신청」이라고 말씀해 주세요." : "결석 취소를 그만했어요. 신청한 결석은 그대로예요.", MAIN_MENU);
  }

  switch (state.step) {
    case "DATE": {
      const pick = parseNumberPick(text, PICK_DATE);
      // 번호 대신 날짜로 말해도 받는다(「11/20」「내일」). 단 다른 업무 문장(「내일 셔틀 안 타요」
      // 「11/20 청구 금액 확인」)의 날짜는 결석 날짜가 아니다 → 이 대화를 닫고 그 업무로 넘긴다.
      if (pick === null && !isOwnOrPlainText(text)) return null;
      const said = pick === null ? parseKoreanDateYmd(text, today) : null;
      const byDate = said ? (state.dates ?? []).filter((item) => item.date === said) : [];
      const chosen = pick !== null ? state.dates?.[pick - 1] : byDate.length === 1 ? byDate[0] : undefined;
      if (pick === null && !said) break;
      if (!chosen) return dateListReply(state, webLink, said === today ? "오늘 수업은 「오늘 결석 알리기」로 알려 주세요.\n\n" : "목록에 있는 번호를 골라 주세요.\n\n");
      const next: AbsenceState = { ...state, step: "REASON", chosen };
      if (!(await store.advance(flow.id, "DATE", next))) return flowReply("방금 다른 선택이 먼저 처리됐어요. 「결석 신청」으로 다시 시작해 주세요.", ["결석 신청"]);
      return reasonReply(next);
    }
    case "REASON": {
      const reason = parseAbsenceReason(text);
      if (!reason) break;
      const next: AbsenceState = { ...state, step: "CONFIRM", reason };
      if (!(await store.advance(flow.id, "REASON", next))) return flowReply("방금 다른 선택이 먼저 처리됐어요. 「결석 신청」으로 다시 시작해 주세요.", ["결석 신청"]);
      return confirmReply(next);
    }
    case "CONFIRM": {
      if (text === CONFIRM_REPORT || YES.test(answer) || REPORT_YES.test(answer)) return confirmReport(flow);
      break;
    }
    case "CANCEL_PICK": {
      const pick = parseNumberPick(text, PICK_RECORD);
      if (pick === null) break;
      const record = state.records?.[pick - 1];
      if (!record) return recordListReply(state, webLink, "목록에 있는 번호를 골라 주세요.\n\n");
      const next: AbsenceState = { ...state, step: "CANCEL_CONFIRM", record };
      if (!(await store.advance(flow.id, "CANCEL_PICK", next))) return flowReply("방금 다른 선택이 먼저 처리됐어요. 「결석 취소」로 다시 시작해 주세요.", ["결석 취소"]);
      return cancelConfirmReply(next);
    }
    case "CANCEL_CONFIRM": {
      if (text === CONFIRM_CANCEL || YES.test(answer) || CANCEL_YES.test(answer)) return confirmCancel(flow, today);
      if (text === "취소") return renderStep(state, webLink, "결석 신청을 취소하려면 「취소할게요」, 그대로 두려면 「그만하기」를 눌러 주세요.\n\n");
      break;
    }
    default:
      return renderStep(state, webLink);
  }

  // 이 단계의 입력은 아니지만 결석 흐름의 버튼·짧은 답이면 지금 단계를 다시 보여 준다.
  if (STALE_CONTROL.test(text) || SHORT_ANSWER.test(answer) || isStrayShortReply(text)) return renderStep(state, webLink, "지금 단계의 버튼을 눌러 주세요.\n\n");
  return null;
}

/** 정규수업 결석을 시작·취소하는 말인가(업무 분류가 REGULAR_ABSENCE, 메뉴 버튼 제외) */
export function isAbsenceUtterance(text: string): boolean {
  return !FLOW_MENU_TEXT.test(text) && classifyParentUtterance(text) === "REGULAR_ABSENCE";
}

/**
 * 연결된 학부모의 말을 결석 대화로 처리한다. 결석과 무관하면 null → 챗봇의 기존 흐름을 그대로 탄다.
 * 우선순위(handleLinkedMessage 안): 재확인 링크 → 보강 대화 → [여기] → 셔틀 대화 → 작성 중 접수 → …
 */
export async function handleAbsenceConversation(input: AbsenceFlowInput): Promise<Reply | null> {
  const flow = await store.active(input.identityId, input.parentUserId);
  if (flow) {
    const handled = await continueFlow(input, flow);
    if (handled) return handled;
  }
  if (!isAbsenceUtterance(input.text)) {
    // 결석 대화 도중 다른 업무를 말하면 결석 대화는 닫고 기존 흐름으로 넘긴다(남은 「네」가 엉뚱하게 확정되지 않게).
    if (flow) await store.close(flow.id, "CANCELED");
    return null;
  }
  if (input.text === STOP) return flowReply("진행 중인 결석 신청이 없어요.", MAIN_MENU);
  const lead = !flow && STALE_CONTROL.test(input.text)
    ? "진행 중인 선택이 없어요(선택 후 30분이 지나면 처음부터 다시 해요). 처음부터 다시 안내할게요.\n\n"
    : "";
  const named = pickChild(input.children, input.text);
  if (/취소/.test(input.text)) return startCancel(input, named, lead);
  if (!named) {
    // 자녀 선택: 상태 없이 「이름 + 결석 신청」 문장을 돌려받는다.
    await store.open(input.identityId, input.text, null);
    return flowReply(
      `${lead}어느 자녀의 결석을 신청할까요?`,
      [...input.children.slice(0, 9).map((child) => ({ label: child.name, messageText: `${child.name} 결석 신청` })), STOP_REPLY],
    );
  }
  return startReport(input, named, lead);
}
