// <copyright file="Issue1881CheckedUncheckedEmitTests.cs" company="GSharp">
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

/// Issue #1881: G# had no `checked`/`unchecked` support at all — a
/// `checked { }` statement translated (by cs2gs) to a plain block,
/// silently erasing overflow-trap semantics, and `checked(...)`/
/// `unchecked(...)` expressions had no G# equivalent whatsoever. This
/// adds the language feature to gsc itself (syntax, binding, and emission) so
/// cs2gs can translate faithfully. These tests execute compiled programs;
/// (cref:GSharp.Core.Tests.CodeAnalysis.Binding.Issue1881CheckedUncheckedEmittedOracleTests)
/// pins expression and block forms through the emitted submission oracle.
open class Issue1881CheckedUncheckedEmitTests {
    @Fact
    func CheckedExpression_Int32Addition_OverflowThrows() {
        const Source = `package Issue1881Add
import System

func run() {
    var maxInt int32 = 2147483647
    var one int32 = 1
    var caught = "no"
    try {
        var boom = checked(maxInt + one)
        Console.WriteLine(boom)
    } catch (e OverflowException) {
        caught = "yes"
    }
    Console.WriteLine(caught)
}

run()
`
        let output = CompileAndRun(Source, "Issue1881Add")
        Assert.Contains("yes", output)
    }

    @Fact
    func UncheckedExpression_Int32Addition_Wraps() {
        const Source = `package Issue1881Wrap
import System

func run() {
    var maxInt int32 = 2147483647
    var one int32 = 1
    var wrapped = unchecked(maxInt + one)
    Console.WriteLine(wrapped)
}

run()
`
        let output = CompileAndRun(Source, "Issue1881Wrap")
        Assert.Contains("-2147483648", output)
    }

    @Fact
    func CheckedStatement_BlockContainingOverflow_Throws() {
        // The exact silent-divergence shape from the issue: a `checked { }`
        // block around a plain `+` inside a try/catch(OverflowException).
        const Source = `package Issue1881Block
import System

func run() {
    var caught = "no"
    checked {
        var maxInt int32 = 2147483647
        var one int32 = 1
        try {
            var boom = maxInt + one
            Console.WriteLine(boom)
        } catch (e OverflowException) {
            caught = "yes"
        }
    }
    Console.WriteLine(caught)
}

run()
`
        let output = CompileAndRun(Source, "Issue1881Block")
        Assert.Contains("yes", output)
    }

    @Fact
    func UncheckedStatement_BlockContainingOverflow_Wraps() {
        const Source = `package Issue1881BlockWrap
import System

func run() {
    unchecked {
        var maxInt int32 = 2147483647
        var one int32 = 1
        var wrapped = maxInt + one
        Console.WriteLine(wrapped)
    }
}

run()
`
        let output = CompileAndRun(Source, "Issue1881BlockWrap")
        Assert.Contains("-2147483648", output)
    }

    @Fact
    func CheckedExpression_UnsignedInt32Addition_OverflowThrows() {
        const Source = `package Issue1881UAdd
import System

func run() {
    var maxU uint32 = 4294967295
    var one uint32 = 1
    var caught = "no"
    try {
        var boom = checked(maxU + one)
        Console.WriteLine(boom)
    } catch (e OverflowException) {
        caught = "yes"
    }
    Console.WriteLine(caught)
}

run()
`
        let output = CompileAndRun(Source, "Issue1881UAdd")
        Assert.Contains("yes", output)
    }

    @Fact
    func UncheckedExpression_UnsignedInt32Addition_Wraps() {
        const Source = `package Issue1881UWrap
import System

func run() {
    var maxU uint32 = 4294967295
    var one uint32 = 1
    var wrapped = unchecked(maxU + one)
    Console.WriteLine(wrapped)
}

run()
`
        let output = CompileAndRun(Source, "Issue1881UWrap")
        Assert.Contains("0", output)
    }

    @Fact
    func CheckedExpression_Int64Multiplication_OverflowThrows() {
        const Source = `package Issue1881LongMul
import System

func run() {
    var big int64 = 9223372036854775807
    var two int64 = 2
    var caught = "no"
    try {
        var boom = checked(big * two)
        Console.WriteLine(boom)
    } catch (e OverflowException) {
        caught = "yes"
    }
    Console.WriteLine(caught)
}

run()
`
        let output = CompileAndRun(Source, "Issue1881LongMul")
        Assert.Contains("yes", output)
    }

    @Fact
    func CheckedExpression_UInt64Subtraction_UnderflowThrows() {
        const Source = `package Issue1881ULongSub
import System

func run() {
    var zero uint64 = 0
    var one uint64 = 1
    var caught = "no"
    try {
        var boom = checked(zero - one)
        Console.WriteLine(boom)
    } catch (e OverflowException) {
        caught = "yes"
    }
    Console.WriteLine(caught)
}

run()
`
        let output = CompileAndRun(Source, "Issue1881ULongSub")
        Assert.Contains("yes", output)
    }

    @Fact
    func CheckedExpression_NarrowingByteConversion_OverflowThrows() {
        const Source = `package Issue1881ByteNarrow
import System

func run() {
    var big int32 = 300
    var caught = "no"
    try {
        var narrow = checked(byte(big))
        Console.WriteLine(narrow)
    } catch (e OverflowException) {
        caught = "yes"
    }
    Console.WriteLine(caught)
}

run()
`
        let output = CompileAndRun(Source, "Issue1881ByteNarrow")
        Assert.Contains("yes", output)
    }

    @Fact
    func UncheckedExpression_NarrowingByteConversion_Truncates() {
        const Source = `package Issue1881ByteWrap
import System

func run() {
    var wide = unchecked(byte(300))
    Console.WriteLine(wide)
}

run()
`
        let output = CompileAndRun(Source, "Issue1881ByteWrap")
        Assert.Contains("44", output)
    }

    @Fact
    func NestedContexts_InnermostUncheckedInsideChecked_Wraps() {
        const Source = `package Issue1881NestUnchecked
import System

func run() {
    checked {
        var maxInt int32 = 2147483647
        var one int32 = 1
        unchecked {
            var wrapped = maxInt + one
            Console.WriteLine(wrapped)
        }
    }
}

run()
`
        let output = CompileAndRun(Source, "Issue1881NestUnchecked")
        Assert.Contains("-2147483648", output)
    }

    @Fact
    func NestedContexts_InnermostCheckedInsideUnchecked_Throws() {
        const Source = `package Issue1881NestChecked
import System

func run() {
    var caught = "no"
    unchecked {
        var maxInt int32 = 2147483647
        var one int32 = 1
        try {
            checked {
                var boom = maxInt + one
                Console.WriteLine(boom)
            }
        } catch (e OverflowException) {
            caught = "yes"
        }
    }
    Console.WriteLine(caught)
}

run()
`
        let output = CompileAndRun(Source, "Issue1881NestChecked")
        Assert.Contains("yes", output)
    }

    @Fact
    func CheckedExpression_FloatingPointOverflow_DoesNotThrow() {
        // C# float/double never trap on overflow regardless of checked context.
        const Source = `package Issue1881Float
import System

func run() {
    var big float64 = 1.0e308
    var ten float64 = 10.0
    var result = checked(big * ten)
    Console.WriteLine(Double.IsPositiveInfinity(result))
}

run()
`
        let output = CompileAndRun(Source, "Issue1881Float")
        Assert.Contains("True", output)
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
