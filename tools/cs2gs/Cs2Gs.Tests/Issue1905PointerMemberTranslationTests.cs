// <copyright file="Issue1905PointerMemberTranslationTests.cs" company="GSharp">
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
/// Issue #1905: a C# pointer member access <c>p-&gt;X</c> parses as a
/// <see cref="Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax"/>
/// distinguished from plain <c>p.X</c> only by its
/// <c>SyntaxKind.PointerMemberAccessExpression</c> kind, and the translator
/// previously dropped that distinction, emitting a bare <c>p.X</c> — which
/// gsc rejects on a pointer receiver (GS0158). gsc's own G# grammar already
/// has a native <c>-&gt;</c> operator (sugar for <c>(*p).X</c>, ADR-0122 §4 /
/// issue #1034) that its parser desugars at parse time, so the fix simply
/// preserves the arrow instead of rewriting it to a dot. Covers field access
/// (read and assignment target), a method call, and a chained
/// <c>a-&gt;b-&gt;c</c> receiver.
/// </summary>
public class Issue1905PointerMemberTranslationTests
{
    [Fact]
    public void FieldRead_LowersToNativeArrow()
    {
        string rendered = Render(@"
namespace Corpus.Issue1905
{
    public struct Point
    {
        public int X;
    }

    public static class Holder
    {
        public static unsafe int Read(Point* p)
        {
            return p->X;
        }
    }
}
");

        Assert.Contains("return p->X", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("p.X", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void FieldWrite_AssignmentTarget_LowersToNativeArrow()
    {
        string rendered = Render(@"
namespace Corpus.Issue1905
{
    public struct Point
    {
        public int X;
    }

    public static class Holder
    {
        public static unsafe void Write(Point* p)
        {
            p->X = 10;
        }
    }
}
");

        Assert.Contains("p->X = 10", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void MethodCall_LowersToNativeArrowReceiver()
    {
        string rendered = Render(@"
namespace Corpus.Issue1905
{
    public struct Point
    {
        public int X;
        public int Y;

        public int Sum()
        {
            return X + Y;
        }
    }

    public static class Holder
    {
        public static unsafe int CallSum(Point* p)
        {
            return p->Sum();
        }
    }
}
");

        Assert.Contains("return p->Sum()", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ChainedArrow_LowersEachSegmentToNativeArrow()
    {
        // Each `->` recurses through the same translation path, so a chained
        // `a->b->c` receiver — here a pointer-to-pointer double-dereference,
        // since G# has no pointer-typed struct field (GS9006) to chain
        // through a real member — lowers with every arrow preserved.
        string rendered = Render(@"
namespace Corpus.Issue1905
{
    public struct Point
    {
        public int X;
    }

    public static class Holder
    {
        public static unsafe int ReadChained(Point** pp)
        {
            return (*pp)->X;
        }
    }
}
");

        Assert.Contains("return (*pp)->X", rendered, StringComparison.Ordinal);
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
