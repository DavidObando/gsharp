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
    internal static void TranslateMissing(
        string sourceRoot,
        string destinationRoot,
        IReadOnlyList<string> sourceFiles)
    {
        foreach (string relativePath in sourceFiles.Where(path =>
            Path.GetExtension(path).Equals(".cs", StringComparison.OrdinalIgnoreCase)))
        {
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
                throw new InvalidOperationException(
                    $"Checked-in C# file '{relativePath}' is excluded from all projects and " +
                    $"could not be translated independently: {unsupported}");
            }

            RoundTripResult roundTrip = GSharpRoundTrip.Validate(generated);
            if (!roundTrip.Success)
            {
                throw new InvalidOperationException(
                    $"Checked-in C# file '{relativePath}' is excluded from all projects and " +
                    $"its independent translation did not parse: {roundTrip.Errors.FirstOrDefault()}");
            }

            Directory.CreateDirectory(Path.GetDirectoryName(destinationPath));
            File.WriteAllText(destinationPath, generated);
        }
    }
}
