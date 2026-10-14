// <copyright file="Issue2984MainEntryPointInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Execution
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Collections.Immutable
import System.IO
import Xunit

/// Issue #2984: script-mode execution invokes the entry point selected by the
/// binder. Historically pinned on the tree-walking evaluator (including the
/// direct `Evaluator`-constructor overload surface); since the evaluator
/// retired in ADR-0156 Phase 3c (#3176) the same observable entry-point
/// selection runs through (cref:EmittedProgramHost) — the gsi script
/// driver — with the assertions preserved.
@Collection("ConsoleIo")
open class Issue2984MainEntryPointInterpreterTests {
    @Fact
    func PackageScopeMainRuns() {
        const Source = `import System

func Main() {
    Console.WriteLine("package-main")
}`
        let (diagnostics, output) = Run(Source)
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
        Assert.Equal("package-main${Environment.NewLine}", output)
    }

    @Fact
    func ValueEchoPreservesTopLevelExpressionValue() {
        // The evaluator's `Evaluate` value-echo contract, preserved through
        // the emitted oracle's synthesized trailing-expression capture.
        let result = EmittedOracle.Evaluate("40 + 2")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ClassScopedSharedMainRuns() {
        const Source = `import System

class Launcher {
    shared {
        func Main() {
            Console.WriteLine("class-main")
        }
    }
}`
        let (diagnostics, output) = Run(Source)
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
        Assert.Equal("class-main${Environment.NewLine}", output)
    }

    @Fact
    func TopLevelStatementsStillRun() {
        const Source = `import System

Console.WriteLine("top-level")`
        let (diagnostics, output) = Run(Source)
        Assert.Empty(diagnostics)
        Assert.Equal("top-level${Environment.NewLine}", output)
    }

    @Fact
    func TopLevelStatementsWinOverExplicitMain() {
        const Source = `import System

Console.WriteLine("top-level")

func Main() {
    Console.WriteLine("explicit-main")
}`
        let (diagnostics, output) = Run(Source)
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
        Assert.Contains(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0166")
        Assert.Equal("top-level${Environment.NewLine}", output)
    }

    @Fact
    func MainArgsReceivesEmptyArray() {
        const Source = `import System

func Main(args []string) {
    Console.WriteLine(args.Length)
}`
        let (diagnostics, output) = Run(Source)
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func NonArgsMainParameterIsNotSeededWithStringArray() {
        const Source = `import System

func Main(x int32) {
    Console.WriteLine(x)
}`
        let (diagnostics, output) = Run(Source)
        // A `Main` whose parameter is not `args []string` is not an entry
        // point: nothing is seeded (no System.String[] coercion — the
        // original #2984 bug) and nothing runs. The evaluator additionally
        // reported an invocation error naming the parameter; the emitted
        // driver simply produces a program without an entry point.
        Assert.DoesNotContain(
            diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Message.Contains("System.String[]")
        )
        Assert.Equal(string.Empty, output)
    }

    shared {
        private func Run(source string)(
            Diagnostics ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic],
            Output string
        ) {
            using let output = StringWriter()
            let previousOutput = Console.Out
            Console.SetOut(output)
            try {
                let compilation = Compilation(SyntaxTree.Parse(source))
                let result = EmittedProgramHost.Run(compilation)
                return (result.Diagnostics, output.ToString().ReplaceLineEndings(Environment.NewLine))
            } finally {
                Console.SetOut(previousOutput)
            }
        }
    }
}
