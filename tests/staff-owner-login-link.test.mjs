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
import { ROLE_CHANGE_COACH_LINKABLE, ROLE_CHANGE_OPTIONS, roleChangePreview } from "../src/lib/staff/roleChange.ts";
import { maskedPhoneLast4, redactOwnerInviteTokens } from "../src/lib/staff/staffRoster.ts";

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
    // 원장·부원장 비밀번호 재설정도 대상이 있으면 받는다(검수 정확 4 — 대상 역할 일치는 가입 처리가 DB 에서 확인)
    assert.equal(invitationRoleAccepted({ role: "ADMIN", targetUserId: "u1", purpose: "PASSWORD_RESET" }), true);
    assert.equal(invitationRoleAccepted({ role: "VICE_ADMIN", targetUserId: null, purpose: "PASSWORD_RESET" }), false);
    assert.equal(invitationRoleAccepted({ role: "ADMIN", targetUserId: "u1", purpose: "OTHER" }), false);
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
    // 코치 연결 역할도 서버 COACH_LINKABLE_ROLES 와 같은 집합(검수 정확 1)
    const serverLinkable = admin.match(/const COACH_LINKABLE_ROLES: readonly StaffRoleValue\[\] = \[([^\]]*)\]/)[1]
        .split(",").map((value) => value.trim().replace(/"/g, ""));
    assert.deepEqual([...ROLE_CHANGE_COACH_LINKABLE], serverLinkable);

    const toParent = roleChangePreview({ currentRole: "INSTRUCTOR", nextRole: "PARENT", coachName: "김코치" });
    assert.deepEqual(toParent.lines, ["코치/강사 → 학부모", "학부모로 바꾸면 스태프 목록에서 빠져요.", "코치 프로필 «김코치» 연결이 풀려요."]);
    assert.equal(toParent.danger, true);
    // 서버와 같은 조건만(검수 정확 3): 코치 연결이 없으면 «풀려요» 없음, 승인된 선생님 추가 역할이 있으면 서버가 유지
    const noCoach = roleChangePreview({ currentRole: "INSTRUCTOR", nextRole: "DRIVER", coachName: null });
    assert.ok(!noCoach.lines.some((line) => line.includes("연결이 풀려요")));
    assert.equal(noCoach.danger, false);
    const withGrant = roleChangePreview({ currentRole: "INSTRUCTOR", nextRole: "PARENT", coachName: "김코치", hasInstructorGrant: true });
    assert.ok(!withGrant.lines.some((line) => line.includes("연결이 풀려요")));
    // 서버 조건(승인된 선생님 역할이면 유지)이 그대로인지
    assert.match(fnBody(admin, "updateUserRole"), /role = 'INSTRUCTOR' AND status = 'ACTIVE'/);
    const toDriver = roleChangePreview({ currentRole: "INSTRUCTOR", nextRole: "DRIVER", coachName: "김코치" });
    assert.ok(toDriver.lines.includes("코치 프로필 «김코치» 연결이 풀려요."));
    assert.equal(toDriver.danger, true);
    const toViceNoCoach = roleChangePreview({ currentRole: "INSTRUCTOR", nextRole: "VICE_ADMIN", coachName: "김코치" });
    assert.equal(toViceNoCoach.danger, false); // 부원장은 코치 연결을 유지
    assert.ok(toViceNoCoach.lines.includes("관리 화면을 쓸 수 있게 돼요."));
    const withLink = roleChangePreview({ currentRole: "ADMIN", nextRole: "VICE_ADMIN", hasPendingLink: true });
    assert.ok(withLink.lines.includes("대기 중인 가입·재설정 링크는 취소돼요."));
    // 화면은 재설정 링크까지 센다(서버가 targetUserId 대기 초대를 목적과 상관없이 취소)
    assert.match(client, /pendingInvitations\.some\(\(inv\) => inv\.targetUserId === roleTargetUser\.id\)/);
    assert.match(fnBody(admin, "updateUserRole"), /WHERE "targetUserId" = \$1 AND status IN \('PENDING', 'PROCESSING'\)/);
    assert.match(client, /hasInstructorGrant\?: boolean/);
});

test("부원장 화면 데이터에서는 원장·부원장 계정 초대의 링크 토큰을 비운다(페이지·API 둘 다)", () => {
    const invites = [
        { id: "a", role: "ADMIN", targetUserId: "u1", token: "t-admin" },
        { id: "b", role: "VICE_ADMIN", targetUserId: "u2", token: "t-vice", purpose: "PASSWORD_RESET" },
        { id: "c", role: "INSTRUCTOR", targetUserId: null, token: "t-coach" },
        { id: "d", role: "INSTRUCTOR", targetUserId: "u3", token: "t-convert" },
    ];
    assert.deepEqual(redactOwnerInviteTokens(invites, false).map((inv) => inv.token), ["", "", "t-coach", "t-convert"]);
    assert.deepEqual(redactOwnerInviteTokens(invites, true).map((inv) => inv.token), ["t-admin", "t-vice", "t-coach", "t-convert"]);
    const page = readFileSync("src/app/admin/staff/page.tsx", "utf8");
    const route = readFileSync("src/app/api/admin/staff/route.ts", "utf8");
    assert.match(page, /redactOwnerInviteTokens\(cachedInvitations, canManage\)/);
    assert.match(route, /redactOwnerInviteTokens\(payload\.invitations, canManage\)/);
    assert.match(route, /canManage = admin\.appUserRole === "ADMIN"/);
    // 토큰이 없는 초대는 ⚡ 복사도 없다
    assert.match(client, /if \(!inv\.token\) return \[\];/);
});

test("받을 번호 끝 4자리 표시", () => {
    assert.equal(maskedPhoneLast4("010-1234-2571"), "010-****-2571");
    assert.equal(maskedPhoneLast4("123"), "***");
    assert.equal(maskedPhoneLast4(null), "***");
    assert.match(client, /\{maskedPhoneLast4\(detailConversion\.phone\)\} 로 인증번호가 가요/);
    assert.match(client, /\$\{result\.phoneMasked\} 로 인증번호가 가요/);
    // 24시간 링크 만료는 시각까지
    assert.match(client, /\{kstLabel\(detailConversion\.expiresAt\)\} \{kstHm\(detailConversion\.expiresAt\)\}까지/);
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
        maskedPhoneLast4,
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
    assert.equal(result.phoneMasked, "010-****-2222");
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
    assert.match(body, /AND \(role IN \('INSTRUCTOR'::"Role", 'DRIVER'::"Role"\)\s*OR \(role IN \('ADMIN'::"Role", 'VICE_ADMIN'::"Role"\) AND "targetUserId" IS NOT NULL\s*AND COALESCE\(purpose, 'SIGNUP'\) IN \('SIGNUP', 'PASSWORD_RESET'\)\)\)/);
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
    assert.match(invite, /if \(linkedAdminNotice\.value\) await notifyOwnerAccountChange\(\{ \.\.\.linkedAdminNotice\.value, kind: "linked" \}\)/);
    const notice = invite.slice(invite.indexOf("async function notifyOwnerAccountChange"), invite.indexOf("const SMS_TIMEOUT_MS"));
    assert.match(notice, /role IN \('ADMIN', 'VICE_ADMIN'\) AND "withdrawnAt" IS NULL AND id <> \$1/, "본인 제외");
    assert.match(notice, /계정 로그인이 연결됐어요/);
    assert.doesNotMatch(notice, /password|sendSms|sendTrackedSms/); // 알림에 비밀번호 값이 실리지 않는다(종류 이름 STAFF_PASSWORD_RESET 은 제외)
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

// ── 원장·부원장 비밀번호 재설정(검수 정확 4) ─────────────────────────

const resetHelper = admin.slice(admin.indexOf("async function createOwnerPasswordReset"), admin.indexOf("/**\n * sendStaffPasswordReset"));

function loadReset({ target = null, pending = null } = {}) {
    const calls = { inserts: [], audits: [], sms: 0 };
    const tx = {
        $executeRawUnsafe: async (sql, ...values) => {
            if (sql.includes("pg_advisory_xact_lock")) return 1;
            if (sql.includes('INSERT INTO "OperationsAuditLog"')) { calls.audits.push({ sql, values }); return 1; }
            throw new Error(`unexpected execute: ${sql}`);
        },
        $queryRawUnsafe: async (sql, ...values) => {
            if (sql.includes('INSERT INTO "StaffInvitation"')) { calls.inserts.push({ sql, values }); return [{ id: "r-new", token: "rt-new" }]; }
            if (sql.includes('FROM "StaffInvitation"')) return pending ? [pending] : [];
            throw new Error(`unexpected query: ${sql}`);
        },
    };
    const deps = {
        prisma: { $queryRawUnsafe: async () => (target ? [target] : []), $transaction: async (work) => work(tx) },
        inviteStaffRejected: (error) => ({ rejected: true, error }),
        staffLoginKind,
        isLoginLinkRole,
        maskedPhoneLast4,
        revalidateStaffAdminCaches: () => {},
        revalidatePath: () => {},
        getStaffInvitationUrl: (token) => `/invite/${token}`,
        sendFailClosedTrackedSms: async () => { calls.sms++; return { ok: true }; },
    };
    const compiled = ts.transpile(`${resetHelper}\nmodule.exports.run = createOwnerPasswordReset;`, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
    const loaded = { exports: {} };
    new Function("module", "exports", ...Object.keys(deps), compiled)(loaded, loaded.exports, ...Object.values(deps));
    return { run: (id) => loaded.exports.run({ id: "auth-owner", appUserId: "owner-1" }, id), calls };
}

const loginAdmin = { id: "u-vice", name: "박부원장", phone: "01033334444", role: "VICE_ADMIN", email: "01033334444@staff.stiz.kr", authUserId: "auth-vice" };

test("원장·부원장 재설정: 원장 전용 진입 — sendStaffPasswordReset 이 requireOwner 뒤에만 userId 경로로 간다", () => {
    const body = fnBody(admin, "sendStaffPasswordReset");
    const owner = body.indexOf("await requireOwner()");
    const delegate = body.indexOf("if (data.userId) return createOwnerPasswordReset(user,");
    assert.ok(owner > 0 && delegate > owner, "원장 확인 → 위임 순서");
    // 번호로 고르는 기존 경로는 예전처럼 코치·기사만
    assert.match(body, /role IN \('INSTRUCTOR','DRIVER'\) AND "withdrawnAt" IS NULL/);
});

test("원장·부원장 재설정: 직원 전용 로그인 대상에게 24시간 PASSWORD_RESET 링크, 문자 자동 발송 없음, 감사 기록", async () => {
    const { run, calls } = loadReset({ target: loginAdmin });
    const result = await run("u-vice");
    assert.equal(result.rejected, false);
    assert.equal(result.smsSent, false);
    assert.equal(result.phoneMasked, "010-****-4444");
    assert.match(calls.inserts[0].sql, /NOW\(\) \+ INTERVAL '1 day', 'PASSWORD_RESET', \$4, \$5/);
    assert.deepEqual(calls.inserts[0].values, ["박부원장", "01033334444", "VICE_ADMIN", "u-vice", "auth-owner"]);
    assert.match(calls.audits[0].sql, /'STAFF_PASSWORD_RESET_LINK_CREATED'/);
    assert.equal(calls.sms, 0, "자동 발송 없음");
    assert.doesNotMatch(resetHelper, /sendFailClosedTrackedSms|sendSms|updateUserById/);
});

test("원장·부원장 재설정 거절: 본인·코치·로그인 없는 기록·학부모 계정 로그인·다른 대기 초대", async () => {
    const cases = [
        ["owner-1", loginAdmin, /본인 계정은 여기서 재설정할 수 없어요/],
        ["u-vice", { ...loginAdmin, role: "INSTRUCTOR" }, /원장·부원장 계정만/],
        ["u-vice", { ...loginAdmin, email: "01033334444@staff.local", authUserId: null }, /전화번호 아이디로 로그인하는 계정만/],
        ["u-vice", { ...loginAdmin, email: "parent@gmail.com" }, /전화번호 아이디로 로그인하는 계정만/],
        ["u-vice", { ...loginAdmin, authUserId: null }, /전화번호 아이디로 로그인하는 계정만/],
    ];
    for (const [id, target, pattern] of cases) {
        const { run, calls } = loadReset({ target });
        const result = await run(id);
        assert.equal(result.rejected, true, String(pattern));
        assert.match(result.error, pattern);
        assert.equal(calls.inserts.length, 0);
    }
    const busy = await loadReset({ target: loginAdmin, pending: { id: "x", token: "t", targetUserId: "u-vice", purpose: "SIGNUP", role: "VICE_ADMIN" } }).run("u-vice");
    assert.equal(busy.rejected, true);
    const reuse = await loadReset({ target: loginAdmin, pending: { id: "r-old", token: "rt-old", targetUserId: "u-vice", purpose: "PASSWORD_RESET", role: "VICE_ADMIN" } }).run("u-vice");
    assert.equal(reuse.reused, true);
});

test("원장·부원장 재설정 수락: 지금 역할 = 초대 역할·직원 전용 로그인일 때만 비밀번호만 바꾸고, 감사 기록·다른 원장 알림", () => {
    const accept = fnBody(invite, "acceptInvitation");
    const branch = accept.slice(accept.indexOf('if (invitation.purpose === "PASSWORD_RESET")'), accept.indexOf("const staffEmail ="));
    assert.match(branch, /WHERE id = \$1 AND role = \$2::"Role" AND "withdrawnAt" IS NULL/, "대상 역할 불일치면 못 찾음(거절)");
    assert.match(branch, /if \(ownerReset && \(!target\.authUserId \|\| staffLoginKind\(target\) !== "staffLogin"\)\)/);
    assert.doesNotMatch(branch, /SET role|createUser/);
    assert.match(branch, /'STAFF_PASSWORD_RESET_DONE'/);
    assert.match(branch, /notifyOwnerAccountChange\(\{ userId: target\.id, name: invitation\.name, role: invitation\.role, kind: "reset" \}\)/);
    assert.match(invite, /계정 비밀번호가 재설정됐어요/);
});

test("화면: 원장 패널의 [비밀번호 재설정]은 전화번호 아이디 원장·부원장·본인 제외, 받을 번호 확인 창", () => {
    const panel = client.slice(client.indexOf("function buildUserPanelActions"), client.indexOf("// 추가 역할 줄의 역할 칩"));
    assert.match(panel, /!user\.directAdded && staffLogin && isLoginLinkRole\(user\.role\) && user\.id !== currentUserId && !pendingReset/);
    assert.match(panel, /label: "비밀번호 재설정"/);
    const handler = client.slice(client.indexOf("async function handleOwnerPasswordReset"), client.indexOf("// 전환 초대 문자"));
    assert.match(handler, /maskedPhoneLast4\(user\.phone\)\} 로 인증번호가 가요/);
    assert.match(handler, /sendStaffPasswordReset\(\{ phone: user\.phone \?\? "", userId: user\.id \}\)/);
});
