"""Set build-only package versions, without committing a version bump."""
import os
import re
from pathlib import Path
version = os.environ['NUMERIC_VERSION']
for filename in ['Cargo.toml', 'Cargo.lock']:
    path = Path(filename)
    text = path.read_text()
    if filename.endswith('.toml'):
        text, count = re.subn(r'(?m)^version = "[^"]+"', f'version = "{version}"', text, count=1)
    else:
        text, count = re.subn(r'(\[\[package\]\]\nname = "hato"\nversion = ")[^"]+', rf'\g<1>{version}', text)
    assert count == 1, f'Cannot locate hato version in {filename}'
    path.write_text(text)
