// <copyright file="RepositoryOrphanSourceTranslator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq

/// Translates inventoried C# files excluded from every project compilation.
internal shared class RepositoryOrphanSourceTranslator {
    /// Translates each orphaned C# file into its checked-in G# mirror.
    /// Issue #3580: failures are RECORDED, not thrown — this step runs after
    /// every app already succeeded, and an exception here used to abort the
    /// run before the report table and `run.json` were written. Files
    /// under a project directory that `--exclude` removed from the run
    /// are skipped entirely: they are out of scope, not orphans, and their
    /// standalone translation (single-file, no project references) proves
    /// nothing.
    /// @param sourceRoot The migrated repository's source root.
    /// @param destinationRoot The mirror destination root.
    /// @param sourceFiles The repository-relative inventory ('/'-separated).
    /// @param excludedScope The out-of-scope source set, or `null` for none.
    /// @returns The failure messages, one per file that could not be mirrored; empty on success.
    internal func TranslateMissing(
        sourceRoot string?,
        destinationRoot string?,
        sourceFiles IReadOnlyList[string]?,
        excludedScope RepositoryExcludedScope? = nil
    ) IReadOnlyList[string] {
        var excludedScope = excludedScope
        excludedScope ??= RepositoryExcludedScope.None
        let failures = List[string]()
        // Issue #4850: a `.cs` a project references as data or foreign input
        // is mirrored verbatim by RepositoryMirror.Prepare, not an orphan.
        let verbatim = RepositoryVerbatimSources.Compute(sourceRoot, sourceFiles)
        for relativePath in sourceFiles!!.Where(
            (path string) -> Path.GetExtension(path).Equals(".cs", StringComparison.OrdinalIgnoreCase)
        ) {
            if excludedScope!!.IsExcluded(relativePath) || verbatim.Contains(relativePath) {
                continue
            }
            let destinationPath = Path.Combine(destinationRoot!!, Path.ChangeExtension(relativePath, ".gs"))
            if File.Exists(destinationPath) {
                continue
            }
            let sourcePath = Path.Combine(sourceRoot!!, relativePath)
            let loaded = CSharpProjectLoader.LoadInMemory(
                [](sourcePath string, string){(sourcePath, File.ReadAllText(sourcePath))},
                assemblyName: "Cs2Gs.Orphan." + Guid.NewGuid().ToString("N")
            )
            if loaded.Documents.Count == 0 {
                Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!!)
                File.WriteAllText(destinationPath, string.Empty)
                continue
            }
            let document = loaded.Documents.Single()
            let translationContext = TranslationContext(
                loaded.Compilation,
                document.SemanticModel,
                document.FilePath,
                Array.Empty[CSharpCompilation]()
            )
            let translator = CSharpToGSharpTranslator()
            let generated = GSharpPrinter.Print(translator.TranslateDocument(document, translationContext))
            let unsupported string? = translationContext
                .Diagnostics
                .Where((diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported)
                .Select((diagnostic TranslationDiagnostic) -> diagnostic.Message)
                .FirstOrDefault()
            if unsupported != nil {
                failures.Add(
                    "Checked-in C# file '$relativePath' is excluded from all projects and " +
                        "could not be translated independently: $unsupported"
                )
                continue
            }
            let roundTrip = GSharpRoundTrip.Validate(generated)
            if !roundTrip.Success {
                failures.Add(
                    "Checked-in C# file '$relativePath' is excluded from all projects and " +
                        "its independent translation did not parse: ${roundTrip.Errors.FirstOrDefault()}"
                )
                continue
            }
            Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!!)
            File.WriteAllText(destinationPath, generated)
        }
        return failures
    }
}
