// <copyright file="IteratorEmitTests.cs" company="GSharp">
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

/// End-to-end emit tests for iterator functions (ADR-0040: sequence[T] and yield).
open class IteratorEmitTests {
    @Fact
    func Iterator_KickoffOnly_DoesNotThrow() {
        // Minimal test: call the iterator but don't iterate.
        // Validates the kickoff body IL is well-formed.
        let source = `
package IterTest
import System
import System.Collections.Generic

func numbers() sequence[int32] {
    yield 1
    yield 2
    yield 3
}

var n = numbers()
Console.WriteLine("ok")
`
        let output = CompileLoadInvokeCaptureStdout(source, "Iterator_KickoffOnly_DoesNotThrow")
        Assert.Contains("ok", output)
    }

    @Fact
    func Iterator_Sequence_EnumeratesYieldedValues() {
        let source = `
package IterTest
import System
import System.Collections.Generic

func numbers() sequence[int32] {
    yield 1
    yield 2
    yield 3
}

for x in numbers() {
    Console.WriteLine(x)
}
`
        let output = CompileLoadInvokeCaptureStdout(source, "Iterator_Sequence_EnumeratesYieldedValues")
        Assert.Contains("1", output)
        Assert.Contains("2", output)
        Assert.Contains("3", output)
    }

    @Fact
    func Iterator_IEnumerable_EnumeratesYieldedValues() {
        let source = `
package IterTest
import System
import System.Collections.Generic

func numbers() IEnumerable[int32] {
    yield 1
    yield 2
    yield 3
}

for x in numbers() {
    Console.WriteLine(x)
}
`
        let output = CompileLoadInvokeCaptureStdout(source, "Iterator_IEnumerable_EnumeratesYieldedValues")
        Assert.Contains("1", output)
        Assert.Contains("2", output)
        Assert.Contains("3", output)
    }

    @Fact
    func Iterator_Fib_ProducesExpectedSequence() {
        let source = `
package IterTest
import System
import System.Collections.Generic

func fib(max int32) sequence[int32] {
    var a = 0
    var b = 1
    for a <= max {
        yield a
        a, b = b, a+b
    }
}

for x in fib(20) {
    Console.Write(x)
    Console.Write(" ")
}
`
        let output = CompileLoadInvokeCaptureStdout(source, "Iterator_Fib_ProducesExpectedSequence")
        Assert.Contains("0 1 1 2 3 5 8 13", output)
    }

    @Fact
    func Iterator_With_Yield_Inside_Conditional_Works() {
        let source = `
package IterTest
import System
import System.Collections.Generic

func evens(max int32) sequence[int32] {
    var i = 0
    for i <= max {
        if i % 2 == 0 {
            yield i
        }
        i = i + 1
    }
}

for x in evens(10) {
    Console.Write(x)
    Console.Write(" ")
}
`
        let output = CompileLoadInvokeCaptureStdout(source, "Iterator_With_Yield_Inside_Conditional_Works")
        Assert.Contains("0 2 4 6 8 10", output)
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
