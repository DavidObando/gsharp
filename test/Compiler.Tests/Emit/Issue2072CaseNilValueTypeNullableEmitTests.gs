// <copyright file="Issue2072CaseNilValueTypeNullableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2072 — a switch/case-nil pattern against a value-type
/// `Nullable<T>` discriminant crashed emit with GS9998.
///
/// `PatternBinder.BindConstantPattern` built the `nil`-arm's
/// converted value directly as a bare `BoundConversionExpression`,
/// bypassing `ConversionClassifier.BindConversion`'s issue #504
/// lowering that rewrites `nil -> Nullable<value-type>` to a
/// `BoundDefaultExpression` so emit can materialize the verifiable
/// `ldloca; initobj; ldloc` shape instead of an invalid `ldnull`
/// against a value-type `Nullable<T>` slot. Fixed by routing that
/// conversion through the same classifier entry point used everywhere else.
///
/// Covers a BCL primitive (`int32?`), a user struct, and a user enum
/// discriminant — every facet crashed emit on current main and passes after
/// the fix. Each uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed.
open class Issue2072CaseNilValueTypeNullableEmitTests {
    @Fact
    func EndToEnd_CaseNil_Int32Nullable_Runs() {
        const source = `package i2072int32
import System

class C {
    shared {
        func Describe(x int32?) string -> switch x {
            case _ is int32: "has value"
            case nil: "none"
            default: "impossible"
        }
    }
}

func Main() {
    System.Console.WriteLine(C.Describe(5))
    System.Console.WriteLine(C.Describe(nil))
}`
        let output = CompileAndRun(source)
        Assert.Equal("has value${Environment.NewLine}none${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_CaseNil_UserStructNullable_Runs() {
        const source = `package i2072struct
import System

struct Point2072(X int32, Y int32) { }

class C {
    shared {
        func Describe(p Point2072?) string -> switch p {
            case _ is Point2072: "has point"
            case nil: "no point"
            default: "impossible"
        }
    }
}

func Main() {
    System.Console.WriteLine(C.Describe(Point2072(1, 2)))
    System.Console.WriteLine(C.Describe(nil))
}`
        let output = CompileAndRun(source)
        Assert.Equal("has point${Environment.NewLine}no point${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_CaseNil_UserEnumNullable_Runs() {
        const source = `package i2072enum
import System

enum Color2072 { Red, Green, Blue }

class C {
    shared {
        func Describe(c Color2072?) string -> switch c {
            case _ is Color2072: "has color"
            case nil: "no color"
            default: "impossible"
        }
    }
}

func Main() {
    System.Console.WriteLine(C.Describe(Color2072.Green))
    System.Console.WriteLine(C.Describe(nil))
}`
        let output = CompileAndRun(source)
        Assert.Equal("has color${Environment.NewLine}no color${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2072_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
