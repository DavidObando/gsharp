package Trail

import System
import System.Collections.Generic
import System.IO
import System.Security.Cryptography
import System.Text.Json

public data class FileEntry(Path string, Bytes int64, Sha256 string?, Error string?)
public data class Inventory(Files[]FileEntry, TotalBytes int64, Failed int32)

func inspect(path string, root string) FileEntry {
    let relative = Path.GetRelativePath(root, path).Replace('\\', '/')
    try {
        if (File.GetAttributes(path) & FileAttributes.ReparsePoint) == FileAttributes.ReparsePoint {
            return FileEntry(relative, 0, nil, "Symbolic links are not read.")
        }
        using let stream = File.OpenRead(path)
        let digest = SHA256.HashData(stream)
        return FileEntry(relative, stream.Length, Convert.ToHexString(digest).ToLowerInvariant(), nil)
    } catch (e IOException) {
        return FileEntry(relative, 0, nil, e.Message)
    } catch (e UnauthorizedAccessException) {
        return FileEntry(relative, 0, nil, e.Message)
    }
}

func discover(root string, extension string?, jobs out chan[string]) {
    try {
        let options = EnumerationOptions{
            RecurseSubdirectories: true,
            IgnoreInaccessible: false,
            AttributesToSkip: FileAttributes.ReparsePoint
        }
        for path in Directory.EnumerateFiles(root, "*", options) {
            if let suffix = extension {
                if !path.EndsWith(suffix, StringComparison.OrdinalIgnoreCase) {
                    continue
                }
            }
            jobs <- path
        }
    } finally {
        jobs.Close()
    }
}

func worker(root string, jobs in chan[string], results out chan[FileEntry]) {
    for path in jobs {
        results <- inspect(path, root)
    }
}

func inspectAll(root string, jobs in chan[string], results out chan[FileEntry]) {
    try {
        scope {
            for id in 0 ... 4 {
                go worker(root, jobs, results)
            }
        }
    } finally {
        results.Close()
    }
}

func inventory(root string, extension string?) Inventory {
    let jobs = chan[string](8)
    let results = chan[FileEntry](8)
    let entries = List[FileEntry]()
    scope {
        go discover(root, extension, jobs)
        go inspectAll(root, jobs, results)
        for entry in results {
            entries.Add(entry)
        }
    }
    entries.Sort((left FileEntry, right FileEntry) -> String.CompareOrdinal(left.Path, right.Path))
    var bytes int64 = 0
    var failed = 0
    for entry in entries {
        bytes = checked(bytes + entry.Bytes)
        if entry.Error != nil {
            failed++
        }
    }
    return Inventory(entries.ToArray(), bytes, failed)
}

func run(args[]string) int32 {
    const usage = "Usage: Trail <folder> [extension]\nExample: Trail demo .txt"
    if args.Length == 2 && args[1] == "--help" {
        Console.WriteLine(usage)
        return 0
    }
    if args.Length < 2 || args.Length > 3 {
        Console.Error.WriteLine(usage)
        return 2
    }
    let root = Path.GetFullPath(args[1])
    if !Directory.Exists(root) {
        Console.Error.WriteLine("Trail: the folder does not exist.")
        return 2
    }
    if (File.GetAttributes(root) & FileAttributes.ReparsePoint) == FileAttributes.ReparsePoint {
        Console.Error.WriteLine("Trail: choose a real folder, not a symbolic link.")
        return 2
    }
    let extension string? = args.Length == 3 ? args[2]: nil
    if let suffix = extension {
        if suffix.Length < 2 || !suffix.StartsWith(".") || suffix.Contains("/") || suffix.Contains("\\") {
            Console.Error.WriteLine("Trail: an extension must look like .txt, without a path.")
            return 2
        }
    }
    let report = inventory(root, extension)
    let options = JsonSerializerOptions{
        WriteIndented: true,
        IncludeFields: true,
        PropertyNamingPolicy: JsonNamingPolicy.CamelCase
    }
    Console.WriteLine(JsonSerializer.Serialize[Inventory](report, options))
    return report.Failed == 0 ? 0: 1
}

try {
    Environment.ExitCode = run(Environment.GetCommandLineArgs())
} catch (e Exception) {
    Console.Error.WriteLine("Trail: " + e.Message)
    Environment.ExitCode = 1
}
