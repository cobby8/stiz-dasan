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
    /**
     * 휴대폰·브라우저 «뒤로» = 이 패널만 닫기. 열려 있는 동안 기록 한 칸을 넣어 뒤로 가기가 화면째 나가지 않는다
     * (규칙: overlayHistory). 2026-11-18 원장 결정 ①부터 기본 켜짐(관리자·선생님 화면 포함) — 기록 칸 관리는 AdminModal 이 한다.
     * 기록 칸을 스스로 관리하는 시트(청구 시트)만 false 로 끈다.
     */
    backToClose?: boolean;
    /** 저장·처리 중 — 그동안은 «뒤로»를 눌러도 패널이 닫히지 않는다 */
    busy?: boolean;
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
    backToClose = true,
    busy = false,
}: ListDetailPanelProps) {
    // «뒤로 = 닫기»·패널 안 링크 처리(칸을 먼저 되돌린 뒤 이동)는 AdminModal 한 곳에서 한다 — 두 벌 만들지 않는다
    return (
        <AdminModal
            onClose={onClose}
            titleId={titleId}
            layout="side"
            panelClassName={panelClassName}
            closeOnBackdrop={closeOnBackdrop}
            backToClose={backToClose}
            busy={busy}
        >
            {children}
        </AdminModal>
    );
}
