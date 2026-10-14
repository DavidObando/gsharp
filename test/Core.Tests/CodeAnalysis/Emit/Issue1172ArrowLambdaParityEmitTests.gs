// <copyright file="Issue1172ArrowLambdaParityEmitTests.cs" company="GSharp">
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

/// ADR-0128 / issue #1172 — end-to-end emit tests proving a block-bodied arrow
/// lambda `(p) -> { … }` now behaves as a statement block with an optional
/// trailing value expression (parity with func literals): a non-trailing
/// `if`-without-`else` is a void statement, a trailing one yields a void
/// (Action) lambda, explicit `return` works anywhere, and the return type is
/// inferred — all previously rejected with GS0276. Includes WORKS-today regression
/// guards.
open class Issue1172ArrowLambdaParityEmitTests {
    @Fact
    func NonTrailingIfWithoutElse_ThenReturn_RunsAndReturnsValue() {
        const Source = `package P1
import System

func main() int32 {
    let f = (x int32) -> { if x > 0 { Console.WriteLine("a") }
return x * 2 }
    return f(3)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "NonTrailingIfWithoutElse_ThenReturn_RunsAndReturnsValue")
        try {
            Assert.Equal(6, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func TrailingIfWithoutElse_VoidActionLambda_ExecutesSideEffect() {
        // A trailing `if`-without-`else` makes the block produce no value: the
        // lambda is a void Action. Observe the side effect via a captured local.
        const Source = `package P2
import System

func main() int32 {
    var seen = 0
    let act = (x int32) -> { if x > 0 { seen = x } }
    act(5)
    return seen
}
`
        let (asm, ctx) = CompileToAssembly(Source, "TrailingIfWithoutElse_VoidActionLambda_ExecutesSideEffect")
        try {
            Assert.Equal(5, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func EarlyReturnInsideIfWithoutElse_RunsBothPaths() {
        const Source = `package P3
import System

func classify(x int32) int32 {
    let f = (n int32) -> { if n < 0 { return 0 }
return n * 2 }
    return f(x)
}

func main() int32 {
    return classify(3) + classify(-4)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "EarlyReturnInsideIfWithoutElse_RunsBothPaths")
        try {
            // classify(3) -> 6, classify(-4) -> 0, total 6.
            Assert.Equal(6, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func ExplicitFuncTargetType_IfWithoutElse_RunsAndReturnsValue() {
        const Source = `package P4
import System

func main() int32 {
    let g Func[int32, int32] = (x int32) -> { if x > 0 { return x }
return 0 }
    return g(5)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "ExplicitFuncTargetType_IfWithoutElse_RunsAndReturnsValue")
        try {
            Assert.Equal(5, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func NestedIfWithoutElse_InnerIfWithElse_TrailingValue_Runs() {
        const Source = `package P5
import System

func main() int32 {
    let f = (x int32) -> { if x > 0 { if x > 10 { Console.WriteLine("big") } else { Console.WriteLine("small") } }
x }
    return f(15)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "NestedIfWithoutElse_InnerIfWithElse_TrailingValue_Runs")
        try {
            Assert.Equal(15, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func TrailingIfWithElse_AsValue_Runs() {
        const Source = `package P6
import System

func main() string {
    let f = (x int32) -> { if x > 0 { "pos" } else if x < 0 { "neg" } else { "zero" } }
    return f(-3)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "TrailingIfWithElse_AsValue_Runs")
        try {
            Assert.Equal("neg", GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func ElseIfChainWithoutFinalElse_VoidActionLambda_ExecutesSideEffect() {
        // An `if`/`else if` chain WITHOUT a terminating plain `else` is a void
        // statement, so the lambda is a void Action — parity with func literals.
        // Observe the side effect via a captured local.
        const Source = `package P10
import System

func main() int32 {
    var seen = 0
    let act = (x int32) -> { if x > 0 { seen = 1 } else if x < 0 { seen = 2 } }
    act(-5)
    return seen
}
`
        let (asm, ctx) = CompileToAssembly(Source, "ElseIfChainWithoutFinalElse_VoidActionLambda_ExecutesSideEffect")
        try {
            Assert.Equal(2, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func ElseIfChainTerminatingPlainElse_AsValue_Runs() {
        // An `if`/`else if` chain terminating in a plain `else` is a
        // value-producing if-expression: verify each path returns its value.
        const Source = `package P11
import System

func classify(x int32) int32 {
    let g = (y int32) -> { if y > 0 { 1 } else if y < 0 { 2 } else { 3 } }
    return g(x)
}

func main() int32 {
    return classify(5) * 100 + classify(-5) * 10 + classify(0)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "ElseIfChainTerminatingPlainElse_AsValue_Runs")
        try {
            // classify(5) -> 1, classify(-5) -> 2, classify(0) -> 3 => 123.
            Assert.Equal(123, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func AsyncBlockLambda_WithVoidIf_AwaitsAndReturns() {
        const Source = `package P7
import System
import System.Threading.Tasks

var f = async (x int32) -> { if x > 0 { Console.WriteLine("pos") }
return x + 1 }

var t = f(5)
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "AsyncBlockLambda_WithVoidIf_AwaitsAndReturns")
        Assert.Contains("pos", output)
        Assert.Contains("6", output)
    }

    @Fact
    func TrailingExpressionValueBlock_StillRuns() {
        const Source = `package P8
import System

func main() int32 {
    let f = (x int32) -> { let y = x + 1
y * 2 }
    return f(3)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "TrailingExpressionValueBlock_StillRuns")
        try {
            Assert.Equal(8, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func ExpressionBodyLambda_StillRuns() {
        const Source = `package P9
import System

func main() int32 {
    let f = (x int32) -> x * 2
    return f(3)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "ExpressionBodyLambda_StillRuns")
        try {
            Assert.Equal(6, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    shared {
        private func GetProgramMethod(asm Assembly, name string) MethodInfo {
            let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
            Assert.NotNull(programType)
            let method MethodInfo? = programType!!.GetMethod(
                name,
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(method)
            return method!!
        }

        private func CompileToAssembly(source string, contextName string)(asm Assembly, ctx AssemblyLoadContext) {
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
            let asm = loadContext.LoadFromStream(peStream)
            return (asm, loadContext)
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
                } catch (ex TargetInvocationException) when ex.InnerException is AggregateException agg {
                    throw agg.InnerException ?? agg
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
