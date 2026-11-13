// 2026-11-14 사진·인스타 점검 — 화면 문구(인스타 오류 한국어화·연결 배지·동의 안내·역할별 안내·문구 출처)를 못박는다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  QUICK_UPLOAD_CONSENT_NOTICE,
  SUBJECT_UNASSIGNED_PUBLISH_MESSAGE,
  instagramConnectionBadge,
  instagramErrorGuide,
} from "../src/lib/socialPostMessages.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const gallery = read("../src/app/admin/gallery/GalleryAdminClient.tsx");
const quickPost = read("../src/app/staff/quick-post/QuickPostClient.tsx");
const quickPostPage = read("../src/app/staff/quick-post/page.tsx");
const actions = read("../src/app/actions/social-posts.ts");
const campaigns = read("../src/app/actions/social-campaigns.ts");
const captionAI = read("../src/lib/socialCaptionAI.ts");
const settings = read("../src/app/admin/settings/AdminSettingsClient.tsx");
const consent = read("../src/lib/studentMediaConsent.ts");

const HANGUL = /[가-힣]/;

test("인스타 오류: 흔한 영어 원문은 한국어 안내로 바꾸고 원문을 덧붙인다", () => {
  const cases = [
    ["Error validating access token: Session has expired on Friday, 13-Nov-26 02:00:00 PST.", /연결이 만료/],
    ["Invalid OAuth access token - Cannot parse access token", /연결이 만료/],
    ["(#10) Application does not have permission for this action", /게시 권한이 없습니다/],
    ["(#200) Permissions error", /게시 권한이 없습니다/],
    ["The image's aspect ratio is not supported. Please check the image.", /형식이나 크기/],
    ["Only photo or video can be accepted as media type.", /형식이나 크기/],
    ["Media download has failed. The media URI doesn't meet our requirements.", /형식이나 크기/],
    ["(#4) Application request limit reached", /한도를 넘었습니다/],
    ["The user has exceeded the content publishing limit (2207042)", /한도를 넘었습니다/],
  ];
  for (const [raw, expected] of cases) {
    const guide = instagramErrorGuide(raw);
    assert.match(guide.message, expected, raw);
    assert.match(guide.message, HANGUL);
    assert.doesNotMatch(guide.message, /[A-Za-z]{4,}/, "안내문에는 영어 원문이 섞이지 않는다");
    assert.equal(guide.detail, raw, "원문은 따로 덧붙인다");
  }
});

test("인스타 오류: 토큰 만료가 «권한»보다 먼저 판정된다", () => {
  const guide = instagramErrorGuide("OAuthException: Error validating access token, permission denied");
  assert.match(guide.message, /연결이 만료/);
});

test("인스타 오류: 한국어 안내는 그대로, 모르는 영어는 일반 안내 + 원문, 빈 값은 없음", () => {
  const korean = "인스타그램 API 토큰 또는 계정 ID가 설정되지 않았습니다.";
  assert.deepEqual(instagramErrorGuide(korean), { message: korean, detail: null });

  const unknown = instagramErrorGuide("An unknown error has occurred.");
  assert.match(unknown.message, /인스타그램 게시에 실패했습니다/);
  assert.equal(unknown.detail, "An unknown error has occurred.");

  assert.equal(instagramErrorGuide(null), null);
  assert.equal(instagramErrorGuide("   "), null);
});

test("인스타 오류: 결과 불명확은 «먼저 확인하고, 없을 때만 다시 게시»로 안내한다", () => {
  const guide = instagramErrorGuide("Instagram 게시 결과 확인 필요");
  assert.match(guide.message, /실제로 올라갔는지 확인/);
  assert.match(guide.message, /올라가지 않았을 때만/);
  assert.equal(guide.detail, null);
});

test("관리자 갤러리: 오류는 안내 + 작은 원문으로, 원문을 그대로 뿌리지 않는다", () => {
  assert.match(gallery, /const publishErrorGuide = instagramErrorGuide\(draft\.instagramPublishError\);/);
  assert.match(gallery, /<p>\{publishErrorGuide\.message\}<\/p>/);
  assert.match(gallery, /publishErrorGuide\.detail && \([\s\S]{0,160}text-xs[\s\S]{0,80}원문: \{publishErrorGuide\.detail\}/);
  assert.doesNotMatch(gallery, />\s*\{draft\.instagramPublishError\}\s*</);
});

test("연결 배지: 연결 정보가 있다는 것만 말하고 «준비 완료»라고 단정하지 않는다", () => {
  assert.deepEqual(instagramConnectionBadge(true), {
    label: "연결 정보 있음",
    hint: "실제 연결은 게시하거나 가져올 때 확인됩니다.",
  });
  assert.equal(instagramConnectionBadge(false).label, "설정 필요");
  assert.match(gallery, /\{instagramBadge\.label\}/);
  assert.match(gallery, /\{instagramBadge\.hint\}/);
  assert.doesNotMatch(gallery, /준비 완료/);
});

test("학생 미지정 초안: 막는 것은 그대로, 다음에 할 일을 알려 준다", () => {
  assert.equal(
    SUBJECT_UNASSIGNED_PUBLISH_MESSAGE,
    "이 사진은 학생이 지정되지 않아 공개 동의를 확인할 수 없습니다. 수업 화면에서 학생을 골라 올린 사진만 게시할 수 있습니다.",
  );
  // 안내로 바꾸는 조건이 동의 검사의 «학생 미지정» 조건과 같다(규칙을 새로 만들지 않았다)
  const condition = /\(!draft\.sessionId && !draft\.classId\) \|\| draft\.subjectStudentIds\.length === 0/;
  assert.match(consent, condition);
  assert.match(actions, condition);
  // 안내는 «게시하지 않고» 값으로 돌려준다 — 갤러리·인스타 단계보다 앞에서 끝난다
  const publish = actions.slice(actions.indexOf("export async function publishSocialPostDraft(id: string)"));
  assert.match(publish, /blocked: true as const,\s*error: SUBJECT_UNASSIGNED_PUBLISH_MESSAGE,\s*\};\s*\}\s*const gallery = await publishSocialPostDraftToGallery\(id\);/);
  // 동의 검사는 갤러리·인스타 액션에 그대로 남아 있다
  assert.match(actions, /assertSocialDraftMediaConsent\(currentDraft!, "GALLERY"\)/);
  assert.match(actions, /assertSocialDraftMediaConsent\(currentDraft, "INSTAGRAM"\)/);
  // 빠른 업로드 화면은 올리기 전에 같은 사실을 알린다
  assert.match(QUICK_UPLOAD_CONSENT_NOTICE, /학생이 지정되지 않아/);
  assert.match(quickPost, /\{QUICK_UPLOAD_CONSENT_NOTICE\}/);
  assert.ok(quickPost.indexOf("{QUICK_UPLOAD_CONSENT_NOTICE}") < quickPost.indexOf("사진 선택하고 문구 초안 만들기"), "안내가 올리기 버튼보다 위");
});

test("역할별 안내: 권한은 서버가 내려 주고, 선생님에게 «바로 게시»를 말하지 않는다", () => {
  // 서버가 계산(서버 액션의 검사와 같은 기준: 갤러리 = 관리자, 인스타 = 원장)
  assert.match(quickPostPage, /canPublishGallery: staff\.appUserRole === "ADMIN" \|\| staff\.appUserRole === "VICE_ADMIN",/);
  assert.match(quickPostPage, /canPublishInstagram: staff\.appUserRole === "ADMIN",/);
  // 화면은 역할 글자로 권한을 추측하지 않는다
  assert.doesNotMatch(quickPost, /currentUser\.role === "(ADMIN|VICE_ADMIN)"/);
  assert.match(quickPost, /const canApprove = permissions\.canPublishGallery;/);
  // 게시 버튼은 게시 권한이 있을 때만, 선생님은 저장(검토 대기)
  assert.match(quickPost, /\{canApprove && !isPublished && \(canPublishInstagram \|\| !needsInstagramRetry\) && \(\s*<button[\s\S]{0,80}onClick=\{confirmPublish\}/);
  assert.match(quickPost, /\{canApprove \? "수정 저장" : "저장\(검토 대기\)"\}/);
  assert.match(quickPost, /원장님 확인을 거쳐야 게시됩니다/);
  assert.doesNotMatch(quickPost, /바로 게시할 수 있습니다/);
  // 부원장: 인스타 게시는 비활성 + 이유 한 줄
  assert.match(quickPost, /\{canApprove && !canPublishInstagram && !isPublished && \([\s\S]{0,200}<button type="button" disabled[\s\S]{0,120}인스타그램 게시[\s\S]{0,200}\{INSTAGRAM_OWNER_ONLY_TEXT\}/);
  // 서버 권한은 그대로
  assert.match(actions, /export async function publishSocialPostDraftToGallery\(id: string\) \{\s*const staff = await requireAdmin\(\);/);
  assert.match(actions, /const owner = await requireOwner\(\);/);
  // 부원장이 누르면 갤러리까지만 하고, 인스타 액션은 부르지 않는다
  assert.match(actions, /if \(staff\.appUserRole !== "ADMIN"\) \{\s*return \{ ok: false as const, draft: gallery\.draft, instagramOwnerOnly: true as const \};\s*\}\s*return publishSocialPostDraftToInstagram\(id\);/);
});

test("AI 문구: 기본 문구로 바뀌면 결과에 담아 화면이 구분해 보여 준다", () => {
  assert.match(captionAI, /source: "AI" \| "FALLBACK";/);
  assert.match(captionAI, /hashtags: normalizeHashtags\(""\),\s*source: "FALLBACK",/);
  assert.match(captionAI, /hashtags: normalizeHashtags\(parsed\.hashtags \|\| fallback\.hashtags\),\s*source: "AI",/);
  assert.match(actions, /return \{ ok: true, draft, captionSource: aiDraft\.source \};/);
  assert.match(quickPost, /captionSource === "FALLBACK"\s*\? "기본 문구입니다\(AI 연결 안 됨\)"/);
  assert.match(quickPost, /result\.captionSource === "AI" \? "AI 초안이 만들어졌습니다\." : "기본 문구입니다\(AI 연결 안 됨\)\."/);
});

test("공지 → 인스타 문구: 방학특강이 박혀 나오지 않고 학원 이름 해시태그만 쓴다", () => {
  assert.doesNotMatch(campaigns.replace(/\/\/.*$/gm, ""), /방학/);
  assert.match(campaigns, /return \["#스티즈농구교실", "#스티즈농구교실다산점"\]\.join\(" "\);/);
  assert.match(campaigns, /adDescription: "STIZ 농구교실 다산점 안내",/);
});

test("설정 문구: 자동 업로드는 «첫 번째 이미지»가 아니라 최대 10장 묶음이다", () => {
  assert.doesNotMatch(settings, /첫 번째 이미지를 인스타그램/);
  assert.match(settings, /최대 10장을 한 게시물로 묶어 올립니다/);
  // 실제 동작과 같은 숫자인지 — 인스타 모듈이 10장까지 자른다
  assert.match(read("../src/lib/instagram.ts"), /\.slice\(0, 10\);/);
});
