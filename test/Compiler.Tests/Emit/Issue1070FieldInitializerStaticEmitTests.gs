// <copyright file="Issue1070FieldInitializerStaticEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #1070 end-to-end coverage. A static member of a type (a `const`,
/// or a `shared` field) must be visible from a field-initializer expression
/// in the same type. These tests round-trip the scenario through compile →
/// IL-verify → run so we confirm both that binding succeeds (no GS0125 / GS0159)
/// and that the emitted code loads the static member correctly at runtime:
/// - an instance field initializer that sizes an array from a class `const` (the const is inlined as
/// the array length);
/// - a `shared` field initializer that references an earlier `shared` field (a `ldsfld` of the sibling
/// static field).
open class Issue1070FieldInitializerStaticEmitTests {
    @Fact
    func InstanceFieldInit_FromConst_And_SharedFieldInit_FromSharedField_Roundtrips() {
        let source = `package P
import System

class Buffer {
    const BlockSize int32 = 16
    public let data []uint8 = System.GC.AllocateArray[uint8](BlockSize)
}

class Stats {
    shared {
        let Rates []int32 = []int32{10, 20, 30}
        let First int32 = Rates[0]
        let Total int32 = Rates[0] + Rates[1] + Rates[2]

        public func Combined() int32 {
            return First + Total
        }
    }
}

let b = Buffer()
Console.WriteLine(b.data.Length)
Console.WriteLine(Stats.Combined())`
        let output = CompileAndRun(source)
        // 16 = const BlockSize used as the instance array length.
        // 70 = First(10) + Total(10+20+30=60); First and Total are shared
        // field initializers that read the sibling shared `Rates` field.
        Assert.Equal("16${Environment.NewLine}70${Environment.NewLine}", output)
    }

    @Fact
    func InstanceFieldInit_FromConst_OrderIndependent_Roundtrips() {
        // The const is declared AFTER the field initializer that uses it.
        let source = `package P
import System

class Buffer {
    public let data []uint8 = System.GC.AllocateArray[uint8](BlockSize)
    const BlockSize int32 = 24
}

let b = Buffer()
Console.WriteLine(b.data.Length)`
        let output = CompileAndRun(source)
        Assert.Equal("24${Environment.NewLine}", output)
    }

    @Fact
    func ConstBearingType_FollowedBySharedFields_HasCorrectFieldRows() {
        // Regression for the FieldDef-row planner: a `const` field is emitted as a
        // CLR literal field row, so it must be counted when reserving FieldDef
        // rows. Previously the planner omitted const fields, which shifted every
        // following type's fieldList pointer and leaked the last `shared` field of
        // the following type onto the synthesized <Program> type — producing
        // invalid IL (a `.cctor` storing another type's initonly field). IL-verify
        // would catch the regression; the runtime values confirm correct binding.
        let source = `package P
import System

class Limits {
    const Cap int32 = 8
}

class Stats {
    shared {
        let A int32 = 1
        let B int32 = 2
        let C int32 = 3
    }
}

Console.WriteLine(Stats.A + Stats.B + Stats.C)`
        let output = CompileAndRun(source)
        Assert.Equal("6${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1070_emit_").FullName
            try {
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
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
