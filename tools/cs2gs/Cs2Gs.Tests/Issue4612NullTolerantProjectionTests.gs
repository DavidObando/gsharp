// <copyright file="Issue4612NullTolerantProjectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #4612: the #4671 audit of the self-migration corpus found translator
/// and pipeline source that projects a possible null through a LINQ lambda
/// and filters it out afterwards. C# stores the null and drops it; the
/// migrated G# asserts the lambda result (a value stored into the delegate's
/// type-parameter result slot) and throws first. The source now keeps the
/// null out of the projection. These tests pin both shapes so the reason for
/// the rewrite stays visible.
/// @remarks Fixed sites: `SdkCompileRunner.ResolveMirrorRoot` (a root path's null
/// `GetDirectoryName`), `DeclaredProjectItem` (a project without a
/// path), and `AnalyzerProjectDetector.IsAnalyzerProject` (a declaration
/// without a symbol, filtered by `OfType`).
open class Issue4612NullTolerantProjectionTests {
    /// The old shape: a possible null projected and filtered afterwards keeps
    /// its fail-fast assertion on the lambda result.
    @Fact
    func NullProjectedThenFiltered_KeepsFailFastAssertion() {
        let printed = TranslateUnit(`using System.Linq;

public static class C
{
    public static int Count(string[] paths) =>
        paths.Select(path => Directory(path)).Where(d => !string.IsNullOrEmpty(d)).Count();
` + MaybeNullHelper + "\n}")
        Assert.Contains("Directory(path)!!", printed, StringComparison.Ordinal)
    }

    /// The shape the source now uses: the null maps to a value the filter
    /// already drops, so the lambda result carries no assertion.
    @Fact
    func NullMappedToEmpty_CarriesNoAssertion() {
        let printed = TranslateUnit(`using System.Linq;

public static class C
{
    public static int Count(string[] paths) =>
        paths.Select(path => Directory(path) ?? string.Empty).Where(d => !string.IsNullOrEmpty(d)).Count();
` + MaybeNullHelper + "\n}")
        Assert.DoesNotContain("Directory(path)!!", printed, StringComparison.Ordinal)
        Assert.Contains("Directory(path) ??", printed, StringComparison.Ordinal)
    }

    /// The `OfType` rewrite: testing the symbol inside the predicate
    /// stores nothing, so there is no assertion to throw.
    @Fact
    func SymbolTestedInsidePredicate_CarriesNoAssertion() {
        let printed = TranslateUnit(`using System.Linq;

public static class C
{
    public static bool Any(string[] paths) =>
        paths.Any(path => Directory(path) is string directory && directory.Length > 2);
` + MaybeNullHelper + "\n}")
        Assert.DoesNotContain("Directory(path)!!", printed, StringComparison.Ordinal)
    }

    shared {
        private const MaybeNullHelper string = `#nullable enable
    private static string? Directory(string path) => path.Length > 1 ? path : null;
#nullable restore`

        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must bind. Errors:" + Environment.NewLine + string.Join(
                    Environment.NewLine,
                    result!!.Errors
                ) +
                    Environment.NewLine +
                    Environment.NewLine +
                    "Printed:" +
                    Environment.NewLine +
                    printed
            )
            return printed
        }
    }
}
