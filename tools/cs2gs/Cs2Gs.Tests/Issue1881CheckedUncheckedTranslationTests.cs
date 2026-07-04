// <copyright file="Issue1881CheckedUncheckedTranslationTests.cs" company="GSharp">
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
/// Issue #1881: cs2gs silently dropped C# <c>checked</c>/<c>unchecked</c>
/// overflow semantics. A <c>checked(expr)</c>/<c>unchecked(expr)</c>
/// expression fell to the expression fallback (reported as CS2GS-GAP), and a
/// <c>checked { }</c>/<c>unchecked { }</c> statement translated to a plain
/// block — silently erasing the overflow-trap behavior (the worst kind of
/// divergence: the migrated program compiles and runs, but disagrees on
/// stdout with the C# oracle). gsc now has native <c>checked</c>/<c>unchecked</c>
/// expression and block support, so both forms translate directly with no
/// gap and no silent behavior change.
/// </summary>
public class Issue1881CheckedUncheckedTranslationTests
{
    [Fact]
    public void CheckedExpression_TranslatesToCheckedExpression_NoGap()
    {
        string rendered = Render(@"
namespace Corpus.Issue1881
{
    public static class E
    {
        public static int Run(int a, int b)
        {
            return checked(a + b);
        }
    }
}
");

        Assert.Contains("checked(a + b)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void UncheckedExpression_TranslatesToUncheckedExpression_NoGap()
    {
        string rendered = Render(@"
namespace Corpus.Issue1881
{
    public static class E
    {
        public static int Run(int a, int b)
        {
            return unchecked(a + b);
        }
    }
}
");

        Assert.Contains("unchecked(a + b)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void CheckedExpression_NarrowingConversion_TranslatesToCheckedExpression()
    {
        string rendered = Render(@"
namespace Corpus.Issue1881
{
    public static class E
    {
        public static byte Run(int wide)
        {
            return checked((byte)wide);
        }
    }
}
");

        Assert.Contains("checked(", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void CheckedStatement_TranslatesToCheckedBlock_NotPlainBlock()
    {
        string rendered = Render(@"
namespace Corpus.Issue1881
{
    public static class E
    {
        public static int Run(int a, int b)
        {
            int result = 0;
            checked
            {
                result = a + b;
            }

            return result;
        }
    }
}
");

        // The pre-fix translator emitted a plain `{ }` block here, silently
        // erasing the overflow-trap semantics (issue #1881's core bug).
        Assert.Contains("checked {", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void UncheckedStatement_TranslatesToUncheckedBlock_NotPlainBlock()
    {
        string rendered = Render(@"
namespace Corpus.Issue1881
{
    public static class E
    {
        public static int Run(int a, int b)
        {
            int result = 0;
            unchecked
            {
                result = a + b;
            }

            return result;
        }
    }
}
");

        Assert.Contains("unchecked {", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void CheckedStatement_NestedUnchecked_BothContextsTranslate()
    {
        string rendered = Render(@"
namespace Corpus.Issue1881
{
    public static class E
    {
        public static int Run(int a, int b)
        {
            int result = 0;
            checked
            {
                unchecked
                {
                    result = a + b;
                }
            }

            return result;
        }
    }
}
");

        Assert.Contains("checked {", rendered, StringComparison.Ordinal);
        Assert.Contains("unchecked {", rendered, StringComparison.Ordinal);
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

        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        return GSharpPrinter.Print(unit);
    }
}
