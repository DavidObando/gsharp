// <copyright file="Issue1928LambdaInterpolatedStringEmitTests.cs" company="GSharp">
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

/// Issue #1928: emit-only lowering must rewrite interpolated strings inside
/// hosted nested bodies (arrow lambdas, func literals, generic local
/// functions) the same way it already rewrites ordinary function bodies.
open class Issue1928LambdaInterpolatedStringEmitTests {
    @Fact
    func ArrowLambdaBody_WithInterpolatedString_EmitsAndRuns() {
        const Source = `package Issue1928Arrow
import System
import System.Linq

var xs = []int32{1, 2, 3}
var mapped = xs.Select((x int32) -> "v=$x")
Console.WriteLine(string.Join(",", mapped))
`
        let output = CompileAndRun(Source, "ArrowLambdaBody_WithInterpolatedString_EmitsAndRuns")
        Assert.Contains("v=1,v=2,v=3", output)
    }

    @Fact
    func GenericLocalFunctionBody_WithInterpolatedString_EmitsAndRuns() {
        const Source = `package Issue1928Local
import System

let format[T] = func(value T) string { return "v=$value" }
Console.WriteLine(format(7))
`
        let output = CompileAndRun(Source, "GenericLocalFunctionBody_WithInterpolatedString_EmitsAndRuns")
        Assert.Contains("v=7", output)
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
