#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

PROJECT_DIR = Path(__file__).resolve().parent.parent
TARGET_PATH = PROJECT_DIR / "reviews" / "control" / "notification-target.json"
ACTIVE_TASK_PATH = PROJECT_DIR / "reviews" / "control" / "active-task.json"
PROJECT_NAME = PROJECT_DIR.name


def load_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def load_target() -> Dict[str, Any]:
    if not TARGET_PATH.exists():
        raise FileNotFoundError(f"missing target config: {TARGET_PATH}")
    return json.loads(TARGET_PATH.read_text())


def first_non_empty(values: Iterable[Optional[str]]) -> Optional[str]:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return None


def find_first(data: Any, keys: set[str]) -> Optional[str]:
    if isinstance(data, dict):
        for key, value in data.items():
            if key in keys and value not in (None, "", [], {}):
                return str(value)
        for value in data.values():
            found = find_first(value, keys)
            if found:
                return found
    elif isinstance(data, list):
        for item in data:
            found = find_first(item, keys)
            if found:
                return found
    return None


def build_context(payload: Dict[str, Any]) -> Dict[str, Optional[str]]:
    active_task = load_json(ACTIVE_TASK_PATH)
    task_name = first_non_empty([
        find_first(payload, {"subject", "task_subject", "title", "task_title"}),
        active_task.get("summary"),
        find_first(payload, {"summary", "task_summary", "description"}),
        active_task.get("task_id"),
    ])
    task_id = first_non_empty([
        find_first(payload, {"taskId", "task_id", "id"}),
        active_task.get("task_id"),
    ])
    branch = first_non_empty([
        find_first(payload, {"branch", "branch_name"}),
        active_task.get("branch"),
    ])
    status = first_non_empty([
        find_first(payload, {"status", "task_status"}),
        active_task.get("status"),
    ])
    return {
        "task_name": task_name,
        "task_id": task_id,
        "branch": branch,
        "status": status,
    }


def build_message(event: str, payload: Dict[str, Any]) -> str:
    context = build_context(payload)
    if event == "task-completed":
        title = f"**{PROJECT_NAME}** Claude Code task completed"
    elif event == "stop":
        title = f"**{PROJECT_NAME}** Claude Code session stopped"
    else:
        title = f"**{PROJECT_NAME}** Claude Code event: {event}"

    lines = [title]
    if context["task_name"]:
        lines.append(f"- task: {context['task_name']}")
    if context["task_id"]:
        lines.append(f"- task_id: {context['task_id']}")
    if context["branch"]:
        lines.append(f"- branch: {context['branch']}")
    if context["status"]:
        lines.append(f"- status: {context['status']}")
    return "\n".join(lines)


def build_command(target: Dict[str, Any], message: str) -> list[str]:
    lark_cli = shutil.which("lark-cli") or "/opt/homebrew/bin/lark-cli"
    if not Path(lark_cli).exists():
        raise FileNotFoundError("lark-cli is not available")

    identity = target.get("identity") or "bot"
    delivery_mode = target.get("delivery_mode") or "chat"
    content_mode = target.get("content_mode") or "text"
    chat_id = target.get("chat_id")
    user_id = target.get("user_id")

    cmd = [lark_cli, "im", "+messages-send", "--as", identity]
    if delivery_mode == "chat":
        if not chat_id:
            raise ValueError("notification-target.json requires chat_id when delivery_mode=chat")
        cmd.extend(["--chat-id", chat_id])
    elif delivery_mode == "user":
        if not user_id:
            raise ValueError("notification-target.json requires user_id when delivery_mode=user")
        cmd.extend(["--user-id", user_id])
    else:
        raise ValueError(f"unsupported delivery_mode: {delivery_mode}")

    if content_mode == "markdown":
        cmd.extend(["--markdown", message])
    else:
        cmd.extend(["--text", message])
    return cmd


def main() -> int:
    parser = argparse.ArgumentParser(description="Send a Lark notification for Claude hook events")
    parser.add_argument("event", help="Event label, e.g. task-completed or stop")
    args = parser.parse_args()

    raw_payload = sys.stdin.read()
    payload = json.loads(raw_payload) if raw_payload.strip() else {}
    target = load_target()
    message = build_message(args.event, payload)
    cmd = build_command(target, message)
    subprocess.run(cmd, cwd=str(PROJECT_DIR), check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
