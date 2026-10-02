// <copyright file="Issue4704ForwardedWarningIdTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4704: the self-migrated Translate stage threw a
/// <c>NullReferenceException</c> on the first translation warning without a
/// diagnostic id. <c>TranslationDiagnostic.DiagnosticId</c> is null unless set,
/// and once <c>ReportUnsupported</c> could assign it a null argument cs2gs typed
/// it <c>string?</c>. <c>TranslateStage</c> passed it to a <c>string</c>
/// parameter, which cs2gs bridged with a fail-fast <c>!!</c>. The predicate now
/// takes the diagnostic and compares the id, which accepts null in both
/// languages. These tests pin both shapes so the reason stays visible.
/// </summary>
/// <remarks>
/// End-to-end witness: the migrated Pipeline built from the old shape crashes
/// translating <c>tools/cs2gs/corpus/grid/G06-Types-Console</c>
/// (<c>TranslateStage.gs: IsForwardedTranslationWarning(d.DiagnosticId!!)</c>);
/// built from the new shape it translates the corpus.
/// </remarks>
public class Issue4704ForwardedWarningIdTests
{
    private const string Diagnostic = """
        public sealed class Diagnostic
        {
            public string Id { get; set; }

            public static Diagnostic Make(string id = null) => new Diagnostic { Id = id };
        }
        """;

    /// <summary>
    /// The old shape: a nullable-by-evidence id passed to a <c>string</c>
    /// parameter is bridged with a fail-fast <c>!!</c>.
    /// </summary>
    [Fact]
    public void IdPassedToAStringParameter_IsAssertedNonNull()
    {
        string printed = TranslateUnit("""

            public static class Stage
            {
                public static bool Forwarded(Diagnostic d) => IsForwarded(d.Id);

                private static bool IsForwarded(string id) => id == "X";
            }
            """);

        Assert.Contains("IsForwarded(d.Id!!)", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The shape TranslateStage now uses: the predicate takes the diagnostic
    /// and compares its id, so nothing asserts the id non-null.
    /// </summary>
    [Fact]
    public void IdComparedInsideThePredicate_IsNotAsserted()
    {
        string printed = TranslateUnit("""

            public static class Stage
            {
                public static bool Forwarded(Diagnostic d) => IsForwarded(d);

                private static bool IsForwarded(Diagnostic diagnostic) => diagnostic.Id == "X";
            }
            """);

        Assert.DoesNotContain("Id!!", printed, StringComparison.Ordinal);
        Assert.Contains("IsForwarded(d)", printed, StringComparison.Ordinal);
    }

    // As in the repository: the diagnostic type lives in one project
    // (Cs2Gs.Translator) and the stage in another (Cs2Gs.Pipeline), translated
    // with both as sibling compilations.
    private static string TranslateUnit(string stageSource)
    {
        LoadedCSharpProject library = CSharpProjectLoader.LoadInMemory(
            new[] { ("Diagnostic.cs", Diagnostic) },
            CSharpProjectLoader.RuntimeReferences(),
            "Issue4704.Library");
        Assert.True(library.BoundWithoutErrors, string.Join(Environment.NewLine, library.ErrorDiagnostics));
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Stage.cs", stageSource) },
            CSharpProjectLoader.RuntimeReferences().Append(library.Compilation.ToMetadataReference()).ToList(),
            "Issue4704.Stage");
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var siblings = new[] { project.Compilation, library.Compilation };
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath,
            siblings,
            repositoryCompilations: siblings);
        return GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }
}
