#!/usr/bin/env python3
"""会話による更新用: 指定した時間休業を calendar.json に追加します。"""
import argparse
import json
from datetime import datetime
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "dist" / "data" / "calendar.json"

def time_value(value: str) -> str:
    try:
        parsed = datetime.strptime(value, "%H:%M")
    except ValueError as exc:
        raise argparse.ArgumentTypeError("時刻は 13:00 の形式で入力してください") from exc
    if parsed.minute != 0:
        raise argparse.ArgumentTypeError("休業時間は1時間単位で指定してください")
    return parsed.strftime("%H:%M")

parser = argparse.ArgumentParser(description="エルムバルーンの時間指定休業を追加")
parser.add_argument("--date", required=True, help="日付（例: 2026-10-10）")
parser.add_argument("--start", required=True, type=time_value, help="開始（例: 13:00）")
parser.add_argument("--end", required=True, type=time_value, help="終了（例: 16:00）")
parser.add_argument("--label", default="臨時休業", help="カレンダーに表示する名称")
args = parser.parse_args()
datetime.strptime(args.date, "%Y-%m-%d")
if args.start >= args.end:
    parser.error("終了時刻は開始時刻より後にしてください")

data = json.loads(DATA.read_text(encoding="utf-8"))
item = {"date": args.date, "start": args.start, "end": args.end, "kind": "closed", "label": args.label}
data.setdefault("exceptions", []).append(item)
DATA.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"追加しました: {args.date} {args.start}〜{args.end} {args.label}")
