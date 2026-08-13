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
/// Issue #2236/#3090: optional declarations retain their defaults and named
/// call sites retain names. Native gsc binding supplies skipped defaults.
/// </summary>
public class Issue2236NamedArgumentSkipNonLiteralDefaultTests
{
    [Fact]
    public void NamedArgument_SkipsParameterWithDecimalDefault_PreservesNames()
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
}",
            "G# currently cannot bind decimal optional defaults emitted without a decimal literal suffix.");
        Assert.Contains("Foo(a: 1, flag: 2)", printed, StringComparison.Ordinal);
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
}",
            "G# currently cannot bind decimal optional defaults emitted without a decimal literal suffix.");
        Assert.Contains("price decimal = 1.5", printed, StringComparison.Ordinal);
        Assert.Contains("Foo(1)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NamedArgument_SkipsParameterWithDefaultKeyword_PreservesNames()
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
        Assert.Contains("Foo(a: 1, flag: 2)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NamedArgument_SkipsParameterWithNewValueTypeDefault_PreservesNames()
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
        Assert.Contains("Foo(a: 1, flag: 2)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NamedArgument_SkipsParameterWithReferencedConstantDefault_PreservesNames()
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
        Assert.Contains("Foo(a: 1, flag: 2)", printed, StringComparison.Ordinal);
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
        Assert.Contains("Foo(a: 1, flag: 2)", printed, StringComparison.Ordinal);
    }

    private static string TranslateUnit(string source, string roundTripOnlyReason = null)
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
        RoundTripResult result = roundTripOnlyReason is null
            ? TranslationTestValidation.AssertBinds(printed)
            : TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
