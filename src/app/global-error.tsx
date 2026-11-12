"use client";

/**
 * 사이트 전체의 마지막 오류 화면(d1, 2026-11-13).
 *
 * 왜: 루트 레이아웃(src/app/layout.tsx) 자체에서 오류가 나면 src/app/error.tsx 도 그리지 못하고,
 * Next.js 기본(영어) 오류 화면이 뜬다. 이 파일은 레이아웃을 «대신»하므로 html·body 를 직접 갖고,
 * 테마 CSS·폰트·아이콘이 하나도 안 불러와졌을 수 있어 **다른 모듈을 쓰지 않는다**(의존성 최소).
 * 그래서 색도 CSS 변수 대신 이 화면 안에서만 쓰는 값을 둔다 — 테마 파일이 못 불러와진 상황을 위한 화면이다.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ko">
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif", background: "Canvas", color: "CanvasText" }}>
        <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", boxSizing: "border-box" }}>
          <section role="alert" style={{ maxWidth: "420px", width: "100%", textAlign: "center" }}>
            <h1 style={{ fontSize: "20px", margin: "0 0 8px" }}>화면을 불러오지 못했어요</h1>
            <p style={{ fontSize: "15px", lineHeight: 1.6, margin: "0 0 20px", opacity: 0.8 }}>
              잠시 연결이 불안정했을 수 있어요. 다시 시도해 주세요.
              <br />
              계속 안 되면 학원으로 연락해 주세요.
            </p>
            <div style={{ display: "flex", gap: "8px", justifyContent: "center", flexWrap: "wrap" }}>
              {/* 누르는 영역 44px 이상 */}
              <button
                type="button"
                onClick={() => reset()}
                style={{ minHeight: "44px", padding: "0 20px", fontSize: "15px", fontWeight: 700, borderRadius: "10px", border: "1px solid ButtonBorder", background: "ButtonFace", color: "ButtonText", cursor: "pointer" }}
              >
                다시 시도
              </button>
              {/* 레이아웃이 깨진 상태라 Next Link 대신 새로 불러오는 일반 링크 */}
              <a
                href="/"
                style={{ minHeight: "44px", padding: "0 20px", fontSize: "15px", fontWeight: 700, borderRadius: "10px", border: "1px solid ButtonBorder", color: "LinkText", display: "inline-flex", alignItems: "center", textDecoration: "none" }}
              >
                처음 화면으로
              </a>
            </div>
            {error.digest && <p style={{ marginTop: "16px", fontSize: "12px", opacity: 0.6 }}>확인 번호: {error.digest}</p>}
          </section>
        </main>
      </body>
    </html>
  );
}
