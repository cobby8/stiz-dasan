import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getParentBillingHolds, getParentPaymentRequests } from "@/lib/payments/parent-payment-request";
import { getPaymentProviderConfig } from "@/lib/payment-ledger";
import { getAcademySettings } from "@/lib/queries";
import { parentKakaoUrl } from "@/lib/academyPhone";
import { academyBankAccount } from "@/lib/payments/academy-bank-account";
import PaymentRequestClient, { type PaymentContact } from "./PaymentRequestClient";

export const dynamic = "force-dynamic";

// getAcademySettings 가 DB 오류 때 넣는 자리표시 번호 — 진짜 번호처럼 보여 주면 안 된다.
const PLACEHOLDER_PHONE = "010-0000-0000";

export default async function ParentPaymentsPage() {
  const parent = await requireVerifiedParent().catch(() => null);
  // bounced=1 로 목적지를 지운다. 여기로 되돌려보내면 거절 → 판별 → 거절이 무한 반복된다.
  if (!parent) redirect("/mypage/continue?bounced=1");

  const [rows, settings] = await Promise.all([
    getParentPaymentRequests(parent.appUserId),
    getAcademySettings().catch(() => null) as Promise<any>,
  ]);
  // 부상 결석이 승인돼 청구를 잠시 멈춘 자녀 — 위 조회가 끝난 뒤에 읽는다(DB 연결을 동시에 늘리지 않는다). 실패하면 빈 목록
  const holds = await getParentBillingHolds(parent.appUserId);

  // 온라인 결제 가능 여부 — 결제 화면(/payments/[invoiceId])이 쓰는 판정을 그대로 쓴다(키·제공자 설정).
  // 비밀키는 넘기지 않고 참/거짓만 넘긴다.
  const payReady = getPaymentProviderConfig().providerReady;

  // 결제가 안 될 때 «어디로 물어보면 되는지» — 학원 설정(전화·카카오 채널)에 있는 값만 쓴다.
  const phone = typeof settings?.contactPhone === "string" ? settings.contactPhone.trim() : "";
  const contact: PaymentContact = {
    phone: phone && phone !== PLACEHOLDER_PHONE ? phone : null,
    // https:// 없이 저장된 주소도 누를 수 있게 공용 규칙으로 다듬는다(2026-11-17, 바닥글·문의 버튼과 같은 함수)
    // 학부모 «카카오 문의»는 스위치 한 곳(PARENT_KAKAO_INQUIRY_OPEN)을 따른다 — 닫혀 있으면 null(2026-11-17 원장 지시)
    kakaoChannelUrl: parentKakaoUrl(settings?.kakaoChannelUrl),
    // 입금 계좌 — 로그인한 학부모 화면에만 값으로 넘긴다(서버 전용 모듈, 원장 확인 2026-11-09)
    bankAccount: academyBankAccount(),
  };

  return <PaymentRequestClient rows={rows} payReady={payReady} contact={contact} holds={holds} />;
}
