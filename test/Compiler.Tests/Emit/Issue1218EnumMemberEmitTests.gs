// <copyright file="Issue1218EnumMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #1218: inherited System.Enum / System.ValueType / System.Object
/// instance members must emit and run on enum values. An enum is a CLR value
/// type whose base chain is System.Enum -> System.ValueType ->
/// System.Object, so its inherited members (Enum.HasFlag,
/// Object/ValueType ToString / GetHashCode / Equals, Object.GetType) resolve to
/// real CLR MethodInfos. The value-type receiver is boxed before the
/// `callvirt`; for HasFlag the enum argument is additionally boxed to
/// System.Enum. These tests compile a program that exercises each member,
/// statically verify the IL, and assert the runtime output. G# enums get
/// sequential values (Red=0, Green=1, Blue=2) with no explicit-value or
/// `[Flags]` syntax, so HasFlag is exercised with single-flag equality
/// semantics (Green.HasFlag(Green) is true, Green.HasFlag(Blue) is false).
open class Issue1218EnumMemberEmitTests {
    @Fact
    func EnumReceiver_HasFlag_BoxesArgumentAndRuns() {
        let source = `package P
import System

enum Color { Red, Green, Blue }

Console.WriteLine(Color.Green.HasFlag(Color.Green))
Console.WriteLine(Color.Green.HasFlag(Color.Blue))
Console.WriteLine(Color.Blue.HasFlag(Color.Green))`
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func EnumReceiver_ToStringAndGetType_BoxAndRun() {
        let source = `package P
import System

enum Color { Red, Green, Blue }

Console.WriteLine(Color.Green.ToString())
Console.WriteLine(Color.Green.GetType().Name)`
        Assert.Equal("Green${Environment.NewLine}Color${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EnumReceiver_EqualsAndGetHashCode_BoxAndRun() {
        let source = `package P
import System

enum Color { Red, Green, Blue }

Console.WriteLine(Color.Green.Equals(Color.Green))
Console.WriteLine(Color.Green.Equals(Color.Blue))
Console.WriteLine(Color.Green.GetHashCode() == Color.Green.GetHashCode())
Console.WriteLine(Color.Green.GetHashCode() == Color.Blue.GetHashCode())`
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func EnumReceiver_HasFlagThroughClassMethod_EmitsAndRuns() {
        // Mirrors the original repro from issue #1218: HasFlag invoked through a
        // class method whose parameter is the enum type. Verifies the binder
        // resolves the inherited member on a parameter-typed receiver (not only
        // on a `Type.Member` literal) and that it emits and runs.
        let source = `package P
import System

enum Color { Red, Green, Blue }

class C {
    func Test(a Color, b Color) bool {
        return a.HasFlag(b)
    }
}

let c = C{ }
Console.WriteLine(c.Test(Color.Blue, Color.Blue))
Console.WriteLine(c.Test(Color.Blue, Color.Green))`
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1218_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                // (a) Static verification: the emitted IL must be valid.
                IlVerifier.Verify(outPath)
                // (b) Dynamic verification: the emitted code must execute.
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
