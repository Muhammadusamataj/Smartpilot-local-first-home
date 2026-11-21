#!/usr/bin/env python3
"""Build the Android APK (WebView client for a Tuya Local Key server).

    python build_apk.py                # -> dist/TuyaLocalKey.apk (debug)
    python build_apk.py --release      # -> dist/TuyaLocalKey.apk (your secure signing config)
    python build_apk.py --install      # also `adb install -r` on a connected device

Requires the Android SDK (ANDROID_HOME / ANDROID_SDK_ROOT) and a JDK. The Gradle
wrapper is created automatically on first run (the small wrapper jar is fetched
from the Gradle repository); pass --gradle to regenerate it with a local Gradle.

The APK is a thin client: start the EXE / Docker / HA server first, then enter
its address (for example http://192.168.1.10:8000/) in the app's top field.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ANDROID = ROOT / "android"
DIST = ROOT / "dist"
def _adb(sdk: Path) -> str:
    found = shutil.which("adb")
    if found:
        return found
    candidate = sdk / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb")
    if candidate.exists():
        return str(candidate)
    raise SystemExit("adb not found (expected in ANDROID_HOME/platform-tools).")


WRAPPER_VERSION = "8.7"
WRAPPER_JAR_URL = (
    f"https://raw.githubusercontent.com/gradle/gradle/v{WRAPPER_VERSION}.0/"
    "gradle/wrapper/gradle-wrapper.jar"
)

GRADLEW_BAT = """@rem Gradle startup script for Windows
@if "%DEBUG%"=="" @echo off
setlocal
set DIRNAME=%~dp0
if "%DIRNAME%"=="" set DIRNAME=.
set APP_HOME=%DIRNAME%
set CLASSPATH=%APP_HOME%\\gradle\\wrapper\\gradle-wrapper.jar
if defined JAVA_HOME goto findJavaFromJavaHome
set JAVA_EXE=java.exe
%JAVA_EXE% -version >NUL 2>&1
if %ERRORLEVEL% equ 0 goto execute
echo ERROR: JAVA_HOME is not set and no 'java' command was found. 1>&2
goto fail
:findJavaFromJavaHome
set JAVA_HOME=%JAVA_HOME:"=%
set JAVA_EXE=%JAVA_HOME%/bin/java.exe
if exist "%JAVA_EXE%" goto execute
echo ERROR: JAVA_HOME is set to an invalid directory: %JAVA_HOME% 1>&2
goto fail
:execute
"%JAVA_EXE%" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %*
:end
endlocal & exit /b %ERRORLEVEL%
:fail
endlocal & exit /b 1
"""

GRADLEW_SH = """#!/bin/sh
# Gradle startup script for POSIX systems
APP_HOME=$(cd "$(dirname "$0")" && pwd)
CLASSPATH="$APP_HOME/gradle/wrapper/gradle-wrapper.jar"
if [ -n "$JAVA_HOME" ]; then
  JAVA_EXE="$JAVA_HOME/bin/java"
else
  JAVA_EXE=java
fi
exec "$JAVA_EXE" $DEFAULT_JVM_OPTS $JAVA_OPTS $GRADLE_OPTS -classpath "$CLASSPATH" org.gradle.wrapper.GradleWrapperMain "$@"
"""


def _sdk_root(explicit: str | None) -> Path:
    value = explicit or os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not value:
        raise SystemExit(
            "Android SDK not found. Set ANDROID_HOME (or pass --sdk-root) to\n"
            "the SDK folder, e.g. C:\\Users\\you\\AppData\\Local\\Android\\Sdk"
        )
    path = Path(value).expanduser()
    if not path.is_dir():
        raise SystemExit(f"Android SDK folder does not exist: {path}")
    return path


def _ensure_wrapper(explicit_gradle: str | None) -> list[str]:
    wrapper = ANDROID / ("gradlew.bat" if os.name == "nt" else "gradlew")
    if explicit_gradle:
        print(f"+ {explicit_gradle} wrapper --gradle-version {WRAPPER_VERSION}")
        subprocess.check_call(
            [explicit_gradle, "wrapper", "--gradle-version", WRAPPER_VERSION], cwd=ANDROID)

    jar = ANDROID / "gradle" / "wrapper" / "gradle-wrapper.jar"
    if not jar.exists():
        jar.parent.mkdir(parents=True, exist_ok=True)
        print(f"+ download {WRAPPER_JAR_URL}")
        urllib.request.urlretrieve(WRAPPER_JAR_URL, jar)

    batch = ANDROID / "gradlew.bat"
    shell = ANDROID / "gradlew"
    if not batch.exists():
        batch.write_text(GRADLEW_BAT, encoding="utf-8", newline="\r\n")
    if not shell.exists():
        shell.write_text(GRADLEW_SH, encoding="utf-8", newline="\n")
        shell.chmod(0o755)
    return [str(wrapper)]


def _check_java() -> None:
    java_home = os.environ.get("JAVA_HOME")
    if java_home and (Path(java_home) / "bin" / ("java.exe" if os.name == "nt" else "java")).exists():
        return
    if shutil.which("java"):
        return
    raise SystemExit(
        "JDK not found. Install a JDK (Android Studio includes one) and set\n"
        "JAVA_HOME, or make sure 'java' is on PATH."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-root", default=None, help="Android SDK folder")
    parser.add_argument("--gradle", default=None, help="local gradle used to generate the wrapper")
    parser.add_argument("--release", action="store_true", help="build the release variant")
    parser.add_argument("--install", action="store_true", help="adb install after building")
    args = parser.parse_args()

    sdk = _sdk_root(args.sdk_root)
    _check_java()
    (ANDROID / "local.properties").write_text(f"sdk.dir={sdk.as_posix()}\n", encoding="utf-8")

    cmd = _ensure_wrapper(args.gradle)
    variant = "release" if args.release else "debug"
    task = "assembleRelease" if args.release else "assembleDebug"
    print(f"+ {' '.join(cmd)} {task}")
    subprocess.check_call([*cmd, task, "--no-daemon"], cwd=ANDROID)

    src = ANDROID / "app" / "build" / "outputs" / "apk" / variant / f"app-{variant}.apk"
    if not src.exists():
        raise SystemExit(f"Build finished but {src} was not found.")
    DIST.mkdir(parents=True, exist_ok=True)
    apk = DIST / "TuyaLocalKey.apk"
    shutil.copy2(src, apk)

    print(f"\nBuilt: {apk}")
    print("Enter your server address in the app, e.g. http://192.168.1.10:8000/")
    print("(Use http://10.0.2.2:8000/ when running in the Android emulator.)")
    if args.install:
        adb = _adb(sdk)
        print("+ " + adb + " install -r " + str(apk))
        subprocess.check_call([adb, "install", "-r", str(apk)], cwd=ROOT)


if __name__ == "__main__":
    main()
