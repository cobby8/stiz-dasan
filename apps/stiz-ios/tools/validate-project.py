"""Windows에서도 실행 가능한 구성 검사. Xcode 컴파일/기기 검사를 대신하지 않는다."""
from pathlib import Path
import json
import plistlib
import re
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
project = (root / "STIZ.xcodeproj/project.pbxproj").read_text(encoding="utf-8")
defined = re.findall(r"^\s*(A[0-9A-F]{23}) =", project, re.M)
references = set(re.findall(r"\bA[0-9A-F]{23}\b", project))
assert len(defined) == len(set(defined)), "프로젝트 ID 중복"
assert references == set(defined), "프로젝트 파일 참조 누락"
for file in ["AppDelegate.swift", "NavigationPolicy.swift", "WebViewController.swift", "Info.plist", "Assets.xcassets"]:
    assert (root / "STIZ" / file).exists(), file
    assert f"path = {file};" in project, file
for path in (root / "STIZ").rglob("*.json"):
    json.loads(path.read_text(encoding="utf-8"))
with (root / "STIZ/Info.plist").open("rb") as handle:
    info = plistlib.load(handle)
assert not any("Location" in key for key in info), "iOS 위치 권한은 이 그룹 범위 아님"
assert "NSAppTransportSecurity" not in info, "HTTP/TLS 예외 금지"
assert "UIInterfaceOrientationLandscapeLeft" in info["UISupportedInterfaceOrientations"]
scheme = ET.parse(root / "STIZ.xcodeproj/xcshareddata/xcschemes/STIZ.xcscheme")
assert all(ref.attrib["BlueprintIdentifier"] in references for ref in scheme.iter("BuildableReference"))
assert "kr.stiz.academy.dev" in project and "DEVELOPMENT_TEAM" not in project
workflow = (root.parents[1] / "codemagic.yaml").read_text(encoding="utf-8")
assert "events: []" in workflow and "CODE_SIGNING_ALLOWED=NO" in workflow
assert "publishing:" not in workflow and "app_store_connect:" not in workflow
assert "bdr-asc-key" not in workflow and "mac_mini_m2" in workflow
print(f"STIZ iOS 구성 검사 통과: 프로젝트 참조 {len(defined)}개, plist·scheme·색상·수동 무서명 구성 (실제 빌드 미실행)")
