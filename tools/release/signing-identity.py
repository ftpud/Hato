"""Resolve the imported Developer ID identity by hash, avoiding name encoding issues."""
import re
import subprocess
import sys

result = subprocess.run(
    ["security", "find-identity", "-v", "-p", "codesigning", sys.argv[1]],
    check=True, capture_output=True, text=True,
)
identities = re.findall(
    r'^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"Developer ID Application:[^"\n]+"',
    result.stdout, re.MULTILINE,
)
if len(identities) != 1:
    sys.exit(
        f"Expected one valid Developer ID Application identity in the temporary keychain; "
        f"found {len(identities)}. Check the exported .p12 includes its private key "
        "and the certificate is valid and trusted."
    )
print(identities[0])
