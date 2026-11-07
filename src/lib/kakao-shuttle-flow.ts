import { prisma } from "@/lib/prisma";
import { classifyParentUtterance, type KakaoQuickReply, type ParentRequestKind } from "@/lib/kakao-chatbot-contract";
import { cancelShuttleException, submitShuttleException } from "@/lib/shuttle/parent-shuttle-exception";
import { MAX_DAYS_AHEAD, SHUTTLE_DIRECTION_LABEL, type ShuttleDirection, type ShuttleExceptionKind } from "@/lib/shuttle/dayExceptionRules";
import { DAY_INDEX, DAY_KO } from "@/lib/regular/regularAbsenceRules";
import { notifyAdminsOfKakaoIntake } from "@/lib/kakao-intake-admin-alert";
import { addDaysKst, kstDow, kstLabel, todayKst } from "@/lib/datetime/kst";
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
// 정규 셔틀 변경(신청·중단·장소·시간): 바로 반영하지 않고 «원장님 승인 접수»로 둔다(노선·자리 확인이 필요하다).
//   대신 요일·방향·새 장소(또는 시간)·시작일을 대화로 받아 structuredJson 에 담아, 관리자 접수함
//   (/admin/kakao-requests)이 effectiveDate·shuttleIntent·details 를 미리 채운 채 바로 처리할 수 있게 한다.
//
// ★ IDOR: 학부모는 번호만 보낸다. 변경 id 는 서버가 만든 목록(대화 상태)에서만 꺼내고,
//   저장·취소 함수가 다시 "이 보호자 자녀인가"를 SQL 로 확인한다(이중 방어).

export const SHUTTLE_FLOW_STATUS = "SHUTTLE_FLOW";
/** 날짜 바로가기로 보여 주는 날 수(오늘부터) — 바로가기 10개 = 날짜 8 + 그만 + 여유 */
export const SHUTTLE_DATE_CHOICES = 8;
const MAX_ITEMS = 8;

type ExceptionItem = { id: string; studentName: string; serviceDate: string; label: string };

/** 정규 셔틀 변경 종류: 신청·중단·탑승 장소·시간 */
export type RegularShuttleAction = "START" | "STOP" | "PLACE" | "TIME";

export type ShuttleState = BaseFlowState & {
  mode: "DAY" | "DAY_CANCEL" | "REGULAR";
  step: "DATE" | "DIRECTION" | "KIND" | "LOCATION" | "CONFIRM" | "SAVING" | "CANCEL_PICK" | "CANCEL_CONFIRM" | "CANCELING"
    | "R_ACTION" | "R_DAYS" | "R_DIRECTION" | "R_DETAIL" | "R_START" | "R_CONFIRM" | "R_SAVING";
  studentName: string | null;
  dates?: string[];
  date?: string;
  direction?: ShuttleDirection;
  kind?: ShuttleExceptionKind;
  location?: string;
  items?: ExceptionItem[];
  item?: ExceptionItem;
  // 정규 셔틀 변경
  action?: RegularShuttleAction;
  classDays?: string[]; // 그 자녀가 다니는 반 요일(한글 한 글자, 월~일 순)
  days?: string[];      // 고른 요일, 또는 ["전체"]
  detail?: string;      // 새 장소(START·PLACE) 또는 원하는 시간(TIME)
  effectiveDate?: string;
};

const store = createFlowStore<ShuttleState>({ status: SHUTTLE_FLOW_STATUS, kind: "SHUTTLE_SKIP" });

// 바로가기 문장은 모두 「셔틀변경 」으로 시작한다(‘셔틀’을 품어 상태가 만료된 뒤 눌러도 셔틀 흐름으로 돌아온다).
const P = "셔틀변경";
const PICK_DATE = `${P} 날짜`;
const PICK_ITEM = `${P} 취소`;
const CONFIRM_DAY = `${P} 확정`;
const CONFIRM_CANCEL = `${P} 취소 확정`;
const CONFIRM_REGULAR = `${P} 정규 확정`;
const STOP = `${P} 그만`;
const STOP_REPLY = { label: "그만하기", messageText: STOP };
const STALE_CONTROL = new RegExp(`^${P} `);
const ABORT = /^(그만|그만하기|그만할게요|아니요|아니오|취소|취소할게요|셔틀변경 그만)$/;
const DAY_YES = /^((네|넵|예|좋아요) ?)?(신청|신청할게요|변경할게요|바꿔 ?주세요|확정)$/;
const REGULAR_YES = /^((네|넵|예|좋아요) ?)?(접수|접수할게요|접수해 ?주세요|신청|신청할게요|확정)$/;
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

// ── 정규 셔틀 변경: 말 읽기(순수 함수 — 테스트 대상) ─────────────────────────

const WEEK_ORDER = ["월", "화", "수", "목", "금", "토", "일"];
const ACTION_LABEL: Record<RegularShuttleAction, string> = { START: "정규 셔틀 신청", STOP: "정규 셔틀 중단", PLACE: "탑승 장소 변경", TIME: "탑승 시간 변경" };
const ACTION_INTENT: Record<RegularShuttleAction, "START" | "STOP" | "CHANGE"> = { START: "START", STOP: "STOP", PLACE: "CHANGE", TIME: "CHANGE" };

/** 신청·중단·장소·시간 중 하나로 읽는다. 둘 이상 걸리면(메뉴 「정규 셔틀 신청·중단」 등) null → 버튼으로 묻는다. */
export function parseRegularShuttleAction(text: string): RegularShuttleAction | null {
  const value = text.replace(new RegExp(`^${P}\\s*정규\\s*`), "");
  const hits: RegularShuttleAction[] = [];
  if (/중단|그만|이용\s*안|끊|빼\s*주/.test(value)) hits.push("STOP");
  if (/장소|정류장|위치|타는\s*곳/.test(value)) hits.push("PLACE");
  if (/시간|시각|몇\s*시/.test(value)) hits.push("TIME");
  if (/신청|시작|타고\s*싶|이용하고|새로\s*타/.test(value)) hits.push("START");
  return hits.length === 1 ? hits[0] : null;
}

/** 요일 읽기: 「월 수」「월수금」「화요일, 목요일」「전체」. 못 읽으면 null. 순서는 월~일. */
export function parseWeekdays(text: string): string[] | null {
  const value = text.replace(new RegExp(`^${P}\\s*요일\\s*`), "").trim();
  if (/전체|모든|전부|매번|수업\s*날\s*다/.test(value)) return ["전체"];
  const compact = value.replace(/요일|[\s·,/]|와|과|랑|및|만|이요|요$/g, "");
  let found: string[] = [];
  if (/^[월화수목금토일]+$/.test(compact)) found = [...compact];
  else found = [...value.matchAll(/([월화수목금토일])요일/g)].map((m) => m[1]);
  const unique = WEEK_ORDER.filter((d) => found.includes(d));
  return unique.length ? unique : null;
}

/** 시작일 후보: 고른 요일(또는 반 요일)의 내일 이후 첫 수업일, 다음 주 월요일 */
export function regularStartChoices(today: string, days: string[]): { nextClass: string; nextWeek: string } {
  const dows = new Set(days.map((d) => (WEEK_ORDER.indexOf(d) + 1) % 7)); // 월=1 … 일=0
  let nextClass = addDaysKst(today, 1);
  for (let i = 1; i <= 7; i += 1) {
    const ymd = addDaysKst(today, i);
    if (dows.size === 0 || dows.has(kstDow(ymd))) { nextClass = ymd; break; }
  }
  const delta = ((1 - kstDow(today) + 7) % 7) || 7;
  return { nextClass, nextWeek: addDaysKst(today, delta) };
}

/** 관리자 접수함이 읽는 structuredJson(effectiveDate·shuttleIntent·details) + 원본 값 */
export function buildRegularShuttleIntake(state: Pick<ShuttleState, "studentId" | "studentName" | "action" | "days" | "direction" | "detail" | "effectiveDate">) {
  const action = state.action!;
  const kind: ParentRequestKind = action === "START" || action === "STOP" ? "SHUTTLE_START_STOP" : "SHUTTLE_CHANGE";
  const dayText = state.days?.[0] === "전체" ? "다니는 수업일 전체" : (state.days ?? []).join("·");
  const parts = [
    `${ACTION_LABEL[action]}`,
    `요일: ${dayText}`,
    `방향: ${state.direction ? SHUTTLE_DIRECTION_LABEL[state.direction] : "-"}`,
    ...(action === "START" || action === "PLACE" ? [`탑승 장소: ${state.detail ?? "-"}`] : []),
    ...(action === "TIME" ? [`원하는 시간: ${state.detail ?? "-"}`] : []),
    `시작일: ${state.effectiveDate ? kstLabel(state.effectiveDate) : "-"}`,
  ];
  return {
    kind,
    lines: parts,
    structured: {
      studentId: state.studentId,
      studentName: state.studentName,
      kind,
      effectiveDate: state.effectiveDate ?? "",
      shuttleIntent: ACTION_INTENT[action],
      details: `${parts.join(" / ")} (카카오 대화 접수)`,
      regularShuttle: {
        action, days: state.days ?? [], direction: state.direction ?? null,
        place: action === "START" || action === "PLACE" ? state.detail ?? null : null,
        time: action === "TIME" ? state.detail ?? null : null,
        effectiveDate: state.effectiveDate ?? null,
      },
      source: "KAKAO_FLOW",
    },
  };
}

// ── DB 읽기(보호자 소유 조건 포함) ─────────────────────────────────────────

/** 이 보호자 자녀가 지금 다니는 반 요일(한글, 월~일 순) */
async function classDaysOf(parentUserId: string, studentId: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ dayOfWeek: string }>>(
    `SELECT DISTINCT c."dayOfWeek" AS "dayOfWeek"
       FROM "Enrollment" e
       JOIN "Student" s ON s.id=e."studentId" AND s."parentId"=$1 AND s."mergedIntoStudentId" IS NULL
       JOIN "Class" c ON c.id=e."classId"
      WHERE e."studentId"=$2 AND e.status='ACTIVE'`,
    parentUserId, studentId,
  );
  const ko = rows.map((row) => DAY_KO[DAY_INDEX[row.dayOfWeek] ?? -1]).filter(Boolean);
  return WEEK_ORDER.filter((d) => ko.includes(d));
}

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
    case "R_ACTION":
      return flowReply(`${lead}${who} 정규 셔틀을 어떻게 바꿀까요? (오늘만 바꾸는 건 「오늘 셔틀 안 타요」)`, [
        { label: "새로 신청", messageText: `${P} 정규 신청` }, { label: "이용 중단", messageText: `${P} 정규 중단` },
        { label: "탑승 장소 변경", messageText: `${P} 정규 장소` }, { label: "시간 변경", messageText: `${P} 정규 시간` }, STOP_REPLY]);
    case "R_DAYS": {
      const choices = state.classDays?.length ? state.classDays : WEEK_ORDER.slice(0, 6);
      return flowReply(`${lead}${who} ${state.action ? ACTION_LABEL[state.action] : ""} — 어느 요일인가요? 여러 요일이면 「월 수」처럼 적어 주세요.`, [
        ...choices.map((d) => ({ label: `${d}요일`, messageText: `${P} 요일 ${d}` })), { label: "수업일 전체", messageText: `${P} 요일 전체` }, STOP_REPLY]);
    }
    case "R_DIRECTION":
      return flowReply(`${lead}등원·하원 중 어느 쪽인가요?`, [...DIRECTION_REPLIES, STOP_REPLY]);
    case "R_DETAIL":
      return flowReply(state.action === "TIME"
        ? `${lead}원하시는 시간을 적어 주세요(예: 하원 6시 30분 차로).`
        : `${lead}새로 타실 곳을 적어 주세요(예: ○○아파트 정문).`, [STOP_REPLY]);
    case "R_START": {
      const { nextClass, nextWeek } = regularStartChoices(today, state.days?.[0] === "전체" ? state.classDays ?? [] : state.days ?? []);
      return flowReply(`${lead}언제부터 바꿀까요? 날짜를 적어도 돼요(예: 11/20).`, [
        { label: `다음 수업 ${kstLabel(nextClass)}`, messageText: `${P} 시작 ${nextClass}` },
        { label: `다음 주 ${kstLabel(nextWeek)}`, messageText: `${P} 시작 ${nextWeek}` }, STOP_REPLY]);
    }
    case "R_CONFIRM": {
      const { lines } = buildRegularShuttleIntake(state);
      return flowReply(
        `${lead}${who} 정규 셔틀 변경 요청이에요.\n\n${lines.map((line) => `· ${line}`).join("\n")}\n\n원장님께 접수할까요? 노선·자리를 확인하고 승인하면 반영돼요(바로 바뀌지는 않아요).`,
        [{ label: "접수할게요", messageText: CONFIRM_REGULAR }, STOP_REPLY],
      );
    }
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

/** 정규 셔틀: 아직 안 정한 첫 단계(종류 → 요일 → 방향 → 장소·시간 → 시작일 → 확정) */
function nextRegularStep(state: ShuttleState): ShuttleState["step"] {
  if (!state.action) return "R_ACTION";
  if (!state.days?.length) return "R_DAYS";
  if (!state.direction) return "R_DIRECTION";
  if (state.action !== "STOP" && !state.detail) return "R_DETAIL";
  if (!state.effectiveDate) return "R_START";
  return "R_CONFIRM";
}

async function startRegular(input: ShuttleFlowInput, child: FlowChild, lead: string): Promise<Reply> {
  const classDays = await classDaysOf(input.parentUserId, child.id);
  const base: ShuttleState = {
    v: 1, parentUserId: input.parentUserId, mode: "REGULAR", step: "R_ACTION", studentId: child.id, studentName: child.name,
    classDays,
    action: parseRegularShuttleAction(input.text) ?? undefined,
    direction: parseShuttleDirection(input.text) ?? undefined,
    // 다니는 요일이 하루뿐이면 묻지 않는다
    days: classDays.length === 1 ? classDays : undefined,
  };
  const state: ShuttleState = { ...base, step: nextRegularStep(base) };
  const flowId = await store.open(input.identityId, input.text, state);
  if (!flowId) return flowReply("셔틀 변경 접수를 시작하지 못했어요. 잠시 후 다시 시도해 주세요.", ["셔틀"]);
  return renderStep(state, todayKst(), input.webLink, lead);
}

/** 확정 → 흐름 행을 그대로 원장님 승인 접수(SUBMITTED)로 바꾸고 원장님께 앱 알림 */
async function confirmRegular(flow: FlowRow<ShuttleState>, today: string): Promise<Reply> {
  const state = flow.state;
  if (nextRegularStep(state) !== "R_CONFIRM" || !state.studentId) return renderStep({ ...state, step: nextRegularStep(state) }, today, null);
  const { kind, structured } = buildRegularShuttleIntake(state);
  // 흐름 상태일 때만 SUBMITTED 로 바뀐다 — 같은 확정이 두 번 와도 접수는 한 건.
  if (!(await store.submit(flow.id, kind, structured))) return flowReply("이미 접수된 요청이에요.", ["셔틀", "메뉴"]);
  await notifyAdminsOfKakaoIntake({
    intakeId: flow.id,
    kindLabel: ACTION_LABEL[state.action!],
    studentName: state.studentName,
    sourceText: String(structured.details),
  }).catch(() => undefined);
  return flowReply(`${ACTION_LABEL[state.action!]} 요청을 접수했어요. 원장님이 노선·자리를 확인한 뒤 카카오톡이나 전화로 알려 드릴게요.`, ["메뉴"]);
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
    return flowReply(state.mode === "DAY_CANCEL" ? "셔틀 변경 취소를 그만했어요. 신청한 변경은 그대로예요."
      : state.mode === "REGULAR" ? "정규 셔틀 변경 접수를 그만했어요. 지금 셔틀은 그대로예요." : "셔틀 변경을 그만했어요. 원래 셔틀대로 타요.", MAIN_MENU);
  }

  // 단계 하나를 정했으면 다음 빈 단계로 넘긴다(선점 조건 = 지금 단계).
  const go = async (patch: Partial<ShuttleState>) => {
    const merged: ShuttleState = { ...state, ...patch };
    const next: ShuttleState = { ...merged, step: nextDayStep(merged) };
    if (!(await store.advance(flow.id, state.step, next))) return flowReply("방금 다른 선택이 먼저 처리됐어요. 다시 말씀해 주세요.", ["셔틀"]);
    return renderStep(next, today, webLink);
  };

  const goRegular = async (patch: Partial<ShuttleState>) => {
    const merged: ShuttleState = { ...state, ...patch };
    const next: ShuttleState = { ...merged, step: nextRegularStep(merged) };
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
    case "R_ACTION": {
      const action = parseRegularShuttleAction(text);
      if (!action) break;
      return goRegular({ action });
    }
    case "R_DAYS": {
      const days = parseWeekdays(text);
      if (!days) break;
      // 다니는 반 요일이 아닌 날은 받지 않는다(그날은 수업이 없어 셔틀도 없다)
      const outside = days[0] === "전체" || !state.classDays?.length ? [] : days.filter((d) => !state.classDays!.includes(d));
      if (outside.length) return renderStep(state, today, webLink, `${outside.join("·")}요일은 지금 다니는 수업이 없어요.\n\n`);
      return goRegular({ days });
    }
    case "R_DIRECTION": {
      const direction = parseShuttleDirection(text);
      if (!direction) break;
      return goRegular({ direction });
    }
    case "R_DETAIL": {
      const detail = text.trim();
      if (FLOW_MENU_TEXT.test(detail) || STALE_CONTROL.test(detail) || [...detail].length < 2) break;
      const kind = classifyParentUtterance(detail);
      if (kind !== "UNKNOWN" && !kind.startsWith("SHUTTLE")) break;
      return goRegular({ detail: [...detail].slice(0, 100).join("") });
    }
    case "R_START": {
      const fromButton = new RegExp(`^${P} 시작 (\\d{4}-\\d{2}-\\d{2})$`).exec(text)?.[1] ?? null;
      // 「다음 주부터」「다음 수업부터」도 버튼과 같은 날짜로 읽는다
      const choices = regularStartChoices(today, state.days?.[0] === "전체" ? state.classDays ?? [] : state.days ?? []);
      const said = fromButton ?? (/다음\s*주/.test(text) ? choices.nextWeek : /다음\s*수업/.test(text) ? choices.nextClass : parseKoreanDateYmd(text, today));
      if (!said) break;
      // 내일부터 90일 안(오늘 바로 바꾸는 건 노선 확인이 안 된다)
      if (said <= today || said > addDaysKst(today, 90)) return renderStep(state, today, webLink, "내일부터 90일 안의 날짜로 골라 주세요.\n\n");
      return goRegular({ effectiveDate: said });
    }
    case "R_CONFIRM": {
      if (text === CONFIRM_REGULAR || YES.test(answer) || REGULAR_YES.test(answer)) return confirmRegular(flow, today);
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
 * - REGULAR: 정규 셔틀 신청·중단(SHUTTLE_START_STOP), 「변경·바꾸기」가 들어간 셔틀 말, 메뉴 버튼
 *   (셔틀 시간을 «묻는» 말처럼 바꾸는 말이 없는 SHUTTLE_CHANGE 는 예전처럼 원문 접수로 간다)
 */
export function shuttleIntentOf(text: string): "DAY" | "DAY_CANCEL" | "REGULAR" | null {
  if (FLOW_MENU_TEXT.test(text)) return null;
  if (text === "오늘 다른 곳에서 타요" || text === "오늘 셔틀 안 타요") return "DAY";
  if (text === "정규 셔틀 신청·중단" || text === "탑승 장소·시간 변경") return "REGULAR";
  const kind = classifyParentUtterance(text);
  if (!SHUTTLE_KINDS.has(kind) || kind === "SHUTTLE_FEE") return null;
  if (/취소/.test(text) && !/정규|매주|중단|신청|이용/.test(text)) return "DAY_CANCEL";
  if (kind === "SHUTTLE_SKIP" || kind === "SHUTTLE_LOCATION") return "DAY";
  if (kind === "SHUTTLE_CHANGE" && DATE_WORD.test(text) && /장소|정류장|곳|데서/.test(text)) return "DAY";
  if (kind === "SHUTTLE_START_STOP") return "REGULAR";
  if (kind === "SHUTTLE_CHANGE" && /변경|바꾸|바꿔|바뀌|옮기/.test(text)) return "REGULAR";
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
    if (intent === "REGULAR") {
      return flowReply("어느 자녀의 정규 셔틀을 바꿀까요?", [...input.children.slice(0, 9).map((child) => ({ label: child.name, messageText: `${child.name} 정규 셔틀 변경` })), STOP_REPLY]);
    }
    // 자녀 이름을 붙여 원래 문장을 돌려받는다(첫 문장의 날짜·방향 정보를 잃지 않게)
    const base = stale ? "오늘 셔틀 안 타요" : input.text;
    return flowReply(`${lead}어느 자녀의 셔틀을 바꿀까요?`, [...input.children.slice(0, 9).map((child) => ({ label: child.name, messageText: `${child.name} ${base}`.slice(0, 200) })), STOP_REPLY]);
  }
  if (intent === "REGULAR") return startRegular(input, named, lead);
  if (stale && /^셔틀변경 (정규|요일|시작) /.test(input.text)) return startRegular({ ...input, text: `${named.name} 정규 셔틀 변경` }, named, lead);
  // 만료된 버튼으로 다시 시작할 때는 첫 문장 정보가 없으므로 날짜부터 묻는다.
  return startDay(stale ? { ...input, text: `${named.name} 셔틀 변경` } : input, named, lead);
}
