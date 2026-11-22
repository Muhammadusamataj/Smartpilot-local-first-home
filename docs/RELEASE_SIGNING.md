# Release signing

Two different APKs exist. Keep their identities separate:

- **Offline APK** — `dist\SmartPilot-Local.apk`, package
  `com.example.tuyalocalkey.offline.v2.debug`, published on GitHub Releases.
  This is the app people install on their phones and upgrade in place. It is
  signed with the **pinned debug key** described below.
- **Production release APKs** — `dist\TuyaLocalKey-Offline-release.apk` and
  `dist\TuyaLocalKey-release.apk`, signed with the dedicated production key.

## Offline APK signing key — WHERE IT IS SAVED

The offline APK must keep the **same certificate** across releases, or Android
refuses to upgrade an installed copy with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.
The keystore is stored in two places:

```
tools\keys\debug.keystore                          # used by the build (gitignored)
C:\Users\abc\.smartpilot-signing\debug.keystore    # private backup OUTSIDE the repo
```

- Alias: `androiddebugkey`, store/key password: `android` (standard public debug
  password — no secret is committed).
- Certificate SHA-256:
  `bbe14afd137fa6617ade862ea53d6ab0c34ddbf23e1f582bd602651dd7adf00f`
- Certificate SHA-1:
  `AE:3D:9B:B3:56:52:21:8F:DD:32:AA:77:9F:C9:82:34:04:DF:DC:AA`

`build_offline_apk.py` calls `tools/ensure_signing_key.py` before every build.
It restores `tools/keys/debug.keystore` from the backup if missing, verifies the
fingerprint, and fails the build on any mismatch. After building it verifies the
finished APK's signer too. Neither copy is bundled in source ZIPs or Git.

> **If the PC is formatted / the repo is moved:** copy
> `C:\Users\abc\.smartpilot-signing\debug.keystore` back to
> `tools\keys\debug.keystore`. Losing both copies means a new certificate and an
> unavoidable uninstall/reinstall for every installed user.

> Upgrading an already-installed v1.11–v1.15 (old signer
> `a6cf3f81…0830ca58`) to v1.16 needs
> `python tools/install_preserving_data.py --yes`, which backs up data,
> uninstalls, installs, and restores. After v1.16, normal in-app updates work.

## Where the production release key lives

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
| `dist\SmartPilot-Local.apk` (offline, GitHub Releases) | `com.example.tuyalocalkey.offline.v2.debug` | 17 / 1.16 | `bbe14afd137fa6617ade862ea53d6ab0c34ddbf23e1f582bd602651dd7adf00f` |
| `dist\TuyaLocalKey-Offline-release.apk` | `com.example.tuyalocalkey.offline.v2` | 7 / 1.6 | `092024131e8d4f49fe557a23c3942743e131d4b5e9dfdedf46ea739e6c2aa003` |
| `dist\TuyaLocalKey-release.apk` | `com.example.tuyalocalkey` | 7 / 1.6 | `092024131e8d4f49fe557a23c3942743e131d4b5e9dfdedf46ea739e6c2aa003` |

The release packages intentionally omit the `.debug` suffix, so they can be
installed alongside the existing debug builds without touching their data.
The signer differs from the debug key (`b8614854...4bb930`), confirming no
fallback to the public debug key.
