"""h3_tokens: 純 Python の Qwen2 BPE が ComfyUI のトークナイザと同じ数を返すか。

期待値は ComfyUI venv の HF tokenizers(Qwen2 と同じ前処理+MiniMax の追加トークン)で数えたもの。
"""
import pytest

from app.services import h3_tokens

EXPECTED = {
    "<Picture 1>: ": 6, "<Picture 9>: ": 6, "<Video 1>: ": 6, "<Audio 2>: ": 5,
    "<0.5 seconds>": 6, "<12.0 seconds>": 7, "<7.0 seconds>": 6,
    "It's raining; we'll see THE girl's umbrella... 12345 apples!\n\n  Next line\ttab": 24,
    "杏子は傘をさして歩く。綺麗な場所へ行こう": 20,
    "<d>[English] We know the game</d> and <|cutoff|> done": 13,
    "Émilie's café — “quoted” text… ½ ² ③ 🎉 emoji": 22,
    "subject_definitions:\n<Subject 1> is Kyoko Sakura, exactly as drawn in <Picture 1>.\n\n"
    "summary:\n[video editing] The target video...": 32,
}


@pytest.fixture(autouse=True)
def _need_tokenizer():
    if not h3_tokens.is_exact():
        pytest.skip("Qwen トークナイザ(merges.txt)が見つからない")


@pytest.mark.parametrize("text,n", list(EXPECTED.items()))
def test_counts_match_comfyui_tokenizer(text, n):
    got, exact = h3_tokens.count_tokens(text)
    assert exact is True
    assert got == n


def test_empty():
    assert h3_tokens.count_tokens("") == (0, True)


def test_fallback_is_conservative(monkeypatch, tmp_path):
    """トークナイザが無いときは文字数見積り(多めに数える)に切り替わる。"""
    exact_counts = {t: h3_tokens.count_tokens(t)[0] for t in EXPECTED}
    monkeypatch.setenv("H3_QWEN_TOKENIZER_DIR", str(tmp_path / "missing"))
    saved = dict(h3_tokens._state)
    h3_tokens._state.clear()
    try:
        for t, n in exact_counts.items():
            got, exact = h3_tokens.count_tokens(t)
            assert exact is False
            assert got >= n, (t, got, n)
    finally:
        h3_tokens._state.clear()
        h3_tokens._state.update(saved)
