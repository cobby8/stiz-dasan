// 공개 공지 상세는 «처음 열릴 때 그려 저장(ISR)»한다(2026-11-19 전 화면 속도 10회차)
//
// 왜: revalidate=60 이 있어도 generateStaticParams 가 없으면 Next 가 [id] 화면을 매번 서버에서 새로 그렸다
//     (빌드 표 ƒ, 운영 x-vercel-cache 가 연속 MISS, 3.5일 355회). 빈 목록([])을 돌려주면 처음 연 공지부터 저장된다.
//     대신 공지 수정·삭제는 그 상세 주소도 바로 갱신해야 한다(지운 공지가 저장본으로 남지 않게).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("공지 상세 — generateStaticParams 빈 목록 + revalidate 60", () => {
  const src = readFileSync("src/app/notices/[id]/page.tsx", "utf8");
  assert.match(src, /export const revalidate = 60;/);
  assert.match(src, /export async function generateStaticParams\(\) \{\s*return \[\];\s*\}/);
  // 사람마다 다른 내용을 읽지 않는다(저장본을 모두에게 같이 준다)
  assert.doesNotMatch(src, /cookies\(\)|headers\(\)|requireAuth|requireVerifiedParent/);
  // DB 오류를 숨기는 조회(null)를 쓰면 «없는 공지(404)»가 저장된다 — 던지는 조회만(검수 반영)
  assert.doesNotMatch(src, /getNoticeById\(/);
  assert.equal((src.match(/getNoticeByIdOrThrow\(id\)/g) ?? []).length, 2, "메타·본문 둘 다");
  const q = readFileSync("src/lib/queries.ts", "utf8");
  const strict = q.slice(q.indexOf("export const getNoticeByIdOrThrow"), q.indexOf("export const getNoticeById = "));
  assert.doesNotMatch(strict, /catch/, "OrThrow 는 오류를 삼키지 않는다");
});

// 2026-11-20 원장 결정: 반에만 보낸 공지(CLASS)는 공개 상세에서 «없는 공지(404)»로 — 마이페이지 소식에서만 본다
test("공개 공지 상세는 전체 공지(ALL)만 — 반 공지는 메타·본문 모두 없는 공지로", () => {
  const src = readFileSync("src/app/notices/[id]/page.tsx", "utf8");
  assert.match(src, /notice && notice\.targetType === "ALL" \? notice : null/);
  assert.match(src, /buildNoticeMetadata\(publicOnly\(await getNoticeByIdOrThrow\(id\)\)\)/, "메타도 거른다(제목 노출 금지)");
  const body = src.slice(src.indexOf("export default async function NoticeDetailPage"));
  assert.match(body, /const notice = publicOnly\(found\);\s*if \(!notice\) notFound\(\);/, "본문도 거른 뒤 404");
  assert.doesNotMatch(body.slice(0, body.indexOf("publicOnly(found)")), /notice\./, "거르기 전에 공지 내용을 쓰지 않는다");
});

test("반 공지는 인스타 발행도 거절한다(공개 노출·깨진 링크 방지)", () => {
  const src = readFileSync("src/app/actions/social-campaigns.ts", "utf8");
  const fn = src.slice(src.indexOf("async function getNoticeForSocial"), src.indexOf("function buildPreview"));
  assert.match(fn, /WHERE id = \$1\s+AND "targetType" = 'ALL'/);
});

test("공지 수정·삭제는 공지 상세 주소도 바로 갱신한다", () => {
  const src = readFileSync("src/app/actions/admin.ts", "utf8");
  for (const fn of ["updateNotice", "deleteNotice"]) {
    const start = src.indexOf(`export async function ${fn}(`);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    assert.ok(start > 0, fn);
    assert.match(body, /revalidatePath\(`\/notices\/\$\{id\}`\);/, fn);
  }
});
