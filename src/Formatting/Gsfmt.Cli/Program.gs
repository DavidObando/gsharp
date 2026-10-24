// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Gsfmt

import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import System
import System.Collections.Generic
import System.IO
import System.Linq

internal shared class Program {
    private class Options {
        init() {
            Paths = List[string]()
        }

        prop Help bool
        prop Write bool
        prop List bool
        prop Check bool
        prop Diff bool
        prop StdinName string?
        prop Out TextWriter
        prop Err TextWriter

        prop Paths List[string] {
            get;
        }
    }

    internal func Main(args[]string) int32 -> Run(args, Console.Out, Console.Error)

    internal func Run(args[]string, stdout TextWriter, stderr TextWriter) int32 {
        if !TryParse(args, stdout, stderr, out var options) {
            return 2
        }
        if options.Help {
            PrintUsage(options)
            return 0
        }
        try {
            return if options.Paths.Count == 0 && Console.IsInputRedirected {
                FormatStandardInput(options)
            } else {
                FormatPaths(options)
            }
        } catch (ex Exception) when ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException {
            options.Err.WriteLine("gsfmt: " + ex.Message)
            return 2
        }
    }

    private func FormatStandardInput(options Options) int32 {
        if options.Write {
            options.Err.WriteLine("gsfmt: --write cannot be used with standard input.")
            return 2
        }
        let name = options.StdinName ?? "<stdin>"
        let original = Console.In.ReadToEnd()
        let result = GSharpFormatter.Format(SourceText.From(original, name))
        if !result.Diagnostics.IsEmpty {
            PrintDiagnostics(options, name, result)
            return 2
        }
        let formatted = result.Text?.ToString() ??
            throw InvalidOperationException("Successful formatting must return text.")
        if options.Check {
            if !result.Changed {
                return 0
            }
            ReportCheckFailure(options, List[string]{name})
            return 1
        }
        if options.List {
            if result.Changed {
                options.Out.WriteLine(name)
            }
            return 0
        }
        if options.Diff {
            if result.Changed {
                options.Out.Write(UnifiedDiff(name, original, formatted))
            }
            return 0
        }
        options.Out.Write(formatted)
        return 0
    }

    private func FormatPaths(options Options) int32 {
        let files = CollectFiles(
            if options.Paths.Count == 0 {
                cast[IEnumerable[string]]([]string{"."})
            } else {
                cast[IEnumerable[string]](options.Paths)
            }
        )
        let changedPaths = List[string]()
        var failed = false
        for path in files {
            var original string
            var sourceText SourceText
            try {
                sourceText = SourceText.Load(path)
                original = sourceText.ToString()
            } catch (ex Exception) when ex is IOException || ex is UnauthorizedAccessException {
                options.Err.WriteLine("gsfmt: $path: ${ex.Message}")
                failed = true
                continue
            }
            let result = GSharpFormatter.Format(sourceText)
            if !result.Diagnostics.IsEmpty {
                PrintDiagnostics(options, path, result)
                failed = true
                continue
            }
            let formatted = result.Text?.ToString() ??
                throw InvalidOperationException("Successful formatting must return text.")
            if !result.Changed {
                if !options.Write && !options.List && !options.Check && !options.Diff {
                    options.Out.Write(formatted)
                }
                continue
            }
            changedPaths.Add(path)
            if options.List {
                options.Out.WriteLine(path)
            }
            if options.Write {
                File.WriteAllText(path, formatted)
            } else if options.Diff {
                options.Out.Write(UnifiedDiff(path, original, formatted))
            } else if !options.Check && !options.List {
                options.Out.Write(formatted)
            }
        }
        if failed {
            return 2
        }
        if options.Check && changedPaths.Count > 0 {
            ReportCheckFailure(options, changedPaths)
            return 1
        }
        return 0
    }

    // `--check` names every file that would change on stdout, one per line in the order `-l` uses, then
    // explains the failure and the fix on stderr so a pipe of the list stays clean (#5299).
    private func ReportCheckFailure(options Options, changedPaths List[string]) {
        for changedPath in changedPaths {
            options.Out.WriteLine(changedPath)
        }
        let target = if options.Paths.Count == 0 {
            "."
        } else {
            string.Join(" ", options.Paths)
        }
        options.Err.WriteLine("gsfmt: ${changedPaths.Count} file(s) need formatting. Run 'gsfmt -w $target' to fix.")
    }

    private func CollectFiles(paths IEnumerable[string]) IReadOnlyList[string] {
        let files = SortedSet[string](StringComparer.Ordinal)
        for path in paths {
            let fullPath = Path.GetFullPath(path)
            if File.Exists(fullPath) {
                if fullPath.EndsWith(".gs", StringComparison.OrdinalIgnoreCase) && !IgnoreMatcher.IsIgnored(
                    fullPath,
                    Path.GetDirectoryName(fullPath) ?? fullPath
                ) {
                    files.Add(fullPath)
                }
                continue
            }
            if !Directory.Exists(fullPath) {
                throw FileNotFoundException("Path does not exist.", path)
            }
            let pending = Stack[string]()
            pending.Push(fullPath)
            while pending.Count > 0 {
                let directory = pending.Pop()
                for child in Directory.EnumerateDirectories(directory) {
                    let name = Path.GetFileName(child)
                    if !((name == "bin" || name == "obj" || name == "out")) {
                        pending.Push(child)
                    }
                }
                for file in Directory.EnumerateFiles(directory, "*.gs") {
                    if !IgnoreMatcher.IsIgnored(file, fullPath) {
                        files.Add(Path.GetFullPath(file))
                    }
                }
            }
        }
        return files.ToArray()
    }

    private func PrintDiagnostics(options Options, path string, result FormatResult) {
        for diagnostic in result.Diagnostics {
            if diagnostic.Location.Text == nil {
                options.Err.WriteLine("$path: ${diagnostic.Id}: ${diagnostic.Message}")
                continue
            }
            options.Err.WriteLine(
                "$path(${diagnostic.Location.StartLine + 1},${diagnostic.Location.StartCharacter + 1}): " +
                    "${diagnostic.Id}: ${diagnostic.Message}"
            )
        }
    }

    private func UnifiedDiff(path string, original string, formatted string) string {
        let oldLines = SplitLines(original)
        let newLines = SplitLines(formatted)
        let lines = List[string]{"--- " + path, "+++ " + path, "@@ -1,${oldLines.Length} +1,${newLines.Length} @@"}
        lines.AddRange(oldLines.Select((line string) -> "-" + line))
        lines.AddRange(newLines.Select((line string) -> "+" + line))
        return string.Join("\n", lines) + "\n"
    }

    private func SplitLines(text string)[]string -> text
        .TrimEnd('\r', '\n')
        .Replace("\r\n", "\n", StringComparison.Ordinal)
        .Split('\n')

    private func TryParse(args[]string, stdout TextWriter, stderr TextWriter, out options Options) bool {
        options = Options()
        options.Out = stdout
        options.Err = stderr
        for var i = 0; i < args.Length; i++ {
            let argument = args[i]
            switch argument {
                case "-h", "--help" {
                    options.Help = true
                }
                case "-w", "--write" {
                    options.Write = true
                }
                case "-l", "--list" {
                    options.List = true
                }
                case "--check" {
                    options.Check = true
                }
                case "-d", "--diff" {
                    options.Diff = true
                }
                case "--stdin-name" {
                    if (i += 1) >= args.Length {
                        options.Err.WriteLine("gsfmt: --stdin-name requires a value.")
                        return false
                    }
                    options.StdinName = args[i]
                }
                default {
                    if argument.StartsWith("-", StringComparison.Ordinal) {
                        options.Err.WriteLine("gsfmt: unknown option '$argument'.")
                        return false
                    }
                    options.Paths.Add(argument)
                }
            }
        }
        if options.Write && options.Check {
            options.Err.WriteLine("gsfmt: --write and --check cannot be combined.")
            return false
        }
        return true
    }

    private func PrintUsage(options Options) {
        options.Out.WriteLine("Usage: gsfmt [flags] [path ...]")
        options.Out.WriteLine("  -w, --write        rewrite files in place")
        options.Out.WriteLine("  -l, --list         list files whose formatting would change")
        options.Out.WriteLine("      --check        list files that would change and exit 1")
        options.Out.WriteLine("  -d, --diff         print a unified diff")
        options.Out.WriteLine("      --stdin-name   diagnostic filename for standard input")
    }
}
