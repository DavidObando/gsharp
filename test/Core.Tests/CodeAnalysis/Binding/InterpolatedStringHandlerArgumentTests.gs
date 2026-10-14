// <copyright file="InterpolatedStringHandlerArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.Fixtures
import GSharp.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Emitted-oracle and end-to-end emit/run coverage for interpolated-string-handler argument forwarding.
/// Traceability: issue #368.
open class InterpolatedStringHandlerArgumentTests {
    @Fact
    func Forwarded_Argument_Evaluates_Through_EmittedOracle() {
        const Source = `package HandlerEval
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Format("PFX:", "x=${40 + 2}")
`
        let (diagnostics, value) = EvaluateNamed(Source, "msg")
        Assert.Empty(diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("PFX:x=42", value)
    }

    @Fact
    func Receiver_Forwarding_Evaluates_Through_EmittedOracle() {
        const Source = `package HandlerReceiver
import GSharp.Core.Tests.Fixtures

let log = InterpolationLog()
let msg = log.Append("v=${7}")
`
        let (diagnostics, value) = EvaluateNamed(Source, "msg")
        Assert.Empty(diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("v=7", value)
    }

    @Fact
    func Forwarded_Argument_Emits_And_Runs() {
        const Source = `package HandlerEmit
import System
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Format("PFX:", "x=${40 + 2}")
Console.WriteLine(msg)
`
        let output = CompileAndRun(Source, "HandlerEmitTest")
        Assert.Contains("PFX:x=42", output)
    }

    @Theory
    @InlineData("\"v=$${42,6}\"", "P: v=    42")
    @InlineData("\"v=$${42:0000}\"", "P: v=0042")
    @InlineData("\"v=$${42,6:0000}\"", "P: v=  0042")
    func Alignment_And_Format_Select_Matching_AppendFormatted(interpolation string, expected string) {
        let source = (`package HandlerShape
import System
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Format("P: ", ` + "$interpolation" + `)
Console.WriteLine(msg)
`)
        Assert.Contains(expected, CompileAndRun(source, "HandlerShapeTest"))
    }

    @Theory
    @InlineData("\"v=$${9,3}\"", "(value, int)")
    @InlineData("\"v=$${9:000}\"", "(value, string)")
    func Missing_AppendFormatted_Shape_Reports_Diagnostic(interpolation string, expectedShape string) {
        let source = (`package HandlerShapeNegative
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Gated(true, ` + "$interpolation" + `)
`)
        using let peStream = MemoryStream()
        let result = Compilation(SyntaxTree.Parse(SourceText.From(source))).Emit(peStream)
        Assert.False(result.Success)
        let diagnostic = Assert.Single(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("GS0221", diagnostic.Id)
        Assert.Contains(expectedShape, diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func OutBool_Gated_Handler_Enabled_Emits_And_Runs() {
        const Source = `package HandlerGatedOn
import System
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Gated(true, "y=${9}")
Console.WriteLine(msg)
`
        let output = CompileAndRun(Source, "HandlerGatedOnTest")
        Assert.Contains("y=9", output)
    }

    @Fact
    func OutBool_Gated_Handler_Disabled_Skips_Appends() {
        const Source = `package HandlerGatedOff
import System
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Gated(false, "y=${9}")
Console.WriteLine(msg)
`
        let output = CompileAndRun(Source, "HandlerGatedOffTest")
        Assert.DoesNotContain("y=9", output)
    }

    /// Issue #418 (P1-10): a string-typed hole must select
    /// `AppendFormatted(string)`, not the first reflected overload (which
    /// happens to be `AppendFormatted(int)` on this fixture). Pre-fix,
    /// the lowerer's value-blind first-match would either pick the int overload
    /// (invalid IL: `string` argument supplied where `int` is
    /// expected) or generate an `InvalidCastException` at run time.
    @Fact
    func TypedAppend_String_Hole_Picks_String_Overload() {
        const Source = `package HandlerTypedStr
import System
import GSharp.Core.Tests.Fixtures

let s = "hello"
let msg = InterpolationHarness.Typed("P:", "v=${s}")
Console.WriteLine(msg)
`
        let output = CompileAndRun(Source, "HandlerTypedStrTest")
        Assert.Contains("P:v=[str:hello]", output)
        Assert.DoesNotContain("[int:", output)
        Assert.DoesNotContain("[T:", output)
    }

    /// Issue #418 (P1-10): an int-typed hole must select `AppendFormatted(int)`.
    @Fact
    func TypedAppend_Int_Hole_Picks_Int_Overload() {
        const Source = `package HandlerTypedInt
import System
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Typed("P:", "v=${42}")
Console.WriteLine(msg)
`
        let output = CompileAndRun(Source, "HandlerTypedIntTest")
        Assert.Contains("P:v=[int:42]", output)
        Assert.DoesNotContain("[str:", output)
        Assert.DoesNotContain("[T:", output)
    }

    /// Issue #418 (P1-10): a hole whose static type matches neither the
    /// `int` nor the `string` overload must fall through to the
    /// generic `AppendFormatted<T>`.
    @Fact
    func TypedAppend_Bool_Hole_Picks_Generic_Overload() {
        const Source = `package HandlerTypedBool
import System
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Typed("P:", "v=${true}")
Console.WriteLine(msg)
`
        let output = CompileAndRun(Source, "HandlerTypedBoolTest")
        Assert.Contains("P:v=[T:True]", output)
        Assert.DoesNotContain("[int:", output)
        Assert.DoesNotContain("[str:", output)
    }

    /// Issue #418 (P1-9): when the handler ctor sets `shouldAppend = false`,
    /// hole expressions must NOT be evaluated. Prior to the fix the lowering
    /// pre-spilled every hole containing an `await` into a temp before
    /// the ctor ran, so the awaiting side effect (here, incrementing
    /// `HoleEvaluations`) fired even when the gate disabled appends.
    @Fact
    func OutBool_Gated_Handler_Disabled_Does_Not_Evaluate_Awaiting_Holes() {
        const Source = `package HandlerGatedOffNoEval
import System.Threading.Tasks
import GSharp.Core.Tests.Fixtures

InterpolationHarness.ResetHoleEvaluations()

async func runDisabled() string {
    return InterpolationHarness.Gated(false, "y=${await InterpolationHarness.BumpAndReturnAsync(9)}")
}

var t = runDisabled()
t.Wait()
`
        let evaluations = CompileAndReadHoleEvaluations(Source, "HandlerGatedOffNoEvalTest")
        Assert.Equal(0, evaluations)
    }

    /// Issue #418 (P1-9) sanity check: when the gate is enabled, awaiting holes
    /// must still be evaluated exactly once per append.
    @Fact
    func OutBool_Gated_Handler_Enabled_Evaluates_Awaiting_Holes_Once() {
        const Source = `package HandlerGatedOnEvalOnce
import System.Threading.Tasks
import GSharp.Core.Tests.Fixtures

InterpolationHarness.ResetHoleEvaluations()

async func runEnabled() string {
    return InterpolationHarness.Gated(true, "a=${await InterpolationHarness.BumpAndReturnAsync(1)} b=${await InterpolationHarness.BumpAndReturnAsync(2)}")
}

var t = runEnabled()
t.Wait()
`
        let evaluations = CompileAndReadHoleEvaluations(Source, "HandlerGatedOnEvalOnceTest")
        Assert.Equal(2, evaluations)
    }

    /// Issue #418 (P1-9): non-await holes already evaluated lazily inside the
    /// gated block; verify that behavior remains correct after the refactor.
    @Fact
    func OutBool_Gated_Handler_Disabled_Does_Not_Evaluate_Plain_Holes() {
        const Source = `package HandlerGatedOffPlainNoEval
import GSharp.Core.Tests.Fixtures

InterpolationHarness.ResetHoleEvaluations()
let msg = InterpolationHarness.Gated(false, "y=${InterpolationHarness.BumpAndReturn(9)}")
`
        let evaluations = CompileAndReadHoleEvaluations(Source, "HandlerGatedOffPlainNoEvalTest")
        Assert.Equal(0, evaluations)
    }

    shared {
        private func EvaluateNamed(source string, variableName string)(
            Diagnostics ImmutableArray[Diagnostic],
            Value object?
        ) {
            // Post-run global read back through the oracle (issue #3176 Phase
            // 3b.2): the emitted equivalent of the evaluator's variables
            // dictionary.
            let result = EmittedOracle.Evaluate(source)
            return (result.Diagnostics, result.ReadGlobal(variableName))
        }

        private func CompileAndRun(source string, contextName string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }

        /// Issue #418 (P1-9): compiles and runs the G# source, then reads the
        /// host-process value of (cref:GSharp.Core.Tests.Fixtures.InterpolationHarness.HoleEvaluations)
        /// to assert how many hole expressions actually executed. The collectible
        /// ALC resolves the fixture assembly through the default ALC, so the
        /// counter is shared between the generated assembly and the host test.
        private func CompileAndReadHoleEvaluations(source string, contextName string) int32 {
            InterpolationHarness.ResetHoleEvaluations()
            CompileAndRun(source, contextName)
            return InterpolationHarness.HoleEvaluations
        }
    }
}
