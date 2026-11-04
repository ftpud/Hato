#!/usr/bin/env python3
"""Resolve a release label and its Cargo/Apple-compatible numeric version."""
import os
import re
import subprocess
import tomllib

requested = os.environ.get('RELEASE_VERSION', '').strip()
pattern = re.compile(r'^(?:v|[A-Za-z][A-Za-z0-9]*-)?(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$')
if requested:
    match = pattern.fullmatch(requested)
    if not match:
        raise SystemExit('Use a version such as 0.2.0, Beta-0.0.1, or 0.2.0-beta.1')
    label = requested
    numeric = '.'.join(str(int(n)) for n in match.groups())
else:
    tags = subprocess.check_output(['git', 'tag', '--list'], text=True).splitlines()
    versions = [tuple(map(int, m.groups())) for tag in tags if (m := pattern.fullmatch(tag))]
    versions.append(tuple(map(int, tomllib.load(open('Cargo.toml', 'rb'))['package']['version'].split('.'))))
    major, minor, _ = max(versions)
    numeric = label = f'{major}.{minor + 1}.0'
if subprocess.run(['git', 'rev-parse', '--verify', '--quiet', f'refs/tags/{label}'], stdout=subprocess.DEVNULL).returncode == 0:
    raise SystemExit(f'Tag {label} already exists; choose a new version')
prerelease = label.removeprefix('v') != numeric
values = {'version': label, 'numeric': numeric, 'prerelease': str(prerelease).lower()}
for key, value in values.items():
    print(f'{key}={value}')
if output := os.environ.get('GITHUB_OUTPUT'):
    with open(output, 'a') as file:
        for key, value in values.items():
            file.write(f'{key}={value}\n')
