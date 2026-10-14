// <copyright file="NullableStringPatternEmitTests.cs" company="GSharp">
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

/// Verifies that string constant patterns use value equality when the
/// discriminant's static type is nullable.
open class NullableStringPatternEmitTests {
    @Fact
    func SwitchStatement_NullableStringConstant_UsesValueEquality() {
        const Source = `package NullableStringSwitchStatement
import System
let value string? = string.Concat("System.", "Boolean")
var result = "miss"
switch value {
    case "System.Boolean" { result = "hit" }
    default { }
}
Console.WriteLine(result)`
        Assert.Contains(
            "hit",
            CompileLoadInvokeCaptureStdout(Source, "SwitchStatement_NullableStringConstant_UsesValueEquality")
        )
    }

    @Fact
    func SwitchExpression_NullableStringConstant_UsesValueEquality() {
        const Source = `package NullableStringSwitchExpression
import System
let value string? = string.Concat("System.", "Boolean")
let result = switch value {
    case "System.Boolean": "hit"
    default: "miss"
}
Console.WriteLine(result)`
        Assert.Contains(
            "hit",
            CompileLoadInvokeCaptureStdout(Source, "SwitchExpression_NullableStringConstant_UsesValueEquality")
        )
    }

    shared {
        private func CompileLoadInvokeCaptureStdout(source string, contextName string) string {
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
                let assembly = loadContext.LoadFromStream(peStream)
                let programType Type? = assembly.GetTypes().FirstOrDefault((type Type) -> type.Name == "<Program>")
                Assert.NotNull(programType)
                let entryPoint MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entryPoint)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entryPoint!!.Invoke(
                        nil,
                        if entryPoint!!.GetParameters().Length == 0 {
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
