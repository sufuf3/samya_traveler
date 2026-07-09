"""簡易網頁介面：貼上目的地素材 -> 產生 Reels 腳本。

啟動方式：
    export ANTHROPIC_API_KEY=sk-ant-xxxx
    python webapp/app.py
然後開啟瀏覽器 http://127.0.0.1:5000
"""
from __future__ import annotations

import sys
from pathlib import Path

from flask import Flask, render_template, request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from lib.generator import DEFAULT_MODE, DEFAULT_MODEL, GenerationRequest, generate_script

app = Flask(__name__)


@app.route("/", methods=["GET", "POST"])
def index():
    result = None
    error = None
    form_values = {"destination": "", "material": "", "style_notes": "", "mode": DEFAULT_MODE}

    if request.method == "POST":
        form_values["destination"] = request.form.get("destination", "").strip()
        form_values["material"] = request.form.get("material", "").strip()
        form_values["style_notes"] = request.form.get("style_notes", "").strip()
        form_values["mode"] = request.form.get("mode", DEFAULT_MODE)

        if not form_values["destination"]:
            error = "請輸入目的地／主題名稱。"
        else:
            try:
                req = GenerationRequest(
                    destination=form_values["destination"],
                    material=form_values["material"],
                    style_notes=form_values["style_notes"],
                    model=DEFAULT_MODEL,
                    mode=form_values["mode"],
                )
                result = generate_script(req)
            except Exception as exc:  # noqa: BLE001 - 直接把錯誤顯示給使用者
                error = str(exc)

    return render_template("index.html", result=result, error=error, **form_values)


if __name__ == "__main__":
    app.run(debug=True)
