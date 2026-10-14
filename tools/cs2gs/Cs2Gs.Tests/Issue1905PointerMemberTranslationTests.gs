// <copyright file="Issue1905PointerMemberTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1905: a C# pointer member access `p->X` parses as a
/// (cref:Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax)
/// distinguished from plain `p.X` only by its
/// `SyntaxKind.PointerMemberAccessExpression` kind, and the translator
/// previously dropped that distinction, emitting a bare `p.X` — which
/// gsc rejects on a pointer receiver (GS0158). gsc's own G# grammar already
/// has a native `->` operator (sugar for `(*p).X`, ADR-0122 §4 /
/// issue #1034) that its parser desugars at parse time, so the fix simply
/// preserves the arrow instead of rewriting it to a dot. Covers field access
/// (read and assignment target), a method call, and a chained
/// `a->b->c` receiver.
open class Issue1905PointerMemberTranslationTests {
    @Fact
    func FieldRead_LowersToNativeArrow() {
        let rendered = Render(`
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
`)
        Assert.Contains("return p->X", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("p.X", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func FieldWrite_AssignmentTarget_LowersToNativeArrow() {
        let rendered = Render(`
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
`)
        Assert.Contains("p->X = 10", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func MethodCall_LowersToNativeArrowReceiver() {
        let rendered = Render(`
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
`)
        Assert.Contains("return p->Sum()", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ChainedArrow_LowersEachSegmentToNativeArrow() {
        // Each `->` recurses through the same translation path, so a chained
        // `a->b->c` receiver — here a pointer-to-pointer double-dereference,
        // since G# has no pointer-typed struct field (GS9006) to chain
        // through a real member — lowers with every arrow preserved.
        let rendered = Render(`
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
`)
        Assert.Contains("return (*pp)->X", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result = TranslationTestValidation.ValidateRoundTripOnly(
                rendered,
                "G# currently rejects managed-pointer parameter types even though native pointer-member syntax parses."
            )
            Assert.True(
                result.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            return GSharpPrinter.Print(unit)
        }
    }
}
