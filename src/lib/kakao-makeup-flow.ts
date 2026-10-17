import { prisma } from "@/lib/prisma";
import { bookMakeup, cancelMakeupBooking, getMakeupOptionsForCredit } from "@/lib/makeup/parent-makeup";
import { notifyAdminsOfKakaoIntake } from "@/lib/kakao-intake-admin-alert";
import { buildKakaoSkillResponse, classifyParentUtterance, KAKAO_TEXT_CARD_DESCRIPTION_MAX, type KakaoQuickReply } from "@/lib/kakao-chatbot-contract";
import { addDaysKst, kstLabel, todayKst, toKstYmd } from "@/lib/datetime/kst";

// ── 카카오 「보강 신청·취소」 대화 흐름 (연결된 학부모 전용) ─────────────────────
//
// 왜 대화 안에서 하나: 사이트 오픈 전에는 학부모가 마이페이지(/mypage/makeup)를 못 쓴다.
// 그래서 카톡 대화만으로 보강권 확인 → 수업 선택 → 확인 → 예약까지 끝낸다. 링크는 보조 버튼으로 남긴다.
//
// ★ 규칙은 새로 만들지 않는다. 학년 매칭·정원 +2·내일부터·만료 전·취소 규칙은 전부
//   src/lib/makeup/parent-makeup.ts(웹과 같은 함수)를 그대로 부른다. 그래서 웹과 결과가 같다.
//
// ★ IDOR 방어
//   - 학부모는 번호(1번, 2번…)만 보낸다. 보강권 id·반 id 는 서버가 만든 목록(대화 상태)에서만 꺼낸다.
//   - 대화 상태는 그 카카오 연결(identityId)의 행에만 있고, 상태 안의 parentUserId 가 지금 연결된 보호자와
//     다르면 버린다. 예약 직전에는 "이 보호자 자녀의 사용 가능한 보강권인가"를 DB 에서 다시 확인한다.
//   - parent-makeup 함수들도 "Student"."parentId" = 보호자 조건으로 한 번 더 막는다(이중 방어).
//
// 대화 상태 저장: 기존 접수 원장 KakaoParentIntake 한 행(kind='MAKEUP', status='MAKEUP_FLOW')을 쓴다.
//   - 스키마 변경 없음(status 는 자유 TEXT). 마지막 갱신 후 30분이 지나면 무시된다(만료).
//   - 예약·취소가 끝나면 status='APPLIED'(관리자 화면 「자동 반영 완료」), 그만두면 'CANCELED'.
//   - 접수 초안(DRAFT·NEEDS_DETAILS)과 동시에 살아 있지 않게, 보강 대화를 시작할 때 초안을 닫는다.

export const MAKEUP_FLOW_STATUS = "MAKEUP_FLOW";
/** 대화 상태가 살아 있는 시간(분) */
export const MAKEUP_FLOW_TTL_MINUTES = 30;
/** 후보 수업을 보여 주는 기간 — 내일부터 14일 */
export const MAKEUP_LOOKAHEAD_DAYS = 14;
/** 한 번에 보여 주는 후보 수(바로가기 10개 안에서 번호 + 「그만하기」·「다른 보강권」) */
export const MAKEUP_MAX_CANDIDATES = 8;
const MAX_CREDITS_SHOWN = 8;

type Reply = ReturnType<typeof buildKakaoSkillResponse>;
type Child = { id: string; name: string };
type WebLink = { label: string; url: string };

export type MakeupCandidate = { classId: string; dateYmd: string; label: string };
type CreditItem = { id: string; label: string; absenceLabel: string; expiresLabel: string };
type ReservationItem = { creditId: string; studentName: string; dateYmd: string; label: string; expiresLabel: string };

type FlowState = {
  v: 1;
  parentUserId: string;
  mode: "BOOK" | "CANCEL";
  step: "CREDIT" | "OPTION" | "CONFIRM" | "BOOKING" | "CANCEL_PICK" | "CANCEL_CONFIRM" | "CANCELING";
  studentId: string | null;
  studentName: string | null;
  credits?: CreditItem[];
  credit?: CreditItem;
  options?: MakeupCandidate[];
  chosen?: MakeupCandidate;
  reservations?: ReservationItem[];
  reservation?: ReservationItem;
};
type FlowRow = { id: string; state: FlowState };

// 바로가기가 보내는 문장. 모두 '보강'을 품고 있어서, 30분이 지나 상태가 사라진 뒤 눌러도
// 엉뚱한 접수로 새지 않고 보강 흐름을 처음부터 다시 시작한다.
const PICK_CREDIT = "보강권";
const PICK_OPTION = "보강 수업";
const PICK_RESERVATION = "보강 취소";
const CONFIRM_BOOK = "보강 신청 확정";
const CONFIRM_CANCEL = "보강 취소 확정";
const OTHER_OPTION = "보강 다른 수업";
const STOP = "보강 그만";
const ASK_DIRECTOR = { label: "원장님께 문의", messageText: "원장님께 보강 문의할게요" };
const STOP_REPLY = { label: "그만하기", messageText: STOP };
const MAIN_MENU = ["결석·보강", "셔틀", "청구·영수증", "수강 변경", "정보·상담"];

// 확인 단어는 신청·취소를 나눈다 — 「취소할게요」가 보강 "신청" 확인으로 읽히면 안 된다.
const YES = /^(네|예|확인|맞아요|진행)$/;
const BOOK_YES = /^(신청|신청할게요)$/;
const CANCEL_YES = /^(취소할게요)$/;
const ABORT = /^(그만|그만하기|그만할게요|아니요|아니오|취소|취소할게요|보강 그만)$/;
// 대화 중에 들어온 짧은 답(번호·네)은 다른 업무로 새지 않게 지금 단계를 다시 보여 준다.
const SHORT_ANSWER = /^(\d{1,2}\s*번?|네|예|확인|맞아요|진행|신청|신청할게요)$/;
// 버튼 문장 형식(상태가 만료된 뒤 눌렀는지 알아보려고 쓴다)
const STALE_CONTROL = /^보강(권 \d{1,2}번| 수업 \d{1,2}번| 취소 \d{1,2}번| 신청 확정| 취소 확정| 다른 수업)$/;

/** 버튼이 있으면 textCard(400자), 넘치면 버튼을 떼고 simpleText(1000자)로 — 목록이 잘리지 않게 한다. */
function reply(text: string, quickReplies: KakaoQuickReply[] = [], webLink?: WebLink | null): Reply {
  const fitsCard = [...text].length <= KAKAO_TEXT_CARD_DESCRIPTION_MAX;
  return buildKakaoSkillResponse({
    text,
    quickReplies,
    buttons: webLink && fitsCard ? [{ action: "webLink", label: webLink.label, webLinkUrl: webLink.url }] : [],
  });
}

function clipName(value: string | null | undefined, max = 10): string {
  const chars = [...(value ?? "").replace(/\s+/g, " ").trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/** "1번" → 1, "보강 수업 3번"(prefix 일치) → 3. 다른 단계의 버튼이면 null. */
export function parsePick(text: string, prefix: string): number | null {
  const bare = /^(\d{1,2})\s*번?$/.exec(text);
  if (bare) return Number(bare[1]);
  const prefixed = new RegExp(`^${prefix} (\\d{1,2})번$`).exec(text);
  return prefixed ? Number(prefixed[1]) : null;
}

/**
 * parent-makeup 이 준 반별 날짜 목록을 「날짜·시간 순 후보」로 펼친다(순수 함수 — 테스트 대상).
 * 내일부터(parent-makeup 이 이미 보장) 14일 안의 날짜만, 최대 8개.
 */
export function buildMakeupCandidates(
  options: Array<{ classId: string; className: string; startTime: string; dates: { ymd: string }[] }>,
  todayYmd: string,
  limit = MAKEUP_MAX_CANDIDATES,
): MakeupCandidate[] {
  const until = addDaysKst(todayYmd, MAKEUP_LOOKAHEAD_DAYS);
  const flat = options.flatMap((option) => option.dates
    .filter((date) => date.ymd > todayYmd && date.ymd <= until)
    .map((date) => ({
      classId: option.classId,
      dateYmd: date.ymd,
      startTime: option.startTime,
      label: `${kstLabel(date.ymd)} ${option.startTime} ${clipName(option.className, 12)}`,
    })));
  flat.sort((a, b) => a.dateYmd.localeCompare(b.dateYmd) || a.startTime.localeCompare(b.startTime));
  return flat.slice(0, limit).map(({ classId, dateYmd, label }) => ({ classId, dateYmd, label }));
}

function numberReplies(count: number, prefix: string): KakaoQuickReply[] {
  return Array.from({ length: count }, (_, index) => ({ label: `${index + 1}번`, messageText: `${prefix} ${index + 1}번` }));
}

// ── DB 읽기(모두 보호자 소유 조건 포함) ─────────────────────────────────────

/** 이 보호자 자녀의 「지금 쓸 수 있는」 보강권(AVAILABLE·만료 전). 만료 임박 순. */
async function availableCredits(parentUserId: string, studentId: string): Promise<CreditItem[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; absenceDate: Date; expiresAt: Date; sourceType: string; originClassName: string | null }>>(
    `SELECT mc.id, mc."absenceDate", mc."expiresAt", mc."sourceType", oc.name AS "originClassName"
       FROM "MakeupCredit" mc
       JOIN "Student" s ON s.id=mc."studentId" AND s."parentId"=$1 AND s."mergedIntoStudentId" IS NULL
       LEFT JOIN "Class" oc ON oc.id=mc."originClassId"
      WHERE mc."studentId"=$2 AND mc.status='AVAILABLE' AND mc."expiresAt">now()
      ORDER BY mc."expiresAt" ASC LIMIT 20`,
    parentUserId, studentId,
  );
  return rows.map((row) => {
    const absenceLabel = kstLabel(row.absenceDate);
    const expiresLabel = kstLabel(row.expiresAt);
    const origin = row.sourceType === "SEASONAL" ? "방학특강" : clipName(row.originClassName ?? "정규수업");
    return { id: row.id, absenceLabel, expiresLabel, label: `${absenceLabel} 결석 · ${origin} · ${expiresLabel}까지` };
  });
}

/** 이 보호자 자녀의 예약된(아직 안 지난) 보강. 오늘 것도 포함한다(당일 취소 불가 안내용). */
async function upcomingReservations(parentUserId: string, studentId: string | null, today: string): Promise<ReservationItem[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ creditId: string; studentName: string; expiresAt: Date; makeupDate: Date; className: string | null; startTime: string | null }>>(
    `SELECT mc.id AS "creditId", s.name AS "studentName", mc."expiresAt", ms."makeupDate", c.name AS "className", c."startTime"
       FROM "MakeupCredit" mc
       JOIN "Student" s ON s.id=mc."studentId" AND s."parentId"=$1 AND s."mergedIntoStudentId" IS NULL
       JOIN "MakeupSession" ms ON ms.id=mc."makeupSessionId" AND ms.status='BOOKED'
       LEFT JOIN "Class" c ON c.id=ms."makeupClassId"
      WHERE mc.status='RESERVED' AND ($2::text IS NULL OR mc."studentId"=$2)
      ORDER BY ms."makeupDate" ASC LIMIT 20`,
    parentUserId, studentId,
  );
  return rows
    .map((row) => {
      const dateYmd = toKstYmd(row.makeupDate);
      return {
        creditId: row.creditId,
        studentName: row.studentName,
        dateYmd,
        expiresLabel: kstLabel(row.expiresAt),
        label: `${kstLabel(dateYmd)} ${row.startTime ?? ""} ${clipName(row.className, 12)}`.replace(/\s+/g, " ").trim(),
      };
    })
    .filter((row) => row.dateYmd >= today)
    .slice(0, MAX_CREDITS_SHOWN);
}

// ── 대화 상태 ───────────────────────────────────────────────────────────

function parseState(raw: unknown): FlowState | null {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return value && typeof value === "object" && (value as FlowState).v === 1 ? (value as FlowState) : null;
  } catch {
    return null;
  }
}

async function activeFlow(identityId: string, parentUserId: string): Promise<FlowRow | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; structuredJson: unknown }>>(
    `SELECT id,"structuredJson" FROM "KakaoParentIntake"
      WHERE "identityId"=$1 AND status='${MAKEUP_FLOW_STATUS}'
        AND "updatedAt">now()-interval '${MAKEUP_FLOW_TTL_MINUTES} minutes'
      ORDER BY "updatedAt" DESC LIMIT 1`,
    identityId,
  );
  const row = rows[0];
  const state = row ? parseState(row.structuredJson) : null;
  // 다른 보호자로 다시 연결된 카카오라면 이전 대화 상태를 쓰지 않는다.
  if (!row || !state || state.parentUserId !== parentUserId) return null;
  return { id: row.id, state };
}

/**
 * 새 보강 대화를 연다: 같은 연결의 작성 중 접수 초안과 이전 보강 대화를 닫고,
 * 상태가 필요하면(state 가 있으면) 새 행을 만든다. 접수 초안 생성과 같은 잠금 키를 쓴다.
 */
async function openFlow(identityId: string, sourceText: string, state: FlowState | null): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, identityId);
    await tx.$executeRawUnsafe(
      `UPDATE "KakaoParentIntake" SET status='CANCELED',"updatedAt"=now()
        WHERE "identityId"=$1 AND status IN ('DRAFT','NEEDS_DETAILS','${MAKEUP_FLOW_STATUS}')`,
      identityId,
    );
    if (!state) return null;
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO "KakaoParentIntake" (id,"identityId","studentId",kind,"sourceText","structuredJson",status,"idempotencyKey")
       VALUES (gen_random_uuid()::text,$1,$2,'MAKEUP',$3,$4::jsonb,'${MAKEUP_FLOW_STATUS}','kakao:makeup:'||gen_random_uuid()::text)
       RETURNING id`,
      identityId, state.studentId, sourceText, JSON.stringify(state),
    );
    return rows[0]?.id ?? null;
  });
}

/** 단계가 그대로일 때만 다음 단계로 넘긴다(같은 버튼을 두 번 눌러도 한 번만 진행). */
async function advance(flowId: string, fromStep: FlowState["step"], next: FlowState): Promise<boolean> {
  const changed = await prisma.$executeRawUnsafe(
    `UPDATE "KakaoParentIntake" SET "structuredJson"=$3::jsonb,"studentId"=$4,"updatedAt"=now()
      WHERE id=$1 AND status='${MAKEUP_FLOW_STATUS}' AND "structuredJson"->>'step'=$2`,
    flowId, fromStep, JSON.stringify(next), next.studentId,
  );
  return Number(changed) > 0;
}

async function closeFlow(flowId: string, status: "APPLIED" | "CANCELED", state?: FlowState): Promise<void> {
  await prisma.$executeRawUnsafe(
    status === "APPLIED"
      ? `UPDATE "KakaoParentIntake" SET status='APPLIED',"appliedAt"=now(),"confirmedAt"=now(),
           "structuredJson"=COALESCE($2::jsonb,"structuredJson"),"updatedAt"=now() WHERE id=$1`
      : `UPDATE "KakaoParentIntake" SET status='CANCELED',"structuredJson"=COALESCE($2::jsonb,"structuredJson"),"updatedAt"=now()
          WHERE id=$1 AND status='${MAKEUP_FLOW_STATUS}'`,
    flowId, state ? JSON.stringify(state) : null,
  );
}

// ── 화면(말풍선) ─────────────────────────────────────────────────────────

const POLICY_LINE = "보강은 결석 1회당 1번, 결석일부터 2개월 안에, 학년이 맞는 다른 수업으로 직접 신청해요.";

function creditListReply(state: FlowState, webLink: WebLink | null, lead = ""): Reply {
  const credits = state.credits ?? [];
  const lines = credits.map((credit, index) => `${index + 1}. ${credit.label}`).join("\n");
  return reply(
    `${lead}${state.studentName} 학생이 쓸 수 있는 보강권 ${credits.length}장이에요. 사용할 보강권 번호를 골라 주세요.\n\n${lines}`,
    [...numberReplies(credits.length, PICK_CREDIT), STOP_REPLY],
    webLink,
  );
}

function optionListReply(state: FlowState, webLink: WebLink | null, lead = ""): Reply {
  const options = state.options ?? [];
  const lines = options.map((option, index) => `${index + 1}. ${option.label}`).join("\n");
  const extra: KakaoQuickReply[] = (state.credits?.length ?? 0) > 1 ? [{ label: "다른 보강권", messageText: "보강 신청" }] : [];
  return reply(
    `${lead}${state.studentName} 학생 · ${state.credit?.absenceLabel} 결석분 보강권(${state.credit?.expiresLabel}까지)\n앞으로 2주 안에 신청할 수 있는 수업이에요. 번호를 골라 주세요.\n\n${lines}`,
    [...numberReplies(options.length, PICK_OPTION), ...extra, STOP_REPLY],
    webLink,
  );
}

function confirmReply(state: FlowState, lead = ""): Reply {
  return reply(
    `${lead}${state.studentName} 학생 보강 신청 내용이에요.\n\n· 보강 수업: ${state.chosen?.label}\n· 사용 보강권: ${state.credit?.absenceLabel} 결석분\n\n이 수업으로 보강 신청할까요? 신청 후 당일 취소는 안 돼요.`,
    [{ label: "신청할게요", messageText: CONFIRM_BOOK }, { label: "다른 수업", messageText: OTHER_OPTION }, STOP_REPLY],
  );
}

function reservationListReply(state: FlowState, today: string, webLink: WebLink | null, lead = ""): Reply {
  const items = state.reservations ?? [];
  const many = new Set(items.map((item) => item.studentName)).size > 1;
  const lines = items.map((item, index) =>
    `${index + 1}. ${many ? `${item.studentName} · ` : ""}${item.label}${item.dateYmd === today ? " (오늘·취소 불가)" : ""}`).join("\n");
  return reply(
    `${lead}예약된 보강이에요. 취소할 번호를 골라 주세요. 미리 취소하면 보강권은 그대로 남아요.\n\n${lines}`,
    [...numberReplies(items.length, PICK_RESERVATION), STOP_REPLY],
    webLink,
  );
}

function cancelConfirmReply(state: FlowState, lead = ""): Reply {
  const item = state.reservation!;
  return reply(
    `${lead}${item.studentName} 학생 ${item.label} 보강 예약을 취소할까요? 취소하면 보강권은 다시 쓸 수 있어요(${item.expiresLabel}까지).`,
    [{ label: "취소할게요", messageText: CONFIRM_CANCEL }, { label: "그만하기", messageText: STOP }],
  );
}

function sameDayRefusal(item: ReservationItem): Reply {
  return reply(
    `${item.label} 보강은 오늘이라 취소할 수 없어요(당일 취소 불가). 오늘 못 오시면 원장님께 꼭 알려 주세요. 연락 없이 빠지면 보강권이 사용 처리돼요.`,
    [{ label: "원장님께 알리기", messageText: "원장님께 오늘 보강 불참 알릴게요" }, "메뉴"],
  );
}

/** 지금 단계를 다시 보여 준다(잘못된 번호·다른 단계 버튼·재전송). */
function renderStep(state: FlowState, today: string, webLink: WebLink | null, lead = ""): Reply {
  switch (state.step) {
    case "CREDIT": return creditListReply(state, webLink, lead);
    case "OPTION": return optionListReply(state, webLink, lead);
    case "CONFIRM": return confirmReply(state, lead);
    case "CANCEL_PICK": return reservationListReply(state, today, webLink, lead);
    case "CANCEL_CONFIRM": return cancelConfirmReply(state, lead);
    default: return reply("방금 요청을 처리하고 있어요. 잠시 후 「보강 신청」이라고 다시 말씀해 주세요.", ["메뉴"]);
  }
}

// ── 단계별 처리 ─────────────────────────────────────────────────────────

/** 보강권 하나에 대해 후보 수업을 다시 계산한다(웹과 같은 getMakeupOptionsForCredit). */
async function candidatesFor(parentUserId: string, creditId: string, today: string): Promise<{ ok: true; options: MakeupCandidate[] } | { ok: false; message: string }> {
  const result = await getMakeupOptionsForCredit(parentUserId, creditId);
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, options: buildMakeupCandidates(result.options, today) };
}

function noOptionReply(state: FlowState, webLink: WebLink | null, lead = ""): Reply {
  return reply(
    `${lead}${state.studentName} 학생 ${state.credit?.absenceLabel} 결석분 보강권으로 앞으로 2주 안에 신청할 수 있는 수업이 없어요(학년이 맞고 자리가 남은 수업 기준). 며칠 뒤 다시 확인하시거나 원장님께 문의해 주세요.`,
    [ASK_DIRECTOR, ...((state.credits?.length ?? 0) > 1 ? [{ label: "다른 보강권", messageText: "보강 신청" }] : []), "메뉴"],
    webLink,
  );
}

/** 보강권을 정한 뒤: 후보를 계산해 OPTION 단계로(없으면 대화를 닫는다). */
async function toOptionStep(flowId: string, fromStep: FlowState["step"], state: FlowState, credit: CreditItem, today: string, webLink: WebLink | null, lead = ""): Promise<Reply> {
  const found = await candidatesFor(state.parentUserId, credit.id, today);
  const next: FlowState = { ...state, step: "OPTION", credit, options: found.ok ? found.options : [], chosen: undefined };
  if (!found.ok) {
    await closeFlow(flowId, "CANCELED");
    return reply(`${lead}${found.message} 처음부터 다시 보려면 「보강 신청」을 눌러 주세요.`, ["보강 신청", "메뉴"]);
  }
  if (found.options.length === 0) {
    await closeFlow(flowId, "CANCELED", next);
    return noOptionReply(next, webLink, lead);
  }
  if (!(await advance(flowId, fromStep, next))) return reply("방금 다른 선택이 먼저 처리됐어요. 「보강 신청」으로 다시 시작해 주세요.", ["보강 신청"]);
  return optionListReply(next, webLink, lead);
}

async function startBooking(input: FlowInput, child: Child, lead: string): Promise<Reply> {
  const today = todayKst();
  const credits = await availableCredits(input.parentUserId, child.id);
  if (credits.length === 0) {
    await openFlow(input.identityId, input.text, null);
    const reserved = await upcomingReservations(input.parentUserId, child.id, today);
    const reservedLine = reserved.length ? `\n\n예약된 보강이 ${reserved.length}건 있어요. 취소하려면 「보강 취소」를 눌러 주세요.` : "";
    return reply(
      `${lead}${child.name} 학생은 지금 사용할 수 있는 보강권이 없어요. 보강권은 결석 처리 후 발급됩니다(결석 1회당 1장, 결석일부터 2개월 안에 사용).${reservedLine}\n\n원장님께 문의하려면 「원장님께 문의」를 눌러 주세요.`,
      [ASK_DIRECTOR, ...(reserved.length ? ["보강 취소"] : []), "메뉴"],
      input.webLink,
    );
  }
  const shown = credits.slice(0, MAX_CREDITS_SHOWN);
  const base: FlowState = { v: 1, parentUserId: input.parentUserId, mode: "BOOK", step: "CREDIT", studentId: child.id, studentName: child.name, credits: shown };
  const flowId = await openFlow(input.identityId, input.text, base);
  if (!flowId) return reply("보강 신청을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.", ["보강 신청"]);
  // 보강권이 한 장이면 고를 필요 없이 바로 후보 수업으로 간다.
  if (shown.length === 1) return toOptionStep(flowId, "CREDIT", base, shown[0], today, input.webLink, `${lead}${POLICY_LINE}\n\n`);
  return creditListReply(base, input.webLink, `${lead}${POLICY_LINE}\n\n`);
}

async function startCancel(input: FlowInput, child: Child | null, lead: string): Promise<Reply> {
  const today = todayKst();
  const reservations = await upcomingReservations(input.parentUserId, child?.id ?? null, today);
  if (reservations.length === 0) {
    await openFlow(input.identityId, input.text, null);
    return reply(`${lead}${child ? `${child.name} 학생은 ` : ""}취소할 수 있는 보강 예약이 없어요.`, ["보강 신청", "메뉴"]);
  }
  const state: FlowState = {
    v: 1, parentUserId: input.parentUserId, mode: "CANCEL", step: "CANCEL_PICK",
    studentId: child?.id ?? null, studentName: child?.name ?? null, reservations,
  };
  const flowId = await openFlow(input.identityId, input.text, state);
  if (!flowId) return reply("보강 취소를 시작하지 못했어요. 잠시 후 다시 시도해 주세요.", ["보강 취소"]);
  return reservationListReply(state, today, input.webLink, lead);
}

/** 확인을 받은 뒤 실제 예약 — parent-makeup.bookMakeup(웹과 같은 함수)을 부른다. */
async function confirmBooking(input: FlowInput, flow: FlowRow, today: string): Promise<Reply> {
  const state = flow.state;
  const credit = state.credit;
  const chosen = state.chosen;
  if (!credit || !chosen || !state.studentId) return renderStep({ ...state, step: "OPTION" }, today, input.webLink);
  // 선점: CONFIRM → BOOKING. 같은 확인이 두 번 와도 예약은 한 번만 시도한다.
  const booking: FlowState = { ...state, step: "BOOKING" };
  if (!(await advance(flow.id, "CONFIRM", booking))) return reply("이미 처리 중이거나 처리된 신청이에요. 결과는 「보강 신청」에서 다시 확인할 수 있어요.", ["보강 신청", "메뉴"]);

  // ★ 서버 재검증 1: 이 보호자 자녀의 지금 쓸 수 있는 보강권인가(대화 상태를 믿지 않는다).
  const owned = await availableCredits(state.parentUserId, state.studentId);
  if (!owned.some((item) => item.id === credit.id)) {
    await closeFlow(flow.id, "CANCELED");
    return reply("이 보강권은 지금 사용할 수 없어요(이미 예약됐거나 기간이 지났어요). 「보강 신청」으로 다시 확인해 주세요.", ["보강 신청", "메뉴"]);
  }
  // ★ 서버 재검증 2: 고른 수업·날짜가 아직 후보인가(그 사이 정원이 찼을 수 있다).
  const before = await candidatesFor(state.parentUserId, credit.id, today);
  const stillOpen = before.ok && before.options.some((item) => item.classId === chosen.classId && item.dateYmd === chosen.dateYmd);
  const result = stillOpen
    ? await bookMakeup(state.parentUserId, { creditId: credit.id, classId: chosen.classId, dateYmd: chosen.dateYmd })
    : { ok: false, message: "방금 정원이 마감됐거나 더 이상 신청할 수 없는 수업이에요." };

  if (result.ok) {
    await closeFlow(flow.id, "APPLIED", { ...booking, step: "BOOKING" });
    // 원장님께 앱 알림(메일 아님). 알림이 실패해도 학부모 답은 그대로 나간다.
    await notifyAdminsOfKakaoIntake({
      intakeId: flow.id,
      kindLabel: "보강 예약 완료",
      studentName: state.studentName,
      sourceText: `${chosen.label} · ${credit.absenceLabel} 결석분 보강권 (카카오 대화로 예약)`,
      linkUrl: "/admin/makeup",
    }).catch(() => undefined);
    return reply(
      `보강 예약 완료: ${state.studentName} 학생 ${chosen.label}\n\n당일 취소는 안 되고, 못 오시면 하루 전까지 카톡으로 알려 주세요(「보강 취소」). 연락 없이 빠지면 보강권이 사용 처리돼요.`,
      ["보강 취소", "메뉴"],
    );
  }

  // 실패: 사유를 알리고 후보 목록을 새로 계산해 다시 보여 준다.
  const lead = `보강 신청을 못 했어요: ${result.message}\n\n`;
  const refreshed = await candidatesFor(state.parentUserId, credit.id, today);
  const options = refreshed.ok ? refreshed.options : [];
  const next: FlowState = { ...state, step: "OPTION", options, chosen: undefined };
  if (options.length === 0) {
    await closeFlow(flow.id, "CANCELED", next);
    return noOptionReply(next, input.webLink, lead);
  }
  await advance(flow.id, "BOOKING", next);
  return optionListReply(next, input.webLink, lead);
}

/** 확인을 받은 뒤 실제 취소 — parent-makeup.cancelMakeupBooking(웹과 같은 함수). */
async function confirmCancel(input: FlowInput, flow: FlowRow, today: string): Promise<Reply> {
  const item = flow.state.reservation;
  if (!item) return renderStep({ ...flow.state, step: "CANCEL_PICK" }, today, input.webLink);
  // 날짜가 바뀌어 오늘이 됐을 수 있다 — 확인 순간에도 당일 여부를 다시 본다.
  if (item.dateYmd <= today) {
    await closeFlow(flow.id, "CANCELED");
    return sameDayRefusal(item);
  }
  if (!(await advance(flow.id, "CANCEL_CONFIRM", { ...flow.state, step: "CANCELING" }))) {
    return reply("이미 처리 중이거나 처리된 취소예요.", ["보강 취소", "메뉴"]);
  }
  // ★ 서버 재검증: 이 보호자 자녀의 예약인지 다시 조회한다.
  const owned = await upcomingReservations(flow.state.parentUserId, null, today);
  if (!owned.some((row) => row.creditId === item.creditId)) {
    await closeFlow(flow.id, "CANCELED");
    return reply("취소할 수 있는 예약이 아니에요(이미 취소됐거나 지난 보강이에요).", ["보강 취소", "메뉴"]);
  }
  const result = await cancelMakeupBooking(flow.state.parentUserId, item.creditId);
  if (!result.ok) {
    await closeFlow(flow.id, "CANCELED");
    return reply(`보강 취소를 못 했어요: ${result.message}`, [ASK_DIRECTOR, "메뉴"]);
  }
  await closeFlow(flow.id, "APPLIED", { ...flow.state, step: "CANCELING" });
  await notifyAdminsOfKakaoIntake({
    intakeId: flow.id,
    kindLabel: "보강 예약 취소",
    studentName: item.studentName,
    sourceText: `${item.label} 보강 예약 취소 (카카오 대화, 보강권 복구)`,
    linkUrl: "/admin/makeup",
  }).catch(() => undefined);
  return reply(`보강 예약을 취소했어요: ${item.studentName} 학생 ${item.label}\n\n보강권은 그대로 남아 있어요(${item.expiresLabel}까지). 다른 날로 신청하려면 「보강 신청」을 눌러 주세요.`, ["보강 신청", "메뉴"]);
}

/** 진행 중인 대화에 들어온 말을 처리한다. 대화와 무관한 말이면 null(대화는 조용히 닫는다). */
async function continueFlow(input: FlowInput, flow: FlowRow): Promise<Reply | null> {
  const { text, webLink } = input;
  const state = flow.state;
  const today = todayKst();

  // 취소 확인 단계의 「취소」·「취소할게요」는 그만두기가 아니다(아래에서 확인·재질문으로 처리).
  if (ABORT.test(text) && !(state.step === "CANCEL_CONFIRM" && /^취소(할게요)?$/.test(text))) {
    await closeFlow(flow.id, "CANCELED");
    return reply(state.mode === "BOOK" ? "보강 신청을 그만했어요. 필요하면 언제든 「보강 신청」이라고 말씀해 주세요." : "보강 취소를 그만했어요. 예약은 그대로 유지돼요.", MAIN_MENU);
  }

  switch (state.step) {
    case "CREDIT": {
      const pick = parsePick(text, PICK_CREDIT);
      if (pick === null) break;
      const credit = state.credits?.[pick - 1];
      if (!credit) return creditListReply(state, webLink, "목록에 있는 번호를 골라 주세요.\n\n");
      return toOptionStep(flow.id, "CREDIT", state, credit, today, webLink);
    }
    case "OPTION": {
      const pick = parsePick(text, PICK_OPTION);
      if (pick === null) break;
      const chosen = state.options?.[pick - 1];
      if (!chosen) return optionListReply(state, webLink, "목록에 있는 번호를 골라 주세요.\n\n");
      const next: FlowState = { ...state, step: "CONFIRM", chosen };
      if (!(await advance(flow.id, "OPTION", next))) return reply("방금 다른 선택이 먼저 처리됐어요. 「보강 신청」으로 다시 시작해 주세요.", ["보강 신청"]);
      return confirmReply(next);
    }
    case "CONFIRM": {
      if (text === CONFIRM_BOOK || YES.test(text) || BOOK_YES.test(text)) return confirmBooking(input, flow, today);
      if (text === OTHER_OPTION) {
        // 후보는 그 사이 바뀌었을 수 있어 새로 계산한다.
        return toOptionStep(flow.id, "CONFIRM", state, state.credit!, today, webLink);
      }
      break;
    }
    case "CANCEL_PICK": {
      const pick = parsePick(text, PICK_RESERVATION);
      if (pick === null) break;
      const item = state.reservations?.[pick - 1];
      if (!item) return reservationListReply(state, today, webLink, "목록에 있는 번호를 골라 주세요.\n\n");
      if (item.dateYmd <= today) {
        await closeFlow(flow.id, "CANCELED");
        return sameDayRefusal(item);
      }
      const next: FlowState = { ...state, step: "CANCEL_CONFIRM", reservation: item };
      if (!(await advance(flow.id, "CANCEL_PICK", next))) return reply("방금 다른 선택이 먼저 처리됐어요. 「보강 취소」로 다시 시작해 주세요.", ["보강 취소"]);
      return cancelConfirmReply(next);
    }
    case "CANCEL_CONFIRM": {
      if (text === CONFIRM_CANCEL || YES.test(text) || CANCEL_YES.test(text)) return confirmCancel(input, flow, today);
      if (text === "취소") return renderStep(state, today, webLink, "예약을 취소하려면 「취소할게요」, 그대로 두려면 「그만하기」를 눌러 주세요.\n\n");
      break;
    }
    default:
      return renderStep(state, today, webLink);
  }

  // 이 단계의 입력은 아니지만 보강 관련 버튼·문장이면 지금 단계를 다시 보여 준다.
  if (STALE_CONTROL.test(text) || SHORT_ANSWER.test(text)) return renderStep(state, today, webLink, "지금 단계의 버튼을 눌러 주세요.\n\n");
  return null;
}

export type FlowInput = {
  identityId: string;
  parentUserId: string;
  children: Child[];
  text: string;
  /** 보조 버튼(마이페이지 보강 화면) — 없으면 버튼 없이 보낸다 */
  webLink: WebLink | null;
};

// 메뉴 버튼 문장. 「결석·보강」은 '보강'을 품고 있지만 하위 메뉴를 여는 버튼이라 보강 업무가 아니다.
const MENU_TEXT = /^(결석·보강|메뉴|처음|시작)$/;

/** 보강을 시작·취소하는 말인가(연결된 학부모의 업무 분류가 MAKEUP 인 말, 메뉴 버튼 제외). */
export function isMakeupUtterance(text: string): boolean {
  return !MENU_TEXT.test(text) && classifyParentUtterance(text) === "MAKEUP";
}

/**
 * 연결된 학부모의 말을 보강 대화로 처리한다. 보강과 무관하면 null → 챗봇의 기존 흐름을 그대로 탄다.
 *
 * 우선순위(kakao-parent-chatbot.handleLinkedMessage 안에서): 보완 요청 재확인 링크 → [여기] → 작성 중 접수 →
 * 메뉴·바로가기 → 업무 분류 → 정책 답변 → 새 접수. 보강 분류는 원래도 정책 답변보다 먼저(화면 링크)였다.
 */
export async function handleMakeupConversation(input: FlowInput): Promise<Reply | null> {
  const flow = await activeFlow(input.identityId, input.parentUserId);
  if (flow) {
    const handled = await continueFlow(input, flow);
    if (handled) return handled;
  }

  const makeup = isMakeupUtterance(input.text);
  if (!makeup) {
    // 보강 대화 도중 다른 업무를 말하면 보강 대화는 닫고 기존 흐름으로 넘긴다(남은 「네」가 엉뚱하게 확정되지 않게).
    if (flow) await closeFlow(flow.id, "CANCELED");
    return null;
  }

  if (input.text === STOP) return reply("진행 중인 보강 신청이 없어요.", MAIN_MENU);
  const lead = !flow && STALE_CONTROL.test(input.text)
    // 30분이 지났거나 이미 끝난 선택의 버튼을 다시 누른 경우 — 둘 다 처음부터 다시 보여 준다.
    ? `진행 중인 선택이 없어요(선택 후 ${MAKEUP_FLOW_TTL_MINUTES}분이 지나면 처음부터 다시 해요). 처음부터 다시 안내할게요.\n\n`
    : "";
  const named = input.children.length === 1
    ? input.children[0]
    : (() => { const hits = input.children.filter((child) => input.text.includes(child.name)); return hits.length === 1 ? hits[0] : null; })();

  if (/취소/.test(input.text)) return startCancel(input, named, lead);

  if (!named) {
    // 자녀 선택: 상태 없이 「이름 + 보강 신청」 문장을 돌려받는다(기존 자녀 선택과 같은 이름 매칭).
    await openFlow(input.identityId, input.text, null);
    return reply(
      `${lead}어느 자녀의 보강을 신청할까요?`,
      [...input.children.slice(0, 9).map((child) => ({ label: child.name, messageText: `${child.name} 보강 신청` })), STOP_REPLY],
    );
  }
  return startBooking(input, named, lead);
}
