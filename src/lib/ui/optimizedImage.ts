/**
 * 사진을 «보이는 크기»에 맞춰 줄여 받게 하는 주소 만들기(2026-11-18 속도 조치).
 *
 * 홈 사진은 Supabase 저장소의 원본(장당 200~300KB)을 그대로 받았다 — 휴대폰에서 12장 2.2MB.
 * Next 의 이미지 줄이기(/_next/image)를 거치면 화면 폭에 맞는 크기 + webp/avif 로 나간다(같은 사진이 37~55KB).
 * <img> 태그와 기존 CSS 는 그대로 두고 src·srcSet·sizes 만 바꾼다(next/image 부품으로 바꾸면 배치 CSS 를 다시 짜야 한다).
 *
 * 다른 모듈을 import 하지 않는 순수 함수다 — 테스트가 그대로 실행한다.
 * 폭 목록은 Next 기본 허용 폭(deviceSizes·imageSizes)에 있는 값만 쓴다. 없는 폭을 요청하면 400 이 난다.
 */

/** next.config.ts images.remotePatterns 와 같은 범위 중 «우리 저장소»만 줄인다(그 밖의 주소는 원래 주소 그대로) */
const OPTIMIZABLE_HOST = /\.supabase\.(co|in)$/;
/** Next 기본 허용 폭 가운데 쓰는 것 */
export const OPTIMIZED_WIDTHS = [256, 384, 640, 828, 1080, 1200, 1920] as const;
const QUALITY = 75; // Next 기본 허용 품질

export type OptimizedImageProps = { src: string; srcSet?: string; sizes?: string };

function optimizable(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" && OPTIMIZABLE_HOST.test(parsed.hostname);
    } catch {
        return false;
    }
}

function optimizedUrl(url: string, width: number): string {
    return `/_next/image?url=${encodeURIComponent(url)}&w=${width}&q=${QUALITY}`;
}

/**
 * @param url    원본 사진 주소
 * @param sizes  화면에서 차지하는 폭(CSS sizes 값, 예: "100vw" · "(max-width: 767px) 50vw, 20vw")
 * @param maxWidth 이 폭보다 큰 후보는 만들지 않는다(작게만 보이는 사진에 큰 파일을 주지 않게)
 */
export function optimizedImageProps(url: string, sizes: string, maxWidth: number = 1920): OptimizedImageProps {
    if (!url || !optimizable(url)) return { src: url };
    const widths = OPTIMIZED_WIDTHS.filter((w) => w <= maxWidth);
    if (!widths.length) return { src: url };
    return {
        // srcSet 을 모르는 아주 옛 브라우저용 기본값 — 가운데 크기
        src: optimizedUrl(url, widths[Math.min(2, widths.length - 1)]),
        srcSet: widths.map((w) => `${optimizedUrl(url, w)} ${w}w`).join(", "),
        sizes,
    };
}
