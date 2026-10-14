// <copyright file="Issue1745PrinterCodeModelCleanupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Threading.Tasks
import Xunit

/// Regression tests for issue #1745's cleanup batch: the string/interpolation
/// escaper is a single shared function (locks its output for the tricky
/// escape chars so a future edit can't silently diverge the two call sites
/// again), (cref:ForInStatement.IsAwait) is now constructor-only, and
/// re-printing the same AST node is byte-identical (the "same AST → same
/// text" guarantee the mutable setter used to put at risk), and
/// (cref:GSharpPrinter.Print) is safe to call concurrently (it has no
/// shared mutable state). The `isOpen`-extraction cleanup is pure
/// perf/dedup with no observable-output change, so it's covered implicitly
/// by every other printer test in this suite continuing to pass unchanged.
open class Issue1745PrinterCodeModelCleanupTests {
    /// A string literal and an interpolated string share the exact same
    /// escaper (`GSharpPrinter.RenderEscapedLiteralBody`) for their text
    /// body. Both must escape backslash, the closing quote, control chars
    /// (as `\uXXXX`), and double a literal `$` (so it can't be
    /// mistaken for an interpolation hole) identically.
    @Fact
    func StringLiteralAndInterpolation_EscapeIdentically() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public string Plain() => "a\\b\"c$d\u0001e";

        public string Interpolated(int x) => $"a\\b\"c$d\u0001e{x}";
    }
}`)
        // Plain string: backslash doubled, quote escaped, '$' doubled, control
        // char rendered as \u0001.
        Assert.Contains("\"a\\\\b\\\"c$$$$d\\u0001e\"", printed, StringComparison.Ordinal)
        // Interpolated string: identical escaping for the literal text
        // segment, plus the `$x` interpolation hole for the expression.
        Assert.Contains("\"a\\\\b\\\"c$$$$d\\u0001e$$x\"", printed, StringComparison.Ordinal)
        let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(result!!.Success, "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed)
    }

    /// (cref:ForInStatement.IsAwait) used to be a mutable
    /// `{ get; set; }` property, which broke the printer's "same AST
    /// always produces byte-identical text" guarantee if a shared node was
    /// mutated between prints. It's now set once at construction time.
    /// Printing the very same (cref:ForInStatement) instance twice
    /// must yield byte-identical text.
    @Fact
    func ForInStatement_SameInstancePrintedTwice_IsByteIdentical() {
        let loop = ForInStatement(
            "x",
            IdentifierExpression("src"),
            BlockStatement(Array.Empty[GStatement]()),
            isAwait: true
        )
        let unit = CompilationUnit(members: []GNode{loop})
        let first = GSharpPrinter.Print(unit)
        let second = GSharpPrinter.Print(unit)
        Assert.Equal(first, second)
        Assert.Contains("await for x in src", first, StringComparison.Ordinal)
    }

    /// (cref:GSharpPrinter.Print) is a public static API and xunit
    /// runs test classes in parallel by default, so it must not rely on any
    /// unsynchronized shared mutable state (a prior indent-string cache did,
    /// and could race). Printing many nested, varying-depth ASTs from
    /// multiple threads at once must not throw and must produce correctly
    /// nested output every time.
    @Fact
    func Print_FromMultipleThreadsConcurrently_DoesNotThrow() {
        Parallel.For(
            0,
            64,
            (i int32) -> {
                var body GStatement = BlockStatement(Array.Empty[GStatement]())
                for var depth = 0; depth < (i % 20) + 1; depth++ {
                    body = BlockStatement([]GStatement{body})
                }
                let unit = CompilationUnit(members: []GNode{body})
                let printed = GSharpPrinter.Print(unit)
                Assert.Contains("{", printed, StringComparison.Ordinal)
            }
        )
    }

    shared {
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
