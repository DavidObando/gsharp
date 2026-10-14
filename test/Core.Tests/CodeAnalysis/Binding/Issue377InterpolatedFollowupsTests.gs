// <copyright file="Issue377InterpolatedFollowupsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.Fixtures
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #377 regression coverage for the five follow-ups to PRs #372/#374:
/// (1) byref handler-parameter shape, (2) once-evaluated forwarded
/// constructor arguments, (3) await-in-hole spilling under the gated user
/// handler, (4) `M(object)` vs `M(FormattableString)` tie-break,
/// and (5) named-argument-wrapped interpolations target-typed to
/// `FormattableString`.
open class Issue377InterpolatedFollowupsTests {
    // --- Sub-item 1: byref handler parameter (ref / in) -------------------
    @Fact
    func Sub1_RefHandlerParameter_BindsAndRunsThroughHandler() {
        const Source = `package Issue377Ref
import System
import GSharp.Core.Tests.Fixtures

let msg = ByRefHandlerHarness.AppendRef("R:", "x=${40 + 2}")
Console.WriteLine(msg)
`
        let output = CompileAndRun(Source, "Issue377Ref")
        Assert.Contains("R:x=42", output)
    }

    @Fact
    func Sub1_InHandlerParameter_BindsAndRunsThroughHandler() {
        const Source = `package Issue377In
import System
import GSharp.Core.Tests.Fixtures

let msg = ByRefHandlerHarness.AppendIn("I:", "y=${7 * 6}")
Console.WriteLine(msg)
`
        let output = CompileAndRun(Source, "Issue377In")
        Assert.Contains("I:y=42", output)
    }

    @Fact
    func Sub1_ByValueHandler_StillWorks_NoRegression() {
        const Source = `package Issue377ByVal
import System
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Format("V:", "z=${3 + 4}")
Console.WriteLine(msg)
`
        let output = CompileAndRun(Source, "Issue377ByVal")
        Assert.Contains("V:z=7", output)
    }

    // --- Sub-item 2: forwarded arg evaluated exactly once -----------------
    @Fact
    func Sub2_ForwardedArgumentEvaluatedExactlyOnce() {
        const Source = `package Issue377Once
import System
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Format(ForwardCounter.IncrementAndReturn("K:"), "v=${9}")
Console.WriteLine(msg)
`
        ForwardCounter.Reset()
        let output = CompileAndRun(Source, "Issue377Once")
        Assert.Contains("K:v=9", output)
        Assert.Equal(1, ForwardCounter.InvocationCount)
    }

    // --- Sub-item 3: await inside hole + gated user handler ---------------
    /// Deeper await-in-hole regression: a binary expression with an await
    /// operand inside the hole, plus a gated handler. The gate must skip
    /// the hole-and-append entirely when disabled (matching #418) and run
    /// the spilled await exactly once when enabled (no double evaluation).
    @Fact
    func Sub3_AwaitInsideBinaryHole_GatedHandler_EnabledRunsOnce() {
        const Source = `package Issue377AwaitGated
import System.Threading.Tasks
import GSharp.Core.Tests.Fixtures

InterpolationHarness.ResetHoleEvaluations()

async func runEnabled() string {
    return InterpolationHarness.Gated(true, "sum=${(await InterpolationHarness.BumpAndReturnAsync(40)) + 2}")
}

var t = runEnabled()
t.Wait()
`
        InterpolationHarness.ResetHoleEvaluations()
        CompileAndRun(Source, "Issue377AwaitGated")
        Assert.Equal(1, InterpolationHarness.HoleEvaluations)
    }

    @Fact
    func Sub3_AwaitInsideBinaryHole_GatedHandler_DisabledDoesNotEvaluate() {
        const Source = `package Issue377AwaitGatedOff
import System.Threading.Tasks
import GSharp.Core.Tests.Fixtures

InterpolationHarness.ResetHoleEvaluations()

async func runDisabled() string {
    return InterpolationHarness.Gated(false, "sum=${(await InterpolationHarness.BumpAndReturnAsync(40)) + 2}")
}

var t = runDisabled()
t.Wait()
`
        InterpolationHarness.ResetHoleEvaluations()
        CompileAndRun(Source, "Issue377AwaitGatedOff")
        Assert.Equal(0, InterpolationHarness.HoleEvaluations)
    }

    // --- Sub-item 4: M(object) vs M(FormattableString) tie-break ---------
    @Fact
    func Sub4_FormattableStringOverloadBeatsObject() {
        const Source = `package Issue377Overload
import System
import GSharp.Core.Tests.Fixtures

FormattableOverloadHarness.Reset()
let _ = FormattableOverloadHarness.ChooseObject("value=${42}")
Console.WriteLine(FormattableOverloadHarness.LastChosen)
`
        FormattableOverloadHarness.Reset()
        let output = CompileAndRun(Source, "Issue377Overload")
        Assert.Contains("formattable:value={0}", output)
        Assert.DoesNotContain("object:", output)
    }

    // --- Sub-item 5: named-argument wrapped interpolation target-typing --
    @Fact
    func Sub5_NamedArgumentInterpolationTargetTypesToFormattableString() {
        // Sanity: positional call (works without SI5).
        const PositionalSource = `package Issue377NamedSanity
import System
import GSharp.Core.Tests.Fixtures

FormattableNamedArgHarness.Reset()
let _ = FormattableNamedArgHarness.AcceptNamed("value=${1 + 2}")
Console.WriteLine(FormattableNamedArgHarness.LastFormat)
`
        FormattableNamedArgHarness.Reset()
        let positionalOutput = CompileAndRun(PositionalSource, "Issue377NamedSanity")
        Assert.Contains("value={0}", positionalOutput)
        const Source = `package Issue377Named
import System
import GSharp.Core.Tests.Fixtures

FormattableNamedArgHarness.Reset()
let _ = FormattableNamedArgHarness.AcceptNamed(f: "value=${1 + 2}")
Console.WriteLine(FormattableNamedArgHarness.LastFormat)
`
        FormattableNamedArgHarness.Reset()
        let output = CompileAndRun(Source, "Issue377Named")
        Assert.Contains("value={0}", output)
    }

    shared {
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
    }
}
