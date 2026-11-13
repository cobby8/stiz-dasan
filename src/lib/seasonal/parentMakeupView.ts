/**
 * 학부모 방학특강 보강 화면 데이터 — 순수 함수(prisma 없음 · 테스트에서 바로 실행).
 */
import { seatLevel, type SeatLevel } from "@/lib/seats/seatLevel";


/**
 * 학부모에게 보낼 보강 후보 — 정원·인원·남은 자리 숫자와 반 학년 평균은 빼고 화면에 쓰는 칸만 골라 담는다
 * (재원생 수 비공개 · 2026-11-13 f9). 관리자 화면은 getMakeupOptions 를 그대로 쓴다. 신청 때 서버가 숫자로 다시 검사한다.
 */
export function toParentSeasonalCandidates(opt: {
  seasonalCandidates: Array<{ sessionDateId: string; label: string | null; remaining: number | null }>;
  regularCandidates: Array<{ classId: string; name: string; schedule: string; nextDate: string | null; nextLabel: string | null }>;
}) {
  return {
    seasonalCandidates: opt.seasonalCandidates.map((s) => {
      // 후보에 오른 날 = 여유가 있는 날. 정원 미지정(null)은 «여유», 기준선 초과 허용으로 0 이하가 나와도 «임박»으로
      const level: SeatLevel = s.remaining == null ? "AVAILABLE" : seatLevel(s.remaining);
      return { sessionDateId: s.sessionDateId, label: s.label, seatLevel: level === "FULL" ? "LOW" as SeatLevel : level };
    }),
    regularCandidates: opt.regularCandidates.map((c) => ({
      classId: c.classId, name: c.name, schedule: c.schedule, nextDate: c.nextDate, nextLabel: c.nextLabel,
    })),
  };
}
