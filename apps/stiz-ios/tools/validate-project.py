"""Windows에서도 실행 가능한 구성 검사. Xcode 컴파일/기기 검사를 대신하지 않는다."""
from pathlib import Path
import json
import plistlib
import re
import xml.etree.ElementTree as ET
from native_signed_sandbox import validate_workflows

root = Path(__file__).resolve().parents[1]
project = (root / "STIZ.xcodeproj/project.pbxproj").read_text(encoding="utf-8")
defined = re.findall(r"^\s*(A[0-9A-F]{23}) =", project, re.M)
references = set(re.findall(r"\bA[0-9A-F]{23}\b", project))
assert len(defined) == len(set(defined)), "프로젝트 ID 중복"
assert references == set(defined), "프로젝트 파일 참조 누락"
for file in ["AppDelegate.swift", "NavigationPolicy.swift", "NativeAuthPolicy.swift", "NativeAuthCoordinator.swift", "WebViewController.swift", "NativePush.swift", "Info.plist", "Assets.xcassets", "PrivacyInfo.xcprivacy", "Firebase"]:
    assert (root / "STIZ" / file).exists(), file
    assert f"path = {file};" in project, file
for path in (root / "STIZ").rglob("*.json"):
    json.loads(path.read_text(encoding="utf-8"))
with (root / "STIZ/Info.plist").open("rb") as handle:
    info = plistlib.load(handle)
# 개발 흔적(로컬 네트워크 안내·개발 URL 스킴)은 Debug 전용 Info-Debug.plist 에만 둔다(2026-11-13 출시 정리).
with (root / "STIZ/Info-Debug.plist").open("rb") as handle:
    debug_info = plistlib.load(handle)
dev_only = {"NSLocalNetworkUsageDescription", "CFBundleURLTypes"}
assert not (dev_only & set(info)), "출시 Info.plist 에 개발용 키 금지"
assert {k: v for k, v in debug_info.items() if k not in dev_only} == info, "Debug/출시 Info.plist 는 개발용 키 말고 같아야 함"
assert not any("Location" in key for key in info), "iOS 위치 권한은 이 그룹 범위 아님"
assert "NSAppTransportSecurity" not in info, "HTTP/TLS 예외 금지"
assert info["STIZNativeAuthDevelopmentEnabled"] is False, "새 인증 기본 비활성"
assert info["STIZSandboxOrigin"] == "$(STIZ_SANDBOX_ORIGIN)", "시험 주소는 명시 빌드 설정만 사용"
assert debug_info["NSLocalNetworkUsageDescription"], "개발용 로컬 서버 접근 안내(Debug 전용)"
assert project.count('STIZ_SANDBOX_ORIGIN = "";') == 2, "Debug/Release 기본 시험 주소는 비어 있어야 함"
assert info["NSCameraUsageDescription"] and info["NSPhotoLibraryUsageDescription"]
assert debug_info["CFBundleURLTypes"][0]["CFBundleURLSchemes"] == ["stiz-academy-dev"]
assert "UIInterfaceOrientationLandscapeLeft" in info["UISupportedInterfaceOrientations"]
scheme = ET.parse(root / "STIZ.xcodeproj/xcshareddata/xcschemes/STIZ.xcscheme")
assert all(ref.attrib["BlueprintIdentifier"] in references for ref in scheme.iter("BuildableReference"))
assert "kr.stiz.academy.dev" in project and "DEVELOPMENT_TEAM" not in project
# 스토어용 Release 는 정식 ID·1.x 버전, 개발 Debug 는 기존 개발 ID·0.1.0(격리 시험 도구 계약)을 유지한다.
release_settings = re.search(r"A0000000000000000000000F = \{[^\n]*\}; name = Release;\};", project).group(0)
assert "PRODUCT_BUNDLE_IDENTIFIER = kr.co.upturnlabs.stizdasan;" in release_settings and "MARKETING_VERSION = 1.0.1;" in release_settings
assert "INFOPLIST_FILE = STIZ/Info.plist;" in release_settings and 'INFOPLIST_FILE = "STIZ/Info-Debug.plist";' in project
# 유니버설 링크 권한 파일은 준비만 해 두고 1.0.1 에서는 연결하지 않는다(2026-11-13 검수 결정).
# 애플 포털에서 Associated Domains 를 켜고 프로파일을 다시 받은 뒤 Release 에 한 줄 복원 → 이 검사도 그때 «연결됨»으로 바꾼다.
# 절차: docs/store-release.md «iOS 유니버설 링크 다시 켜기».
assert "CODE_SIGN_ENTITLEMENTS" not in project, "프로파일 준비 전에는 권한 파일을 서명에 붙이지 않는다"
with (root / "STIZ/STIZ.entitlements").open("rb") as handle:
    entitlements = plistlib.load(handle)
# 앱 알림(FCM→APNs, 2026-11-14 e2): aps-environment 도 준비만 — 애플 포털에서 Push Notifications 를 켠 프로파일과 함께 연결한다.
assert entitlements == {"aps-environment": "production", "com.apple.developer.associated-domains": ["applinks:www.stiz-dasan.kr", "webcredentials:www.stiz-dasan.kr"]}
# 앱 알림: Firebase 패키지(FirebaseMessaging)·설정 폴더(폴더 참조 — 파일이 없으면 알림만 꺼지고 빌드는 된다).
assert 'repositoryURL = "https://github.com/firebase/firebase-ios-sdk";' in project and "productName = FirebaseMessaging;" in project
assert "lastKnownFileType = folder; path = Firebase;" in project, "설정 파일은 폴더 참조로만(파일 참조면 없을 때 빌드가 깨진다)"
assert "GoogleService-Info.plist" not in project, "설정 파일을 프로젝트에 직접 연결하지 않는다"
assert "STIZ/Firebase/GoogleService-Info.plist" in (root / ".gitignore").read_text(encoding="utf-8"), "설정 파일은 저장소에 넣지 않는다"
native_push = (root / "STIZ/NativePush.swift").read_text(encoding="utf-8")
assert 'inDirectory: "Firebase"' in native_push and "guard !NavigationPolicy.sandbox.isRequested" in native_push, "시험 앱·설정 없는 빌드는 Firebase 를 켜지 않는다"
assert "message.frameInfo.isMainFrame" in native_push and 'origin.host.lowercased() == "www.stiz-dasan.kr"' in native_push, "알림 창구는 우리 사이트 맨 위 화면에만"
assert "NavigationPolicy.pushTarget(" in native_push, "알림을 눌러 여는 주소는 주소 정책으로 거른다"
assert info["CFBundleDisplayName"] == "STIZ 농구교실"
# 스토어 아이콘: 1024 한 장(투명 없음)과 빌드 설정. 개인정보 명세: 앱 리소스로 포함·추적 없음.
assert project.count("ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;") == 2, "Debug/Release 모두 AppIcon 사용"
icon = json.loads((root / "STIZ/Assets.xcassets/AppIcon.appiconset/Contents.json").read_text(encoding="utf-8"))
assert [(i["size"], i["filename"]) for i in icon["images"]] == [("1024x1024", "AppIcon-1024.png")]
png = (root / "STIZ/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png").read_bytes()
assert png[:8] == b"\x89PNG\r\n\x1a\n" and int.from_bytes(png[16:20], "big") == 1024 and int.from_bytes(png[20:24], "big") == 1024
assert png[25] == 2, "앱스토어 아이콘은 투명 채널 없는 RGB 여야 함"
assert "path = PrivacyInfo.xcprivacy;" in project and "A00000000000000000000026" in project.split("PBXResourcesBuildPhase")[1].split("\n")[0]
with (root / "STIZ/PrivacyInfo.xcprivacy").open("rb") as handle:
    privacy = plistlib.load(handle)
assert privacy["NSPrivacyTracking"] is False and privacy["NSPrivacyTrackingDomains"] == []
assert all(not item["NSPrivacyCollectedDataTypeTracking"] for item in privacy["NSPrivacyCollectedDataTypes"])
assert info["ITSAppUsesNonExemptEncryption"] is False, "HTTPS 표준 암호화만 사용(수출 규정 면제)"
workflow = (root.parents[1] / "codemagic.yaml").read_text(encoding="utf-8")
validate_workflows(workflow)
# 업턴랩스 팀 키(bdr-asc-key)는 스토어 작업에만 — BDR 앱과 함께 쓴다(원장 결정 2026-11-08). 다른 작업에서는 금지.
before_store, store_part = workflow.split("\n  stiz-ios-app-store:", 1)
assert "app_store_connect:" not in re.sub(r"(?m)^\s*#.*$", "", before_store), "시뮬레이터·격리 작업에 스토어 키 금지"
assert "app_store_connect: bdr-asc-key" in store_part
assert "mac_mini_m2" in workflow
view = (root / "STIZ/WebViewController.swift").read_text(encoding="utf-8")
assert "WKContentRuleListStore.default().compileContentRuleList" in view
assert "guard sandboxProtectionReady else { return }" in view, "통신 차단 준비 전 페이지 로드 금지"
assert "? .nonPersistent() : .default()" in view, "시험 저장소를 운영 쿠키와 분리"
assert "serverTrust" not in view and "NSAppTransportSecurity" not in view, "TLS 신뢰 우회 금지"
assert not re.search(r"\.map\(\s*NavigationPolicy\.allowsSubframe\s*\)", view), "기본 인자가 있는 함수는 Optional.map에 명시 closure로 전달"
print(f"STIZ iOS 구성 검사 통과: 프로젝트 참조 {len(defined)}개, plist·scheme·색상·수동 무서명 구성 (실제 빌드 미실행)")
