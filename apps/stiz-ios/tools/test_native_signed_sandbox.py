"""합성 프로파일만 사용한다. 실제 인증서·기기·환경·서명 명령에 접근하지 않는다."""
import copy
from datetime import datetime, timezone, timedelta
from pathlib import Path
import unittest
from native_signed_sandbox import (
    BUNDLE, TEAM, ORIGIN, PROFILE_NAME, GateError, device_digest,
    validate_profile, validate_settings, validate_app, validate_workflows, export_options, command_failure,
)


def profile_fixture():
    return {"Name": PROFILE_NAME, "UUID": "00000000-0000-4000-8000-000000000000",
            "TeamIdentifier": [TEAM], "ApplicationIdentifierPrefix": [TEAM],
            "ExpirationDate": datetime.now(timezone.utc) + timedelta(days=1),
            "ProvisionedDevices": ["a" * 24], "DeveloperCertificates": [b"synthetic public certificate"],
            "Entitlements": {"application-identifier": f"{TEAM}.{BUNDLE}",
                             "com.apple.developer.team-identifier": TEAM, "get-task-allow": False}}


class SignedSandboxTests(unittest.TestCase):
    def test_failure_report_has_stage_and_exit_code_without_raw_values(self):
        self.assertIn("Debug 앱 빌드 실패 (xcodebuild, 종료 번호 65)", command_failure("archive", "xcodebuild", 65))
        self.assertIn("Ad Hoc IPA 내보내기", command_failure("export", "xcodebuild", 70))
        # 임의 단계·실행 파일·종료 번호에도 합성 기기/해시/이메일을 로그에 전달하지 않는다.
        for private in ["a" * 24, "b" * 40, "c" * 64, "synthetic@example.invalid", "apikey=synthetic-secret"]:
            result = command_failure(private, private, private)
            self.assertNotIn(private, result)
            self.assertLess(len(result), 160)
            self.assertIn("알 수 없는 검증 단계", result)

    def test_normalized_private_device_comparison(self):
        expected = device_digest("a" * 24)
        self.assertEqual(device_digest("a" * 8 + "-" + "a" * 16), expected)
        self.assertEqual(device_digest("A" * 8 + "_" + "A" * 16), expected)
        result = validate_profile(profile_fixture(), expected)
        self.assertNotIn("a" * 24, str(result))
        self.assertEqual(len(result["certificate_sha1"]), 40)

    def test_wrong_device_and_profile_scope_are_rejected(self):
        expected = device_digest("a" * 24)
        mutations = [
            lambda p: p.update(TeamIdentifier=["OTHER_TEAM"]),
            lambda p: p.update(Name="other app profile"),
            lambda p: p.update(ProvisionedDevices=["b" * 24]),
            lambda p: p.update(ProvisionedDevices=["a" * 24, "b" * 24]),
            lambda p: p.update(ProvisionsAllDevices=True),
            lambda p: p.update(DeveloperCertificates=[]),
            lambda p: p.update(ExpirationDate=datetime.now(timezone.utc)),
            lambda p: p["Entitlements"].update({"get-task-allow": True}),
            lambda p: p["Entitlements"].update({"application-identifier": f"{TEAM}.*"}),
            lambda p: p["Entitlements"].update({"beta-reports-active": True}),
            lambda p: p.update(UUID="-" * 36),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                profile = profile_fixture()
                mutation(profile)
                with self.assertRaises(GateError):
                    validate_profile(profile, expected)

    def test_missing_device_confirmation_never_passes(self):
        for value in ["", "TRUE", "0" * 63, "a" * 24]:
            with self.assertRaises(GateError):
                validate_profile(profile_fixture(), value)

    def test_debug_device_settings_required(self):
        good = {"CONFIGURATION": "Debug", "PRODUCT_BUNDLE_IDENTIFIER": BUNDLE,
                "DEVELOPMENT_TEAM": TEAM, "STIZ_SANDBOX_ORIGIN": ORIGIN,
                "CODE_SIGNING_ALLOWED": "YES", "CODE_SIGN_STYLE": "Manual",
                "SWIFT_ACTIVE_COMPILATION_CONDITIONS": "DEBUG", "SDK_NAME": "iphoneos26.5"}
        validate_settings(good)
        for key, bad in [("CONFIGURATION", "Release"), ("STIZ_SANDBOX_ORIGIN", "https://www.stiz-dasan.kr"),
                         ("SWIFT_ACTIVE_COMPILATION_CONDITIONS", ""), ("SDK_NAME", "iphonesimulator26.5"),
                         ("PRODUCT_BUNDLE_IDENTIFIER", "kr.stiz.bdr.bdrStatV3")]:
            changed = dict(good, **{key: bad})
            with self.assertRaises(GateError):
                validate_settings(changed)

    def test_export_is_local_registered_device_distribution(self):
        options = export_options(PROFILE_NAME, "B" * 40)
        self.assertEqual(options["method"], "release-testing")
        self.assertEqual(options["destination"], "export")
        self.assertFalse(options["uploadSymbols"])
        self.assertEqual(options["provisioningProfiles"], {BUNDLE: PROFILE_NAME})
        self.assertNotIn("testFlightInternalTestingOnly", options)

    def test_final_app_origin_and_entitlements_checked(self):
        info = {"CFBundleIdentifier": BUNDLE, "STIZSandboxOrigin": ORIGIN,
                "STIZNativeAuthDevelopmentEnabled": False, "CFBundleDisplayName": "STIZ 격리시험",
                "CFBundleSupportedPlatforms": ["iPhoneOS"]}
        entitlements = copy.deepcopy(profile_fixture()["Entitlements"])
        validate_app(info, entitlements)
        for key, bad in [("STIZSandboxOrigin", ""), ("CFBundleIdentifier", "other"),
                         ("STIZNativeAuthDevelopmentEnabled", True), ("NSAppTransportSecurity", {}),
                         ("CFBundleSupportedPlatforms", ["iPhoneSimulator"])]:
            with self.assertRaises(GateError):
                validate_app(dict(info, **{key: bad}), entitlements)
        with self.assertRaises(GateError):
            validate_app(info, dict(entitlements, **{"get-task-allow": True}))

    def test_actual_workflow_and_unsafe_mutations(self):
        workflow = (Path(__file__).resolve().parents[3] / "codemagic.yaml").read_text(encoding="utf-8")
        validate_workflows(workflow)
        for invalid in [
            workflow.replace("events: []", "events: [push]", 1),
            workflow.replace("CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_ALLOWED=YES"),
            workflow.replace(ORIGIN, "https://www.stiz-dasan.kr"),
            workflow.replace("native_signed_sandbox.py build", "another_script.py build"),
            workflow.replace("native_signed_sandbox.py build", "native_signed_sandbox.py build\n          xcrun altool --upload-app --file unapproved.ipa"),
            workflow.replace("CODE_SIGNING_ALLOWED=NO build", "CODE_SIGNING_ALLOWED=NO build\n          arbitrary-command"),
            workflow.replace("stiz-dasan-adhoc-sandbox-2026", "other-profile"),
            workflow + "      - signing-key.p12\n",
            workflow + "  another-workflow:\n    triggering:\n      events: []\n",
            workflow.replace("    artifacts:", "    publishing:\n      app_store_connect: enabled\n    artifacts:", 1),
        ]:
            with self.subTest(invalid=invalid[:25]):
                with self.assertRaises(GateError):
                    validate_workflows(invalid)


if __name__ == "__main__":
    unittest.main()
