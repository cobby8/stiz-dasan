import type { ReactNode } from "react";

/**
 * 관리자 페이지 머리말 — 제목 한 가지 모양(2026-11-13 UI 통일 1단계).
 *
 * 왜: 관리자 화면의 h1 이 크기 3종 × 굵기 3종 = 20가지로 흩어져 «덜 다듬어진» 인상을 줬다.
 * 새 화면과 고치는 화면은 직접 <h1 className="..."> 을 쓰지 말고 이 부품을 쓴다.
 * 모양 값은 academy-theme.css 의 .academy-page-title / .academy-page-description 한 곳에 있다.
 *
 * - title: 페이지 제목(한 줄). 아이콘을 붙이지 않는다 — 글자로만 말한다.
 * - description: 제목 옆·아래 보조 설명(건수·기간 같은 한 줄 정보)
 * - actions: 오른쪽 버튼 묶음. 주 버튼(academy-button-primary)은 한 화면에 하나만.
 */
export default function AdminPageHeader({
    title,
    description,
    actions,
    className = "",
}: {
    title: ReactNode;
    description?: ReactNode;
    actions?: ReactNode;
    className?: string;
}) {
    return (
        <div className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 ${className}`}>
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                <h1 className="academy-page-title">{title}</h1>
                {description != null && <p className="academy-page-description">{description}</p>}
            </div>
            {actions != null && <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
    );
}
