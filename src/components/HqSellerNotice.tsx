import FontFreeIcon from "@/components/ui/FontFreeIcon";

/**
 * SHOP 상품의 실제 판매자(본사) 안내.
 *
 * 왜 필요한가: 사이트 하단에는 학원(스티즈농구교실 다산2호점) 사업자 정보가 있는데,
 * SHOP 상품은 본사 쇼핑몰(stiz.kr)에서 소명엔비씨가 팔고 결제받는다.
 * 판매자를 따로 적지 않으면 "교육업체가 의류를 판다"로 보여 결제사 심사에서 걸리고,
 * 전자상거래법의 판매자 표시 의무에도 어긋난다.
 * 값은 stiz.kr 하단 표기(2026-10-02 확인)와 같다.
 */
export const HQ_SELLER = {
  name: "소명엔비씨 주식회사 (STIZ 본사)",
  owner: "김수빈",
  registrationNumber: "119-86-78811",
  mailOrderNumber: "제2023-서울성동-0890호",
  address: "서울특별시 성동구 한림말길 33 청훈빌딩 지하2층",
  phone: "070-4337-3000",
} as const;

/** compact: 상품 상세 상단 띠처럼 좁은 자리에 쓰는 한 줄 판. */
export default function HqSellerNotice({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <p className="break-keep border-b border-gray-200 bg-gray-50 px-3 py-2 text-[11px] leading-5 text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300 sm:px-5">
        판매자 <strong className="font-bold text-gray-800 dark:text-white">{HQ_SELLER.name}</strong> · 결제·배송·교환은 본사 쇼핑몰에서 처리됩니다 · 문의 {HQ_SELLER.phone}
      </p>
    );
  }

  return (
    <div className="mb-5 rounded-xl border border-gray-200 bg-white p-4 text-sm dark:border-gray-800 dark:bg-gray-950">
      <p className="flex items-start gap-2 break-keep font-bold text-gray-900 dark:text-white">
        <FontFreeIcon name="checkroom" size={18} className="mt-0.5 shrink-0 text-brand-orange-500 dark:text-brand-neon-lime" />
        SHOP 상품은 STIZ 본사(소명엔비씨 주식회사)가 판매·배송합니다.
      </p>
      <p className="mt-1 break-keep pl-6 text-xs leading-5 text-gray-600 dark:text-gray-400">
        결제·배송·교환·환불은 본사 쇼핑몰에서 처리되며, 학원 수강료와는 별도입니다.
      </p>
      <p className="mt-2 break-keep pl-6 text-[11px] leading-5 text-gray-500 dark:text-gray-400">
        상호 {HQ_SELLER.name} · 대표자 {HQ_SELLER.owner} · 사업자등록번호 {HQ_SELLER.registrationNumber} · 통신판매업 {HQ_SELLER.mailOrderNumber}
        <br />
        주소 {HQ_SELLER.address} · 전화 {HQ_SELLER.phone}
      </p>
    </div>
  );
}
