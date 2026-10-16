#!/usr/bin/env python3
"""Real Jellyfin 10.11 + real jellyfin-web in Chromium 38 / modern Chromium: does Jellyfin Enhanced initialize
with Es5CompatibilityMode OFF vs ON? Reuses tests/host/run.py helpers. Needs JE_CHROME38 and JE_CHROME38_LIBS."""
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("host_run", ROOT / "tests/host/run.py")
hr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hr)
DRIVER = ROOT / "tests/es5/c38-driver.mjs"


def drive(mode, host, password):
    result = subprocess.run(["node", str(DRIVER)], input=json.dumps({"mode": mode, "url": host.url, "user": "regression-admin", "password": password, "timeout": 40000}),
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=ROOT, timeout=400)
    try:
        return json.loads(result.stdout.strip().splitlines()[-1])
    except Exception:
        return {"driverError": result.stdout[-2000:]}


def summarize(label, r):
    print(f"\n=== {label} ===")
    print(json.dumps(r, indent=2))
    st = r.get("state") or {}
    return {"web": bool(st.get("home") or st.get("header")) and not st.get("loginForm"), "init": st.get("initialized") is True,
            "es5tag": str((st.get("scriptTag") or {}).get("version") or "").endswith("-es5"),
            "es5body": str(r.get("scriptHead", "")).startswith("/* Jellyfin Enhanced ES5 compatibility layer"),
            "errors": len(st.get("errors") or []) + len(r.get("pageErrors") or [])}


def main():
    for var in ("JE_CHROME38", "JE_CHROME38_LIBS"):
        if not os.environ.get(var):
            sys.exit(f"{var} is required")
    name = "je-regression-" + uuid.uuid4().hex[:12]
    ok = False
    with tempfile.TemporaryDirectory(prefix=name) as temporary:
        temp = pathlib.Path(temporary)
        temp.chmod(0o755)
        try:
            image = hr.pull(hr.IMAGES["jf10"])
            build = subprocess.run(["dotnet", "build", str(ROOT / "Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj"), "-c", "Release",
                                    "-p:JellyfinTarget=jf10", "-p:JeEs5Build=true", "--artifacts-path", str(temp / "build")], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            assert build.returncode == 0, "Build failed:\n" + build.stdout[-3000:]
            dll = list((temp / "build/bin").rglob("Jellyfin.Plugin.JellyfinEnhanced.dll"))
            assert len(dll) == 1, dll
            plugin = temp / "config/plugins/JellyfinEnhanced"
            plugin.mkdir(parents=True)
            shutil.copyfile(dll[0], plugin / dll[0].name)
            (temp / "cache").mkdir()
            hr.create_network(name)
            hr.command("docker", "run", "-d", "--name", name, "--label", f"{hr.LABEL}={name}", "--network", name, "--user", f"{os.getuid()}:{os.getgid()}",
                       "--volume", f"{temp / 'cache'}:/cache", "--volume", f"{temp / 'config'}:/config", "--env", "JELLYFIN_PublishedServerUrl=http://localhost", image)
            address = json.loads(hr.command("docker", "inspect", name))[0]["NetworkSettings"]["Networks"][name]["IPAddress"]
            host = hr.Host(f"http://{address}:8096")
            host.ready()
            password = "Regression-only-" + uuid.uuid4().hex
            host.request("/Startup/Configuration", "POST", {"UICulture": "en-US", "MetadataCountryCode": "US", "PreferredMetadataLanguage": "en"}, expected=204)
            host.request("/Startup/User")
            host.request("/Startup/User", "POST", {"Name": "regression-admin", "Password": password}, expected=204)
            host.request("/Startup/RemoteAccess", "POST", {"EnableRemoteAccess": False, "EnableAutomaticPortMapping": False}, expected=204)
            host.request("/Startup/Complete", "POST", expected=204)
            token = host.request("/Users/AuthenticateByName", "POST", {"Username": "regression-admin", "Pw": password})["AccessToken"]
            route = f"/Plugins/{hr.PLUGIN_ID}/Configuration"

            def set_es5(value):
                cfg = host.request(route, token=token)
                key = next(k for k in cfg if k.lower() == "es5compatibilitymode")
                cfg[key] = value
                host.request(route, "POST", cfg, token, expected=204)
                assert host.request(route, token=token)[key] is value

            set_es5(False)
            r1 = summarize("1. Chromium 38, Es5CompatibilityMode OFF", drive("c38", host, password))
            set_es5(True)
            r2 = summarize("2. Chromium 38, Es5CompatibilityMode ON", drive("c38", host, password))
            r3 = summarize("3. Modern Chromium, Es5CompatibilityMode ON", drive("modern", host, password))
            set_es5(False)
            r4 = summarize("4. Chromium 38, Es5CompatibilityMode OFF again", drive("c38", host, password))
            c1 = r1["web"] and not r1["init"] and not r1["es5tag"]
            c2 = r2["web"] and r2["init"] and r2["es5tag"] and r2["es5body"] and r2["errors"] == 0
            c3 = r3["init"]
            c4 = r4["web"] and not r4["init"] and not r4["es5tag"]
            print("\nSUMMARY", json.dumps({"1 OFF fails as expected": c1, "2 ON works in c38": c2, "3 ON works in modern": c3, "4 OFF fails again": c4}))
            ok = c1 and c2 and c3
        finally:
            for removal in (("docker", "rm", "-f", name), ("docker", "network", "rm", name)):
                try:
                    hr.owned(*removal)
                except Exception as error:
                    print("cleanup error:", error)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
