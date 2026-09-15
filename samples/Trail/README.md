# Trail

A small, original G# application that inventories local project files and writes a JSON report. It uses the published G# SDK, the .NET base class library, and no other packages.

## Run

Install the .NET 10 SDK, then from this directory:

```sh
dotnet run -- demo
dotnet run -- demo .txt
```

From the repository root:

```sh
dotnet run --project samples/Trail -- samples/Trail/demo
```

The optional extension filter is case-insensitive and includes its leading dot. Omit it to inspect all discovered files. Paths in the report are relative and sorted; SHA-256 values come from streaming file reads.

## What to explore

- `FileEntry` and `Inventory`: data classes describing the report.
- `string?` and `if let`: an optional extension filter.
- `discover`, `worker`, and `inspectAll`: directional channels and explicit ownership.
- `scope`: joining the worker pool before closing its result stream.
- `using let`: disposing each file stream.
- .NET IO, cryptography, collections, and JSON serialization.

Four workers read from an eight-item queue. A second eight-item channel carries results back to the caller, which is the only writer to the report list. Each stage closes the channel it owns in `finally`, including when work fails.

The program is read-only. It skips symbolic links found during enumeration and rejects a symbolic-link root. It is an example for ordinary local project files, not a sandbox for adversarial or special-device filesystems. Files can change during a scan, and the complete metadata report is held in memory. Review filenames and metadata before sharing a report.

Exit code `0` means success, `1` means a file or scan failed, and `2` means invalid arguments. Per-file IO/access failures appear in the report's `error` field and affect the exit code; traversal failures are reported on stderr instead of emitting an incomplete success report.

## Verify

From the G# repository root:

```sh
python3 website/tests/verify-trail.py
```

This checks the report against independent Python hashes, extension filtering, bounded-queue workloads, empty directories, invalid inputs, and supported failure/link cases.

Trail is original code under the repository's MIT license. Oahu's task-oriented workflows and goo's concrete G# examples informed the website's presentation, but no code or assets were copied from either project.
