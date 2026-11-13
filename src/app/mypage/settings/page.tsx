import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { logout } from "@/app/actions/auth";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { childAccessSql } from "@/lib/account/child-access";
import { notMergedStudent } from "@/lib/studentVisibility";
import { readPushPrefs } from "@/lib/parent-notification-preferences";
import { formatPhoneInput } from "@/lib/application-display-format";
import { FONT_SCALE_COOKIE, parseFontScale, SHOW_THEME_SETTING } from "@/lib/mypage/parentSettings";
import pkg from "../../../../package.json";
import { readPreferredPaymentMethod } from "@/lib/payments/preferredMethodStore";
import { NameRow, PasswordRow, NotificationRows, FontScaleRow, FeedbackRow, PaymentMethodRow } from "./SettingsClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "설정 | 스티즈 농구교실" };

// 학부모 앱 설정 (2026-11-10 원장 결정 k7·m5) — 머리줄 ⚙ 가 데려오는 화면.
// 예전 «⋯» 메뉴(알림·자녀 연결·간편로그인·로그아웃)를 전부 여기로 모았다.
// 한 줄 행 목록을 섹션으로 묶는다. 설명 문장은 꼭 필요한 곳에만.

// 한 줄 행(링크·보기 전용) — 높이 48px, 왼쪽 이름, 오른쪽 값·«›» (2026-11-13 UI 통일: 줄 앞 장식 아이콘을 뺐다)
const ROW = "flex min-h-12 w-full items-center gap-3 px-4 py-1.5 text-left text-sm";
const LINK_ROW = `${ROW} hover:bg-[var(--color-academy-soft)]`;

// 섹션 = 작은 제목 + 테두리 칸 안의 줄 목록(근접성: 같은 묶음은 한 칸 안에)
function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
    return (
        <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="scroll-mt-20">
            <h2 id={id ? `${id}-title` : undefined} className="px-1 pb-1 text-xs font-medium text-[var(--color-academy-muted)]">{title}</h2>
            <ul className="academy-panel divide-y divide-[var(--color-academy-line)] overflow-hidden">{children}</ul>
        </section>
    );
}

function LinkRow({ href, label, value }: { href: string; label: string; value?: string }) {
    return (
        <li>
            <Link href={href} className={LINK_ROW}>
                <span className="flex-1 font-medium text-[var(--color-academy-ink)]">{label}</span>
                {value && <span className="shrink-0 text-[var(--color-academy-muted)]">{value}</span>}
                <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-faint)]">›</span>
            </Link>
        </li>
    );
}

export default async function ParentSettingsPage() {
    const parent = await requireVerifiedParent().catch(() => null);
    // bounced=1 로 목적지를 지운다(다른 계정 화면과 같은 이유 — 거절 → 판별 → 거절 반복 방지)
    if (!parent) redirect("/mypage/continue?bounced=1");

    const supabase = await createClient();
    // 모든 조회의 대상 = 서버가 확인한 로그인 사용자(parent.appUserId) — 화면 값으로 남의 정보를 열 수 없다
    const [userRows, authResult, childRows, pushPrefs, cookieStore, preferredMethod] = await Promise.all([
        prisma.$queryRawUnsafe<{ name: string; phone: string | null; username: string | null; role: string }[]>(
            `SELECT name, phone, username, role::text AS role FROM "User" WHERE id = $1 LIMIT 1`,
            parent.appUserId,
        ),
        supabase.auth.getUser(),
        prisma.$queryRawUnsafe<{ id: string; name: string }[]>(
            `SELECT s.id, s.name FROM "Student" s WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")} ORDER BY s.name`,
            parent.appUserId,
        ).catch(() => [] as { id: string; name: string }[]),
        readPushPrefs(parent.appUserId),
        cookies(),
        // 자주 쓰는 결제 방법(칸이 없거나 못 읽으면 null — 설정 화면은 그대로 열린다)
        readPreferredPaymentMethod(parent.appUserId),
    ]);
    const me = userRows[0];
    const authUser = authResult.data?.user;
    // 아이디·비밀번호로 로그인하는 계정인가(간편로그인만 쓰는 계정은 비밀번호가 없다)
    const hasPasswordLogin = (authUser?.identities ?? []).some((identity) => identity.provider === "email");
    const fontScale = parseFontScale(cookieStore.get(FONT_SCALE_COOKIE)?.value);
    // 앱 정보 — 웹 버전(package.json) + 배포 번호(Vercel 이 넣어 주는 커밋 앞 7자리, 없으면 생략)
    const build = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7);
    const versionLabel = build ? `${pkg.version} (${build})` : pkg.version;

    return (
        <div className="mx-auto grid max-w-2xl gap-4">
            <div className="flex items-center gap-2">
                {/* 뒤로가기 = 누르는 영역 44×44(academy-back-link) */}
                <Link href="/mypage" aria-label="홈으로" className="academy-back-link">
                    <span className="material-symbols-outlined" aria-hidden="true">arrow_back</span>
                </Link>
                <h1 className="academy-heading">설정</h1>
            </div>

            {/* 내 정보 — 이름은 고칠 수 있고, 연락처는 보기만(가입·자녀 연결의 본인 확인 번호라 학원에서 바꾼다) */}
            <Section title="내 정보">
                <NameRow name={me?.name ?? parent.appUserName} />
                <li className={ROW}>
                    <span className="w-16 shrink-0 font-medium text-[var(--color-academy-ink)]">연락처</span>
                    {/* 안내는 번호 아래 줄 — 큰 글자·좁은 화면에서도 번호가 잘리지 않게 */}
                    <span className="min-w-0 flex-1">
                        <span className="block tabular-nums text-[var(--color-academy-muted)]">{me?.phone ? formatPhoneInput(me.phone) : "없음"}</span>
                        <span className="block text-xs text-[var(--color-academy-faint)]">변경은 학원 문의</span>
                    </span>
                </li>
                {me?.username && (
                    <li className={ROW}>
                        <span className="w-16 shrink-0 font-medium text-[var(--color-academy-ink)]">아이디</span>
                        <span className="min-w-0 flex-1 truncate text-[var(--color-academy-muted)]">{me.username}</span>
                    </li>
                )}
            </Section>

            <Section title="로그인">
                {hasPasswordLogin && <PasswordRow />}
                <LinkRow href="/mypage/login-methods" label="간편로그인 연결" />
            </Section>

            {/* 결제 — 고른 방법이 결제 화면 맨 위 큰 버튼이 된다 */}
            <Section title="결제">
                <PaymentMethodRow current={preferredMethod} />
            </Section>

            <Section title="가족">
                <LinkRow href="/mypage/children" label="자녀·가족 초대" />
                {/* 예전 «⋯» 메뉴에 들어갈 예정이던 형제·자매 상담(상담 신청 화면은 별도 작업) — ⋯ 를 없애 여기로 */}
                <LinkRow href="/mypage/consult" label="형제·자매 상담 신청" />
            </Section>

            {/* 종 패널의 «알림 설정»이 이 자리로 데려온다 */}
            <Section id="settings-notifications" title="알림 설정">
                {/* 종류별 받기는 학부모 계정만 — 자녀가 있는 직원 계정은 업무 알림이 같은 종류라 끄지 못하게(발송 쪽도 PARENT 만 거른다) */}
                <NotificationRows initialPrefs={pushPrefs.prefs} prefsAvailable={pushPrefs.available && me?.role === "PARENT"} />
            </Section>

            <Section title="화면">
                <FontScaleRow current={fontScale} />
                {/* 테마(어둡게) 자리 — 원장 결정 m5: 다크모드 작업 때 SHOW_THEME_SETTING 을 켜고 줄을 넣는다. 지금은 숨김 */}
                {SHOW_THEME_SETTING ? <li className={ROW}><span className="flex-1 font-medium text-[var(--color-academy-ink)]">테마</span></li> : null}
            </Section>

            <Section title="도움">
                <FeedbackRow childList={childRows} />
            </Section>

            <Section title="앱 정보">
                <li className={ROW}>
                    <span className="flex-1 font-medium text-[var(--color-academy-ink)]">버전</span>
                    <span className="shrink-0 tabular-nums text-[var(--color-academy-muted)]">{versionLabel}</span>
                </li>
                <LinkRow href="/terms" label="이용약관" />
                <LinkRow href="/privacy" label="개인정보처리방침" />
            </Section>

            {/* 로그아웃 · 회원 탈퇴 — 맨 끝. 탈퇴는 되돌릴 수 없어 위험색 글자로 따로 */}
            <ul className="academy-panel divide-y divide-[var(--color-academy-line)] overflow-hidden">
                <li>
                    <form action={logout}>
                        <button
                            type="submit"
                            className="inline-flex min-h-12 w-full items-center gap-3 px-4 text-sm font-medium text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]"
                        >
                            로그아웃
                        </button>
                    </form>
                </li>
                <li>
                    <Link href="/mypage/withdraw" className={`${LINK_ROW} font-medium text-[var(--color-academy-danger)]`}>
                        <span className="flex-1">회원 탈퇴</span>
                        <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-faint)]">›</span>
                    </Link>
                </li>
            </ul>
        </div>
    );
}
