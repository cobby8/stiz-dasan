import { requireAdmin } from "@/lib/auth-guard";
import { redirect } from "next/navigation";

/** 폐기된 관리 화면의 기존 북마크는 안전하게 관리자 홈으로 보낸다. */
export default async function RetiredOperationsSyncPage() {
  // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
  await requireAdmin();
  redirect("/admin");
}
