"""Verify the original Swift counterpart displayed in the language bridge."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
result = subprocess.run(["swift", str(root / "samples/SwiftBridge/example.swift")],
                        capture_output=True, text=True, timeout=120)
if result.returncode:
    raise RuntimeError(result.stdout + result.stderr)
assert result.stdout == "3, 0\nno position\ntrue\n", result.stdout
assert not result.stderr, result.stderr
print("Verified the Swift bridge counterpart.")
