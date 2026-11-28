#!/usr/bin/env python3
"""Cardigan device pairing (C-705).

Run on a new device, standard library only:

    curl -fsS https://<workbench>/pair-device.py | python3 - https://<workbench>

It reports this device's hostname, system, CPU architecture, tailnet address
and a free numeric account id to the Workbench (C-707: plus CPU, memory, disk
and GPU for the onboarding report), then shows a one-time pairing
code and a QR code of the confirmation link. The code is valid for ten
minutes and works once; the owner confirms it in the Workbench, which only
opens a draft of the add-worker wizard. Pairing itself needs no sudo and
changes nothing on this device.

C-706: after the owner confirms the draft's configuration, this fetches the
one-time initialisation script generated for it, lists what the script will
do, asks for "yes" and only then runs it with `sudo python3 -IB -` from
standard input, so the script is never written to disk. The result is
reported to the Workbench, which starts the wizard's recheck. `--no-init`
stops after the code is confirmed, as before.

C-709: it also prints this device's SSH host key as the control host's
worker-known-hosts line, hints when no SSH server listens or the device runs
on battery, and authenticates sudo before running the script.
"""

import argparse
import grp
import json
import os
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


def run_text(command, timeout=10):
    """A command's output, or None when it is missing or fails."""
    try:
        out = subprocess.run(
            command,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
        ).stdout
        return out.decode("utf-8", "replace").strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def printable(value, limit):
    if not value:
        return None
    value = re.sub(r"\s+", " ", value).strip()[:limit].strip()
    return value if value and value.isprintable() else None


def cpu_model():
    if sys.platform == "darwin":
        return printable(run_text(["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"]), 120)
    try:
        with open("/proc/cpuinfo", encoding="utf-8", errors="replace") as f:
            for line in f:
                key, _, value = line.partition(":")
                if key.strip() in ("model name", "Hardware", "Model"):
                    return printable(value, 120)
    except OSError:
        pass
    return None


def memory_bytes():
    if sys.platform == "darwin":
        value = run_text(["/usr/sbin/sysctl", "-n", "hw.memsize"])
        return int(value) if value and value.isdigit() else None
    try:
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return None


def gpu_names():
    if sys.platform == "darwin":
        out = run_text(["/usr/sbin/system_profiler", "SPDisplaysDataType", "-json"], 20)
        try:
            names = [d.get("sppci_model") for d in json.loads(out or "{}").get("SPDisplaysDataType", [])]
        except (ValueError, AttributeError):
            names = []
    else:
        out = run_text(["lspci"]) or ""
        names = [
            line.split(": ", 1)[1]
            for line in out.splitlines()
            if ": " in line and re.search(r"VGA|3D|Display", line.split(": ", 1)[0])
        ]
    return printable("; ".join(n for n in names if n), 160)


def hardware_facts(os_name, root_readonly):
    """C-707: for the Workbench's onboarding report only; best effort, so
    nothing here can stop the pairing."""
    try:
        return collect_hardware(os_name, root_readonly)
    except Exception:
        return {}


def collect_hardware(os_name, root_readonly):
    facts = {}
    cpu = cpu_model()
    if cpu:
        facts["cpu"] = cpu
    cores = os.cpu_count()
    if cores and 0 < cores <= 4096:
        facts["cpu_cores"] = cores
    memory = memory_bytes()
    if memory and memory > 0:
        facts["memory_bytes"] = memory
    # The volume the worker's work root goes on.
    disk = "/Users" if os_name == "darwin" else ("/home" if root_readonly else "/")
    try:
        usage = shutil.disk_usage(disk)
        if usage.total > 0:
            facts.update(disk_path=disk, disk_total_bytes=usage.total, disk_free_bytes=min(usage.free, usage.total))
    except OSError:
        pass
    gpu = gpu_names()
    if gpu:
        facts["gpu"] = gpu
    return facts


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
    try:
        # SteamOS and similar systems mount / read-only; the work root then
        # goes under /home.
        if os_name == "linux" and os.statvfs("/").f_flag & os.ST_RDONLY:
            facts["root_readonly"] = True
    except OSError:
        pass
    facts.update(hardware_facts(os_name, facts.get("root_readonly", False)))
    return facts


def readiness_hints(facts):
    """C-709: things a new worker commonly lacks (SteamOS ships with sshd off);
    printed as hints only, never stop the pairing."""
    hints = []
    try:
        with socket.create_connection(("127.0.0.1", 22), timeout=2):
            pass
    except OSError:
        hints.append(
            "本机 22 端口没有 SSH 服务，控制主机要经 SSH 连接这台设备。"
            "SteamOS 等默认关闭 sshd 的系统可运行：sudo systemctl enable --now sshd"
        )
    if facts["os"] == "linux":
        mains = []
        try:
            for name in os.listdir("/sys/class/power_supply"):
                base = os.path.join("/sys/class/power_supply", name)
                with open(os.path.join(base, "type"), encoding="utf-8") as f:
                    if f.read().strip() != "Mains":
                        continue
                with open(os.path.join(base, "online"), encoding="utf-8") as f:
                    mains.append(f.read().strip() == "1")
        except (OSError, ValueError):
            mains = []
        if mains and not any(mains):
            hints.append("本机正在用电池供电。作为 worker 请接上电源，并关闭自动休眠。")
    return hints


def known_hosts_line(facts, path):
    """C-709: the control host checks this device's SSH host key against its
    private worker-known-hosts under the wizard's machine id (the lowercased
    hostname, as the Workbench derives it). Show the public line here, on the
    device's own console, so the owner can copy and check it."""
    try:
        with open(path, encoding="utf-8") as f:
            parts = f.read().split()
    except (OSError, UnicodeDecodeError):
        return None
    if len(parts) < 2 or parts[0] != "ssh-ed25519" or not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", parts[1]):
        return None
    machine = facts["hostname"].lower()
    return "%s ssh-ed25519 %s" % ("device-local" if machine == "local" else machine, parts[1])


class Rejected(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def request(origin, path, body):
    """POST JSON; a Workbench error becomes `Rejected`, no connection exits."""
    req = urllib.request.Request(
        origin + path,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Origin": origin},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read().decode("utf-8"))["error"]
            raise Rejected(error.code, detail.get("code"), "%s（%s）" % (detail.get("message"), detail.get("code")))
        except (ValueError, KeyError, TypeError, AttributeError):
            raise Rejected(error.code, None, "HTTP %s" % error.code)
    except (urllib.error.URLError, OSError) as error:
        fail("连不上 Workbench：%s" % getattr(error, "reason", error))


def post(origin, path, body):
    try:
        return request(origin, path, body)
    except Rejected as error:
        fail("Workbench 拒绝了请求：%s" % error.message)


def ask(prompt):
    """A line typed on the terminal, or None without one.

    C-839: a terminal is not seekable, so a text-mode "r+" open of /dev/tty
    fails (io.UnsupportedOperation) and was read as "no terminal"; reading
    and writing use separate one-way opens instead."""
    try:
        with open("/dev/tty", "w", encoding="utf-8") as out, open("/dev/tty", encoding="utf-8") as tty:
            out.write(prompt)
            out.flush()
            return tty.readline().strip().lower()
    except OSError:
        return None


def confirm():
    answer = ask("确认在本机用 sudo 执行以上操作？输入 yes 继续：")
    if answer is None:
        print("没有可用的终端来确认；核对上面的清单后可加 --yes 重新配对。", file=sys.stderr)
    return answer == "yes"


def sudo_ready(args):
    """C-709: authenticate sudo before running the script, so a missing
    password (SteamOS's deck account has none by default) is not reported to
    the Workbench as a failed initialisation. The device token stays valid,
    so the owner can set one and retry here without pairing again."""
    while True:
        try:
            ok = subprocess.run([args.sudo, "-v"], stdin=subprocess.DEVNULL).returncode == 0
        except OSError:
            ok = False
        if ok:
            return True
        print(
            "sudo 验证没有通过，本机未做改动。请确认当前账号能用 sudo；"
            "SteamOS 的 deck 账号默认没有密码，先在另一个终端运行 passwd 设置。",
            file=sys.stderr,
        )
        if args.yes or ask("设置好后按回车重试，输入 q 放弃：") in (None, "q"):
            print("已放弃，本机未做改动；稍后重新运行本命令。", file=sys.stderr)
            return False


def initialise(origin, token, args):
    """C-706: fetch, show, confirm, run with sudo from stdin, report."""
    print("请在 Workbench 向导里核对并确认写入配置；确认后本机继续初始化……")
    sys.stdout.flush()
    shown = None
    script = None
    while script is None:
        try:
            state = request(origin, "/api/device-pairings/status", {"device_token": token})
        except Rejected:
            print("配对已失效，请重新运行本命令。", file=sys.stderr)
            return 1
        init = state.get("init")
        if init == "succeeded":
            print("本机已完成初始化。")
            return 0
        if init == "unavailable":
            print("向导草稿已取消或过期，请重新运行本命令。", file=sys.stderr)
            return 1
        if init == "ready":
            try:
                script = request(origin, "/api/device-pairings/init-script", {"device_token": token})["script"]
                break
            except Rejected as error:
                if error.status == 410:
                    print("向导草稿已取消或过期，请重新运行本命令。", file=sys.stderr)
                    return 1
                if error.message != shown:
                    print("暂时取不到初始化脚本：%s" % error.message, file=sys.stderr)
                    shown = error.message
        time.sleep(POLL_SECONDS)
    data = script.encode("utf-8")
    python = args.python or ("/usr/bin/python3" if os.path.exists("/usr/bin/python3") else sys.executable)
    listing = subprocess.run([python, "-IB", "-", "--list"], input=data, stdout=subprocess.PIPE)
    if listing.returncode != 0:
        print("初始化脚本无法读取，请重新运行本命令。", file=sys.stderr)
        return 1
    print("初始化脚本将在本机做以下操作（已有账号或文件冲突时停下，不做改动）：")
    print(listing.stdout.decode("utf-8", "replace").rstrip())
    sys.stdout.flush()
    if not args.yes and not confirm():
        print("已取消，本机未做改动。", file=sys.stderr)
        return 1
    if not sudo_ready(args):
        return 1
    result = subprocess.run([args.sudo, python, "-IB", "-"], input=data)
    ok = result.returncode == 0
    try:
        reply = request(origin, "/api/device-pairings/initialized", {"device_token": token, "ok": ok})
    except Rejected as error:
        print("未能通知 Workbench：%s。请在向导里点“继续检查”。" % error.message, file=sys.stderr)
        return 0 if ok else 1
    if not ok:
        print("初始化未完成（退出码 %d），已告知 Workbench。按上面的提示处理后重新配对。" % result.returncode, file=sys.stderr)
        return 1
    if reply.get("recheck") == "started":
        print("初始化完成，已通知 Workbench 开始复查。")
    else:
        print("初始化完成，已通知 Workbench。请在向导里点“继续检查”。")
    return 0


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
    parser.add_argument(
        "--no-init", action="store_true", help="确认配对后退出，不做本机初始化"
    )
    parser.add_argument(
        "--yes", action="store_true", help="列出初始化操作后不再询问，直接用 sudo 运行"
    )
    parser.add_argument("--sudo", default="sudo", help=argparse.SUPPRESS)
    parser.add_argument("--host-key", default="/etc/ssh/ssh_host_ed25519_key.pub", help=argparse.SUPPRESS)
    parser.add_argument("--python", help=argparse.SUPPRESS)
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
    line = known_hosts_line(facts, args.host_key)
    if line:
        print("控制主机 worker-known-hosts 需要的一行（在向导里改了机器编号时，把开头换成新编号）：")
        print("  %s" % line)
    for hint in readiness_hints(facts):
        print("提示：%s" % hint)
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
                print("已在 Workbench 确认。")
                if args.no_init or "init" not in state:
                    print("请回到 Workbench 的“添加 worker”向导继续预览和确认。")
                    return 0
                return initialise(origin, token, args)
            if state.get("status") == "expired":
                print("配对码已过期，请重新运行本命令。", file=sys.stderr)
                return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
