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
/// fix stopped chained assignments from re-reading inner targets. ADR-0161
/// now lets cs2gs preserve the native nested assignment expression directly;
/// G# owns single evaluation and returns each assigned value without a getter
/// read-back.
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

        Assert.Equal(1, CountOccurrences(printed, "\"get\""));
        Assert.DoesNotContain("__spill", printed);
        Assert.Contains("a = (obj.P = C.SideEffect())", printed);
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

        Assert.Equal(1, CountOccurrences(printed, "C.Next()"));
        Assert.DoesNotContain("__spill", printed);
        Assert.Contains("a = (b = (c = C.Next()))", printed);
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

        Assert.Equal(2, CountOccurrences(printed, "NextIndex()"));
        Assert.DoesNotContain("__spill", printed);
        Assert.Contains("a = (", printed);
        Assert.Contains("buf[", printed);
        Assert.Contains("(c = 7)", printed);
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

        Assert.Contains("a = (b += c)", printed);
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
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
