"""등록 기기용 격리 앱 빌드. 키 내용은 읽지 않고 서명은 macOS keychain에 맡긴다."""
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import zipfile

BUNDLE = "kr.co.upturnlabs.stizdasan"
TEAM = "UC62AC4W4T"
ORIGIN = "https://172.30.1.12:8453"
PROFILE_NAME = "STIZ-Dasan-AdHoc-Sandbox-2026"
PROFILE_REFERENCE = "stiz-dasan-adhoc-sandbox-2026"
CERTIFICATE_REFERENCE = "BDR iOS App Store Distribution"
VERSION = "0.1.0"
BUILD = "4"
SANDBOX_ATS = {"NSExceptionDomains": {"172.30.1.12": {
    "NSExceptionAllowsInsecureHTTPLoads": False,
    "NSExceptionMinimumTLSVersion": "TLSv1.2",
    "NSExceptionRequiresForwardSecrecy": True,
    "NSIncludesSubdomains": False,
}}}


class GateError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise GateError(message)


def validate_workflows(text):
    """일반 YAML 실행기가 아니라 이 저장소의 두 수동 워크플로 계약만 확인한다."""
    cleaned = re.sub(r"(?m)^\s*#.*$", "", text)
    headers = list(re.finditer(r"(?m)^  ([a-z0-9-]+):\s*$", cleaned))
    names = [match.group(1) for match in headers]
    require(names == ["stiz-ios-simulator", "stiz-ios-sandbox-adhoc"], "승인된 워크플로 두 개만 허용합니다")
    require(not re.search(r"(?m)^\s*(publishing|integrations|app_store_connect):", cleaned), "스토어 업로드·추가 연동 금지")
    blocks = [cleaned[match.end():headers[index + 1].start() if index + 1 < len(headers) else len(cleaned)]
              for index, match in enumerate(headers)]
    for block in blocks:
        require(len(re.findall(r"(?m)^\s*triggering:", block)) == 1, "수동 실행 설정 중복·누락")
        events = re.findall(r"(?m)^\s*events:(.*)$", block)
        require(len(events) == 1 and re.fullmatch(r"\s*\[\s*\]\s*", events[0]), "자동 빌드 실행 금지")
    simulator, signed = blocks
    # 승인된 명령 묶음의 지문을 고정한다. 추가 업로드·우회 명령은 한 줄이어도 차단한다.
    approved_scripts = ["9f176863b4cc2e12c7b1f2cf1fae2bcf55bc69e640a44f8470b4c9efd4eb8c3f",
                        "b1e51ffd5f835ce293ec416a9f421ad56c52fae95845c416d0ee1c6eaccaf58d"]
    for block, fingerprint in zip(blocks, approved_scripts):
        pieces = re.split(r"(?m)^    scripts:\s*$", block.replace("\r\n", "\n"))
        require(len(pieces) == 2, "실행 명령 묶음 중복·누락")
        script = re.split(r"(?m)^    artifacts:\s*$", pieces[1])[0].strip()
        require(hashlib.sha256(script.encode("utf-8")).hexdigest() == fingerprint, "승인되지 않은 실행 명령 변경")
    require(re.findall(r"CODE_SIGNING_ALLOWED\s*=\s*(\S+)", simulator) == ["NO"], "시뮬레이터 서명 금지")
    require("-sdk iphonesimulator" in simulator and "ios_signing:" not in simulator, "무서명 검증 경계 변경 금지")
    require(signed.count(f"- profile: {PROFILE_REFERENCE}") == 1, "STIZ 전용 프로파일 참조 필요")
    require(len(re.findall(r"(?m)^          - profile:", signed)) == 1, "추가 프로파일 금지")
    require(signed.count("environment_variable: STIZ_SANDBOX_PROFILE") == 1, "프로파일 경로 전달 필요")
    require(signed.count(f'- "{CERTIFICATE_REFERENCE}"') == 1, "선택한 팀 인증서 참조 필요")
    require(len(re.findall(r"(?m)^        - ", signed)) == 1 and "- stiz_ios_sandbox_device" in signed,
            "대상 기기 확인용 비공개 그룹만 참조합니다")
    require(len(re.findall(r"(?m)^          - (?!profile:)", signed)) == 1, "추가 인증서 금지")
    require(signed.count(f'STIZ_SANDBOX_ORIGIN: "{ORIGIN}"') == 1, "격리 주소 고정 필요")
    require(signed.count("python3 apps/stiz-ios/tools/native_signed_sandbox.py build") == 1,
            "기기 일치·서명·IPA 검증 도구 필요")
    require("STIZ_EXPECTED_DEVICE_SHA256:" not in cleaned, "기기 확인값을 저장소에 넣지 않습니다")
    require("distribution_type:" not in signed and "bundle_identifier:" not in signed, "참조명 방식과 자동 선택 혼용 금지")
    require("CODE_SIGNING_ALLOWED" not in signed and "xcodebuild" not in signed, "서명 검증 도구 우회 금지")
    artifacts = re.split(r"(?m)^    artifacts:\s*$", signed)
    require(len(artifacts) == 2 and [line.strip() for line in artifacts[1].strip().splitlines()] == [
        "- apps/stiz-ios/build/sandbox-device/STIZ-sandbox.ipa",
        "- apps/stiz-ios/build/sandbox-device/verification.json"], "허용된 IPA·검증 요약만 보관합니다")


def device_digest(value):
    compact = value.replace("-", "").replace("_", "").lower()
    require(re.fullmatch(r"[0-9a-f]{24}", compact), "등록 기기 식별자 형식 확인 실패")
    return hashlib.sha256(compact.encode("ascii")).hexdigest()


def validate_profile(profile, expected_device_hash, now=None):
    """선택한 프로파일의 승인 범위만 검사하고 기기 원문은 반환하지 않는다."""
    require(re.fullmatch(r"[0-9a-f]{64}", expected_device_hash or ""), "비공개 대상 기기 확인값 필요")
    now = now or datetime.now(timezone.utc)
    expires = profile.get("ExpirationDate")
    require(isinstance(expires, datetime), "프로파일 만료 정보 누락")
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    require(expires > now + timedelta(minutes=30), "프로파일이 만료되었거나 곧 만료됩니다")
    require(profile.get("Name") == PROFILE_NAME, "STIZ 전용 프로파일 이름 불일치")
    require(profile.get("TeamIdentifier") == [TEAM], "프로파일 조직 불일치")
    require(profile.get("ApplicationIdentifierPrefix") == [TEAM], "프로파일 앱 접두사 불일치")
    require(re.fullmatch(r"[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}", profile.get("UUID", "")), "프로파일 UUID 누락")
    ent = profile.get("Entitlements", {})
    require(ent.get("application-identifier") == f"{TEAM}.{BUNDLE}", "프로파일 앱 식별자 불일치")
    require(ent.get("com.apple.developer.team-identifier") == TEAM, "프로파일 팀 권한 불일치")
    require(ent.get("get-task-allow") is False, "Ad Hoc 배포 권한이 아닙니다")
    require(not ent.get("beta-reports-active"), "App Store/TestFlight 프로파일 금지")
    require(not profile.get("ProvisionsAllDevices"), "전체 기기 허용 프로파일 금지")
    devices = profile.get("ProvisionedDevices")
    require(isinstance(devices, list) and len(devices) == 1, "승인된 기기 한 대만 포함해야 합니다")
    require(isinstance(devices[0], str) and device_digest(devices[0]) == expected_device_hash, "대상 기기 불일치")
    certs = profile.get("DeveloperCertificates")
    require(isinstance(certs, list) and len(certs) == 1 and isinstance(certs[0], bytes), "배포 인증서 한 개 확인 필요")
    return {"uuid": profile["UUID"], "certificate_sha1": hashlib.sha1(certs[0]).hexdigest().upper()}


def validate_settings(settings):
    expected = {"CONFIGURATION": "Debug", "PRODUCT_BUNDLE_IDENTIFIER": BUNDLE,
                "DEVELOPMENT_TEAM": TEAM, "STIZ_SANDBOX_ORIGIN": ORIGIN,
                "CODE_SIGNING_ALLOWED": "YES", "CODE_SIGN_STYLE": "Manual",
                "CURRENT_PROJECT_VERSION": BUILD, "MARKETING_VERSION": VERSION}
    require(all(settings.get(key) == value for key, value in expected.items()), "기기 빌드의 격리·서명 설정 불일치")
    require("DEBUG" in settings.get("SWIFT_ACTIVE_COMPILATION_CONDITIONS", "").split(), "DEBUG 컴파일 조건 필요")
    require(settings.get("SDK_NAME", "").startswith("iphoneos"), "실기기 SDK 필요")


def validate_app(info, entitlements):
    require(info.get("CFBundleIdentifier") == BUNDLE, "완성 앱 식별자 불일치")
    require(info.get("STIZSandboxOrigin") == ORIGIN, "완성 앱 시험 주소 불일치")
    require(info.get("STIZNativeAuthDevelopmentEnabled") is False, "시험 앱의 실제 인증은 꺼져 있어야 합니다")
    # Python의 False == 0 비교를 피하고 키·값·불리언 형식까지 정확히 비교한다.
    require(json.dumps(info.get("NSAppTransportSecurity"), sort_keys=True) == json.dumps(SANDBOX_ATS, sort_keys=True),
            "시험 IP의 보안 기본값만 명시해야 합니다")
    require(info.get("CFBundleShortVersionString") == VERSION and info.get("CFBundleVersion") == BUILD,
            "시험 앱 버전·빌드 번호 불일치")
    require(info.get("CFBundleDisplayName") == "STIZ 격리시험", "시험 앱 표시 이름 누락")
    require(info.get("CFBundleSupportedPlatforms") == ["iPhoneOS"], "실기기용 앱이 아닙니다")
    require(entitlements.get("application-identifier") == f"{TEAM}.{BUNDLE}", "서명 앱 권한 식별자 불일치")
    require(entitlements.get("com.apple.developer.team-identifier") == TEAM, "서명 앱 팀 불일치")
    require(entitlements.get("get-task-allow") is False, "서명 앱 Ad Hoc 권한 불일치")
    require(not entitlements.get("beta-reports-active"), "스토어 배포 권한 금지")


def export_options(profile_name, certificate_sha1):
    return {"method": "release-testing", "destination": "export", "signingStyle": "manual",
            "teamID": TEAM, "signingCertificate": certificate_sha1,
            "provisioningProfiles": {BUNDLE: profile_name}, "manageAppVersionAndBuildNumber": False,
            "uploadSymbols": False, "stripSwiftSymbols": True, "thinning": "<none>"}


def command_failure(stage, executable, returncode):
    # 인수·명령 출력은 공개하지 않고 미리 정한 단계명과 종료 번호만 남긴다.
    labels = {"profile": "프로파일 확인", "identity": "서명 항목 확인", "capability": "Xcode 배포 방식 확인",
              "settings": "실기기 빌드 설정 확인", "archive": "Debug 앱 빌드",
              "export": "Ad Hoc IPA 내보내기", "signature": "앱 서명 확인",
              "entitlements": "앱 권한 확인", "commit": "소스 버전 확인"}
    tools = {"security", "xcodebuild", "codesign", "git"}
    label = labels.get(stage, "알 수 없는 검증 단계")
    tool = executable if executable in tools else "검증 도구"
    code = str(returncode) if type(returncode) is int else "확인 불가"
    return f"{label} 실패 ({tool}, 종료 번호 {code}). 명령 인수와 원문 출력은 비공개입니다"


def command(args, *, stage, cwd=None, both=False):
    # 하위 출력에는 프로파일 기기 정보가 있을 수 있어 원문을 출력하거나 artifact로 보관하지 않는다.
    result = subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    require(result.returncode == 0, command_failure(stage, args[0], result.returncode))
    return result.stdout + result.stderr if both else result.stdout


def decode_profile(path):
    return plistlib.loads(command(["security", "cms", "-D", "-i", str(path)], stage="profile"))


def verify_bundle(app, expected_hash):
    command(["codesign", "--verify", "--deep", "--strict", str(app)], stage="signature")
    profile = decode_profile(app / "embedded.mobileprovision")
    validate_profile(profile, expected_hash)
    info = plistlib.loads((app / "Info.plist").read_bytes())
    entitlements = plistlib.loads(command(["codesign", "--display", "--entitlements", ":-", str(app)], stage="entitlements"))
    validate_app(info, entitlements)
    return info


def build():
    require(sys.platform == "darwin", "이 도구는 승인된 원격 Mac에서만 실행합니다")
    require(os.environ.get("STIZ_SANDBOX_ORIGIN") == ORIGIN, "명시한 격리 주소 필요")
    expected_hash = os.environ.get("STIZ_EXPECTED_DEVICE_SHA256", "")
    require(re.fullmatch(r"[0-9a-f]{64}", expected_hash), "비공개 대상 기기 확인값 필요")
    profile_path = Path(os.environ.get("STIZ_SANDBOX_PROFILE", ""))
    require(profile_path.is_file() and not profile_path.is_symlink(), "선택한 STIZ 프로파일 경로 필요")
    expected_directory = Path.home() / "Library/MobileDevice/Provisioning Profiles"
    require(profile_path.suffix == ".mobileprovision" and profile_path.resolve().is_relative_to(expected_directory.resolve()),
            "Codemagic의 선택 프로파일 폴더만 허용합니다")
    profile = decode_profile(profile_path)
    selected = validate_profile(profile, expected_hash)
    identity_output = command(["security", "find-identity", "-v", "-p", "codesigning"], stage="identity").decode("utf-8")
    require(selected["certificate_sha1"] in re.findall(r"\b[0-9A-F]{40}\b", identity_output), "프로파일과 일치하는 keychain 서명 항목 없음")
    require("release-testing" in command(["xcodebuild", "-help"], stage="capability", both=True).decode("utf-8"), "현재 Xcode의 등록 기기 배포 방식 확인 필요")
    root = Path(__file__).resolve().parents[3]
    output = root / "apps/stiz-ios/build/sandbox-device"
    output.mkdir(parents=True, exist_ok=False)
    temporary_info = plistlib.loads((root / "apps/stiz-ios/STIZ/Info.plist").read_bytes())
    require("NSAppTransportSecurity" not in temporary_info, "원본 앱의 ATS 설정 변경 금지")
    temporary_info["CFBundleDisplayName"] = "STIZ 격리시험"
    # iOS 17 이상은 IP 주소도 명시해야 한다. HTTP·TLS·인증서 검증은 완화하지 않는다.
    temporary_info["NSAppTransportSecurity"] = SANDBOX_ATS
    info_path = output / "SandboxInfo.plist"
    info_path.write_bytes(plistlib.dumps(temporary_info))
    project = root / "apps/stiz-ios/STIZ.xcodeproj"
    archive = output / "STIZ.xcarchive"
    overrides = [f"PRODUCT_BUNDLE_IDENTIFIER={BUNDLE}", f"DEVELOPMENT_TEAM={TEAM}",
                 f"STIZ_SANDBOX_ORIGIN={ORIGIN}", "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG",
                 f"CURRENT_PROJECT_VERSION={BUILD}",
                 "CODE_SIGN_STYLE=Manual", "CODE_SIGNING_ALLOWED=YES", "CODE_SIGNING_REQUIRED=YES",
                 f"CODE_SIGN_IDENTITY={selected['certificate_sha1']}",
                 f"PROVISIONING_PROFILE_SPECIFIER={selected['uuid']}", f"INFOPLIST_FILE={info_path}"]
    base = ["xcodebuild", "-project", str(project), "-scheme", "STIZ", "-configuration", "Debug",
            "-sdk", "iphoneos", "-destination", "generic/platform=iOS"]
    settings_data = json.loads(command(base + ["-showBuildSettings", "-json"] + overrides, stage="settings"))
    targets = [row["buildSettings"] for row in settings_data if row.get("target") == "STIZ"]
    require(len(targets) == 1, "빌드 대상이 모호합니다")
    validate_settings(targets[0])
    require(Path(targets[0].get("INFOPLIST_FILE", "")).resolve() == info_path.resolve(), "생성된 시험 앱 정보 파일만 허용합니다")
    print("서명 전 STIZ 조직·앱·단일 기기·Debug 격리 설정 확인 완료", flush=True)
    command(base + ["-archivePath", str(archive), "SKIP_INSTALL=NO"] + overrides + ["archive"], stage="archive")
    verify_bundle(archive / "Products/Applications/STIZ.app", expected_hash)
    options_path = output / "ExportOptions.plist"
    options_path.write_bytes(plistlib.dumps(export_options(PROFILE_NAME, selected["certificate_sha1"])))
    export_path = output / "export"
    command(["xcodebuild", "-exportArchive", "-archivePath", str(archive), "-exportPath", str(export_path),
             "-exportOptionsPlist", str(options_path)], stage="export")
    artifacts = list(export_path.glob("*.ipa"))
    require(len(artifacts) == 1, "IPA 산출물이 모호합니다")
    verify_dir = output / "verified-payload"
    with zipfile.ZipFile(artifacts[0]) as package:
        entries = package.infolist()
        require(len(entries) < 3000 and sum(x.file_size for x in entries) < 150 * 1024 * 1024, "IPA 범위 제한 초과")
        for entry in entries:
            relative = Path(entry.filename)
            require(not relative.is_absolute() and ".." not in relative.parts and "\\" not in entry.filename,
                    "IPA 내부 경로 오류")
            require((entry.external_attr >> 16) & 0o170000 != 0o120000, "IPA 연결 파일 금지")
        package.extractall(verify_dir)
    apps = list((verify_dir / "Payload").glob("*.app"))
    require(len(apps) == 1, "IPA 앱이 모호합니다")
    info = verify_bundle(apps[0], expected_hash)
    final = output / "STIZ-sandbox.ipa"
    artifacts[0].rename(final)
    commit = command(["git", "rev-parse", "HEAD"], stage="commit", cwd=root).decode().strip()
    require(re.fullmatch(r"[0-9a-f]{40}", commit), "소스 커밋 확인 실패")
    report = {"bundleId": BUNDLE, "team": TEAM, "configuration": "Debug", "debugCondition": True,
              "sandboxOrigin": ORIGIN, "registeredDeviceCount": 1, "deviceMatch": True,
              "profileName": PROFILE_NAME, "signed": True, "version": info["CFBundleShortVersionString"],
              "build": info["CFBundleVersion"], "sourceCommit": commit,
              "artifactSha256": hashlib.sha256(final.read_bytes()).hexdigest(),
              "testflight": False, "productionDeploy": False, "installed": False}
    (output / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("서명 IPA 검증 완료: 단일 등록 기기·STIZ 식별자·격리 주소 일치. 업로드·설치 미실행", flush=True)


if __name__ == "__main__":
    try:
        require(sys.argv[1:] == ["build"], "사용법: python3 native_signed_sandbox.py build")
        build()
    except GateError as error:
        print(f"STIZ 격리 서명 검증 실패: {error}", file=sys.stderr)
        sys.exit(1)
    except Exception:
        # 원문 예외에는 기기·프로파일·환경 정보가 담길 수 있어 외부 로그에 전달하지 않는다.
        print("STIZ 격리 서명 빌드 검증 실패. 대상·프로파일·빌드 설정을 안전하게 재확인하세요.", file=sys.stderr)
        sys.exit(1)
