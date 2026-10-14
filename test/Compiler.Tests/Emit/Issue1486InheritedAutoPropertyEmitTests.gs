// <copyright file="Issue1486InheritedAutoPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1486 — reading (or writing) an INHERITED auto-property from a DERIVED
/// class lowered to a direct `ldfld`/`stfld` of the base class's PRIVATE
/// `<X>k__BackingField` instead of dispatching through the accessor.
/// That emitted invalid IL (ilverify `FieldAccess: Field is not visible`) and
/// threw (cref:FieldAccessException) at runtime. After the fix the direct
/// backing-field lowering fires only when the enclosing type DIRECTLY declares the
/// property; an inherited access dispatches through `get_X`/`set_X`.
open class Issue1486InheritedAutoPropertyEmitTests {
    @Fact
    func EndToEnd_DerivedReadsInheritedAutoProperty_VerifiesAndRuns() {
        let source = `package Issue1486a
import System

open class Issue1486Base {
    init() { Value = 7 }
    prop Value int32 { get; init; }
}

class Issue1486Derived : Issue1486Base {
    init() : base() { }
    shared {
        func Make() int32 {
            let d = Issue1486Derived()
            return d.Value
        }
    }
}

func Main() {
    Console.WriteLine(Issue1486Derived.Make())
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_DerivedWritesThenReadsInheritedAutoProperty_VerifiesAndRuns() {
        let source = `package Issue1486b
import System

open class Issue1486BaseW {
    prop Value int32 { get; set; }
}

class Issue1486DerivedW : Issue1486BaseW {
    shared {
        func Make() int32 {
            let d = Issue1486DerivedW()
            d.Value = 42
            return d.Value
        }
    }
}

func Main() {
    Console.WriteLine(Issue1486DerivedW.Make())
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_OwnAutoPropertyStillWorks_VerifiesAndRuns() {
        let source = `package Issue1486c
import System

class Issue1486Own {
    init() { Value = 99 }
    prop Value int32 { get; init; }
    shared {
        func Make() int32 {
            let o = Issue1486Own()
            return o.Value
        }
    }
}

func Main() {
    Console.WriteLine(Issue1486Own.Make())
}`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1486_exe_").FullName
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
