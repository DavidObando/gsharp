// <copyright file="Issue1379GenericStaticReturnEmitTests.cs" company="GSharp">
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

/// Issue #1379: a `shared` (static) method on a user-defined generic type
/// whose return type references the type's own type parameter
/// (`func Make() Box[T]`) must have the receiver's type argument
/// substituted at the call site, so `Box[int32].Make()` is typed
/// `Box[int32]` rather than the raw/open `Box` (which fails the
/// conversion to the closed construction, GS0155). These end-to-end tests lock
/// the parse -> bind -> emit -> verify -> execute chain for the substituted
/// static return (and parameter) types.
open class Issue1379GenericStaticReturnEmitTests {
    @Fact
    func StaticReturnReferencingT_VerifiesAndExecutes() {
        // `Box[int32].Make(5)` returns `Box[int32]`; read its T-typed field.
        let source = `package P
import System
struct Box[T] {
    var V T
    shared { func Make(v T) Box[T] -> Box[T]{ V: v } }
}
var b = Box[int32].Make(5)
Console.WriteLine(b.V)`
        Assert.Equal("5${Environment.NewLine}", CompileVerifyAndRun(source))
    }

    @Fact
    func StaticReturnReferencingT_StringTypeArg_VerifiesAndExecutes() {
        // The substituted return type is independent of the element's
        // value/reference kind (`Box[string]`).
        let source = `package P
import System
struct Box[T] {
    var V T
    shared { func Make(v T) Box[T] -> Box[T]{ V: v } }
}
var b = Box[string].Make("hi")
Console.WriteLine(b.V)`
        Assert.Equal("hi${Environment.NewLine}", CompileVerifyAndRun(source))
    }

    @Fact
    func StaticReturnNotReferencingT_StillVerifiesAndExecutes() {
        // Control: a static method whose return type does NOT reference T keeps
        // emitting and executing unchanged.
        let source = `package P
import System
struct Box[T] { shared { func Make() int32 -> 41 } }
Console.WriteLine(Box[int32].Make() + 1)`
        Assert.Equal("42${Environment.NewLine}", CompileVerifyAndRun(source))
    }

    shared {
        private func CompileVerifyAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1379_emit_").FullName
            try {
                let outPath = CompileToDll(tempDir, source, "/target:exe")
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

        private func CompileToDll(tempDir string, source string, target string) string {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let args = List[string]{"/out:" + outPath, target, "/targetframework:net10.0", "/lib:" + runtimeDir}
            for refName in[]string{"System.Runtime.dll", "System.Private.CoreLib.dll", "System.Console.dll"} {
                args.Add("/reference:" + Path.Combine(runtimeDir, refName))
            }
            args.Add(srcPath)
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
            Assert.True(compileExit == 0, (`compile failed (` + "$compileExit" + `):
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            return outPath
        }
    }
}
