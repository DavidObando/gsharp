// <copyright file="Issue1845ChainedAssignmentReadBackTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #1845, a follow-up to #1731/#1842. The earlier
/// fix stopped a chained assignment's inner target from having its
/// side-effecting receiver/index evaluated twice, but it still re-embedded
/// the (now duplication-safe) target as the VALUE read back for the next
/// (outer) link — `a = b = c` lowered to `b = c; a = b`. When the inner
/// target is a property or indexer, that read-back calls its GETTER, which
/// C# never does: a plain-`=` chain assigns the RHS VALUE to every target and
/// only ever calls the SETTERS. The fix binds the RHS to a shared temp once
/// and assigns that temp to every target in the chain, for chains of any
/// length, while a compound-operator link (`+=`, …) still reads its target
/// back afterward — that read is real C# semantics (the link produces a new,
/// not-yet-known value), unrelated to this bug.
/// </summary>
public class Issue1845ChainedAssignmentReadBackTests
{
    [Fact]
    public void ChainedAssignment_PropertyInnerTarget_NeverCallsGetterOnReadBack()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Holder
    {
        private int backing;

        public int P
        {
            get { System.Console.WriteLine(""get""); return this.backing; }
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
}");

        // The setter runs once (`obj.P = __spillN`); the getter (`get { … }`
        // body) is never invoked from the chain lowering itself — only its
        // own declaration site (`get { System.Console.WriteLine(...) }`)
        // contains the "get" text, so a single occurrence proves no read-back
        // call was emitted.
        Assert.Equal(1, CountOccurrences(printed, "\"get\""));
        Assert.Contains("__spill", printed);
        Assert.Contains("obj.P =", printed);
        Assert.Equal(1, CountOccurrences(printed, "C.SideEffect()"));
    }

    [Fact]
    public void ChainedAssignment_ThreeLinkChain_SharesOneComputedValue()
    {
        string printed = TranslateUnit(@"
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
}");

        // `Next()` is evaluated exactly once, spilled into one shared temp,
        // and that temp is assigned to all three targets.
        Assert.Equal(1, CountOccurrences(printed, "C.Next()"));
        Assert.Contains("__spill", printed);

        string spillTemp = ExtractSpillTempName(printed);
        Assert.Equal(4, CountOccurrences(printed, spillTemp));
    }

    [Fact]
    public void ChainedAssignment_SideEffectingIndexInMiddleTarget_EvaluatesOnceInOrder()
    {
        string printed = TranslateUnit(@"
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
}");

        // The index-producing call runs exactly once, spilled into a shared
        // temp; that temp — not a second `NextIndex()` call — is used as the
        // element index, and all three targets receive the same literal
        // value (7).
        Assert.Equal(1, CountOccurrences(printed, "= NextIndex()"));
        string spillTemp = ExtractSpillTempName(printed);
        Assert.Contains($"buf[{spillTemp}] = 7", printed);
        Assert.Contains("a = 7", printed);
        Assert.Contains("c = 7", printed);
    }

    [Fact]
    public void ChainedAssignment_CompoundInnerLink_StillReadsBackNewValue()
    {
        // `a = b += c`: this is NOT the #1845 bug — `b += c` genuinely
        // produces a new value that only a read-back of `b` can supply, so
        // the compound link must keep reading its target back afterward.
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("b += c", printed);
        Assert.Contains("a = b", printed);
    }

    [Fact]
    public void SimpleAssignment_Unchanged()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.DoesNotContain("__spill", printed);
        Assert.Contains("a = c", printed);
    }

    private static string ExtractSpillTempName(string printed)
    {
        int start = printed.IndexOf("__spill", System.StringComparison.Ordinal);
        Assert.True(start >= 0, "Expected a __spill temp in:\n" + printed);
        int end = start;
        while (end < printed.Length && (char.IsLetterOrDigit(printed[end]) || printed[end] == '_'))
        {
            end++;
        }

        return printed.Substring(start, end - start);
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        for (int index = haystack.IndexOf(needle, System.StringComparison.Ordinal);
            index >= 0;
            index = haystack.IndexOf(needle, index + needle.Length, System.StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(System.Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
