#!/usr/bin/env python3
# Convert the source artwork into the Windows icon that build.rs embeds, preserving alpha. Needs Pillow.
#   tools/windows/build-icon.py [assets/hato-icon.png] [assets/hato.ico]
import sys
from PIL import Image

source = sys.argv[1] if len(sys.argv) > 1 else "assets/hato-icon.png"
destination = sys.argv[2] if len(sys.argv) > 2 else "assets/hato.ico"
sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
Image.open(source).convert("RGBA").save(destination, sizes=[(s, s) for s in sizes])
