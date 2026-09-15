---
title: "Build Trail: a workspace inventory"
description: "Build a complete G# application with data classes, nullable filters, bounded channels, resource cleanup, and .NET JSON."
sidebar_position: 2
---

# Build Trail: a workspace inventory

Trail scans local project files, computes SHA-256 hashes, and writes a sorted JSON report. This walkthrough connects language concepts to one complete program instead of a collection of unrelated fragments.

**Verified example:** G# SDK 0.4.591 and .NET 10. The project is original code; Oahu's task-oriented workflows and goo's concrete G# examples informed the presentation, not its implementation.

## 1. Run the complete project

Install the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0), download [Trail for SDK 0.4.591](/downloads/trail-0.4.591.zip), and unzip it. From the extracted `Trail` directory:

```bash
dotnet run -- demo
dotnet run -- demo .txt
```

The download contains `Trail.gsproj`, `Program.gs`, a README, and three small demo files. The first command reports all three files; the second reports the two text files. The [project overview](/trail) shows the complete expected JSON.

No account, API key, GUI framework, or additional NuGet package is required. The program uses the .NET base class library and the G# SDK runtime.

## 2. Describe success and failure with data

Open `Program.gs`. The following excerpts come from the complete downloaded project:

```gsharp
public data class FileEntry(Path string, Bytes int64, Sha256 string?, Error string?)
public data class Inventory(Files []FileEntry, TotalBytes int64, Failed int32)
```

The nullable fields make the result shape explicit: a successful read has a hash and no error; a failed read records an error and no hash. `Bytes` and `TotalBytes` are `int64`, not counters limited to a 32-bit file size.

**Try it:** find the code that increments `Failed`. Why does the program return a nonzero exit code even though it produced a JSON report?

<details>
<summary>Reasoning</summary>

The report can describe individual failures without pretending every file succeeded. Exit code `1` lets a script detect that outcome; the `error` fields explain it.

</details>

## 3. Make the optional filter explicit

The extension is a `string?`. In `discover`, `if let` supplies a non-null suffix only when the caller provided one:

```gsharp
if let suffix = extension {
    if !path.EndsWith(suffix, StringComparison.OrdinalIgnoreCase) {
        continue
    }
}
```

This excerpt sits inside the discovery loop. The command boundary first validates that an extension resembles `.txt` and does not contain a path separator.

**Try it:** run `dotnet run -- demo .TXT`. It should select the same files as `.txt`. Then run `dotnet run -- demo txt` and inspect the error and exit code.

## 4. Coordinate a bounded worker pool

Discovery owns the jobs channel. Four workers read those paths and send `FileEntry` values to the results channel. One collector owns the list:

```gsharp
func worker(root string, jobs in chan[string], results out chan[FileEntry]) {
    for path in jobs {
        results <- inspect(path, root)
    }
}
```

The directional types make ownership readable: workers can receive jobs and send results. Both channels have a capacity of eight, so the producer cannot queue unlimited unread work.

The `inspectAll` coordinator joins the workers in a nested `scope` and closes the results channel in `finally`. Discovery also closes its output in `finally`. The outer scope runs both stages while the caller drains results; waiting for every worker before draining a bounded result channel could deadlock.

The final sort makes the report's order stable even though worker completion order can vary.

**Try it:** create more than eight small files in a temporary demo directory and run Trail there. The verification script uses forty files to exercise work beyond the channel capacities.

## 5. Use .NET for files, hashes, and JSON

`inspect` opens a file with `using let`, passes its stream to `SHA256.HashData`, and converts the digest with `Convert.ToHexString`. The stream is disposed on both successful and exceptional paths.

`JsonSerializer` emits the final data model. `IncludeFields` includes public fields, `PropertyNamingPolicy` gives the report camel-case names, and `WriteIndented` makes the result readable.

**Try it:** redirect the result to a file outside the directory being scanned:

```bash
dotnet run -- demo > report.json
```

Do not create the output inside the scan directory: the output file itself could then become part of the inventory.

## 6. Inspect behavior in your editor

Open the extracted folder in VS Code with the [G# extension](../tooling/vscode.md). Completion and hover use the same .NET types the project builds against.

Set a breakpoint inside `inspect` and use the extension's **GSharp: Generate Build & Debug Assets** command to create launch settings. Pass `demo` as the program argument; see [debugging](../tooling/debugging.md) for the required managed debugger.

Watch a successful `FileEntry`, the nullable `extension`, and the collected result list. Do not infer execution order from where a worker happens to stop at a breakpoint.

## Limits and verification

Trail is a read-only example for ordinary local project files, not a filesystem security sandbox. It skips links encountered during enumeration and rejects a symbolic-link root. Files may change while a report is being produced, and all report metadata is retained in memory.

Per-file IO/access failures appear in JSON. A traversal failure aborts the scan and is reported on stderr rather than emitting a misleading partial success. Exit codes are `0` for success, `1` for operational failure, and `2` for invalid arguments.

In a clone of the G# repository:

```bash
python3 website/tests/verify-trail.py
```

The check builds the downloadable project, compares its hashes with an independent implementation, and covers filtering, empty input, queued workloads, errors, and supported link cases.

## Where next?

- Compare familiar concepts in [G# for Kotlin developers](../bridges/gsharp-for-kotlin-developers.md), [for C# developers](../bridges/gsharp-for-csharp-developers.md), or [for Go developers](../bridges/gsharp-for-go-developers.md).
- Explore [scope and cancellation](../guide/concurrency.md) and [channel operations](../extensions/go-concurrency.md).
- Read [CLR interop](../ref/clr-interop.md) when integrating another .NET library.
