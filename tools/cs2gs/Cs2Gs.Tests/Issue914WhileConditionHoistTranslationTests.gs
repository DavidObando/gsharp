// <copyright file="Issue914WhileConditionHoistTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Regression tests for the `Oahu.Decrypt` migration fix tracked under
/// issue #914: a `while`/`do-while` whose condition carries a
/// side-effecting `is`-pattern clause (a call declaring `out var`
/// matched against an `and`/`not` pattern combinator). G# has no
/// `and`/`not` combinators, so the naive lowering re-emitted the
/// scrutinee per sub-test — re-running the call and re-declaring the
/// `out var` (→ GS0102). The fix hoists the scrutinee to a single local at
/// the top of the loop body and converts the trailing pattern tests into
/// `break` guards, keeping the leading side-effect-free clauses as the real
/// loop condition. Since ADR-0166 / issue #3409, G# accepts pattern variables
/// (and the ADR-0162 `and`/`not` combinators) directly in a boolean
/// `is`, so a loop whose designations all qualify is emitted verbatim and
/// the hoist remains the fallback for the other shapes. Each snippet must
/// round-trip-parse through the real G# parser.
open class Issue914WhileConditionHoistTranslationTests {
    /// The motivating `Frame.LoadChildren` shape:
    /// `while (a && b && M(out var n) is Frame child and not EmptyFrame)`.
    /// ADR-0166 / issue #3409: the whole condition is emitted verbatim as a native
    /// pattern variable in the loop condition — the scrutinee call, the
    /// `out var` declaration and the binder each appear exactly once and no
    /// hoist local or `break` guard is produced.
    @Fact
    func WhileWithOutVarAndPatternCombinator_UsesNativePatternVariable() {
        let printed = TranslateUnit(`
namespace Demo
{
    public abstract class Frame { }

    public sealed class EmptyFrame : Frame { }

    public sealed class RealFrame : Frame { }

    public static class TagFactory
    {
        public static Frame CreateTag(out int lengthRead)
        {
            lengthRead = 1;
            return new RealFrame();
        }
    }

    public sealed class Loader
    {
        public System.Collections.Generic.List<Frame> Children { get; } = new();

        public void LoadChildren(int endPosition)
        {
            int position = 0;
            int origPosition = position;

            while (position < endPosition
                && origPosition == position
                && TagFactory.CreateTag(out var lengthRead) is Frame child and not EmptyFrame)
            {
                origPosition += lengthRead;
                Children.Add(child);
            }
        }
    }
}`)
        // ADR-0166 / issue #3409: the whole condition — leading pure clauses, the
        // side-effecting scrutinee, the `and not` combinator and the binder — is
        // the native loop condition.
        Assert.Contains("while position < endPosition &&", printed, StringComparison.Ordinal)
        Assert.Contains("(TagFactory.CreateTag(out var lengthRead) is Frame child and not EmptyFrame) {", printed)
        // No hoist local and no `break` guard are produced.
        Assert.DoesNotContain("let child", printed)
        Assert.DoesNotContain("break", printed)
        Assert.DoesNotContain("__spill", printed)
        // The `out var` declaration and the call must each appear exactly once.
        Assert.Equal(1, CountOccurrences(printed, "out var lengthRead"))
        Assert.Equal(1, CountOccurrences(printed, "TagFactory.CreateTag"))
        // The body reads the pattern variable and the out-var.
        Assert.Contains("origPosition += lengthRead", printed)
        Assert.Contains("Children.Add(child)", printed)
    }

    /// A plain `while` with no pattern binding or side-effecting duplicated
    /// scrutinee must be left as a plain `while cond { }` — the hoist
    /// transform must not regress ordinary loops.
    @Fact
    func SimpleWhile_IsNotHoisted() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        public int Sum(int n)
        {
            int i = 0;
            int total = 0;
            while (i < n)
            {
                total += i;
                i++;
            }

            return total;
        }
    }
}`)
        Assert.Contains("while i < n {", printed)
        Assert.DoesNotContain("break", printed)
    }

    /// A `while` whose only condition is a side-effecting pattern clause
    /// (no leading pure clauses). ADR-0166 / issue #3409: the pattern is the
    /// native loop condition (no `while true` + hoist + `break` guard).
    @Fact
    func WhilePatternOnly_UsesNativePatternVariableCondition() {
        let printed = TranslateUnit(`
namespace Demo
{
    public abstract class Node { }

    public sealed class Stop : Node { }

    public sealed class Step : Node { }

    public static class Source
    {
        public static Node Next(out int read)
        {
            read = 1;
            return new Step();
        }
    }

    public sealed class C
    {
        public int Drain()
        {
            int consumed = 0;
            while (Source.Next(out var read) is Node node and not Stop)
            {
                consumed += read;
            }

            return consumed;
        }
    }
}`)
        Assert.Contains("while (Source.Next(out var read) is Node node and not Stop) {", printed)
        Assert.Contains("consumed += read", printed)
        Assert.DoesNotContain("while true {", printed)
        Assert.DoesNotContain("let node", printed)
        Assert.DoesNotContain("break", printed)
        Assert.Equal(1, CountOccurrences(printed, "out var read"))
        Assert.Equal(1, CountOccurrences(printed, "Source.Next"))
    }

    shared {
        private func CountOccurrences(haystack string, needle string) int32 {
            var count = 0
            for var index = haystack.IndexOf(needle, StringComparison.Ordinal); index >= 0; index = haystack.IndexOf(
                needle,
                index + needle.Length,
                StringComparison.Ordinal
            ) {
                count++
            }
            return count
        }

        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
