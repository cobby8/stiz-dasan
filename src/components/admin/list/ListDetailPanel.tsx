"use client";

import type { ReactNode } from "react";
import AdminModal from "@/components/admin/AdminModal";

interface ListDetailPanelProps {
    children: ReactNode;
    onClose: () => void;
    /** 패널 제목 요소의 id (스크린리더가 "무슨 창인지" 읽게 연결) */
    titleId: string;
    panelClassName?: string;
    closeOnBackdrop?: boolean;
}

/**
 * 목록 행을 눌렀을 때 여는 상세 패널.
 * - 데스크톱(md 이상): 화면 오른쪽에서 열리는 폭 420px 패널
 * - 모바일: 아래에서 올라오는 시트
 * Esc·바깥 클릭·포커스 가두기·닫은 뒤 원래 행으로 포커스 복귀는 AdminModal 의 것을 그대로 쓴다
 * (같은 규칙을 두 벌 만들지 않기 위해 껍데기 배치만 바꾼다).
 */
export default function ListDetailPanel({
    children,
    onClose,
    titleId,
    panelClassName = "",
    closeOnBackdrop = true,
}: ListDetailPanelProps) {
    return (
        <AdminModal
            onClose={onClose}
            titleId={titleId}
            layout="side"
            panelClassName={panelClassName}
            closeOnBackdrop={closeOnBackdrop}
        >
            {children}
        </AdminModal>
    );
}
