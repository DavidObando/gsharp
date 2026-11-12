// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

class Issue5978NestedArrayAssertionTests {
    @Theory
    @InlineData("new[] { rows }", "Issue5978NestedArrayAssertion")
    @InlineData("new Node?[][] { rows }", "Issue5978NestedArrayAssertion")
    @InlineData("{ rows }", "Issue5978BareArrayAssertion")
    func NestedNullableElements_DoNotAssertNonNullOuterStorage(initializer string, golden string) {
        let source = `
#nullable enable
public class Node { }
public static class P {
    public static void Main() {
        var rows = new Node?[1];
        rows = new Node?[] { new Node() };
        Node?[][] nested = INITIALIZER;
        System.Console.Write(nested.Length);
    }
}
`.Replace("INITIALIZER", initializer)
        let printed = Translate(source)
        AssertNoRelevantDiagnostics(printed)
        GoldenFile.AssertMatches(Path.Combine(AppContext.BaseDirectory, "Fixtures", golden + ".golden"), printed)
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (raw string) -> Assert.Equal(printed, raw),
            verifyAssembly: VerifyStrictIL
        )
    }

    @Fact
    func NullableOuterStorageAndElements_KeepRequiredAssertionsAndEvaluationOrder() {
        let source = `
#nullable enable
using System;
public class Node { public string Name = "node"; }
public static class P {
    static Node?[]? current;
    static int reads;
    static Node?[]? Rows { get { reads++; return current; } }
    static string Read() {
        if (Rows == null) return "nil";
        Node?[][] nested = new Node?[][] { Rows };
        try { return nested[0][0]!.Name; }
        catch (NullReferenceException) { return "nre"; }
    }
    public static void Main() {
        Node?[]? rows = null;
        var nested = new[] { rows };
        Console.Write(nested[0] == null);
        current = new Node?[] { new Node() };
        Console.Write("|" + Read());
        current = new Node?[1];
        Console.Write("|" + Read());
        current = null;
        Console.Write("|" + Read() + "|" + reads);
    }
}
`
        let printed = Translate(source)
        Assert.Contains("[][]Node?{Rows!!}", printed)
        Assert.Contains("nested[0][0]!!.Name", printed)
        AssertNoRelevantDiagnostics(printed)
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (raw string) -> Assert.Equal(printed, raw),
            verifyAssembly: VerifyStrictIL
        )
    }

    @Fact
    func ByRefElementPromotionAndReassignment_DoNotAssertNonNullOuterAliases() {
        let source = `
#nullable enable
using System;
using System.Threading;
public static class P {
    static string? cache;
    static string?[]? replacement = new string?[] { null };
    static T[] MakeArray<T>(T value) => new T[] { value };
    static void Consume(string[] values) { }
    public static void Main() {
        var consumedRow = new[] { "ok" };
        Consume(consumedRow);
        var row = new[] { "ok" };
        var alias = row;
        var rows = new[] { consumedRow, alias, new[] { Volatile.Read(ref cache!) } };
        row = new string[] { "next" };
        row = MakeArray("final");
        var snapshots = new[] { row, alias };
        row = Volatile.Read(ref replacement!);
        Console.Write(rows[0][0].Length + "|" + rows[1][0] + "|" + (rows[2][0] == null) + "|" +
            snapshots[0][0] + "|" + snapshots[1][0] + "|" + (row[0] == null));
    }
}
`
        let printed = Translate(source)
        AssertNoRelevantDiagnostics(printed)
        GoldenFile.AssertMatches(
            Path.Combine(AppContext.BaseDirectory, "Fixtures", "Issue5978ByRefArrayAliases.golden"),
            printed
        )
        Assert.Contains("row = Volatile.Read(&replacement)!!", printed)
        Assert.Contains("rows[0][0]!!.Length", printed)
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (raw string) -> Assert.Equal(printed, raw),
            verifyAssembly: VerifyStrictIL
        )
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, string){("Probe.cs", source)},
                outputKind: Microsoft.CodeAnalysis.OutputKind.ConsoleApplication
            )
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func AssertNoRelevantDiagnostics(printed string) {
            let tree = SyntaxTree.Parse(SourceText.From(printed, "Probe.gs"))
            using let references = ReferenceResolver.WithRuntimeReferences(nil)
            let compilation = Compilation(references, tree)
            let diagnostics = tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((diagnostic Diagnostic) -> diagnostic.IsError || diagnostic.Id == "GS0536")
                .ToArray()
            Assert.True(
                diagnostics.Length == 0,
                string.Join(
                    "\n",
                    diagnostics.Select(
                        (diagnostic Diagnostic) ->
                        "${diagnostic.Id} (${diagnostic.Location.StartLine + 1},${diagnostic.Location.StartCharacter + 1},${diagnostic.Location.EndLine + 1},${diagnostic.Location.EndCharacter + 1}): ${diagnostic.Message}"
                    )
                ) +
                    "\n" +
                    printed
            )
        }

        private func VerifyStrictIL(assembly string) {
            let arguments = List[string]{"tool", "run", "ilverify", assembly, "-s", "System.Private.CoreLib"}
            for reference in Directory.EnumerateFiles(
                Path.GetDirectoryName(typeof(object).Assembly.Location)!!,
                "*.dll"
            ) {
                arguments.Add("-r")
                arguments.Add(reference)
            }
            let result = ProcessRunner.Run("dotnet", arguments, IlVerifyRunner().RepoRoot)
            Assert.False(result.TimedOut, result.Output)
            Assert.True(result.ExitCode == 0, result.Output)
        }
    }
}
