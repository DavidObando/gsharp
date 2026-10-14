// <copyright file="Issue1107OutVarUserTypeErasureEmitTests.cs" company="GSharp">
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

/// Issue #1107: an inline `out var` argument bound against a generic by-ref
/// parameter whose pointee is a type-level type parameter — e.g. the
/// `out TValue` of `Dictionary<TKey, TValue>.TryGetValue` — was
/// typed from the type-erased closed CLR shape (`out object`) when the
/// receiver's generic argument is a <em>same-compilation</em> user type. The
/// out-var local therefore bound as `object` and any subsequent member
/// access on it failed with `GS0158`.
///
/// This is the by-ref-parameter counterpart of the generic-method return-type
/// erasure fixed for #1100 (PR #1102): the return path was recovered in
/// `ResolveInstanceReturnTypeFromReceiver`, but the by-ref parameter path
/// in `RebindInlineOutVarArguments` (#977) still derived the out-var
/// pointee from the erased closed shape. The new
/// `ResolveInstanceParameterPointeeTypeFromReceiver` re-projects the open
/// declaring type's parameter pointee through the receiver's symbolic type
/// arguments, recovering the user element type. These tests compile, IL-verify,
/// and actually run the shape end-to-end.
open class Issue1107OutVarUserTypeErasureEmitTests {
    @Fact
    func DictionaryOfUserClass_TryGetValueOutVar_Compiles_And_Runs() {
        // The headline repro: `Dictionary[string, Entry].TryGetValue(key, out var
        // found)` must bind `found` as `Entry` (not erased `object`) so the
        // subsequent `found.V` resolves (no GS0158), and the program runs.
        let source = `package P
import System
import System.Collections.Generic

class Entry { var V int32 }

class C {
    private let d Dictionary[string, Entry] = Dictionary[string, Entry]()
    func Put(key string, e Entry) { d[key] = e }
    func TryGet(key string) int32 {
        var ok = d.TryGetValue(key, out var found)
        if ok { return found.V }
        return -1
    }
}

var c = C()
var a = Entry()
a.V = 42
c.Put("k", a)
Console.WriteLine(c.TryGet("k"))
Console.WriteLine(c.TryGet("missing"))`
        Assert.Equal("42${Environment.NewLine}-1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func DictionaryOfUserDataStruct_TryGetValueOutVar_Compiles_And_Runs() {
        // Value-type user argument: `found` must bind as the `Item` struct (not
        // `object`), so `found.Price` resolves and no spurious unbox is emitted.
        let source = `package P
import System
import System.Collections.Generic

data struct Item(Name string, Price int32)

class C {
    private let d Dictionary[string, Item] = Dictionary[string, Item]()
    func Put(key string, i Item) { d[key] = i }
    func TryTotal(key string) int32 {
        var ok = d.TryGetValue(key, out var found)
        if ok { return found.Price }
        return -1
    }
}

var c = C()
c.Put("a", Item{Name: "a", Price: 42})
Console.WriteLine(c.TryTotal("a"))
Console.WriteLine(c.TryTotal("missing"))`
        Assert.Equal("42${Environment.NewLine}-1${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1107_emit_").FullName
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
