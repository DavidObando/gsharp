// <copyright file="Issue1895DeconstructAssignTranslationTests.cs" company="GSharp">
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
/// Issue #1895: a C# deconstruction-ASSIGNMENT into EXISTING locals
/// (<c>(x, y) = (y, x);</c>) was mis-classified as a deconstruction-
/// DECLARATION and emitted its targets as brand-new <c>let</c> bindings; the
/// element-wise write-back then failed gsc <c>GS0127</c> ("read-only")
/// because a G# <c>let</c> is immutable.
///
/// The fix spills the whole right-hand side ONCE into a flat
/// <c>let (t0, t1, ...) = rhs</c> (G#'s native tuple-deconstruction
/// binding — the same mechanism the declaration form already uses, so it
/// inherits support for a tuple literal, a tuple-returning call, and a
/// <c>Deconstruct</c>-method type RHS for free) and then, per target:
/// <list type="bullet">
/// <item>an EXISTING local (or member/element access) → a plain
/// assignment from its temp (and the existing local is now correctly
/// classified as reassigned, so its own declaration binds <c>var</c>, not
/// <c>let</c>);</item>
/// <item>a mixed-form NEW binding (<c>(x, var y) = ...</c>) → a
/// <c>let</c>/<c>var</c> declaration from its temp;</item>
/// <item>a discard (<c>(x, _) = ...</c>) → no statement at all (the native
/// deconstruction binding already discards a literal <c>_</c> name).</item>
/// </list>
/// Spilling the RHS as a single statement (rather than one assignment per
/// element) also preserves C#'s evaluate-then-assign-all semantics, so an
/// aliasing swap (<c>(a, b) = (b, a)</c>) is lowered correctly. A NESTED
/// target (<c>((a, b), c) = ...</c>) recurses: the nested arm gets its own
/// temp, which a SECOND <c>let (...) = temp</c> statement then further
/// deconstructs (issue #1974).
/// </summary>
public class Issue1895DeconstructAssignTranslationTests
{
    [Fact]
    public void Swap_ExistingLocals_LowersToSpillThenAssignments()
    {
        string rendered = Render(@"
namespace Corpus.Issue1895
{
    public class Holder
    {
        public void M()
        {
            int x = 1;
            int y = 2;
            (x, y) = (y, x);
            System.Console.WriteLine(x + y);
        }
    }
}
");

        Assert.Contains("var x = 1", rendered, StringComparison.Ordinal);
        Assert.Contains("var y = 2", rendered, StringComparison.Ordinal);
        Assert.Contains("let (__decon0, __decon1) = (y, x)", rendered, StringComparison.Ordinal);
        Assert.Contains("x = __decon0", rendered, StringComparison.Ordinal);
        Assert.Contains("y = __decon1", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("let x", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("let y", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SingleExistingTarget_LowersToAssignmentNotLetBinding()
    {
        string rendered = Render(@"
namespace Corpus.Issue1895
{
    public class Holder
    {
        public void M()
        {
            int x = 1;
            int z = 2;
            (x, z) = (5, 6);
            System.Console.WriteLine(x + z);
        }
    }
}
");

        Assert.Contains("var x = 1", rendered, StringComparison.Ordinal);
        Assert.Contains("var z = 2", rendered, StringComparison.Ordinal);
        Assert.Contains("x = __decon0", rendered, StringComparison.Ordinal);
        Assert.Contains("z = __decon1", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void MixedTarget_ExistingLocalAssignsNewLocalDeclares()
    {
        string rendered = Render(@"
namespace Corpus.Issue1895
{
    public class Holder
    {
        public void M()
        {
            int x = 1;
            (x, var y) = (2, 3);
            System.Console.WriteLine(x + y);
        }
    }
}
");

        Assert.Contains("x = __decon0", rendered, StringComparison.Ordinal);
        Assert.Contains("let y = __decon1", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void DiscardTarget_DropsAssignmentForDiscardedElement()
    {
        string rendered = Render(@"
namespace Corpus.Issue1895
{
    public class Holder
    {
        public void M()
        {
            int x = 1;
            (x, _) = (2, 3);
            System.Console.WriteLine(x);
        }
    }
}
");

        Assert.Contains("let (__decon0, _) = (2, 3)", rendered, StringComparison.Ordinal);
        Assert.Contains("x = __decon0", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void DeclarationForm_StillLowersToLetBinding()
    {
        // Regression: `var (x, y) = e` is a deconstruction-DECLARATION (both
        // elements are brand-new locals), not an assignment, and must keep
        // its existing `let (x, y) = e` lowering.
        string rendered = Render(@"
namespace Corpus.Issue1895
{
    public class Holder
    {
        public void M()
        {
            var (x, y) = (1, 2);
            System.Console.WriteLine(x + y);
        }
    }
}
");

        Assert.Contains("let (x, y) = (1, 2)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void NestedTarget_LowersToChainedDeconstructionStatements()
    {
        // `((a, b), c) = ((4, 5), 6)` (issue #1974): the outer temp holding the
        // nested element is deconstructed by a SECOND native `let (...) = ...`
        // binding rather than gapping.
        string rendered = Render(@"
namespace Corpus.Issue1895
{
    public class Holder
    {
        public void M()
        {
            int a = 1;
            int b = 2;
            int c = 3;
            ((a, b), c) = ((4, 5), 6);
            System.Console.WriteLine(a + b + c);
        }
    }
}
");

        Assert.Contains("let (__decon0, __decon1) = ((4, 5), 6)", rendered, StringComparison.Ordinal);
        Assert.Contains("let (__decon2, __decon3) = __decon0", rendered, StringComparison.Ordinal);
        Assert.Contains("a = __decon2", rendered, StringComparison.Ordinal);
        Assert.Contains("b = __decon3", rendered, StringComparison.Ordinal);
        Assert.Contains("c = __decon1", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void DeclarationDiscardTarget_UsesUnderscoreInSpillNoUnusedTemp()
    {
        // `(x, var _) = e`: the discard is a `DeclarationExpressionSyntax`
        // wrapping a `DiscardDesignationSyntax`, not a bare `_` identifier.
        // It must spill as a literal `_` (discarded by G#'s native
        // deconstruction binding), not an unused `__deconN` temp.
        string rendered = Render(@"
namespace Corpus.Issue1895
{
    public class Holder
    {
        public void M()
        {
            int x = 1;
            (x, var _) = (2, 3);
            System.Console.WriteLine(x);
        }
    }
}
");

        Assert.Contains("let (__decon0, _) = (2, 3)", rendered, StringComparison.Ordinal);
        Assert.Contains("x = __decon0", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void NestedAllDiscardTarget_SkipsPointlessInnerBinding()
    {
        // `(x, (_, _)) = e` (issue #2099, item 3): the nested arm is entirely
        // discards, so it must not allocate a real temp for itself or emit a
        // pointless inner `let (_, _) = __deconN` binding.
        string rendered = Render(@"
namespace Corpus.Issue1895
{
    public class Holder
    {
        public void M()
        {
            int x = 1;
            (x, (_, _)) = (2, (3, 4));
            System.Console.WriteLine(x);
        }
    }
}
");

        Assert.Contains("let (__decon0, _) = (2, (3, 4))", rendered, StringComparison.Ordinal);
        Assert.Contains("x = __decon0", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("let (_, _)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ElementAccessTarget_NowLowersWithoutGap()
    {
        // `(arr[i], y) = rhs`: issue #2234 generalizes the #1895 lowering to
        // capture `arr`/`i` into temps BEFORE the RHS is spilled (via
        // `MakeDuplicationSafeTarget`), preserving C#'s evaluation order —
        // no more loud gap.
        string rendered = Render(@"
namespace Corpus.Issue1895
{
    public class Holder
    {
        public void M()
        {
            int[] arr = new int[2];
            int i = 0;
            int y = 1;
            (arr[i], y) = (2, 3);
            System.Console.WriteLine(arr[0] + y);
        }
    }
}
");
        AssertRoundTripParses(rendered);
        Assert.Contains("let (__decon", rendered);
        Assert.Contains("arr[i]", rendered);
    }

    [Fact]
    public void MemberAccessTarget_NowLowersWithoutGap()
    {
        // `(obj.F, y) = rhs`: same generalization as the element-access case.
        string rendered = Render(@"
namespace Corpus.Issue1895
{
    public class Box
    {
        public int F;
    }

    public class Holder
    {
        public void M()
        {
            var obj = new Box();
            int y = 1;
            (obj.F, y) = (2, 3);
            System.Console.WriteLine(obj.F + y);
        }
    }
}
");
        AssertRoundTripParses(rendered);
        Assert.Contains("let (__decon", rendered);
        Assert.Contains("obj.F", rendered);
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
