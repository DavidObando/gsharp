// <copyright file="Issue654IfInLambdaEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #654: `if` statement inside a lambda body triggered GS9998
/// ("Bound statement kind 'IfStatement' is not yet supported by the emitter")
/// because lambda bodies (both capturing and non-capturing) were not run
/// through the (cref:GSharp.Core.CodeAnalysis.Lowering.Lowerer) before
/// being stored in `lambdaBodies`. The Lowerer converts `IfStatement`
/// into `ConditionalGotoStatement` + `LabelStatement` which the
/// emitter already supports.
open class Issue654IfInLambdaEmitTests {
    @Fact
    func If_In_TaskRun_Lambda_Compiles_And_Runs() {
        let source = `package Probe
import System
import System.Threading.Tasks

Task.Run(func() {
    let x = 0
    if x > 0 {
        return
    }
}).Wait()
Console.Write("ok")`
        let (_, stdout) = CompileRunCapture(source)
        Assert.Equal("ok", stdout)
    }

    @Fact
    func IfElse_In_Closure_Lambda_Compiles_And_Runs() {
        let source = `package Probe
import System

var result = ""
var action = func() {
    let x = 42
    if x > 10 {
        result = "big"
    } else {
        result = "small"
    }
}
action()
Console.Write(result)`
        let (_, stdout) = CompileRunCapture(source)
        Assert.Equal("big", stdout)
    }

    @Fact
    func NestedIf_In_For_In_Lambda_Compiles_And_Runs() {
        let source = `package Probe
import System
import System.Threading.Tasks

var sum = 0
Task.Run(func() {
    for var i = 0; i < 5; i = i + 1 {
        if i > 2 {
            if i < 5 {
                sum = sum + i
            }
        }
    }
}).Wait()
Console.Write(sum)`
        // i=3 and i=4 satisfy both conditions → sum = 3 + 4 = 7
        let (_, stdout) = CompileRunCapture(source)
        Assert.Equal("7", stdout)
    }

    @Fact
    func If_In_Func_Lambda_Compiles_And_Runs() {
        let source = `package Probe
import System

var compute = func(x int32) int32 {
    if x > 3 {
        return x * 2
    }
    return x
}
Console.Write(compute(5))`
        let (_, stdout) = CompileRunCapture(source)
        Assert.Equal("10", stdout)
    }

    shared {
        private func CompileRunCapture(source string)(assembly Assembly, stdout string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_654_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            let assembly = EmittedFixture.Load(outPath)
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            let captured = StringWriter()
            let prevOut2 = Console.Out
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
                Console.SetOut(prevOut2)
            }
            return (assembly, captured.ToString().ReplaceLineEndings(Environment.NewLine))
        }
    }
}
