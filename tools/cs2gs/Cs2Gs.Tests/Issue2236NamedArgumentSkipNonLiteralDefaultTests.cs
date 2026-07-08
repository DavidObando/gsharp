// <copyright file="Issue2236NamedArgumentSkipNonLiteralDefaultTests.cs" company="GSharp">
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
/// Issue #2236: a named-argument call that SKIPS an optional parameter reports
/// "no faithful G# positional form yet (issue #1727)" whenever
/// <c>BuildOptionalParameterDefault</c> cannot express the skipped parameter's
/// own default. Investigation found that <c>default</c>/<c>default(T)</c>,
/// <c>new T()</c> (value type), and a referenced <c>const</c> field were ALL
/// already handled correctly — Roslyn's <c>IParameterSymbol.ExplicitDefaultValue</c>
/// resolves each of those to a plain constant (or <c>null</c> for the zero
/// value), which <see cref="M:Cs2Gs.Translator.CSharpToGSharpTranslator"/>'s
/// existing constant-mapping switch already covered for every numeric kind
/// EXCEPT <c>decimal</c> — a <c>decimal</c> default fell through to the
/// "not a simple literal" diagnostic and was dropped, which (since the
/// dropped default also makes the DECLARATION itself wrongly require the
/// argument) breaks both the named-argument-skip path AND a plain declaration
/// with a <c>decimal</c> default. The fix adds the missing <c>decimal</c> arm
/// to the shared constant-mapping switch (<c>MapConstantValue</c>) rather than
/// add native named-argument call syntax to gsc (see the PR description for
/// the full engineering-judgment reasoning): every other "non-literal" shape
/// the issue calls out was already a faithful reconstruction via the existing
/// call path, so only the one missing numeric kind needed a fix, and doing so
/// in the single shared method used by both call sites (declaration defaults
/// and named-argument-skip filler defaults) fixes both root causes at once.
/// </summary>
public class Issue2236NamedArgumentSkipNonLiteralDefaultTests
{
    [Fact]
    public void NamedArgument_SkipsParameterWithDecimalDefault_FillsDefaultPositionally()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void Foo(int a, decimal price = 1.5m, int flag = 0) { }

        public void Caller()
        {
            Foo(a: 1, flag: 2);
        }
    }
}");
        Assert.Contains("Foo(1, 1.5, 2)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void DecimalDefault_WithoutNamedArguments_KeepsParameterOptional()
    {
        // Regression for the same root cause on the DECLARATION side (not just
        // the named-argument-skip path): a plain `decimal` default must not be
        // silently dropped, or the parameter becomes wrongly required.
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void Foo(int a, decimal price = 1.5m) { }

        public void Caller()
        {
            Foo(1);
        }
    }
}");
        Assert.Contains("price decimal = 1.5", printed, StringComparison.Ordinal);
        Assert.Contains("Foo(1)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NamedArgument_SkipsParameterWithDefaultKeyword_FillsDefaultPositionally()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public struct Options { public int X; }

    public class C
    {
        public void Foo(int a, Options table = default, int flag = 0) { }

        public void Caller()
        {
            Foo(a: 1, flag: 2);
        }
    }
}");
        Assert.Contains("Foo(1, default(Options), 2)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NamedArgument_SkipsParameterWithNewValueTypeDefault_FillsDefaultPositionally()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public struct Options { public int X; }

    public class C
    {
        public void Foo(int a, Options table = new Options(), int flag = 0) { }

        public void Caller()
        {
            Foo(a: 1, flag: 2);
        }
    }
}");
        Assert.Contains("Foo(1, default(Options), 2)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NamedArgument_SkipsParameterWithReferencedConstantDefault_FillsDefaultPositionally()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public const string TableName = ""users"";

        public void Foo(int a, string table = TableName, int flag = 0) { }

        public void Caller()
        {
            Foo(a: 1, flag: 2);
        }
    }
}");
        Assert.Contains("Foo(1, \"users\", 2)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NamedArgument_SkipsParameterWithSimpleLiteralDefault_StillWorks()
    {
        // Baseline from issue #1727: must still work unchanged.
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void Foo(int a, int b = 42, int flag = 0) { }

        public void Caller()
        {
            Foo(a: 1, flag: 2);
        }
    }
}");
        Assert.Contains("Foo(1, 42, 2)", printed, StringComparison.Ordinal);
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
