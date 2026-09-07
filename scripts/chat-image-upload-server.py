"""Chat image upload endpoint backed by Cloudflare R2.

POST /chat-upload-image (multipart, field "file") -> {"ok":true,"url":...}
GET  /chat-image/<key>  -> serves the stored image back through this server.

Stored under images/<sha256>.<ext>; content-addressed and immutable, so
repeat uploads of the same image cost nothing. Public access is preferred
via the bucket's public r2.dev base (R2_PUBLIC_BASE); without it images are
streamed through this server.

Credenv (all optional; without them the endpoint returns 503 and chat.html
falls back to inline base64, exactly like today):
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
  R2_PUBLIC_BASE (optional, e.g. https://pub-xxxx.r2.dev)
"""

import hashlib
import json
import os
import re

MAX_IMAGE_BYTES = 1.5 * 1024 * 1024  # client compresses to ~200KB anyway

_MAGIC_EXT = (
    (b"\xff\xd8\xff", "jpg"),
    (b"\x89PNG", "png"),
    (b"GIF8", "gif"),
    (b"RIFF", "webp"),
)

_CTYPES = {
    "jpg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
}


def _detect_ext(head):
    for magic, ext in _MAGIC_EXT:
        if head.startswith(magic):
            return ext
    return None


class ChatImageUploadMixin:
    """Add to serve-chalk.py's handler bases. Needs _json_response and
    _simple_response helpers (already present in that server)."""

    def _r2_client(self):
        if getattr(self, "_r2", None) is not None:
            return self._r2
        if getattr(self, "_r2_checked", False):
            return None
        self._r2_checked = True
        acct = os.environ.get("R2_ACCOUNT_ID", "")
        key = os.environ.get("R2_ACCESS_KEY_ID", "")
        secret = os.environ.get("R2_SECRET_ACCESS_KEY", "")
        bucket = os.environ.get("R2_BUCKET", "")
        if not (acct and key and secret and bucket):
            return None
        try:
            import boto3
            from botocore.config import Config
            self._r2 = boto3.client(
                "s3",
                endpoint_url=f"https://{acct}.r2.cloudflarestorage.com",
                aws_access_key_id=key,
                aws_secret_access_key=secret,
                config=Config(signature_version="s3v4"),
            )
            self._r2_bucket = bucket
            pub = os.environ.get("R2_PUBLIC_BASE", "").strip().rstrip("/")
            self._r2_public_base = pub or None
            return self._r2
        except Exception as e:
            print(f"[chat-upload] R2 unavailable: {e}")
            return None

    def _r2_public_url(self, key):
        base = getattr(self, "_r2_public_base", None)
        if base:
            return f"{base}/{key}"
        return None

    def handle_chat_upload_image(self):
        """POST /chat-upload-image"""
        client = self._r2_client()
        if not client:
            self._json_response(503, {"ok": False, "error": "upload not configured"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_IMAGE_BYTES + 64 * 1024:
                self._json_response(413, {"ok": False, "error": "too large"})
                return
            body = self.rfile.read(length)

            ctype = self.headers.get("Content-Type", "")
            m = re.search(r'boundary=([^;]+)', ctype)
            if not m:
                self._json_response(400, {"ok": False, "error": "expected multipart"})
                return
            boundary = m.group(1).strip().encode()
            delim = b"--" + boundary

            part = None
            for chunk in body.split(delim):
                if b"Content-Disposition" in chunk and b"filename" in chunk:
                    part = chunk
                    break
            if not part:
                self._json_response(400, {"ok": False, "error": "no file part"})
                return
            idx = part.find(b"\r\n\r\n")
            if idx < 0:
                self._json_response(400, {"ok": False, "error": "malformed part"})
                return
            data = part[idx + 4:]
            if data.endswith(b"\r\n"):
                data = data[:-2]

            if len(data) > MAX_IMAGE_BYTES:
                self._json_response(413, {"ok": False, "error": "too large"})
                return

            ext = _detect_ext(data[:16]) or "png"
            digest = hashlib.sha256(data).hexdigest()[:32]
            key = f"images/{digest}.{ext}"

            client.put_object(
                Bucket=self._r2_bucket,
                Key=key,
                Body=data,
                ContentType=_CTYPES.get(ext, "application/octet-stream"),
                CacheControl="public, max-age=31536000, immutable",
            )

            url = self._r2_public_url(key)
            if not url:
                url = f"/chat-image/{key.split('/', 1)[1]}"
            self._json_response(200, {"ok": True, "url": url, "key": key})
        except Exception as e:
            print(f"[chat-upload] error: {e}")
            self._json_response(500, {"ok": False, "error": str(e)[:200]})

    def handle_chat_image_get(self, key):
        """GET /chat-image/<key> (fallback when no public base is configured)"""
        client = self._r2_client()
        if not client or not re.fullmatch(r"[a-f0-9]{32}\.(jpg|png|gif|webp)", key or ""):
            self._simple_response(404, b"not found", ctype="text/plain")
            return
        try:
            obj = client.get_object(Bucket=self._r2_bucket, Key=f"images/{key}")
            data = obj["Body"].read()
            ext = key.rsplit(".", 1)[-1].lower()
            self._simple_response(200, data, ctype=_CTYPES.get(ext, "application/octet-stream"),
                                  cache="public, max-age=31536000, immutable")
        except Exception:
            self._simple_response(404, b"not found", ctype="text/plain")
