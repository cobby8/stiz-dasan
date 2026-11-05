// 유니폼 신청 공용 선택지·입력 검증 — 순수 모듈(화면·서버 양쪽에서 같이 쓴다)
//
// 왜 공용으로 뺐나: 기존 추가주문 폼(UniformApplicationForm)과 3년 재원 무료 신청 폼이
// 같은 디자인·사이즈 목록과 같은 필수 규칙을 써야 한다. 파일마다 복사하면 한쪽만 고쳐지는
// 사고가 나므로 한 곳에 둔다. 서버도 이 목록으로 다시 검사해 화면을 우회한 값을 막는다.

export const DESIGN_OPTIONS = ["", "DYG 블랙&화이트", "카툰 블랙&화이트"];
export const SIZE_OPTIONS = ["", "5XS(110)", "4XS(120)", "3XS(130)", "2XS(140)", "XS(150)", "S(160)", "M", "L", "XL", "2XL", "3XL", "4XL"];

/** 휴대폰 입력을 010-0000-0000 꼴로(입력 중 자동 하이픈) */
export function formatUniformPhone(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
}

export type UniformItemFields = {
  design: string;
  initials: string;
  backNumber: string;
  topSize: string;
  bottomSize: string;
};

/**
 * 학생 1명분 유니폼 칸 검증. 문제가 없으면 빈 문자열, 있으면 학부모가 읽을 안내 문구.
 * 기존 추가주문 폼의 규칙 그대로: 디자인·이니셜 필수, 상의/하의 중 하나 이상.
 * 추가로 서버에서 화면을 우회한 값(목록에 없는 디자인·사이즈, 숫자 아닌 등번호)을 막는다.
 */
export function validateUniformItemFields(item: UniformItemFields): string {
  const design = item.design.trim();
  const initials = item.initials.trim();
  const backNumber = item.backNumber.trim();
  if (!design) return "유니폼 디자인을 선택해주세요.";
  if (!DESIGN_OPTIONS.includes(design)) return "유니폼 디자인을 다시 선택해주세요.";
  if (!initials) return "유니폼 이니셜을 입력해주세요.";
  if (initials.length > 20) return "이니셜은 20자 이내로 입력해주세요.";
  if (backNumber && !/^\d{1,3}$/.test(backNumber)) return "등번호는 숫자 3자리 이내로 입력해주세요.";
  if (!item.topSize && !item.bottomSize) return "상의 또는 하의 사이즈 중 하나 이상을 선택해주세요.";
  if (item.topSize && !SIZE_OPTIONS.includes(item.topSize)) return "상의 사이즈를 다시 선택해주세요.";
  if (item.bottomSize && !SIZE_OPTIONS.includes(item.bottomSize)) return "하의 사이즈를 다시 선택해주세요.";
  return "";
}

/** 학부모 이름·휴대폰 검증(기존 폼과 같은 기준: 숫자 10~11자리) */
export function validateUniformParentFields(parentName: string, parentPhone: string): string {
  if (!parentName.trim()) return "학부모 이름을 입력해주세요.";
  const digits = parentPhone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 11) return "학부모 휴대폰 번호를 정확히 입력해주세요.";
  return "";
}
