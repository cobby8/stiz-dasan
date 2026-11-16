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
// 2026-11-16 지금 화면에 맞춰 고침(한 화면 접이식 수업 칸·출결 다시 누르면 취소·사진·영상 막대·지난 수업 고치기)
const CLASS_FLOW: Step[] = [
  {
    title: "수업 시작",
    lines: [
      "홈 «오늘 수업»에서 지금 수업의 «수업 시작»을 누르고, 확인 창에서 한 번 더 «수업 시작»을 눌러요.",
      "시작하면 그 자리에서 수업 칸이 펼쳐져요. 칸 머리를 누르면 접히고 펼쳐져요.",
    ],
  },
  {
    title: "출석부",
    lines: [
      "펼쳐진 «출석부»에서 아이마다 «출석 · 지각 · 결석» 중 하나를 눌러요. 누르는 순간 저장돼요(따로 저장 버튼 없음).",
      "잘못 눌렀으면 같은 버튼을 한 번 더 누르면 «미확인»으로 돌아가요(결석은 한 번 더 물어봐요).",
      "다 왔으면 «미확인 학생 전체 출석» 한 번이면 끝나요.",
      "«체험» 아이와 학부모가 결석을 미리 알린 아이는 전체 출석에서 빠지니 직접 눌러 주세요.",
      "결석이 아파서라면 «질병·부상 결석»도 눌러 주세요.",
      "학부모가 미리 알린 지각·조퇴는 이름 옆에 «지각 예정 17:20», «조퇴 예정 18:00»처럼 보여요.",
    ],
  },
  {
    title: "수업 내용·사진·영상(선택)",
    lines: [
      "«수업 내용»은 쓰고 «수업 내용 저장»을 눌러요. «메모»는 자동 저장돼요.",
      "화면 아래 «사진 · 동영상 · 갤러리»로 바로 찍거나 찍어 둔 것을 올려요. 영상은 30초 이내로 짧게 찍어 주세요.",
      "사진·영상은 그 수업에 참여한 아이의 학부모만 수업이 끝난 뒤 볼 수 있어요. 잘못 올린 영상은 «영상 삭제»로 지워요.",
    ],
  },
  {
    title: "수업 종료",
    lines: [
      "수업 칸 위쪽 «수업 종료» → 확인 창에서 «종료 확인»을 누르면 끝나요.",
      "출석을 아직 안 누른 아이가 있으면 종료가 안 돼요. «명단으로 가기»로 돌아가 채워 주세요.",
      "종료 창의 «학부모에게 보낼 글»에 수업 내용이 들어가요. «학부모에게 바로 보내기»가 켜져 있으면 함께 전해져요.",
      "실수로 시작했다면 «수업 시작 취소 (시작 전으로 되돌리기)»를 눌러요. 누른 출결은 그대로 남아요.",
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
    title: "지난 수업 다시 보기·고치기",
    lines: [
      "홈 맨 아래 «지난 수업»(최근 14일) 또는 «완료한 수업»을 펼쳐 들어가요.",
      "수업 내용·출결·사진·영상·메모를 고칠 수 있어요. 출결을 고쳐도 학부모 알림은 다시 가지 않아요.",
      "아직 학부모에게 안 보낸 수업은 «학부모에게 보내기»로 보내요.",
      "고칠 수 있는 기간은 수업일을 포함해 7일이에요. 지나면 원장님께 말씀해 주세요.",
    ],
  },
  {
    title: "아래 탭",
    lines: [
      "수업: 오늘 내 수업 목록(홈).",
      "학생: 내가 맡은 반 학생과 학부모 연락처. 전화·문자를 바로 할 수 있어요.",
      "일정: 학원 연간 일정(개강·종강·휴무·행사)을 달력으로 봐요. 날짜를 누르면 그날 일정이 나와요.",
      "특강: 날짜를 넘기며 특강 수업을 시작하거나 기록을 봐요. 출석부는 정규 수업과 같아요.",
    ],
  },
  {
    title: "대타 수업",
    lines: ["원장님이 대타로 지정하면 그날 하루만 그 반이 «대타» 표시와 함께 «오늘 수업»에 나와요. 출석부 쓰는 방법은 같아요."],
  },
  {
    title: "그 밖에",
    lines: [
      "위쪽 «○○ 선생님» 버튼(선생님 메뉴)에서 화면 바꾸기(학부모 화면 등)·청구·내 계정·로그아웃을 해요.",
      "청구(메뉴 안): 학부모 납부 상태를 보고, 현금·계좌이체로 받았으면 «납부 확인 요청»으로 원장님께 알려요.",
      "수업 칸이 펼쳐져 있는 동안에는 아래 탭이 숨겨져요. 칸을 접거나 수업을 끝내면 다시 보여요.",
      "로그아웃은 수업을 종료한 뒤에 해 주세요.",
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
            {lineList([
              "로그인 후 위쪽 이름 버튼 왼쪽의 종 모양을 눌러 알림을 켜 주세요. 켜지면 초록 종, 꺼져 있으면 회색 빗금 종이에요.",
              "앱에서는 처음 로그인할 때 «알림 허용» 창이 뜰 수 있어요. «허용»을 눌러 주세요.",
            ])}
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
