import numpy as np
import soundfile as sf

from audiobook_worker.tts import registry, service
from audiobook_worker.tts.base import TTSEngine, Voice, trim_silence


class FakeEngine(TTSEngine):
    """Deterministic engine: 0.05s of tone per word, with silence padding to test trimming."""
    name = "fake"
    calls = 0
    fail_first = False

    @classmethod
    def available(cls):
        return True, "ready"

    def voices(self):
        return [Voice("v1", "V1", "en")]

    def synthesize(self, text, voice, speed, language):
        FakeEngine.calls += 1
        if FakeEngine.fail_first and FakeEngine.calls == 1:
            raise RuntimeError("transient")
        rate = 16000
        n = int(rate * 0.05 * len(text.split()))
        tone = 0.3 * np.sin(np.linspace(0, 440 * 2 * np.pi * n / rate, n)).astype(np.float32)
        pad = np.zeros(int(rate * 0.2), dtype=np.float32)
        return np.concatenate([pad, tone, pad]), rate


def setup_module(_):
    registry.ENGINES["fake"] = FakeEngine
    registry._instances.pop("fake", None)


def test_trim_silence():
    rate = 24000
    x = np.concatenate([np.zeros(rate), 0.5 * np.ones(rate // 2, dtype=np.float32), np.zeros(rate)])
    y = trim_silence(x.astype(np.float32), rate)
    assert abs(y.size / rate - 0.5) < 0.1


def test_chapter_timings_are_sample_accurate(tmp_path):
    segs = [{"id": "a", "text": "one two three four", "pauseMs": 250},
            {"id": "b", "text": "five six", "pauseMs": 600},
            {"id": "c", "text": "seven eight nine ten eleven twelve", "pauseMs": 0}]
    out = tmp_path / "ch.flac"
    res = service.synthesize_chapter(segs, str(out), "fake", "v1", sample_rate=24000, word_timings=True)
    data, rate = sf.read(str(out))
    assert rate == 24000
    assert data.size == res["samples"]
    t = res["timings"]
    assert [x["id"] for x in t] == ["a", "b", "c"]
    assert abs(t[0]["end"] - 0.2) < 0.06  # 4 words * 0.05s (+ trim padding)
    assert abs((t[1]["start"] - t[0]["end"]) - 0.25) < 1e-3
    assert abs((t[2]["start"] - t[1]["end"]) - 0.60) < 1e-3
    assert abs(res["duration"] - t[2]["end"]) < 1e-3
    assert len(t[2]["words"]) == 6 and t[2]["words"][-1]["end"] <= t[2]["end"] + 1e-3


def test_retry_on_transient_failure(tmp_path):
    FakeEngine.calls = 0
    FakeEngine.fail_first = True
    try:
        res = service.synthesize_chapter([{"id": "a", "text": "hello world", "pauseMs": 0}], str(tmp_path / "x.flac"), "fake", "v1")
        assert res["timings"][0]["end"] > 0
        assert FakeEngine.calls == 2
    finally:
        FakeEngine.fail_first = False
