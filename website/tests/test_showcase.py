"""Check that published downloads do not depend on checkout line endings."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

root = Path(__file__).resolve().parents[2]


class ShowcaseTests(unittest.TestCase):
    def test_lf_and_crlf_checkouts_produce_identical_downloads_and_evidence(self):
        with tempfile.TemporaryDirectory(prefix="showcase-") as folder:
            checkout = Path(folder)
            for name in ["Trail", "ConcurrencyPatterns"]:
                shutil.copytree(root / "samples" / name, checkout / "samples" / name,
                                ignore=shutil.ignore_patterns("bin", "obj"))
            site = checkout / "website"
            (site / "scripts").mkdir(parents=True)
            (site / "src/data").mkdir(parents=True)
            shutil.copyfile(root / "website/scripts/prepare-showcase.py",
                            site / "scripts/prepare-showcase.py")
            shutil.copyfile(root / "website/src/data/release.json", site / "src/data/release.json")

            def generate():
                subprocess.run([sys.executable, str(site / "scripts/prepare-showcase.py")],
                               check=True, capture_output=True)
                files = [*sorted((site / "static/downloads").glob("*.zip")),
                         *sorted((site / "src/data").glob("*.json"))]
                self.assertEqual(len(files), 5)
                return {file.relative_to(site).as_posix(): file.read_bytes() for file in files}

            files = [file for file in (checkout / "samples").rglob("*") if file.is_file()]
            for file in files:
                file.write_bytes(file.read_bytes().replace(b"\r\n", b"\n"))
            lf = generate()
            for file in files:
                file.write_bytes(file.read_bytes().replace(b"\n", b"\r\n"))
            crlf = generate()
            for name in lf:
                self.assertEqual(lf[name], crlf[name], name)
            report = json.loads(crlf["src/data/trail-report.json"])
            self.assertGreater(len(report["files"]), 0)
            self.assertEqual(report["totalBytes"], sum(row["bytes"] for row in report["files"]))


if __name__ == "__main__":
    unittest.main()
