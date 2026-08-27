// <copyright file="RepositoryOrphanSourceTranslator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis.CSharp;

namespace Cs2Gs.Pipeline;

/// <summary>Translates inventoried C# files excluded from every project compilation.</summary>
internal static class RepositoryOrphanSourceTranslator
{
    /// <summary>
    /// Translates each orphaned C# file into its checked-in G# mirror.
    /// Issue #3580: failures are RECORDED, not thrown — this step runs after
    /// every app already succeeded, and an exception here used to abort the
    /// run before the report table and <c>run.json</c> were written. Files
    /// under a project directory that <c>--exclude</c> removed from the run
    /// are skipped entirely: they are out of scope, not orphans, and their
    /// standalone translation (single-file, no project references) proves
    /// nothing.
    /// </summary>
    /// <param name="sourceRoot">The migrated repository's source root.</param>
    /// <param name="destinationRoot">The mirror destination root.</param>
    /// <param name="sourceFiles">The repository-relative inventory ('/'-separated).</param>
    /// <param name="excludedScope">The out-of-scope source set, or <see langword="null"/> for none.</param>
    /// <returns>The failure messages, one per file that could not be mirrored; empty on success.</returns>
    internal static IReadOnlyList<string> TranslateMissing(
        string sourceRoot,
        string destinationRoot,
        IReadOnlyList<string> sourceFiles,
        RepositoryExcludedScope excludedScope = null)
    {
        excludedScope ??= RepositoryExcludedScope.None;
        var failures = new List<string>();
        foreach (string relativePath in sourceFiles.Where(path =>
            Path.GetExtension(path).Equals(".cs", StringComparison.OrdinalIgnoreCase)))
        {
            if (excludedScope.IsExcluded(relativePath))
            {
                continue;
            }

            string destinationPath = Path.Combine(
                destinationRoot,
                Path.ChangeExtension(relativePath, ".gs"));
            if (File.Exists(destinationPath))
            {
                continue;
            }

            string sourcePath = Path.Combine(sourceRoot, relativePath);
            LoadedCSharpProject loaded = CSharpProjectLoader.LoadInMemory(
                new[] { (sourcePath, File.ReadAllText(sourcePath)) },
                assemblyName: "Cs2Gs.Orphan." + Guid.NewGuid().ToString("N"));
            LoadedDocument document = loaded.Documents.Single();
            var translationContext = new TranslationContext(
                loaded.Compilation,
                document.SemanticModel,
                document.FilePath,
                Array.Empty<CSharpCompilation>());
            var translator = new CSharpToGSharpTranslator();
            string generated = GSharpPrinter.Print(
                translator.TranslateDocument(document, translationContext));
            string unsupported = translationContext.Diagnostics
                .Where(diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported)
                .Select(diagnostic => diagnostic.Message)
                .FirstOrDefault();
            if (unsupported is not null)
            {
                failures.Add(
                    $"Checked-in C# file '{relativePath}' is excluded from all projects and " +
                    $"could not be translated independently: {unsupported}");
                continue;
            }

            RoundTripResult roundTrip = GSharpRoundTrip.Validate(generated);
            if (!roundTrip.Success)
            {
                failures.Add(
                    $"Checked-in C# file '{relativePath}' is excluded from all projects and " +
                    $"its independent translation did not parse: {roundTrip.Errors.FirstOrDefault()}");
                continue;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(destinationPath));
            File.WriteAllText(destinationPath, generated);
        }

        return failures;
    }
}
