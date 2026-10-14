// <copyright file="CoverageCommand.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Cli

import Cs2Gs.Pipeline
import Cs2Gs.Translator.Coverage
import System
import System.Collections.Generic
import System.IO
import System.Linq

/// The `cs2gs coverage` verb (ADR-0138): keeps the construct inventory,
/// the Roslyn-surface golden, and the generated docs matrix in lockstep.
/// Without `--write` it reports drift (exit 1) without touching files —
/// the same checks ConstructInventoryGoldenTests enforces in CI. With
/// `--write` it appends skeleton rows for newly appeared node kinds
/// (the post-Roslyn-bump workflow), canonicalizes the inventory JSON, and
/// regenerates the golden and `docs/cs2gs-coverage-matrix.md`.
internal shared class CoverageCommand {
    /// Runs the verb.
    /// @param args The verb arguments (`--write`, `--repo-root <dir>`).
    /// @returns 0 when in sync (or written), 1 on drift without `--write`, 2 on tool error.
    func Run(args[]string) int32 {
        var write = false
        var repoRoot string? = nil
        for var i = 0; i < args.Length; i++ {
            switch args[i] {
                case "--write" {
                    write = true
                }
                case "--repo-root" when i + 1 < args.Length {
                    repoRoot = args[(i += 1)]
                }
                default {
                    Console.Error.WriteLine("cs2gs coverage: unknown option '${args[i]}'.")
                    return 2
                }
            }
        }
        repoRoot ??= LocateRepoRoot()
        if repoRoot == nil {
            Console.Error.WriteLine(
                "cs2gs coverage: repository root (GSharp.sln or GSharp.slnx) not found above the current directory; pass --repo-root."
            )
            return 2
        }
        let inventoryPath = Path.Combine(
            repoRoot,
            ConstructInventory.RepoRelativePath.Replace('/', Path.DirectorySeparatorChar)
        )
        let matrixPath = Path.Combine(
            repoRoot,
            ConstructInventory.MatrixRepoRelativePath.Replace('/', Path.DirectorySeparatorChar)
        )
        let goldenPath = Path.Combine(
            repoRoot,
            "tools",
            "cs2gs",
            "Cs2Gs.Tests",
            "Coverage",
            "roslyn-surface.golden.txt"
        )
        let entries = if File.Exists(inventoryPath) {
            ConstructInventory.Load(inventoryPath).Entries.ToList()
        } else {
            List[ConstructEntry]()
        }
        let known = HashSet[string](entries.Select((e ConstructEntry) -> e.Kind), StringComparer.Ordinal)
        let nodeClasses = HashSet[string](RoslynSurface.NodeClassNames(), StringComparer.Ordinal)
        let appended = List[string]()
        for kind in RoslynSurface.NodeKindNames() {
            if known.Contains(kind) {
                continue
            }
            entries.Add(
                ConstructEntry{
                    Kind: kind,
                    NodeType: if nodeClasses.Contains(kind + "Syntax") {
                        kind + "Syntax"
                    } else {
                        "TBD"
                    },
                    Status: ConstructStatus.Unclassified
                }
            )
            appended.Add(kind)
        }
        let inventory = ConstructInventory(entries)
        // Never write (or report "in sync") from a structurally-broken
        // inventory (e.g. a duplicate-kind row surviving a bad merge/hand
        // edit): a duplicate row inflates the row count invisibly in one
        // status bucket while the header total silently drifts out of sync
        // with the docs matrix on a later regeneration (#2020).
        let violations = inventory.Validate(repoRoot)
        if violations.Count > 0 {
            Console.Error.WriteLine("cs2gs coverage: construct inventory is invalid; fix before writing:")
            for violation in violations {
                Console.Error.WriteLine("  $violation")
            }
            return 2
        }
        let inventoryJson = inventory.ToJson()
        let matrix = inventory.BuildMatrixMarkdown()
        let golden = RoslynSurface.BuildSnapshot()
        let drift = appended.Count > 0 ||
            !FileMatches(inventoryPath, inventoryJson) ||
            !FileMatches(matrixPath, matrix) ||
            !FileMatches(goldenPath, golden)
        if !write {
            if drift {
                Console.Error.WriteLine(
                    "cs2gs coverage: drift detected (${appended.Count} new node kinds); run `cs2gs coverage --write`."
                )
                return 1
            }
            Console.WriteLine("cs2gs coverage: inventory, golden, and docs matrix are in sync.")
            return 0
        }
        Directory.CreateDirectory(Path.GetDirectoryName(inventoryPath)!!)
        File.WriteAllText(inventoryPath, inventoryJson)
        File.WriteAllText(matrixPath, matrix)
        File.WriteAllText(goldenPath, golden)
        Console.WriteLine(
            "cs2gs coverage: wrote ${ConstructInventory.RepoRelativePath} (${entries.Count} rows, " +
                "${appended.Count} appended), ${ConstructInventory.MatrixRepoRelativePath}, and the Roslyn-surface golden."
        )
        for kind in appended {
            Console.WriteLine("  new (unclassified): $kind")
        }
        return 0
    }

    /// Compares a file's current content to the expected text (LF-normalized).
    /// @param path The file path.
    /// @param expected The expected content.
    /// @returns `true` when the file exists and matches.
    private func FileMatches(path string, expected string) bool {
        return File.Exists(path) && string.Equals(
            File.ReadAllText(path).Replace("\r\n", "\n"),
            expected,
            StringComparison.Ordinal
        )
    }

    /// Walks up from the current directory to the directory containing
    /// `GSharp.sln` or `GSharp.slnx`.
    /// @returns The repo root, or `null` when not found.
    private func LocateRepoRoot() string? {
        var dir DirectoryInfo? = DirectoryInfo(Directory.GetCurrentDirectory())
        while dir != nil {
            if RepositoryRootMarker.IsRoot(dir.FullName) {
                return dir.FullName
            }
            dir = dir.Parent
        }
        return nil
    }
}
