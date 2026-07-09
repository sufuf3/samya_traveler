#!/usr/bin/env python3
"""CLI：輸入目的地與素材，產生一支符合「樂天小熊Samya」品牌規則的 Reels 腳本。

用法範例：
    python scripts/generate_script.py \
        --destination "宜蘭 - 小礁溪野溪溫泉" \
        --material "沿著小礁溪步道走 20 分鐘可達野溪溫泉，需自備泡湯用具，平日人少" \
        --output outputs/宜蘭小礁溪.md

不呼叫 API、只想看組出來的 prompt 內容時，加上 --dry-run。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.generator import DEFAULT_MODEL, GenerationRequest, generate_script, preview_prompt


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--destination", "-d", required=True, help="目的地／主題名稱")
    parser.add_argument(
        "--material", "-m", default="",
        help="素材文字（景點特色、旅宿、交通等），也可搭配 --material-file 使用長文字",
    )
    parser.add_argument(
        "--material-file", "-f", type=Path, default=None,
        help="從檔案讀取素材內容（會與 --material 內容合併）",
    )
    parser.add_argument("--style-notes", "-s", default="", help="本次額外的風格／限制備註（選填）")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"使用的模型（預設 {DEFAULT_MODEL}）")
    parser.add_argument("--output", "-o", type=Path, default=None, help="輸出檔案路徑（預設印在終端機）")
    parser.add_argument("--dry-run", action="store_true", help="不呼叫 API，只印出組好的 system/user prompt")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    material = args.material
    if args.material_file:
        file_text = args.material_file.read_text(encoding="utf-8")
        material = f"{material}\n{file_text}".strip() if material else file_text

    req = GenerationRequest(
        destination=args.destination,
        material=material,
        style_notes=args.style_notes,
        model=args.model,
    )

    if args.dry_run:
        system_prompt, user_message = preview_prompt(req)
        print("===== SYSTEM PROMPT =====\n")
        print(system_prompt)
        print("\n===== USER MESSAGE =====\n")
        print(user_message)
        return

    script_text = generate_script(req)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(script_text, encoding="utf-8")
        print(f"已產出腳本：{args.output}")
    else:
        print(script_text)


if __name__ == "__main__":
    main()
