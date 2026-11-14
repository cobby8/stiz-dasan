import "server-only";
import { unstable_rethrow } from "next/navigation";
import { withFallback } from "@/lib/net/resilience";

/**
 * 서버 화면용 «실패해도 기본값» 조회 — Next.js 이동 신호(redirect·notFound)는 그대로 통과시킨다.
 * 예: const photos = await loadOrDefault("리포트 상세: 사진", () => listPhotos(...), new Map());
 * ⚠️ 로그인·권한 판정에는 쓰지 말 것(실패하면 막혀야 한다).
 */
export function loadOrDefault<T>(stage: string, load: () => Promise<T>, fallback: T): Promise<T> {
  return withFallback(stage, load, fallback, { rethrow: unstable_rethrow });
}
