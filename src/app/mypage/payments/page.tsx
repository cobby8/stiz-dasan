import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getParentPaymentRequests } from "@/lib/payments/parent-payment-request";
import { getPaymentProviderConfig } from "@/lib/payment-ledger";
import { getAcademySettings } from "@/lib/queries";
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

  // 온라인 결제 가능 여부 — 결제 화면(/payments/[invoiceId])이 쓰는 판정을 그대로 쓴다(키·제공자 설정).
  // 비밀키는 넘기지 않고 참/거짓만 넘긴다.
  const payReady = getPaymentProviderConfig().providerReady;

  // 결제가 안 될 때 «어디로 물어보면 되는지» — 학원 설정(전화·카카오 채널)에 있는 값만 쓴다.
  const phone = typeof settings?.contactPhone === "string" ? settings.contactPhone.trim() : "";
  const contact: PaymentContact = {
    phone: phone && phone !== PLACEHOLDER_PHONE ? phone : null,
    kakaoChannelUrl: typeof settings?.kakaoChannelUrl === "string" && settings.kakaoChannelUrl.trim() ? settings.kakaoChannelUrl.trim() : null,
    // 입금 계좌 — 로그인한 학부모 화면에만 값으로 넘긴다(서버 전용 모듈, 원장 확인 2026-11-09)
    bankAccount: academyBankAccount(),
  };

  return <PaymentRequestClient rows={rows} payReady={payReady} contact={contact} />;
}
