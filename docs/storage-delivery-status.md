# 저장·반영·전달 상태 개선

기준일: 2026-10-19. 사용자 승인 범위는 코드 수정과 로컬 검증이며 운영 DB·고객 발송·푸시·배포는 포함하지 않는다. 새 시안은 만들지 않는다.

## 상태의 의미

| 상태 | 확인 근거 | 보장하지 않는 것 |
|---|---|---|
| 저장 완료 | 서버 저장 결과 또는 같은 작업의 재조회 | 알림 전달·사람의 확인 |
| 업무 반영 | 실제 업무 데이터 또는 명단 조회가 읽는 변경 기록 | 열어 둔 상대 화면의 최신 갱신 |
| 사이트 알림 등록 | 수신자별 IN_APP 장부의 SENT | 열람·업무 확인 |
| 푸시 전송 접수 | PUSH 장부의 SENT | 기기 화면 표시·사람의 확인 |
| 결과 확인 필요 | 응답 유실·재조회 실패·일부 처리 실패 | 실패 확정·안전한 무조건 재제출 |

## 구현 그룹

- A: 학부모 셔틀 변경과 교사 공지. 저장·알림 결과를 분리하고 동일 작업을 조회하여 응답 유실을 확인한다. 내부 수신자 ID나 원시 공급자 오류는 학부모에게 반환하지 않는다.
- B: 기사 승하차·GPS. 승하차 POST 후 서버 상태를 GET으로 확인하며 조회 실패를 미체크로 표시하지 않는다. GPS 위치 수집과 서버 전송을 별도로 표시한다.
- C: 관리자 전달 장부와 일반 문의. 내부 결석·셔틀 알림 장부의 기존 범위를 유지한다. 일반 문의의 상담 종결은 출결·배차 변경 완료를 뜻하지 않는다.
- D: 실제 서버 함수에 가짜 인증·저장소·전송기를 연결한 행동 검사와 실제 React 화면에 가짜 응답을 연결한 브라우저 검사를 분리한다.

## 중복·실패 처리 원칙

- 응답이 끊기면 같은 작업의 저장 여부부터 조회한다. 확인할 수 없으면 확인 필요로 유지한다.
- 승하차 저장 재확인은 조회만 수행한다. 같은 버튼을 다시 토글해 저장 결과를 뒤집지 않는다.
- 공지의 작업 식별자는 작성자·반과 함께 검증한다. 동일 작업 ID로 새 공지를 만들지 않는다.
- 누락 알림 재처리는 기존 장부로 최초 대상이 증명되는 경우에만 허용한다. 새로 입반한 학부모를 추측해 추가하지 않는다. 기존 푸시 재시도 정책은 유지한다.
- GPS 마지막 전송 시각은 정상 서버 응답 이후에만 갱신한다. 기기 중단과 서버 중단 확인은 구분한다.
- `Notification.isRead`는 업무 확인 기록이 아니므로 기사·교사의 확인 완료를 만들어내지 않는다.

## 검증 경계

행동 검사에서 저장 성공/알림 실패, 수신자 없음, 부분 푸시, 동일 요청, 응답 유실, 취소, 권한 차단, GET 실패, GPS 권한 거부·재연결·중단을 재현한다. 브라우저 검사는 운영 API를 호출할 수 없는 loopback 서버에서 실제 화면 코드를 사용한다. 최소 검사 스타일은 제품 시안이나 운영 화면의 시각적 검증을 의미하지 않는다.

실제 운영 인증 세션·전체 DB 스키마·실기기 푸시 도착·모바일 백그라운드 GPS는 이 로컬 검사로 검증되지 않는다. GPS 서버 요청이 타임아웃 뒤 오래 실행될 때의 순서 보장은 별도 한계이며 서버 중단 확인을 단정하지 않는다. 운영 검증과 배포는 결과 보고 후 별도 승인한다.

## 최종 검증 결과

- `node --test tests/parent-staff-status.test.mjs tests/driver-status-behavior.test.mjs tests/driver-status-api.test.mjs tests/admin-delivery-status.test.mjs tests/admin-request-save-status.test.mjs tests/operational-notification-delivery.test.mjs tests/unified-driver-run.test.mjs tests/driver-app-home.test.mjs tests/shuttle-ride-status.test.mjs tests/staff-home-bridge.test.mjs tests/operational-delivery-admin-ui.test.mjs tests/parent-request-message-only.test.mjs tests/admin-requests-pagination.test.mjs tests/parent-request-authorization.test.mjs`: 121/121 통과.
- `node scripts/test-storage-delivery-status-browser.mjs`: 실제 React 화면 격리 브라우저 18/18 통과. `tests/helpers/status-browser-harness.mjs`가 서버 모듈 번들을 차단하고 운영 API 대신 모의 응답만 사용한다.
- 독립 tester의 관리자 추가 실제 화면 검사 4/4 통과. 채널별 SENT·동일 사건 묶음 1건, 일반 요청 저장·응답 유실·조회 실패 잠금 3건. `.tmp/status-qa/browser-admin-channels.json`, `browser-admin-requests.json` 참조. 앞선 예비 검사는 중복 합산하지 않는다.
- `node tests/admin-request-status-browser.integration.mjs`: 일반 요청 화면의 보존·잠금·전달 구분 재현 2/2 통과(위 독립 검사와 중복).
- `npx.cmd tsc --noEmit`, `git diff --check` 통과. 삭제된 경로를 가리키던 Next 생성 타입은 `next typegen` 및 폐기된 dev validator 캐시 정리 후 재검증했다.
- 변경 TS/TSX와 신규 helper의 ESLint는 기존 대형 파일 2개를 제외하고 오류·경고 0. `admin.ts`는 동일 설정의 HEAD 대비 기존 오류 75→74, 경고 5→5. `MyPageClient.tsx` 기존 이미지 경고 1→1. 전체 린트 통과로 표현하지 않는다.
- 독립 reviewer의 A/B/C 검토 통과. 공지 미저장 재시도 잠금, 형제별 푸시 누락, 무좌표 종료의 서버 접수 오인 결함을 수정하고 행동·브라우저 회귀를 확인했다.

일반 문의는 내부 결석·셔틀 전달 장부의 대상이 아니므로, 재방문 시 영구 알림 결과 추적은 이번 범위에 없다. 상담 저장 확인과 불확실한 알림 결과를 분리하며 자동 재발송하지 않는다. 스키마 변경·운영 쓰기·실제 고객 발송·푸시·배포는 실행하지 않았다.
