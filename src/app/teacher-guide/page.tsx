import Link from "next/link";
import PublicPageLayout from "@/components/PublicPageLayout";
import SectionLayout from "@/components/ui/SectionLayout";
import { buildPublicMetadata } from "@/lib/publicMetadata";

// 선생님 사용 설명(2026-11-13 원장 요청 «설치·로그인·사용 설명을 한 페이지로»).
// 문자 링크로 바로 열리게 로그인 없이 볼 수 있는 공개 페이지다 — 개인정보·금액은 넣지 않는다. 검색엔진에는 노출하지 않는다.
// 화면 글자(버튼 이름)는 src/app/staff/** 의 실제 글자를 옮겼다. 선생님 화면을 고치면 이 글도 같이 고친다.
export const revalidate = 3600;
export const metadata = {
  ...buildPublicMetadata({
    title: "선생님 앱 사용 설명 | STIZ 농구교실",
    description: "스티즈농구교실 앱 설치·로그인·출석부 쓰는 방법",
    path: "/teacher-guide",
  }),
  robots: { index: false, follow: false },
};

type Step = { title: string; lines: string[] };

// 수업 하나를 처음부터 끝까지 — 순서대로 번호를 붙인다
const CLASS_FLOW: Step[] = [
  { title: "수업 시작", lines: ["홈 «오늘 수업»에서 지금 수업의 «수업 시작»을 누르고, 확인 창에서 한 번 더 «수업 시작»을 눌러요."] },
  {
    title: "출석 확인",
    lines: [
      "«출석부 확인»을 누르고 아이마다 «출석 · 지각 · 결석» 중 하나를 눌러요. 누르는 순간 저장돼요(따로 저장 버튼 없음).",
      "다 왔으면 «미확인 학생 전체 출석» 한 번이면 끝나요.",
      "«체험» 아이와 학부모가 결석을 미리 알린 아이는 전체 출석에서 빠지니 직접 눌러 주세요.",
      "결석이 아파서라면 «질병·부상 결석»도 눌러 주세요.",
    ],
  },
  { title: "수업 중 기록(선택)", lines: ["«오늘 수업 내용», «수업 사진», «수업 중 특이사항»을 남길 수 있어요. 메모는 자동 저장돼요.", "사진은 «사진에 나온 학생»을 먼저 고르고 올려요. 원장님이 확인한 뒤 게시해요."] },
  {
    title: "수업 종료",
    lines: [
      "화면 아래 «수업 종료 확인» → «종료 확인»을 누르면 끝나요.",
      "출석을 아직 안 누른 아이가 있으면 종료가 안 돼요. «출석부 확인하기»로 돌아가 채워 주세요.",
      "«오늘 수업 한 줄»을 쓰면 학부모에게 함께 전해져요.",
    ],
  },
];

const SECTIONS: Step[] = [
  {
    title: "학부모에게 가는 알림",
    lines: [
      "출석·지각을 누르면 바로 «출석 안내»가 가요.",
      "결석은 3분 뒤에도 결석이면 «결석 안내»가 가요. 잘못 눌렀다면 3분 안에 고치면 안내가 나가지 않아요.",
      "수업을 종료하면 «수업 종료» 안내가 가요.",
    ],
  },
  {
    title: "아래 탭",
    lines: [
      "수업: 오늘 내 수업 목록(홈).",
      "학생: 내가 맡은 반 학생과 학부모 연락처. 전화·문자·번호 복사가 돼요.",
      "특강: 날짜를 넘기며 특강 수업을 시작하거나 기록을 봐요. 출석부는 정규 수업과 같아요.",
      "청구: 학부모 납부 상태를 보고, 현금·계좌이체로 받았으면 «요청»으로 원장님께 납부 확인을 요청해요.",
    ],
  },
  {
    title: "대타 수업",
    lines: ["원장님이 대타로 지정하면 그날 하루만 그 반이 «대타» 표시와 함께 «오늘 수업»에 나와요. 출석부 쓰는 방법은 같아요."],
  },
  {
    title: "그 밖에",
    lines: [
      "위쪽 이름 버튼(선생님 메뉴)에서 화면 바꾸기(학부모 화면 등)·내 계정·로그아웃을 해요.",
      "수업 중에는 로그아웃이 잠겨요. 수업을 종료한 뒤 로그아웃해 주세요.",
      "수업 진행 화면에서는 아래 탭이 숨겨져요. 끝나면 다시 보여요.",
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

export default function TeacherGuidePage() {
  return (
    <PublicPageLayout>
      <section className="public-page-hero public-page-hero--compact bg-[var(--color-public-dark)] py-8 text-white md:py-10">
        <div className="mx-auto max-w-3xl px-6 md:px-4">
          <h1 className="mb-1 break-keep text-2xl font-bold md:text-3xl">선생님 앱 사용 설명</h1>
          <p className="text-sm text-white/80">설치 → 로그인 → 수업 하나 끝내기까지</p>
        </div>
      </section>

      <SectionLayout className="public-content-section" bgColor="section">
        <div className="mx-auto max-w-3xl space-y-3">
          <Card title="1. 앱 설치">
            {lineList(["아이폰·안드로이드 스토어에서 «스티즈농구교실»을 설치해요. 아래 버튼을 누르면 내 휴대폰에 맞는 스토어로 가요."])}
            <Link
              href="/install"
              className="mt-3 inline-flex min-h-11 items-center gap-1 rounded-lg bg-[var(--color-public-accent)] px-4 text-sm font-semibold text-white hover:bg-[var(--color-public-strong)] dark:bg-[var(--color-public-orange)] dark:text-[var(--color-public-dark)]"
            >
              앱 설치하기
            </Link>
          </Card>

          <Card title="2. 로그인">
            {lineList([
              "로그인 화면 하나로 모두 로그인해요. 아이디 칸에 휴대폰 번호(숫자만), 비밀번호를 넣으면 선생님 화면이 바로 열려요.",
              "학부모로 먼저 가입했던 선생님은 원래 쓰던 아이디로 로그인하면 돼요.",
              "비밀번호를 모르면 원장님께 «비밀번호 재설정 링크»를 요청하세요. 문자로 온 링크(24시간 유효)에서 새 비밀번호(10자 이상)를 정해요.",
            ])}
          </Card>

          <Card title="3. 휴대폰 알림 켜기">
            {lineList(["로그인 후 위쪽 «알림» 버튼을 눌러 알림을 켜 주세요. 휴대폰이 알림을 지원하지 않으면 버튼이 보이지 않아요."])}
          </Card>

          <Card title="4. 수업 하나 끝내기">
            <ol className="space-y-3">
              {CLASS_FLOW.map((step, index) => (
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
            <Card key={section.title} title={`${index + 5}. ${section.title}`}>{lineList(section.lines)}</Card>
          ))}

          <p className="px-1 text-xs text-[var(--color-public-muted)]">궁금한 점은 원장님께 물어봐 주세요.</p>
        </div>
      </SectionLayout>
    </PublicPageLayout>
  );
}
