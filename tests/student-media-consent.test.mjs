import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateMediaConsent, normalizeSubjectStudentIds } from "../src/lib/studentMediaConsentPolicy.ts";

const allowed = {
  studentId: "student-1",
  studentName: "홍길동",
  internalAllowed: true,
  galleryAllowed: true,
  instagramAllowed: true,
  revokedAt: null,
  isRelated: true,
};

test("갤러리는 내부 및 갤러리 동의가 모두 있어야 한다", () => {
  assert.equal(evaluateMediaConsent([allowed], "GALLERY").ok, true);
  assert.equal(evaluateMediaConsent([{ ...allowed, galleryAllowed: false }], "GALLERY").ok, false);
});

test("인스타그램은 세 범위 동의가 모두 있어야 한다", () => {
  const result = evaluateMediaConsent([{ ...allowed, instagramAllowed: false }], "INSTAGRAM");
  assert.equal(result.ok, false);
  assert.equal(result.blockedStudents[0].id, "student-1");
});

test("동의 철회는 모든 공개를 차단한다", () => {
  const result = evaluateMediaConsent([{ ...allowed, revokedAt: "2026-07-15T00:00:00Z" }], "GALLERY");
  assert.equal(result.ok, false);
  assert.equal(result.blockedStudents[0].reason, "동의 철회");
});

test("대상 학생을 확인할 수 없으면 안전하게 공개를 차단한다", () => {
  const result = evaluateMediaConsent([], "GALLERY");
  assert.equal(result.ok, false);
  assert.equal(result.studentCount, 0);
});

test("명시한 학생이 해당 수업 또는 반 소속이 아니면 차단한다", () => {
  const result = evaluateMediaConsent([{ ...allowed, isRelated: false }], "GALLERY");
  assert.equal(result.ok, false);
  assert.equal(result.blockedStudents[0].reason, "수업 또는 반 소속 불일치");
});

test("학생 ID는 중복과 비정상 값을 제거해 저장한다", () => {
  assert.deepEqual(normalizeSubjectStudentIds([" student-1 ", "student-1", "../bad", "student_2", 3]), [
    "student-1",
    "student_2",
  ]);
});

// ── 2026-11-14 원장 결정: 사진 공개 동의 제거 ──────────────────────────
// 위 동의 규칙(evaluateMediaConsent)은 «공개 게시 동의 검사»를 다시 켤 때 그대로 쓰도록 남겨 둔다.
// 지금 정책: 학부모 보기 = 동의 없이 «그 수업 참여 학생의 보호자»만, 공개 게시 = 관리자·원장 수동 승인.
const readSrc = (path) => readFileSync(path, "utf8");

test("학부모 사진 보기는 동의를 보지 않고 «참여한 아이의 보호자»만(공용 판정 하나)", () => {
  const route = readSrc("src/app/api/staff/sessions/[sessionId]/photos/[photoId]/route.ts");
  assert.doesNotMatch(route, /FROM "StudentMediaConsent"/);
  assert.match(route, /parentCanViewSession\(parent\.appUserId, sessionId\)/);
  const feed = readSrc("src/lib/feed/server.ts");
  assert.doesNotMatch(feed, /StudentMediaConsent/);
  assert.match(feed, /feedParticipantSql\("st", "se"\)/);
});

test("공개 게시 동의 검사는 꺼졌지만(되돌릴 스위치 유지) 갤러리=관리자·인스타=원장 수동 승인은 그대로", () => {
  const consent = readSrc("src/lib/studentMediaConsent.ts");
  assert.match(consent, /export const PUBLIC_POST_CONSENT_GATE_ENABLED = false;/);
  assert.match(consent, /if \(!PUBLIC_POST_CONSENT_GATE_ENABLED\) \{/);
  // 기존 검사 본문은 지우지 않았다(스위치를 켜면 다시 돈다)
  assert.match(consent, /FROM "StudentMediaConsent" c/);
  const actions = readSrc("src/app/actions/social-posts.ts");
  assert.match(actions, /export async function publishSocialPostDraftToGallery\(id: string\) \{\s*const staff = await requireAdmin\(\);/);
  assert.match(actions, /export async function publishSocialPostDraftToInstagram\(id: string\) \{[\s\S]*?const owner = await requireOwner\(\);/);
  // 대기열은 원장이 승인해 PUBLISHING 이 된 초안만 처리한다
  assert.match(readSrc("src/lib/socialDrafts.ts"), /WHERE status = 'PUBLISHING'/);
});
