// <copyright file="Issue4350IndexerArgumentsAndPromotionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4350: two silent miscompiles found by the <c>Gsharp.Runtime.Values</c>
/// self-migration. A multi-parameter indexer access (<c>slice[index,
/// fromEnd]</c>) dropped every argument after the first, and an integral
/// constant was narrowed to the other operand's type even when C# performs the
/// operation in the constant's wider type (<c>2L * capacity</c> became the
/// overflowing <c>int32(2L) * capacity</c>).
/// </summary>
public class Issue4350IndexerArgumentsAndPromotionTranslationTests
{
    [Fact]
    public void MultiParameterIndexer_KeepsEveryArgumentInOrder()
    {
        string printed = Render(@"
using System.Collections.Generic;
namespace Corpus.Issue4350
{
    public class Grid
    {
        private readonly int[] cells = { 1, 2, 3, 4, 5, 6 };

        public int this[int row, bool fromEnd]
        {
            get => fromEnd ? cells[cells.Length - 1 - row] : cells[row];
            set => cells[fromEnd ? cells.Length - 1 - row : row] = value;
        }
    }

    public class Probe
    {
        private static int Step(List<string> log, string name, int value)
        {
            log.Add(name);
            return value;
        }

        private static bool Flag(List<string> log, string name, bool value)
        {
            log.Add(name);
            return value;
        }

        public static string Run()
        {
            var log = new List<string>();
            var grid = new Grid();
            int read = grid[Step(log, ""r"", 1), Flag(log, ""f"", true)];
            grid[0, false] = 10;
            grid[Step(log, ""c"", 0), Flag(log, ""g"", false)] += 5;
            Grid maybe = grid;
            int? conditional = maybe?[2, false];
            return read + "","" + grid[0, false] + "","" + conditional + "","" + string.Join("""", log);
        }
    }
}
");

        // Every argument survives, in source order, for reads, writes,
        // compound writes, and null-conditional access. Before this fix cs2gs
        // silently printed `grid[Step(log, "r", 1)]` and gsc bound the wrong
        // indexer.
        Assert.Contains("grid[Step(log, \"r\", 1), Flag(log, \"f\", true)]", printed, StringComparison.Ordinal);
        Assert.Contains("grid[0, false] = 10", printed, StringComparison.Ordinal);
        Assert.Contains("grid[Step(log, \"c\", 0), Flag(log, \"g\", false)] += 5", printed, StringComparison.Ordinal);
        Assert.Contains("?[2, false]", printed, StringComparison.Ordinal);
        Assert.Contains("grid[0, false]", printed, StringComparison.Ordinal);
        Assert.True(TranslationTestValidation.AssertBinds(printed).Success);

        var result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal("5,15,3,rfcg", result.Value);
    }

    [Fact]
    public void LongConstantTimesInt_MultipliesInLong()
    {
        string printed = Render(@"
using System;
namespace Corpus.Issue4350
{
    public class Probe
    {
        public static long Run(int capacity, int length)
            => Math.Max((long)length, Math.Max(4L, 2L * capacity));
    }
}
");

        Assert.DoesNotContain("int32(2L)", printed, StringComparison.Ordinal);
        Assert.True(TranslationTestValidation.AssertBinds(printed).Success);

        var result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe.Run(1500000000, 7)");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(3_000_000_000L, result.Value);
    }

    [Fact]
    public void IntConstantComparedWithNarrowOperand_StaysNarrowed()
    {
        // Comparisons are unaffected: the result is bool either way, so the
        // constant is still retyped to the narrow operand for readability.
        string printed = Render(@"
namespace Corpus.Issue4350
{
    public class Probe
    {
        public static bool Run(ushort channelCount) => channelCount == 2;
    }
}
");

        Assert.Contains("channelCount == uint16(2)", printed, StringComparison.Ordinal);
        Assert.True(TranslationTestValidation.AssertBinds(printed).Success);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Source.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity is TranslationSeverity.Unsupported or TranslationSeverity.Warning);
        return printed;
    }
}
