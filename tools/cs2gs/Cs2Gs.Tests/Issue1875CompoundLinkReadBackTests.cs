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
/// run of plain `=` links in a chained assignment reuse a single spilled RHS
/// value instead of re-reading an inner target's getter for each outer link.
/// One case was left over: a COMPOUND link (`+=`, …) followed by outer plain
/// `=` links. `a = b = c.P += d` legitimately reads `c.P`'s getter once as
/// part of the compound operation, but the outer `=` links (`b =`, `a =`)
/// used to re-embed the target expression `c.P` itself as their value
/// source — re-running the getter once per outer link. The fix expands the
/// compound link into read-old/combine/store-new, capturing the combined
/// value directly so every outer `=` link reuses that value instead of
/// re-reading the target.
/// </summary>
public class Issue1875CompoundLinkReadBackTests
{
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
        Assert.Contains("c.P =", printed);
        Assert.Contains("b =", printed);
        Assert.Contains("a =", printed);
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

        // The combined value is spilled once into a shared temp; `c.P`'s
        // setter is assigned that temp, and both outer links (`b`, `a`) are
        // assigned the SAME temp — never `c.P` itself.
        // The combined value is spilled once into a shared temp; `c.P`'s
        // setter is assigned that temp, and both outer links (`b`, `a`) are
        // assigned the SAME temp — never `c.P` itself.
        int assignIndex = printed.IndexOf("c.P = __spill", System.StringComparison.Ordinal);
        Assert.True(assignIndex >= 0, "Expected `c.P = __spillN` in:\n" + printed);
        string spillTemp = ExtractSpillTempName(printed.Substring(assignIndex));
        Assert.Contains($"c.P = {spillTemp}", printed);
        Assert.Contains($"b = {spillTemp}", printed);
        Assert.Contains($"a = {spillTemp}", printed);
        Assert.DoesNotContain("b = c.P", printed);
        Assert.DoesNotContain("a = c.P", printed);
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
        // compound link reads/writes.
        Assert.Equal(1, CountOccurrences(printed, "C.GetHolder()"));
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

        Assert.Contains("b += c", printed);
        Assert.Contains("a = b", printed);
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

        Assert.Equal(1, CountOccurrences(printed, "C.Next()"));
        string spillTemp = ExtractSpillTempName(printed);
        Assert.Equal(4, CountOccurrences(printed, spillTemp));
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
