// 2026-11-14 사진 점검 — 화면 문구(동의 안내·역할별 안내·문구 출처)를 못박는다.
// 2026-11-18 결정표 insta-auto-publish «안 쓴다»: 인스타 오류 한국어화·연결 배지·공지→인스타 문구 단언은
// 그 기능을 지우며 뺐다. 대신 «게시 = 홈페이지 갤러리만, 끝나면 초안을 PUBLISHED 로 닫는다»를 못박는다.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  QUICK_UPLOAD_CONSENT_NOTICE,
  SUBJECT_UNASSIGNED_PUBLISH_MESSAGE,
} from "../src/lib/socialPostMessages.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const gallery = read("../src/app/admin/gallery/GalleryAdminClient.tsx");
const quickPost = read("../src/app/staff/quick-post/QuickPostClient.tsx");
const quickPostPage = read("../src/app/staff/quick-post/page.tsx");
const actions = read("../src/app/actions/social-posts.ts");
const drafts = read("../src/lib/socialDrafts.ts");
const captionAI = read("../src/lib/socialCaptionAI.ts");
const settings = read("../src/app/admin/settings/AdminSettingsClient.tsx");
const consent = read("../src/lib/studentMediaConsent.ts");

test("학생 미지정 초안: 막는 것은 그대로, 다음에 할 일을 알려 준다", () => {
  assert.equal(
    SUBJECT_UNASSIGNED_PUBLISH_MESSAGE,
    "이 사진은 학생이 지정되지 않아 공개 동의를 확인할 수 없습니다. 수업 화면에서 학생을 골라 올린 사진만 게시할 수 있습니다.",
  );
  // 안내로 바꾸는 조건이 동의 검사의 «학생 미지정» 조건과 같다(규칙을 새로 만들지 않았다)
  const condition = /\(!draft\.sessionId && !draft\.classId\) \|\| draft\.subjectStudentIds\.length === 0/;
  assert.match(consent, condition);
  assert.match(actions, condition);
  // 안내는 «게시하지 않고» 값으로 돌려준다 — 갤러리 단계보다 앞에서 끝난다
  const publish = actions.slice(actions.indexOf("export async function publishSocialPostDraft(id: string)"));
  assert.match(publish, /blocked: true as const,\s*error: SUBJECT_UNASSIGNED_PUBLISH_MESSAGE,\s*\};\s*\}\s*const gallery = await publishSocialPostDraftToGallery\(id\);/);
  // 동의 검사는 갤러리 액션에 그대로 남아 있다
  assert.match(actions, /assertSocialDraftMediaConsent\(currentDraft!, "GALLERY"\)/);
  // 빠른 업로드 화면은 올리기 전에 같은 사실을 알린다
  assert.match(QUICK_UPLOAD_CONSENT_NOTICE, /학생이 지정되지 않아/);
  assert.match(quickPost, /\{QUICK_UPLOAD_CONSENT_NOTICE\}/);
  assert.ok(quickPost.indexOf("{QUICK_UPLOAD_CONSENT_NOTICE}") < quickPost.indexOf("사진 선택하고 문구 초안 만들기"), "안내가 올리기 버튼보다 위");
});

test("역할별 안내: 권한은 서버가 내려 주고, 선생님에게 «바로 게시»를 말하지 않는다", () => {
  // 서버가 계산(서버 액션의 검사와 같은 기준: 갤러리 = 관리자)
  assert.match(quickPostPage, /canPublishGallery: staff\.appUserRole === "ADMIN" \|\| staff\.appUserRole === "VICE_ADMIN",/);
  // 화면은 역할 글자로 권한을 추측하지 않는다
  assert.doesNotMatch(quickPost, /currentUser\.role === "(ADMIN|VICE_ADMIN)"/);
  assert.match(quickPost, /const canApprove = permissions\.canPublishGallery;/);
  // 게시 버튼은 게시 권한이 있을 때만, 선생님은 저장(검토 대기)
  assert.match(quickPost, /\{canApprove && !isPublished && \(\s*<button[\s\S]{0,80}onClick=\{confirmPublish\}/);
  assert.match(quickPost, /\{canApprove \? "수정 저장" : "저장\(검토 대기\)"\}/);
  assert.match(quickPost, /원장님 확인을 거쳐야 게시됩니다/);
  assert.doesNotMatch(quickPost, /바로 게시할 수 있습니다/);
  // 서버 권한은 그대로(갤러리 = 관리자)
  assert.match(actions, /export async function publishSocialPostDraftToGallery\(id: string\) \{\s*const staff = await requireAdmin\(\);/);
});

test("게시 = 홈페이지 갤러리만: 인스타 버튼·문구·권한 값이 없다", () => {
  for (const [name, source] of [["QuickPostClient", quickPost], ["quick-post page", quickPostPage], ["GalleryAdminClient", gallery], ["social-posts", actions]]) {
    assert.doesNotMatch(source, /canPublishInstagram|INSTAGRAM_OWNER_ONLY_TEXT|instagramOwnerOnly|publishSocialPostDraftToInstagram|isInstagramApprovalPending/, name);
    // 화면·서버가 «말하는» 문구만 본다(주석의 경위 설명은 제외)
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /인스타그램(에|과)? ?(다시 )?게시/, name);
  }
  assert.doesNotMatch(gallery, /instagramStatus|인스타그램 연결/);
  // 설정 화면: 자동 업로드 체크·비즈니스 계정 번호 칸은 없고, 푸터용 인스타 주소 칸은 남는다
  assert.doesNotMatch(settings, /instagramAutoPublishEnabled|instagramBusinessAccountId/);
  assert.match(settings, /name="instagramUrl"/);
  // 인스타 게시 모듈·대기열 규칙·5분 크론은 지웠다
  for (const path of ["../src/lib/instagram.ts", "../src/lib/socialPublishQueueRules.ts", "../src/app/api/cron/social-posts/route.ts", "../src/app/actions/social-campaigns.ts"]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, path);
  }
});

test("갤러리 게시가 끝나면 초안을 «게시 완료(PUBLISHED)»로 닫는다 — «게시 처리 중»에 남지 않는다", () => {
  const toGallery = actions.slice(
    actions.indexOf("export async function publishSocialPostDraftToGallery(id: string)"),
    actions.indexOf("export async function publishSocialPostDraft(id: string)"),
  );
  // 갤러리 올리기 → 바로 PUBLISHED 로 닫기(순서 고정)
  assert.match(toGallery, /const galleryPostId = await upsertGalleryPostFromSocialDraft\(currentDraft!\);\s*(\/\/.*\n\s*)*const draft = await markSocialPostDraftGalleryPublished\(id, \{ galleryPostId \}\);/);
  // 닫는 SQL: PUBLISHED + 게시 시각, 게시할 수 있는 상태일 때만(반려된 초안을 되살리지 않는다)
  const sql = drafts.slice(drafts.indexOf("export const MARK_GALLERY_PUBLISHED_SQL"), drafts.indexOf("export async function markSocialPostDraftGalleryPublished"));
  assert.match(sql, /SET status = 'PUBLISHED',/);
  assert.match(sql, /"publishedAt" = COALESCE\("publishedAt", NOW\(\)\)/);
  assert.match(sql, /WHERE id = \$2\s+AND status IN \('READY', 'FAILED', 'PUBLISHING'\)/);
  assert.doesNotMatch(sql, /status = 'PUBLISHING'/);
  // 묶음 액션도 갤러리 결과를 그대로 돌려준다(인스타 단계로 넘어가지 않는다)
  assert.match(actions, /const gallery = await publishSocialPostDraftToGallery\(id\);\s*return \{ ok: true as const, draft: gallery\.draft, galleryPostId: gallery\.galleryPostId \};/);
});

test("AI 문구: 기본 문구로 바뀌면 결과에 담아 화면이 구분해 보여 준다", () => {
  assert.match(captionAI, /source: "AI" \| "FALLBACK";/);
  assert.match(captionAI, /hashtags: normalizeHashtags\(""\),\s*source: "FALLBACK",/);
  assert.match(captionAI, /hashtags: normalizeHashtags\(parsed\.hashtags \|\| fallback\.hashtags\),\s*source: "AI",/);
  assert.match(actions, /return \{ ok: true, draft, captionSource: aiDraft\.source \};/);
  assert.match(quickPost, /captionSource === "FALLBACK"\s*\? "기본 문구입니다\(AI 연결 안 됨\)"/);
  assert.match(quickPost, /result\.captionSource === "AI" \? "AI 초안이 만들어졌습니다\." : "기본 문구입니다\(AI 연결 안 됨\)\."/);
});
