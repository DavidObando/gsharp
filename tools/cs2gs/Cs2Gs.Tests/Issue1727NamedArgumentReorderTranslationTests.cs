// <copyright file="Issue1727NamedArgumentReorderTranslationTests.cs" company="GSharp">
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
/// Issue #1727: <c>TranslateArgument</c> never read <c>ArgumentSyntax.NameColon</c>,
/// and every call site emitted <c>invocation.ArgumentList.Arguments</c> in SYNTAX
/// order. G# has no named-argument call syntax, so <c>Foo(b: 2, a: 1)</c> was
/// silently emitted as <c>Foo(2, 1)</c> — the arguments swapped — and
/// <c>Foo(c: 5)</c> against a method with leading optional parameters bound
/// <c>5</c> to the FIRST parameter. The fix reorders named/mixed argument lists
/// into parameter DECLARATION order using the semantic model
/// (<c>IArgumentOperation.Parameter</c>), filling any skipped optional parameter
/// with its default value, and refuses to reorder (reporting Unsupported instead)
/// when doing so would change the observable evaluation order of a
/// potentially side-effecting argument.
/// </summary>
public class Issue1727NamedArgumentReorderTranslationTests
{
    [Fact]
    public void NamedArguments_OutOfDeclarationOrder_AreReorderedPositionally()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void Foo(int a, int b) { }

        public void Caller()
        {
            Foo(b: 2, a: 1);
        }
    }
}");
        Assert.Contains("Foo(1, 2)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Foo(2, 1)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NamedArgument_SkipsLeadingOptionalParameters_FillsDefaults()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void Foo(int a = 1, int b = 2, int c = 3) { }

        public void Caller()
        {
            Foo(c: 5);
        }
    }
}");
        Assert.Contains("Foo(1, 2, 5)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NamedArguments_AlreadyInDeclarationOrder_TranslateUnchanged()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void Foo(int a, int b) { }

        public void Caller()
        {
            Foo(a: 1, b: 2);
        }
    }
}");
        Assert.Contains("Foo(1, 2)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void MixedPositionalAndNamedArguments_ReorderCorrectly()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void Foo(int a, int b, int c) { }

        public void Caller()
        {
            Foo(1, c: 3, b: 2);
        }
    }
}");
        Assert.Contains("Foo(1, 2, 3)", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Reordering named arguments that carry a method call (a potential side
    /// effect) relative to declaration order must not silently change C#'s
    /// lexical evaluation order: the translator reports Unsupported rather than
    /// emit a reordered call that could observably differ from the source.
    /// </summary>
    [Fact]
    public void NamedArguments_ReorderingSideEffectingCalls_ReportsUnsupported()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Demo
{
    public class C
    {
        public void Foo(int a, int b) { }

        public int NextA() => 1;

        public int NextB() => 2;

        public void Caller()
        {
            Foo(b: NextB(), a: NextA());
        }
    }
}");
        Assert.Contains(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported
            && d.Message.Contains("issue #1727", StringComparison.OrdinalIgnoreCase));
        Assert.NotNull(unit);
    }

    private static string TranslateUnit(string source)
    {
        (CompilationUnit unit, _) = Translate(source);
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static (CompilationUnit Unit, TranslationContext Context) Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (unit, context);
    }
}
