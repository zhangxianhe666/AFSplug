#!/usr/bin/env python3
"""
refresh_glm_token.py — 自动从 Chrome 提取 chatglm_refresh_token 并更新到 Chat2API

流程：
  1. 读取 Chrome 的 Cookies 数据库，提取 chatglm.cn 域下的 chatglm_refresh_token
  2. 如果没找到，自动打开浏览器让用户登录（可选 -o/--open）
  3. 解密 ~/.chat2api/data.json：16字节 IV + ':' + AES-256-CBC 密文
  4. 找到所有 GLM 账户，更新 refresh_token 凭证
  5. 重新加密并写回 data.json

前置依赖（按需安装其中一组即可）：
  方案 A（推荐，功能完整）：
    pip3 install browser-cookie3 pycryptodome
  方案 B（轻量，仅需加密库）：
    pip3 install pycryptodome
    （此时需手动传入 token：python3 refresh_glm_token.py --token YOUR_TOKEN）
  方案 C（最小依赖，使用 cryptography 代替 pycryptodome）：
    pip3 install cryptography
    （此时需手动传入 token，或安装 browser-cookie3 自动提取）

用法：
  python3 refresh_glm_token.py                  # 提取 token 并更新
  python3 refresh_glm_token.py --token TOKEN    # 手动指定 token
  python3 refresh_glm_token.py --print          # 仅打印 token，不修改文件
  python3 refresh_glm_token.py --open           # 若未登录，自动打开智谱清言网页
  python3 refresh_glm_token.py --dry-run        # 干跑，显示将要更新的内容
  python3 refresh_glm_token.py --check-deps     # 仅检查依赖，不执行
"""

import os
import sys
import json
import argparse
import subprocess
import platform
import shutil
import time
from typing import Optional, Dict

ENCRYPTION_KEY = "chat2api-fixed-encryption-key-v1"
DATA_FILE = os.path.expanduser("~/.chat2api/data.json")
GLM_DOMAIN = "chatglm.cn"
TOKEN_KEY = "chatglm_refresh_token"
GLM_LOGIN_URL = "https://chatglm.cn"

# ── Platform-specific Chrome cookie paths ──────────────────────


def _chrome_cookie_paths() -> list:
    system = platform.system()
    home = os.path.expanduser("~")
    paths = []

    if system == "Darwin":  # macOS
        paths = [
            os.path.join(home, "Library/Application Support/Google/Chrome/Default/Cookies"),
            os.path.join(home, "Library/Application Support/Google/Chrome/Profile */Cookies"),
            os.path.join(home, "Library/Application Support/Chromium/Default/Cookies"),
        ]
    elif system == "Windows":
        localappdata = os.environ.get("LOCALAPPDATA", os.path.join(home, "AppData/Local"))
        paths = [
            os.path.join(localappdata, "Google/Chrome/User Data/Default/Cookies"),
            os.path.join(localappdata, "Google/Chrome/User Data/Default/Network/Cookies"),
        ]
    elif system == "Linux":
        paths = [
            os.path.join(home, ".config/google-chrome/Default/Cookies"),
            os.path.join(home, ".config/chromium/Default/Cookies"),
            os.path.join(home, "snap/chromium/common/chromium/Default/Cookies"),
        ]

    # Expand glob patterns
    import glob as _glob
    expanded = []
    for p in paths:
        if "*" in p:
            expanded.extend(_glob.glob(p))
        else:
            expanded.append(p)
    return expanded


# ── Dependency Check ───────────────────────────────────────────

def check_deps() -> dict:
    """Check which optional dependencies are available and return status."""
    result = {
        "browser_cookie3": None,
        "pycryptodome": None,
        "cryptography": None,
        "sqlite3": None,
    }

    # browser-cookie3: for reading Chrome cookies
    try:
        import browser_cookie3
        result["browser_cookie3"] = True
    except ImportError:
        result["browser_cookie3"] = False

    # pycryptodome: preferred crypto library
    try:
        from Crypto.Cipher import AES
        from Crypto.Util.Padding import pad, unpad
        from Crypto.Protocol.KDF import PBKDF2
        from Crypto.Hash import SHA512
        from Crypto.Random import get_random_bytes
        result["pycryptodome"] = True
    except ImportError:
        result["pycryptodome"] = False

    # cryptography: fallback crypto library
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.primitives import padding as _cpad
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
        from cryptography.hazmat.primitives import hashes
        result["cryptography"] = True
    except ImportError:
        result["cryptography"] = False

    # sqlite3: built-in, for direct cookie DB access
    try:
        import sqlite3
        result["sqlite3"] = True
    except ImportError:
        result["sqlite3"] = False

    return result


def print_deps_status(deps: dict):
    """Print dependency status and install instructions."""
    print("Dependency Status:")
    print(f"  browser-cookie3 : {'✓ 已安装' if deps['browser_cookie3'] else '✗ 未安装 (pip3 install browser-cookie3)'}")
    print(f"  pycryptodome    : {'✓ 已安装' if deps['pycryptodome'] else '✗ 未安装 (pip3 install pycryptodome)'}")
    print(f"  cryptography    : {'✓ 已安装' if deps['cryptography'] else '✗ 未安装 (pip3 install cryptography)'}")
    print(f"  sqlite3        : {'✓ 内置' if deps['sqlite3'] else '✗ 不可用'}")
    print()

    if not deps["pycryptodome"] and not deps["cryptography"]:
        print("[WARN] 至少需要一个加密库 (pycryptodome 或 cryptography)。")
        print("      推荐安装: pip3 install pycryptodome")
    if not deps["browser_cookie3"]:
        print("[INFO] 未安装 browser-cookie3，将尝试直接读取 Chrome Cookie 数据库。")
        print("      如果失败，请安装: pip3 install browser-cookie3")
        print("      或手动指定 token: python3 refresh_glm_token.py --token YOUR_TOKEN")


# ── Step 1: 从 Chrome 提取 cookie ─────────────────────────────

def _extract_via_browser_cookie3() -> Optional[str]:
    """Extract token using browser-cookie3 library (preferred method)."""
    import browser_cookie3
    try:
        cj = browser_cookie3.chrome(domain_name=GLM_DOMAIN)
        for cookie in cj:
            if cookie.name == TOKEN_KEY:
                return cookie.value
    except Exception as e:
        print(f"[WARN] browser-cookie3 读取失败: {e}", file=sys.stderr)
    return None


def _extract_via_sqlite(db_path: str) -> Optional[str]:
    """Extract token by reading Chrome's SQLite Cookie database directly."""
    import sqlite3
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        cur = conn.execute(
            "SELECT value FROM cookies WHERE host_key LIKE ? AND name = ?",
            (f"%{GLM_DOMAIN}%", TOKEN_KEY)
        )
        row = cur.fetchone()
        conn.close()
        if row:
            return row[0]
    except Exception as e:
        print(f"[DEBUG] sqlite3 读取 {db_path} 失败: {e}", file=sys.stderr)
    return None


def extract_token() -> Optional[str]:
    """从 Chrome 的 Cookies 数据库提取 chatglm_refresh_token

    优先使用 browser-cookie3，失败后尝试直接读取 SQLite 数据库。
    """
    deps = check_deps()

    # Method 1: browser-cookie3 (handles encryption across platforms)
    if deps["browser_cookie3"]:
        token = _extract_via_browser_cookie3()
        if token:
            return token
        print("[INFO] browser-cookie3 未找到 token，尝试直接读取数据库...")

    # Method 2: Direct SQLite read (works if Chrome is not running or on simpler setups)
    if deps["sqlite3"]:
        for db_path in _chrome_cookie_paths():
            if os.path.exists(db_path):
                print(f"[DEBUG] 尝试读取: {db_path}")
                token = _extract_via_sqlite(db_path)
                if token:
                    return token

    return None


def open_login_page():
    """打开智谱清言网页让用户登录"""
    print("[INFO] 正在打开智谱清言网页 (https://chatglm.cn) ...")
    import webbrowser
    webbrowser.open(GLM_LOGIN_URL)


# ── Step 2: 加密/解密 data.json ────────────────────────────────

def _iv_to_salt(iv: bytes) -> str:
    """将 IV 转换为 PBKDF2 salt，匹配 Node.js Buffer.toString() 行为"""
    return iv.decode("utf-8", errors="replace")


def _derive_key_pycryptodome(iv: bytes) -> bytes:
    """PBKDF2 派生 AES 密钥 (pycryptodome)"""
    from Crypto.Protocol.KDF import PBKDF2
    from Crypto.Hash import SHA512
    salt = _iv_to_salt(iv)
    return PBKDF2(ENCRYPTION_KEY.encode(), salt.encode("utf-8"),
                  dkLen=32, count=10_000, hmac_hash_module=SHA512)


def _derive_key_cryptography(iv: bytes) -> bytes:
    """PBKDF2 派生 AES 密钥 (cryptography fallback)"""
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    salt = _iv_to_salt(iv)
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA512(),
        length=32,
        salt=salt.encode("utf-8"),
        iterations=10_000,
    )
    return kdf.derive(ENCRYPTION_KEY.encode())


def _decrypt_pycryptodome(iv: bytes, ct: bytes) -> dict:
    """Decrypt using pycryptodome."""
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import unpad
    key = _derive_key_pycryptodome(iv)
    cipher = AES.new(key, AES.MODE_CBC, iv=iv)
    plaintext = unpad(cipher.decrypt(ct), AES.block_size)
    return json.loads(plaintext.decode("utf-8"))


def _decrypt_cryptography(iv: bytes, ct: bytes) -> dict:
    """Decrypt using cryptography fallback."""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives import padding
    key = _derive_key_cryptography(iv)
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
    decryptor = cipher.decryptor()
    padded = decryptor.update(ct) + decryptor.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    plaintext = unpadder.update(padded) + unpadder.finalize()
    return json.loads(plaintext.decode("utf-8"))


def _encrypt_pycryptodome(data: dict) -> bytes:
    """Encrypt using pycryptodome."""
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import pad
    from Crypto.Random import get_random_bytes
    iv = get_random_bytes(16)
    key = _derive_key_pycryptodome(iv)
    cipher = AES.new(key, AES.MODE_CBC, iv=iv)
    plaintext = json.dumps(data, ensure_ascii=False, indent="\t").encode("utf-8")
    ct = cipher.encrypt(pad(plaintext, AES.block_size))
    return iv + b":" + ct


def _encrypt_cryptography(data: dict) -> bytes:
    """Encrypt using cryptography fallback."""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives import padding
    import os as _os
    iv = _os.urandom(16)
    key = _derive_key_cryptography(iv)
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
    encryptor = cipher.encryptor()
    padder = padding.PKCS7(128).padder()
    plaintext = json.dumps(data, ensure_ascii=False, indent="\t").encode("utf-8")
    padded = padder.update(plaintext) + padder.finalize()
    ct = encryptor.update(padded) + encryptor.finalize()
    return iv + b":" + ct


def decrypt_data() -> Optional[dict]:
    """解密 data.json = IV(16 bytes) + b':' + AES-256-CBC ciphertext"""
    if not os.path.exists(DATA_FILE):
        print(f"[ERROR] 数据文件不存在: {DATA_FILE}", file=sys.stderr)
        return None

    with open(DATA_FILE, "rb") as f:
        content = f.read()

    if len(content) < 17:
        print("[ERROR] 数据文件太短（至少需要 17 字节）", file=sys.stderr)
        return None

    iv = content[:16]
    colon = content[16:17]
    ct = content[17:]

    if colon != b":":
        print("[ERROR] 数据文件格式异常（IV 后不是 ':' 分隔符）", file=sys.stderr)
        return None

    deps = check_deps()

    if deps["pycryptodome"]:
        try:
            return _decrypt_pycryptodome(iv, ct)
        except Exception as e:
            print(f"[WARN] pycryptodome 解密失败: {e}", file=sys.stderr)
            if deps["cryptography"]:
                print("[INFO] 尝试 cryptography 解密...")

    if deps["cryptography"]:
        try:
            return _decrypt_cryptography(iv, ct)
        except Exception as e:
            print(f"[ERROR] cryptography 解密也失败: {e}", file=sys.stderr)
            return None

    print("[ERROR] 没有可用的加密库。请安装: pip3 install pycryptodome cryptography")
    return None


def encrypt_data(data: dict) -> bytes:
    """加密 dict → IV + b':' + AES-256-CBC 密文"""
    deps = check_deps()

    if deps["pycryptodome"]:
        return _encrypt_pycryptodome(data)

    if deps["cryptography"]:
        return _encrypt_cryptography(data)

    raise RuntimeError("没有可用的加密库。请安装: pip3 install pycryptodome cryptography")


# ── Step 3: 更新 GLM 账户 ──────────────────────────────────────

def update_glm_accounts(data: dict, new_token: str, dry_run: bool = False) -> int:
    """查找所有 GLM 账户并更新 refresh_token"""
    accounts = data.get("accounts", [])
    updated = 0

    for acc in accounts:
        provider_id = acc.get("providerId", "")
        if provider_id != "glm":
            continue

        name = acc.get("name", "未命名")
        creds = acc.get("credentials", {})
        old_token = creds.get("refresh_token", "") or creds.get("token", "")
        if old_token:
            old_masked = old_token[:15] + "..." + old_token[-8:] if len(old_token) > 25 else old_token[:10] + "..."
        else:
            old_masked = "(空)"

        if dry_run:
            print(f"  [DRY-RUN] {name}: refresh_token {old_masked} -> {new_token[:15]}...{new_token[-8:]}")
        else:
            creds["refresh_token"] = new_token
            creds["token"] = new_token
            print(f"  [OK] {name}: refresh_token 已更新")

        updated += 1

    return updated


# ── Main ───────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="自动刷新 Chat2API 的 GLM refresh_token")
    parser.add_argument("--token", "-t", help="手动指定 refresh_token（跳过自动提取）")
    parser.add_argument("--print", action="store_true", help="仅打印 token，不修改文件")
    parser.add_argument("--open", "-o", action="store_true", help="若未找到 token，打开智谱清言网页")
    parser.add_argument("--dry-run", action="store_true", help="干跑模式：显示变更但不实际写入")
    parser.add_argument("--check-deps", action="store_true", help="仅检查依赖，不执行任何操作")
    args = parser.parse_args()

    # Check deps first
    deps = check_deps()

    if args.check_deps:
        print_deps_status(deps)
        sys.exit(0 if deps["pycryptodome"] or deps["cryptography"] else 1)

    # Verify we have at least one crypto library
    if not deps["pycryptodome"] and not deps["cryptography"]:
        print_deps_status(deps)
        print("\n[FATAL] 没有可用的加密库，无法继续。")
        print("请安装: pip3 install pycryptodome")
        sys.exit(1)

    # 1. Get token
    token = args.token
    if not token:
        print("[1/3] 从 Chrome 提取 chatglm_refresh_token ...")
        token = extract_token()

        if not token:
            print("[FAIL] 未找到 chatglm_refresh_token")
            print("[HINT] 请先在 Chrome 中登录 https://chatglm.cn")
            print("[HINT] 或手动指定: python3 refresh_glm_token.py --token YOUR_TOKEN")
            if args.open:
                open_login_page()
                print("[INFO] 登录完成后请重新运行此脚本")
            sys.exit(1)

    print(f"  [OK] 找到 token: {token[:15]}...{token[-8:]}" if len(token) > 25 else f"  [OK] token: {token[:10]}...")

    if args.print:
        print(f"\n{token}")
        return

    # 2. Decrypt data.json
    print("\n[2/3] 解密 data.json ...")
    data = decrypt_data()
    if data is None:
        sys.exit(1)
    print("  [OK] 解密成功")

    # 3. Update accounts
    print("\n[3/3] 更新 GLM 账户凭证 ...")
    count = update_glm_accounts(data, token, dry_run=args.dry_run)

    if count == 0:
        print("  [WARN] 没有找到 GLM 账户，请先在 Chat2API 中添加 GLM 提供方")
        sys.exit(1)

    if args.dry_run:
        print(f"\n[DRY-RUN] 共 {count} 个账户将被更新（未实际写入）")
        return

    # 4. Encrypt and write back
    print("\n[4/4] 加密并写回 data.json ...")
    encrypted = encrypt_data(data)

    # Backup original
    backup = DATA_FILE + ".bak." + str(int(time.time()))
    if os.path.exists(DATA_FILE):
        shutil.copy2(DATA_FILE, backup)
        print(f"  [OK] 已备份: {backup}")

    with open(DATA_FILE, "wb") as f:
        f.write(encrypted)
    print(f"  [OK] 已写入 {DATA_FILE}")

    print(f"\n[OK] 完成！已更新 {count} 个 GLM 账户。请重启 Chat2API 使更改生效。")


if __name__ == "__main__":
    main()
