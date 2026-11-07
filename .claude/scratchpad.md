# 작업 스크래치패드

## 현재 작업
- **상태(2026-10-05)**: Phase 2-A 자동화 배포(보강권 버그·특강 자동 퇴원·휴원/퇴원 예약 자동 적용). 랠리즈 10월 청구 정리·오래된 미납 94건 납부 처리 완료.
- **미푸시 커밋 0개** — main 29080efa 배포.
- **현재 담당**: pm
- **마지막 세션**: 2026-10-05
- **테스트 기준선 갱신(2026-10-05)**: **1813건 중 실패 1건**(`.claude/worktrees/` 옛 사본 때문 — pos 매칭 로직 단일성 테스트, 배포 무관)

## UI 전수 점검 — 남은 일 (다음 세션 이어서)
조사 보고서 6종은 세션 임시 폴더에 있어 **사라질 수 있음**. 핵심만 여기 옮겨 둔다.

- **기능/UI 제거 — 주요 항목은 처리 완료**(2026-08-06). 남은 것:
  · `상태 직접 변경` 셀렉트(4버튼과 중복이나 **PENDING 되돌리기는 셀렉트에만 있음** — 제거 시 기능 손실. 되돌리기를 쓰는지 확인 필요)
  · 이관 화면의 CSV 붙여넣기 경로(구글시트 직접 가져오기가 상위호환인 레거시 이중 경로)
  · 공지 → 소셜 발행의 "페이스북 광고 소재" 섹션(광고를 실제로 집행하는지)
  · 갤러리 "인스타 가져오기"(등록 경로가 3중)
  · 설정 화면 `AppliesTo` 파란 뱃지 9곳(실무에 쓰이는지 시각 소음인지)
  · 시설 사진·프로그램 이미지의 URL 수기 입력(다른 이미지는 전부 파일 업로드인데 여기만 URL)
- ✅ (해소 2026-10-02) 정규 셔틀 시트 방식 → 「셔틀 명단」 탭에서 앱이 RegularShuttleStop 을 직접 편집. 기사 화면·결석 매칭은 같은 테이블을 그대로 읽는다. 시트 가져오기 API 는 410 으로 종료.
- 리포트 편집 화면 vs `SessionLogModal` — 같은 Session 레코드를 편집하는 화면이 둘(확인 필요)
- **남은 판단거리 (작은 것)**
  · 설정 화면 "외부 신청 링크"(구글폼 주소) 칸이 이제 공개 사이트에 무영향 — 칸 제거 or 점검 항목 정리
  · `lib/siteOpsBot.ts` 의 체험/수강 신청 점검이 항상 ok 가 됨 — 단순화 or 삭제
  · 스킬 "평가자" 자유 입력 → 로그인 사용자 자동 기입(서버 `skills/page.tsx` 2줄 + prop 1개 필요)
- **테스트가 문구·코드 존재를 단정해 못 건드린 것** (지우려면 테스트 동반 수정 필요):
  · ~~`ShuttleRouteAdminClient.tsx`~~ — 2026-10-02 3단계 정리에서 삭제, 그 화면을 읽던 tests 7개는 서버·API 단정만 남김
  · 신청관리 문구 2건, 방학특강 문구 2건
- ⚠️ **다중 에이전트 동시 작업 중 `git stash` 금지.** 이번에 한 에이전트가 baseline 측정용으로 실행해 다른 4개의 미저장 변경 46파일을 함께 치웠고 pop이 충돌했다. baseline이 필요하면 `git show HEAD:<파일>`로 개별 조회할 것.

## ⚠️ 배포 메커니즘(중요)
- Vercel 빌드는 `prisma generate && next build`뿐 — **`migrate deploy` 자동 실행 안 됨**. 스키마 변경은 **멱등 SQL을 운영 Supabase(ref gpjdtkumqxzfgkixjamp)에 직접 적용**(Supabase MCP apply_migration). 마이그레이션 폴더는 기록용.
- 운영 배포 = `git push origin HEAD:main` fast-forward.
- 테스트는 `node --test tests/*.test.mjs` **+ 가드 `node --experimental-strip-types --test src/lib/*.test.ts`**(=`npm test`). ⚠️ 2026-10-25 실측: `tests/` 만 돌려 **학생 병합 필터 가드(src/lib/studentVisibility.test.ts)를 놓쳤다** — 회원 탈퇴 배포 후 release:preflight 가 실패하던 상태였다. **`npx vitest`는 이 프로젝트에 없음**(설정도 없어 worktree까지 긁어 전부 오탐).
- 현재 테스트 기준선: **858건 중 실패 9건**(체험신청 폼·셔틀 좌석/주소·청구 안내 등 기존 실패). 신규 실패 판정은 이 집합과 비교할 것.

## 진행 현황
| 항목 | 상태 |
|------|------|
| 관리자·선생님 UI 전수조사(6영역 병렬) | 완료 — 문구 140·기능 46·보존 144·확인필요 61 |
| 선생님 화면 문구 정리 + 설치배너 제거 | 완료·커밋 |
| 관리자 문구 106건 정리 | 완료·커밋 |
| 도달 불가 라우트·미사용 심볼 제거 | 완료·커밋 |
| 수강신청 "수정" 버튼 복구(진입점 유실) | 완료·커밋 |
| 원생목록 7월 하드코딩 수정 | 완료·커밋 |
| 보강 잔여석 실제 계산 + 정원 초과 차단 | 완료·커밋 |
| 수업 리포트 사진 깨짐 수정 | 완료·커밋 |
| UI 기능/UI 제거 46건 | 대기(원장 확인 필요 항목 다수) |
| 셔틀 확정 명단 4~5단계(변동 감지·재발 방지 가드) | 대기 |
| 4b 시즌 격리 / 4c 추가 확정 / 4d 변동 배지 | 대기 |
| 정규반 형제할인 자동화 | 대기(시트 수동 10% 이중적용 위험 확인 필요) |
| 미푸시 커밋 | **13개** |

## 미해결 리뷰 수정 사항 (이월)
| 번호 | 파일 | 심각도 | 내용 |
|------|------|--------|------|
| R-1 | api/admin/trial-count/route.ts | 필수 | 인증 가드 추가 |
| R-2 | actions/public.ts | 권장 | source/referralSource 서버 화이트리스트 검증 |
| R-3 | actions/public.ts:353 | 권장 | shuttleNeeded: `\|\|` → `??` 변경 |
| R-7② | lib/seasonal/shuttleRoster.ts:166~176 | 권장 | 다음 시즌 신청자가 목록·확정 버튼에서 사라짐(시즌 스코프 전체 합산) |
| R-8② | admin/seasonal/shuttle/ShuttleRosterClient.tsx | 권장 | 제외 되돌리기가 세션 한정(새로고침 시 복구 UI 소멸) |
| M-1 | actions/admin.ts `bookMakeupSession` | 참고 | 정원 검증이 "조회 후 INSERT"라 극단적 동시 요청에선 이론상 1건 초과 가능(DB 제약 아님) |

---

## 작업 로그 (최근 10건)

| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-07 | developer(체육관 대관): 공개 /rental(안내·날짜칩·1시간 칸·인원/냉난방·실시간 요금·동의·완료 화면에만 계좌) + 관리자 /admin/rental(한 줄 행·상태 칩·⚡/상세 패널·확인 창, 승인→입금 확인→사용 완료→환불·취소) + GymRentalRequest(EXCLUDE 겹침 제약·RLS) + 문자 규칙 4종(원장 켬·신청자 3종 끔+env 스위치). 운영 DB 시험 실행(BEGIN…ROLLBACK)으로 겹침 제약 23P01 확인. 실제 적용·머지·배포는 독립 검수 후. tsc 0·eslint 0·전체 2993 통과(새 19) | 검수 대기 |
| 11-07 | developer 수정 1차(claude/gym-rental, 검수 권장 6건): ① 계좌를 서버 전용 notify(server-only)로 이동·클라이언트 import 그래프 검사 테스트 ② [종료]·ACTIVE 수강생 없는 반 제외 ③ 승인 때 정규 반·특강 재확인 ④ 확정 뒤 취소는 돌려준 금액 필수(cancelRefundAmount)+메모 ⑤ IP 한도(10분 5·하루 15, 지문 clientIpHash)+신청 tx·advisory lock, 원장 문자 10분 창 묶기 ⑥ 접수 문자 전용 스위치. 마이그레이션 2칸·색인 1개 추가(미적용, 시험 실행 OK). tsc 0·eslint 0·전체 2998 통과 | 완료 |
| 11-07 | reviewer(미커밋: 수강신청 안내 문자 장문화 admin.ts·smsTemplate.ts·테스트): 코드 흐름 통과 — requestedChannel=SMS면 정책 fallbackChannel=null→textChannel undefined→바이트로 자동 판정(554B=LMS, 2000B 한도 안), 잘림·강제 없음. 중복 방지 키 그대로(이미 SENT면 DUPLICATE_SKIPPED, 예전과 같음). 지운 import 잔존 0·다른 호출처 1곳(TrialCrmClient) 영향 없음. **필수 1**: smsTemplate.ts 223~237 기존 DB 교체 UPDATE 가 옛 단문으로 바꾸는 코드로 남아 있고, 기본 목록 변경은 ON CONFLICT DO NOTHING 이라 운영 DB 문구가 안 바뀜 → UPDATE 를 «옛 단문(·옛 장문)일 때 새 문구·새 variables» 로 고치거나 운영에서 «기본값 복원»/DB 갱신 | 수정 필요 |
| 11-05 | developer(claude/regular-dispatch-depart-order): 운영 지적 「16시 등원, 17시 등원, 16시 하차 순이 시간순」 반영 — runTimelineOrder 1순위를 카드 출발 시각(departTime·손 수정 반영)으로, 없으면 등원 수업−30분·하원 종료 → tripLabel → 맨 뒤, 「수업시간 확인 필요」 회차는 맨 뒤, 동률 등원 먼저. 방향 배지 dark: 변형. tsc 0, src/lib/regular 28-0, regular-*·admin-list-standard 122-0 | 검수 대기 |
| 11-05 | reviewer: regular-dispatch-by-time(f1923403) 검수 — 통과(필수 0). timeOrdered=false 분기 DOM 동일 확인·저장은 방향별 saveRoute·지도 스크롤 자기 방향 mapRef·제거 상태 잔존 0. tsc 0, 대상 테스트 148-0. 권장: ① 수업시간 누락 회차 맨 뒤로 ② 방향 배지 dark: 변형 ③ 지도 맨 아래까지 스크롤이 김(의도된 설계, 실사용 확인) — ①② 는 depart-order 에서 반영 | 통과 |
| 11-05 | developer 수정 1차(claude/dispatch-intake-merge, 검수 권장 2건): ① 저장 중 다른 학생 모달을 열면 앞 저장이 그 모달을 바꾸던 것 → 「열린 모달 = 저장한 학생」일 때만 이동 ② 운영은 저장 노선 0건이라 자동 초안만으로 dirty 가 켜져 넣기 뒤 새로고침이 늘 막힘 → RouteSection 선택 prop onUserEditChange(markDirty 만 켬, 자동 초안·저장본 읽기·저장 성공 때 끔), 정규 화면은 이 값으로만 막음. confirmLeave·저장 안 됨 표시·방학특강은 그대로. 실행 테스트 2건 추가(옛 조건이면 실패 확인) | 완료 |
| 11-05 | reviewer(8473ad8f 신규 셔틀 신청 → 정규배차 합침): 통과(필수 0). AssignLegView = 옛 AssignView 와 줄 단위 동일(page 변형 main·h1·chevron·「목록」 그대로, source 는 기사 화면에서 안 보냄). dirty 면 refreshKey 안 올림·없으면 올림, redirect month=isServiceMonth+encode, intake POST 본문 기존과 동일, via 는 DB 관리자 역할일 때만. tsc 0·테스트 277-0. 권장: ① 저장 중 모달 닫고 다른 학생 칩을 열면 저장 끝에 앞 학생 다음 칸으로 바뀜 ② 저장 노선 없는 요일은 generate 가 dirty=true 라 넣을 때마다 「저장하지 않은 수정」 안내 ③ REVIEW_LABELS 를 ShuttleIntakeClient 에서 가져옴(타입 파일로) ④ 모달 첫 포커스·포커스 가두기 없음 | 통과 |
| 11-05 | developer(claude/dispatch-intake-merge): 「신규 셔틀 신청」 탭 → 정규배차로 합침. 요일 탭 아래 「신규 배차 학생 N명·남은 칸 M」 한 줄(펼침=학생 한 줄+칸 칩·고른 요일 강조·기사 검토 배지/요청=기존 intake API) → 칩=하단 시트 모달(공용 AssignLegView, 기사 화면도 같은 파일) → 넣은 뒤 dirty 없으면 refreshKey 로 회차 카드 재조회, dirty 면 안내+「회차 다시 불러오기」. via ADMIN_DISPATCH(관리자 역할+source 일 때만). /admin/shuttle/intake → regular-dispatch redirect(month 유지). tsc 0, 관련 172/172, 전체 2961 중 실패 4(기존·무관 파일) | 완료 |
| 11-05 | reviewer(a9692f50 합류 자리·다른 요일 정류장): 통과. 시프트는 그 달·그 요일·잠금 안 계산(다음 달은 그 달 행 기준 별도 planRosterInsert), BEFORE/END 회귀 없음, OTHER key 결정적·서버 재계산, 실례 재현 OK. 직접 돌린 경계(겹친 번호·다음 달 번호/시각 복사·빈 이름) 통과, 테스트 125-0. 권장: ① 같은 이름·좌표 약간 다른 다른 요일 정류장이 후보 3칸을 중복으로 채울 수 있음(이름 기준 중복 제거) ② mapPlacementsToMonth JOIN 은 글자 그대로 비교(공백 차이면 맨 뒤+fellBack) | 통과 |
| 11-05 | developer(claude/driver-assign-join-fix): 기사 「새 학생 배정」 버그 3건 — A) 합류(JOIN) 행이 칸 맨 뒤 번호(nextSortOrder)로 들어가 다른 반·PIVOT 뒤로 가던 것 → planRosterInsert 에서 「그 이름 첫 묶음 마지막 행 바로 뒤 + 요일 전체 +1」(관리자 공통, 다음 달도 같은 이름 있으면 JOIN). B) joinOptions 에 같은 달 다른 요일·반 정류장(이름+좌표, 그 칸에 없는 이름) 추가·300m 안 최근접 추천·고르면 OTHER→INSERT(자리=추가거리 최소). C) 이미 이름 우선이라 그대로. tsc 0 · 셔틀/명단 테스트 471 통과 | 검수 대기 |
