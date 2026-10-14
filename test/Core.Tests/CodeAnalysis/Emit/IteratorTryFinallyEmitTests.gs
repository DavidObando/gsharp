// <copyright file="IteratorTryFinallyEmitTests.cs" company="GSharp">
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

/// End-to-end emit tests for iterator functions that contain
/// `yield` statements inside `try`/`finally` blocks
/// (issue #419 — P0-3).
open class IteratorTryFinallyEmitTests {
    @Fact
    func Iterator_YieldInsideTryFinally_RunsFinallyAfterFullEnumeration() {
        let source = `
package IterTest
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        yield 1
        yield 2
    } finally {
        Console.WriteLine("dispose")
    }
}

for v in gen() {
    Console.WriteLine(v)
}
`
        let output = CompileLoadInvokeCaptureStdout(
            source,
            "Iterator_YieldInsideTryFinally_RunsFinallyAfterFullEnumeration"
        )
        Assert.Contains("1", output)
        Assert.Contains("2", output)
        Assert.Contains("dispose", output)
        // Finally must run AFTER the last yielded value.
        let idx1 = output.IndexOf("1", StringComparison.Ordinal)
        let idx2 = output.IndexOf("2", StringComparison.Ordinal)
        let idxFinally = output.IndexOf("dispose", StringComparison.Ordinal)
        Assert.True(idx1 < idx2)
        Assert.True(idx2 < idxFinally)
    }

    @Fact
    func Iterator_YieldInsideTryWithCatch_IsRejected_Issue836() {
        // Issue #836: per C# §15.14 / ECMA-335, `yield` lexically inside
        // a `try` block that has any `catch` clause is rejected. The
        // iterator state machine cannot resume into a protected region
        // that also acts as a CLR exception-handler frame. Pure
        // try/finally remains supported.
        let source = `
package IterTest
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        yield 10
        yield 20
    } catch (e Exception) {
        Console.WriteLine("caught")
    } finally {
        Console.WriteLine("done")
    }
}

for v in gen() {
    Console.WriteLine(v)
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.False(result.Success, "compilation must fail when yield appears inside try with catch.")
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0367")
    }

    @Fact
    func Iterator_NestedTryFinally_RunsBothFinallies_InCorrectOrder() {
        let source = `
package IterTest
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        try {
            yield 1
            yield 2
        } finally {
            Console.WriteLine("inner")
        }
    } finally {
        Console.WriteLine("outer")
    }
}

for v in gen() {
    Console.WriteLine(v)
}
`
        let output = CompileLoadInvokeCaptureStdout(
            source,
            "Iterator_NestedTryFinally_RunsBothFinallies_InCorrectOrder"
        )
        Assert.Contains("1", output)
        Assert.Contains("2", output)
        let idxInner = output.IndexOf("inner", StringComparison.Ordinal)
        let idxOuter = output.IndexOf("outer", StringComparison.Ordinal)
        Assert.True(idxInner > 0, "inner finally must run")
        Assert.True(idxOuter > 0, "outer finally must run")
        Assert.True(idxInner < idxOuter, "inner finally runs before outer finally")
    }

    @Fact
    func Iterator_EarlyBreak_TriggersDispose_WhichRunsFinally() {
        // foreach in G# desugars to a for-range loop that disposes the
        // enumerator on early exit. Break out after the first yield and
        // verify the finally still runs.
        let source = `
package IterTest
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        yield 1
        yield 2
        yield 3
    } finally {
        Console.WriteLine("dispose")
    }
}

for v in gen() {
    Console.WriteLine(v)
    if v == 1 {
        break
    }
}
`
        let output = CompileLoadInvokeCaptureStdout(source, "Iterator_EarlyBreak_TriggersDispose_WhichRunsFinally")
        Assert.Contains("1", output)
        Assert.DoesNotContain("2", output)
        Assert.Contains("dispose", output)
    }

    @Fact
    func Iterator_NestedEarlyBreak_RunsInnerThenOuterFinally() {
        let source = `
package IterTest
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        try {
            yield 1
            yield 2
        } finally {
            Console.WriteLine("inner")
        }
    } finally {
        Console.WriteLine("outer")
    }
}

for v in gen() {
    Console.WriteLine(v)
    if v == 1 {
        break
    }
}
`
        let output = CompileLoadInvokeCaptureStdout(source, "Iterator_NestedEarlyBreak_RunsInnerThenOuterFinally")
        let idx1 = output.IndexOf("1", StringComparison.Ordinal)
        let idxInner = output.IndexOf("inner", StringComparison.Ordinal)
        let idxOuter = output.IndexOf("outer", StringComparison.Ordinal)
        Assert.True(idx1 >= 0)
        Assert.True(idxInner > idx1)
        Assert.True(idxOuter > idxInner)
        Assert.DoesNotContain("2", output)
    }

    @Fact
    func Iterator_YieldInTryFinally_ResumesAcrossYields() {
        // Verifies the resume path: each MoveNext must correctly re-enter
        // the protected region via the synthesized entry label and pick
        // up after the prior yield without the CLR rejecting the IL.
        let source = `
package IterTest
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        yield 100
        Console.WriteLine("mid")
        yield 200
    } finally {
        Console.WriteLine("fin")
    }
}

for v in gen() {
    Console.WriteLine(v)
}
`
        let output = CompileLoadInvokeCaptureStdout(source, "Iterator_YieldInTryFinally_ResumesAcrossYields")
        let idx1 = output.IndexOf("100", StringComparison.Ordinal)
        let idxMid = output.IndexOf("mid", StringComparison.Ordinal)
        let idx2 = output.IndexOf("200", StringComparison.Ordinal)
        let idxFin = output.IndexOf("fin", StringComparison.Ordinal)
        Assert.True(idx1 >= 0)
        Assert.True(idxMid > idx1, "user code between yields must execute")
        Assert.True(idx2 > idxMid)
        Assert.True(idxFin > idx2)
    }

    shared {
        private func Compile(source string, peStream Stream) EmitResult {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.Emit(peStream)
        }

        private func CompileLoadInvokeCaptureStdout(source string, contextName string) string {
            using let peStream = MemoryStream()
            let result = Compile(source, peStream)
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
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
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
