#!/usr/bin/env python3
"""Summarize xctrace metal-gpu-intervals export for one fixture process.

Group by command buffer, not display frame: offscreen render_to_image doesn't present.
Active fragment intervals are summed per buffer. Vertex/fragment can overlap; don't add them.
"""
import argparse
import collections
import json
import statistics
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument("xml")
parser.add_argument("pid", type=int)
parser.add_argument("--skip", type=int, default=20, help="skip initial command buffers (startup/warmup)")
parser.add_argument("--trim-end", type=int, default=1)
args = parser.parse_args()
root = ET.parse(args.xml).getroot()
ids = {e.attrib["id"]: e for e in root.iter() if "id" in e.attrib}


def resolve(e):
    return ids[e.attrib["ref"]] if "ref" in e.attrib else e


def value(e):
    return resolve(e).text or ""


schema = root.find(".//schema[@name='metal-gpu-intervals']")
if schema is None:
    raise SystemExit("No metal-gpu-intervals table in export")
columns = {col.findtext("mnemonic"): i for i, col in enumerate(schema.findall("col"))}
buffers = {}
for row in root.iter("row"):
    cells = list(row)
    process = resolve(cells[columns["process"]])
    pid = process.find("pid")
    if pid is None or int(value(pid)) != args.pid or value(cells[columns["state"]]) != "Active":
        continue
    key = value(cells[columns["cmdbuffer-id"]])
    b = buffers.setdefault(key, {"start": int(value(cells[columns["start"]])), "fragment": 0., "vertex": 0., "encoders": set()})
    channel = value(cells[columns["channel-name"]]).lower()
    if channel in ("fragment", "vertex"):
        b[channel] += int(value(cells[columns["duration"]])) / 1e6
        if channel == "fragment":
            b["encoders"].add(value(cells[columns["encoder-id"]]))
ordered = sorted((b for b in buffers.values() if b["fragment"] > 0), key=lambda b: b["start"])
kept = ordered[args.skip:len(ordered) - args.trim_end if args.trim_end else None]
if not kept:
    raise SystemExit(f"No buffers remain ({len(ordered)} found); check PID/skip")
durations = sorted(b["fragment"] for b in kept)
print(json.dumps({
    "pid": args.pid, "buffers_found": len(ordered), "buffers_measured": len(kept),
    "fragment_ms_per_buffer": {"mean": statistics.mean(durations), "p50": statistics.median(durations),
                               "p95": durations[round((len(durations) - 1) * .95)], "min": min(durations), "max": max(durations)},
    "vertex_ms_per_buffer_mean": statistics.mean(b["vertex"] for b in kept),
    "fragment_encoders_per_buffer": dict(collections.Counter(len(b["encoders"]) for b in kept)),
    "note": "Active GPU intervals; no CPU image readback. Vertex and fragment may overlap. Startup buffers excluded, not all warmup boundaries.",
}, indent=2))
