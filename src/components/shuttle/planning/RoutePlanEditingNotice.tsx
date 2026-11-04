import "server-only";

import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { isServiceMonth } from "@/lib/regular/serviceMonth";

const NOTICE = "mx-auto max-w-6xl px-4 pt-3 text-sm text-[var(--color-academy-muted)]";

/** 미래에 적용할 확정 배차가 있는 달에는 기존 월별 편집 화면의 적용일을 안내한다. */
export default async function RoutePlanEditingNotice({ serviceMonth }: { serviceMonth: string }) {
  await requireAdmin();
  if (!isServiceMonth(serviceMonth)) return null;
  try {
    const tables = await prisma.$queryRawUnsafe<{ present: string | null }[]>(
      `SELECT to_regclass('public."RegularRoutePlanVersion"')::text AS present`,
    );
    if (!tables[0]?.present) return null;
    const rows = await prisma.$queryRawUnsafe<{ effectiveFrom: string | null }[]>(
      `SELECT max("effectiveFrom")::text AS "effectiveFrom" FROM "RegularRoutePlanVersion" WHERE "serviceMonth"=$1`,
      serviceMonth,
    );
    const date = rows[0]?.effectiveFrom;
    if (!date) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid route plan date");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (date <= today) return null;
    return <p role="status" className={NOTICE}>이 월의 배차 수정은 <strong>{date.replaceAll("-", ".")}</strong>부터 적용됩니다. 현재 운행 조정은 기사님 날짜별 화면에서 확인하세요.</p>;
  } catch {
    return <p role="status" className={NOTICE}>배차 수정 적용일을 확인하지 못했습니다. 적용일 확인이 필요합니다.</p>;
  }
}
