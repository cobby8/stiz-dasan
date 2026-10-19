"use client";

import { useState } from "react";

/** 이미지 실패 처리는 브라우저에서만 실행해 서버 리포트의 직렬화를 보존합니다. */
export default function ReportPhoto({ src, alt }: { src: string; alt: string }) {
    const [failed, setFailed] = useState(false);

    if (failed) return null;

    return (
        <img
            src={src}
            alt={alt}
            loading="lazy"
            className="w-full h-40 object-cover rounded-lg border border-gray-200 dark:border-gray-700"
            onError={() => setFailed(true)}
        />
    );
}
