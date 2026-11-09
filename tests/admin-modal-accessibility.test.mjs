import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const modal = readFileSync(new URL("../src/components/admin/AdminModal.tsx", import.meta.url), "utf8");

test("공통 관리자 모달은 대화상자 의미와 제목 연결을 제공한다", () => {
    assert.match(modal, /role="dialog"/);
    assert.match(modal, /aria-modal="true"/);
    assert.match(modal, /aria-labelledby=\{titleId\}/);
});

test("공통 관리자 모달은 키보드 포커스를 가두고 닫은 뒤 원래 위치로 돌린다", () => {
    assert.match(modal, /event\.key === "Escape"/);
    assert.match(modal, /event\.key !== "Tab"/);
    // 2026-11-09: 창을 연 버튼이 사라졌으면(⚡ 메뉴 항목 등) 되돌리지 않는다 — 문서에 붙어 있을 때만
    assert.match(modal, /const previous = previousFocusRef\.current;\s*if \(previous\?\.isConnected\) previous\.focus\(\);/);
    assert.match(modal, /data-admin-modal-initial-focus/);
});

test("공통 관리자 모달은 배경 스크롤과 모바일 화면 높이를 안전하게 처리한다", () => {
    assert.match(modal, /document\.body\.style\.overflow = "hidden"/);
    assert.match(modal, /100dvh/);
    assert.match(modal, /safe-area-inset-bottom/);
    assert.match(modal, /overflow-y-auto/);
});

test("주요 관리자 운영 모달이 공통 컨테이너를 사용한다", () => {
    const files = [
        "../src/app/admin/apply/ApplyAdminModals.tsx",
        "../src/app/admin/schedule/ScheduleAdminModals.tsx",
        "../src/app/admin/trial/TrialCrmModals.tsx",
        "../src/app/admin/students/StudentManagementClient.tsx",
        "../src/app/admin/staff/AddStaffModal.tsx",
        "../src/app/admin/staff/InviteStaffModal.tsx",
        "../src/app/admin/apply/ApplyAdminClient.tsx",
        "../src/app/admin/trial/TrialCrmClient.tsx",
    ];
    for (const file of files) {
        const source = readFileSync(new URL(file, import.meta.url), "utf8");
        assert.match(source, /<AdminModal\b/, `${file}에서 AdminModal을 사용해야 합니다.`);
    }
});
