// <copyright file="Issue4859YieldedTemporaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4859: <c>yield return</c> values only need a temporary when their
/// printed form starts with <c>(</c> and is not a tuple literal (#4705), or
/// when it starts with a nonempty <c>[</c> (a sized array, <c>yield [3]T</c>
/// parses as indexing), or when it is a branching expression, which needs the
/// iterator element type as its target (#4719).
/// Everything else prints inline, and a remaining temporary has a readable name, never <c>__yielded{N}</c>.
/// </summary>
public sealed class Issue4859YieldedTemporaryTests
{
    [Fact]
    public void CommonYieldShapes_PrintInlineWithoutATemporary()
    {
        string printed = Translate("""
            using System;
            using System.Collections.Generic;

            public static class Obj
            {
                public static string Name(int n) => "n" + n;

                public static IEnumerable<object[]> Rows(int num)
                {
                    yield return new object[] { 1, "a", Array.Empty<string>() };
                    yield return new object[] { 2, "b", Array.Empty<string>() };
                }

                public static IEnumerable<string> Texts(int num)
                {
                    yield return "static";
                    yield return Name(num);
                    yield return $"GS{num:D4}";
                    yield return string.Concat("a", "b");
                }
            }
            """);

        Assert.DoesNotContain("__yielded", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("let item", printed, StringComparison.Ordinal);
        Assert.Contains("yield []object{", printed, StringComparison.Ordinal);
        Assert.Contains("yield \"static\"", printed, StringComparison.Ordinal);
        Assert.Contains("yield Name(num)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ParenthesisStartingValue_UsesReadableCollisionCheckedName()
    {
        string printed = Translate("""
            using System.Collections.Generic;

            public static class Obj
            {
                public static IEnumerable<int> Conditional(bool choose, int item, int y, int z)
                {
                    yield return (choose ? item : y) + z;
                    yield return (choose ? y : item) + z;
                }

                public static int Run()
                {
                    int total = 0;
                    foreach (int v in Conditional(true, 1, 2, 10))
                    {
                        total += v;
                    }

                    return total;
                }
            }
            """);

        Assert.DoesNotContain("__yielded", printed, StringComparison.Ordinal);
        Assert.Contains("let item_2 int32 =", printed, StringComparison.Ordinal);
        Assert.Contains("let item_3 int32 =", printed, StringComparison.Ordinal);
        Assert.Contains("yield item_2", printed, StringComparison.Ordinal);
        EmittedOracleResult result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal(11 + 12, result.Value);
    }

    [Fact]
    public void NameAllocation_IsPerMember_NotPerType()
    {
        string printed = Translate("""
            using System.Collections.Generic;

            public static class Obj
            {
                public static int Unrelated(int item) => item;

                public static IEnumerable<int> Rows(bool choose, int y, int z)
                {
                    yield return (choose ? y : z) + 1;
                }
            }
            """);

        Assert.Contains("let item int32 =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("item_2", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void SizedArrayYield_IsMaterializedBecauseYieldBracketIsAnIndex()
    {
        string printed = Translate("""
            using System.Collections.Generic;

            public static class Obj
            {
                public static IEnumerable<int[]> Rows()
                {
                    yield return new int[3];
                }

                public static int Run()
                {
                    int total = 0;
                    foreach (int[] row in Rows())
                    {
                        total += row.Length;
                    }

                    return total;
                }
            }
            """);

        Assert.DoesNotContain("yield [", printed, StringComparison.Ordinal);
        Assert.Contains("yield item", printed, StringComparison.Ordinal);
        EmittedOracleResult result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void BranchingYield_IsMaterializedSoTheElementTypeIsItsTarget()
    {
        string printed = Translate("""
            using System.Collections.Generic;

            public static class Obj
            {
                public static IEnumerable<object> Rows(bool b, string s, int n)
                {
                    yield return b ? s : n;
                }

                public static int Run()
                {
                    int total = 0;
                    foreach (object row in Rows(false, "x", 4))
                    {
                        total += (int)row;
                    }

                    return total;
                }
            }
            """);

        Assert.DoesNotContain("yield if", printed, StringComparison.Ordinal);
        Assert.Matches(@"let item(_\d+)? ", printed);
        EmittedOracleResult result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void GuardCaptureLocal_AndYieldTemporary_DoNotCollide()
    {
        string printed = Translate("""
            using System.Collections.Generic;

            public class Holder
            {
                public string Item { get; }

                public IEnumerable<int> Rows(bool choose, int y, int z)
                {
                    if (Item == null)
                    {
                        throw new System.InvalidOperationException();
                    }

                    int length = Item.Length;
                    yield return (choose ? y : z) + length;
                }
            }
            """);

        Assert.Contains("let item = Item!!", printed, StringComparison.Ordinal);
        Assert.Contains("let item_2 int32 =", printed, StringComparison.Ordinal);
        Assert.Contains("yield item_2", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void InlineArrayYield_BindsAndRuns()
    {
        string printed = Translate("""
            using System.Collections.Generic;

            public static class Obj
            {
                public static IEnumerable<object[]> Rows()
                {
                    yield return new object[] { 1, "a" };
                    yield return new object[] { 2, "b" };
                }

                public static int Run()
                {
                    int total = 0;
                    foreach (object[] row in Rows())
                    {
                        total += (int)row[0];
                    }

                    return total;
                }
            }
            """);

        Assert.DoesNotContain("__yielded", printed, StringComparison.Ordinal);
        EmittedOracleResult result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal(3, result.Value);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) },
            null);
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
