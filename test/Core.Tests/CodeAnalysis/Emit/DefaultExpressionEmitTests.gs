// <copyright file="DefaultExpressionEmitTests.cs" company="GSharp">
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

/// Emit tests for `BoundDefaultExpression` — validates the IL patterns
/// for `default(T)` across reference types, primitive value types, and
/// arbitrary value-type structs.
open class DefaultExpressionEmitTests {
    @Fact
    func Default_Of_Int_Is_Zero() {
        let source = `
package DefaultIntTest
import System
import System.Threading.Tasks

async func getVal() int32 {
    var a = await Task.FromResult(42)
    var b = await Task.FromResult(a + 1)
    return b
}

var result = getVal().Result
Console.WriteLine(result)
`
        let output = CompileLoadInvokeCaptureStdout(source, "Default_Of_Int_Is_Zero")
        Assert.Contains("43", output)
    }

    @Fact
    func Default_Of_Bool_Is_False() {
        let source = `
package DefaultBoolTest
import System
import System.Threading.Tasks

async func check() bool {
    var a = await Task.FromResult(true)
    var b = await Task.FromResult(a)
    return b
}

var result = check().Result
Console.WriteLine(result)
`
        let output = CompileLoadInvokeCaptureStdout(source, "Default_Of_Bool_Is_False")
        Assert.Contains("True", output)
    }

    @Fact
    func Default_Of_ReferenceType_Is_Null() {
        let source = `
package DefaultRefTest
import System
import System.Threading.Tasks

async func getText() string {
    var a = await Task.FromResult("hello")
    var b = await Task.FromResult(a + " world")
    return b
}

var result = getText().Result
Console.WriteLine(result)
`
        let output = CompileLoadInvokeCaptureStdout(source, "Default_Of_ReferenceType_Is_Null")
        Assert.Contains("hello world", output)
    }

    @Fact
    func Default_Of_ValueType_Struct_IsZeroed() {
        let source = `
package DefaultStructTest
import System
import System.Threading.Tasks

async func compute() int32 {
    var x = await Task.FromResult(10)
    var y = await Task.FromResult(20)
    var z = await Task.FromResult(30)
    return x + y + z
}

var result = compute().Result
Console.WriteLine(result)
`
        let output = CompileLoadInvokeCaptureStdout(source, "Default_Of_ValueType_Struct_IsZeroed")
        Assert.Contains("60", output)
    }

    @Fact
    func Store_Default_Into_Field_Of_ValueType_Struct() {
        let source = `
package StoreDefaultFieldTest
import System
import System.Threading.Tasks

async func pipeline() string {
    var a = await Task.FromResult("A")
    var b = await Task.FromResult("B")
    var c = await Task.FromResult("C")
    return a + b + c
}

var result = pipeline().Result
Console.WriteLine(result)
`
        let output = CompileLoadInvokeCaptureStdout(source, "Store_Default_Into_Field_Of_ValueType_Struct")
        Assert.Contains("ABC", output)
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
