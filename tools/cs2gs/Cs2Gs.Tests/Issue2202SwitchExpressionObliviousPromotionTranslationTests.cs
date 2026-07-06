// <copyright file="Issue2202SwitchExpressionObliviousPromotionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #2202: in a nullable-<em>oblivious</em>
/// compilation, <see cref="ObliviousNullabilityAnalyzer"/>'s <c>ResolveSources</c>
/// / <c>IsDirectlyNullable</c> walk had no case at all for a C# switch
/// <em>expression</em> (<c>x switch { ... }</c>), unlike the ternary conditional
/// expression it already handled. A switch expression whose arms include a
/// literal <c>null</c>/<c>default</c> fallback, or an otherwise nullable-tainted
/// arm, is itself nullable — a function/property whose body is (or forwards) such
/// a switch expression must be emitted <c>T?</c> or gsc reports GS0179 "not all
/// code paths return a value"/GS0156 at the call site. This mirrors the existing
/// ternary handling (issue #2157) but for the switch-expression syntax shape.
/// </summary>
public class Issue2202SwitchExpressionObliviousPromotionTranslationTests
{
    [Fact]
    public void Oblivious_SwitchExpression_WithNullDefaultArm_RendersNullableReturn()
    {
        // The `_ => null` fallback arm makes the whole switch expression (and
        // therefore the method's inferred/declared return) nullable.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Base { }

    public class A : Base { }

    public class B : Base
    {
        public Base Inner;
    }

    public static class Extensions
    {
        public static Base Get(this Base common)
        {
            return common switch
            {
                A a => a,
                B b => b.Inner,
                _ => null,
            };
        }
    }
}");

        Assert.Contains("Base?", printed);
    }

    [Fact]
    public void Oblivious_SwitchExpression_WithTaintedNullableArm_RendersNullableReturn()
    {
        // No literal `null` arm here — one arm forwards `b.Inner`, a field that
        // is directly assigned `null` elsewhere in the same compilation and is
        // therefore already tainted `Base?` by the whole-program taint analysis;
        // the switch expression itself must inherit that taint.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Base { }

    public class A : Base { }

    public class B : Base
    {
        public Base Inner;

        public void Clear()
        {
            Inner = null;
        }
    }

    public static class Extensions
    {
        public static Base Get(this Base common)
        {
            return common switch
            {
                A a => a,
                B b => b.Inner,
                _ => common,
            };
        }
    }
}");

        Assert.Contains("Base?", printed);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
