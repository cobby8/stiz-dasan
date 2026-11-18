import Link from "next/link";
import PublicPageLayout from "@/components/PublicPageLayout";
import SectionLayout from "@/components/ui/SectionLayout";
import { buildPublicMetadata } from "@/lib/publicMetadata";

// 기사님 사용 설명(2026-11-16 원장 요청 «기사님용 설명도»). 기사님 휴대폰 = 안드로이드(원장 답).
// 문자·카톡 링크로 바로 열리게 로그인 없이 볼 수 있는 공개 페이지 — 개인정보·운행 링크 주소는 넣지 않는다. 검색엔진에는 노출하지 않는다.
// 화면 글자는 실제 글자를 옮겼다: src/components/shuttle/**(운행 화면), apps/driver-android MainActivity(«기존 운행 링크 입력»·위치 공유 동의 창).
// 2026-11-16: 로그인만으로 운행 시작 — 안드로이드 앱은 로그인 후 /staff/driver → /staff/run/open → 운행 링크 화면(위치 공유)으로 간다.
export const revalidate = 3600;
export const metadata = {
  ...buildPublicMetadata({
    title: "기사님 화면 사용 설명 | STIZ 농구교실",
    description: "스티즈농구교실 앱 설치·운행 시작·탑승 체크 방법",
    path: "/driver-guide",
  }),
  robots: { index: false, follow: false },
};

type Step = { title: string; lines: string[] };

// 운행 하나를 처음부터 끝까지 — 순서대로 번호를 붙인다
const RUN_FLOW: Step[] = [
  {
    title: "운행 시작",
    lines: [
      "운행 화면 맨 위 «운행 시작»을 눌러요.",
      "처음에는 «운행 중 위치 공유» 창이 떠요. «동의하고 시작»을 누르고, 이어서 나오는 위치 권한은 «정확한 위치»로, 알림 권한은 «허용»으로 눌러 주세요.",
      "휴대폰 맨 위 알림줄에 «운행 중 · 위치 공유»가 보이면 정상이에요. 화면을 꺼도 위치는 계속 보내져요.",
    ],
  },
  {
    title: "정류장에서 체크",
    lines: [
      "정류장 순서대로 카드가 보여요. «길안내»를 누르면 T맵으로 길을 알려 줘요.",
      "등원은 아이마다 «탑승» 또는 «미탑승», 하원은 «하차» 또는 «미하차»를 눌러요.",
      "«미탑승»을 누르면 «결석(안 옴)»과 «자차등원»(하원은 «자차하원») 중에 골라요.",
      "잘못 눌렀으면 «대기로 되돌리기»를 눌러요.",
      "«학부모 전화»·«학생 전화»로 바로 전화할 수 있어요. «특이»를 누르면 아이 건강 메모가 보여요.",
    ],
  },
  {
    title: "운행 종료",
    lines: [
      "다 끝나면 맨 위 «운행 종료» → «운행 종료»를 눌러요. 알림줄의 «운행 종료»로 끝내도 돼요.",
      "운행을 끝내야 위치 공유가 멈춰요.",
    ],
  },
];

const SECTIONS: Step[] = [
  {
    title: "아이 표시 보는 법",
    lines: [
      "빨간 «결석»: 학부모가 결석을 알린 아이예요. 안 태워도 돼요. 그래도 탔으면 «탑승»을 눌러요.",
      "«자차»·«조퇴»·«지각» 표시: 학부모가 이 셔틀을 안 탄다고 알린 아이라 버튼이 잠겨요. 실제로 탔으면 «그래도 탑승» → «탑승으로 기록»을 눌러요.",
      "회색 표시(휴원·오늘 수업 없음): 체크하지 않아요.",
      "«결석 N명 · 정차 안 해도 됨»이 보이면 그 정류장 아이가 모두 결석이라 서지 않아도 돼요.",
    ],
  },
  {
    title: "학부모에게 가는 알림",
    lines: [
      "«탑승»·«하차»를 누르고 1분이 지나면 학부모에게 «셔틀에 탔어요»·«셔틀에서 내렸어요» 알림이 가요.",
      "잘못 눌렀다면 1분 안에 «대기로 되돌리기»를 누르면 알림이 가지 않아요.",
      "«미탑승»·«자차»는 알림이 가지 않아요.",
    ],
  },
  {
    title: "명단 변경 알림 켜기",
    lines: [
      "위쪽 이름 버튼 왼쪽의 종 모양을 눌러 알림을 켜 주세요. 켜지면 초록 종이에요.",
      "켜 두면 학부모가 결석·자차를 알리거나 명단이 바뀔 때 바로 알림이 와요.",
    ],
  },
  {
    title: "꼭 지켜 주세요",
    lines: [
      "운행 중에는 앱을 강제로 끄거나 위치·알림 권한을 끄지 마세요. 위치 공유가 멈춰요.",
      "휴대폰 «절전 모드»나 앱 «배터리 제한»을 켜면 위치가 끊길 수 있어요.",
      "위쪽에 «위치 지연»·«권한 확인»이 보이면 눌러서 «위치 연결 다시 시도»를 눌러 주세요.",
      "운행 중 다른 화면으로 가면 «운행 종료 후 화면 이동»을 물어봐요. 운행이 끝나기 전에는 «운행 화면 유지»를 눌러 주세요.",
    ],
  },
];

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--color-public-line)] bg-white p-4 dark:bg-[var(--color-public-tint)] md:p-5">
      <h2 className="mb-2 text-base font-bold text-[var(--color-public-ink)] dark:text-white">{title}</h2>
      {children}
    </div>
  );
}

const lineList = (lines: string[]) => (
  <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
    {lines.map((line) => <li key={line}>{line}</li>)}
  </ul>
);

export default function DriverGuidePage() {
  return (
    <PublicPageLayout>
      <section className="public-page-hero public-page-hero--compact bg-[var(--color-public-dark)] py-8 text-white md:py-10">
        <div className="mx-auto max-w-3xl px-6 md:px-4">
          <h1 className="mb-1 break-keep text-2xl font-bold md:text-3xl">기사님 화면 사용 설명</h1>
          <p className="text-sm text-white/80">설치 → 로그인 → 운행 하나 끝내기까지 (안드로이드 휴대폰)</p>
        </div>
      </section>

      <SectionLayout className="public-content-section" bgColor="section">
        <div className="mx-auto max-w-3xl space-y-3">
          <Card title="1. 앱 설치">
            {lineList(["Play 스토어에서 «스티즈농구교실»을 설치해요. 아래 버튼을 누르면 바로 스토어로 가요."])}
            <Link
              href="/install"
              className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-[var(--color-public-accent)] px-4 text-sm font-semibold text-white hover:bg-[var(--color-public-strong)] dark:bg-[var(--color-public-orange)] dark:text-[var(--color-public-dark)]"
            >
              앱 설치하기
            </Link>
          </Card>

          <Card title="2. 로그인">
            {lineList([
              "아이디 칸에 휴대폰 번호(숫자만), 비밀번호를 넣어요. 로그인하면 오늘 운행 화면이 바로 열려요.",
              "따로 운행 링크를 받을 필요 없어요. 다음부터는 앱만 열면 돼요.",
              "셔틀 화면에 있을 때는 맨 위 «운행 시작 (위치 전송)»을 누르면 운행 화면으로 가요.",
              "비밀번호를 모르면 원장님께 «비밀번호 재설정 링크»를 요청하세요. 문자로 온 링크에서 새 비밀번호(10자 이상)를 정해요.",
            ])}
          </Card>

          <Card title="3. 운행 하나 끝내기">
            <ol className="space-y-3">
              {RUN_FLOW.map((step, index) => (
                <li key={step.title} className="flex gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-public-accent)] text-sm font-semibold text-white dark:bg-[var(--color-public-orange)] dark:text-[var(--color-public-dark)]" aria-hidden="true">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="mb-1 text-sm font-semibold text-[var(--color-public-ink)] dark:text-white">{step.title}</p>
                    {lineList(step.lines)}
                  </div>
                </li>
              ))}
            </ol>
          </Card>

          {SECTIONS.map((section, index) => (
            <Card key={section.title} title={`${index + 4}. ${section.title}`}>{lineList(section.lines)}</Card>
          ))}

          <p className="px-1 text-xs text-[var(--color-public-muted)]">궁금한 점은 원장님께 물어봐 주세요.</p>
        </div>
      </SectionLayout>
    </PublicPageLayout>
  );
}
