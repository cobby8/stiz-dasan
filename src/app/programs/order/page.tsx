import { redirect } from "next/navigation";

/**
 * 옛 주소 넘김 — 토스페이먼츠 가맹 심사용 테스트 결제 화면이 있던 자리다.
 * 심사가 끝나(2026-11-07 승인) 2026-11-14 에 심사용 결제 흐름(주문서·결과 화면·심사용 API)을 지웠다.
 * 즐겨찾기·검색 결과로 들어온 사람이 «없는 페이지»를 보지 않게 프로그램 안내로 보낸다.
 * (실제 수강료 결제는 학부모 청구서 결제 /payments/<청구서> · /pay/<토큰> 이 맡는다 — 이 파일과 무관)
 */
export default function RetiredReviewPaymentPage() {
    redirect("/programs");
}
