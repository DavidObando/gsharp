// <copyright file="Issue4350IndexerArgumentsAndPromotionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import System
import Xunit

/// Issue #4350: two silent miscompiles found by the `Gsharp.Runtime.Values`
/// self-migration. A multi-parameter indexer access (`slice[index,
/// fromEnd]`) dropped every argument after the first, and an integral
/// constant was narrowed to the other operand's type even when C# performs the
/// operation in the constant's wider type (`2L * capacity` became the
/// overflowing `int32(2L) * capacity`).
open class Issue4350IndexerArgumentsAndPromotionTranslationTests {
    @Fact
    func MultiParameterIndexer_KeepsEveryArgumentInOrder() {
        let printed = Render(`
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
            int read = grid[Step(log, "r", 1), Flag(log, "f", true)];
            grid[0, false] = 10;
            grid[Step(log, "c", 0), Flag(log, "g", false)] += 5;
            Grid maybe = grid;
            int? conditional = maybe?[2, false];
            return read + "," + grid[0, false] + "," + conditional + "," + string.Join("", log);
        }
    }
}
`)
        // Every argument survives, in source order, for reads, writes,
        // compound writes, and null-conditional access. Before this fix cs2gs
        // silently printed `grid[Step(log, "r", 1)]` and gsc bound the wrong
        // indexer.
        Assert.Contains("grid[Step(log, \"r\", 1), Flag(log, \"f\", true)]", printed, StringComparison.Ordinal)
        Assert.Contains("grid[0, false] = 10", printed, StringComparison.Ordinal)
        Assert.Contains("grid[Step(log, \"c\", 0), Flag(log, \"g\", false)] += 5", printed, StringComparison.Ordinal)
        Assert.Contains("?[2, false]", printed, StringComparison.Ordinal)
        Assert.Contains("grid[0, false]", printed, StringComparison.Ordinal)
        Assert.True(TranslationTestValidation.AssertBinds(printed)!!.Success)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal("5,15,3,rfcg", result.Value)
    }

    @Fact
    func LongConstantTimesInt_MultipliesInLong() {
        let printed = Render(`
using System;
namespace Corpus.Issue4350
{
    public class Probe
    {
        public static long Run(int capacity, int length)
            => Math.Max((long)length, Math.Max(4L, 2L * capacity));
    }
}
`)
        Assert.DoesNotContain("int32(2L)", printed, StringComparison.Ordinal)
        Assert.True(TranslationTestValidation.AssertBinds(printed)!!.Success)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe.Run(1500000000, 7)")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(3_000_000_000L, result.Value)
    }

    @Fact
    func LongConstantShiftedByInt_ShiftsInLong() {
        // Review finding: a shift is typed by its left operand; `2L << count`
        // is a `long` shift even though the count is `int`.
        let printed = Render(`
namespace Corpus.Issue4350
{
    public class Probe
    {
        public static long Run(int count) => (2L << count) + (1L >> count);
    }
}
`)
        Assert.DoesNotContain("int32(2L)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("int32(1L)", printed, StringComparison.Ordinal)
        Assert.True(TranslationTestValidation.AssertBinds(printed)!!.Success)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe.Run(40)")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(2L << 40, result.Value)
    }

    @Fact
    func IntConstantComparedWithNarrowOperand_StaysNarrowed() {
        // Comparisons are unaffected: the result is bool either way, so the
        // constant is still retyped to the narrow operand for readability.
        let printed = Render(`
namespace Corpus.Issue4350
{
    public class Probe
    {
        public static bool Run(ushort channelCount) => channelCount == 2;
    }
}
`)
        Assert.Contains("channelCount == uint16(2)", printed, StringComparison.Ordinal)
        Assert.True(TranslationTestValidation.AssertBinds(printed)!!.Success)
    }

    @Fact
    func NamedIndexArgumentsInParameterOrder_DropNames() {
        let printed = Render(GridSource("grid[row: 1, fromEnd: true]"))
        Assert.Contains("grid[1, true]", printed, StringComparison.Ordinal)
        Assert.True(TranslationTestValidation.AssertBinds(printed)!!.Success)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func ReorderedNamedIndexArguments_ReportUnsupported() {
        // Review finding: `grid[fromEnd: true, row: 1]` binds by name; printing
        // it positionally would swap the parameters, so it is reported.
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){("Source.cs", GridSource("grid[fromEnd: true, row: 1]"))}
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let _ = CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "out of parameter order",
                StringComparison.Ordinal
            )
        )
    }

    shared {
        private func GridSource(access string) string -> `
namespace Corpus.Issue4350
{
    public class Grid
    {
        private readonly int[] cells = { 1, 2, 3, 4, 5, 6 };

        public int this[int row, bool fromEnd] => fromEnd ? cells[cells.Length - 1 - row] : cells[row];
    }

    public class Probe
    {
        public static int Run()
        {
            var grid = new Grid();
            return ` + access + `;
        }
    }
}
`

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> (
                    d.Severity is TranslationSeverity.Unsupported or TranslationSeverity.Warning
                )
            )
            return printed
        }
    }
}
