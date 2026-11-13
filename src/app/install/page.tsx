import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import PublicSiteTheme from "@/components/PublicSiteTheme";
import { detectInstallEnvironment } from "@/lib/pwa/installEnvironment";
import { PLAY_STORE_URL, appStoreUrl, resolveAppInstallTarget } from "@/lib/app-install-links";

// 가입 안내 문자의 «앱 설치» 짧은 주소(2026-11-13 f10).
// 문자에는 이 주소 하나만 넣고, 여기서 기기를 보고 갈 곳을 나눈다:
//   안드로이드 → Play 스토어로 바로 이동
//   아이폰     → App Store(앱 번호가 채워지면 바로 이동) / 출시 전에는 «곧 출시» + 웹으로 쓰기
//   PC 등      → 두 스토어 버튼을 보여 준다
// ⚠️ /app 은 예전부터 «홈 화면 바로가기(/mypage/install)» 짧은 주소라 그대로 두고, 스토어 설치는 새 주소를 쓴다.

// 기기마다 다른 곳으로 보내므로 미리 만들어 두면 안 된다(요청마다 UA 를 본다)
// 버튼 등급(게슈탈트 «유사성»): 꽉 찬 주 버튼 / 테두리 보조 버튼. 색은 공개 홈페이지 토큰(public-sport.css)
const PRIMARY_BUTTON = "flex min-h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--color-public-accent)] px-4 text-sm font-bold text-[var(--color-public-white)]";
const SECONDARY_BUTTON = "flex min-h-12 w-full items-center justify-center rounded-xl border border-[var(--color-public-accent)] px-4 text-sm font-bold text-[var(--color-public-accent)]";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "스티즈 농구교실 앱 설치",
  description: "출결·수업 소식·청구와 결제를 확인하는 스티즈 농구교실 앱을 설치하세요.",
};

export default async function AppInstallPage() {
  // 기기 판별은 설치 안내 화면들이 같이 쓰는 순수 모듈 한 곳에서만 한다
  const env = detectInstallEnvironment({ userAgent: (await headers()).get("user-agent") || "" });
  const target = resolveAppInstallTarget(env.platform);
  // 스토어로 바로 보낼 수 있으면 화면을 거치지 않는다(문자 링크 → 한 번에 스토어)
  if (target.kind === "redirect") redirect(target.url);

  const iosUrl = appStoreUrl();
  const isIphone = target.kind === "ios-coming-soon";

  return (
    <PublicSiteTheme publicScope>
      <main className="mx-auto flex min-h-[70vh] max-w-md items-center px-4 py-8">
        <section
          className="w-full rounded-2xl border border-[var(--color-public-line)] bg-[var(--color-public-paper)] p-5"
          aria-labelledby="install-title"
        >
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-3xl text-[var(--color-public-accent)]" aria-hidden="true">install_mobile</span>
            <div>
              <h1 id="install-title" className="text-lg font-black text-[var(--color-public-ink)]">스티즈 농구교실 앱</h1>
              <p className="text-sm text-[var(--color-public-muted)]">출결·수업 소식·청구와 결제를 한 곳에서</p>
            </div>
          </div>

          {isIphone ? (
            // 아이폰 + App Store 출시 전: 기다리게 하지 않고 웹으로 바로 쓰게 한다
            <div className="mt-4 space-y-2">
              <p className="rounded-xl bg-[var(--color-public-tint)] px-3 py-2 text-sm leading-6 text-[var(--color-public-ink)]">
                아이폰 앱은 곧 출시돼요. 그동안 홈페이지에서 똑같이 쓰실 수 있어요.
              </p>
              <Link href="/mypage" className={PRIMARY_BUTTON}>홈페이지로 쓰기</Link>
              <Link href="/parent-app" className={SECONDARY_BUTTON}>홈 화면에 바로가기 만들기</Link>
            </div>
          ) : (
            // PC 등 기기를 모를 때: 두 스토어를 나란히(아이폰은 출시 전이면 안내만)
            <div className="mt-4 space-y-2">
              <a href={PLAY_STORE_URL} className={PRIMARY_BUTTON} rel="noopener">
                <span className="material-symbols-outlined text-xl" aria-hidden="true">shop</span>
                안드로이드 · Play 스토어
              </a>
              {iosUrl ? (
                <a href={iosUrl} className={PRIMARY_BUTTON} rel="noopener">
                  <span className="material-symbols-outlined text-xl" aria-hidden="true">phone_iphone</span>
                  아이폰 · App Store
                </a>
              ) : (
                <p className="text-center text-xs leading-5 text-[var(--color-public-muted)]">아이폰 앱은 곧 출시돼요. 그동안 홈페이지에서 쓰실 수 있어요.</p>
              )}
              <Link href="/mypage" className={SECONDARY_BUTTON}>홈페이지로 쓰기</Link>
            </div>
          )}
        </section>
      </main>
    </PublicSiteTheme>
  );
}
