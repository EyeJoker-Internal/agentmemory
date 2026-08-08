#!/usr/bin/env python3
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import tempfile
import unicodedata
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_BASE_URL = "https://memory.eyejoker.com"


def resolve_runtime() -> tuple[str, str]:
    base_url = os.environ.get("AGENTMEMORY_URL", DEFAULT_BASE_URL).rstrip("/")
    secret = os.environ.get("AGENTMEMORY_SECRET", "")
    if secret:
        return base_url, secret
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            parts = Path(f"/proc/{entry}/environ").read_bytes().split(b"\0")
        except OSError:
            continue
        env: dict[str, str] = {}
        for part in parts:
            if b"=" not in part:
                continue
            key, value = part.split(b"=", 1)
            env[key.decode(errors="ignore")] = value.decode(errors="ignore")
        candidate_secret = env.get("AGENTMEMORY_SECRET", "")
        candidate_url = env.get("AGENTMEMORY_URL", "")
        if candidate_secret and candidate_url.startswith(DEFAULT_BASE_URL):
            return candidate_url.rstrip("/"), candidate_secret
    raise RuntimeError("AgentMemory runtime credentials are unavailable")


def request_json(
    base_url: str,
    secret: str,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        base_url + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {secret}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode(), strict=False)


def load_inputs(fixture_dir: Path | None) -> dict[str, dict[str, Any]]:
    if fixture_dir:
        return {
            name: json.loads((fixture_dir / f"{name}.json").read_text())
            for name in ["health", "semantic", "status", "diagnostics", "reaper"]
        }
    base_url, secret = resolve_runtime()
    return {
        "health": request_json(base_url, secret, "GET", "/agentmemory/health"),
        "semantic": request_json(base_url, secret, "GET", "/agentmemory/semantic"),
        "status": request_json(
            base_url,
            secret,
            "GET",
            "/agentmemory/semantic/status",
        ),
        "diagnostics": request_json(
            base_url,
            secret,
            "POST",
            "/agentmemory/diagnostics",
            {},
        ),
        "reaper": request_json(
            base_url,
            secret,
            "POST",
            "/agentmemory/session/reap",
            {"dryRun": True, "thresholdHours": 24, "limit": 50},
        ),
    }


def normalized(value: str) -> str:
    return re.sub(
        r"\s+",
        " ",
        unicodedata.normalize("NFKC", value).lower(),
    ).strip()


def canonical(value: str) -> str:
    return " ".join(re.findall(r"[\w가-힣]+", normalized(value), re.UNICODE))


def tokens(value: str) -> set[str]:
    result: set[str] = set()
    for word in re.findall(r"[0-9a-zA-Z_]+|[가-힣]+", normalized(value)):
        result.add(word)
        if re.fullmatch(r"[가-힣]+", word) and len(word) >= 4:
            result.update(word[index : index + 2] for index in range(len(word) - 1))
    return result


def numeric_signature(value: str) -> tuple[str, ...]:
    return tuple(
        sorted(
            re.findall(
                r"(?<![A-Za-z])[#vV]?\d+(?:\.\d+)*(?:-[A-Za-z0-9.]+)?",
                value,
            )
        )
    )


def negation_signature(value: str) -> tuple[bool, ...]:
    text = f" {normalized(value)} "
    return tuple(
        marker in text
        for marker in [
            " not ",
            " no ",
            " never ",
            " without ",
            " cannot ",
            " don't ",
            " doesn't ",
            "않",
            "아니",
            "없",
            "금지",
        ]
    )


def lifecycle_signature(value: str) -> tuple[str, ...]:
    text = normalized(value)
    return tuple(
        marker
        for marker in [
            "planned",
            "proposed",
            "pending",
            "currently",
            "implemented",
            "completed",
            "fixed",
            "removed",
            "deprecated",
            "enabled",
            "disabled",
            "failing",
            "passing",
            "draft",
            "released",
        ]
        if marker in text
    )


def semantic_metrics(rows: list[dict[str, Any]]) -> dict[str, int]:
    exact: dict[str, list[str]] = defaultdict(list)
    for row in rows:
        key = canonical(str(row.get("fact", "")))
        if key:
            exact[key].append(str(row.get("id", "")))
    exact_groups = sum(1 for ids in exact.values() if len(ids) > 1)

    source_groups: dict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        source = tuple(sorted(str(value) for value in row.get("sourceSessionIds", [])))
        if source:
            source_groups[source].append(row)

    same_source_pairs = 0
    for group in source_groups.values():
        for left_index in range(len(group)):
            for right_index in range(left_index + 1, len(group)):
                left = str(group[left_index].get("fact", ""))
                right = str(group[right_index].get("fact", ""))
                if numeric_signature(left) != numeric_signature(right):
                    continue
                if negation_signature(left) != negation_signature(right):
                    continue
                if lifecycle_signature(left) != lifecycle_signature(right):
                    continue
                left_tokens = tokens(left)
                right_tokens = tokens(right)
                if not left_tokens or not right_tokens:
                    continue
                intersection = len(left_tokens & right_tokens)
                jaccard = intersection / len(left_tokens | right_tokens)
                sequence = difflib.SequenceMatcher(
                    None,
                    normalized(left),
                    normalized(right),
                    autojunk=False,
                ).ratio()
                if jaccard >= 0.85 or sequence >= 0.92:
                    same_source_pairs += 1
    return {
        "exactGroups": exact_groups,
        "sameSourcePairs": same_source_pairs,
    }


def read_state(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def write_state(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-dir", type=Path)
    parser.add_argument(
        "--state-file",
        type=Path,
        default=Path.home() / ".hermes/state/agentmemory-quality-audit.json",
    )
    args = parser.parse_args()

    try:
        inputs = load_inputs(args.fixture_dir)
        rows = list(inputs["semantic"].get("semantic", []))
        quality = semantic_metrics(rows)
        semantic_status = inputs["status"].get("semantic", {})
        projects = list(inputs["status"].get("projects", []))
        diagnostics = inputs["diagnostics"].get("summary", {})
        stale = int(inputs["reaper"].get("candidateCount") or 0)
        current_count = len(rows)
        prior = read_state(args.state_file)
        prior_count = prior.get("semanticCount")
        delta = current_count - int(prior_count) if isinstance(prior_count, int) else None
        pending = sum(int(project.get("pendingSummaries") or 0) for project in projects)
        max_pending = max(
            [int(project.get("pendingSummaries") or 0) for project in projects] or [0]
        )
        scoped = int(semantic_status.get("projectScoped") or 0)
        legacy = int(semantic_status.get("legacyUnscoped") or 0)
        warn = int(diagnostics.get("warn") or 0)
        fail = int(diagnostics.get("fail") or 0)
        passed = int(diagnostics.get("pass") or 0)
        warnings: list[str] = []
        if quality["exactGroups"]:
            warnings.append("exact_duplicates")
        if quality["sameSourcePairs"]:
            warnings.append("same_source_duplicates")
        if delta is not None and delta > 50:
            warnings.append("semantic_growth")
        if max_pending > 20:
            warnings.append("watermark_backlog")
        if warn or fail:
            warnings.append("diagnostics")
        if stale:
            warnings.append("stale_sessions")

        delta_text = "first" if delta is None else f"{delta:+d}"
        warning_text = ",".join(warnings) if warnings else "none"
        print(
            "AgentMemory 주간 품질 감사"
            f" | health={inputs['health'].get('status', 'unknown')}"
            f" | semantic={current_count} delta={delta_text}"
            f" | scoped={scoped} legacy={legacy}"
            f" | exactGroups={quality['exactGroups']}"
            f" | sameSourcePairs={quality['sameSourcePairs']}"
            f" | pending={pending} maxPending={max_pending}"
            f" | stale={stale}"
            f" | diagnose={passed}/{warn}/{fail}"
            f" | warnings={warning_text}"
        )
        write_state(
            args.state_file,
            {
                "at": datetime.now(timezone.utc).isoformat(),
                "semanticCount": current_count,
                "projectScoped": scoped,
                "legacyUnscoped": legacy,
                "exactGroups": quality["exactGroups"],
                "sameSourcePairs": quality["sameSourcePairs"],
                "pendingSummaries": pending,
                "staleSessions": stale,
            },
        )
        return 0
    except Exception as error:
        print(f"AgentMemory 주간 품질 감사 | ERROR={type(error).__name__}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
