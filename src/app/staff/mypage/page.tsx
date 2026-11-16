import Link from "next/link";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { logoutStaff } from "@/app/actions/auth";
import CalendarSyncButton from "@/components/calendar/CalendarSyncButton";
import ProfileAvatar from "@/components/common/ProfileAvatar";
import { StaffPushToggle } from "@/components/push/StaffPushControls";
import AppVersionRow from "@/components/storeApp/AppVersionRow";
import { requireStaff } from "@/lib/auth-guard";
import { getStaffMyClasses, getStaffMyProfile } from "@/lib/staff-mypage";
import { getStaffMonthSessionStats } from "@/lib/staff-past-sessions";
import { classDayLabel, kstMonthRangeAt, needsPastSessionsLink, staffPhoneLabel, staffRoleLabel } from "@/lib/staff/mypageRules";
import { appVersionLabels } from "@/lib/storeApp";
import StaffInstallGuideRow from "./StaffInstallGuideRow";

export const dynamic = "force-dynamic";

/**
 * 선생님 «마이페이지»(2026-11-16 원장 지시 「선생님 메뉴에도 내 계정이 아니라 마이페이지 만들고 필요한 기능 추가」).
 * 위에서 아래로: 내 정보 · 내 담당 반 · 이번 달 수업 · 알림 설정 · 도움말·앱 정보 · 로그아웃.
 * 선생님·기사님 모두 들어온다 — «내 담당 반»과 «이번 달 수업»은 선생님(roles.teacher)에게만 보인다.
 * 청구는 넣지 않는다(원장 「청구는 필요 없어」).
 */

// 한 줄 행(높이 48px) — 학부모 설정 화면의 줄과 같은 모양
const ROW = "flex min-h-12 w-full items-center gap-3 px-4 py-1.5 text-left text-sm";
const LINK_ROW = `${ROW} hover:bg-[var(--color-academy-soft)]`;

// 칸 = 칸 제목 + 테두리 안의 줄 목록(근접성: 같은 묶음은 한 칸 안에)
function Section({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <div className="flex items-end justify-between gap-3 px-1 pb-1">
        <h2 id={id} className="academy-section-title">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const LIST = "academy-panel divide-y divide-[var(--color-academy-line)] overflow-hidden";
const EMPTY = "academy-panel px-4 py-3 text-sm text-[var(--color-academy-muted)]";
// 불러오지 못했을 때 — 화면 전체를 막지 않고 그 칸에만 알린다
const LOAD_FAILED = "불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.";

export default async function StaffMyPage() {
  const staff = await requireStaff();
  const isTeacher = staff.roles.teacher;
  // 원장·부원장은 수업 숫자가 «전체 반» 기준이다(지난 수업 화면과 같은 범위)
  const seesAllClasses = staff.appUserRole === "ADMIN" || staff.appUserRole === "VICE_ADMIN";
  // «이번 달» = KST 달(공용 KST 모듈로만 구한다 — 서버 시계의 날짜 함수는 쓰지 않는다)
  const month = kstMonthRangeAt();

  const [profile, classes, stats, headerStore] = await Promise.all([
    getStaffMyProfile(staff),
    // 선생님 전용 칸 — 기사님만인 계정은 조회하지 않는다
    isTeacher ? getStaffMyClasses().catch(() => null) : Promise.resolve(null),
    isTeacher ? getStaffMonthSessionStats(month).catch(() => null) : Promise.resolve(null),
    // 요청 머리말 — 스토어 앱 버전 표식을 읽는다(학부모 설정 «앱 정보»와 같은 방식)
    headers(),
  ]);

  const roleLabel = staffRoleLabel(staff.appUserRole, staff.roles);
  const phoneLabel = staffPhoneLabel(profile.phone);
  const version = appVersionLabels({ userAgent: headerStore.get("user-agent"), build: process.env.VERCEL_GIT_COMMIT_SHA });

  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 pb-8 pt-5">
      <h1 className="academy-heading">마이페이지</h1>

      {/* 1. 내 정보 — 사진(없으면 이름 첫 글자)·이름·역할·연락처 + 계정 화면으로 가는 줄 */}
      <section aria-label="내 정보" className={LIST}>
        <div className="flex items-center gap-3 px-4 py-3">
          <ProfileAvatar name={profile.name} src={profile.photoSrc} size={40} decorative />
          <div className="min-w-0 flex-1">
            <p className="break-keep text-base font-semibold text-[var(--color-academy-ink)]">{profile.name}</p>
            <p className="text-sm tabular-nums text-[var(--color-academy-muted)]">
              {roleLabel}{phoneLabel ? ` · ${phoneLabel}` : " · 연락처 없음"}
            </p>
          </div>
        </div>
        {/* 계정 일(가족 연결·회원 탈퇴)은 다시 만들지 않고 기존 «내 계정» 화면으로 보낸다 */}
        <Link href="/account" className={LINK_ROW}>
          <span className="flex-1 font-medium text-[var(--color-academy-primary)]">계정 관리</span>
          <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-faint)]">›</span>
        </Link>
        {/* 간편로그인(Apple·카카오 등)을 이 계정에 붙이는 화면(2026-11-17 원장 지시) — 직원 전용 연결 화면으로 간다 */}
        <Link href="/staff/mypage/login-methods" className={LINK_ROW}>
          <span className="flex-1 font-medium text-[var(--color-academy-primary)]">간편로그인 연결</span>
          <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-faint)]">›</span>
        </Link>
      </section>

      {/* 2. 내 담당 반 — 선생님만. 읽기 전용(누르는 줄이 아니다) */}
      {isTeacher && (
        <Section id="staff-mypage-classes" title="내 담당 반" aside={classes && classes.length > 0 ? <p className="text-xs tabular-nums text-[var(--color-academy-muted)]">{classes.length}개 반</p> : undefined}>
          {classes === null ? (
            <p role="status" className={EMPTY}>{LOAD_FAILED}</p>
          ) : classes.length === 0 ? (
            <p role="status" className={EMPTY}>담당으로 연결된 반이 없습니다</p>
          ) : (
            <ul className={LIST}>
              {classes.map((row) => (
                <li key={row.id} className="flex min-h-12 items-center gap-2 px-4 py-1.5 text-sm">
                  <span className="shrink-0 text-xs font-medium tabular-nums text-[var(--color-academy-ink)]">
                    {classDayLabel(row.dayOfWeek)} {row.startTime}–{row.endTime}
                  </span>
                  {/* 반 이름은 자르지 않고 줄바꿈 허용(말줄임 금지) */}
                  <span className="min-w-0 flex-1 break-keep font-medium text-[var(--color-academy-ink)]">{row.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-[var(--color-academy-muted)]">학생 {row.studentCount}명</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {/* 3. 이번 달 수업 — 선생님만. 숫자 판정은 «지난 수업» 화면과 같은 조각을 쓴다 */}
      {isTeacher && (
        <Section
          id="staff-mypage-month"
          title={`이번 달 ${seesAllClasses ? "수업" : "내 수업"}`}
          aside={<p className="text-xs text-[var(--color-academy-muted)]">{month ? `${month.label} · 오늘까지` : ""}{seesAllClasses ? " · 전체 반" : ""}</p>}
        >
          {stats === null ? (
            <p role="status" className={EMPTY}>{LOAD_FAILED}</p>
          ) : (
            <div className="academy-panel overflow-hidden">
              <dl className="grid grid-cols-3 divide-x divide-[var(--color-academy-line)]">
                <StatCell label="완료한 수업" value={stats.completed} tone="text-[var(--color-academy-ink)]" />
                {/* 색만으로 알리지 않는다 — 이름표가 뜻을 말하고, 0보다 클 때만 주의 색 */}
                <StatCell label="수업 내용 없음" value={stats.noFeed} tone={stats.noFeed > 0 ? "text-[var(--color-academy-warning)]" : "text-[var(--color-academy-ink)]"} />
                <StatCell label="학부모에게 안 보냄" value={stats.unpublished} tone={stats.unpublished > 0 ? "text-[var(--color-academy-warning)]" : "text-[var(--color-academy-ink)]"} />
              </dl>
              {needsPastSessionsLink(stats) && (
                <Link href="/staff/sessions" className={`${LINK_ROW} border-t border-[var(--color-academy-line)]`}>
                  <span className="flex-1 font-medium text-[var(--color-academy-primary)]">지난 수업 보기</span>
                  <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-faint)]">›</span>
                </Link>
              )}
            </div>
          )}
        </Section>
      )}

      {/* 4. 알림 설정 — 머리줄과 같은 부품(StaffPushToggle)을 그대로 끼운다. 이 기기가 알림을 못 받으면 종이 그려지지 않는다 */}
      <Section id="staff-mypage-push" title="알림 설정">
        <ul className={LIST}>
          <li className={ROW}>
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-[var(--color-academy-ink)]">휴대폰 알림</span>
              <span className="block text-xs text-[var(--color-academy-muted)]">오른쪽 종을 눌러 켜고 꺼요. 종이 없으면 휴대폰 설정의 앱 알림에서 바꿔요.</span>
            </span>
            <StaffPushToggle />
          </li>
        </ul>
      </Section>

      {/* 5. 캘린더 연동 — 학원 일정·내 수업을 골라 휴대폰 캘린더에 넣는다(일정 화면의 버튼과 같은 부품) */}
      <Section id="staff-mypage-calendar" title="캘린더 연동">
        <ul className={LIST}>
          <li className={ROW}>
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-[var(--color-academy-ink)]">내 휴대폰 캘린더</span>
              <span className="block text-xs text-[var(--color-academy-muted)]">학원 일정과 내 수업을 골라 넣어요. 한 번 연동하면 알아서 새로 받아 와요.</span>
            </span>
            <CalendarSyncButton theme="academy" />
          </li>
        </ul>
      </Section>

      {/* 6. 도움말·앱 정보 — 앱 버전(스토어 앱일 때), 설치 안내(스토어 앱이 아닐 때) */}
      <Section id="staff-mypage-help" title="도움말·앱 정보">
        <ul className={LIST}>
          {version.app ? (
            <AppVersionRow appLabel={version.app} />
          ) : (
            <li className={ROW}>
              <span className="flex-1 font-medium text-[var(--color-academy-ink)]">버전</span>
              <span className="shrink-0 text-[var(--color-academy-muted)]">웹으로 보는 중</span>
            </li>
          )}
          <StaffInstallGuideRow />
        </ul>
      </Section>

      {/* 7. 로그아웃 — 이름 버튼 메뉴와 같은 logoutStaff */}
      <form action={logoutStaff} className="academy-panel overflow-hidden">
        <button type="submit" className={`${LINK_ROW} font-medium text-[var(--color-academy-ink)]`}>
          로그아웃
        </button>
      </form>
    </main>
  );
}

// 숫자 한 칸 — 숫자가 주인공, 이름표는 작게
function StatCell({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex min-h-14 flex-col-reverse items-center justify-center px-1 py-2 text-center">
      <dt className="break-keep text-xs text-[var(--color-academy-muted)]">{label}</dt>
      <dd className={`text-xl font-semibold tabular-nums ${tone}`}>{value}</dd>
    </div>
  );
}
