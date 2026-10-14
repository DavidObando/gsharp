// <copyright file="Issue1895DeconstructAssignTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import System
import Xunit

/// Issue #1895: a C# deconstruction-ASSIGNMENT into EXISTING locals
/// (`(x, y) = (y, x);`) was mis-classified as a deconstruction-
/// DECLARATION and emitted its targets as brand-new `let` bindings; the
/// element-wise write-back then failed gsc `GS0127` ("read-only")
/// because a G# `let` is immutable.
///
/// The fix spills the whole right-hand side ONCE into a flat
/// `let (t0, t1, ...) = rhs` (G#'s native tuple-deconstruction
/// binding — the same mechanism the declaration form already uses, so it
/// inherits support for a tuple literal, a tuple-returning call, and a
/// `Deconstruct`-method type RHS for free) and then, per target:
/// - an EXISTING local (or member/element access) → a plain assignment from its temp (and the existing
/// local is now correctly classified as reassigned, so its own declaration binds `var`, not `let`);
/// - a mixed-form NEW binding (`(x, var y) = ...`) → a `let`/`var` declaration from its temp;
/// - a discard (`(x, _) = ...`) → no statement at all (the native deconstruction binding already
/// discards a literal `_` name).
/// Spilling the RHS as a single statement (rather than one assignment per
/// element) also preserves C#'s evaluate-then-assign-all semantics, so an
/// aliasing swap (`(a, b) = (b, a)`) is lowered correctly. A NESTED
/// target (`((a, b), c) = ...`) recurses: the nested arm gets a
/// source-derived carrier, which a SECOND `let (...) = carrier`
/// statement then further deconstructs (issues #1974/#4300).
open class Issue1895DeconstructAssignTranslationTests {
    @Fact
    func Swap_ExistingLocals_LowersToSpillThenAssignments() {
        let rendered = Render(`
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
`)
        Assert.Contains("var x = 1", rendered, StringComparison.Ordinal)
        Assert.Contains("var y = 2", rendered, StringComparison.Ordinal)
        // Issue #3358: G#'s native multi-target assignment (ADR-0015) evaluates
        // every right-hand expression before any write, so the aliasing swap is
        // correct without the tool synthesising its own temps.
        Assert.Contains("x, y = y, x", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("let x", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("let y", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SingleExistingTarget_LowersToAssignmentNotLetBinding() {
        let rendered = Render(`
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
`)
        Assert.Contains("var x = 1", rendered, StringComparison.Ordinal)
        Assert.Contains("var z = 2", rendered, StringComparison.Ordinal)
        // Issue #3358: native multi-target assignment, no temps.
        Assert.Contains("x, z = 5, 6", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func MixedTarget_ExistingLocalAssignsNewLocalDeclares() {
        let rendered = Render(`
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
`)
        Assert.Contains("x, let y = 2, 3", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func DiscardTarget_DropsAssignmentForDiscardedElement() {
        let rendered = Render(`
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
`)
        // Issue #3358: `_` is a native multi-assignment target, so the discarded
        // element needs no temp either.
        Assert.Contains("x, _ = 2, 3", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func DeclarationForm_StillLowersToLetBinding() {
        // Regression: `var (x, y) = e` is a deconstruction-DECLARATION (both
        // elements are brand-new locals), not an assignment, and must keep
        // its existing `let (x, y) = e` lowering.
        let rendered = Render(`
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
`)
        Assert.Contains("let (x, y) = (1, 2)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func MutableDeclarationForm_UsesVarTupleBinding() {
        let rendered = Render(`
namespace Corpus.Issue1895
{
    public class Holder
    {
        public void M()
        {
            var (x, y) = (1, 2);
            x = 3;
            System.Console.WriteLine(x + y);
        }
    }
}
`)
        Assert.Contains("var (x, y) = (1, 2)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func NestedTarget_LowersToChainedDeconstructionStatements() {
        // `((a, b), c) = ((4, 5), 6)` (issue #1974): the outer temp holding the
        // nested element is deconstructed by a SECOND native `let (...) = ...`
        // binding rather than gapping.
        let rendered = Render(`
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
`)
        Assert.Contains("let (aTuple, cValue) = ((4, 5), 6)", rendered, StringComparison.Ordinal)
        Assert.Contains("let (aValue, bValue) = aTuple", rendered, StringComparison.Ordinal)
        Assert.Contains("a = aValue", rendered, StringComparison.Ordinal)
        Assert.Contains("b = bValue", rendered, StringComparison.Ordinal)
        Assert.Contains("c = cValue", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func NestedVarDesignation_DeclaresEveryLeafAndRuns() {
        let rendered = Render(`
namespace Corpus.Issue1895
{
    public sealed class Holder
    {
        public int Run()
        {
            int existing = 0;
            (existing, var (x, y)) = (1, (2, 3));
            return (existing * 100) + (x * 10) + y;
        }
    }
}
`)
        Assert.Contains("existingValue", rendered, StringComparison.Ordinal)
        Assert.Contains("let (x, y) =", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("let x =", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("let y =", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Holder().Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(123, result.Value)
    }

    @Fact
    func DeclarationDiscardTarget_UsesNativeDiscard() {
        // `(x, var _) = e`: the discard is a `DeclarationExpressionSyntax`
        // wrapping a `DiscardDesignationSyntax`, not a bare `_` identifier.
        // It remains a literal `_` target, with no unused temp.
        let rendered = Render(`
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
`)
        Assert.Contains("x, _ = 2, 3", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func NestedAllDiscardTarget_SkipsPointlessInnerBinding() {
        // `(x, (_, _)) = e` (issue #2099, item 3): the nested arm is entirely
        // discards, so it must not allocate a real temp for itself or emit a
        // pointless inner discard-only binding.
        let rendered = Render(`
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
`)
        Assert.Contains("let (xValue, _) = (2, (3, 4))", rendered, StringComparison.Ordinal)
        Assert.Contains("x = xValue", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("let (_, _)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ElementAccessTarget_NowLowersWithoutGap() {
        // Issue #3353 makes storage targets native while preserving #2234 order.
        let rendered = Render(`
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
`)
        AssertRoundTripParses(rendered)
        Assert.Contains("arr[i], y = 2, 3", rendered)
        Assert.DoesNotContain("__decon", rendered)
        Assert.DoesNotContain("__spill", rendered)
    }

    @Fact
    func MemberAccessTarget_NowLowersWithoutGap() {
        // Member storage targets use same native path.
        let rendered = Render(`
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
`)
        AssertRoundTripParses(rendered)
        Assert.Contains("obj.F, y = 2, 3", rendered)
        Assert.DoesNotContain("__decon", rendered)
        Assert.DoesNotContain("__spill", rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

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
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }
    }
}
