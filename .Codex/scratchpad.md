# STIZ 작업 스크래치패드
## 현재 작업
- 목표: 등록 아이폰용 STIZ 격리 서명 앱 빌드·설치·실기기 검증. 운영·TestFlight 제외.
- 현재 단계: effective달력열닫/날짜유지 사용자확인·실제한글키보드/합성사유/신청버튼 동시표시·독립검토통과. resume폭326/right364/card385·가로0/사유유지. resume달력취소/가로회전 사용자대기.
- 승인 범위: build4·거부검사2파일 + 시험CA명/검사2파일 로컬수정·새격리준비 승인. 후속사용자승인으로검증브랜치956까지푸시/수동서명1회실행. 산출물검증후사용자빌드4설치·실기기검증승인완료. 운영/main·DB·발송·결제·배포/TestFlight 제외.
- 검증 한계/다음: resume달력·가로/세로복원 미완료. Drive Files PNG비활성 별도보류/복수선택·수동다운로드취소미검증. 합성사진104수신1/저장0·운영/TestFlight0.
## 진행 현황표
| 그룹 | 담당 | 상태 | 완료 기준 |
|---|---|---|---|
| 빌드4·식별 CA 준비 | PM 구현/환경·독립QA | 로컬·실HTTPS 완료 | Python9/참조28/Node44·전체2600/학생5·새run13/독립14, 푸시/remote/설치0 |
| 격리 HTTPS 시험 환경 | 서버 worker / Android worker / iOS worker / PM·독립QA | 로컬·독립 완료 | docs/native-device-sandbox.md; 전체2581/학생5·서버12·실행55/독립47+18·Java321/산출물24·iOS구성28, 기기/원격0 |
| 출시 문서·실기기 준비 | 문서 worker / 점검 worker / PM·독립 tester | 완료·로컬 커밋 | docs/native-device-release-readiness.md; 전체2569/학생5·전용13·독립읽기8/링크12·점검7/2/8, 운영/설치0 |
| 앱 사진·개발 인증 인계 | Android/서버 병렬·PM iOS/갱신·독립QA | 로컬·독립·최종빌드 완료 | docs/native-app-media-auth-followup.md; Android소스27/APK3일치·운영/설치0·#2Swift컴파일통과·사진runtime미검증 |
| Codemagic 검증 브랜치 | PM 실행·독립QA | 새#3 실제Swift/Xcode완료 | docs/stiz-ios-codemagic.md;9dea3b21·#3 finished84초·zip266.49KB·운영/main유지 |
| 통합앱·공통계정 기반 | Android/계정 병렬개발·PM iOS/Codemagic·독립QA | 로컬·독립·생산빌드 완료 | docs/native-app-foundation.md; 로컬만·미푸시/미배포 |
| 가족 연결·스포츠 업무 화면 | 서버·UI 병렬 / PM통합 / 독립QA | 푸시·운영배포검증 진행 | docs/child-connections-and-sport-workspace.md;2514/학생5·독립107·928소스·새기능off |
| 운영 홈 최초 HTML 스타일 | explorer경계 / PM수정·서버 / 독립tester | 운영배포·도메인검증 완료 | docs/public-home-ssr-style-fix.md;facac46f·2475/학생5·운영20/20·미푸시0 |
| 공개 헤더 실제 공간 | PM구현 / 탐색Guide / 콘텐츠리뷰 / 독립QA | 로컬·최종빌드·독립검증 완료 | docs/public-header-fit.md;2320/학생5·fit5/29·src881/1cbb·독립87/JS0·미배포 |
| 공개 원문·헤더 정리 | 원문 worker / 탐색 explorer·PM / 독립QA | 로컬·독립·최종빌드 완료 | docs/public-header-content-repair.md;2312/학생5·4/26·src879/4f1488·50→8·JS0·미배포 |
| 공개 홈페이지 나머지 전수 | 콘텐츠 worker / 메뉴 explorer·PM / 독립QA | 로컬·독립·최종빌드 검증 완료 | docs/public-pages-date-navigation-audit.md;2305/학생5·24/17·src879/00bb·독립92·JS0·미배포 |
| 공개 홈페이지 사용자 후속 | 특강 worker / 연간일정 worker / PM헤더·통합 / 독립QA | 로컬·생산·독립 검증 완료 | docs/public-sport-homepage.md;2281/학생5·src875·독립85(42/27/9/4/3)·JS0·운영/푸시/배포없음 |
| 공개 홈페이지 스포츠 적용 | 공통 shell / 하위페이지 / PM 홈·통합 / 독립 QA·리뷰 | 로컬·독립·생산·모바일 폭 검증 완료 | docs/public-sport-homepage.md; 2261/학생5·src873·130/기능30·HTTP29/fixture18; API·업무 라벤더 보존·미배포 |
| 공개 홈페이지3컨셉 시안 | 메뉴 explorer / 공개자료 worker / PM 시안 / 독립 tester | 전체 공개구조·독립 검증 완료 | stiz-home-complete-20261020/README.md;4095·29경로자료/정상28·192→36·신청3/4단계합성·메뉴/사진닫기/320수정·업무쓰기/인증전달0 |
| 종료 수업 시간표 삭제 | PM 수동 운영·미리보기 / tester 독립읽기 | 운영 반영·독립 검증 완료 | HANDOFF; 승인2행만 삭제·Class2/이력9·나머지설정 해시불변·독립8·운영카드제거 |
| 공개 홈페이지 변경 철회 | PM 역변경·미리보기 / tester 독립 검증 | 복원·독립 검증 완료 | a56cdcfc만 철회, src/scripts/tests는 e3f3c9a8 유지·이전 기능 보존·배포 없음 |
| 관리자·청구 통합 | 계산·UI·메뉴 worker / PM 기존경로·통합 / 독립 QA | 로컬·독립·생산빌드 완료 | docs/billing-workbench-upgrade.md; 2258/학생5·PG20/UI20·49·src867; 운영쓰기/발행/푸시/배포없음 |
| 실제 자료 개발 미리보기 | snapshot worker / PM 실행기·기기 / 독립QA | 로컬·독립·실제자료화면완료 | docs/real-data-development-preview.md;26테이블·RO/분리·소스857·단위16/외부6·9화면/36메뉴/차단4·4090실행유지 |
| 웹 배포 준비 | 범위 검토 / 설정 검토 / 독립 QA / PM | 운영 키 미발급으로 보류 | 최신2143/5·소스860·76 통과, 토스 온라인 키 누락. 환경/운영DB 검사·배포 미실행, 앱/자녀등록 별도 |
| 좁은 휴대폰 네역할 | 기사 worker / 가족·교사 worker / 관리자 worker / 독립QA / PM 통합 | 로컬·독립·생산·기사끝글자후속완료 | docs/narrow-phone-verification.md; 기존181/258/32상태140·컴파일40/청구4폭, 기사후속326/91/53·소스860·PM4폭전후동일, PM4053→4069/PG55470·미배포 |
| 명시적 보호자·반려 재검토 | 서버 worker / 신청 UI worker / 독립QA / PM 기기·서버단독 | 로컬·독립·실기기 완료 | docs/enrollment-parent-link.md; 전체2143·서버39·UI43·실제PG18/후속8·tsc·생산src860일치; 운영등록/배포없음 |
| 중복 필터 개편 | 공통·신청 worker / 원생 worker / PM·독립QA | 로컬·독립·생산·iPhone완료 | docs/admin-compact-filters.md; 230/54/45·2128/5·생산12/소스19·iPhone, 조건/API유지·미배포 |
| 전체 페이지 검증 | 역할 tester / 오류 worker / PM 기기·서버단독 | 전수·iPhone/Android회전/키보드·짧은높이완료 | docs/{all-pages,role-followup,navigation-hydration}-verification.md; 기존2143·검색14/메뉴77·실제Android3역할/청구/기사, 구4061/PG55461정리·최신시험상단참조 |
| 안드로이드 기사 위치 앱 | 앱 / 서버 / PM 기기단독 / 독립 리뷰 | USB 태블릿 단기 검증·종료·정리 완료, 출시 보류 | docs/driver-device-validation.md; Android13 단기 잠금/T맵·복귀·종료, HTTPS/PG·좌표DB 정리완료, 운영SQL/env 미적용 |
| 기사님 운행·체크 UX | UI / GPS / 저장 / PM / 독립 QA·격리PG | 실제화면·저장재조회 로컬완료·미배포 | 회귀106·JSX/CSS91·순서9·실제PG8·기존10/네이티브10·독립검토·tsc/lint; docs/driver-{lavender-implementation,order-persistence}.md |
| 출석 명단 당월 금액 | 조사 / 서버·UI / 독립 QA·리뷰 / PM | 로컬 검증 완료·미배포 | 회귀116·브라우저10·로컬PG실제UI통합9·독립모달4/반영3·tsc·lint·리뷰; docs/staff-attendance-fees.md |
| 선생님 수업·출결 UX | 조사 / 홈·진행 UI / 독립 tester·reviewer / PM | 로컬 검증 완료·미배포 | 브라우저10·상태18·회귀87·UI34·tsc·lint·리뷰 통과; docs/staff-workspace-ux.md |
| 학부모 홈 UX | 읽기 조사 / UI / 독립 tester·reviewer / PM | 로컬 검증 완료·미배포 | 브라우저10·관련회귀65·독립UI25·tsc·검토 통과; docs/parent-workspace-ux.md |
| 관리자 업무 UX | 관리자 UI / 탐색 UI / 독립 tester·reviewer / PM | 로컬 검증 완료·미배포 | UI25·브라우저4·tsc·검토 통과, 확대145/146·기존 POS 환경 실패1; docs/admin-workspace-ux.md |
| 라벤더·퍼플 학원 UI | 공통 PM / 관리자·학부모·현장 / 독립 tester·reviewer | 로컬 검증 완료·미배포 | 회귀121·브라우저18·독립49·폰트40·tsc·신규 lint 0, 상세 docs/academy-lavender-ui.md |
| 저장·반영·전달 상태 | A/B/C 구현 + tester/reviewer + PM | 로컬 검증 완료·미배포 | 회귀121·실제 화면 격리22·tsc·신규 lint·독립 검토 통과; 운영 DB/실제 푸시 미검증 |
| 다산 디지털 홍보 기반 | Codex | 로컬 검증 완료·미배포 | 검색 제목·업체 정보·FAQ 본문·사이트맵·광고 유입 식별, tsc·diff-check 통과. 네이버 광고 계정 대기 |
| G4 수동 설정 백업 | 홈페이지 구현 / 테스트 / 운영 검토 | 로컬 완료·미배포 | 57검사·tsc·독립검토 통과, 기존 lint 오류1/경고3 유지; 실제 Storage/복원 미실행 |
| G3a 입학 증거 | 홈페이지 구현 / 운영 독립검토 | 로컬 검증 완료·미배포 | 모델10·SSR2·tsc·lint 통과; 확정일 미확정 유지, G3b 설계는 정책 대기 |
| G2 상담 후속·종결 | 홈페이지 구현 / tester / 운영 독립검토 | 로컬 검증 완료·미배포 | 행동18·회귀12·tsc·lint·운영 독립검토 통과; 실제 PG/브라우저는 별도 |
| G1 예약 설정 백업 | 홈페이지 코드·기록 / 운영 독립 검토 | 로컬 검증 완료·미배포 | 실제 라우트 행동18·tsc·lint·운영 독립 재검토 통과; 전체 DB/실제 복원 검증은 후속, 수동은 G4 완료 |
| 사이트 월 장부 1차 | PM + developer + QA | 로컬 검증 완료 | 현재 수강과 선택월 Payment 분리, 다반 확인필요, 발행 범위 제한; 영구 월 장부는 다음 단계 |
| 사이트 월 장부 2차 | PM + API 연결 + 통합 suite + QA | 통합 로컬 검증 완료 | 실제 권한/API/화면/임시 DB 통합20·DB/복원37·브라우저19·회귀87·tsc·lint·QA 통과; 모의 인증, 운영 DB/배포 미적용 |
| 수납 대조 안전 차단 | Codex | 로컬 검증 완료·미배포 | 자동 쓰기 차단, 복수 반 REVIEW, 월 자료 누락 오류, 회귀 5건·tsc 통과 |
| 외부 이벤트 접수 | developer | 완료 | HMAC·재생 방지·멱등·충돌 차단 |
| 안전 검증 | tester + reviewer | 완료 | 통합 회귀 41건, tsc, diff-check 통과 |
| 원장 소비 워커 | developer + tester | 부분 완료 | PENDING 후보 읽기 전용 분류·인증 크론 라우트·계약 테스트 통과, 외부 자동 쓰기 미등록 |
| 성인반 복귀 1건 | PM | 확인보류 | 세 시스템 금액 기준 확정 후 새 미리보기 |
| 신규 수강 안전 승인 | developer + tester + reviewer | 완료 | 알림 미발송·원장 원자성·멱등성·정적 검사 통과 |
| 신규 수강신청 1건 | PM | 승인 대기 | 3중 등록 재조회 후 청구·알림·초대는 미리보기 승인 전 HELD, 승인 후 재조회 완료 |
| 대량 SMS 큐 | developer + tester + reviewer | 완료 | 최대 500명 접수·멱등·비동기 처리·진행률·UNCERTAIN 격리 검증 |
| Solapi 일괄 전송 | developer + tester + reviewer | 완료 | send-many 1회 접수·부분 실패·10분 유예·최종 결과 재조회 검증 |
| 유니폼 본사 연동 | developer + tester | 완료(발송 대기) | 자체 폼·DB 원장·디자인/이니셜·HMAC 전송·관리자 상태 화면·운영 DB 프리플라이트·로컬 빌드 검증 |
| 토스 온라인 PG 자동결제 | developer + tester | 완료(키 설정 대기) | 학부모 결제창·서버 승인·웹훅·관리자 상태·프리플라이트 검증 |
| 본사 카페24 결제 브리지 | developer + tester | 완료(본사 API 인계 완료) | 결제 제공자 분기·서명 요청·서명 웹훅·관리자 표시·프리플라이트·빌드 검증, 본사 Issue #134 생성 |
| 카카오 학부모 접수 | developer + tester | 내부 자동화 완료·채널 배포 HELD | 최초 인증, 매분 라우팅, 원장·담당 코치·기사 내부 알림 검증; 외부 3중 쓰기는 승인형 |
| 정규 배차 담당 기사 알림 | developer + tester + reviewer | 완료·운영 배포 대기 | 월·요일·방향·학생 ID로 고유 기사 알림, 미배정/복수는 원장 확인, 요청 취소 포함 |
| 담당자 알림 전달 장부 | developer + tester + reviewer | 완료·운영 배포 대기 | 인앱·푸시 상태/오류/시도 기록, 중복 방지, 개인정보 제거, 5분 누락 복구, 관리자 조회 |
## 구현 기록
- 현재 앱·공통계정 그룹 상세는 docs/native-app-foundation.md, iOS는 docs/stiz-ios-codemagic.md에 보존한다.
- 완료된 배차·동기화·화면 그룹 상세는 각 docs 문서와 Git 이력에 보존한다.
## 기획설계
- 사이트 변경은 원본 시스템 완료, 나머지 시스템 대기로 기록한다.
- 시트 직접 변경은 서명된 이벤트로 사이트 승인대기 원장에 접수한다.
- Rallyz 공식 API·웹훅이 없으므로 로그인 브라우저 감독형 반영을 유지한다.
- 다음 단계는 시트 Apps Script 발신 코드, PENDING 소비 워커, 관리자 상태 화면이다.
- 오전 10시 전체 대조는 실시간 경로의 누락 안전망으로 유지한다.
- 청구·결제·환불·문자·알림은 정확한 미리보기와 실행 시점 승인 전 자동 실행하지 않는다.
## 테스트 결과
- 격리 환경: 전체2581/학생5·서버12·TLS/화면55·독립47+18·Java321/산출물24·iOS구성28 통과. 신규Swift/기기미검증, 이전도구7/2/8 및 앱증거는 각 정본에 구분.
- 이전 검증 상세는 각 그룹 문서와 Git 이력에 보존한다. 운영·실기기·모의 자료 검증은 구분한다.
## 수정 요청
- 현재 미결 코드 검토 요청 없음. 이전 완료 결과는 Git 이력과 knowledge에 보존.

## 확인보류
- 복수 반은 시트 별도 행. 운영 라우터/인증/API/DB 통합 E2E·스키마 호환·이관대조·할인/이월 잔액 자동검증 필요. 시트 중단·운영 쓰기·배포 미승인.
- 성인반 복귀 1건: 시트·Rallyz·사이트의 상태와 금액 기준이 달라 등록과 청구를 분리하고 확인보류한다.
- 다음 월 개강일과 청구 기준일은 실행 시 공식 연간일정표에서 재확인한다.
- RESUME/CLASS_ADD/CLASS_CHANGE 자동 실행 어댑터는 다음 그룹이다.
- 카카오 운영 적용은 전용 migration·비밀 환경변수·챗봇 관리자센터 스킬/블록 배포·단일 ACTIVE 처리기 승인이 필요하다.

## 작업 로그 (최근 10건)
- 2026-10-29: effective달력유지 사용자확인/실물한글키보드·사유/신청표시 독립통과(402x400 visual388/가로0). 휴원사유유지·resume326/right364/card385/가로0, 달력취소·가로회전대기. 운영/신청/TestFlight0.
- 2026-10-29: 정확사진input Files비활성/Drive확인→시험서버종료PID/양쪽refused확정·같은runCA숨김복구. 사진보관함PNG104수신1/저장0·실물확인, 새effective날짜폭326/가로0·키보드대기. 운영/TestFlight0.
- 2026-10-29: 합성PNG Drive표시직접확인·정확사진accept입력메뉴root실행후Files비활성사용자재현. 원인미확정/성공보류·합성사진저장/보관함경로요청, 개인사진캡처/운영작업0.
- 2026-10-29: 저장후media복귀실물/독립확인·사진선택취소전후upload/stored0·선택0. 후속PNG104B Files회색/실수신0으로사용자성공응답보류·사진input재시도대기·운영/TestFlight0.
- 2026-10-29: 새CA사용자신뢰후빌드4 역할선택실물/402x750가로0·strictTLS200. 합성PNG104B iOS공유창열림/뒤media유지, 사용자로컬저장대기·upload/stored0·운영/TestFlight0.
- 2026-10-29: 승인빌드4 동일기기정확guard/USB설치1회·별도조회4, 직접실행·독립PNG 안내/-1202정상. 새CA명식별공개전달200/키경로404·사용자신뢰대기, strictHTTPS합성health200·운영/TestFlight0.
- 2026-10-29: 승인5커밋956까지푸시·서명#4 1회 finished111초. IPA0.1.0/4 SHA일치·독립서명/코드/프로파일통과, strictTLS health200·합성전용. 운영/TestFlight/설치/새CA신뢰0·설치승인대기.
- 2026-10-29: 승인BUILD4·이전1/2/3거부/실행ID CA명4파일정정, Python9/참조28/Node44·전체2600/학생5·독립PASS. 새run-7ef56c476e747a20 source54/최종date+PNG104B·strictHTTPS13/독립14, 현Codemagic STIZ프로파일읽기확인. BlobCSV2경로조사만·기기신뢰/푸시/remote/설치/운영/TestFlight0.
- 2026-10-28: 부모실제키보드/합성사유·신청버튼동시표시 독립확인·POST0. 승인날짜2입력폭로컬보완·현재적용일임시대조391→364/복원391, tsc·기존신청31·독립diff통과. 새번들/복귀일/선택기미검증·종료시역할복귀미확인/시험탐색중단·연결종료. 운영/푸시/빌드/설치/TestFlight0.
- 2026-10-28: 승인iOS다운로드4파일로컬구현/독립정적28·구성28·최종2599/학생5통과. 동일원점·knownlen10MiB·취소/공유/temp정리, Swift컴파일/설치0·BlobCSV미지원. PNG길이104B정정/독립HTTP검사·현재run보존/새prepare필요. 관리자세로복원완료·부모날짜6px확정/입력검사중, Safari유실로개인picker0·운영/푸시/TestFlight0.
## PM 체크
