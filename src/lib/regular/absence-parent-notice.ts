// 선생님 출석부 «결석» → 학부모 알림 규칙(출시 전 수정 f2, 2026-11-13 원장 지시).
//
// 왜 바로 안 보내고 «몇 분 뒤»에 보내나:
//   선생님이 줄을 잘못 눌러 «결석»을 찍었다가 곧바로 «출석»으로 고치는 일이 흔하다.
//   즉시 보내면 학부모는 «우리 아이가 결석?» 알림을 받고 놀란다.
//   → 매분 도는 push-outbox 크론이 «결석으로 찍힌 지 N분이 지났고, 지금도 결석인» 줄만 골라 보낸다.
//     (출결 행의 updatedAt 이 결석으로 바뀐 시각이다. 출석→결석으로 다시 바꾸면 시계가 새로 돈다.)
//
// 보내지 않는 경우(SQL 쪽 조건과 같은 뜻 — absence-parent-notice-sweep.ts):
//   - 결석 신고가 이미 있는 날(학부모 신고·원장 기간 결석·출석부 질병·부상 표시) — 학원이 이미 사정을 안다.
//   - 보강 온 아이·방학특강 회차 — 정규 반 수강생의 정규 수업만 대상.
//   - 오늘(KST)이 아닌 수업 — 지난 수업을 나중에 정리하며 찍은 결석은 알리지 않는다.
//   - 같은 아이·같은 날·같은 반은 한 번만(dedupeKey).
//
// 유료 문자는 쓰지 않는다 — 출석 알림과 같은 길(앱 알림함 + 웹푸시, deliverParentNotification)만 쓴다.
//
// ⚠️ prisma·next import 금지(테스트가 이 파일을 그대로 실행한다).

/** 결석으로 찍힌 뒤 이만큼 지나도 여전히 결석이면 보낸다(분). */
export const ABSENCE_NOTICE_DELAY_MINUTES = 3;

/** 알림 장부의 이벤트 종류. */
export const ABSENCE_NOTICE_EVENT = "ATTENDANCE_ABSENT";

/** 학부모가 받는 문구 — 짧고 정중하게. */
export function absenceNoticeTitle(className: string): string {
  return `${className} 결석 안내`;
}
export function absenceNoticeMessage(className: string, studentName: string): string {
  return `오늘 ${className} 수업에 ${studentName} 학생이 결석으로 확인되었습니다. 사정이 있으시면 학원으로 알려 주세요.`;
}

/**
 * 같은 아이·같은 날·같은 반·같은 학부모는 한 번만 — 수업(Session) id 가 아니라 반+날짜로 묶는다.
 * (수업 기록이 다시 만들어져도 같은 날 같은 반이면 같은 키라 두 번 나가지 않는다.)
 */
export function absenceNoticeDedupeKey(input: { classId: string; dateYmd: string; studentId: string; userId: string }): string {
  return `absence:${input.classId}:${input.dateYmd}:student:${input.studentId}:user:${input.userId}`;
}
