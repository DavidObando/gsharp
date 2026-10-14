// <copyright file="Issue4350GetOnlyAutoPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #4350: a get-only auto-property assigned in its declaring
/// constructor stores the backing field directly, so the emitted property
/// keeps C#'s get-only ABI — no setter or init accessor in metadata.
open class Issue4350GetOnlyAutoPropertyEmitTests {
    @Fact
    func ConstructorStores_EmitNoSetter() {
        let source = `package P
import System

struct Window[T] {
    init(items []T, length int32) {
        Items = items
        Length = length
        this.Capacity = items.Length
        Length += 0
    }
    prop Items []T { get; }
    prop Length int32 { get; }
    prop Capacity int32 { get; }
}

class Named {
    init(name string) {
        Name = name
        Count++
    }
    prop Name string { get; }
    prop Count int32 { get; }
}

let window = Window[string]([]string{"a", "b", "c"}, 2)
Console.WriteLine(window.Length)
Console.WriteLine(window.Capacity)
let named = Named("n")
Console.WriteLine(named.Name + named.Count.ToString())
Console.WriteLine(typeof(Window[string]).GetProperty("Length")!!.SetMethod == nil)
Console.WriteLine(typeof(Window[string]).GetProperty("Capacity")!!.SetMethod == nil)
Console.WriteLine(typeof(Named).GetProperty("Name")!!.SetMethod == nil)
Console.WriteLine(typeof(Named).GetProperty("Count")!!.CanWrite)`
        Assert.Equal(Lines("2", "3", "n1", "True", "True", "True", "False"), CompileAndRun(source))
    }

    shared {
        private func Lines(lines ...string) string -> string.Concat(
            Array.ConvertAll(lines, (line string) -> (line + Environment.NewLine))
        )

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue4350_getonly_").FullName
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
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi)!!
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
