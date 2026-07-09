"""核心產生邏輯：讀取 master system prompt，套用目的地素材，呼叫 Claude API。

被 scripts/generate_script.py（CLI）與 webapp/app.py（網頁介面）共用，
確保兩種使用方式套用完全相同的規則。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SYSTEM_PROMPT_PATH = REPO_ROOT / "prompts" / "system_prompt.md"
PLACEHOLDER = "{{DESTINATION_MATERIAL}}"

DEFAULT_MODEL = "claude-sonnet-5"


@dataclass
class GenerationRequest:
    destination: str
    material: str
    style_notes: str = ""
    model: str = DEFAULT_MODEL


def load_system_prompt() -> str:
    """讀取 master system prompt，並移除本次素材佔位區塊（素材改以 user message 傳入）。"""
    text = SYSTEM_PROMPT_PATH.read_text(encoding="utf-8")
    if PLACEHOLDER not in text:
        raise ValueError(
            f"system_prompt.md 中找不到佔位字串 {PLACEHOLDER}，請確認模板檔案未被誤改。"
        )
    head, _, _tail = text.partition(PLACEHOLDER)
    return head.strip()


def build_user_message(req: GenerationRequest) -> str:
    lines = [
        f"【目的地】{req.destination}",
        "",
        "【素材／踩點資訊】",
        req.material.strip() or "（使用者未提供細節，請依目的地常見公開資訊合理發想，但避免捏造具體店名）",
    ]
    if req.style_notes.strip():
        lines += ["", "【本次額外風格備註】", req.style_notes.strip()]
    lines += [
        "",
        "請依照 system prompt 中的三大區塊格式，輸出這支目的地的 Reels 腳本。",
    ]
    return "\n".join(lines)


def generate_script(req: GenerationRequest) -> str:
    """呼叫 Anthropic API 產生腳本，回傳 Claude 回覆的文字內容。"""
    try:
        import anthropic
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "缺少 anthropic 套件，請先執行：pip install -r requirements.txt"
        ) from exc

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "找不到環境變數 ANTHROPIC_API_KEY，請先設定你的 Anthropic API Key。"
        )

    client = anthropic.Anthropic(api_key=api_key)
    system_prompt = load_system_prompt()
    user_message = build_user_message(req)

    response = client.messages.create(
        model=req.model,
        max_tokens=4096,
        system=system_prompt,
        messages=[{"role": "user", "content": user_message}],
    )
    return "".join(
        block.text for block in response.content if getattr(block, "type", None) == "text"
    )


def preview_prompt(req: GenerationRequest) -> tuple[str, str]:
    """不呼叫 API，回傳 (system_prompt, user_message) 供 --dry-run 或除錯使用。"""
    return load_system_prompt(), build_user_message(req)
