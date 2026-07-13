#!/usr/bin/env python3
"""
refresh_glm_token.py — 自动从 Chrome 提取 chatglm_refresh_token 并更新到 Chat2API

流程：
  1. 读取 Chrome 的 Cookies 数据库，提取 chatglm.cn 域下的 chatglm_refresh_token
  2. 如果没找到，自动打开浏览器让用户登录（可选 -o/--open）
  3. 解密 ~/.chat2api/data.json：16字节 IV + ':' + AES-256-CBC 密文
  4. 找到所有 GLM 账户，更新 refresh_token 凭证
  5. 重新加密并写回 data.json

前置依赖：
  pip3 install browser-cookie3 pycryptodome

用法：
  python3 refresh_glm_token.py            # 提取 token 并更新
  python3 refresh_glm_token.py --print    # 仅打印 token，不修改文件
  python3 refresh_glm_token.py --open     # 若未登录，自动打开智谱清言网页
  python3 refresh_glm_token.py --dry-run  # 干跑，显示将要更新的内容
"""

import os
import sys
import json
import argparse
import subprocess
from typing import Optional

ENCRYPTION_KEY = "chat2api-fixed-encryption-key-v1"
DATA_FILE = os.path.expanduser("~/.chat2api/data.json")
GLM_DOMAIN = "chatglm.cn"
TOKEN_KEY = "chatglm_refresh_token"
GLM_LOGIN_URL = "https://chatglm.cn"


# ── Step 1: 从 Chrome 提取 cookie ─────────────────────────────

def extract_token():
    """从 Chrome 的 Cookies 数据库提取 chatglm_refresh_token"""
    try:
        import browser_cookie3
        cj = browser_cookie3.chrome(domain_name=GLM_DOMAIN)
        for cookie in cj:
            if cookie.name == TOKEN_KEY:
                return cookie.value
    except Exception as e:
        print(f"[ERROR] 读取 Chrome Cookies 失败: {e}", file=sys.stderr)
        print("[HINT] 请确保 Chrome 已安装且登录了智谱清言", file=sys.stderr)
        return None
    return None


def open_login_page():
    """打开智谱清言网页让用户登录"""
    print("[INFO] 正在打开智谱清言网页 (https://chatglm.cn) ...")
    subprocess.run(["open", GLM_LOGIN_URL], check=False)


# ── Step 2: 加密/解密 data.json ────────────────────────────────

def _iv_to_salt(iv: bytes) -> str:
    """将 IV 转换为 PBKDF2 salt，匹配 Node.js Buffer.toString() 行为

    Node.js 的 Buffer.toString() 默认使用 UTF-8 解码，
    对于无效的 UTF-8 字节会替换为 U+FFFD (replacement character)。
    """
    return iv.decode("utf-8", errors="replace")


def _derive_key(iv: bytes) -> bytes:
    """PBKDF2 派生 AES 密钥"""
    from Crypto.Protocol.KDF import PBKDF2
    from Crypto.Hash import SHA512
    salt = _iv_to_salt(iv)
    return PBKDF2(ENCRYPTION_KEY.encode(), salt.encode("utf-8"),
                  dkLen=32, count=10_000, hmac_hash_module=SHA512)


def decrypt_data() -> Optional[dict]:
    """解密 data.json = IV(16 bytes) + b':' + AES-256-CBC ciphertext"""
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import unpad

    if not os.path.exists(DATA_FILE):
        print(f"[ERROR] 数据文件不存在: {DATA_FILE}", file=sys.stderr)
        return None

    with open(DATA_FILE, "rb") as f:
        content = f.read()

    iv = content[:16]
    colon = content[16:17]
    ct = content[17:]

    if colon != b":":
        print("[ERROR] 数据文件格式异常（IV 后不是 ':' 分隔符）", file=sys.stderr)
        return None

    key = _derive_key(iv)
    cipher = AES.new(key, AES.MODE_CBC, iv=iv)
    plaintext = unpad(cipher.decrypt(ct), AES.block_size)
    return json.loads(plaintext.decode("utf-8"))


def encrypt_data(data: dict) -> bytes:
    """加密 dict → IV + b':' + AES-256-CBC 密文"""
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import pad
    from Crypto.Random import get_random_bytes

    iv = get_random_bytes(16)
    key = _derive_key(iv)
    cipher = AES.new(key, AES.MODE_CBC, iv=iv)
    plaintext = json.dumps(data, ensure_ascii=False, indent="\t").encode("utf-8")
    ct = cipher.encrypt(pad(plaintext, AES.block_size))
    return iv + b":" + ct


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
    parser.add_argument("--print", action="store_true", help="仅打印 token，不修改文件")
    parser.add_argument("--open", "-o", action="store_true", help="若未找到 token，打开智谱清言网页")
    parser.add_argument("--dry-run", action="store_true", help="干跑模式：显示变更但不实际写入")
    args = parser.parse_args()

    # 1. 提取 token
    print("[1/3] 从 Chrome 提取 chatglm_refresh_token ...")
    token = extract_token()

    if not token:
        print("[FAIL] 未找到 chatglm_refresh_token")
        print("[HINT] 请先在 Chrome 中登录 https://chatglm.cn")
        if args.open:
            open_login_page()
            print("[INFO] 登录完成后请重新运行此脚本")
        sys.exit(1)

    print(f"  [OK] 找到 token: {token[:15]}...{token[-8:]}")

    if args.print:
        print(f"\n{token}")
        return

    # 2. 解密 data.json
    print("\n[2/3] 解密 data.json ...")
    data = decrypt_data()
    if data is None:
        sys.exit(1)
    print("  [OK] 解密成功")

    # 3. 更新账户
    print("\n[3/3] 更新 GLM 账户凭证 ...")
    count = update_glm_accounts(data, token, dry_run=args.dry_run)

    if count == 0:
        print("  [WARN] 没有找到 GLM 账户，请先在 Chat2API 中添加 GLM 提供方")
        sys.exit(1)

    if args.dry_run:
        print(f"\n[DRY-RUN] 共 {count} 个账户将被更新（未实际写入）")
        return

    # 4. 加密写回
    print("\n[4/4] 加密并写回 data.json ...")
    encrypted = encrypt_data(data)

    # 备份原文件
    import time
    import shutil
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
