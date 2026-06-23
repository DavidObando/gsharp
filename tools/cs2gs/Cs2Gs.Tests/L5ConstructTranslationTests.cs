// <copyright file="L5ConstructTranslationTests.cs" company="GSharp">
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
/// Translation tests for the new C# surface area exercised by the L5-Console
/// corpus app (ADR-0115 §E/§G): a <c>switch</c> statement over type patterns, a
/// <c>yield return</c> iterator (with the <c>IEnumerable&lt;T&gt;</c> return
/// type rewritten to <c>sequence[T]</c>), and the two faithfulness fixes the L5
/// pipeline surfaced — an integer literal that C# implicitly promotes to a
/// floating-point parameter is emitted as a float literal, and a parameterless
/// constructor that initializes a property keeps its explicit <c>init</c> body
/// (G# has no property member initializer).
/// </summary>
public class L5ConstructTranslationTests
{
    /// <summary>
    /// A C# <c>switch</c> statement over type patterns is emitted as the
    /// canonical G# <c>switch subj { case P { … } default { … } }</c> statement
    /// form (PatternSwitch.gs), with the per-section <c>break;</c> dropped.
    /// </summary>
    [Fact]
    public void SwitchStatement_OverTypePatterns_EmittedAsSwitchBlock()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class Shapes
    {
        public static string Kind(object shape)
        {
            switch (shape)
            {
                case string s:
                    return ""text"";
                default:
                    return ""other"";
            }
        }
    }
}");

        Assert.Contains("switch shape {", printed);
        Assert.Contains("case s is string {", printed);
        Assert.Contains("default {", printed);
        Assert.DoesNotContain("break", printed);
    }

    /// <summary>
    /// Issue #991: a C# <c>when</c> guard on a switch-statement case is now
    /// translated to the canonical G# <c>case &lt;pattern&gt; when &lt;bool&gt; { … }</c>
    /// form instead of being reported as unsupported.
    /// </summary>
    [Fact]
    public void SwitchStatement_WhenGuard_EmittedAsGuardedCase()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class Shapes
    {
        public static string Kind(int n)
        {
            switch (n)
            {
                case > 0 when n < 10:
                    return ""small"";
                default:
                    return ""other"";
            }
        }
    }
}");

        Assert.Contains("case > 0 when n < 10 {", printed);
        Assert.DoesNotContain("when' guard has no canonical", printed);
    }

    /// <summary>
    /// Issue #991: a C# <c>when</c> guard on a switch-expression arm is now
    /// translated to the canonical G# <c>case &lt;pattern&gt; when &lt;bool&gt;: …</c>
    /// form.
    /// </summary>
    [Fact]
    public void SwitchExpression_WhenGuard_EmittedAsGuardedArm()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class Shapes
    {
        public static string Kind(int n) => n switch
        {
            > 0 when n < 10 => ""small"",
            > 0 => ""big"",
            _ => ""other"",
        };
    }
}");

        Assert.Contains("case > 0 when n < 10:", printed);
    }

    /// <summary>
    /// A C# iterator method (<c>yield return</c>) returning
    /// <c>IEnumerable&lt;string&gt;</c> is emitted with the return type rewritten
    /// to <c>sequence[string]</c> and a bare <c>yield expr</c> body
    /// (TupleSequenceIterators.gs).
    /// </summary>
    [Fact]
    public void Iterator_YieldReturn_EmitsSequenceReturnAndYield()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System.Collections.Generic;

    public static class Source
    {
        public static IEnumerable<string> Names()
        {
            yield return ""a"";
            yield return ""b"";
        }
    }
}");

        Assert.Contains("sequence[string]", printed);
        Assert.Contains("yield \"a\"", printed);
        Assert.DoesNotContain("IEnumerable", printed);
    }

    /// <summary>
    /// A C# integer literal argument that the semantic model implicitly promotes
    /// to a floating-point parameter is emitted as a float literal (e.g.
    /// <c>30</c> → <c>30.0</c>). G# performs no implicit numeric promotion, so a
    /// bare <c>int32</c> push to a <c>float64</c> parameter would yield invalid
    /// IL (ilverify StackUnexpected). ADR-0115 §B.12.
    /// </summary>
    [Fact]
    public void IntegerLiteral_ImplicitlyPromotedToDouble_EmittedAsFloatLiteral()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class Calc
    {
        public static double Scale(double factor) => factor * 2.0;

        public static double Run() => Scale(30);
    }
}");

        Assert.Contains("Scale(30.0)", printed);
        Assert.DoesNotContain("Scale(30)", printed);
    }

    /// <summary>
    /// A parameterless constructor that assigns a constant to a property keeps
    /// its explicit <c>init()</c> body — G# accepts a field member initializer
    /// (<c>var Name T = expr</c>) but rejects a property member initializer
    /// (<c>prop Name T = expr</c>), so the assignment must stay in the
    /// constructor (ADR-0115 §B.3).
    /// </summary>
    [Fact]
    public void ParameterlessConstructor_InitializingProperty_KeepsExplicitInit()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Label
    {
        public string Text { get; set; }

        public Label()
        {
            Text = ""empty"";
        }
    }
}");

        Assert.Contains("init() {", printed);
        Assert.Contains("Text = \"empty\"", printed);
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
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
