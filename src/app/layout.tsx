import type { Metadata } from "next";
import "./globals.css";
import "./academy-theme.css";
import { getAcademySettings } from "@/lib/queries";
import { BODY_FONT_OPTIONS, HEADING_FONT_OPTIONS, getFontCss } from "@/lib/fonts";
import { ThemeProvider } from "@/components/ThemeProvider";
import MetaPixel from "@/components/MetaPixel";
import DeferredFontStyles from "@/components/DeferredFontStyles";
import PwaUpdater from "@/components/PwaUpdater";
import ThemeColorUpdater from "@/components/ThemeColorUpdater";
import { buildPublicMetadata } from "@/lib/publicMetadata";
import StandaloneBackButton from "@/components/StandaloneBackButton";

export const metadata: Metadata = {
    ...buildPublicMetadata({
        title: "남양주 다산 농구교실 | STIZ 다산2호점",
        description: "유아·초등·중등 수준별 맞춤 농구 수업, 전문 코치진, 셔틀 안내와 체험수업 신청까지 한 번에 확인하세요.",
        path: "/",
    }),
    // PWA manifest 연결 - 홈 화면 추가 시 앱처럼 동작하게 해줌
    manifest: "/manifest.json",
    // iOS Safari용 PWA 설정 (Apple은 manifest를 완전히 지원하지 않아 별도 메타 태그 필요)
    appleWebApp: {
        capable: true,
        statusBarStyle: "black-translucent",
        title: "스티즈농구",
    },
};

export default async function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    // 폰트 설정을 DB에서 읽어 CSS 변수로 주입 (실패 시 시스템 폰트로 fallback)
    let bodyFontCss = getFontCss("system", BODY_FONT_OPTIONS);
    let headingFontCss = getFontCss("same-as-body", HEADING_FONT_OPTIONS);
    try {
        const settings = await getAcademySettings() as any;
        bodyFontCss = getFontCss(settings?.siteBodyFont, BODY_FONT_OPTIONS);
        const rawHeading = getFontCss(settings?.siteHeadingFont, HEADING_FONT_OPTIONS);
        headingFontCss = rawHeading === "inherit" ? bodyFontCss : rawHeading;
    } catch {
        // fallback to system fonts
    }

    return (
        <html
            lang="ko"
            suppressHydrationWarning
        >
            <head>
                {/* PWA 테마 색상은 ThemeColorUpdater가 현재 테마에 맞게 갱신합니다. */}
                <meta name="theme-color" content="#ccff00" />
                {/* 파일명을 버전 처리해 브라우저에 남은 이전 탭 아이콘 캐시를 교체합니다. */}
                <link rel="icon" href="/favicon-v2.ico" sizes="any" />
                <link rel="shortcut icon" href="/favicon-v2.ico" />
                {/* iOS에서 홈 화면 아이콘으로 쓸 이미지 */}
                <link rel="apple-touch-icon" href="/icon-v2-192.png" />
                {/*
                  PWA 설치 이벤트(beforeinstallprompt) 캡처.
                  크롬은 페이지가 뜨자마자 이 이벤트를 한 번만 쏘는데, React 하이드레이션 후
                  useEffect에서 리스너를 달면 그 사이에 발생한 이벤트를 놓쳐 설치 버튼이 영영 안 뜬다.
                  그래서 React보다 먼저 실행되는 인라인 스크립트로 이벤트를 붙잡아 전역에 보관하고,
                  설치 화면들은 마운트할 때 이 값을 읽어간다. (계약: __stizInstallPrompt / stiz:installprompt / stiz:installed)
                */}
                <script
                    dangerouslySetInnerHTML={{
                        __html: `(function(){try{if(window.__stizInstallPromptReady)return;window.__stizInstallPromptReady=1;window.__stizInstallPrompt=null;window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();window.__stizInstallPrompt=e;window.dispatchEvent(new Event("stiz:installprompt"));});window.addEventListener("appinstalled",function(){window.__stizInstallPrompt=null;window.dispatchEvent(new Event("stiz:installed"));});}catch(e){}})();`,
                    }}
                />
            </head>
            <body
                className="antialiased selection:bg-brand-orange-500 selection:text-white dark:selection:bg-brand-neon-lime dark:selection:text-brand-navy-900"
                style={
                    {
                        "--font-body": bodyFontCss,
                        "--font-heading": headingFontCss,
                    } as React.CSSProperties
                }
            >
                <ThemeProvider
                    attribute="class"
                    defaultTheme="dark"
                    enableSystem
                    disableTransitionOnChange
                >
                    <DeferredFontStyles />
                    <MetaPixel />
                    <ThemeColorUpdater />
                    <PwaUpdater />
                    <StandaloneBackButton />
                    {children}
                </ThemeProvider>
            </body>
        </html>
    );
}
