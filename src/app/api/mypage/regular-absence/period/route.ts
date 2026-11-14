import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedParent } from "@/lib/auth-guard";
import {
  closeParentAbsencePeriod,
  createParentAbsencePeriod,
  previewParentAbsencePeriod,
} from "@/lib/regular/parent-absence-period";
import { PARENT_PERIOD_MAX_DAYS } from "@/lib/regular/parentAbsencePeriodRules";
import { ILLNESS_MAKEUP_IN_USE } from "@/lib/regular/illness-carry-tx";
import { todayKst } from "@/lib/datetime/kst";
import { BEFORE_RESUME_CODE, resumeFromOfError, resumeNotice } from "@/lib/enrollment/resumeWindow";

// 학부모 «여러 날 결석»(2026-11-15 원장 결정) — 미리보기(GET) · 알리기/복귀했어요/알림 취소(POST)
// 권한·기간·수업일은 서버가 다시 계산한다(화면이 보낸 날짜 목록을 믿지 않는다).

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const WEEKS = PARENT_PERIOD_MAX_DAYS / 7;

/** 오류 코드 → 학부모용 한국어 문구. tooLong 은 화면이 «휴원 신청» 버튼을 함께 보이게 하는 표시 */
const MESSAGES: Record<string, string> = {
  PERIOD_NOT_READY: "여러 날 결석 알리기를 아직 쓸 수 없습니다. 하루씩 알려 주세요.",
  NOT_OWNER: "본인 자녀의 수업만 알릴 수 있습니다.",
  STUDENT_OR_CLASS_MISSING: "아이를 선택해 주세요.",
  INVALID_REASON: "결석 사유를 선택해 주세요.",
  ILLNESS_REASON_TEXT_REQUIRED: "어디가 아픈지 한 줄로 적어 주세요. (예: 독감, 발목 염좌 · 100자까지)",
  [ILLNESS_MAKEUP_IN_USE]: "이 기간에 이미 보강을 예약했거나 들은 결석이 있어 질병·부상으로 알릴 수 없어요. 보강 예약을 먼저 취소해 주세요.",
  PERIOD_INVALID_DATE: "날짜를 다시 골라 주세요.",
  PERIOD_START_PAST: "시작일은 오늘부터 고를 수 있습니다.",
  PERIOD_START_TOO_FAR: `시작일은 앞으로 ${WEEKS}주 안에서 고를 수 있습니다.`,
  PERIOD_DAILY_LIMIT: "오늘은 더 알릴 수 없어요. 학원에 문의해 주세요.",
  PERIOD_END_BEFORE_START: "끝일은 시작일과 같거나 그 뒤여야 합니다.",
  PERIOD_TOO_LONG: `오늘부터 ${WEEKS}주가 넘으면 휴원 신청을 이용해 주세요.`,
  PERIOD_NO_DATES: "이 기간에 알릴 수업이 없습니다. 날짜를 다시 확인해 주세요.",
  PERIOD_OVERLAP: "이미 알린 기간과 날짜가 겹칩니다. 그 기간을 먼저 «복귀했어요» 또는 «알림 취소»로 정리해 주세요.",
  PERIOD_OVERLAP_ADMIN: "학원에 등록된 결석 기간과 겹쳐요. 학원에 문의해 주세요.",
  PERIOD_NOT_FOUND: "알린 기간을 찾을 수 없습니다.",
  PERIOD_ALREADY_CLOSED: "이미 끝났거나 취소된 기간입니다.",
  PERIOD_RETURN_PAST: "복귀일은 오늘부터 고를 수 있습니다.",
  PERIOD_RETURN_AFTER_END: "복귀일이 알린 기간보다 뒤입니다. 날짜를 다시 골라 주세요.",
};

function failure(error: unknown, where: string) {
  const code = error instanceof Error ? error.message : "UNKNOWN";
  if (code === BEFORE_RESUME_CODE) {
    return NextResponse.json({ error: `${resumeNotice(resumeFromOfError(error), "신고")}.`, code }, { status: 409, headers: noStore });
  }
  const known = MESSAGES[code];
  // 건강 정보(사유 글)가 섞이지 않게 오류 이름만 남긴다
  if (!known) console.error(`[api/mypage/regular-absence/period] ${where} failed:`, error instanceof Error ? error.name : "");
  return NextResponse.json(
    { error: known || "처리에 실패했습니다. 잠시 후 다시 시도해 주세요.", code: known ? code : undefined, tooLong: code === "PERIOD_TOO_LONG" || undefined,
      // 화면이 글만 두지 않고 전화·문의 버튼을 함께 보인다
      needContact: code === "PERIOD_DAILY_LIMIT" || code === "PERIOD_OVERLAP_ADMIN" || undefined },
    { status: known ? 409 : 500, headers: noStore },
  );
}

async function parentOrNull() {
  try { return await requireVerifiedParent(); } catch { return null; }
}

// 미리보기 — ?studentId=&startDate=&endDate=(비우면 «아직 몰라요»)
export async function GET(request: NextRequest) {
  const parent = await parentOrNull();
  if (!parent) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401, headers: noStore });
  const q = request.nextUrl.searchParams;
  try {
    const preview = await previewParentAbsencePeriod(parent.appUserId, {
      studentId: q.get("studentId") ?? "", startDate: q.get("startDate") ?? "", endDate: q.get("endDate") || null,
    });
    return NextResponse.json({ preview }, { headers: noStore });
  } catch (error) {
    return failure(error, "GET");
  }
}

// 알리기(create) · 복귀했어요(return) · 알림 취소(cancel)
export async function POST(request: NextRequest) {
  const parent = await parentOrNull();
  if (!parent) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401, headers: noStore });
  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid body" }, { status: 400, headers: noStore }); }
  try {
    if (body?.action === "return") {
      return NextResponse.json(await closeParentAbsencePeriod(parent.appUserId, { periodId: body.periodId, returnDate: body.returnDate }), { headers: noStore });
    }
    if (body?.action === "cancel") {
      // 알림 취소 = 오늘부터의 결석을 취소(지난 날짜는 그대로). 오늘은 KST 공용 모듈로만 만든다
      return NextResponse.json(await closeParentAbsencePeriod(parent.appUserId, { periodId: body.periodId, returnDate: todayKst() }), { headers: noStore });
    }
    return NextResponse.json(await createParentAbsencePeriod(parent.appUserId, {
      studentId: body?.studentId, startDate: body?.startDate, endDate: body?.endDate || null,
      reason: body?.reason, reasonText: typeof body?.reasonText === "string" ? body.reasonText : null,
    }), { headers: noStore });
  } catch (error) {
    return failure(error, "POST");
  }
}
