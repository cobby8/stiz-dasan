import PublicPageLayout from "@/components/PublicPageLayout";
import SectionLayout from "@/components/ui/SectionLayout";
import { buildPublicMetadata } from "@/lib/publicMetadata";

// Google Play·App Store 가 요구하는 «로그인 없이 볼 수 있는 계정 삭제 안내» 페이지.
// 실제 탈퇴 동작(src/app/actions/parent-account.ts executeAccountWithdrawal)과 같은 내용만 적는다 — 동작을 바꾸면 이 글도 고친다.
export const revalidate = 3600;
export const metadata = buildPublicMetadata({
  title: "계정 삭제 안내 | STIZ 농구교실",
  description: "STIZ 농구교실 앱·웹사이트 계정과 개인정보 삭제를 요청하는 방법을 안내합니다.",
  path: "/account-deletion",
});

// 안내 카드 한 묶음(제목 + 줄 목록)
const SECTIONS: { title: string; lines: string[] }[] = [
  {
    title: "1. 앱·웹사이트에서 직접 탈퇴하기",
    lines: [
      "STIZ 농구교실 앱(또는 www.stiz-dasan.kr)에 로그인합니다.",
      "마이페이지 → 회원 탈퇴 메뉴로 이동합니다.",
      "안내를 확인하고 «탈퇴 신청»을 누릅니다.",
      "수강 중인 자녀가 없으면 바로 삭제됩니다. 수강 중이면 미납·환불 확인을 위해 학원이 확인한 뒤 처리합니다.",
    ],
  },
  {
    title: "2. 로그인이 어려운 경우",
    lines: [
      "학원 대표 연락처(홈페이지 하단) 또는 카카오톡 채널로 «계정 삭제 요청»과 가입한 휴대폰 번호를 알려 주세요.",
      "본인 확인 후 처리하고 결과를 알려 드립니다.",
    ],
  },
  {
    title: "3. 삭제되는 정보",
    lines: [
      "로그인 계정(아이디·비밀번호·간편로그인 연결)",
      "이름·이메일·휴대폰 번호 등 회원 정보 — 다시 알아볼 수 없게 익명 처리합니다.",
      "자녀 연결 정보, 앱 알림 구독 정보, 선생님·기사님 등 역할 권한",
    ],
  },
  {
    title: "4. 법령에 따라 보관되는 정보",
    lines: [
      "수강료 결제·환불 기록: 「전자상거래 등에서의 소비자보호에 관한 법률」에 따라 5년간 보관 후 파기합니다(회원 정보는 익명 처리된 상태로 보관).",
      "그 밖의 보유 기간은 개인정보 처리방침(www.stiz-dasan.kr/privacy)을 따릅니다.",
    ],
  },
];

export default function AccountDeletionPage() {
  return (
    <PublicPageLayout>
      <section className="public-page-hero public-page-hero--compact bg-[var(--color-public-dark)] text-white py-10 md:py-12">
        <div className="max-w-4xl mx-auto px-6 md:px-4">
          <h1 className="text-3xl md:text-4xl font-bold mb-2 break-keep">계정 삭제 안내</h1>
          <p className="text-white/80 text-base">STIZ 농구교실 앱·웹사이트 (운영: 업턴랩스)</p>
        </div>
      </section>

      <SectionLayout className="public-content-section" bgColor="section">
        <div className="max-w-4xl mx-auto space-y-4">
          {SECTIONS.map((section) => (
            <div
              key={section.title}
              className="bg-white dark:bg-[var(--color-public-tint)] rounded-xl border border-[var(--color-public-line)] p-5 md:p-6"
            >
              <h2 className="text-lg font-bold text-[var(--color-public-ink)] dark:text-white mb-3">{section.title}</h2>
              <ul className="list-disc pl-5 space-y-1.5 text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)] leading-relaxed">
                {section.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </SectionLayout>
    </PublicPageLayout>
  );
}
