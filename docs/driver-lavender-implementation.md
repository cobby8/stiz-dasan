# 기사님 라벤더 시안의 실제 화면 적용

2026-10-19. 실제 서비스 소스에 적용한 로컬 검증본이다. 푸시·배포·운영 데이터 변경은 하지 않았다.

## 작업 그룹

| 그룹 | 담당 | 의존 관계 | 완료 기준 |
|---|---|---|---|
| 진입 경로·기능 대조 | 읽기 조사 | 없음 | 실제 사용 컴포넌트와 보존 기능 확인 |
| 운행·명단 UI | UI 작업자 | 시안·조사 | 컴팩트 배치와 기존 저장 계약 보존 |
| GPS 상태 표시 | GPS UI 작업자 | 없음 | 작은 상태 아이콘·상세·오류 안내 보존 |
| 현재 시각 계산·통합 | PM | UI와 병합 | 기기 시각·날짜·편집 상태 검증 |
| 독립 검증 | tester·reviewer | 구현 완료 | 회귀·배치·접근성·오류 경로 확인 |

## 적용 경로와 시안 대조

세 경로 `/driver/[token]`, `/shuttle/run/[token]`, `/shuttle/regular/[token]`는 모두 `UnifiedDriverRunPage` → `UnifiedDriverClient`를 사용한다. 연결되지 않은 구형 `RegularDriverClient`, `seasonal/DriverRunClient`는 수정하지 않았다.

| 항목 | 실제 화면 처리 |
|---|---|
| 라이트·라벤더·공식 로고 | 기존 AcademyTheme와 공식 로고 유지 |
| 시간·길안내 | 시간 왼쪽·길안내 오른쪽, 폭이 부족하면 묶음 단위 줄바꿈 |
| 이름·연락·체크 | 이름 오른쪽 전화, 부족하면 체크 버튼 쌍을 다음 행으로 이동 |
| 다음 정류장 | 휴대폰 로컬 날짜·시각과 표시 날짜가 일치할 때 예정 정류장 하나 강조 |
| 강조 방식 | 보라 테두리, 내부 여유8px, 굵은28px 시간·14px 고대비 안내 배지 |
| 시간 미리보기 | 실제 화면에는 없음. 기존 정규 순서 편집용 실제 정차 시간 입력은 유지 |
| 실제 기능 | 정규/특강별 저장 키·API, 등원/하원, 결석/자차, 오늘만 변경, 거점·노선 경고 유지 |
| 저장 상태 | 저장 중·실패·반영 불일치·결과 불명과 재조회·중복 클릭 잠금 유지 |
| GPS | 정상은 헤더 아이콘, 오류·권한·지연·중단 미확인은 짧은 문구. 상세창은 기존 GpsShareBar 그대로 |
| 운행 상태 | 시작·종료·종료 재확인·수동 재시작과 네이티브 복원 처리 유지 |
| PC·태블릿 | 최대1120px, 정류장 정보 옆 명단, 정류장 순서 자체는 세로 유지 |

시계는 처음 서버 렌더에서는 비워 두고 마운트 후 읽는다. 15초 간격 및 화면 복귀에 재계산하므로 분 경계 표시에는 최대15초 지연이 있다. 시각 미정·터미널 안내 행은 강조에서 제외하며 같은 시각은 현재 명단 순서를 따른다. 순서 편집 중에는 강조를 숨긴다. 이 강조는 GPS 기반 도착 판단이 아니며 탑승 상태나 운행 세션을 변경하지 않는다.

## 검증과 증거

- `node --experimental-strip-types --test tests/driver-upcoming.test.mjs tests/driver-gps-indicator.test.mjs tests/gps-share-bar-render.test.mjs tests/driver-status-behavior.test.mjs tests/unified-driver-run.test.mjs tests/native-driver-gps.test.mjs tests/mobile-driver-tracking.test.mjs tests/driver-device-test-server.test.mjs`: 82/82 통과.
- `node scripts/test-driver-lavender-browser.mjs`: 실제 React·원본 Tailwind/Academy CSS·CSS Module·공식 로고·Material Symbols를 연결한 격리 검사91/91 통과. 320/360/390/554/768/834/1024/1280/1920, 다음 정류장 이동·날짜·편집·15초·GPS 상세 Escape/초점·연락과 길안내 위치·44px 터치를 확인했다. `.tmp/driver-lavender-actual/results.json`, `390.png`, `834.png`, `1280.png`.
- 기존 `node scripts/test-driver-workspace-browser.mjs`: 10/10 통과. 정규·특강 실제 저장 요청 구조와 재조회, 응답 유실, 연속 클릭, 미확인 상태, 사전 결석·자차를 합성 API로 검증했다.
- 기존 `node scripts/test-native-driver-browser.mjs`: 10/10 통과. 실제 hook과 bridge adapter에 합성 기기 이벤트를 연결해 복귀·재시작·중단 미확인을 검증했다.
- 독립 담당이 위 브라우저3묶음을 재실행하고 관련 단위47/47 통과를 확인했다. 동일 검사의 재실행이므로 고유 건수로 합산하지 않는다.
- 다른 날짜의 ‘오늘로’ 링크와 최초 조회 실패/저장 결과 미확인 재조회 버튼의44px 보완 후 독립18/18 통과. `.tmp/stiz-design-boundary-qa/actual-driver-error-touch.json`.
- 추가 긴 정류장·학생명, 가로844×390, 글자100/200% 등16/16 통과. `.tmp/stiz-design-boundary-qa/actual-driver-longtext.json`.
- `npx tsc --noEmit`, 변경 TS/TSX·테스트 도구 ESLint, `git diff --check` 통과. React 검토에서 조건부 hook·효과 정리·기존 API 계약 변경 문제 없음.

CSS Module 격리 도구는 실제 CSS를 적용하되 해시 클래스명을 원문에 대응시킨다. Next 이미지 최적화·실제 인증은 대체한다. 검사용 아이콘 폰트는 준비 시 정적 파일만 받아 loopback에서 제공한다. 브라우저에서는 외부/운영 API를 차단했다. 물리 기기, 운영 로그인·DB 저장, 실제 전화·T맵 실행, 실제 GPS 송신·장기 백그라운드 검증은 이번 검사에 포함하지 않았다. 이전 시안/Android 기기 결과를 이번 코드의 실기기 결과로 재사용하지 않는다.

## 조사 중 발견한 기존 저장 불일치

정규 순서 수정 API는 월별 `RegularShuttleStop`을 변경하지만, 확정 배차가 있는 화면은 `RegularDispatchRoute` 저장본의 순서·시각을 우선 읽는다. 합성 재현에서 명단 시각14:40, 확정 배차14:38이면 다시 구성한 기사 화면은14:38을 표시했다. `.tmp/driver-order-readback-gap.json`.

운영 데이터에서 실행한 결과가 아닌 기존 읽기 경로의 합성 재현이다. UI 적용 그룹에서는 API·데이터 조회를 변경하지 않았다. 사용자가 제공한 리디자인 규칙의 API/데이터 변경 금지 범위를 넘어서는 저장·재조회 수정은 별도 범위 승인 질문으로 분리했고, 사용자 승인 후 다음 그룹으로 진행한다. 이 UI 그룹 커밋에는 해당 API 수정을 포함하지 않는다.
