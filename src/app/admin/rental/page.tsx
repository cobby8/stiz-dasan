import { requireAdmin } from "@/lib/auth-guard";
import { getAdminRentalRequests, getAdminRentalSmsContext } from "@/app/actions/rental";
import RentalAdminClient from "./RentalAdminClient";

export const dynamic = "force-dynamic";

export default async function AdminRentalPage() {
  // 권한 확인은 두 액션 안의 requireAdmin 도 하지만, 화면에서도 먼저 확인한다(d3 — 함수가 바뀌어도 새지 않게).
  await requireAdmin();
  // 문자 미리보기용 입금 계좌·문자 켜짐 여부도 같이 읽는다(관리자 화면에만 보낸다).
  const [rows, sms] = await Promise.all([getAdminRentalRequests(), getAdminRentalSmsContext()]);
  return <RentalAdminClient rows={rows} bankAccount={sms.bankAccount} smsOn={sms.smsOn} />;
}
