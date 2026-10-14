// <copyright file="StructuralProjectionEmitTests.cs" company="GSharp">
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

/// Validates emitted ADR-0148 projection behavior.
open class StructuralProjectionEmitTests {
    @Fact
    func ProjectionEmitsConstructorSafeSingleEvaluationCode() {
        let output = CompileAndRun(`
import System
class Source { var Value int32 }
class Target {
    var Value int32
    private var Secret int32 = 91
    func ReadSecret() int32 { return Secret }
}
func Make() Source {
    creates = creates + 1
    return Source{Value: 7}
}
var creates = 0
let target Target = Make()
let changed = Target{ ...target, Value: 9 }
Console.WriteLine(target.Value)
Console.WriteLine(changed.Value)
Console.WriteLine(changed.ReadSecret())
Console.WriteLine(creates)
`)
        Assert.Equal(
            "7" +
                Environment.NewLine +
                "9" +
                Environment.NewLine +
                "91" +
                Environment.NewLine +
                "1" +
                Environment.NewLine,
            output
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
            peStream.Position = 0
            let context = AssemblyLoadContext("projection-run", isCollectible: true)
            try {
                let assembly = context.LoadFromStream(peStream)
                let programType = assembly.GetTypes().First((t Type) -> t.Name == "<Program>")
                let entry MethodInfo? = programType.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                let savedOut = Console.Out
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
                    Console.SetOut(savedOut)
                }
                return captured.ToString()
            } finally {
                context.Unload()
            }
        }
    }
}
