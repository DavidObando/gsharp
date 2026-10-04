// <copyright file="Issue4704ForwardedWarningIdTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4704: the self-migrated Translate stage threw a
/// <c>NullReferenceException</c> on the first translation warning without a
/// diagnostic id. <c>TranslationDiagnostic.DiagnosticId</c> can be null, and
/// the pipeline's warning predicate must compare it without a fail-fast <c>!!</c>.
/// </summary>
public class Issue4704ForwardedWarningIdTests
{
    /// <summary>
    /// The discriminating witness (ADR-0154): translate the repository's real
    /// TranslateStage.cs with the Translator project as a sibling compilation.
    /// The old implementation emitted DiagnosticId!! here, which throws on a
    /// warning without an explicit id.
    /// </summary>
    [Fact]
    public async Task TranslateStageSelfMigration_DoesNotAssertDiagnosticId()
    {
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        LoadedCSharpProject pipeline = await CSharpProjectLoader.LoadProjectAsync(
            Path.Combine(repoRoot, "tools", "cs2gs", "Cs2Gs.Pipeline", "Cs2Gs.Pipeline.csproj"));
        LoadedCSharpProject translator = await CSharpProjectLoader.LoadProjectAsync(
            Path.Combine(repoRoot, "tools", "cs2gs", "Cs2Gs.Translator", "Cs2Gs.Translator.csproj"));

        Assert.True(
            pipeline.BoundWithoutErrors,
            "Cs2Gs.Pipeline should bind with no C# errors: "
                + string.Join(Environment.NewLine, pipeline.ErrorDiagnostics));
        Assert.True(
            translator.BoundWithoutErrors,
            "Cs2Gs.Translator should bind with no C# errors: "
                + string.Join(Environment.NewLine, translator.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(
            pipeline.Documents,
            candidate => Path.GetFileName(candidate.FilePath) == "TranslateStage.cs");
        var siblings = new[] { pipeline.Compilation, translator.Compilation };
        var context = new TranslationContext(
            pipeline.Compilation,
            document.SemanticModel,
            document.FilePath,
            siblings,
            repositoryCompilations: siblings);
        string printed = GSharpPrinter.Print(
            new CSharpToGSharpTranslator(preservePartialParts: true).TranslateDocument(document, context));

        Assert.Contains("IsForwardedTranslationWarning", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("DiagnosticId!!", printed, StringComparison.Ordinal);
    }
}
