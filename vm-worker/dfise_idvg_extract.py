#!/usr/bin/env python
# -*- coding: utf-8 -*-
from __future__ import print_function

import argparse
import base64
import binascii
import csv
import datetime
import hashlib
import json
import math
import os
import re
import struct
import sys
import time
import zlib


EXTRACTOR_VERSION = "dfise-idvg-extract/1"
METRIC_PROFILE = "tcad-idvg-v1"
VTH_METHOD = "constant-current-log-interpolation-v1"
SS_METHOD = "max-adjacent-slope-v1"
DIBL_METHOD = "actual-drain-bias-difference-v1"
FALLBACK_WIDTH = 33
FALLBACK_COLUMNS = {
    "gate outervoltage": 9,
    "drain outervoltage": 25,
    "drain totalcurrent": 31,
}
FALLBACK_FUNCTIONS = [
    "time",
    "outervoltage",
    "innervoltage",
    "quasifermipotential",
    "displacementcurrent",
    "ecurrent",
    "hcurrent",
    "totalcurrent",
    "charge",
    "outervoltage",
    "innervoltage",
    "quasifermipotential",
    "displacementcurrent",
    "ecurrent",
    "hcurrent",
    "totalcurrent",
    "charge",
    "outervoltage",
    "innervoltage",
    "quasifermipotential",
    "displacementcurrent",
    "ecurrent",
    "hcurrent",
    "totalcurrent",
    "charge",
    "outervoltage",
    "innervoltage",
    "quasifermipotential",
    "displacementcurrent",
    "ecurrent",
    "hcurrent",
    "totalcurrent",
    "charge",
]
INVALID_INPUT_CODES = set([
    "BIAS_MISMATCH",
    "BIAS_ORDER_INVALID",
    "DATASET_NOT_FOUND",
    "INVALID_ARGUMENT",
    "MALFORMED_DATA_BLOCK",
    "UNSUPPORTED_METRIC_PROFILE",
    "UNSUPPORTED_SS_METHOD",
])
INCOMPLETE_CODES = set([
    "INSUFFICIENT_POINTS",
    "NO_VALID_POINTS",
    "NONFINITE_METRIC",
    "SS_WINDOW_NOT_COVERED",
    "VTH_NOT_COVERED",
])
NUMBER_RE = re.compile(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][-+]?\d+)?")
QUOTED_RE = re.compile(r'"((?:[^"\\]|\\.)*)"')


try:
    text_type = unicode
except NameError:
    text_type = str


class ExtractionError(Exception):
    def __init__(self, code, message, details=None):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.details = details or {}


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def finite(value):
    return isinstance(value, (int, float)) and not math.isnan(value) and not math.isinf(value)


def normalize_name(value):
    return " ".join((value or "").strip().lower().split())


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def read_text(path):
    with open(path, "rb") as handle:
        raw = handle.read()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def extract_balanced_blocks(text, keyword):
    blocks = []
    pattern = re.compile(r"\b%s\s*\{" % re.escape(keyword), re.IGNORECASE)
    for match in pattern.finditer(text):
        start = match.end()
        depth = 1
        index = start
        while index < len(text) and depth:
            char = text[index]
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
            index += 1
        if depth == 0:
            blocks.append(text[start:index - 1])
    return blocks


def parse_datasets(text):
    match = re.search(r"\bdatasets\s*=\s*\[(.*?)\]", text, re.IGNORECASE | re.DOTALL)
    if not match:
        return []
    return [bytes(value, "utf-8").decode("unicode_escape") if sys.version_info[0] >= 3 else value.decode("string_escape") for value in QUOTED_RE.findall(match.group(1))]


def parse_functions(text):
    match = re.search(r"\bfunctions\s*=\s*\[(.*?)\]", text, re.IGNORECASE | re.DOTALL)
    if not match:
        return []
    block = match.group(1)
    quoted = QUOTED_RE.findall(block)
    if quoted:
        return [normalize_name(value) for value in quoted]
    return [normalize_name(value) for value in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", block)]


def parse_numbers(block):
    residual = NUMBER_RE.sub("", block)
    if re.sub(r"[\s,()]+", "", residual):
        raise ExtractionError("MALFORMED_DATA_BLOCK", "DF-ISE Data block contains unsupported non-numeric content")
    values = []
    for token in NUMBER_RE.findall(block):
        try:
            values.append(float(token.replace("D", "E").replace("d", "e")))
        except ValueError:
            raise ExtractionError("MALFORMED_DATA_BLOCK", "DF-ISE Data block contains an invalid number", {"token": token})
    return values


def fallback_signature_valid(datasets, functions):
    if datasets and len(datasets) != FALLBACK_WIDTH:
        return False
    return functions == FALLBACK_FUNCTIONS


def column_indexes(datasets, functions, warnings):
    normalized = [normalize_name(item) for item in datasets]
    required = ["gate outervoltage", "drain outervoltage", "drain totalcurrent"]
    if all(name in normalized for name in required):
        return len(datasets), dict((name, normalized.index(name)) for name in required), "dataset-name"
    if fallback_signature_valid(datasets, functions):
        warnings.append("Required dataset names missing; used controlled 33-column DF-ISE function-signature fallback.")
        return FALLBACK_WIDTH, dict(FALLBACK_COLUMNS), "function-signature-fallback"
    if not datasets:
        missing = required
    else:
        missing = [name for name in required if name not in normalized]
    raise ExtractionError("DATASET_NOT_FOUND", "Required DF-ISE datasets are missing and the 33-column fallback signature did not match", {
        "missing": missing,
        "datasetCount": len(datasets),
        "functionCount": len(functions),
        "fallbackSignatureValid": False,
    })


def dominant_bias(rows, vd_index):
    buckets = {}
    for row in rows:
        value = row[vd_index]
        if not finite(value):
            continue
        key = round(value, 12)
        buckets[key] = buckets.get(key, 0) + 1
    if not buckets:
        raise ExtractionError("NO_VALID_POINTS", "No finite drain-bias values were found")
    return max(buckets, key=lambda key: (buckets[key], abs(key))), buckets


def dedupe_points(rows, indexes, actual_vd, bias_tolerance):
    by_vg = {}
    duplicate_count = 0
    for row in rows:
        vg = row[indexes["gate outervoltage"]]
        vd = row[indexes["drain outervoltage"]]
        current = abs(row[indexes["drain totalcurrent"]])
        if not finite(vg) or not finite(vd) or not finite(current) or current <= 0:
            continue
        if abs(vd - actual_vd) > bias_tolerance:
            continue
        key = round(vg, 14)
        existing = by_vg.get(key)
        if existing is not None:
            duplicate_count += 1
        if existing is None or current > existing[1]:
            by_vg[key] = (vg, current)
    points = sorted(by_vg.values(), key=lambda item: item[0])
    return points, duplicate_count


def parse_curve(path, min_points, bias_tolerance):
    text = read_text(path)
    datasets = parse_datasets(text)
    functions = parse_functions(text)
    warnings = []
    width, indexes, column_resolution = column_indexes(datasets, functions, warnings)
    candidates = []
    blocks = extract_balanced_blocks(text, "Data")
    if not blocks:
        raise ExtractionError("MALFORMED_DATA_BLOCK", "DF-ISE file has no Data block", {"path": path})
    for block_index, block in enumerate(blocks):
        values = parse_numbers(block)
        if not values:
            continue
        if len(values) % width:
            raise ExtractionError("MALFORMED_DATA_BLOCK", "DF-ISE numeric count is not divisible by record width", {
                "path": path,
                "blockIndex": block_index,
                "valueCount": len(values),
                "recordWidth": width,
            })
        rows = [values[offset:offset + width] for offset in range(0, len(values), width)]
        actual_vd, bias_counts = dominant_bias(rows, indexes["drain outervoltage"])
        points, duplicate_count = dedupe_points(rows, indexes, actual_vd, bias_tolerance)
        candidates.append({
            "blockIndex": block_index,
            "rows": rows,
            "points": points,
            "actualVd": actual_vd,
            "biasCounts": bias_counts,
            "duplicateCount": duplicate_count,
        })
    if not candidates:
        raise ExtractionError("NO_VALID_POINTS", "DF-ISE file has no usable Data block", {"path": path})
    selected = max(candidates, key=lambda item: (len(item["points"]), len(item["rows"])))
    points = selected["points"]
    if len(points) < min_points:
        raise ExtractionError("INSUFFICIENT_POINTS", "Selected DF-ISE curve has too few valid points", {
            "path": path,
            "validPointCount": len(points),
            "minimumPointCount": min_points,
            "selectedBlock": selected["blockIndex"],
        })
    return {
        "path": path,
        "sha256": sha256_file(path),
        "datasetCount": width,
        "functionCount": len(functions),
        "columnResolution": column_resolution,
        "actualVd": selected["actualVd"],
        "points": points,
        "validPointCount": len(points),
        "duplicateCount": selected["duplicateCount"],
        "vgMin": points[0][0],
        "vgMax": points[-1][0],
        "idMin": min(item[1] for item in points),
        "idMax": max(item[1] for item in points),
        "selectedDataBlock": selected["blockIndex"],
        "dataBlockCount": len(candidates),
        "warnings": warnings,
    }


def calculate_vth(points, target_current):
    for index in range(1, len(points)):
        vg0, id0 = points[index - 1]
        vg1, id1 = points[index]
        if id0 == target_current:
            return vg0
        if id0 < target_current <= id1:
            if id0 <= 0 or id1 <= 0 or vg1 == vg0:
                break
            log0 = math.log10(id0)
            log1 = math.log10(id1)
            if log1 == log0:
                break
            fraction = (math.log10(target_current) - log0) / (log1 - log0)
            return vg0 + fraction * (vg1 - vg0)
    if points and points[-1][1] == target_current:
        return points[-1][0]
    raise ExtractionError("VTH_NOT_COVERED", "Curve does not cross the constant-current Vth target", {
        "targetCurrentAperUm": target_current,
        "idMinAperUm": min(item[1] for item in points),
        "idMaxAperUm": max(item[1] for item in points),
    })


def calculate_ss(points, current_min, current_max):
    best_slope = None
    usable_pairs = 0
    window_points = [item for item in points if current_min <= item[1] <= current_max]
    for index in range(1, len(points)):
        vg0, id0 = points[index - 1]
        vg1, id1 = points[index]
        if not (current_min <= id0 <= current_max and current_min <= id1 <= current_max):
            continue
        if vg1 <= vg0 or id0 <= 0 or id1 <= 0:
            continue
        slope = (math.log10(id1) - math.log10(id0)) / (vg1 - vg0)
        if slope <= 0:
            continue
        usable_pairs += 1
        if best_slope is None or slope > best_slope:
            best_slope = slope
    if best_slope is None or usable_pairs < 1:
        raise ExtractionError("SS_WINDOW_NOT_COVERED", "Curve does not contain enough adjacent points in the SS current window", {
            "ssCurrentMinAperUm": current_min,
            "ssCurrentMaxAperUm": current_max,
            "windowPointCount": len(window_points),
            "idMinAperUm": min(item[1] for item in points),
            "suggestedSweepDirection": "extend Vg lower" if points[0][1] > current_min else "extend Vg range",
        })
    return 1000.0 / best_slope, len(window_points), usable_pairs


def validate_expected_bias(curve, expected, tolerance, label):
    if expected is None:
        return
    if abs(curve["actualVd"] - expected) > tolerance:
        raise ExtractionError("BIAS_MISMATCH", "%s curve actual Vd does not match expected Vd" % label, {
            "curve": label,
            "expectedVd": expected,
            "actualVd": curve["actualVd"],
            "toleranceV": tolerance,
        })


def stable_number(value):
    if value is None:
        return ""
    return "%.12g" % value


def merged_rows(low_points, high_points, low_vd, high_vd):
    low = dict((round(vg, 14), (vg, current)) for vg, current in low_points)
    high = dict((round(vg, 14), (vg, current)) for vg, current in high_points)
    keys = sorted(set(low.keys()) | set(high.keys()))
    rows = []
    for key in keys:
        low_item = low.get(key)
        high_item = high.get(key)
        vg = (low_item or high_item)[0]
        rows.append((vg, low_item[1] if low_item else None, high_item[1] if high_item else None, low_vd, high_vd))
    return rows


def write_csv(path, rows):
    lines = ["Vg_V,Id_low_A_per_um,Id_high_A_per_um,Vd_low_V,Vd_high_V"]
    for row in rows:
        lines.append(",".join(stable_number(value) for value in row))
    data = ("\n".join(lines) + "\n").encode("ascii")
    with open(path, "wb") as handle:
        handle.write(data)


def write_json(path, value):
    data = (json.dumps(value, ensure_ascii=True, indent=2, sort_keys=True) + "\n").encode("utf-8")
    with open(path, "wb") as handle:
        handle.write(data)


def write_text(path, value):
    with open(path, "wb") as handle:
        handle.write(value.encode("utf-8"))


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data) & 0xffffffff)


def rgb_bytes(values):
    if sys.version_info[0] < 3:
        return "".join(chr(value) for value in values)
    return bytes(bytearray(values))


def write_plot_png(path, low_points, high_points):
    width = 900
    height = 540
    left = 80
    right = 30
    top = 30
    bottom = 65
    pixels = [255] * (width * height * 3)

    def set_pixel(x_value, y_value, color):
        x_value = int(x_value)
        y_value = int(y_value)
        if x_value < 0 or x_value >= width or y_value < 0 or y_value >= height:
            return
        offset = (y_value * width + x_value) * 3
        pixels[offset:offset + 3] = color

    def line(x0, y0, x1, y1, color):
        x0 = int(round(x0))
        y0 = int(round(y0))
        x1 = int(round(x1))
        y1 = int(round(y1))
        dx = abs(x1 - x0)
        sx = 1 if x0 < x1 else -1
        dy = -abs(y1 - y0)
        sy = 1 if y0 < y1 else -1
        error = dx + dy
        while True:
            set_pixel(x0, y0, color)
            if x0 == x1 and y0 == y1:
                break
            doubled = 2 * error
            if doubled >= dy:
                error += dy
                x0 += sx
            if doubled <= dx:
                error += dx
                y0 += sy

    all_points = low_points + high_points
    vg_min = min(item[0] for item in all_points)
    vg_max = max(item[0] for item in all_points)
    log_min = math.floor(min(math.log10(item[1]) for item in all_points))
    log_max = math.ceil(max(math.log10(item[1]) for item in all_points))
    if vg_max == vg_min:
        vg_max = vg_min + 1.0
    if log_max == log_min:
        log_max = log_min + 1.0

    def project(point):
        vg, current = point
        x_value = left + (vg - vg_min) * (width - left - right) / (vg_max - vg_min)
        y_value = top + (log_max - math.log10(current)) * (height - top - bottom) / (log_max - log_min)
        return x_value, y_value

    axis = [40, 40, 40]
    grid = [225, 225, 225]
    for power in range(int(log_min), int(log_max) + 1):
        y_value = top + (log_max - power) * (height - top - bottom) / (log_max - log_min)
        line(left, y_value, width - right, y_value, grid)
    line(left, top, left, height - bottom, axis)
    line(left, height - bottom, width - right, height - bottom, axis)
    for points, color in [(low_points, [0, 112, 192]), (high_points, [192, 0, 0])]:
        projected = [project(item) for item in points]
        for index in range(1, len(projected)):
            line(projected[index - 1][0], projected[index - 1][1], projected[index][0], projected[index][1], color)

    raw_rows = []
    for y_value in range(height):
        start = y_value * width * 3
        raw_rows.append(b"\x00" + rgb_bytes(pixels[start:start + width * 3]))
    raw = b"".join(raw_rows)
    png = b"\x89PNG\r\n\x1a\n"
    png += png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += png_chunk(b"IDAT", zlib.compress(raw, 9))
    png += png_chunk(b"IEND", b"")
    with open(path, "wb") as handle:
        handle.write(png)


def output_paths(prefix):
    directory = os.path.dirname(prefix)
    base = os.path.basename(prefix)
    metrics_base = base.replace("idvg", "ss_dibl", 1)
    def output(name):
        return os.path.join(directory, name) if directory else name
    return {
        "csv": output(base + "_extracted.csv"),
        "metricsJson": output(metrics_base + "_metrics.json"),
        "metricsDat": output(metrics_base + "_metrics.dat"),
        "report": output(metrics_base + "_report.txt"),
        "plot": output(base + "_plot.png"),
    }


def success_payload(args, low, high, metrics, outputs):
    return {
        "status": "ok",
        "metricProfile": METRIC_PROFILE,
        "extractorVersion": EXTRACTOR_VERSION,
        "methods": {
            "vth": VTH_METHOD,
            "ss": SS_METHOD,
            "dibl": DIBL_METHOD,
        },
        "units": {
            "gateVoltage": "V",
            "drainVoltage": "V",
            "drainCurrent": "A/um",
            "vth": "V",
            "ss": "mV/dec",
            "dibl": "mV/V",
        },
        "inputs": {
            "low": {
                "path": low["path"],
                "sha256": low["sha256"],
                "size": os.path.getsize(low["path"]),
                "actualVd": low["actualVd"],
                "datasetCount": low["datasetCount"],
                "functionCount": low["functionCount"],
                "columnResolution": low["columnResolution"],
                "validPointCount": low["validPointCount"],
                "duplicateCount": low["duplicateCount"],
                "vgMin": low["vgMin"],
                "vgMax": low["vgMax"],
                "idMin": low["idMin"],
                "idMax": low["idMax"],
                "selectedDataBlock": low["selectedDataBlock"],
            },
            "high": {
                "path": high["path"],
                "sha256": high["sha256"],
                "size": os.path.getsize(high["path"]),
                "actualVd": high["actualVd"],
                "datasetCount": high["datasetCount"],
                "functionCount": high["functionCount"],
                "columnResolution": high["columnResolution"],
                "validPointCount": high["validPointCount"],
                "duplicateCount": high["duplicateCount"],
                "vgMin": high["vgMin"],
                "vgMax": high["vgMax"],
                "idMin": high["idMin"],
                "idMax": high["idMax"],
                "selectedDataBlock": high["selectedDataBlock"],
            },
        },
        "parameters": {
            "expectedLowVd": args.expected_low_vd,
            "expectedHighVd": args.expected_high_vd,
            "biasToleranceV": args.bias_tolerance,
            "vthCurrentAperUm": args.vth_current,
            "ssCurrentMinAperUm": args.ss_current_min,
            "ssCurrentMaxAperUm": args.ss_current_max,
            "minimumPointCount": args.min_points,
        },
        "metrics": metrics,
        "outputs": outputs,
        "warnings": low["warnings"] + high["warnings"],
        "generatedAt": now_iso(),
    }


def write_outputs(args, low, high, metrics):
    outputs = output_paths(args.output_prefix)
    rows = merged_rows(low["points"], high["points"], low["actualVd"], high["actualVd"])
    write_csv(outputs["csv"], rows)
    report_lines = [
        "DF-ISE Id-Vg extraction report",
        "status=ok",
        "metricProfile=%s" % METRIC_PROFILE,
        "extractorVersion=%s" % EXTRACTOR_VERSION,
        "low.path=%s" % low["path"],
        "low.sha256=%s" % low["sha256"],
        "low.actualVd=%s V" % stable_number(low["actualVd"]),
        "low.validPointCount=%s" % low["validPointCount"],
        "high.path=%s" % high["path"],
        "high.sha256=%s" % high["sha256"],
        "high.actualVd=%s V" % stable_number(high["actualVd"]),
        "high.validPointCount=%s" % high["validPointCount"],
        "Vth_low=%s V" % stable_number(metrics["vthLowV"]),
        "Vth_high=%s V" % stable_number(metrics["vthHighV"]),
        "SS_low=%s mV/dec" % stable_number(metrics["ssLowMvPerDec"]),
        "SS_high=%s mV/dec" % stable_number(metrics["ssHighMvPerDec"]),
        "DIBL=%s mV/V" % stable_number(metrics["diblMvPerV"]),
        "",
    ]
    write_text(outputs["report"], "\n".join(report_lines))
    dat_lines = [
        "status=ok",
        "metric_profile=%s" % METRIC_PROFILE,
        "extractor_version=%s" % EXTRACTOR_VERSION,
        "actual_vd_low_v=%s" % stable_number(low["actualVd"]),
        "actual_vd_high_v=%s" % stable_number(high["actualVd"]),
        "vth_low_v=%s" % stable_number(metrics["vthLowV"]),
        "vth_high_v=%s" % stable_number(metrics["vthHighV"]),
        "ss_low_mv_per_dec=%s" % stable_number(metrics["ssLowMvPerDec"]),
        "ss_high_mv_per_dec=%s" % stable_number(metrics["ssHighMvPerDec"]),
        "dibl_mv_per_v=%s" % stable_number(metrics["diblMvPerV"]),
        "",
    ]
    write_text(outputs["metricsDat"], "\n".join(dat_lines))
    write_plot_png(outputs["plot"], low["points"], high["points"])
    return outputs


def error_payload(error, args):
    if error.code in INVALID_INPUT_CODES:
        status = "invalid-input"
    elif error.code in INCOMPLETE_CODES:
        status = "incomplete"
    else:
        status = "failed"
    return {
        "status": status,
        "metricProfile": METRIC_PROFILE,
        "extractorVersion": EXTRACTOR_VERSION,
        "error": {
            "code": error.code,
            "message": error.message,
            "details": error.details,
        },
        "parameters": {
            "expectedLowVd": args.expected_low_vd,
            "expectedHighVd": args.expected_high_vd,
            "biasToleranceV": args.bias_tolerance,
            "vthCurrentAperUm": args.vth_current,
            "ssCurrentMinAperUm": args.ss_current_min,
            "ssCurrentMaxAperUm": args.ss_current_max,
        },
        "generatedAt": now_iso(),
    }


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Fixed Python 2/3 DF-ISE Id-Vg extractor")
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--low")
    parser.add_argument("--high")
    parser.add_argument("--expected-low-vd", type=float)
    parser.add_argument("--expected-high-vd", type=float)
    parser.add_argument("--bias-tolerance", type=float, default=1e-6)
    parser.add_argument("--vth-current", type=float, default=1e-7)
    parser.add_argument("--ss-current-min", type=float, default=1e-12)
    parser.add_argument("--ss-current-max", type=float, default=1e-7)
    parser.add_argument("--ss-method", default=SS_METHOD)
    parser.add_argument("--metric-profile", default=METRIC_PROFILE)
    parser.add_argument("--min-points", type=int, default=20)
    parser.add_argument("--output-prefix", default="idvg")
    parser.add_argument("--stdout-json", action="store_true")
    return parser.parse_args(argv)


def validate_arguments(args):
    numeric_values = [
        ("expected-low-vd", args.expected_low_vd, True),
        ("expected-high-vd", args.expected_high_vd, True),
        ("bias-tolerance", args.bias_tolerance, False),
        ("vth-current", args.vth_current, False),
        ("ss-current-min", args.ss_current_min, False),
        ("ss-current-max", args.ss_current_max, False),
    ]
    for name, value, optional in numeric_values:
        if value is None and optional:
            continue
        if not finite(value):
            raise ExtractionError("INVALID_ARGUMENT", "--%s must be finite" % name)
    if args.bias_tolerance <= 0:
        raise ExtractionError("INVALID_ARGUMENT", "--bias-tolerance must be greater than zero")
    if args.vth_current <= 0:
        raise ExtractionError("INVALID_ARGUMENT", "--vth-current must be greater than zero")
    if args.ss_current_min <= 0 or args.ss_current_max <= 0:
        raise ExtractionError("INVALID_ARGUMENT", "SS current bounds must be greater than zero")
    if args.ss_current_min >= args.ss_current_max:
        raise ExtractionError("INVALID_ARGUMENT", "--ss-current-min must be lower than --ss-current-max")
    if args.min_points < 3:
        raise ExtractionError("INVALID_ARGUMENT", "--min-points must be at least 3")
    if not args.output_prefix or not os.path.basename(args.output_prefix):
        raise ExtractionError("INVALID_ARGUMENT", "--output-prefix must name an output file prefix")


def run(argv=None):
    args = parse_args(argv or sys.argv[1:])
    if args.version:
        print(EXTRACTOR_VERSION)
        return 0
    if not args.low or not args.high:
        print(json.dumps(error_payload(ExtractionError("INVALID_ARGUMENT", "--low and --high are required"), args), sort_keys=True))
        return 2
    try:
        validate_arguments(args)
    except ExtractionError as error:
        print(json.dumps(error_payload(error, args), sort_keys=True))
        return 2
    if args.metric_profile != METRIC_PROFILE:
        print(json.dumps(error_payload(ExtractionError("UNSUPPORTED_METRIC_PROFILE", "Unsupported metric profile", {"metricProfile": args.metric_profile}), args), sort_keys=True))
        return 2
    if args.ss_method not in [SS_METHOD, "max-adjacent-v1"]:
        print(json.dumps(error_payload(ExtractionError("UNSUPPORTED_SS_METHOD", "Unsupported SS method", {"ssMethod": args.ss_method}), args), sort_keys=True))
        return 2
    metrics_path = output_paths(args.output_prefix)["metricsJson"]
    try:
        low = parse_curve(args.low, args.min_points, args.bias_tolerance)
        high = parse_curve(args.high, args.min_points, args.bias_tolerance)
        validate_expected_bias(low, args.expected_low_vd, args.bias_tolerance, "low")
        validate_expected_bias(high, args.expected_high_vd, args.bias_tolerance, "high")
        if high["actualVd"] <= low["actualVd"]:
            raise ExtractionError("BIAS_ORDER_INVALID", "High drain bias must be greater than low drain bias", {
                "actualLowVd": low["actualVd"],
                "actualHighVd": high["actualVd"],
            })
        vth_low = calculate_vth(low["points"], args.vth_current)
        vth_high = calculate_vth(high["points"], args.vth_current)
        ss_low, low_window_points, low_pairs = calculate_ss(low["points"], args.ss_current_min, args.ss_current_max)
        ss_high, high_window_points, high_pairs = calculate_ss(high["points"], args.ss_current_min, args.ss_current_max)
        metrics = {
            "vthLowV": vth_low,
            "vthHighV": vth_high,
            "ssLowMvPerDec": ss_low,
            "ssHighMvPerDec": ss_high,
            "diblMvPerV": 1000.0 * (vth_low - vth_high) / (high["actualVd"] - low["actualVd"]),
            "ssLowWindowPointCount": low_window_points,
            "ssHighWindowPointCount": high_window_points,
            "ssLowAdjacentPairCount": low_pairs,
            "ssHighAdjacentPairCount": high_pairs,
        }
        if not all(finite(value) for key, value in metrics.items() if key.endswith(("V", "Dec"))):
            raise ExtractionError("NONFINITE_METRIC", "Required metric is not finite")
        outputs = write_outputs(args, low, high, metrics)
        payload = success_payload(args, low, high, metrics, outputs)
        write_json(metrics_path, payload)
        print(json.dumps(payload, ensure_ascii=True, sort_keys=True))
        return 0
    except ExtractionError as error:
        payload = error_payload(error, args)
        try:
            write_json(metrics_path, payload)
        except Exception:
            pass
        print(json.dumps(payload, ensure_ascii=True, sort_keys=True))
        return 3
    except Exception as error:
        payload = error_payload(ExtractionError("EXTRACTOR_INTERNAL_ERROR", str(error)), args)
        try:
            write_json(metrics_path, payload)
        except Exception:
            pass
        print(json.dumps(payload, ensure_ascii=True, sort_keys=True))
        return 4


if __name__ == "__main__":
    sys.exit(run())
