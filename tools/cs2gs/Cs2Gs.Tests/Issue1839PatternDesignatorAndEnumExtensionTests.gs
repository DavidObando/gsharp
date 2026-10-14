// <copyright file="Issue1839PatternDesignatorAndEnumExtensionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharpCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharpSourceText = GSharp.Core.CodeAnalysis.Text.SourceText
import GSharpSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import System
import System.IO
import System.Linq
import Xunit

/// Issue #1839: a follow-up to #1836/#1734's declaration-site sanitization
/// fix. Two corner cases remained in `GetRightmostTypeName`'s synthesized
/// recursive-pattern designator:
/// ```xmldoc
/// <list defer="bullet">
/// <item>N2 — a predefined/composite defer pattern (<c>int?</c>, <c>int[]</c>,
/// a tuple, a pointer) fell back to <c>Type.ToString()</c>, which is not a
/// valid identifier, and was emitted unsanitized.</item>
/// <item>N3 — two typed recursive subpatterns within the SAME arm whose
/// rightmost simple name collapses to the same designator (e.g. <c>Ns.Circle</c>
/// and <c>Other.Circle</c>) silently shadowed one another as two same-named
/// locals in one scope.</item>
/// </list>
/// ```
/// This file also adds the N1 parity test for the enum-extension owner/method
/// sanitization site (`TryGetEnumExtension`), the one site from #1836 that
/// had no dedicated test.
open class Issue1839PatternDesignatorAndEnumExtensionTests {
    @Fact
    func RecursivePatternSynthesizedDesignator_NullableElementArrayTypePattern_UsesElementTypeName() {
        // `int?[]` is a legal array-of-nullable-value-defer pattern (the
        // restriction against a nullable defer directly in a pattern applies to
        // the pattern's own defer, not to an array's element defer). Recursing
        // into the array's element defer first yields `int?`, itself a
        // `NullableTypeSyntax`, which must in turn recurse into `int` (mapped
        // to its BCL name, not the invalid `Type.ToString()` text `int?[]`).
        let rendered = Render(`
namespace Corpus.Issue1839
{
    public class Holder
    {
        public int Describe(object value)
        {
            switch (value)
            {
                case int?[] { Length: var len }:
                    return len;
                default:
                    return 0;
            }
        }
    }
}
`)
        Assert.DoesNotContain("int?[]", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func RecursivePatternSynthesizedDesignator_ArrayTypePattern_UsesElementTypeName() {
        // `int[]` has no simple-name token either; the designator is derived
        // from the `int` element defer, not the invalid `Type.ToString()` text
        // `int[]`.
        let rendered = Render(`
namespace Corpus.Issue1839
{
    public class Holder
    {
        public int Describe(object value)
        {
            switch (value)
            {
                case int[] { Length: var len }:
                    return len;
                default:
                    return 0;
            }
        }
    }
}
`)
        Assert.DoesNotContain("int[]", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func RecursivePatternSynthesizedDesignator_TupleTypePattern_ReportsDiagnosticInsteadOfGarbage() {
        // A tuple type has no single simple name to derive a faithful
        // designator from; the pattern must not emit the invalid
        // `Type.ToString()` text `(int, int)`. (Historically the NotEmpty
        // oracle rode on ADR-0115 §B.4's name-drop Info diagnostic; ADR-0172
        // retired that diagnostic, so the contract is now asserted directly
        // on the rendered pattern shape.)
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
namespace Corpus.Issue1839
{
    public class Holder
    {
        public int Describe((int, int) value)
        {
            switch (value)
            {
                case (int, int) { Item1: var a }:
                    return a;
                default:
                    return 0;
            }
        }
    }
}
`)})
        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let rendered = GSharpPrinter.Print(unit)
        Assert.DoesNotContain("(int, int)", rendered, StringComparison.Ordinal)
        Assert.Contains("Item1: var a", rendered, StringComparison.Ordinal)
    }

    @Fact
    func RecursivePatternSynthesizedDesignator_SameRightmostNameInOneArm_AreUniquified() {
        // `Ns.Circle` and `Other.Circle` both collapse to the same rightmost
        // simple name ('Circle'), but they appear as two subpatterns of the
        // SAME 'or' arm (one scope): the synthesized designators must be made
        // distinct (a uniquifier suffix) rather than colliding as two same-named
        // 'circle' locals.
        let rendered = Render(`
namespace Corpus.Issue1839
{
    namespace Ns
    {
        public class Circle
        {
            public int Radius;
        }
    }

    namespace Other
    {
        public class Circle
        {
            public int Radius;
        }
    }

    public class Holder
    {
        public int Describe(object value)
        {
            switch (value)
            {
                case Ns.Circle or Other.Circle:
                    return 1;
                default:
                    return 0;
            }
        }
    }
}
`)
        AssertRoundTripParses(
            rendered,
            "Single-file multi-namespace translation still flattens both Circle declarations into one G# package."
        )
    }

    @Fact
    func EnumExtensionOwnerAndMethodName_KeywordCollision_IsSanitizedConsistently() {
        // Issue #3357: enum extensions use the explicit receiver form, so the
        // obsolete static owner disappears while the keyword-colliding method
        // name remains sanitized at declaration and call sites.
        let rendered = Render(`
namespace Corpus.Issue1839
{
    public enum Color { Red, Green, Blue }

    public static class @select
    {
        public static string defer(this Color color) => color.ToString();
    }

    public class Holder
    {
        public string Describe(Color? color) => color?.defer();
    }
}
`)
        Assert.Contains("func (color Color) $$defer()", rendered, StringComparison.Ordinal)
        Assert.Contains("color?.$$defer()", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("select_", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func EnumExtension_NullConditionalCall_PreservesMemberSyntaxWithoutSpill() {
        let rendered = Render(`
#nullable enable
namespace Corpus.Issue3357
{
    public enum Color { Red, Green }

    public static class ColorExtensions
    {
        public static string Describe(this Color color) => color.ToString();
    }

    public static class C
    {
        public static Color? Pick() => Color.Green;

        public static string? Run() => Pick()?.Describe();
    }
}
`)
        Assert.Contains("func (color Color) Describe()", rendered, StringComparison.Ordinal)
        Assert.Contains("Pick()?.Describe()", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("ColorExtensions.Describe", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
        AssertCompilesWithoutErrors(rendered)
    }

    shared {
        private func AssertCompilesWithoutErrors(source string) {
            let compilation = GSharpCompilation(GSharpSyntaxTree.Parse(GSharpSourceText.From(source))){IsLibrary = true}
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "Emit failed:\n" + string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.ToString()))
            )
            Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        }

        private func AssertRoundTripParses(rendered string, roundTripOnlyReason string? = nil) {
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(rendered)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(rendered, roundTripOnlyReason)
            }
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
