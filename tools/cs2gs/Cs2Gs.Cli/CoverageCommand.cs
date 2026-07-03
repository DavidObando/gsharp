// <copyright file="CoverageCommand.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.Translator.Coverage;

namespace Cs2Gs.Cli;

/// <summary>
/// The <c>cs2gs coverage</c> verb (ADR-0138): keeps the construct inventory,
/// the Roslyn-surface golden, and the generated docs matrix in lockstep.
/// Without <c>--write</c> it reports drift (exit 1) without touching files —
/// the same checks ConstructInventoryGoldenTests enforces in CI. With
/// <c>--write</c> it appends skeleton rows for newly appeared node kinds
/// (the post-Roslyn-bump workflow), canonicalizes the inventory JSON, and
/// regenerates the golden and <c>docs/cs2gs-coverage-matrix.md</c>.
/// </summary>
internal static class CoverageCommand
{
    /// <summary>
    /// Runs the verb.
    /// </summary>
    /// <param name="args">The verb arguments (<c>--write</c>, <c>--repo-root &lt;dir&gt;</c>).</param>
    /// <returns>0 when in sync (or written), 1 on drift without <c>--write</c>, 2 on tool error.</returns>
    public static int Run(string[] args)
    {
        bool write = false;
        string repoRoot = null;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--write":
                    write = true;
                    break;
                case "--repo-root" when i + 1 < args.Length:
                    repoRoot = args[++i];
                    break;
                default:
                    Console.Error.WriteLine($"cs2gs coverage: unknown option '{args[i]}'.");
                    return 2;
            }
        }

        repoRoot ??= LocateRepoRoot();
        if (repoRoot is null)
        {
            Console.Error.WriteLine("cs2gs coverage: GSharp.sln not found above the current directory; pass --repo-root.");
            return 2;
        }

        string inventoryPath = Path.Combine(repoRoot, ConstructInventory.RepoRelativePath.Replace('/', Path.DirectorySeparatorChar));
        string matrixPath = Path.Combine(repoRoot, ConstructInventory.MatrixRepoRelativePath.Replace('/', Path.DirectorySeparatorChar));
        string goldenPath = Path.Combine(repoRoot, "tools", "cs2gs", "Cs2Gs.Tests", "Coverage", "roslyn-surface.golden.txt");

        List<ConstructEntry> entries = File.Exists(inventoryPath)
            ? ConstructInventory.Load(inventoryPath).Entries.ToList()
            : new List<ConstructEntry>();

        var known = new HashSet<string>(entries.Select(e => e.Kind), StringComparer.Ordinal);
        var nodeClasses = new HashSet<string>(RoslynSurface.NodeClassNames(), StringComparer.Ordinal);
        var appended = new List<string>();
        foreach (string kind in RoslynSurface.NodeKindNames())
        {
            if (known.Contains(kind))
            {
                continue;
            }

            entries.Add(new ConstructEntry
            {
                Kind = kind,
                NodeType = nodeClasses.Contains(kind + "Syntax") ? kind + "Syntax" : "TBD",
                Status = ConstructStatus.Unclassified,
            });
            appended.Add(kind);
        }

        var inventory = new ConstructInventory(entries);
        string inventoryJson = inventory.ToJson();
        string matrix = inventory.BuildMatrixMarkdown();
        string golden = RoslynSurface.BuildSnapshot();

        bool drift = appended.Count > 0
            || !FileMatches(inventoryPath, inventoryJson)
            || !FileMatches(matrixPath, matrix)
            || !FileMatches(goldenPath, golden);

        if (!write)
        {
            if (drift)
            {
                Console.Error.WriteLine(
                    $"cs2gs coverage: drift detected ({appended.Count} new node kinds); run `cs2gs coverage --write`.");
                return 1;
            }

            Console.WriteLine("cs2gs coverage: inventory, golden, and docs matrix are in sync.");
            return 0;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(inventoryPath));
        File.WriteAllText(inventoryPath, inventoryJson);
        File.WriteAllText(matrixPath, matrix);
        File.WriteAllText(goldenPath, golden);
        Console.WriteLine(
            $"cs2gs coverage: wrote {ConstructInventory.RepoRelativePath} ({entries.Count} rows, " +
            $"{appended.Count} appended), {ConstructInventory.MatrixRepoRelativePath}, and the Roslyn-surface golden.");
        foreach (string kind in appended)
        {
            Console.WriteLine($"  new (unclassified): {kind}");
        }

        return 0;
    }

    /// <summary>
    /// Compares a file's current content to the expected text (LF-normalized).
    /// </summary>
    /// <param name="path">The file path.</param>
    /// <param name="expected">The expected content.</param>
    /// <returns><see langword="true"/> when the file exists and matches.</returns>
    private static bool FileMatches(string path, string expected)
    {
        return File.Exists(path)
            && string.Equals(File.ReadAllText(path).Replace("\r\n", "\n"), expected, StringComparison.Ordinal);
    }

    /// <summary>
    /// Walks up from the current directory to the directory containing
    /// <c>GSharp.sln</c>.
    /// </summary>
    /// <returns>The repo root, or <see langword="null"/> when not found.</returns>
    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        return null;
    }
}
