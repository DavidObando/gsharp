// <copyright file="Issue3254EnclosingGenericClosureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3254: synthesized lambda and `go` closure types must preserve
/// enclosing generic type parameters at their definitions and use sites.
open class Issue3254EnclosingGenericClosureEmitTests {
    @Fact
    func LambdaCapturingNestedTypeWithEnclosingTypeParameterRuns() {
        const Source = `package Issue3254.Lambda
import System

class Thing {
}

class Owner[T] {
    struct Payload[U] {
        var First T
        var Second U
    }
}

func Run[T, U](value Owner[T].Payload[U]) {
    let read = () -> value
    Console.WriteLine([]T{ read().First }.GetType())
    Console.WriteLine(read().First)
    Console.WriteLine([]U{ read().Second }.GetType())
    Console.WriteLine(read().Second)
}

func ShowTypes[T, U](value Owner[T].Payload[U]) {
    let read = () -> value
    Console.WriteLine([]T{ read().First }.GetType())
    Console.WriteLine([]U{ read().Second }.GetType())
}

func Main() {
    Run[int32, string](Owner[int32].Payload[string]{ First: 42, Second: "right" })
    Run[string, int32](Owner[string].Payload[int32]{ First: "left", Second: 7 })
    ShowTypes[string, Thing](Owner[string].Payload[Thing]{ First: "ref", Second: Thing{} })
}`
        AssertCompilesAndRuns(Source, `System.Int32[]
42
System.String[]
right
` + `System.String[]
left
System.Int32[]
7
` + `System.String[]
Issue3254.Lambda.Thing[]
`, "LambdaCapturingNestedTypeWithEnclosingTypeParameterRuns")
    }

    @Fact
    func LambdaCapturingUnqualifiedNestedTypeInsideGenericClassRuns() {
        const Source = `package Issue3254.UnqualifiedLambda
import System

class Owner[T] {
    struct Payload[U] {
        var First T
        var Second U
    }

    func Show(value Payload[string]) {
        let read = () -> value
        Console.WriteLine([]T{ read().First }.GetType())
        Console.WriteLine(read().First)
    }
}

func Main() {
    Owner[int32]{}.Show(Owner[int32].Payload[string]{ First: 42, Second: "int" })
    Owner[string]{}.Show(Owner[string].Payload[string]{ First: "right", Second: "string" })
}`
        AssertCompilesAndRuns(Source, `System.Int32[]
42
System.String[]
right
`, "LambdaCapturingUnqualifiedNestedTypeInsideGenericClassRuns")
    }

    @Fact
    func GoInsideGenericFunctionPreservesCapturedTypeParameter() {
        const Source = `package Issue3254.Go
import System

func Show[T](value T) int32 {
    Console.WriteLine([]T{ value }.GetType())
    Console.WriteLine(value)
    return 0
}

func Run[T](value T) {
    scope {
        go Show[T](value)
    }
}

class Runner[T] {
    func Run(value T) {
        scope {
            go Show[T](value)
        }
    }
}

func Main() {
    Run[int32](42)
    Run[string]("right")
    Runner[int32]{}.Run(7)
    Runner[string]{}.Run("class")
}`
        AssertCompilesAndRuns(Source, `System.Int32[]
42
System.String[]
right
` + `System.Int32[]
7
System.String[]
class
`, "GoInsideGenericFunctionPreservesCapturedTypeParameter")
    }

    @Fact
    func AsyncGoInsideGenericFunctionPreservesCapturedTypeParameter() {
        const Source = `package Issue3254.AsyncGo
import System
import System.Threading.Tasks

async func Show[T](value T) {
    await Task.Delay(1)
    Console.WriteLine([]T{ value }.GetType())
    Console.WriteLine(value)
}

func Run[T](value T) {
    scope {
        go Show[T](value)
    }
}

func Main() {
    Run[int32](42)
    Run[string]("right")
}`
        AssertCompilesAndRuns(Source, `System.Int32[]
42
System.String[]
right
`, "AsyncGoInsideGenericFunctionPreservesCapturedTypeParameter")
    }

    shared {
        private func AssertCompilesAndRuns(source string, expectedOutput string, testName string) {
            let directory = Directory.CreateDirectory(
                Path.Combine(AppContext.BaseDirectory, "issue3254", testName + "-" + Guid.NewGuid().ToString("N"))
            )
                .FullName
            try {
                let sourcePath = Path.Combine(directory, "Probe.gs")
                let assemblyPath = Path.Combine(directory, "Probe.dll")
                File.WriteAllText(sourcePath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(compileExit == 0, (`gsc exited ` + "$compileExit" + `
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                using let process = Process.Start(
                    ProcessStartInfo("dotnet"){
                        ArgumentList = {
                            "exec",
                            "--runtimeconfig",
                            Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                            assemblyPath
                        },
                        WorkingDirectory = directory,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false
                    }
                ) ??
                    throw InvalidOperationException("Failed to start dotnet exec.")
                let stdoutTask = process.StandardOutput.ReadToEndAsync()
                let stderrTask = process.StandardError.ReadToEndAsync()
                Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
                let stdout = stdoutTask.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine)
                let stderr = stderrTask.GetAwaiter().GetResult()
                Assert.True(process.ExitCode == 0, (`dotnet exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                Assert.Equal(expectedOutput, stdout)
                IlVerifier.Verify(assemblyPath)
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }
    }
}
