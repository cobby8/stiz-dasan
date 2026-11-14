// 대시보드 응답의 돈·통계 칸을 역할에 맞게 거른다 — 2026-11-14 부원장 금액 가림.
//
// 왜 따로 두나: adminReadPayloads.ts 의 export 는 전부 «관리자 확인으로 감싼 읽기 함수»여야 한다
// (tests/admin-page-auth-guard.test.mjs). 이 함수는 읽지 않고 거르기만 하므로 순수 모듈로 뺐다.
import { canSeeStats } from "@/lib/auth/moneyAccess";

/**
 * 대시보드 응답에서 역할이 못 보는 칸을 뺀다.
 * extendedStats = 이번 달·지난달 매출, 미납 건수·합계, 월별 매출·출석 추이(통계) → 원장만.
 * ⚠️ unstable_cache 는 역할과 무관하게 공유되므로 «캐시에서 꺼낸 뒤» 이 함수로 거른다(원본은 건드리지 않고 새 객체).
 */
export function stripDashboardMoneyForRole<T extends { extendedStats?: unknown }>(
    payload: T,
    role: string | null | undefined,
): T | (Omit<T, "extendedStats"> & { extendedStats: null }) {
    if (canSeeStats(role)) return payload;
    return { ...payload, extendedStats: null };
}
