"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import AdminModal from "@/components/admin/AdminModal";
import { useBackToClose } from "@/components/common/useBackToClose";

interface ListDetailPanelProps {
    children: ReactNode;
    onClose: () => void;
    /** 패널 제목 요소의 id (스크린리더가 "무슨 창인지" 읽게 연결) */
    titleId: string;
    panelClassName?: string;
    closeOnBackdrop?: boolean;
    /**
     * 휴대폰 «뒤로» = 이 패널 닫기(2026-11-17, 학부모 화면). 켜면 열려 있는 동안 기록 한 칸을 넣어
     * 뒤로 가기가 화면째 나가지 않고 패널만 닫는다(규칙: overlayHistory). 끈 곳(관리자 화면)은 예전 그대로.
     */
    backToClose?: boolean;
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
    backToClose = false,
}: ListDetailPanelProps) {
    // 이 패널은 열려 있는 동안에만 그려진다 — 그려진 동안 = 열림
    const { captureLinks } = useBackToClose(backToClose, onClose);
    const router = useRouter();
    return (
        <AdminModal
            onClose={onClose}
            titleId={titleId}
            layout="side"
            panelClassName={panelClassName}
            closeOnBackdrop={closeOnBackdrop}
        >
            {/* 패널 안 링크는 넣어 둔 기록 칸을 먼저 되돌린 뒤 이동(backToClose 일 때만 — 아니면 captureLinks 는 아무 일 안 함).
                안 하면 새 화면 뒤에 같은 주소 칸이 남아 뒤로가 한 번 헛돈다(2026-11-17 검수) */}
            <div className="contents" onClickCapture={captureLinks((to) => router.push(to))}>
                {children}
            </div>
        </AdminModal>
    );
}
