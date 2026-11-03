import { permanentRedirect } from "next/navigation";

// 이전 신청 주소도 본사 유니폼 상품으로 연결한다.
export default function UniformApplyPage() {
  permanentRedirect("https://stiz.kr/product/detail.html?product_no=4095&from=dasan");
}
