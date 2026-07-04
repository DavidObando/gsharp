// <copyright file="Issue1883LiteralReceiverMemberCallTranslationTests.cs" company="GSharp">
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
/// Issue #1883: a member call on a bare numeric-literal receiver
/// (<c>42.ToString()</c>, <c>7.Squared()</c>) previously translated
/// verbatim, but G#'s grammar never chains postfix member/index/call
/// access directly onto a numeric-literal token (ADR-0054) — the lexer
/// cannot otherwise tell whether the following <c>.</c> starts a float's
/// fractional part or a member access, so the grammar simply disallows the
/// chain. The unparenthesized output failed to round-trip-parse
/// (GS0005/GS0157). Two C# shapes trigger this: string concatenation with a
/// non-string literal operand (<c>"n=" + 42</c>, which lowers to an
/// explicit <c>.ToString()</c> call) and a direct extension-method or
/// instance-member call on an int literal (<c>7.Squared()</c>,
/// <c>42.ToString()</c>, <c>42.GetType()</c>). The fix parenthesizes any
/// receiver that renders as a bare int/float literal wherever it is used
/// as a member-access/call receiver — covering every numeric-literal
/// spelling (decimal, hex, octal, binary, and suffixed forms) uniformly,
/// while leaving non-literal receivers (identifiers, calls, existing
/// parenthesized expressions) untouched.
/// </summary>
public class Issue1883LiteralReceiverMemberCallTranslationTests
{
    [Fact]
    public void IntLiteral_ConcatenatedWithString_ParenthesizesToStringReceiver()
    {
        string rendered = Render(@"
namespace Corpus.Issue1883
{
    public class C
    {
        public string M()
        {
            return ""n="" + 42;
        }
    }
}
");

        Assert.Contains("(42).ToString()", rendered);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void NegativeLiteral_ConcatenatedWithString_ParenthesizesToStringReceiver()
    {
        string rendered = Render(@"
namespace Corpus.Issue1883
{
    public class C
    {
        public string M()
        {
            return ""n="" + -5;
        }
    }
}
");

        Assert.Contains("(-5).ToString()", rendered);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void IntLiteral_DirectExtensionMethodCall_ParenthesizesReceiver()
    {
        string rendered = Render(@"
namespace Corpus.Issue1883
{
    public static class Extensions
    {
        public static int Squared(this int value) => value * value;
    }

    public class C
    {
        public int M()
        {
            return 7.Squared();
        }
    }
}
");

        Assert.Contains("(7).Squared()", rendered);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void IntLiteral_DirectToStringCall_ParenthesizesReceiver()
    {
        string rendered = Render(@"
namespace Corpus.Issue1883
{
    public class C
    {
        public string M()
        {
            return 42.ToString();
        }
    }
}
");

        Assert.Contains("(42).ToString()", rendered);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void LongAndHexLiterals_DirectMemberCall_ParenthesizesReceiver()
    {
        string rendered = Render(@"
namespace Corpus.Issue1883
{
    public class C
    {
        public string M()
        {
            return 42L.ToString() + 0x2AU.ToString();
        }
    }
}
");

        Assert.Contains("(42L).ToString()", rendered);
        Assert.Contains("(0x2AU).ToString()", rendered);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void NonLiteralReceiver_IsNotParenthesized()
    {
        string rendered = Render(@"
namespace Corpus.Issue1883
{
    public class C
    {
        public string M(int n)
        {
            return n.ToString();
        }
    }
}
");

        Assert.Contains("n.ToString()", rendered);
        Assert.DoesNotContain("(n).ToString()", rendered);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

        Assert.True(
            result.Success,
            "Translated G# must round-trip-parse. Errors:\n" +
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
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity != TranslationSeverity.Info);
        return GSharpPrinter.Print(unit);
    }
}
