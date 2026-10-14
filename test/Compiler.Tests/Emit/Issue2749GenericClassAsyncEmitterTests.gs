// <copyright file="Issue2749GenericClassAsyncEmitterTests.cs" company="GSharp">
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

/// Issue #2749: async state-machine field references must use the canonical
/// generic identity of the state machine and its hoisted receiver.
open class Issue2749GenericClassAsyncEmitterTests {
    @Theory
    @MemberData("AsyncGenericMatrix")
    func AwaitAndHoistedLocals_VerifyAndRun(_ string, source string, expected string) {
        Assert.Equal(expected, CompileVerifyAndRun(source))
    }

    shared {
        func AsyncGenericMatrix() sequence[[]object] {
            yield Case("non-generic class", `class Job2749 {
    async func Run(value string) string {
        let hoisted = value
        await Task.Delay(1)
        return hoisted
    }
}
Console.WriteLine(Job2749().Run("plain").Result)`, "plain\n")
            yield Case("generic class", `class Job2749[T](Seed T) {
    async func Run(value T) T {
        let hoisted = value
        await Task.Delay(1)
        Console.WriteLine(Seed)
        return hoisted
    }
}
Console.WriteLine(Job2749[string]("class").Run("hoisted").Result)`, `class
hoisted
`)
            yield Case("generic method", `async func Run2749[T](value T) T {
    let hoisted = value
    await Task.Delay(1)
    return hoisted
}
Console.WriteLine(Run2749("method").Result)`, "method\n")
            yield Case("generic class and method", `class Job2749[T](Seed T) {
    async func Run[U](value U) T {
        let hoistedT = Seed
        let hoistedU = value
        await Task.Delay(1)
        Console.WriteLine(hoistedU)
        return hoistedT
    }
}
Console.WriteLine(Job2749[string]("class-method").Run(42).Result)`, `42
class-method
`)
            yield Case("generic class with async captures", `class Job2749[T](Seed T, Callback (T) -> void) {
    private let Values List[T] = List[T]()

    async func Run(value T) T {
        let hoisted = value
        let action = () -> Callback(hoisted)
        await Task.Delay(1)
        action()
        Values.Add(hoisted)
        return Seed
    }
}
let job = Job2749[string]("captured", (value string) -> Console.WriteLine(value))
Console.WriteLine(job.Run("callback").Result)`, `callback
captured
`)
            yield Case("nested generic class", `class Outer2749[T](Seed T) {
    class Job2749(Seed T) {
        async func Run(value T) T {
            let hoisted = value
            let action = () -> Console.WriteLine(hoisted)
            await Task.Delay(1)
            action()
            return Seed
        }
    }

    func Run(value T) T {
        return Job2749(Seed).Run(value).Result
    }
}
Console.WriteLine(Outer2749[string]("nested").Run("captured-nested"))`, `captured-nested
nested
`)
        }

        private func Case(name string, body string, expected string)[]object -> []object{name, `package issue2749
import System
import System.Collections.Generic
import System.Threading.Tasks
` + body, expected}

        private func CompileVerifyAndRun(source string) string {
            let directory = Path.Combine(
                Directory.GetCurrentDirectory(),
                "out",
                "test-artifacts",
                "issue2749-" + Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let previousOut = Console.Out
                let previousErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousErr)
                }
                Assert.True(exitCode == 0, (`gsc failed:
` + "$compileOut" + `
` + "$compileErr"))
                IlVerifier.Verify(outputPath)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(outputPath)
                using let process Process? = Process.Start(startInfo)
                let stdout = process!!.StandardOutput.ReadToEnd()
                let stderr = process!!.StandardError.ReadToEnd()
                Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process!!.ExitCode == 0, (`exited ` + "${process!!.ExitCode}" + `
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }
    }
}
