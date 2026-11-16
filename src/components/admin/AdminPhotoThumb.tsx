"use client";

import { useState } from "react";

/**
 * 관리자 화면의 사진 미리보기 한 칸(시설 사진·프로그램 이미지).
 *
 * - 이미 저장된 주소가 외부 사이트 주소일 수 있어 next/image 가 아니라 일반 <img> 로 그린다
 *   (next/image 는 허용된 도메인만 그려서, 옛 주소가 미리보기에서 깨질 수 있다).
 * - 불러오기에 실패하면 깨진 그림 대신 «사진을 불러올 수 없습니다» 글자를 보인다
 *   (SessionReportEditor 의 수업 사진과 같은 처리).
 * - 크기·모서리는 쓰는 쪽이 className 으로 정한다.
 */
export default function AdminPhotoThumb({ src, alt, className }: { src: string; alt: string; className: string }) {
    // 실패한 주소를 기억한다 — 주소가 바뀌면(사진 바꾸기) 새 주소는 다시 불러 본다.
    const [brokenSrc, setBrokenSrc] = useState<string | null>(null);

    if (brokenSrc === src) {
        return (
            <div className={`${className} flex items-center justify-center border border-dashed border-[var(--color-academy-line-input)] bg-[var(--color-academy-soft)] px-1 text-center`}>
                <span className="break-keep text-xs leading-tight text-[var(--color-academy-faint)]">사진을 불러올 수 없습니다</span>
            </div>
        );
    }

    return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={src}
            alt={alt}
            loading="lazy"
            className={`${className} border border-[var(--color-academy-line)] object-cover`}
            onError={() => setBrokenSrc(src)}
        />
    );
}
