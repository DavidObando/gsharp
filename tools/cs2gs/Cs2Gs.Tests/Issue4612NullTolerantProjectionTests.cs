// <copyright file="Issue4612NullTolerantProjectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4612: the #4671 audit of the self-migration corpus found translator
/// and pipeline source that projects a possible null through a LINQ lambda
/// and filters it out afterwards. C# stores the null and drops it; the
/// migrated G# asserts the lambda result (a value stored into the delegate's
/// type-parameter result slot) and throws first. The source now keeps the
/// null out of the projection. These tests pin both shapes so the reason for
/// the rewrite stays visible.
/// </summary>
/// <remarks>
/// Fixed sites: <c>SdkCompileRunner.ResolveMirrorRoot</c> (a root path's null
/// <c>GetDirectoryName</c>), <c>DeclaredProjectItem</c> (a project without a
/// path), and <c>AnalyzerProjectDetector.IsAnalyzerProject</c> (a declaration
/// without a symbol, filtered by <c>OfType</c>).
/// </remarks>
public class Issue4612NullTolerantProjectionTests
{
    private const string MaybeNullHelper = """
        #nullable enable
            private static string? Directory(string path) => path.Length > 1 ? path : null;
        #nullable restore
        """;

    /// <summary>
    /// The old shape: a possible null projected and filtered afterwards keeps
    /// its fail-fast assertion on the lambda result.
    /// </summary>
    [Fact]
    public void NullProjectedThenFiltered_KeepsFailFastAssertion()
    {
        string printed = TranslateUnit("""
            using System.Linq;

            public static class C
            {
                public static int Count(string[] paths) =>
                    paths.Select(path => Directory(path)).Where(d => !string.IsNullOrEmpty(d)).Count();

            """ + MaybeNullHelper + """

            }
            """);

        Assert.Contains("Directory(path)!!", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The shape the source now uses: the null maps to a value the filter
    /// already drops, so the lambda result carries no assertion.
    /// </summary>
    [Fact]
    public void NullMappedToEmpty_CarriesNoAssertion()
    {
        string printed = TranslateUnit("""
            using System.Linq;

            public static class C
            {
                public static int Count(string[] paths) =>
                    paths.Select(path => Directory(path) ?? string.Empty).Where(d => !string.IsNullOrEmpty(d)).Count();

            """ + MaybeNullHelper + """

            }
            """);

        Assert.DoesNotContain("Directory(path)!!", printed, StringComparison.Ordinal);
        Assert.Contains("Directory(path) ??", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The <c>OfType</c> rewrite: testing the symbol inside the predicate
    /// stores nothing, so there is no assertion to throw.
    /// </summary>
    [Fact]
    public void SymbolTestedInsidePredicate_CarriesNoAssertion()
    {
        string printed = TranslateUnit("""
            using System.Linq;

            public static class C
            {
                public static bool Any(string[] paths) =>
                    paths.Any(path => Directory(path) is string directory && directory.Length > 2);

            """ + MaybeNullHelper + """

            }
            """);

        Assert.DoesNotContain("Directory(path)!!", printed, StringComparison.Ordinal);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must bind. Errors:" + Environment.NewLine +
                string.Join(Environment.NewLine, result.Errors) + Environment.NewLine + Environment.NewLine +
                "Printed:" + Environment.NewLine + printed);
        return printed;
    }
}
