// <copyright file="Issue2027GotoLabelIsolationEmitTests.cs" company="GSharp">
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

/// Issue #2027 (follow-up to #1884 / PR #2025): before this fix, a lambda or
/// local function that declared a `goto` label reusing the enclosing
/// function's label name shared a single `BoundLabel` across two
/// `MethodBody`s — an emitted `br` targeting a label in a
/// different method (invalid IL / `KeyNotFoundException` in
/// `MethodBodyPlanner.labels`). These emit-level tests pin that a
/// nested-frame `goto`/label declaring its own label matching an outer
/// name now compiles to valid IL and runs correctly — jumping only within
/// its own frame.
open class Issue2027GotoLabelIsolationEmitTests {
    @Fact
    func Lambda_OwnLabelMatchingOuterName_CompilesAndRunsCorrectly() {
        let source = `package Probe
import System

var order = ""
order = order + "A"
sameLabel:
order = order + "B"

let f = (x int32) -> {
    var innerOrder = ""
    goto sameLabel
    innerOrder = innerOrder + "skip"
    sameLabel:
    innerOrder = innerOrder + "C"
    return innerOrder
}

Console.Write(order)
Console.Write(f(1))`
        let (_, stdout) = CompileRunCapture(source)
        Assert.Equal("ABC", stdout)
    }

    @Fact
    func LocalFunction_OwnLabelMatchingOuterName_CompilesAndRunsCorrectly() {
        let source = `package Probe
import System

var order = ""
order = order + "A"
sameLabel:
order = order + "B"

let f = func() string {
    var innerOrder = ""
    goto sameLabel
    innerOrder = innerOrder + "skip"
    sameLabel:
    innerOrder = innerOrder + "C"
    return innerOrder
}

Console.Write(order)
Console.Write(f())`
        let (_, stdout) = CompileRunCapture(source)
        Assert.Equal("ABC", stdout)
    }

    shared {
        private func CompileRunCapture(source string)(assembly Assembly, stdout string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_2027_").FullName
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
