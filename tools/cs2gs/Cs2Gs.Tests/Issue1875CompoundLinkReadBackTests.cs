// <copyright file="Issue1875CompoundLinkReadBackTests.cs" company="GSharp">
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
/// Regression tests for issue #1875, a follow-up to #1845/#1731. #1845 made a
/// run of plain or compound links from re-reading inner targets. ADR-0161 now
/// preserves the native nested assignment expression, whose compiler lowering
/// evaluates each target once and yields the stored value.
/// </summary>
public class Issue1875CompoundLinkReadBackTests
{
    [Fact]
    public void ChainedAssignment_CompoundFromEndIndex_PreservesFromEndSyntax()
    {
        string printed = TranslateUnit(@"
using System;

namespace Demo
{
    public sealed class C
    {
        public uint M(Span<uint> values)
        {
            uint result;
            result = values[^1] += 3;
            return result;
        }
    }
}");

        Assert.Contains("values[^1]", printed);
        Assert.DoesNotContain("let __spill0 = ^1", printed);
    }

    [Fact]
    public void ChainedAssignment_CompoundBitwiseComplementIndex_RemainsValueExpression()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public int M(int[] values, int index)
        {
            int result;
            result = values[~index] += 3;
            return result;
        }
    }
}");

        Assert.Contains("values[(^index)]", printed);
        Assert.DoesNotContain("__spill", printed);
        Assert.DoesNotContain("values[^index]", printed);
    }

    [Fact]
    public void ChainedAssignment_CompoundPropertyTarget_GetterReadExactlyOnce()
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
        public void M()
        {
            var c = new Holder();
            int a, b;
            a = b = c.P += 3;
            System.Console.WriteLine(a);
            System.Console.WriteLine(b);
        }
    }
}");

        // The getter's own declaration also contains the literal "get" text
        // (its body), so exactly one occurrence proves the chain lowering
        // itself never calls the getter a second time for the outer `a =`/
        // `b =` links.
        Assert.Equal(1, CountOccurrences(printed, "\"get\""));
        Assert.Contains("a = (b = (c.P += 3))", printed);
    }

    [Fact]
    public void ChainedAssignment_CompoundPropertyTarget_OuterLinksReuseStoredValue()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Holder
    {
        private int backing;

        public int P
        {
            get => this.backing;
            set { this.backing = value; }
        }
    }

    public sealed class C
    {
        public void M()
        {
            var c = new Holder();
            int a, b;
            a = b = c.P += 3;
            System.Console.WriteLine(a);
            System.Console.WriteLine(b);
        }
    }
}");

        Assert.DoesNotContain("__spill", printed);
        Assert.Contains("a = (b = (c.P += 3))", printed);
    }

    [Fact]
    public void ChainedAssignment_CompoundIndexerTarget_ThreeOuterLinks_ReadsBackOnce()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Holder
    {
        private int[] backing = new int[4];

        public int this[int i]
        {
            get { System.Console.WriteLine(""get""); return this.backing[i]; }
            set { this.backing[i] = value; }
        }
    }

    public sealed class C
    {
        public void M()
        {
            var arr = new Holder();
            int a, b, d;
            a = b = d = arr[0] += 3;
            System.Console.WriteLine(a);
            System.Console.WriteLine(b);
            System.Console.WriteLine(d);
        }
    }
}");

        // Three outer `=` links above the compound indexer link still only
        // read the getter once.
        Assert.Equal(1, CountOccurrences(printed, "\"get\""));
    }

    [Fact]
    public void ChainedAssignment_SideEffectingReceiver_EvaluatedOnceInOrder()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Holder
    {
        public int P { get; set; }
    }

    public sealed class C
    {
        private static int calls;

        private static Holder GetHolder()
        {
            calls++;
            return new Holder();
        }

        public void M()
        {
            int a, b;
            a = b = GetHolder().P += 3;
            System.Console.WriteLine(a);
            System.Console.WriteLine(b);
        }
    }
}");

        // The receiver-producing call (`GetHolder()`) is evaluated exactly
        // once, spilled into a temp, and that temp's `.P` is what the
        // compound link reads/writes. (1 func declaration + 1 call site.)
        Assert.Equal(2, CountOccurrences(printed, "GetHolder()"));
    }

    [Fact]
    public void ChainedAssignment_TrivialCompoundTarget_Unchanged()
    {
        // `a = b += c`: `b` is a bare local, not a property/indexer, so
        // re-embedding it as the outer link's value has no observable getter
        // effect — the #1845-era read-back lowering for compound links is
        // preserved as-is for this case (no unnecessary spill/expansion).
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
    public void ChainedAssignment_PlainOnlyChain_StillSharesOneComputedValue()
    {
        // Pure #1845 case (no compound link at all) must still work unchanged.
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

        Assert.Equal(1, CountOccurrences(printed, "= Next()"));
        Assert.DoesNotContain("__spill", printed);
        Assert.Contains("a = (b = (c = Next()))", printed);
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
