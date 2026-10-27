# -*- coding: utf-8 -*-
"""常驻 ASR 服务：模型只加载一次，之后每次转写几百毫秒。

POST /transcribe  {"path": "C:/...wav"}  -> {"ok":true,"text":"..."}
GET  /health                              -> {"ok":true,"ready":true}
"""
import json
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = r"C:\ai-voice\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50\tools\asr\models"
ASR = os.path.join(MODELS, "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch")
VAD = os.path.join(MODELS, "speech_fsmn_vad_zh-cn-16k-common-pytorch")
PUNC = os.path.join(MODELS, "punc_ct-transformer_zh-cn-common-vocab272727-pytorch")

_model = None
_lock = threading.Lock()


def load():
    global _model
    from funasr import AutoModel

    started = time.time()
    _model = AutoModel(
        model=ASR,
        vad_model=VAD,
        vad_kwargs={"max_single_segment_time": 30000},
        punc_model=PUNC,
        disable_update=True,
        device="cpu",
    )
    sys.stderr.write("[asr] model loaded in %.1fs\n" % (time.time() - started))
    sys.stderr.flush()


def wav_seconds(path):
    try:
        with wave.open(path, "rb") as w:
            return w.getnframes() / float(w.getframerate() or 1)
    except Exception:
        return 0.0


def transcribe(path):
    if not os.path.exists(path):
        return {"ok": False, "error": "file not found"}
    started = time.time()
    with _lock:
        res = _model.generate(input=path, batch_size_s=300)
    text = ""
    if isinstance(res, list) and res:
        text = (res[0].get("text") or "").strip()
    elif isinstance(res, dict):
        text = (res.get("text") or "").strip()
    if not text:
        return {"ok": False, "error": "empty transcription"}
    return {"ok": True, "text": text, "seconds": round(wav_seconds(path), 2), "cost": round(time.time() - started, 2)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, payload, code=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send({"ok": True, "ready": _model is not None})
        else:
            self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        if not self.path.startswith("/transcribe"):
            self._send({"ok": False, "error": "not found"}, 404)
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")
            path = str(data.get("path") or "").strip()
            if not path:
                self._send({"ok": False, "error": "path required"}, 400)
                return
            self._send(transcribe(path))
        except Exception as exc:  # noqa: BLE001
            self._send({"ok": False, "error": str(exc)[:300]}, 500)

    def log_message(self, fmt, *args):  # 静音默认访问日志
        return


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9881
    load()
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    sys.stderr.write("[asr] listening on 127.0.0.1:%d\n" % port)
    sys.stderr.flush()
    srv.serve_forever()


if __name__ == "__main__":
    main()
