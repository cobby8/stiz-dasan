/**
 * 새 선생님·기사님 «역할 미리 붙여 두기»(ROLE_PRESET) 적용 판정 — 한 곳 (2026-11-18 원장 결정 «가입·본인인증 통일» 5단계).
 *
 * ■ 흐름
 *   원장 초대(inviteStaff) = «이 번호에 역할을 미리 붙여 두기»(StaffInvitation purpose ROLE_PRESET, 30일).
 *   본인은 학부모와 같은 가입 화면(아이디 또는 간편로그인 + 본인인증)에서 가입한다. 가입·계정 연결이 «끝나는 그 거래 안에서»
 *   이 파일의 applyRolePresetsForUser 를 부른다 — 계정이 생기는 것과 역할이 붙는 것이 함께 남거나 함께 되돌아간다.
 *   부르는 곳(4곳): 가입 완료(completeParentSignup) · 빈 계정에 간편로그인 연결(resolveVerifiedSignupPhone LINKED)
 *                  · 빈 계정 활성화 완료(consumeParentAccountClaim) · 기존 계정 연결(parent-link/verify OK 갈래)
 *
 * ■ 판정(decideRolePresetGrant)
 *   - 바로 연다(UserRoleGrant ACTIVE): 본인인증(명의 확인) 실명이 초대 이름과 같고, 이 번호를 쓰는 계정이 «이 계정 하나».
 *   - 원장 확인(UserRoleGrant PENDING → 신청함): 문자 인증 샛길(실명 없음) · 실명이 초대 이름과 다름 · 같은 번호 계정 여럿.
 *   - 만료·취소·이미 쓴 초대는 보지 않는다(조회 조건 status='PENDING' AND "expiresAt" > NOW()).
 *   어느 쪽이든 초대는 그 계정이 «썼다»(ACCEPTED·acceptedUserId) — 같은 초대가 다른 계정에 다시 붙지 않게.
 *
 * ■ 이 파일은 prisma·next 를 import 하지 않는다 — db 를 인자로 받아 `node --test` 에서 가짜 db 로 실행 검증한다.
 *   알림(원장 벨)은 거래 밖에서 부르는 쪽이 rolePresetNotify.ts 로 보낸다(실패해도 가입을 되돌리지 않게).
 */
import { linkMatchingCoachProfileToUser } from "@/lib/staff-coach-link";
import { normalizePersonName } from "@/lib/account/social-link";

/** DB CHECK(StaffInvitation_purpose_check)와 같은 목록 — 테스트가 마이그레이션과 대조한다. */
export const STAFF_INVITATION_PURPOSES = ["SIGNUP", "PASSWORD_RESET", "ROLE_PRESET"] as const;
export type StaffInvitationPurpose = (typeof STAFF_INVITATION_PURPOSES)[number];

export const ROLE_PRESET_PURPOSE = "ROLE_PRESET" as const;
/** 미리 붙인 역할의 유효기간(일) — 원장 결정 30일 */
export const ROLE_PRESET_VALID_DAYS = 30;
/** 미리 붙일 수 있는 역할 — 부원장·원장은 지금 방식(직접 추가·로그인 연결) 그대로 */
export const ROLE_PRESET_ROLES = ["INSTRUCTOR", "DRIVER"] as const;

/**
 * 미리 붙이기 안내 문자 본문(처음 보낼 때·다시 보낼 때 같은 문구). 링크는 /invite/{토큰} — 그 화면이 가입 화면으로 안내한다.
 * 발송은 지금처럼 원장이 [초대 만들기]·[재발송]을 누를 때만이다(자동 발송 없음).
 */
export function roleInviteSmsBody(input: { name: string; roleLabel: string; inviteUrl: string; resend?: boolean }): string {
  return `[STIZ 농구교실] ${input.name}님, ${input.roleLabel} 역할을 준비해 두었습니다${input.resend ? "(다시 보냄)" : ""}.\n`
    + `아래 링크에서 안내에 따라 학부모와 같은 가입 화면으로 가입해 주세요(본인인증, ${ROLE_PRESET_VALID_DAYS}일 안):\n${input.inviteUrl}`;
}

/**
 * 이미 계정이 있는 분 안내(검수 R-3) — 가입 화면은 «이미 가입된 번호»로 막히므로, 로그인한 뒤 «내 정보»에서 본인인증(연락처 확인)을
 * 하면 같은 거래에서 역할이 붙는다(phone-change.ts). 원장 초대 결과·초대 안내 화면이 같은 문구를 쓴다.
 */
export const ROLE_PRESET_EXISTING_ACCOUNT_NOTICE =
  "이 번호로 이미 가입한 계정이 있으면, 그분이 로그인한 뒤 «내 정보»에서 본인인증(연락처 확인)을 하면 역할이 붙어요.";

/** DB 값 → 화면·코드가 쓰는 목적. 모르는 값·빈 값은 예전 기본값(SIGNUP). */
export function normalizeStaffInvitationPurpose(value: unknown): StaffInvitationPurpose {
  return (STAFF_INVITATION_PURPOSES as readonly string[]).includes(String(value)) ? (value as StaffInvitationPurpose) : "SIGNUP";
}

export type RolePresetReason = "IDENTITY_MATCH" | "NOT_IDENTITY" | "NAME_MISMATCH" | "MULTIPLE_ACCOUNTS";

/**
 * [순수] 미리 붙인 역할을 바로 열지, 원장 확인으로 둘지.
 * verifiedName = 이번 가입·연결에서 통과한 본인인증 실명. 문자 인증이면 null.
 * accountCount = 이 번호를 쓰는 (탈퇴하지 않은) 계정 수 — 이번 계정 포함.
 */
export function decideRolePresetGrant(input: {
  invitationName: string;
  verifiedName: string | null | undefined;
  accountCount: number;
}): { status: "ACTIVE" | "PENDING"; reason: RolePresetReason } {
  // 같은 번호에 계정이 둘 이상이면 누가 그 사람인지 자동으로 고르지 않는다
  if (input.accountCount !== 1) return { status: "PENDING", reason: "MULTIPLE_ACCOUNTS" };
  const verified = normalizePersonName(input.verifiedName);
  // 문자 인증은 «그 휴대폰을 들고 있다»만 증명한다 — 명의자 이름 확인이 없으면 원장 확인
  if (!verified) return { status: "PENDING", reason: "NOT_IDENTITY" };
  if (verified !== normalizePersonName(input.invitationName)) return { status: "PENDING", reason: "NAME_MISMATCH" };
  return { status: "ACTIVE", reason: "IDENTITY_MATCH" };
}

/** 원장 신청함·감사 기록에 남길 한 줄(실명은 넣지 않는다) */
export const ROLE_PRESET_NOTES: Record<RolePresetReason, string> = {
  IDENTITY_MATCH: "원장 초대(미리 붙인 역할) · 본인인증 이름 일치",
  NOT_IDENTITY: "원장 초대(미리 붙인 역할) · 문자 인증으로 가입 — 확인 필요",
  NAME_MISMATCH: "원장 초대(미리 붙인 역할) · 본인인증 이름이 초대 이름과 다름 — 확인 필요",
  MULTIPLE_ACCOUNTS: "원장 초대(미리 붙인 역할) · 같은 번호 계정이 여럿 — 확인 필요",
};

/**
 * 원장 확인(PENDING) 알림에 붙일 «왜 확인이 필요한가» 한 마디 — 가입한 사람이 초대한 그 사람인지 원장이 판단하게(2026-11-18 검수 권장 1).
 * 실명·번호는 넣지 않는다(알림은 벨·푸시로 나간다).
 */
export const ROLE_PRESET_REVIEW_REASONS: Record<Exclude<RolePresetReason, "IDENTITY_MATCH">, string> = {
  NOT_IDENTITY: "문자 인증으로 가입해 명의자 확인이 안 됐어요",
  NAME_MISMATCH: "본인인증 이름이 초대할 때 적은 이름과 달라요",
  MULTIPLE_ACCOUNTS: "같은 번호를 쓰는 계정이 여럿이에요",
};

/** [순수] 원장 확인 알림 본문 — 초대 이름(원장이 적은 이름)·역할·확인 이유만 */
export function rolePresetReviewMessage(input: { invitationName: string; roleLabel: string; reason: RolePresetReason | "ALREADY" }): string {
  const why = input.reason in ROLE_PRESET_REVIEW_REASONS
    ? ROLE_PRESET_REVIEW_REASONS[input.reason as keyof typeof ROLE_PRESET_REVIEW_REASONS]
    : "확인이 필요해요";
  return `초대 번호(${input.invitationName}님)로 가입한 계정이 있어요. 확인 이유: ${why}. 신청함에서 초대한 분이 맞는지 확인한 뒤 ${input.roleLabel} 역할을 승인해 주세요.`;
}

type Db = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): PromiseLike<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): PromiseLike<number>;
};

export type RolePresetOutcome = {
  invitationId: string;
  role: "INSTRUCTOR" | "DRIVER";
  /** ACTIVE = 바로 열림 · PENDING = 원장 신청함 · ALREADY = 이미 그 역할(주 역할)이라 붙일 것 없음 */
  status: "ACTIVE" | "PENDING" | "ALREADY";
  reason: RolePresetReason | "ALREADY";
  /** 원장이 적은 초대 이름 — 알림 문구용(본인인증 실명이 아니다) */
  invitationName: string;
};

/** 같은 번호의 대기 중 ROLE_PRESET(만료 전)을 잠그고 읽는 SQL — 테스트가 조건을 확인한다 */
export const PENDING_ROLE_PRESET_SQL =
  `SELECT id, name, role::text AS role, "createdBy"
     FROM "StaffInvitation"
    WHERE phone = $1 AND purpose = 'ROLE_PRESET' AND status = 'PENDING' AND "expiresAt" > NOW()
    ORDER BY "createdAt" ASC
    FOR UPDATE`;

/**
 * 가입·연결이 끝나는 거래(db) 안에서 부른다. 이 계정 번호의 미리 붙인 역할을 적용하고 결과를 돌려준다(없으면 빈 배열).
 * verifiedName: 이번에 통과한 본인인증 실명(문자 인증이면 null).
 */
export async function applyRolePresetsForUser(
  db: Db,
  input: { userId: string; verifiedName: string | null | undefined },
): Promise<RolePresetOutcome[]> {
  if (!input.userId) return [];
  const users = await db.$queryRawUnsafe<Array<{ id: string; phone: string | null; role: string }>>(
    `SELECT id, phone, role::text AS role FROM "User" WHERE id = $1 AND "withdrawnAt" IS NULL LIMIT 1`,
    input.userId,
  );
  const user = users[0];
  if (!user) return [];
  // 초대 번호는 숫자만 저장한다(inviteStaff) — 계정 번호도 숫자만 남겨 비교한다. 빈 번호·자리채움 번호는 열쇠로 쓰지 않는다.
  const digits = String(user.phone ?? "").replace(/\D/g, "");
  if (!/^01\d{8,9}$/.test(digits)) return [];

  const invitations = await db.$queryRawUnsafe<Array<{ id: string; name: string; role: string; createdBy: string | null }>>(
    PENDING_ROLE_PRESET_SQL,
    digits,
  );
  if (invitations.length === 0) return [];

  const counts = await db.$queryRawUnsafe<Array<{ count: number }>>(
    `SELECT COUNT(*)::int AS count FROM "User"
      WHERE regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $1 AND "withdrawnAt" IS NULL`,
    digits,
  );
  const accountCount = Number(counts[0]?.count ?? 0);

  const outcomes: RolePresetOutcome[] = [];
  for (const invitation of invitations) {
    if (invitation.role !== "INSTRUCTOR" && invitation.role !== "DRIVER") continue; // DB CHECK 가 막지만 한 번 더
    const role = invitation.role;
    if (user.role === role) {
      // 이미 그 역할이 주 역할인 계정 — 붙일 것이 없다. 초대만 «썼다»로 닫는다.
      await markPresetAccepted(db, invitation.id, user.id);
      outcomes.push({ invitationId: invitation.id, role, status: "ALREADY", reason: "ALREADY", invitationName: invitation.name });
      continue;
    }
    const decision = decideRolePresetGrant({ invitationName: invitation.name, verifiedName: input.verifiedName, accountCount });
    const note = ROLE_PRESET_NOTES[decision.reason];
    if (decision.status === "ACTIVE") {
      // 원장 초대 + 본인인증 이름 일치 = 원장 승인과 같다. 신청 중이던 건이 있으면 그대로 승인된다.
      // decidedBy = 초대를 만든 원장(초대에는 로그인 id 가 적혀 있어 앱 계정 id 로 바꿔 넣는다 — 없으면 NULL)
      await db.$executeRawUnsafe(
        `INSERT INTO "UserRoleGrant" ("userId", role, status, source, "decidedAt", "decidedBy", note)
         VALUES ($1, $2, 'ACTIVE', 'INVITE', NOW(), (SELECT id FROM "User" WHERE id = $3 OR "authUserId" = $3 LIMIT 1), $4)
         ON CONFLICT ("userId", role) WHERE status IN ('PENDING', 'ACTIVE')
         DO UPDATE SET status = 'ACTIVE', source = 'INVITE', "decidedAt" = NOW(),
                       "decidedBy" = EXCLUDED."decidedBy", note = EXCLUDED.note, "updatedAt" = NOW()`,
        user.id,
        role,
        invitation.createdBy ?? "",
        note,
      );
      // 같은 이름·번호의 코치 프로필이 있고 이 계정에 연결된 코치가 없으면 연결한다(초대 가입과 같은 규칙).
      // 이름은 원장이 적은 초대 이름 — 코치 프로필도 원장이 같은 이름으로 적어 둔다(닉네임은 본인이 바꾼다).
      if (role === "INSTRUCTOR") {
        const linked = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM "Coach" WHERE "userId" = $1 LIMIT 1`, user.id);
        if (linked.length === 0) {
          await linkMatchingCoachProfileToUser(db, { userId: user.id, name: invitation.name, phone: digits, role: "INSTRUCTOR" });
        }
      }
    } else {
      // 원장 확인 대기 — 이미 열려 있거나 신청 중이면 그대로 둔다(내리지 않는다)
      await db.$executeRawUnsafe(
        `INSERT INTO "UserRoleGrant" ("userId", role, status, source, note)
         VALUES ($1, $2, 'PENDING', 'INVITE', $3)
         ON CONFLICT ("userId", role) WHERE status IN ('PENDING', 'ACTIVE') DO NOTHING`,
        user.id,
        role,
        note,
      );
    }
    await markPresetAccepted(db, invitation.id, user.id);
    // 감사 기록 — 어느 초대가 어느 계정에 어떻게 붙었나(본인인증 실명·토큰은 남기지 않는다)
    await db.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
       VALUES (gen_random_uuid()::text, 'STAFF_ROLE_PRESET_APPLIED', 'SYSTEM', $1, $2::jsonb)`,
      user.id,
      JSON.stringify({ invitationId: invitation.id, userId: user.id, role, status: decision.status, reason: decision.reason }),
    );
    outcomes.push({ invitationId: invitation.id, role, status: decision.status, reason: decision.reason, invitationName: invitation.name });
  }
  return outcomes;
}

/** 초대를 «이 계정이 썼다»로 닫는다(대기 중일 때만 — 그 사이 원장이 취소했으면 0줄). */
async function markPresetAccepted(db: Db, invitationId: string, userId: string) {
  await db.$executeRawUnsafe(
    `UPDATE "StaffInvitation"
        SET status = 'ACCEPTED', "acceptedAt" = NOW(), "acceptedUserId" = $2, "updatedAt" = NOW()
      WHERE id = $1 AND status = 'PENDING' AND purpose = 'ROLE_PRESET'`,
    invitationId,
    userId,
  );
}
