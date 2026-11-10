#!/usr/bin/env python3
"""Capture a Hato window, optionally cropping a panel/element in window-relative points."""
import argparse
import json
import platform
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from datetime import datetime


def run(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"{args[0]} failed")
    return result.stdout


def crop_rect(value):
    try:
        values = tuple(float(part) for part in value.split(','))
        if len(values) != 4 or values[0] < 0 or values[1] < 0 or values[2] <= 0 or values[3] <= 0:
            raise ValueError()
        return values
    except ValueError:
        raise argparse.ArgumentTypeError('Use x,y,width,height in window-relative points; width/height must be positive.')


def capture(args):
    if platform.system() != 'Darwin':
        raise RuntimeError('This helper currently supports macOS (screencapture and sips).')
    source = Path(__file__).with_name('hato-windows.swift')
    cache = Path(tempfile.gettempdir()) / 'hato-screenshot-swift-cache'
    cache.mkdir(exist_ok=True)
    windows = json.loads(run(['swift', '-module-cache-path', str(cache), str(source)]))
    matches = [w for w in windows if w['owner'].casefold() == args.app.casefold()]
    if args.window_id is not None:
        matches = [w for w in matches if w['id'] == args.window_id]
    if args.title:
        matches = [w for w in matches if args.title.casefold() in w['title'].casefold()]
    if args.list:
        print(json.dumps(matches, indent=2))
        return
    if not matches:
        raise RuntimeError(f'No visible {args.app} window found. Use --list or specify --app / --window-id.')
    if len(matches) != 1:
        raise RuntimeError('Multiple matching windows; select --window-id from --list.\n' + json.dumps(matches, indent=2))
    window = matches[0]
    output = Path(args.output or Path(tempfile.gettempdir()) / f'hato-{datetime.now():%Y%m%d-%H%M%S-%f}.png').resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() or output.with_suffix('.json').exists():
        raise RuntimeError(f'Output already exists: {output}. Choose a new filename.')
    with tempfile.TemporaryDirectory(prefix='hato-capture-') as directory:
        full = Path(directory) / 'window.png'
        try:
            run(['/usr/sbin/screencapture', '-x', '-o', '-l', str(window['id']), str(full)])
        except RuntimeError as error:
            raise RuntimeError(f'Window capture failed: {error}. Check macOS Screen Recording permission for the terminal/agent application, then retry.')
        dimensions = run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', str(full)])
        width = int(re.search(r'pixelWidth:\s*(\d+)', dimensions)[1])
        height = int(re.search(r'pixelHeight:\s*(\d+)', dimensions)[1])
        rect = args.crop
        if rect:
            x, y, w, h = rect
            bounds = window['bounds']
            if x + w > bounds['Width'] or y + h > bounds['Height']:
                raise RuntimeError(f'Crop lies outside {bounds["Width"]}×{bounds["Height"]} window points.')
            sx, sy = width / bounds['Width'], height / bounds['Height']
            run(['sips', '--cropToHeightWidth', str(round(h * sy)), str(round(w * sx)), '--cropOffset', str(round(y * sy)), str(round(x * sx)), str(full), '--out', str(output)])
        else:
            full.replace(output)
    metadata = {'image': str(output), 'window': window, 'windowPixels': [width, height],
                'cropPoints': rect, 'label': args.label, 'capturedAt': datetime.now().astimezone().isoformat()}
    output.with_suffix('.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps(metadata, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--list', action='store_true', help='List matching windows; do not capture.')
    parser.add_argument('--app', default='hato', help='Exact window owner, case-insensitive (default: hato).')
    parser.add_argument('--window-id', type=int)
    parser.add_argument('--title', help='Match part of a window title.')
    parser.add_argument('--crop', type=crop_rect, help='Panel/element rectangle x,y,width,height in window-relative points.')
    parser.add_argument('--label', help='Panel or element name recorded in the sidecar.')
    parser.add_argument('-o', '--output', help='PNG path (default: unique file in the temporary directory).')
    try:
        capture(parser.parse_args())
    except (RuntimeError, OSError, ValueError) as error:
        parser.exit(1, f'{error}\n')


if __name__ == '__main__':
    main()
