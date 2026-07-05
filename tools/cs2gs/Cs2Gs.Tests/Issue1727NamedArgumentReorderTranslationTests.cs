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

    /// <summary>
    /// A named argument at a leading parameter's own position combined with a
    /// <c>params</c> parameter used in EXPANDED form (C# 7.2+) makes several
    /// arguments share the SAME <c>Parameter.Ordinal</c> (the params
    /// parameter's). This must not crash the translator (previously an
    /// unguarded <c>ToDictionary</c> threw on the duplicate key); since source
    /// order already agrees with declaration order here, it is emitted
    /// unchanged.
    /// </summary>
    [Fact]
    public void NamedArgument_WithExpandedParams_DoesNotCrash_EmitsSourceOrder()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void Foo(int x, params int[] rest) { }

        public void Caller()
        {
            Foo(x: 0, 1, 2, 3);
        }
    }
}");
        Assert.Contains("Foo(0, 1, 2, 3)", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Skipping a MIDDLE optional parameter (not just a leading one) must
    /// still dense-fill the gap from the parameter's own default.
    /// </summary>
    [Fact]
    public void NamedArgument_SkipsMiddleOptionalParameter_FillsDefault()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void Foo(int a = 1, int b = 2, int c = 3) { }

        public void Caller()
        {
            Foo(a: 1, c: 5);
        }
    }
}");
        Assert.Contains("Foo(1, 2, 5)", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Sanity baseline: an all-positional call into a <c>params</c> parameter
    /// (no named arguments at all) is untouched by the named-argument reorder
    /// path and keeps its correct, unchanged output.
    /// </summary>
    [Fact]
    public void AllPositionalArguments_WithParams_TranslateUnchanged()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void Foo(int x, params int[] rest) { }

        public void Caller()
        {
            Foo(1, 2, 3);
        }
    }
}");
        Assert.Contains("Foo(1, 2, 3)", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A named argument for a leading optional parameter followed by EXPANDED
    /// <c>params</c> positional elements (<c>Merge(additionalCapacity: 8, a, b)</c>).
    /// Roslyn folds the expanded elements into a single array-creation argument, so
    /// <c>GetOperation</c> on each element syntax returns null — the reorder path
    /// previously gapped ("could not be resolved to a parameter", issue #1727) even
    /// though source order already matches declaration order. It must now emit the
    /// call in source order (the named value first, then the params elements).
    /// </summary>
    [Fact]
    public void NamedArgument_FollowedByExpandedParams_EmitsSourceOrder()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public byte[] Merge(int additionalCapacity = 0, params byte[][] arrays) => arrays[0];

        public byte[] Caller(byte[] a, byte[] b)
        {
            return Merge(additionalCapacity: 8, a, b);
        }
    }
}");
        Assert.Contains("Merge(8, a, b)", printed, StringComparison.Ordinal);
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
