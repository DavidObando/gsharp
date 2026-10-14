// <copyright file="Issue1516CoalesceAsTypeParamEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1516 — null-coalescing (`??`) directly over an `as`-cast to
/// a REFERENCE-typed type parameter emitted unverifiable IL
/// (`StackUnexpected`). `BoundAsExpression.Type` for a reference
/// target is the BARE type parameter `T` (not `T?`), so the
/// `??` LHS is a `TypeParameterSymbol` directly — which the Issue
/// #831 box-probe path (gated on `NullableTypeSymbol(TP)`) missed in both
/// the slot collector and the emit branch. Emission fell through to the bottom
/// `dup; brtrue` shape, which the verifier rejects for an opaque
/// `!!T` stack value (ECMA-335 III.1.8).
///
/// The fix generalizes the box-probe spill to also cover a bare
/// reference-typed type-parameter LHS (`TypeParameterSymbol` that is NOT
/// struct-constrained): the collector pre-allocates a `T`-typed scratch
/// slot and the emitter spills the LHS, probes via `box !!T; brfalse
/// fallback`, and reloads the slot (non-null) or evaluates the RHS
/// (fallback). Every facet failed ilverify on current main and passes after
/// the fix. Each uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed.
open class Issue1516CoalesceAsTypeParamEmitTests {
    @Fact
    func EndToEnd_AsClassConstrainedT_CoalesceThrow_MatchedPath_Runs() {
        const source = `package i1516matchedthrow
import System
import System.IO

open class Box {
    let name string
    init(name string) { this.name = name }
    prop Name string -> name
}

class FooBox : Box {
    init(name string) : base(name) {}
}

class Factory {
    shared {
        func Make[T Box](src Box) T {
            return src as T ?? throw InvalidDataException("nope")
        }
    }
}

func Main() {
    var b Box = FooBox("x")
    System.Console.WriteLine(Factory.Make[FooBox](b).Name)
}`
        let output = CompileAndRun(source)
        Assert.Equal("x${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_AsClassConstrainedT_CoalesceFallback_FallbackPath_Runs() {
        // The cast `src as T` FAILS (a BarBox is not a FooBox), so the
        // fallback expression must be taken and returned.
        const source = `package i1516fallbacktaken
import System

open class Box {
    let name string
    init(name string) { this.name = name }
    prop Name string -> name
}

class FooBox : Box {
    init(name string) : base(name) {}
}

class BarBox : Box {
    init(name string) : base(name) {}
}

class Factory {
    shared {
        func Make[T Box](src Box, fallback T) T {
            return src as T ?? fallback
        }
    }
}

func Main() {
    var b Box = BarBox("bar")
    var fb FooBox = FooBox("fallback")
    System.Console.WriteLine(Factory.Make[FooBox](b, fb).Name)
}`
        let output = CompileAndRun(source)
        Assert.Equal("fallback${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_AsUnconstrainedT_Coalesce_BothPaths_Runs() {
        // Unconstrained `T` used as a reference: the matched path prints the
        // cast value ("hello"); the fallback path prints the fallback ("fb2")
        // because boxing an int32 cannot be cast to string.
        const source = `package i1516unconstrained
import System

class Holder {
    shared {
        func Get[T](src object, fallback T) T {
            return src as T ?? fallback
        }
    }
}

func Main() {
    var s object = "hello"
    System.Console.WriteLine(Holder.Get[string](s, "fb"))
    var n object = 5
    System.Console.WriteLine(Holder.Get[string](n, "fb2"))
}`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}fb2${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_Control_NullableTypeParamCoalesce_NoRegression_Runs() {
        // Control: `maybe T? ?? fallback` over a NullableTypeSymbol(TP) LHS
        // (the Issue #831 path) must remain ilverify-clean and correct.
        const source = `package i1516controlnullable
import System

open class Box {
    let name string
    init(name string) { this.name = name }
    prop Name string -> name
}

class Factory {
    shared {
        func Coalesce[T Box](maybe T?, fallback T) T {
            return maybe ?? fallback
        }
    }
}

func Main() {
    var present Box = Box("present")
    var fb Box = Box("fb")
    System.Console.WriteLine(Factory.Coalesce[Box](present as Box, fb).Name)
    System.Console.WriteLine(Factory.Coalesce[Box](nil, fb).Name)
}`
        let output = CompileAndRun(source)
        Assert.Equal("present${Environment.NewLine}fb${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1516_exe_").FullName
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
