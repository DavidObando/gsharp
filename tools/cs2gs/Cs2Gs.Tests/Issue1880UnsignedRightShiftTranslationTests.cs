// <copyright file="Issue1880UnsignedRightShiftTranslationTests.cs" company="GSharp">
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
/// Issue #1880: C#'s unsigned (logical) right-shift `&gt;&gt;&gt;` and its
/// compound-assign form `&gt;&gt;&gt;=` had no translation. `&gt;&gt;&gt;`
/// crashed the translator outright (<c>ArgumentException: Unknown binary
/// operator: &gt;&gt;&gt;</c> from the G# printer's precedence table), and
/// `&gt;&gt;&gt;=` emitted the C# token text verbatim into G# source that
/// gsc could not parse (since G# had no such operator). Both are now first-class
/// G# operators (see gsc's <c>SyntaxKind.UnsignedShiftRightToken</c> /
/// <c>UnsignedShiftRightEqualsToken</c>), so the translator now passes both
/// straight through unchanged for ALL integer operand types (int/uint/long/
/// ulong/etc — mirrors `&gt;&gt;`/`&gt;&gt;=`, which receive no numeric-
/// promotion coercion either).
/// </summary>
public class Issue1880UnsignedRightShiftTranslationTests
{
    [Fact]
    public void UnsignedRightShiftExpression_Int_TranslatesThrough()
    {
        string rendered = Render(@"
namespace Corpus.Issue1880
{
    public class Holder
    {
        public int Shift(int value)
        {
            return value >>> 1;
        }
    }
}
");

        Assert.Contains("value >>> 1", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void UnsignedRightShiftExpression_Long_TranslatesThrough()
    {
        string rendered = Render(@"
namespace Corpus.Issue1880
{
    public class Holder
    {
        public long Shift(long value)
        {
            return value >>> 2;
        }
    }
}
");

        Assert.Contains("value >>> 2", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void UnsignedRightShiftExpression_UInt_TranslatesThrough()
    {
        string rendered = Render(@"
namespace Corpus.Issue1880
{
    public class Holder
    {
        public uint Shift(uint value)
        {
            return value >>> 3;
        }
    }
}
");

        Assert.Contains("value >>> 3", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void UnsignedRightShiftAssignmentExpression_Int_TranslatesThrough()
    {
        string rendered = Render(@"
namespace Corpus.Issue1880
{
    public class Holder
    {
        public int Shift(int value)
        {
            value >>>= 1;
            return value;
        }
    }
}
");

        Assert.Contains("value >>>= 1", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void UnsignedRightShiftAssignmentExpression_ULong_TranslatesThrough()
    {
        string rendered = Render(@"
namespace Corpus.Issue1880
{
    public class Holder
    {
        public ulong Shift(ulong value)
        {
            value >>>= 4;
            return value;
        }
    }
}
");

        Assert.Contains("value >>>= 4", rendered, StringComparison.Ordinal);
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
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }
}
