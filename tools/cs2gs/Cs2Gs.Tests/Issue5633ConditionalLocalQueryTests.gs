// <copyright file="Issue5633ConditionalLocalQueryTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import System
import System.Diagnostics
import System.IO
import System.Text
import System.Threading.Tasks
import Xunit
import Xunit.Abstractions

/// Issue #5633: repeated result arms must share local-query answers, including reaching assignments and tuple projections.
/// @remarks Before this fix, the enabled reassignment and deconstruction rows exceed the ten-second translation bound.
open class Issue5633ConditionalLocalQueryTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Theory
    @InlineData(true, false, "conditional")
    @InlineData(true, true, "conditional")
    @InlineData(false, false, "conditional")
    @InlineData(false, true, "conditional")
    @InlineData(true, false, "switch")
    @InlineData(true, true, "switch")
    @InlineData(false, false, "switch")
    @InlineData(false, true, "switch")
    @InlineData(true, false, "coalesce")
    @InlineData(true, true, "coalesce")
    @InlineData(false, false, "coalesce")
    @InlineData(false, true, "coalesce")
    @InlineData(true, false, "assigned")
    @InlineData(false, false, "assigned")
    @InlineData(true, true, "assigned")
    @InlineData(false, true, "assigned")
    @InlineData(true, false, "assigned-switch")
    @InlineData(false, false, "assigned-switch")
    @InlineData(true, false, "assigned-coalesce")
    @InlineData(false, false, "assigned-coalesce")
    func JoinedLocalChain_CompletesWithinBound(enabled bool, nullableInput bool, shape string) {
        let body = StringBuilder()
        if !enabled && nullableInput {
            body.AppendLine("p = null;")
        }
        body.AppendLine("var x0 = p;")
        for var i = 1; i <= 24; i++ {
            let previous = "x${i - 1}"
            let value = switch shape {
                case "conditional", "assigned": "flag ? $previous : $previous"
                case "switch", "assigned-switch": "flag switch { true => $previous, false => $previous }"
                default: "$previous ?? $previous"
            }
            body.AppendLine("var x$i = $value;")
            if shape.StartsWith("assigned", StringComparison.Ordinal) {
                body.AppendLine("x$i = $value;")
            }
        }
        let annotation = if enabled && nullableInput {
            "?"
        } else {
            ""
        }
        let mode = if enabled {
            "enable"
        } else {
            "disable"
        }
        let source = "#nullable $mode\nnamespace Demo {\n" +
            "public class Node { public int Read() => 1; }\n" +
            "public static class P {\n" +
            "static void Take(Node$annotation value) { }\n" +
            "static Node$annotation Chain(Node$annotation p, bool flag) {\n" +
            body.ToString() +
            "Take(x24); if (x24 is var captured) Take(captured); _ = x24.Read(); return x24;\n" +
            "} } }"
        let printed = this.TranslateWithinBound(source, enabled)
        Assert.Contains("return x24", printed)
        Assert.Contains("Take(captured", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData(true, true, false)
    @InlineData(false, true, false)
    @InlineData(true, false, false)
    @InlineData(false, false, false)
    @InlineData(true, false, true)
    @InlineData(false, false, true)
    func TupleLocalChain_CompletesWithinBound(enabled bool, deconstruct bool, widened bool) {
        let input = if widened {
            "System.Threading.Volatile.Read(ref p!)"
        } else {
            "p"
        }
        let body = StringBuilder("var x0 = ($input, 0);\n")
        for var i = 1; i <= 24; i++ {
            body.AppendLine("var x$i = flag ? x${i - 1} : x${i - 1};")
            body.AppendLine("x$i = flag ? x${i - 1} : x${i - 1};")
        }
        let mode = if enabled {
            "enable"
        } else {
            "disable"
        }
        let source = "#nullable $mode\nnamespace Demo {\n" +
            "public class Node { }\npublic static class P {\n" +
            "static T First<T>((T Value, int Tag) pair) => pair.Value;\n" +
            "static Node Chain(Node${if enabled && widened { "?" } else { "" }} p, bool flag) {\n" +
            body.ToString() +
            (
            if deconstruct {
                "var (end, code) = x24; return end;"
            } else {
                "var result = First(x24); return result;"
            }
        ) +
            "\n} } }"
        let printed = this.TranslateWithinBound(source, enabled)
        Assert.Contains("var x24 = if flag { x23 } else { x23 }\n", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func DefaultOriginMemo_SeparatesReadPositionsAndTupleLeaves() {
        let printed = this.TranslateWithinBound(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static string IsNull<T>(T value) => (value is null).ToString();
        public static string Run(bool flag)
        {
            object? value = new object();
            var before = flag ? value : value;
            value = default;
            var after = flag ? value : value;
            (object? Left, object? Right) pair = (new object(), new object());
            var saved = pair;
            pair = flag ? (default(object), new object()) : (default(object), new object());
            var (savedLeft, savedRight) = saved;
            var (currentLeft, currentRight) = pair;
            return IsNull(before) + ":" + IsNull(after) + ":" +
                IsNull(savedLeft) + ":" + IsNull(savedRight) + ":" +
                IsNull(currentLeft) + ":" + IsNull(currentRight);
        }
    }
}`, enabled: true)
        GoldenFile.AssertMatches(
            Path.Combine(AppContext.BaseDirectory, "Fixtures", "Issue5633DefaultOriginMemo.golden"),
            printed
        )
        TranslationTestValidation.AssertBinds(printed)
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "System.Console.WriteLine(P.Run(true))\nSystem.Console.WriteLine(P.Run(false))",
            "False:True:False:False:True:False" + Environment.NewLine + "False:True:False:False:True:False"
        )
    }

    private func TranslateWithinBound(source string, enabled bool) string {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Chain.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let compilation = project.Compilation.WithOptions(
            project
                .Compilation
                .Options
                .WithNullableContextOptions(
                if enabled {
                    NullableContextOptions.Enable
                } else {
                    NullableContextOptions.Disable
                }
            )
        )
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
        )
        let original = Assert.Single(project.Documents)
        let document = LoadedDocument(
            original.FilePath,
            original.SyntaxTree,
            compilation.GetSemanticModel(original.SyntaxTree)
        )
        let context = TranslationContext(compilation, document.SemanticModel, document.FilePath)
        let elapsed = Stopwatch.StartNew()
        let translation = Task.Run(
            () -> GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        )
        Assert.True(translation.Wait(TimeSpan.FromSeconds(10)), "Translation took over 10 seconds.")
        elapsed.Stop()
        this.output.WriteLine("Translation: ${elapsed.Elapsed.TotalMilliseconds} ms")
        return translation.Result
    }
}
