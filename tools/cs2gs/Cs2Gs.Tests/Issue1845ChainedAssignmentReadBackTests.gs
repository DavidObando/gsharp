// <copyright file="Issue1845ChainedAssignmentReadBackTests.cs" company="GSharp">
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

/// Regression tests for issue #1845, a follow-up to #1731/#1842. The earlier
/// fix stopped chained assignments from re-reading inner targets. ADR-0161
/// now lets cs2gs preserve the native nested assignment expression directly;
/// G# owns single evaluation and returns each assigned value without a getter
/// read-back.
open class Issue1845ChainedAssignmentReadBackTests {
    @Fact
    func ChainedAssignment_PropertyInnerTarget_NeverCallsGetterOnReadBack() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class Holder
    {
        private int backing;

        public int P
        {
            get { System.Console.WriteLine("get"); return this.backing; }
            set { this.backing = value; }
        }
    }

    public sealed class C
    {
        private static int SideEffect() => 42;

        public void M()
        {
            var obj = new Holder();
            int a;
            a = obj.P = SideEffect();
            System.Console.WriteLine(a);
        }
    }
}`)
        Assert.Equal(1, CountOccurrences(printed, "\"get\""))
        Assert.DoesNotContain("__spill", printed)
        Assert.Contains("a = (obj.P = SideEffect())", printed)
        Assert.Equal(1, CountOccurrences(printed, "= SideEffect()"))
    }

    @Fact
    func ChainedAssignment_ThreeLinkChain_SharesOneComputedValue() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        private static int Next() => 5;

        public void M()
        {
            int a, b, c;
            a = b = c = Next();
            System.Console.WriteLine(a + b + c);
        }
    }
}`)
        Assert.Equal(1, CountOccurrences(printed, "= Next()"))
        Assert.DoesNotContain("__spill", printed)
        Assert.Contains("a = (b = (c = Next()))", printed)
    }

    @Fact
    func ChainedAssignment_SideEffectingIndexInMiddleTarget_EvaluatesOnceInOrder() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        private int[] buf = new int[10];
        private int counter;

        private int NextIndex() => counter++;

        public void M()
        {
            int a, c;
            a = buf[NextIndex()] = c = 7;
            System.Console.WriteLine(a);
        }
    }
}`)
        Assert.Equal(2, CountOccurrences(printed, "NextIndex()"))
        Assert.DoesNotContain("__spill", printed)
        Assert.Contains("a = (", printed)
        Assert.Contains("buf[", printed)
        Assert.Contains("(c = 7)", printed)
    }

    @Fact
    func ChainedAssignment_CompoundInnerLink_StillReadsBackNewValue() {
        // `a = b += c`: this is NOT the #1845 bug — `b += c` genuinely
        // produces a new value that only a read-back of `b` can supply, so
        // the compound link must keep reading its target back afterward.
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        public void M()
        {
            int a = 0;
            int b = 1;
            int c = 2;
            a = b += c;
            System.Console.WriteLine(a);
            System.Console.WriteLine(b);
        }
    }
}`)
        Assert.Contains("a = (b += c)", printed)
    }

    @Fact
    func SimpleAssignment_Unchanged() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        public void M()
        {
            int a;
            int c = 5;
            a = c;
            System.Console.WriteLine(a);
        }
    }
}`)
        Assert.DoesNotContain("__spill", printed)
        Assert.Contains("a = c", printed)
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
