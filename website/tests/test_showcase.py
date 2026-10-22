"""Check that published downloads do not depend on the packaging host."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

root = Path(__file__).resolve().parents[2]


class ShowcaseTests(unittest.TestCase):
    def test_windows_and_posix_checkouts_produce_identical_downloads_and_evidence(self):
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
            for name in ["Z.txt", "a.txt"]:
                (checkout / "samples/Trail/demo" / name).write_text(name + "\n")

            def generate(host):
                # Exercise host defaults even when CI runs on only one operating system.
                simulate_host = """
import pathlib, runpy, sys, zipfile
host, script = sys.argv[1:]
path_type = type(pathlib.Path())
path_type.__lt__ = lambda a, b: (
    a.as_posix().casefold() < b.as_posix().casefold() if host == "windows"
    else a.as_posix() < b.as_posix())
zip_init = zipfile.ZipInfo.__init__
def init(self, *args, **kwargs):
    zip_init(self, *args, **kwargs)
    self.create_system = 0 if host == "windows" else 3
zipfile.ZipInfo.__init__ = init
# Different compressor versions can produce different valid DEFLATE streams.
compressobj = zipfile.zlib.compressobj
zipfile.zlib.compressobj = lambda level, *args, **kwargs: compressobj(
    1 if host == "windows" else 9, *args, **kwargs)
write_text = path_type.write_text
def write(self, data, *args, **kwargs):
    kwargs.setdefault("newline", "\\r\\n" if host == "windows" else "\\n")
    return write_text(self, data, *args, **kwargs)
path_type.write_text = write
runpy.run_path(script, run_name="__main__")
"""
                subprocess.run([sys.executable, "-c", simulate_host, host,
                                str(site / "scripts/prepare-showcase.py")],
                               check=True, capture_output=True)
                files = [*sorted((site / "static/downloads").glob("*.zip")),
                         *sorted((site / "src/data").glob("*.json"))]
                self.assertEqual(len(files), 5)
                return {file.relative_to(site).as_posix(): file.read_bytes() for file in files}

            files = [file for file in (checkout / "samples").rglob("*") if file.is_file()]
            for file in files:
                file.write_bytes(file.read_bytes().replace(b"\r\n", b"\n"))
            lf = generate("posix")
            for file in files:
                file.write_bytes(file.read_bytes().replace(b"\n", b"\r\n"))
            crlf = generate("windows")
            for name in lf:
                with self.subTest(artifact=name):
                    self.assertEqual(lf[name], crlf[name], name)
            report = json.loads(crlf["src/data/trail-report.json"])
            self.assertGreater(len(report["files"]), 0)
            self.assertEqual(report["totalBytes"], sum(row["bytes"] for row in report["files"]))


if __name__ == "__main__":
    unittest.main()
