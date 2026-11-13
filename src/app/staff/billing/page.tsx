import StaffBillingClient from "./StaffBillingClient";
import { getStaffBilling } from "@/lib/staff-portal-queries";
import { getStaffClassAccessContext } from "@/lib/staff-class-access";
import { todayKst } from "@/lib/datetime/kst";
import { resolveBillingMonth } from "@/lib/staff-billing-lookup";
export const dynamic = "force-dynamic";

export default async function StaffBillingPage({ searchParams }: { searchParams: Promise<{ month?: string | string[] }> }) {
  // 주소창의 ?month= 는 바깥 입력이라 형식·범위를 검사하고, 이상한 값은 이번 달(KST)로 돌린다.
  // 반은 주소로 받지 않는다 — 담당 반은 서버가 로그인 계정으로만 정한다.
  const currentMonth = todayKst().slice(0, 7);
  const month = resolveBillingMonth((await searchParams).month, currentMonth);
  // 머리말에 «지금 무엇을 보고 있는지» 알리기 위한 역할(원장·부원장 = 전체 반, 선생님 = 담당 반)
  const access = await getStaffClassAccessContext();
  return (
    <StaffBillingClient
      bills={await getStaffBilling({ month })}
      month={month}
      currentMonth={currentMonth}
      seesAllClasses={access.canAccessAllClasses}
    />
  );
}
