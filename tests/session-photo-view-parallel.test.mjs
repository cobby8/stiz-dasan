// 수업 사진 보기 — 사진 원장(DB) 찾기는 권한 확인과 같이, 저장소 파일 내려받기는 권한 확인 뒤에만(2026-11-19 속도 9회차)
//
// 왜: 운영에서 이 주소가 p75 0.87초였다. 권한 확인(선생님 → 안 되면 보호자, 로그인 확인 포함) 뒤에야 사진 원장을 읽었다.
//     원장 읽기는 권한과 무관해 같이 출발시킨다. 파일 내려받기는 «권한 없는 요청은 파일을 읽지 않는다»(feed-rules IDOR 테스트)를 지켜 뒤에 둔다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync("src/app/api/staff/sessions/[sessionId]/photos/[photoId]/route.ts", "utf8");
const get = src.slice(src.indexOf("export async function GET"), src.indexOf("/** 사진 관리 가능 시간 판정용"));

test("사진 원장 찾기는 권한 확인 전에 출발, 파일 내려받기는 권한 확인 뒤", () => {
  const draftsAt = get.indexOf('FROM "SocialPostDraft" WHERE "sessionId" = $1');
  const viewerAt = get.indexOf("await requirePhotoViewer(sessionId, session.classId, session.date);");
  const downloadAt = get.indexOf(".download(photo.storagePath)");
  assert.ok(draftsAt > 0 && viewerAt > draftsAt, "원장 조회가 권한 확인 앞에서 출발");
  assert.ok(downloadAt > viewerAt, "파일 내려받기는 권한 확인 뒤");
  assert.match(get, /photoP\.catch\(\(\) => \{\}\);/);
  // photoP 안에서는 파일을 받지 않는다
  const inner = get.slice(get.indexOf("const photoP = (async () => {"), get.indexOf("})();"));
  assert.doesNotMatch(inner, /download\(/);
});
