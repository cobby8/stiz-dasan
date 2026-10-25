import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { notMergedStudent, notMergedStudentOptional, NOT_MERGED_STUDENT } from "./studentVisibility.ts";

// ── 1. 조건식 자체 검증 ────────────────────────────────────────────────

test("INNER JOIN/FROM 용 조건은 별칭에 붙는다", () => {
    assert.equal(notMergedStudent("s"), 's."mergedIntoStudentId" IS NULL');
    assert.equal(notMergedStudent("student"), 'student."mergedIntoStudentId" IS NULL');
});

test("LEFT JOIN 용 조건은 학생이 안 붙은 행을 살려 둔다", () => {
    // 이 형태가 아니면 학생이 매칭되지 않은 행이 WHERE에서 통째로 사라진다(= 정상 데이터 소실).
    assert.equal(
        notMergedStudentOptional("s"),
        '(s.id IS NULL OR s."mergedIntoStudentId" IS NULL)',
    );
    assert.match(notMergedStudentOptional("s"), /IS NULL OR/);
});

test("Prisma where 조각은 흡수되지 않은 학생만 고른다", () => {
    assert.deepEqual(NOT_MERGED_STUDENT, { mergedIntoStudentId: null });
});

// ── 2. 소스 전수 가드 ──────────────────────────────────────────────────
//
// 왜 이런 테스트를 두는가:
// 병합은 하드 DELETE를 하지 않으므로, 학생을 읽는 새 쿼리에 이 조건을 빠뜨리면
// 그 화면에만 조용히 유령 학생이 생긴다. 사람이 매번 기억할 수 없으니 테스트가 대신 잡는다.
//
// 아래 목록은 "일부러 필터를 걸지 않은 자리"다. 숫자가 늘어나면 테스트가 실패하므로,
// 새 코드를 추가한 사람은 (a) 필터를 걸거나 (b) 여기에 사유를 적어야 한다.
const ALLOWED_WITHOUT_FILTER: Record<string, { count: number; reason: string }> = {
    // 병합 엔진 본체 — 흡수된 쪽을 읽어야 병합/되돌리기가 가능하다.
    "lib/studentMerge/engine.ts": { count: 4, reason: "병합 엔진 자체(대상 학생을 직접 읽어야 함)" },

    // 회원 탈퇴(2026-10-25) — 흡수된 학생을 빼면 오히려 위험한 경우다.
    //   재학 판정 2건: 흡수된 학생의 수강까지 세야 «재학 중»을 놓치지 않는다. 덜 세면 즉시 삭제로 간다.
    //   좌표 파기 1건: 탈퇴 시 위치정보는 흡수된 학생 것까지 지워야 한다.
    "app/actions/parent-account.ts": { count: 3, reason: "회원 탈퇴 — 재학 판정은 많이 세는 쪽이 안전, 위치정보 파기는 흡수분까지" },

    // 청구·수납 — 흡수된 쪽에 청구가 남았을 때 화면에서 숨기면 미납이 사라진다.
    "lib/payment-ledger.ts": { count: 2, reason: "청구/청구서 목록 — 돈을 숨기는 쪽이 더 위험" },
    "lib/staff-class-billing.ts": { count: 1, reason: "교사앱 청구 목록" },
    "lib/staff-portal-queries.ts": { count: 1, reason: "교사앱 청구 목록(getStaffBilling)" },
    "app/admin/payment-confirmations/page.tsx": { count: 1, reason: "교사 납부확인 요청 처리" },
    // 2026-10-02 실측: 흡수된 학생 8명에게 Payment 4건이 남아 있다(연월 동결 규칙으로 안 옮긴 것).
    "lib/payments/parent-payment-request.ts": {
        count: 3,
        reason: "납부 요청 이력 + 청구 id 지정 제출·취소(부모 소유 확인 포함). 청구 목록 자체는 이미 필터됨",
    },
    "lib/payments/admin-payment-request.ts": { count: 1, reason: "원장 납부 요청 처리 목록" },
    "lib/billing/monthly-class-ledger-read.ts": {
        count: 2,
        reason: "월 청구 원장(수강 ACTIVE/PAUSED + 청구). 흡수 학생은 진행 중 수강이 0건이라 수강 쪽은 영향 없음. 순수 모듈이라 @/ import 불가",
    },

    // POS·토스 결제 대조 — 과거 기록을 봐야 맞출 수 있다.
    "lib/pos/reconcileService.ts": {
        count: 2,
        reason: "POS 대조용 결제 조회. mergedIntoStudentId 를 SELECT 해서 직접 판정한다(FROM 앞이라 가드가 못 봄)",
    },
    "lib/pos/paymentNoticeService.ts": { count: 1, reason: "id 지정 POS 결제 알림 1건의 학생 이름(LEFT JOIN)" },

    // 기록 테이블 (2026-10-02 정리)
    // 병합 엔진(tables.ts)이 이제 보강권·결석·셔틀 예외·반 변경 신청까지 대표 학생에게 옮긴다.
    // 흡수 쪽에 남는 행이 "진짜 중복"인 보강권·보강 일정·셔틀 예외·결석 목록은 필터를 걸었다.
    // (결석은 병합 때 대표 행이 더 살아있는 흡수 쪽 상태를 승계한다 — tables.ts promoteOnConflict)
    // 아래는 남는 행이 유일한 기록일 수 있는 목록 + id·키를 지정한 단건 처리라 거르지 않는다.
    "lib/makeup/parent-makeup.ts": {
        count: 3,
        reason: "보강권 id 지정 예약 옵션·예약·취소 3건(부모 소유 확인 포함)",
    },
    "lib/regular/parent-regular-absence.ts": { count: 2, reason: "결석 id/키 지정 취소 2건(부모 소유 확인 포함)" },
    "lib/shuttle/parent-shuttle-exception.ts": { count: 1, reason: "예외 id 지정 취소(부모 소유 확인 포함)" },
    "lib/shuttle/regularLocationLink.ts": { count: 2, reason: "학생 id 지정 잠금 1건 + 관리자 링크 발급 이력" },
    "lib/enrollment/admin-change-request.ts": {
        count: 2,
        reason: "원장 반 변경 신청 목록(흡수 쪽에 남는 건 대기 중·청구된 유일한 신청) + 신청 id 지정 청구",
    },
    "lib/enrollment/parent-change-request.ts": { count: 1, reason: "신청 id 지정 취소(부모 소유 확인 포함)" },

    // 단건 상세·이력 표시 — 링크로 들어온 사람에게 404를 주지 않는다.
    "lib/queries.ts": {
        count: 10,
        reason: "학생 상세 2건, 청구 목록 2건, 요청/피드백/보강 이력 LEFT JOIN 6건",
    },
    "app/actions/admin.ts": {
        count: 9,
        reason:
            "id를 이미 아는 단건 조회 7건(학생 수정·수강 등록 잠금·수강 상태 변경·청구 보호자 확인·요청/피드백 알림 이름·일괄 등록 보호자) " +
            "+ 청구서 링크 알림·미납 문자 2건(청구)",
    },
    "app/actions/student-media-consent.ts": { count: 1, reason: "id 지정 보호자 조회" },
    "lib/studentMediaConsentAdmin.ts": { count: 1, reason: "id 지정 보호자 조회" },
    "lib/notification.ts": {
        count: 2,
        reason: "id 목록으로 보호자를 찾는 알림 발송 + 재확인 문자 승인 감사기록 대조(링크 id 지정)",
    },
    "app/actions/kakao-reconfirmation-notice.ts": { count: 1, reason: "접수 id + 토큰 지정 재확인 링크 조회" },
    "app/actions/operations-sync.ts": { count: 1, reason: "명령 id 지정 시트 반영(LEFT JOIN)" },
    "app/actions/parent-operations-request.ts": {
        count: 3,
        reason: "토큰 지정 링크 검증·미리보기 2건 + 관리자가 학생 id 로 보는 링크 목록",
    },
    "lib/kakao-parent-chatbot.ts": { count: 1, reason: "중복 요청 id 지정 재조회(LEFT JOIN)" },
    "lib/mediaRevocationQueue.ts": { count: 1, reason: "미디어 철회 작업 이력(LEFT JOIN, 학생 이름 표시)" },
    "app/admin/kakao-requests/page.tsx": { count: 1, reason: "카카오 접수 처리 목록(기록, LEFT JOIN)" },
    "app/api/admin/operational-deliveries/route.ts": { count: 1, reason: "알림 발송 이력(LEFT JOIN)" },
    "app/mypage/reports/[sessionId]/page.tsx": {
        count: 1,
        reason: "이미 필터된 내 자녀 id 목록 안에서의 출석 조회",
    },

    // 권한/동의 게이트 — 조건을 더 걸면 정상 사용자를 막을 수 있어 손대지 않는다.
    "lib/staff-class-access.ts": { count: 1, reason: "교사 접근 권한 검사(막는 방향이라 위험)" },
    "lib/studentMediaConsent.ts": { count: 1, reason: "미디어 동의 게이트(막는 방향이라 위험)" },
    "lib/auth-guard.ts": { count: 1, reason: "직원 겸 학부모 판정 게이트(막는 방향이라 위험)" },
    "lib/account-view-access.ts": { count: 1, reason: "계속 화면에서 옮긴 공통 직원 겸 학부모 분기 게이트. 자녀 목록이 아닌 본인 연결 존재 확인이며 기존 인증 가드와 같은 기준 유지" },

};

function collectTsFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) collectTsFiles(full, out);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
}

test('"Student" 를 읽는 모든 쿼리는 병합 필터를 걸거나 예외 목록에 등록돼 있다', () => {
    const srcRoot = path.join(import.meta.dirname, "..");
    const pattern = /(FROM|JOIN)\s+"Student"/g;
    const found: Record<string, number> = {};

    for (const file of collectTsFiles(srcRoot)) {
        const source = readFileSync(file, "utf8");
        let match: RegExpExecArray | null;
        pattern.lastIndex = 0;
        while ((match = pattern.exec(source)) !== null) {
            // DELETE FROM "Student" 는 조회가 아니라 쓰기다.
            if (/DELETE\s+$/i.test(source.slice(Math.max(0, match.index - 20), match.index))) continue;
            // 같은 쿼리 안(뒤 500자)에 조건이 있으면 통과. 헬퍼든 직접 쓴 SQL이든 인정한다.
            if (/mergedIntoStudentId|notMergedStudent/.test(source.slice(match.index, match.index + 500))) continue;

            const rel = path.relative(srcRoot, file).split(path.sep).join("/");
            found[rel] = (found[rel] ?? 0) + 1;
        }
    }

    const problems: string[] = [];
    for (const [file, count] of Object.entries(found)) {
        const allowed = ALLOWED_WITHOUT_FILTER[file];
        if (!allowed) {
            problems.push(
                `${file}: 병합 필터 없는 학생 조회 ${count}건. ` +
                    `notMergedStudent()를 걸거나, 일부러 제외한 것이면 ALLOWED_WITHOUT_FILTER에 사유를 적어라.`,
            );
        } else if (count > allowed.count) {
            problems.push(
                `${file}: 필터 없는 학생 조회가 ${allowed.count}건 → ${count}건으로 늘었다. ` +
                    `새로 추가한 쿼리에 notMergedStudent()를 걸어라. (기존 예외 사유: ${allowed.reason})`,
            );
        }
    }

    assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
});

test("예외 목록에 적어 둔 파일은 실제로 존재한다(오래된 항목 정리용)", () => {
    const srcRoot = path.join(import.meta.dirname, "..");
    for (const file of Object.keys(ALLOWED_WITHOUT_FILTER)) {
        assert.doesNotThrow(
            () => statSync(path.join(srcRoot, file)),
            `예외 목록의 ${file} 이(가) 없다. 파일이 사라졌으면 목록에서도 지워라.`,
        );
    }
});
