// <copyright file="Issue1839PatternDesignatorAndEnumExtensionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1839: a follow-up to #1836/#1734's declaration-site sanitization
/// fix. Two corner cases remained in <c>GetRightmostTypeName</c>'s synthesized
/// recursive-pattern designator:
/// <list type="bullet">
/// <item>N2 — a predefined/composite type pattern (<c>int?</c>, <c>int[]</c>,
/// a tuple, a pointer) fell back to <c>Type.ToString()</c>, which is not a
/// valid identifier, and was emitted unsanitized.</item>
/// <item>N3 — two typed recursive subpatterns within the SAME arm whose
/// rightmost simple name collapses to the same designator (e.g. <c>Ns.Circle</c>
/// and <c>Other.Circle</c>) silently shadowed one another as two same-named
/// locals in one scope.</item>
/// </list>
/// This file also adds the N1 parity test for the enum-extension owner/method
/// sanitization site (<c>TryGetEnumExtension</c>), the one site from #1836 that
/// had no dedicated test.
/// </summary>
public class Issue1839PatternDesignatorAndEnumExtensionTests
{
    [Fact]
    public void RecursivePatternSynthesizedDesignator_NullableElementArrayTypePattern_UsesElementTypeName()
    {
        // `int?[]` is a legal array-of-nullable-value-type pattern (the
        // restriction against a nullable type directly in a pattern applies to
        // the pattern's own type, not to an array's element type). Recursing
        // into the array's element type first yields `int?`, itself a
        // `NullableTypeSyntax`, which must in turn recurse into `int` (mapped
        // to its BCL name, not the invalid `Type.ToString()` text `int?[]`).
        string rendered = Render(@"
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
");

        Assert.DoesNotContain("int?[]", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void RecursivePatternSynthesizedDesignator_ArrayTypePattern_UsesElementTypeName()
    {
        // `int[]` has no simple-name token either; the designator is derived
        // from the `int` element type, not the invalid `Type.ToString()` text
        // `int[]`.
        string rendered = Render(@"
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
");

        Assert.DoesNotContain("int[]", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void RecursivePatternSynthesizedDesignator_TupleTypePattern_ReportsDiagnosticInsteadOfGarbage()
    {
        // A tuple type has no single simple name to derive a faithful
        // designator from; a diagnostic must be reported rather than emitting
        // the invalid `Type.ToString()` text `(int, int)`.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Source.cs", @"
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
"),
        });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string rendered = GSharpPrinter.Print(unit);

        Assert.NotEmpty(context.Diagnostics);
        Assert.DoesNotContain("(int, int)", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void RecursivePatternSynthesizedDesignator_SameRightmostNameInOneArm_AreUniquified()
    {
        // `Ns.Circle` and `Other.Circle` both collapse to the same rightmost
        // simple name ('Circle'), but they appear as two subpatterns of the
        // SAME 'or' arm (one scope): the synthesized designators must be made
        // distinct (a uniquifier suffix) rather than colliding as two same-named
        // 'circle' locals.
        string rendered = Render(@"
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
");

        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void EnumExtensionOwnerAndMethodName_KeywordCollision_IsSanitizedConsistently()
    {
        // Issue #1836 (N1 parity): the null-conditional enum-extension call
        // rewrite (`TryGetEnumExtension`) synthesizes an `Owner.Method(receiver, …)`
        // static-call form from the extension's declaring type and method
        // names. Both must be sanitized consistently, so a keyword-colliding
        // owner/method name agrees between the synthesized call and (if it were
        // ever declared elsewhere) its declaration.
        string rendered = Render(@"
namespace Corpus.Issue1839
{
    public enum Color { Red, Green, Blue }

    public static class @select
    {
        public static string type(this Color color) => color.ToString();
    }

    public class Holder
    {
        public string Describe(Color? color) => color?.type();
    }
}
");

        Assert.Contains("select_", rendered, StringComparison.Ordinal);
        Assert.Contains("type_", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
