// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Formatting;

namespace GSharp.Gsfmt;

internal static class Program
{
    internal static int Main(string[] args)
    {
        if (!TryParse(args, out Options options))
        {
            return 2;
        }

        if (options.Help)
        {
            PrintUsage();
            return 0;
        }

        try
        {
            return options.Paths.Count == 0 && Console.IsInputRedirected
                ? FormatStandardInput(options)
                : FormatPaths(options);
        }
        catch (Exception ex) when (ex is IOException
            or UnauthorizedAccessException
            or ArgumentException)
        {
            Console.Error.WriteLine("gsfmt: " + ex.Message);
            return 2;
        }
    }

    private static int FormatStandardInput(Options options)
    {
        if (options.Write)
        {
            Console.Error.WriteLine("gsfmt: --write cannot be used with standard input.");
            return 2;
        }

        string name = options.StdinName ?? "<stdin>";
        string original = Console.In.ReadToEnd();
        FormatResult result = GSharpFormatter.Format(SourceText.From(original, name));
        if (!result.Diagnostics.IsEmpty)
        {
            PrintDiagnostics(name, result);
            return 2;
        }

        if (options.Check)
        {
            return result.Changed ? 1 : 0;
        }

        if (options.List)
        {
            if (result.Changed)
            {
                Console.Out.WriteLine(name);
            }

            return 0;
        }

        if (options.Diff)
        {
            if (result.Changed)
            {
                Console.Out.Write(UnifiedDiff(name, original, result.Text!.ToString()));
            }

            return 0;
        }

        Console.Out.Write(result.Text!.ToString());
        return 0;
    }

    private static int FormatPaths(Options options)
    {
        IReadOnlyList<string> files = CollectFiles(
            options.Paths.Count == 0 ? new[] { "." } : options.Paths);
        bool changed = false;
        bool failed = false;

        foreach (string path in files)
        {
            string original;
            try
            {
                original = File.ReadAllText(path);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Console.Error.WriteLine($"gsfmt: {path}: {ex.Message}");
                failed = true;
                continue;
            }

            FormatResult result = GSharpFormatter.Format(SourceText.From(original, path));
            if (!result.Diagnostics.IsEmpty)
            {
                PrintDiagnostics(path, result);
                failed = true;
                continue;
            }

            if (!result.Changed)
            {
                if (!options.Write && !options.List && !options.Check && !options.Diff)
                {
                    Console.Out.Write(result.Text!.ToString());
                }

                continue;
            }

            changed = true;
            if (options.List)
            {
                Console.Out.WriteLine(path);
            }

            if (options.Write)
            {
                File.WriteAllText(path, result.Text!.ToString());
            }
            else if (options.Diff)
            {
                Console.Out.Write(UnifiedDiff(path, original, result.Text!.ToString()));
            }
            else if (!options.Check && !options.List)
            {
                Console.Out.Write(result.Text!.ToString());
            }
        }

        if (failed)
        {
            return 2;
        }

        return options.Check && changed ? 1 : 0;
    }

    private static IReadOnlyList<string> CollectFiles(IEnumerable<string> paths)
    {
        var files = new SortedSet<string>(StringComparer.Ordinal);
        foreach (string path in paths)
        {
            string fullPath = Path.GetFullPath(path);
            if (File.Exists(fullPath))
            {
                if (fullPath.EndsWith(".gs", StringComparison.OrdinalIgnoreCase)
                    && !IgnoreMatcher.IsIgnored(fullPath))
                {
                    files.Add(fullPath);
                }

                continue;
            }

            if (!Directory.Exists(fullPath))
            {
                throw new FileNotFoundException("Path does not exist.", path);
            }

            var pending = new Stack<string>();
            pending.Push(fullPath);
            while (pending.Count > 0)
            {
                string directory = pending.Pop();
                foreach (string child in Directory.EnumerateDirectories(directory))
                {
                    string name = Path.GetFileName(child);
                    if (name is not ("bin" or "obj" or "out"))
                    {
                        pending.Push(child);
                    }
                }

                foreach (string file in Directory.EnumerateFiles(directory, "*.gs"))
                {
                    if (!IgnoreMatcher.IsIgnored(file))
                    {
                        files.Add(Path.GetFullPath(file));
                    }
                }
            }
        }

        return files.ToArray();
    }

    private static void PrintDiagnostics(string path, FormatResult result)
    {
        foreach (var diagnostic in result.Diagnostics)
        {
            if (diagnostic.Location.Text is null)
            {
                Console.Error.WriteLine($"{path}: {diagnostic.Id}: {diagnostic.Message}");
                continue;
            }

            Console.Error.WriteLine(
                $"{path}({diagnostic.Location.StartLine + 1},{diagnostic.Location.StartCharacter + 1}): "
                + $"{diagnostic.Id}: {diagnostic.Message}");
        }
    }

    private static string UnifiedDiff(string path, string original, string formatted)
    {
        string[] oldLines = SplitLines(original);
        string[] newLines = SplitLines(formatted);
        var lines = new List<string>
        {
            "--- " + path,
            "+++ " + path,
            $"@@ -1,{oldLines.Length} +1,{newLines.Length} @@",
        };
        lines.AddRange(oldLines.Select(line => "-" + line));
        lines.AddRange(newLines.Select(line => "+" + line));
        return string.Join("\n", lines) + "\n";
    }

    private static string[] SplitLines(string text) =>
        text.TrimEnd('\r', '\n').Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');

    private static bool TryParse(string[] args, out Options options)
    {
        options = new Options();
        for (int i = 0; i < args.Length; i++)
        {
            string argument = args[i];
            switch (argument)
            {
                case "-h":
                case "--help":
                    options.Help = true;
                    break;
                case "-w":
                case "--write":
                    options.Write = true;
                    break;
                case "-l":
                case "--list":
                    options.List = true;
                    break;
                case "--check":
                    options.Check = true;
                    break;
                case "-d":
                case "--diff":
                    options.Diff = true;
                    break;
                case "--stdin-name":
                    if (++i >= args.Length)
                    {
                        Console.Error.WriteLine("gsfmt: --stdin-name requires a value.");
                        return false;
                    }

                    options.StdinName = args[i];
                    break;
                default:
                    if (argument.StartsWith("-", StringComparison.Ordinal))
                    {
                        Console.Error.WriteLine($"gsfmt: unknown option '{argument}'.");
                        return false;
                    }

                    options.Paths.Add(argument);
                    break;
            }
        }

        if (options.Write && options.Check)
        {
            Console.Error.WriteLine("gsfmt: --write and --check cannot be combined.");
            return false;
        }

        return true;
    }

    private static void PrintUsage()
    {
        Console.Out.WriteLine("Usage: gsfmt [flags] [path ...]");
        Console.Out.WriteLine("  -w, --write        rewrite files in place");
        Console.Out.WriteLine("  -l, --list         list files whose formatting would change");
        Console.Out.WriteLine("      --check        exit 1 if any file would change");
        Console.Out.WriteLine("  -d, --diff         print a unified diff");
        Console.Out.WriteLine("      --stdin-name   diagnostic filename for standard input");
    }

    private sealed class Options
    {
        public bool Help { get; set; }

        public bool Write { get; set; }

        public bool List { get; set; }

        public bool Check { get; set; }

        public bool Diff { get; set; }

        public string? StdinName { get; set; }

        public List<string> Paths { get; } = new();
    }
}
