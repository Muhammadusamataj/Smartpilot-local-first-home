# Release signing

Release APKs are signed with a dedicated production key, **never** with the
project debug key (`tools/keys/debug.keystore`, public password `android`).

## Where the release key lives

The release keystore and its credentials are stored **outside this repository**,
in a directory readable only by the current Windows user:

```
C:\Users\abc\.tuya-local-key-release\
├── tuyalocalkey-release.jks   # production keystore (RSA 2048, 10,000 days)
└── credentials.txt            # store/key passwords + alias (KEEP SECRET)
```

`credentials.txt` is deliberately **not** in the repo and `.gitignore` has no
exception for it. Never paste these values into source, CI logs, or chat.

## Backup — important

The keystore and `credentials.txt` must be backed up together in a password
manager or offline storage. If they are lost, future release updates cannot be
signed with the same identity and users would have to uninstall/reinstall.

## Building a release build

Load the four variables from the saved credentials into your shell, then build:

```powershell
$cred = "C:\Users\abc\.tuya-local-key-release\credentials.txt"
Get-Content $cred | Where-Object { $_ -match '^RELEASE_' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  [Environment]::SetEnvironmentVariable($k, $v, "Process")
}
$env:ANDROID_HOME = "C:\Users\abc\AppData\Local\Android\Sdk"
cd android_offline; .\gradlew.bat assembleRelease
cd ..\android;      .\gradlew.bat assembleRelease
```

`checkReleaseSigning` fails the build if `RELEASE_STORE_FILE` is missing, so an
unintentional debug-signed release cannot be produced.

## Verified release identity (2026-11-20)

| Artifact | Package | Version | Signer SHA-256 |
|---|---|---|---|
| `dist\TuyaLocalKey-Offline-release.apk` | `com.example.tuyalocalkey.offline.v2` | 7 / 1.6 | `092024131e8d4f49fe557a23c3942743e131d4b5e9dfdedf46ea739e6c2aa003` |
| `dist\TuyaLocalKey-release.apk` | `com.example.tuyalocalkey` | 7 / 1.6 | `092024131e8d4f49fe557a23c3942743e131d4b5e9dfdedf46ea739e6c2aa003` |

The release packages intentionally omit the `.debug` suffix, so they can be
installed alongside the existing debug builds without touching their data.
The signer differs from the debug key (`b8614854...4bb930`), confirming no
fallback to the public debug key.
