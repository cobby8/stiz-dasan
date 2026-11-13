# 아이폰 앱 알림(FCM) 설정 파일 자리

Firebase 콘솔에서 받은 `GoogleService-Info.plist` 를 **빌드 직전에** 이 폴더에 넣는다(저장소에는 넣지 않는다 — `.gitignore`).

- 이 폴더는 Xcode 에 «폴더 참조»로 연결돼 있어, 안의 파일이 그대로 앱의 `Firebase/` 폴더로 복사된다.
- 파일이 없으면 빌드는 그대로 되고 앱 알림만 꺼진다(웹에는 «알림은 문자·카카오톡으로 보내드려요»).
- Codemagic 에 넣는 방법: `docs/native-push.md` «아이폰 설정 파일 주입».
