// <copyright file="Issue1124GenericUninferableOverloadEmitTests.cs" company="GSharp">
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

/// Issue #1124: a method group containing a generic overload whose type
/// parameter cannot be inferred from the arguments (it appears only in the
/// return type / a constraint) alongside a non-generic overload with a matching
/// parameter list must, for a call without explicit type arguments, exclude the
/// generic candidate and bind the non-generic overload — previously this was
/// wrongly reported as GS0266 ambiguous.
///
/// These tests compile, IL-verify, and run the minimal repro end to end. The
/// non-generic overload returns a real `Box` (Tag = 99) while the generic
/// overload returns `default(T)` (null), so the runtime output proves which
/// overload was selected: the implicit call selects the non-generic overload
/// (prints 99), and an explicit type-argument list selects the generic overload
/// (returns null → prints -1).
open class Issue1124GenericUninferableOverloadEmitTests {
    @Fact
    func ImplicitCall_SelectsNonGenericOverload_EmitsAndRuns() {
        let source = `package p
import System

interface IBox {
    func Tag() int32;
}

class Box : IBox {
    func Tag() int32 { return 99 }
}

class Factory {
    shared {
        func Make[T Box](file int32, parent IBox?) T { return default(T) }
        func Make(file int32, parent IBox?) IBox { return Box() }
    }
}

class C {
    func runImplicit(b IBox) int32 {
        let child = Factory.Make(5, b)
        return child.Tag()
    }
}

var c = C()
Console.WriteLine(c.runImplicit(Box()))`
        Assert.Equal("99${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ExplicitTypeArguments_SelectGenericOverload_EmitsAndRuns() {
        let source = `package p
import System

interface IBox {
    func Tag() int32;
}

class Box : IBox {
    func Tag() int32 { return 99 }
}

class Factory {
    shared {
        func Make[T Box](file int32, parent IBox?) T? { return default(T) }
        func Make(file int32, parent IBox?) IBox { return Box() }
    }
}

class C {
    func runImplicit(b IBox) int32 {
        let child = Factory.Make(5, b)
        return child.Tag()
    }

    func runExplicit(b IBox) int32 {
        let child = Factory.Make[Box](5, b)
        if child == nil {
            return -1
        }

        return child.Tag()
    }
}

var c = C()
Console.WriteLine(c.runImplicit(Box()))
Console.WriteLine(c.runExplicit(Box()))`
        Assert.Equal("99${Environment.NewLine}-1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ExplicitTypeArguments_RankUsingSubstitutedParameterTypes() {
        let source = `package p
import System

interface IFormatter {
    func Format[T](value T) string;
    func Format[T](value object) string;
}

class Formatter : IFormatter {
    func Format[T](value T) string { return "typed" }
    func Format[T](value object) string { return "object" }
}

class C {
    func Run(formatter IFormatter, value object) string {
        return formatter.Format[Enum](value)
    }
}

Console.WriteLine(C().Run(Formatter(), "x"))`
        Assert.Equal("object${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1124_emit_").FullName
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
