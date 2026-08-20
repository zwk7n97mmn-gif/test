"""NIST P-256 (secp256r1) の ECDSA を標準ライブラリだけで実装したもの。

ライセンスキーの署名に使う。外部パッケージを入れなくても
`python taskdeck/tools/keygen.py` が動くようにするためだけの実装で、
用途はライセンス発行に限定している。

対になる検証側は app/taskdeck.html の中に JavaScript で同じ計算が入っている。
両者が一致することは tests/test_license.py が実際に鍵を作って確かめる。
"""

from __future__ import annotations

import hashlib
import secrets

# 曲線パラメータ (FIPS 186-4)
P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296
GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551

# 無限遠点は None で表す。
Point = tuple[int, int] | None


def _inv(value: int, modulus: int) -> int:
    return pow(value, -1, modulus)


def point_add(p1: Point, p2: Point) -> Point:
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2 and (y1 + y2) % P == 0:
        return None
    if p1 == p2:
        lam = (3 * x1 * x1 + A) * _inv(2 * y1, P) % P
    else:
        lam = (y2 - y1) * _inv(x2 - x1, P) % P
    x3 = (lam * lam - x1 - x2) % P
    y3 = (lam * (x1 - x3) - y1) % P
    return (x3, y3)


def point_mul(k: int, point: Point) -> Point:
    """素朴な double-and-add。鍵発行は手元でしか動かさないので定数時間性は問わない。"""
    result: Point = None
    addend = point
    while k:
        if k & 1:
            result = point_add(result, addend)
        addend = point_add(addend, addend)
        k >>= 1
    return result


def is_on_curve(point: Point) -> bool:
    if point is None:
        return True
    x, y = point
    return (y * y - (x * x * x + A * x + B)) % P == 0


def generate_keypair() -> tuple[int, tuple[int, int]]:
    """(秘密鍵, 公開鍵) を返す。"""
    private = secrets.randbelow(N - 1) + 1
    public = point_mul(private, (GX, GY))
    assert public is not None
    return private, public


def _hash_int(message: bytes) -> int:
    return int.from_bytes(hashlib.sha256(message).digest(), "big")


def sign(private: int, message: bytes) -> bytes:
    """r || s を 32 バイトずつ並べた 64 バイトの署名を返す。"""
    z = _hash_int(message)
    while True:
        k = secrets.randbelow(N - 1) + 1
        point = point_mul(k, (GX, GY))
        if point is None:
            continue
        r = point[0] % N
        if r == 0:
            continue
        s = _inv(k, N) * (z + r * private) % N
        if s == 0:
            continue
        # 署名の可鍛性を避けるため s は小さい方に寄せる (JavaScript 側もこれを前提にしない実装だが揃えておく)
        if s > N // 2:
            s = N - s
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def verify(public: tuple[int, int], message: bytes, signature: bytes) -> bool:
    if len(signature) != 64 or not is_on_curve(public):
        return False
    r = int.from_bytes(signature[:32], "big")
    s = int.from_bytes(signature[32:], "big")
    if not (1 <= r < N and 1 <= s < N):
        return False
    z = _hash_int(message)
    w = _inv(s, N)
    point = point_add(point_mul(z * w % N, (GX, GY)), point_mul(r * w % N, public))
    if point is None:
        return False
    return point[0] % N == r


def public_to_hex(public: tuple[int, int]) -> str:
    """非圧縮形式 (04 || X || Y) の 16 進文字列。JavaScript 側もこの形で読む。"""
    return "04" + f"{public[0]:064x}" + f"{public[1]:064x}"


def public_from_hex(text: str) -> tuple[int, int]:
    text = text.strip().lower()
    if len(text) != 130 or not text.startswith("04"):
        raise ValueError("公開鍵は 04 で始まる 130 桁の 16 進文字列である必要があります")
    return (int(text[2:66], 16), int(text[66:], 16))
