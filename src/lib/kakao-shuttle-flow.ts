import { prisma } from "@/lib/prisma";
import { classifyParentUtterance, type KakaoQuickReply, type ParentRequestKind } from "@/lib/kakao-chatbot-contract";
import { cancelShuttleException, submitShuttleException } from "@/lib/shuttle/parent-shuttle-exception";
import { MAX_DAYS_AHEAD, SHUTTLE_DIRECTION_LABEL, type ShuttleDirection, type ShuttleExceptionKind } from "@/lib/shuttle/dayExceptionRules";
import { addDaysKst, kstLabel, todayKst } from "@/lib/datetime/kst";
import {
  answerOf, createFlowStore, FLOW_MENU_TEXT, flowReply, MAIN_MENU, numberQuickReplies,
  parseKoreanDateYmd, parseNumberPick, pickChild, YES,
  type BaseFlowState, type FlowChild, type FlowRow, type Reply, type WebLink,
} from "@/lib/kakao-flow-store";

// ── 카카오 「당일 셔틀 변경」 대화 흐름 (연결된 학부모 전용) ───────────────────────
//
// 왜 대화 안에서 하나: 지금까지는 셔틀 화면 링크만 줬다. 보강·결석 흐름과 같은 방식으로 카톡 대화만으로 끝낸다.
//
// 당일 변경: 날짜(오늘~14일, KST) → 등원/하원/둘 다 → 안 탐 또는 다른 장소(글) → 확정 → submitShuttleException
// 당일 변경 취소: 예정 변경 목록 → 번호 → 확정 → cancelShuttleException
//
// ★ 규칙은 새로 만들지 않는다. 날짜 범위·방향·장소 검증, 같은 날·방향 덮어쓰기, 기사님 화면 반영,
//   원장·기사 알림은 전부 parent-shuttle-exception.ts(웹과 같은 함수)가 한다.
// ★ IDOR: 학부모는 번호만 보낸다. 변경 id 는 서버가 만든 목록(대화 상태)에서만 꺼내고,
//   저장·취소 함수가 다시 "이 보호자 자녀인가"를 SQL 로 확인한다(이중 방어).

export const SHUTTLE_FLOW_STATUS = "SHUTTLE_FLOW";
/** 날짜 바로가기로 보여 주는 날 수(오늘부터) — 바로가기 10개 = 날짜 8 + 그만 + 여유 */
export const SHUTTLE_DATE_CHOICES = 8;
const MAX_ITEMS = 8;

type ExceptionItem = { id: string; studentName: string; serviceDate: string; label: string };

export type ShuttleState = BaseFlowState & {
  mode: "DAY" | "DAY_CANCEL";
  step: "DATE" | "DIRECTION" | "KIND" | "LOCATION" | "CONFIRM" | "SAVING" | "CANCEL_PICK" | "CANCEL_CONFIRM" | "CANCELING";
  studentName: string | null;
  dates?: string[];
  date?: string;
  direction?: ShuttleDirection;
  kind?: ShuttleExceptionKind;
  location?: string;
  items?: ExceptionItem[];
  item?: ExceptionItem;
};

const store = createFlowStore<ShuttleState>({ status: SHUTTLE_FLOW_STATUS, kind: "SHUTTLE_SKIP" });

// 바로가기 문장은 모두 「셔틀변경 」으로 시작한다(‘셔틀’을 품어 상태가 만료된 뒤 눌러도 셔틀 흐름으로 돌아온다).
const P = "셔틀변경";
const PICK_DATE = `${P} 날짜`;
const PICK_ITEM = `${P} 취소`;
const CONFIRM_DAY = `${P} 확정`;
const CONFIRM_CANCEL = `${P} 취소 확정`;
const STOP = `${P} 그만`;
const STOP_REPLY = { label: "그만하기", messageText: STOP };
const STALE_CONTROL = new RegExp(`^${P} `);
const ABORT = /^(그만|그만하기|그만할게요|아니요|아니오|취소|취소할게요|셔틀변경 그만)$/;
const DAY_YES = /^((네|넵|예|좋아요) ?)?(신청|신청할게요|변경할게요|바꿔 ?주세요|확정)$/;
const CANCEL_YES = /^((네|넵|예) ?)?(취소할게요|취소해 ?주세요)$/;
const SHORT_ANSWER = /^(\d{1,2}\s*번?|네|예|확인|맞아요|진행)$/;

const DIRECTION_REPLIES: KakaoQuickReply[] = [
  { label: "등원", messageText: `${P} 등원` },
  { label: "하원", messageText: `${P} 하원` },
  { label: "등·하원 모두", messageText: `${P} 등하원` },
];
const KIND_REPLIES: KakaoQuickReply[] = [
  { label: "안 타요", messageText: `${P} 안 타요` },
  { label: "다른 곳에서 타요", messageText: `${P} 다른 장소` },
];

/**
 * 등원/하원/둘 다 말 읽기(순수 함수 — 테스트 대상). 둘 다를 먼저 본다(「등하원」은 「하원」을 품는다).
 * 「올 때·갈 때」는 누구 기준이냐에 따라 뜻이 뒤집혀서 읽지 않는다(버튼으로 다시 묻는다).
 */
export function parseShuttleDirection(text: string): ShuttleDirection | null {
  const value = text.replace(new RegExp(`^${P}\\s*`), "");
  if (/등\s*[·,/]?\s*하원|둘\s*다|모두|양쪽|왕복/.test(value)) return "BOTH";
  if (/하원|데려다|끝나고\s*집/.test(value)) return "DROPOFF";
  if (/등원|타러|데리러/.test(value)) return "PICKUP";
  return null;
}

/** 안 탐/다른 장소 말 읽기(순수 함수 — 테스트 대상) */
export function parseShuttleKind(text: string): ShuttleExceptionKind | null {
  const value = text.replace(new RegExp(`^${P}\\s*`), "");
  if (/안\s*타|미탑승|안\s*태|못\s*타/.test(value)) return "SKIP";
  if (/다른\s*(곳|장소|데)|장소|에서\s*타|정류장/.test(value)) return "LOCATION";
  return null;
}

/** 오늘부터 바로가기로 보여 줄 날짜들(순수 함수) */
export function shuttleDateChoices(today: string, count = SHUTTLE_DATE_CHOICES): string[] {
  return Array.from({ length: count }, (_, index) => addDaysKst(today, index));
}

function dayName(ymd: string, today: string): string {
  const rel = ymd === today ? "오늘 " : ymd === addDaysKst(today, 1) ? "내일 " : "";
  return `${rel}${kstLabel(ymd)}`;
}

/** 오늘~14일 안의 날짜인가(웹·저장 함수와 같은 범위 — 최종 판정은 저장 함수가 한다) */
function inRange(ymd: string | null, today: string): ymd is string {
  return Boolean(ymd) && ymd! >= today && ymd! <= addDaysKst(today, MAX_DAYS_AHEAD);
}

// ── DB 읽기(보호자 소유 조건 포함) ─────────────────────────────────────────

/** 이 보호자 자녀의 살아 있는 당일 변경(오늘 이후) */
async function upcomingExceptions(parentUserId: string, studentId: string | null, today: string): Promise<ExceptionItem[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; studentName: string; serviceDate: string; direction: string; kind: string; location: string | null }>>(
    `SELECT x.id, s.name AS "studentName", to_char(x."serviceDate",'YYYY-MM-DD') AS "serviceDate", x.direction, x.kind, x.location
       FROM "ShuttleDayException" x
       JOIN "Student" s ON s.id=x."studentId" AND s."parentId"=$1 AND s."mergedIntoStudentId" IS NULL
      WHERE x."canceledAt" IS NULL AND x."serviceDate">=$2::date AND ($3::text IS NULL OR x."studentId"=$3)
      ORDER BY x."serviceDate" ASC, s.name ASC LIMIT ${MAX_ITEMS}`,
    parentUserId, today, studentId,
  );
  return rows.map((row) => ({
    id: row.id,
    studentName: row.studentName,
    serviceDate: row.serviceDate,
    label: `${dayName(row.serviceDate, today)} ${SHUTTLE_DIRECTION_LABEL[row.direction as ShuttleDirection] ?? row.direction} · ${row.kind === "SKIP" ? "안 탐" : `다른 곳(${row.location ?? "-"})`}`,
  }));
}

// ── 말풍선 ─────────────────────────────────────────────────────────────

function summary(state: ShuttleState, today: string): string {
  const what = state.kind === "SKIP" ? "안 타요" : `다른 곳에서 타요 → ${state.location ?? ""}`;
  return `· 날짜: ${state.date ? dayName(state.date, today) : ""}\n· 방향: ${state.direction ? SHUTTLE_DIRECTION_LABEL[state.direction] : ""}\n· 변경: ${what}`;
}

function renderStep(state: ShuttleState, today: string, webLink: WebLink | null, lead = ""): Reply {
  const who = `${state.studentName} 학생`;
  switch (state.step) {
    case "DATE": {
      const dates = state.dates ?? [];
      const lines = dates.map((ymd, index) => `${index + 1}. ${dayName(ymd, today)}`).join("\n");
      return flowReply(
        `${lead}${who} 셔틀을 바꿀 날을 골라 주세요(오늘부터 ${MAX_DAYS_AHEAD}일 안, 「11/20」처럼 적어도 돼요).\n\n${lines}`,
        [...numberQuickReplies(dates.length, PICK_DATE), STOP_REPLY],
        webLink,
      );
    }
    case "DIRECTION":
      return flowReply(`${lead}${who} ${state.date ? dayName(state.date, today) : ""} — 등원·하원 중 어느 쪽인가요?`, [...DIRECTION_REPLIES, STOP_REPLY]);
    case "KIND":
      return flowReply(`${lead}${who} ${state.date ? dayName(state.date, today) : ""} ${state.direction ? SHUTTLE_DIRECTION_LABEL[state.direction] : ""} — 어떻게 바꿀까요?`, [...KIND_REPLIES, STOP_REPLY]);
    case "LOCATION":
      return flowReply(`${lead}그날 타실 곳을 적어 주세요(예: ○○아파트 정문). 기사님 화면에 그대로 보여요.`, [STOP_REPLY]);
    case "CONFIRM":
      return flowReply(
        `${lead}${who} 셔틀 변경 내용이에요.\n\n${summary(state, today)}\n\n이대로 바꿀까요? 기사님 운행 화면에 바로 표시돼요.`,
        [{ label: "바꿀게요", messageText: CONFIRM_DAY }, STOP_REPLY],
      );
    case "CANCEL_PICK": {
      const items = state.items ?? [];
      const many = new Set(items.map((item) => item.studentName)).size > 1;
      const lines = items.map((item, index) => `${index + 1}. ${many ? `${item.studentName} · ` : ""}${item.label}`).join("\n");
      return flowReply(`${lead}신청된 셔틀 변경이에요. 취소할 번호를 골라 주세요(원래 셔틀대로 돌아가요).\n\n${lines}`, [...numberQuickReplies(items.length, PICK_ITEM), STOP_REPLY], webLink);
    }
    case "CANCEL_CONFIRM":
      return flowReply(`${lead}${state.item?.studentName} 학생 ${state.item?.label} 변경을 취소할까요? 원래 셔틀대로 타게 돼요.`, [{ label: "취소할게요", messageText: CONFIRM_CANCEL }, STOP_REPLY]);
    default:
      return flowReply("방금 요청을 처리하고 있어요. 잠시 후 다시 말씀해 주세요.", ["메뉴"]);
  }
}

/** 아직 안 정한 첫 단계(날짜 → 방향 → 종류 → 장소 → 확정) */
function nextDayStep(state: ShuttleState): ShuttleState["step"] {
  if (!state.date) return "DATE";
  if (!state.direction) return "DIRECTION";
  if (!state.kind) return "KIND";
  if (state.kind === "LOCATION" && !state.location) return "LOCATION";
  return "CONFIRM";
}

// ── 단계별 처리 ─────────────────────────────────────────────────────────

export type ShuttleFlowInput = {
  identityId: string;
  parentUserId: string;
  children: FlowChild[];
  text: string;
  webLink: WebLink | null;
};

async function startDay(input: ShuttleFlowInput, child: FlowChild, lead: string): Promise<Reply> {
  const today = todayKst();
  // 첫 문장에 이미 들어 있는 정보(「내일 하원 셔틀 안 타요」)는 다시 묻지 않는다.
  const said = parseKoreanDateYmd(input.text, today);
  const base: ShuttleState = {
    v: 1, parentUserId: input.parentUserId, mode: "DAY", step: "DATE", studentId: child.id, studentName: child.name,
    dates: shuttleDateChoices(today),
    date: inRange(said, today) ? said : undefined,
    direction: parseShuttleDirection(input.text) ?? undefined,
    kind: parseShuttleKind(input.text) ?? undefined,
  };
  const state: ShuttleState = { ...base, step: nextDayStep(base) };
  const flowId = await store.open(input.identityId, input.text, state);
  if (!flowId) return flowReply("셔틀 변경을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.", ["셔틀"]);
  const farLead = said && !inRange(said, today) ? `셔틀 변경은 오늘부터 ${MAX_DAYS_AHEAD}일 안의 날짜만 돼요.\n\n` : "";
  return renderStep(state, today, input.webLink, `${lead}${farLead}`);
}

async function startDayCancel(input: ShuttleFlowInput, child: FlowChild | null, lead: string): Promise<Reply> {
  const today = todayKst();
  const items = await upcomingExceptions(input.parentUserId, child?.id ?? null, today);
  if (items.length === 0) {
    await store.open(input.identityId, input.text, null);
    return flowReply(`${lead}${child ? `${child.name} 학생은 ` : ""}취소할 셔틀 변경이 없어요.`, ["오늘 셔틀 안 타요", "메뉴"]);
  }
  const state: ShuttleState = { v: 1, parentUserId: input.parentUserId, mode: "DAY_CANCEL", step: "CANCEL_PICK", studentId: child?.id ?? null, studentName: child?.name ?? null, items };
  const flowId = await store.open(input.identityId, input.text, state);
  if (!flowId) return flowReply("셔틀 변경 취소를 시작하지 못했어요. 잠시 후 다시 시도해 주세요.", ["셔틀"]);
  return renderStep(state, today, input.webLink, lead);
}

async function confirmDay(flow: FlowRow<ShuttleState>, today: string): Promise<Reply> {
  const state = flow.state;
  if (!state.studentId || !state.date || !state.direction || !state.kind) return renderStep({ ...state, step: nextDayStep(state) }, today, null);
  if (!(await store.advance(flow.id, "CONFIRM", { ...state, step: "SAVING" }))) return flowReply("이미 처리 중이거나 처리된 변경이에요.", ["셔틀", "메뉴"]);
  // ★ 서버 재검증: 소유권·ACTIVE 수강·날짜 범위(KST)·방향·장소는 submitShuttleException 이 다시 본다.
  const result = await submitShuttleException(state.parentUserId, {
    studentId: state.studentId,
    serviceDate: state.date,
    direction: state.direction,
    kind: state.kind,
    location: state.kind === "LOCATION" ? state.location : undefined,
  });
  if (!result.ok) {
    await store.close(flow.id, "CANCELED");
    return flowReply(`셔틀 변경을 못 했어요: ${result.message} 다시 하려면 「셔틀 변경」이라고 말씀해 주세요.`, ["셔틀", "메뉴"]);
  }
  await store.close(flow.id, "APPLIED", { ...state, step: "SAVING" });
  return flowReply(
    `셔틀 변경 완료: ${state.studentName} 학생\n\n${summary(state, today)}\n\n기사님 운행 화면에 바로 표시됐고 원장님께도 전달됐어요. 수업 결석이면 「결석 신청」을 따로 해 주세요.`,
    [{ label: "변경 취소", messageText: "셔틀 변경 취소" }, "메뉴"],
  );
}

async function confirmDayCancel(flow: FlowRow<ShuttleState>, today: string): Promise<Reply> {
  const item = flow.state.item;
  if (!item) return renderStep({ ...flow.state, step: "CANCEL_PICK" }, today, null);
  if (!(await store.advance(flow.id, "CANCEL_CONFIRM", { ...flow.state, step: "CANCELING" }))) return flowReply("이미 처리 중이거나 처리된 취소예요.", ["셔틀", "메뉴"]);
  // ★ cancelShuttleException 이 "이 보호자 자녀의 살아 있는 변경"인지 UPDATE 조건으로 다시 확인한다.
  const result = await cancelShuttleException(flow.state.parentUserId, item.id);
  if (!result.ok) {
    await store.close(flow.id, "CANCELED");
    return flowReply(`셔틀 변경 취소를 못 했어요: ${result.message}`, ["셔틀", "메뉴"]);
  }
  await store.close(flow.id, "APPLIED", { ...flow.state, step: "CANCELING" });
  return flowReply(`셔틀 변경을 취소했어요: ${item.studentName} 학생 ${item.label}\n\n원래 셔틀대로 타요. 기사님 화면에도 반영됐어요.`, ["셔틀", "메뉴"]);
}

function isStrayShortReply(text: string): boolean {
  return [...text].length <= 6 && !FLOW_MENU_TEXT.test(text) && classifyParentUtterance(text) === "UNKNOWN";
}

async function continueFlow(input: ShuttleFlowInput, flow: FlowRow<ShuttleState>): Promise<Reply | null> {
  const { text, webLink } = input;
  const state = flow.state;
  const today = todayKst();
  const answer = answerOf(text);

  if (classifyParentUtterance(text) === "HUMAN") return null;
  if (ABORT.test(answer) && !(state.step === "CANCEL_CONFIRM" && /^취소(할게요)?$/.test(answer))) {
    await store.close(flow.id, "CANCELED");
    return flowReply(state.mode === "DAY_CANCEL" ? "셔틀 변경 취소를 그만했어요. 신청한 변경은 그대로예요." : "셔틀 변경을 그만했어요. 원래 셔틀대로 타요.", MAIN_MENU);
  }

  // 단계 하나를 정했으면 다음 빈 단계로 넘긴다(선점 조건 = 지금 단계).
  const go = async (patch: Partial<ShuttleState>) => {
    const merged: ShuttleState = { ...state, ...patch };
    const next: ShuttleState = { ...merged, step: nextDayStep(merged) };
    if (!(await store.advance(flow.id, state.step, next))) return flowReply("방금 다른 선택이 먼저 처리됐어요. 다시 말씀해 주세요.", ["셔틀"]);
    return renderStep(next, today, webLink);
  };

  switch (state.step) {
    case "DATE": {
      const pick = parseNumberPick(text, PICK_DATE);
      const said = pick === null ? parseKoreanDateYmd(text, today) : null;
      if (pick === null && !said) break;
      const date = pick !== null ? state.dates?.[pick - 1] : said;
      if (!inRange(date ?? null, today)) return renderStep(state, today, webLink, `오늘부터 ${MAX_DAYS_AHEAD}일 안의 날짜를 골라 주세요.\n\n`);
      return go({ date: date! });
    }
    case "DIRECTION": {
      const direction = parseShuttleDirection(text);
      if (!direction) break;
      return go({ direction });
    }
    case "KIND": {
      const kind = parseShuttleKind(text);
      if (!kind) break;
      return go({ kind });
    }
    case "LOCATION": {
      // 장소는 자유 글. 메뉴·흐름 버튼·업무 문장은 장소로 받지 않는다.
      const place = text.trim();
      if (FLOW_MENU_TEXT.test(place) || STALE_CONTROL.test(place) || [...place].length < 2) break;
      const kind = classifyParentUtterance(place);
      if (kind !== "UNKNOWN" && !kind.startsWith("SHUTTLE")) break;
      return go({ location: [...place].slice(0, 100).join("") });
    }
    case "CONFIRM": {
      if (text === CONFIRM_DAY || YES.test(answer) || DAY_YES.test(answer)) return confirmDay(flow, today);
      break;
    }
    case "CANCEL_PICK": {
      const pick = parseNumberPick(text, PICK_ITEM);
      if (pick === null) break;
      const item = state.items?.[pick - 1];
      if (!item) return renderStep(state, today, webLink, "목록에 있는 번호를 골라 주세요.\n\n");
      const next: ShuttleState = { ...state, step: "CANCEL_CONFIRM", item };
      if (!(await store.advance(flow.id, "CANCEL_PICK", next))) return flowReply("방금 다른 선택이 먼저 처리됐어요. 다시 말씀해 주세요.", ["셔틀"]);
      return renderStep(next, today, webLink);
    }
    case "CANCEL_CONFIRM": {
      if (text === CONFIRM_CANCEL || YES.test(answer) || CANCEL_YES.test(answer)) return confirmDayCancel(flow, today);
      if (text === "취소") return renderStep(state, today, webLink, "변경을 취소하려면 「취소할게요」, 그대로 두려면 「그만하기」를 눌러 주세요.\n\n");
      break;
    }
    default:
      return renderStep(state, today, webLink);
  }

  if (STALE_CONTROL.test(text) || SHORT_ANSWER.test(answer) || isStrayShortReply(text)) return renderStep(state, today, webLink, "지금 단계의 버튼을 눌러 주세요.\n\n");
  return null;
}

const SHUTTLE_KINDS = new Set<ParentRequestKind>(["SHUTTLE_SKIP", "SHUTTLE_LOCATION", "SHUTTLE_START_STOP", "SHUTTLE_CHANGE", "SHUTTLE_FEE"]);
const DATE_WORD = /오늘|내일|모레|당일|\d{1,2}\s*(월|\/|\.)\s*\d{1,2}/;

/**
 * 어떤 셔틀 대화를 시작하는 말인가(순수 함수 — 테스트 대상). 셔틀과 무관하면 null.
 * - DAY_CANCEL: 셔틀 말 + 「취소」(정규 이용 중단·신청 말은 제외)
 * - DAY: 오늘만 안 탐·다른 곳(분류 SHUTTLE_SKIP·SHUTTLE_LOCATION), 메뉴 버튼, 날짜 + 장소 변경
 */
export function shuttleIntentOf(text: string): "DAY" | "DAY_CANCEL" | null {
  if (FLOW_MENU_TEXT.test(text)) return null;
  if (text === "오늘 다른 곳에서 타요" || text === "오늘 셔틀 안 타요") return "DAY";
  const kind = classifyParentUtterance(text);
  if (!SHUTTLE_KINDS.has(kind) || kind === "SHUTTLE_FEE") return null;
  if (/취소/.test(text) && !/정규|매주|중단|신청|이용/.test(text)) return "DAY_CANCEL";
  if (kind === "SHUTTLE_SKIP" || kind === "SHUTTLE_LOCATION") return "DAY";
  if (kind === "SHUTTLE_CHANGE" && DATE_WORD.test(text) && /장소|정류장|곳|데서/.test(text)) return "DAY";
  return null;
}

/**
 * 연결된 학부모의 말을 셔틀 대화로 처리한다. 셔틀 대화와 무관하면 null → 챗봇의 기존 흐름을 그대로 탄다.
 * 우선순위(handleLinkedMessage 안): 재확인 링크 → 보강 대화 → 결석 대화 → [여기] → 작성 중 접수 → …
 */
export async function handleShuttleConversation(input: ShuttleFlowInput): Promise<Reply | null> {
  const flow = await store.active(input.identityId, input.parentUserId);
  if (flow) {
    const handled = await continueFlow(input, flow);
    if (handled) return handled;
  }
  const intent = input.text === STOP ? "STOP" : STALE_CONTROL.test(input.text) && !flow ? "STALE" : shuttleIntentOf(input.text);
  if (!intent) {
    if (flow) await store.close(flow.id, "CANCELED");
    return null;
  }
  if (intent === "STOP") return flowReply("진행 중인 셔틀 변경이 없어요.", MAIN_MENU);
  const stale = intent === "STALE";
  const lead = stale ? "진행 중인 선택이 없어요(선택 후 30분이 지나면 처음부터 다시 해요). 처음부터 다시 안내할게요.\n\n" : "";
  const named = pickChild(input.children, input.text);
  if (intent === "DAY_CANCEL" || (stale && new RegExp(`^${PICK_ITEM}`).test(input.text))) return startDayCancel(input, named, lead);
  if (!named) {
    await store.open(input.identityId, input.text, null);
    // 자녀 이름을 붙여 원래 문장을 돌려받는다(첫 문장의 날짜·방향 정보를 잃지 않게)
    const base = stale ? "오늘 셔틀 안 타요" : input.text;
    return flowReply(`${lead}어느 자녀의 셔틀을 바꿀까요?`, [...input.children.slice(0, 9).map((child) => ({ label: child.name, messageText: `${child.name} ${base}`.slice(0, 200) })), STOP_REPLY]);
  }
  // 만료된 버튼으로 다시 시작할 때는 첫 문장 정보가 없으므로 날짜부터 묻는다.
  return startDay(stale ? { ...input, text: `${named.name} 셔틀 변경` } : input, named, lead);
}
