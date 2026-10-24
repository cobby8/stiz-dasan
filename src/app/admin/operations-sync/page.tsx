import { redirect } from "next/navigation";

/** 폐기된 관리 화면의 기존 북마크는 안전하게 관리자 홈으로 보낸다. */
export default function RetiredOperationsSyncPage() {
  redirect("/admin");
}
