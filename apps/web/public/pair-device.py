#!/usr/bin/env python3
"""Cardigan device pairing (C-705).

Run on a new device, standard library only:

    curl -fsS https://<workbench>/pair-device.py | python3 - https://<workbench>

It reports this device's hostname, system, CPU architecture, tailnet address
and a free numeric account id to the Workbench, then shows a one-time pairing
code and a QR code of the confirmation link. The code is valid for ten
minutes and works once; the owner confirms it in the Workbench, which only
opens a draft of the add-worker wizard. Nothing here needs sudo or changes
this device.
"""

import argparse
import grp
import json
import platform
import pwd
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

FIRST_FREE_ID = 2000
POLL_SECONDS = 3


def fail(message, code=2):
    print(message, file=sys.stderr)
    sys.exit(code)


def origin_of(url):
    parsed = urllib.parse.urlsplit(url.strip())
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
    ):
        fail("用法：python3 pair-device.py https://<Workbench 地址>")
    return "%s://%s" % (parsed.scheme, parsed.netloc)


def tailnet_address(tailscale):
    path = shutil.which(tailscale)
    if path is None:
        fail(
            "未找到 tailscale。请先在本机安装 Tailscale 并登录你的 tailnet，"
            "再重新运行；也可以用 --address 指定 Workbench 主机能连到的地址。"
        )
    try:
        out = subprocess.run(
            [path, "status", "--json"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=15,
        ).stdout
        status = json.loads(out.decode("utf-8"))
    except (OSError, subprocess.SubprocessError, ValueError):
        fail("tailscale status 读取失败。请确认 Tailscale 正在运行并已登录。")
    if status.get("BackendState") != "Running":
        fail(
            "Tailscale 未连上 tailnet（当前状态：%s）。请先运行 tailscale up 登录。"
            % status.get("BackendState", "未知")
        )
    me = status.get("Self") or {}
    name = (me.get("DNSName") or "").rstrip(".")
    if name:
        return name
    ips = me.get("TailscaleIPs") or []
    if ips:
        return ips[0]
    fail("没有读到本机的 tailnet 地址。请用 --address 指定。")


def free_id():
    for candidate in range(FIRST_FREE_ID, FIRST_FREE_ID + 10000):
        try:
            pwd.getpwuid(candidate)
            continue
        except KeyError:
            pass
        try:
            grp.getgrgid(candidate)
            continue
        except KeyError:
            return candidate
    fail("找不到空闲的数字账号编号。")


def system_name():
    if sys.platform == "darwin":
        version = platform.mac_ver()[0]
        return ("macOS %s" % version).strip()
    try:
        with open("/etc/os-release", encoding="utf-8") as f:
            for line in f:
                if line.startswith("PRETTY_NAME="):
                    value = line.split("=", 1)[1].strip().strip('"')
                    if value and len(value) <= 80 and value.isprintable():
                        return value
    except OSError:
        pass
    return None


def device_facts(address):
    if sys.platform.startswith("linux"):
        os_name = "linux"
    elif sys.platform == "darwin":
        os_name = "darwin"
    else:
        fail("暂只支持 Linux 和 macOS。")
    machine = platform.machine().lower()
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(
        machine
    )
    if arch is None:
        fail("暂不支持这种 CPU 架构：%s" % machine)
    host = re.sub(r"[^A-Za-z0-9-]", "-", socket.gethostname().split(".")[0])
    host = host.strip("-")[:63] or "device"
    facts = {
        "hostname": host,
        "os": os_name,
        "arch": arch,
        "address": address,
        "free_id": free_id(),
    }
    system = system_name()
    if system:
        facts["system"] = system
    return facts


def post(origin, path, body):
    request = urllib.request.Request(
        origin + path,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Origin": origin},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read().decode("utf-8"))["error"]
            message = "%s（%s）" % (detail.get("message"), detail.get("code"))
        except (ValueError, KeyError, TypeError, AttributeError):
            message = "HTTP %s" % error.code
        fail("Workbench 拒绝了请求：%s" % message)
    except (urllib.error.URLError, OSError) as error:
        fail("连不上 Workbench：%s" % getattr(error, "reason", error))


def main(argv):
    parser = argparse.ArgumentParser(description="把这台设备配对到 Cardigan Workbench")
    parser.add_argument("workbench", help="Workbench 地址，例如 https://host.example.ts.net")
    parser.add_argument("--address", help="Workbench 主机连到本机用的地址（默认读 tailscale）")
    parser.add_argument("--tailscale", default="tailscale", help=argparse.SUPPRESS)
    parser.add_argument(
        "--light", action="store_true", help="浅色背景终端：反转二维码颜色"
    )
    parser.add_argument(
        "--no-wait", action="store_true", help="显示配对码后立即退出，不等待确认"
    )
    args = parser.parse_args(argv)
    origin = origin_of(args.workbench)
    address = args.address or tailnet_address(args.tailscale)
    facts = device_facts(address)
    pairing = post(origin, "/api/device-pairings", {"device": facts})
    invert = str.maketrans({"█": " ", " ": "█", "▀": "▄", "▄": "▀"})
    for row in pairing.get("qr") or []:
        print(row.translate(invert) if args.light else row)
    print()
    print("配对码：%s" % pairing["code"])
    print("确认页：%s" % pairing["confirm_url"])
    print("有效期至：%s（一次有效）" % pairing["expires_at"])
    print(
        "设备：%s · %s/%s · %s · 账号编号 %s"
        % (facts["hostname"], facts["os"], facts["arch"], facts["address"], facts["free_id"])
    )
    sys.stdout.flush()
    if args.no_wait:
        return 0
    token = pairing["device_token"]
    print("等待在 Workbench 确认……（Ctrl-C 退出，配对码到期自动作废）")
    sys.stdout.flush()
    try:
        while True:
            time.sleep(POLL_SECONDS)
            state = post(origin, "/api/device-pairings/status", {"device_token": token})
            if state.get("status") == "claimed":
                print("已在 Workbench 确认。请回到 Workbench 的“添加 worker”向导继续预览和确认。")
                return 0
            if state.get("status") == "expired":
                print("配对码已过期，请重新运行本命令。", file=sys.stderr)
                return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
