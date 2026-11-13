import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedParent } from "@/lib/auth-guard";
import {
  getUpcomingRegularClassDates,
  reportRegularAbsence,
  cancelRegularAbsence,
  ABSENCE_REPORT_WEEKS,
} from "@/lib/regular/parent-regular-absence";
import { ABSENCE_CHANGE_CLOSED_MESSAGE } from "@/lib/regular/regularAbsenceRules";
import { BEFORE_RESUME_CODE, resumeFromOfError, resumeNotice } from "@/lib/enrollment/resumeWindow";

export const dynamic = "force-dynamic";

// 다가오는 정규 수업일 + 결석 신고 상태 조회
export async function GET() {
  let parent;
  try {
    parent = await requireVerifiedParent();
  } catch {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  try {
    const children = await getUpcomingRegularClassDates(parent.appUserId);
    return NextResponse.json({ children }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[api/mypage/regular-absence] GET failed:", error);
    return NextResponse.json({ error: "조회에 실패했습니다." }, { status: 500 });
  }
}

// 결석 신고(report) / 신고 취소(cancel) — body.action 으로 분기
export async function POST(request: NextRequest) {
  let parent;
  try {
    parent = await requireVerifiedParent();
  } catch {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  try {
    let result;
    if (body?.action === "cancel") {
      result = await cancelRegularAbsence(parent.appUserId, {
        id: body.id,
        studentId: body.studentId,
        classId: body.classId,
        date: body.date,
        // «보강 예약도 함께 취소돼요» 확인을 누른 경우에만 true(서버가 예약 여부를 다시 본다)
        confirmMakeupCancel: body.confirmMakeupCancel === true,
      });
    } else {
      result = await reportRegularAbsence(parent.appUserId, {
        studentId: body.studentId,
        classId: body.classId,
        date: body.date,
        reason: body.reason,
      });
    }
    return NextResponse.json(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : "UNKNOWN";
    // 복귀 예정 반(2026-11-14): 복귀일 전 날짜 — 문구에 복귀일(M/D)을 넣어야 해서 표 밖에서 먼저 답한다
    if (code === BEFORE_RESUME_CODE) {
      return NextResponse.json({ error: `${resumeNotice(resumeFromOfError(error), "신고")}.`, code }, { status: 409 });
    }
    // 에러코드 → 학부모용 한국어 메시지
    const map: Record<string, string> = {
      NOT_OWNER: "본인 자녀의 수업만 신고할 수 있습니다.",
      INVALID_REASON: "결석 사유를 선택해 주세요.",
      INVALID_DATE: "날짜 형식이 올바르지 않습니다.",
      STUDENT_OR_CLASS_MISSING: "자녀와 반을 선택해 주세요.",
      NOT_REPORTABLE_DATE: "지난 날짜이거나 그 반 수업 요일이 아니라 신고할 수 없습니다.",
      // 2026-11-14: 목록에 보이는 범위(4주) 밖 날짜는 받지 않는다
      ABSENCE_TOO_FAR: `앞으로 ${ABSENCE_REPORT_WEEKS}주 안의 수업만 신고할 수 있습니다.`,
      // 2026-11-14: 신고·취소·사유 변경은 수업 시작 1시간 전까지(서버가 강제 — regularAbsenceRules.isAbsenceChangeOpen)
      ABSENCE_CHANGE_CLOSED: ABSENCE_CHANGE_CLOSED_MESSAGE,
      ABSENCE_NOT_FOUND: "결석 신고를 찾을 수 없습니다.",
      ABSENCE_NOT_CANCELABLE: "이미 학원에서 확정된 신고라 바꾸거나 취소할 수 없습니다.",
      // 보강권(2026-11-10): 신고 취소 시 보강권 되돌리기에서 막힌 경우
      MAKEUP_BOOKING_CONFIRM_REQUIRED: "이 결석의 보강권으로 보강이 예약돼 있어요. 보강 예약도 함께 취소돼요.",
      MAKEUP_ALREADY_USED: "이 결석의 보강을 이미 들어서 결석 신고를 취소할 수 없어요. 학원으로 문의해 주세요.",
      MAKEUP_BOOKING_PAST: "예약한 보강 날짜가 지나 결석 신고를 취소할 수 없어요. 학원으로 문의해 주세요.",
    };
    const known = map[code];
    if (!known) console.error("[api/mypage/regular-absence] POST failed:", error);
    // code: 화면이 «보강 예약도 함께 취소» 확인을 다시 띄울지 판단할 때 쓴다(알려진 코드만 내보낸다)
    return NextResponse.json({ error: known || "처리에 실패했습니다.", code: known ? code : undefined }, { status: known ? 409 : 500 });
  }
}
