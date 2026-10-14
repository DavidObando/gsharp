// <copyright file="TypeOfNameOfEmitTests.cs" company="GSharp">
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

/// Issue #143: emit tests for `typeof(T)` and `nameof(expr)`.
/// Compiles a tiny GSharp program, loads the produced PE, invokes the entry
/// point, and validates that the CLR-visible (cref:Type) /
/// (cref:string) match expectations.
open class TypeOfNameOfEmitTests {
    @Fact
    func TypeOf_Int_Emits_SystemInt32() {
        let output = CompileAndRun(`
package TypeOfIntTest
import System
var t = typeof(int32)
Console.WriteLine(t.FullName)
`, "TypeOf_Int_Emits_SystemInt32")
        Assert.Contains("System.Int32", output)
    }

    @Fact
    func TypeOf_String_Emits_SystemString() {
        let output = CompileAndRun(`
package TypeOfStringTest
import System
var t = typeof(string)
Console.WriteLine(t.FullName)
`, "TypeOf_String_Emits_SystemString")
        Assert.Contains("System.String", output)
    }

    @Fact
    func TypeOf_NullableInt_Emits_SystemNullable() {
        let output = CompileAndRun(`
package TypeOfNullableTest
import System
var t = typeof(int32?)
Console.WriteLine(t.FullName)
`, "TypeOf_NullableInt_Emits_SystemNullable")
        Assert.Contains("System.Nullable", output)
        Assert.Contains("System.Int32", output)
    }

    @Fact
    func TypeOf_SliceOfInt_Emits_IntArray() {
        let output = CompileAndRun(`
package TypeOfSliceTest
import System
var t = typeof([]int32)
Console.WriteLine(t.FullName)
`, "TypeOf_SliceOfInt_Emits_IntArray")
        Assert.Contains("System.Int32[]", output)
    }

    @Fact
    func NameOf_Local_Emits_Identifier_String() {
        let output = CompileAndRun(`
package NameOfLocalTest
import System
var counter = 7
var n = nameof(counter)
Console.WriteLine(n)
`, "NameOf_Local_Emits_Identifier_String")
        Assert.Contains("counter", output)
    }

    @Fact
    func NameOf_Member_Access_Emits_Rightmost_Name() {
        let output = CompileAndRun(`
package NameOfMemberTest
import System
var n = nameof(Console.WriteLine)
Console.WriteLine(n)
`, "NameOf_Member_Access_Emits_Rightmost_Name")
        Assert.Contains("WriteLine", output)
    }

    shared {
        private func Compile(source string, peStream Stream) EmitResult {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.Emit(peStream)
        }

        private func CompileAndRun(source string, contextName string) string {
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
