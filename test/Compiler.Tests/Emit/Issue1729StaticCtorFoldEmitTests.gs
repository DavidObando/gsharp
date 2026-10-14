// <copyright file="Issue1729StaticCtorFoldEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1729 — runtime proof that the fixed static-constructor fold produces
/// the CORRECT final field value at execution time, not merely a plausible-
/// looking translation. Each source string below is exactly the canonical G#
/// shape `cs2gs` emits after the fix (verified against
/// `Cs2Gs.Tests.Issue1729StaticCtorFoldTranslationTests`, which asserts the
/// C#→G# translation itself picks this shape). Every fact uses a UNIQUE
/// package/type name because the in-process compiler caches are name-keyed.
open class Issue1729StaticCtorFoldEmitTests {
    /// Mode 1 fix: when a static field has BOTH an inline initializer and a
    /// static-ctor assignment, C# runs the field initializer THEN the static
    /// constructor — the constructor's assignment is the field's true final
    /// value. The fold must keep that value (2), not the inline initializer's
    /// value (1).
    @Fact
    func FoldedStaticCtor_InlineInitializerOverwritten_RunsWithCtorFinalValue() {
        const source = `package i1729mode1
import System

class C {
    shared {
        var X int32 = 2
    }
}

func Main() { System.Console.WriteLine(C.X) }`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    /// Regression: a static field with no inline initializer, assigned once by
    /// an otherwise-trivial static constructor with an RHS independent of the
    /// type's own static state, must still fold correctly and run with the
    /// assigned value.
    @Fact
    func FoldedStaticCtor_SimpleAssignment_RunsWithFoldedValue() {
        const source = `package i1729regression
import System

class C {
    shared {
        var X int32 = 1
    }
}

func Main() { System.Console.WriteLine(C.X) }`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    /// Mode 4 fix: an outer static field declared AFTER a nested type must
    /// retain its own folded static-ctor initializer — the fold-collection state
    /// is now saved/restored around the nested-type visit instead of being
    /// wiped wholesale, so both the outer and nested fold survive.
    @Fact
    func FoldedStaticCtor_OuterFieldAfterNestedType_RunsWithBothFoldedValues() {
        const source = `package i1729mode4
import System

class Outer {
    class Nested {
        shared {
            var NestedField int32 = 9
        }
    }

    shared {
        var Before int32 = 1
        var After int32 = 2
    }
}

func Main() {
    System.Console.WriteLine(Outer.Before)
    System.Console.WriteLine(Outer.Nested.NestedField)
    System.Console.WriteLine(Outer.After)
}`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}9${Environment.NewLine}2${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1729_exe_").FullName
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
