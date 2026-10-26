# -*- coding: utf-8 -*-
"""本地中文语音识别（FunASR Paraformer + VAD + 标点）。

用 GPT-SoVITS 整合包里已经下载好的模型，不联网、不下载。
输出一行 JSON：{"ok":true,"text":"...","seconds":1.2} 或 {"ok":false,"error":"..."}
"""
import json
import os
import sys
import time
import wave

MODELS = r"C:\ai-voice\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50\tools\asr\models"
ASR = os.path.join(MODELS, "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch")
VAD = os.path.join(MODELS, "speech_fsmn_vad_zh-cn-16k-common-pytorch")
PUNC = os.path.join(MODELS, "punc_ct-transformer_zh-cn-common-vocab272727-pytorch")


def fail(msg):
    print(json.dumps({"ok": False, "error": str(msg)[:300]}, ensure_ascii=False))
    sys.exit(0)


def wav_seconds(path):
    try:
        with wave.open(path, "rb") as w:
            return w.getnframes() / float(w.getframerate() or 1)
    except Exception:
        return 0.0


def main():
    if len(sys.argv) < 2:
        fail("missing audio path")
    audio = sys.argv[1]
    if not os.path.exists(audio):
        fail("file not found: " + audio)

    started = time.time()
    try:
        from funasr import AutoModel

        model = AutoModel(
            model=ASR,
            vad_model=VAD,
            vad_kwargs={"max_single_segment_time": 30000},
            punc_model=PUNC,
            disable_update=True,
            device="cpu",
        )
        res = model.generate(input=audio, batch_size_s=300)
        text = ""
        if isinstance(res, list) and res:
            text = (res[0].get("text") or "").strip()
        elif isinstance(res, dict):
            text = (res.get("text") or "").strip()
        if not text:
            fail("empty transcription")
        print(json.dumps({
            "ok": True,
            "text": text,
            "seconds": round(wav_seconds(audio), 2),
            "cost": round(time.time() - started, 2),
        }, ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001
        fail(exc)


if __name__ == "__main__":
    main()
