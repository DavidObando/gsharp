// <copyright file="Issue4350InferredOutVarEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #4350: an inline `out var` passed to an imported generic method
/// whose type argument is inferred from an in-scope G# type parameter keeps
/// the symbolic pointee (`ArraySegment[T]`) instead of the erased
/// `ArraySegment[object]`. Found by the Gsharp.Runtime.Values
/// self-migration (`MemoryMarshal.TryGetArray(memory, out var segment)`).
open class Issue4350InferredOutVarEmitTests {
    @Fact
    func InferredGenericOutVar_KeepsSymbolicTypeParameter() {
        let source = `package P
import System
import System.Runtime.InteropServices

class Box[T] {
    shared {
        func Owner(memory ReadOnlyMemory[T]) []?T {
            if MemoryMarshal.TryGetArray(memory, out var segment) && segment.Array is {} array {
                let typed []T = array
                return typed
            }
            return nil
        }

        func Named(memory ReadOnlyMemory[T]) int32 {
            if MemoryMarshal.TryGetArray(segment: out var segment, memory: memory) {
                let copy ArraySegment[T] = segment
                return copy.Offset
            }
            return -1
        }

        func Count(memory ReadOnlyMemory[T]) int32 {
            if MemoryMarshal.TryGetArray(memory, out var segment) {
                let copy ArraySegment[T] = segment
                return copy.Count
            }
            return -1
        }
    }
}

let xs = []string{"a", "b", "c"}
let owner = Box[string].Owner(ReadOnlyMemory[string](xs, 1, 2))
Console.WriteLine(object.ReferenceEquals(owner, xs))
Console.WriteLine(Box[string].Count(ReadOnlyMemory[string](xs, 1, 2)))
Console.WriteLine(Box[string].Named(ReadOnlyMemory[string](xs, 1, 2)))`
        Assert.Equal(Lines("True", "2", "1"), CompileAndRun(source))
    }

    shared {
        private func Lines(lines ...string) string -> string.Concat(
            Array.ConvertAll(lines, (line string) -> (line + Environment.NewLine))
        )

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue4350_outvar_").FullName
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
