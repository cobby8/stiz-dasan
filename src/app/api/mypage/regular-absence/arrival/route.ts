import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { cancelArrivalNotice, submitArrivalNotice } from "@/lib/regular/parent-arrival-notice";
import { ABSENCE_REPORT_WEEKS } from "@/lib/regular/parent-regular-absence";
import { BEFORE_RESUME_CODE, resumeFromOfError, resumeNotice } from "@/lib/enrollment/resumeWindow";
import { ARRIVAL_CHANGE_LIMIT_MESSAGE, ARRIVAL_CHANGE_LIMIT_SHUTTLE_MESSAGE } from "@/lib/regular/arrivalNoticeRules";

export const dynamic = "force-dynamic";

// 지각·조퇴 알리기(2026-11-14 묶음 B) — 알리기·시각 바꾸기(report) / 취소(cancel). body.action 으로 분기.
// 화면 데이터(GET)는 결석 알리기와 같은 묶음(/api/mypage/regular-absence)에 실려 온다.
// 권한·날짜·시간 규칙은 모두 서버 함수(parent-arrival-notice.ts)가 다시 본다 — 화면 값은 믿지 않는다.
export async function POST(request: NextRequest) {
  let parent;
  try {
    parent = await requireVerifiedParent();
  } catch {
    return NextResponse.json({ error: "로그인이 필요해요." }, { status: 401 });
  }

  let body: Record<string, unknown> | null;
  try {
    body = (await request.json()) as Record<string, unknown> | null;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  try {
    const result = body?.action === "cancel"
      ? await cancelArrivalNotice(parent.appUserId, { studentId: body?.studentId, classId: body?.classId, date: body?.date, kind: body?.kind })
      : await submitArrivalNotice(parent.appUserId, {
          studentId: body?.studentId,
          classId: body?.classId,
          date: body?.date,
          kind: body?.kind,
          expectedTime: body?.expectedTime,
          // «셔틀도 안 타요»를 고른 경우에만 true — 서버가 물어볼 날인지 다시 확인한다
          skipShuttle: body?.skipShuttle === true,
        });
    return NextResponse.json(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : "UNKNOWN";
    // 복귀 예정 반: 복귀일 전 날짜 — 문구에 복귀일을 넣는다(결석 알리기와 같은 글)
    if (code === BEFORE_RESUME_CODE) {
      return NextResponse.json({ error: `${resumeNotice(resumeFromOfError(error), "신고")}.`, code }, { status: 409 });
    }
    // 에러코드 → 학부모용 한국어 메시지
    const map: Record<string, string> = {
      NOT_OWNER: "본인 자녀의 수업만 알릴 수 있어요.",
      STUDENT_OR_CLASS_MISSING: "자녀와 반을 선택해 주세요.",
      INVALID_DATE: "날짜 형식이 올바르지 않아요.",
      NOT_REPORTABLE_DATE: "지난 날짜이거나 그 반 수업 요일이 아니라 알릴 수 없어요.",
      ABSENCE_TOO_FAR: `앞으로 ${ABSENCE_REPORT_WEEKS}주 안의 수업만 알릴 수 있어요.`,
      ARRIVAL_INVALID_KIND: "늦는지 일찍 가는지 골라 주세요.",
      ARRIVAL_INVALID_TIME: "예상 시각은 수업 시작과 끝 사이로 골라 주세요.",
      ARRIVAL_TIME_ORDER: "도착 예정 시각이 나가는 시각보다 일러야 해요. 시각을 다시 골라 주세요.",
      // 알릴 수 있는 시간: 지각 = 수업 시작 전까지, 조퇴 = 수업 끝나기 전까지
      ARRIVAL_CLOSED_LATE: "수업이 이미 시작돼 여기서 바꿀 수 없어요.",
      ARRIVAL_CLOSED_EARLY: "수업이 이미 끝나 여기서 바꿀 수 없어요.",
      ARRIVAL_ABSENT: "이 날은 결석으로 알려 두었어요. 결석 알림을 먼저 취소해 주세요.",
      // 하루 변경 상한(5번) — 화면은 이 코드를 보고 «학원에 전화하기» 버튼을 함께 보인다
      ARRIVAL_CHANGE_LIMIT: ARRIVAL_CHANGE_LIMIT_MESSAGE,
      // 딸린 셔틀 자차 기록이 살아 있는 채 막힌 경우
      ARRIVAL_CHANGE_LIMIT_SHUTTLE: ARRIVAL_CHANGE_LIMIT_SHUTTLE_MESSAGE,
      ARRIVAL_NOT_FOUND: "알림을 찾을 수 없어요. 화면을 새로 고쳐 주세요.",
      ARRIVAL_UNAVAILABLE: "지금은 이 기능을 쓸 수 없어요. 잠시 후 다시 시도해 주세요.",
    };
    const known = map[code];
    if (!known) console.error("[api/mypage/regular-absence/arrival] POST failed:", error instanceof Error ? error.name : "");
    return NextResponse.json({ error: known || "처리하지 못했어요.", code: known ? code : undefined }, { status: known ? 409 : 500 });
  }
}
