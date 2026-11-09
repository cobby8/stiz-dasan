-- 저장 노선 흡수 «되돌림» SQL (드라이런 20261109 생성)
-- ⚠️ 초안 — 실행하지 않았다. absorb-dispatch-route-20261109-apply.sql 을 적용한 뒤에만 의미가 있다(백업 표 필요).
-- 백업 표에서 바꾼 행의 sortOrder·arriveTime·stopName·좌표만 원래대로 돌린다(행 id 그대로라 탑승 체크 영향 없음).
-- 저장 노선(RegularDispatchRoute)은 흡수 때 지우지 않으므로 되돌릴 것이 없다. 코드도 되돌려야 하면 이전 커밋 재배포.
BEGIN;
UPDATE "RegularShuttleStop" s
   SET "sortOrder" = b."sortOrder", "arriveTime" = b."arriveTime", "stopName" = b."stopName",
       "latitude" = b."latitude", "longitude" = b."longitude"
  FROM "_bak_20261109_regular_shuttle_stop" b
 WHERE s."id" = b."id"
   AND s."id" IN ('9c2866c6-40ac-406d-b6e7-6ad004d38b80', 'e332cca4-0f86-4cad-b116-6a7f66524d96', '80756ab3-956e-4971-95c6-b0503c33b2a2', '6ed22b3e-41fa-4c02-9a99-adc892cd0295', 'd2429b2b-2dfe-475a-bc9c-26630f91f58b', '3e8af941-8aaa-4db4-82e8-599c3961bc80', 'aa7c6b90-026e-4d5f-aa3e-9764e4e2b34d', '52385e1c-8a4d-42a8-aae9-be6722a8c673', '18a38c8f-ee2a-4dac-9bb6-4b384098aed3', 'cbd5f207-4954-4b80-90ae-a842f566e178', 'c7de6098-0007-4301-8c88-64bc346d2784', '045d9b16-956e-4660-a2bb-2f1bf54a952b', 'f7d74fe6-0bc1-4537-8361-bc338ed566d4', 'f2965f3d-0997-4e2a-85c6-27c3d1d90d8b', 'dd4fba74-de35-46e3-ab48-cd29f6db92d6', 'af1e99e1-2215-40d1-956b-3272bc8db7ac', 'f0c48e1c-c514-4ce4-b81a-f14e33abc412', 'f21d7c44-6f27-45a9-99e5-a08cdd913bf1', '3cd776b0-d116-426a-b441-74595ebd3fee', 'dccea3df-4c36-47da-ae5c-59d78debc570', 'd08bf4bb-e792-4fd6-ac38-0016adec355e', '13944a7b-788b-472b-b1b1-a109716e661f', 'd7fc2e35-8aae-4f24-88e7-83afcda96d7f', '6578251d-968f-4f50-a798-21aaa881b782', 'a8e23094-fb80-4153-aee7-9f9ab6d1581c', '7c9eb8bc-9581-415e-8af2-1fd6925c8d4e', '64671d2b-5510-4849-95c5-dd6bd017f740', 'e91882c3-1bcd-45f3-8d13-74f8b9443981', 'a2790cd1-2260-45c1-b5bc-f81134b591f4', '34834c4e-628c-47f7-8fbb-4c729dedf30d');
-- 확인: 아래 결과가 0 이어야 한다
SELECT count(*) AS "still_different"
  FROM "RegularShuttleStop" s JOIN "_bak_20261109_regular_shuttle_stop" b ON b."id" = s."id"
 WHERE s."sortOrder" <> b."sortOrder" OR s."arriveTime" IS DISTINCT FROM b."arriveTime" OR s."stopName" <> b."stopName";
COMMIT;
-- 백업 표 정리는 1개월 뒤 원장 승인 후: DROP TABLE "_bak_20261109_regular_dispatch_route", "_bak_20261109_regular_shuttle_stop";
