// <copyright file="CollectLabelsInsideBlockExpressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #418 (P1-4): `CollectLabels` used to ignore labels living
/// inside a `BoundBlockExpression` (interpolated-string handler gate,
/// null-conditional capture, switch-expression spill, ...). Those labels
/// are registered in `this.labels` by `EmitBlockExpression`, but
/// the lexical label set for the enclosing `try` never saw them. A
/// `goto` whose source and target both lived inside the same protected
/// region therefore tripped `EmitBranch`'s `crossesRegion`
/// heuristic and emitted a CIL `leave` — illegal when the target is
/// inside the same region; the JIT rejects the method with
/// (cref:System.InvalidProgramException).
///
/// These tests reproduce the bug end-to-end by placing an interpolated
/// string that binds to the `GatedInterpolatedStringHandler` fixture
/// (an `[InterpolatedStringHandler]` whose constructor takes
/// `out bool shouldAppend`) inside a `try`. The lowering pass
/// emits a `BoundBlockExpression` whose statement list contains
/// per-append short-circuit `BoundConditionalGotoStatement` /
/// `BoundLabelStatement` pairs; pre-fix, the `goto`s were
/// translated to `leave` and the resulting method failed to JIT.
open class CollectLabelsInsideBlockExpressionTests {
    @Fact
    func Gated_Interpolated_String_Inside_Try_Catch_Is_Valid_IL() {
        const Source = `package CollectLabelsTryCatch
import System
import GSharp.Core.Tests.Fixtures

try {
    let msg = InterpolationHarness.Gated(true, "y=${9}")
    Console.WriteLine(msg)
} catch (e Exception) {
    Console.WriteLine("caught")
}
`
        let output = CompileAndRun(Source, "P1_4_TryCatch")
        Assert.Contains("y=9", output)
    }

    @Fact
    func Gated_Interpolated_String_Inside_Try_Finally_Is_Valid_IL() {
        const Source = `package CollectLabelsTryFinally
import System
import GSharp.Core.Tests.Fixtures

try {
    let msg = InterpolationHarness.Gated(true, "z=${42}")
    Console.WriteLine(msg)
} finally {
    Console.WriteLine("done")
}
`
        let output = CompileAndRun(Source, "P1_4_TryFinally")
        Assert.Contains("z=42", output)
        Assert.Contains("done", output)
    }

    @Fact
    func Gated_Interpolated_String_With_Many_Holes_Inside_Try_Is_Valid_IL() {
        // Multiple holes => multiple per-append BoundConditionalGoto/BoundLabel
        // pairs inside the same BoundBlockExpression. All of them must be
        // collected into the enclosing try's lexical label set so that the
        // emitter does not translate them to `leave`.
        const Source = `package CollectLabelsTryMultiHole
import System
import GSharp.Core.Tests.Fixtures

try {
    let msg = InterpolationHarness.Gated(true, "a=${1} b=${2} c=${3}")
    Console.WriteLine(msg)
} catch (e Exception) {
    Console.WriteLine("caught")
}
`
        let output = CompileAndRun(Source, "P1_4_MultiHole")
        Assert.Contains("a=1 b=2 c=3", output)
    }

    @Fact
    func Gated_Interpolated_String_Disabled_Inside_Try_Is_Valid_IL() {
        // shouldAppend = false: the gate short-circuits past every append.
        // Pre-fix, the conditional gotos inside the BoundBlockExpression
        // were emitted as `leave`, so the IL would fail to JIT even when
        // taking the disabled branch.
        const Source = `package CollectLabelsTryDisabled
import System
import GSharp.Core.Tests.Fixtures

try {
    let msg = InterpolationHarness.Gated(false, "y=${9}")
    Console.WriteLine("len=" + msg.Length.ToString())
} catch (e Exception) {
    Console.WriteLine("caught")
}
`
        let output = CompileAndRun(Source, "P1_4_Disabled")
        Assert.Contains("len=0", output)
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
