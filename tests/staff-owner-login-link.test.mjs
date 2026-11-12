// 원장·부원장 «로그인 연결» + 역할 변경 창(2026-11-12 원장 지시 — 권혜미 대표원장).
// 순수 판정은 실행해 보고, 서버 액션 linkOwnerStaffLogin 은 가짜 DB 로 실제 실행해 권한·거절·자동 발송 없음을 본다.
// 가입 처리(acceptInvitation)·화면은 약속을 소스로 못박는다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
    CONVERTIBLE_STAFF_ROLES,
    LOGIN_LINK_ROLES,
    isLoginLinkRole,
    staffLoginKind,
    targetedSignupAllowed,
} from "../src/lib/staff/staffAccountLink.ts";
import {
    INVITE_LOGIN_LINK_ROLES,
    INVITE_STAFF_ROLES,
    explainClaimFailure,
    invitationRoleAccepted,
} from "../src/lib/staff/inviteAuthFailure.ts";
import { ROLE_CHANGE_OPTIONS, roleChangePreview } from "../src/lib/staff/roleChange.ts";

const admin = readFileSync("src/app/actions/admin.ts", "utf8");
const invite = readFileSync("src/app/actions/invite.ts", "utf8");
const client = readFileSync("src/app/admin/staff/StaffClient.tsx", "utf8");

function fnBody(src, name) {
    const start = src.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0, name);
    const next = src.indexOf("\nexport async function ", start + 10);
    return src.slice(start, next < 0 ? undefined : next);
}

// ── 순수 판정 ───────────────────────────────────────────────

test("초대 링크가 받는 역할: 코치·기사는 예전 그대로, 원장·부원장은 «그 사람 기록을 향한 가입 초대»만", () => {
    assert.equal(invitationRoleAccepted({ role: "INSTRUCTOR" }), true);
    assert.equal(invitationRoleAccepted({ role: "DRIVER", targetUserId: null }), true);
    assert.equal(invitationRoleAccepted({ role: "ADMIN", targetUserId: "u1", purpose: "SIGNUP" }), true);
    assert.equal(invitationRoleAccepted({ role: "VICE_ADMIN", targetUserId: "u1", purpose: null }), true);
    // 대상 없는 원장 초대(새 원장 계정 만들기)·원장 비밀번호 재설정·학부모는 받지 않는다
    assert.equal(invitationRoleAccepted({ role: "ADMIN", targetUserId: null, purpose: "SIGNUP" }), false);
    assert.equal(invitationRoleAccepted({ role: "ADMIN", targetUserId: "u1", purpose: "PASSWORD_RESET" }), false);
    assert.equal(invitationRoleAccepted({ role: "PARENT", targetUserId: "u1" }), false);
    // 처리 시작 실패 설명도 같은 판정
    assert.deepEqual(explainClaimFailure({ role: "ADMIN", status: "PENDING", targetUserId: null }), { error: "스태프 전용 초대가 아닙니다." });
    assert.notEqual(explainClaimFailure({ role: "ADMIN", status: "PENDING", targetUserId: "u1", purpose: "SIGNUP" }).error, "스태프 전용 초대가 아닙니다.");
});

test("역할 집합은 두 순수 모듈이 같다(의존성 0 모듈이라 복사본 — 어긋나면 깨진다)", () => {
    assert.deepEqual([...INVITE_STAFF_ROLES], [...CONVERTIBLE_STAFF_ROLES]);
    assert.deepEqual([...INVITE_LOGIN_LINK_ROLES], [...LOGIN_LINK_ROLES]);
});

test("기존 기록에 붙는 가입: 원장·부원장은 초대 역할 = 대상 지금 역할일 때만(역할을 올리는 길 없음)", () => {
    assert.equal(targetedSignupAllowed({ inviteRole: "ADMIN", targetRole: "ADMIN" }), true);
    assert.equal(targetedSignupAllowed({ inviteRole: "VICE_ADMIN", targetRole: "VICE_ADMIN" }), true);
    // 대상 역할 불일치 거절
    assert.equal(targetedSignupAllowed({ inviteRole: "ADMIN", targetRole: "VICE_ADMIN" }), false);
    assert.equal(targetedSignupAllowed({ inviteRole: "ADMIN", targetRole: "PARENT" }), false);
    assert.equal(targetedSignupAllowed({ inviteRole: "ADMIN", targetRole: "INSTRUCTOR" }), false);
    assert.equal(targetedSignupAllowed({ inviteRole: "VICE_ADMIN", targetRole: "ADMIN" }), false);
    // 코치·기사 초대가 원장 기록에 붙거나 학부모를 올리지 않는다(예전 규칙 그대로)
    assert.equal(targetedSignupAllowed({ inviteRole: "INSTRUCTOR", targetRole: "ADMIN" }), false);
    assert.equal(targetedSignupAllowed({ inviteRole: "INSTRUCTOR", targetRole: "PARENT" }), false);
    assert.equal(targetedSignupAllowed({ inviteRole: "DRIVER", targetRole: "INSTRUCTOR" }), true);
    assert.deepEqual(["ADMIN", "VICE_ADMIN", "INSTRUCTOR", "DRIVER", "PARENT"].map(isLoginLinkRole), [true, true, false, false, false]);
});

test("역할 변경 창: 고를 수 있는 역할 = 서버 허용 목록 그대로 · 미리보기 문구", () => {
    const serverValues = admin.match(/const STAFF_ROLE_VALUES: readonly StaffRoleValue\[\] = \[([^\]]*)\]/)[1]
        .split(",").map((value) => value.trim().replace(/"/g, ""));
    assert.deepEqual(ROLE_CHANGE_OPTIONS.map((option) => option.value), serverValues);
    for (const option of ROLE_CHANGE_OPTIONS) assert.ok(option.description.length > 0 && option.description.length <= 30, option.value);

    const toParent = roleChangePreview({ currentRole: "INSTRUCTOR", nextRole: "PARENT", coachName: "김코치" });
    assert.deepEqual(toParent.lines, ["코치/강사 → 학부모", "학부모로 바꾸면 목록에서 빠지고 코치 연결이 풀려요."]);
    assert.equal(toParent.danger, true);
    const toDriver = roleChangePreview({ currentRole: "INSTRUCTOR", nextRole: "DRIVER", coachName: "김코치" });
    assert.ok(toDriver.lines.includes("코치 프로필 «김코치» 연결이 풀려요."));
    assert.equal(toDriver.danger, true);
    const toViceNoCoach = roleChangePreview({ currentRole: "INSTRUCTOR", nextRole: "VICE_ADMIN", coachName: "김코치" });
    assert.equal(toViceNoCoach.danger, false); // 부원장은 코치 연결을 유지
    assert.ok(toViceNoCoach.lines.includes("관리 화면을 쓸 수 있게 돼요."));
    const withLink = roleChangePreview({ currentRole: "ADMIN", nextRole: "VICE_ADMIN", hasPendingLink: true });
    assert.ok(withLink.lines.includes("대기 중인 가입 링크는 취소돼요."));
});

// ── 서버: linkOwnerStaffLogin 을 가짜 DB 로 실제 실행 ─────────────────

const linkSource = fnBody(admin, "linkOwnerStaffLogin");

function loadLink({ caller = "ADMIN", target = null, pending = null } = {}) {
    const calls = { inserts: [], audits: [], sms: 0, revalidated: 0 };
    const tx = {
        $executeRawUnsafe: async (sql, ...values) => {
            if (sql.includes("pg_advisory_xact_lock")) return 1;
            if (sql.includes('INSERT INTO "OperationsAuditLog"')) { calls.audits.push({ sql, values }); return 1; }
            throw new Error(`unexpected execute: ${sql}`);
        },
        $queryRawUnsafe: async (sql, ...values) => {
            if (sql.includes('FROM "StaffInvitation"')) return pending ? [pending] : [];
            if (sql.includes('INSERT INTO "StaffInvitation"')) {
                calls.inserts.push({ sql, values });
                return [{ id: "inv-new", token: "tok-new" }];
            }
            throw new Error(`unexpected query: ${sql}`);
        },
    };
    const prisma = {
        $queryRawUnsafe: async (sql) => {
            assert.match(sql, /FROM "User" WHERE id = \$1 AND "withdrawnAt" IS NULL/);
            return target ? [target] : [];
        },
        $transaction: async (work) => work(tx),
    };
    const deps = {
        prisma,
        // requireOwner: 원장만 통과(부원장은 실제 auth-guard 처럼 던진다)
        requireOwner: async () => {
            if (caller !== "ADMIN") throw new Error("원장 권한이 필요합니다. (ADMIN만 가능)");
            return { id: "auth-owner", appUserId: "owner-1", email: "owner@x", appUserRole: "ADMIN" };
        },
        ensureStaffInvitationTable: async () => {},
        inviteStaffRejected: (error) => ({ rejected: true, error }),
        staffLoginKind,
        isLoginLinkRole,
        revalidateStaffAdminCaches: () => { calls.revalidated++; },
        revalidatePath: () => {},
        getStaffInvitationUrl: (token) => `/invite/${token}`,
        // 문자 발송 함수 — 불리면 «자동 발송»이다
        sendFailClosedTrackedSms: async () => { calls.sms++; return { ok: true }; },
    };
    const compiled = ts.transpile(linkSource, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
    const loaded = { exports: {} };
    new Function("module", "exports", ...Object.keys(deps), compiled)(loaded, loaded.exports, ...Object.values(deps));
    return { run: loaded.exports.linkOwnerStaffLogin, calls };
}

const directAdmin = { id: "u-kwon", name: "권혜미", phone: "010-1111-2222", role: "ADMIN", email: "01011112222@staff.local", authUserId: null };

test("로그인 연결: 원장이 누르면 24시간 SIGNUP 대상 초대(역할 그대로)를 만들고 문자는 보내지 않는다", async () => {
    const { run, calls } = loadLink({ target: directAdmin });
    const result = await run("u-kwon");
    assert.equal(result.rejected, false);
    assert.equal(result.inviteUrl, "/invite/tok-new");
    assert.equal(calls.inserts.length, 1);
    assert.match(calls.inserts[0].sql, /NOW\(\) \+ INTERVAL '1 day', 'SIGNUP', \$4, \$5/);
    assert.deepEqual(calls.inserts[0].values, ["권혜미", "01011112222", "ADMIN", "u-kwon", "auth-owner"]);
    assert.equal(calls.audits.length, 1, "감사 기록");
    assert.match(calls.audits[0].sql, /'STAFF_LOGIN_LINK_CREATED'/);
    assert.doesNotMatch(calls.audits[0].values[1], /tok-new/, "감사 기록에 링크 토큰을 남기지 않는다");
    assert.equal(calls.sms, 0, "자동 발송 없음");
    assert.doesNotMatch(linkSource, /sendFailClosedTrackedSms|sendSms|sendTrackedSms/);
});

test("로그인 연결: 부원장은 못 한다(원장 전용)", async () => {
    const { run, calls } = loadLink({ caller: "VICE_ADMIN", target: directAdmin });
    await assert.rejects(run("u-kwon"), /원장 권한이 필요합니다/);
    assert.equal(calls.inserts.length, 0);
});

test("로그인 연결: 코치·학부모 기록·이미 로그인 있는 기록·잘못된 번호·본인은 거절", async () => {
    for (const [target, pattern] of [
        [{ ...directAdmin, role: "INSTRUCTOR" }, /원장·부원장 기록만/],
        [{ ...directAdmin, role: "PARENT" }, /원장·부원장 기록만/],
        [{ ...directAdmin, email: "01011112222@staff.stiz.kr", authUserId: "auth-x" }, /이미 로그인 계정이 있는/],
        [{ ...directAdmin, phone: "02-123-4567" }, /휴대전화 번호가 올바르지/],
    ]) {
        const { run, calls } = loadLink({ target });
        const result = await run("u-kwon");
        assert.equal(result.rejected, true);
        assert.match(result.error, pattern);
        assert.equal(calls.inserts.length, 0);
    }
    const self = await loadLink({ target: directAdmin }).run("owner-1");
    assert.equal(self.rejected, true);
});

test("로그인 연결: 같은 사람 대기 링크는 재사용, 다른 대기 초대가 있으면 거절", async () => {
    const reuse = loadLink({ target: directAdmin, pending: { id: "inv-old", token: "tok-old", targetUserId: "u-kwon", purpose: "SIGNUP", role: "ADMIN" } });
    const reused = await reuse.run("u-kwon");
    assert.equal(reused.reused, true);
    assert.equal(reused.inviteUrl, "/invite/tok-old");
    assert.equal(reuse.calls.inserts.length, 0);
    const other = loadLink({ target: directAdmin, pending: { id: "inv-x", token: "tok-x", targetUserId: null, purpose: "SIGNUP", role: "INSTRUCTOR" } });
    const blocked = await other.run("u-kwon");
    assert.equal(blocked.rejected, true);
});

// ── 가입 처리(acceptInvitation) 약속 ─────────────────────────────

test("가입 시작: 원장·부원장 초대는 대상(targetUserId)이 있는 SIGNUP 만 처리 시작", () => {
    const body = fnBody(invite, "acceptInvitation");
    assert.match(body, /AND \(role IN \('INSTRUCTOR'::"Role", 'DRIVER'::"Role"\)\s*OR \(role IN \('ADMIN'::"Role", 'VICE_ADMIN'::"Role"\) AND "targetUserId" IS NOT NULL AND COALESCE\(purpose, 'SIGNUP'\) = 'SIGNUP'\)\)/);
    // 초대 화면·인증도 같은 판정
    assert.match(invite, /if \(!invitationRoleAccepted\(invitation\)\) return "스태프 전용 초대가 아닙니다\."/);
    assert.equal((invite.match(/"targetUserId"/g) ?? []).length >= 5, true);
});

test("가입 거래: 대상이 지금도 같은 원장·부원장·로그인 없음인지 재확인, 역할은 바꾸지 않고 로그인만 붙인다", () => {
    const conversion = invite.slice(invite.indexOf("if (conversionTargetId) {"), invite.indexOf("} else {", invite.indexOf("if (conversionTargetId) {")));
    assert.match(conversion, /targetedSignupAllowed\(\{ inviteRole: invitation\.role, targetRole: lockedRole \}\) \|\| lockedRole !== conversionTargetRole/);
    assert.match(conversion, /AND "authUserId" IS NULL AND "withdrawnAt" IS NULL AND lower\(email\) LIKE '%@staff\.local'/);
    assert.match(conversion, /AND role = \$4::"Role"`/);
    assert.doesNotMatch(conversion, /SET role/);
    // 감사 기록(비밀번호 없음) + 성공 뒤 다른 원장·부원장 알림
    assert.match(conversion, /'STAFF_LOGIN_LINKED'/);
    assert.doesNotMatch(conversion, /password/i);
    assert.match(invite, /if \(linkedAdminNotice\.value\) await notifyAdminLoginLinked\(linkedAdminNotice\.value\)/);
    const notice = invite.slice(invite.indexOf("async function notifyAdminLoginLinked"), invite.indexOf("const SMS_TIMEOUT_MS"));
    assert.match(notice, /role IN \('ADMIN', 'VICE_ADMIN'\) AND "withdrawnAt" IS NULL AND id <> \$1/, "본인 제외");
    assert.match(notice, /계정 로그인이 연결됐어요/);
    assert.doesNotMatch(notice, /password|sendSms|sendTrackedSms/i);
    // 재입사(다시 열기) 경로로 학부모가 원장이 되지 않는다
    assert.match(invite, /if \(!isConvertibleStaffRole\(invitation\.role\)\) throw new Error\("이 초대는 더 이상 쓸 수 없습니다/);
    // 비밀번호는 로그·응답에 싣지 않는다(기존 흐름 그대로 — createUser/updateUserById 인자로만)
    assert.doesNotMatch(invite, /console\.(error|log)\([^)]*password/);
});

test("다시 보내기: 만료된 원장·부원장 링크는 24시간만 연장, 문자는 원장이 누를 때만", () => {
    const body = fnBody(admin, "resendInvitation");
    assert.match(body, /CASE WHEN role IN \('ADMIN'::"Role", 'VICE_ADMIN'::"Role"\) THEN INTERVAL '1 day' ELSE INTERVAL '7 days' END/);
    assert.match(body, /관리자 로그인 연결 링크입니다\(24시간 유효\)/);
});

// ── 화면 ──────────────────────────────────────────────────

test("화면: [로그인 연결]은 원장 패널에서 로그인 없는 원장·부원장에게만, [역할 변경]은 원장·남에게만", () => {
    const panel = client.slice(client.indexOf("function buildUserPanelActions"), client.indexOf("// 추가 역할 줄의 역할 칩"));
    assert.match(panel, /if \(!canManage\) return \[\];/);
    assert.match(panel, /user\.directAdded && !conversion && isLoginLinkRole\(user\.role\)/);
    assert.match(panel, /label: "로그인 연결"/);
    const button = client.slice(client.indexOf("function roleChangeButton"), client.indexOf("// 코치 연결 선택칸(원장만)"));
    assert.match(button, /if \(user\.id === currentUserId\) return roleChip\(user\.role\);/);
    assert.match(button, /역할 변경/);
    // 패널·PC 표 둘 다 버튼, 부원장(canManage=false)은 칩만
    assert.equal((client.match(/canManage \? roleChangeButton\(/g) ?? []).length, 2);
});
