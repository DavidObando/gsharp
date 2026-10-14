// <copyright file="Issue2771AsyncNullConditionalHoistEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2771: emitter-owned null-conditional capture stores must target
/// state-machine fields when async lowering hoists those captures.
open class Issue2771AsyncNullConditionalHoistEmitTests {
    @Theory
    @MemberData("RuntimeMatrix")
    func NullConditionalMatrix_VerifiesAndRuns(_ string, body string, expected string) {
        Assert.Equal(expected, CompileVerifyAndRun(Wrap(body)))
    }

    @Fact
    func HoistedFields_PreserveNullableIdentity() {
        let source = Wrap(`class Runner {
    async func Ref(raw string?) Task[string?] {
        let value string? = raw?.Trim()
        await Task.Yield()
        return value
    }

    async func Val(raw string?) Task[int32?] {
        let value int32? = raw?.Length
        await Task.Yield()
        return value
    }
}`)
        let (directory, outputPath) = Compile(source)
        try {
            IlVerifier.Verify(outputPath)
            let loadContext = AssemblyLoadContext("Issue2771FieldShape", isCollectible: true)
            try {
                let assembly = loadContext.LoadFromAssemblyPath(outputPath)
                let stateMachines = assembly
                    .GetTypes()
                    .Where((type Type) -> type.Name.Contains("d__", StringComparison.Ordinal))
                    .ToArray()
                let refMachine = Assert.Single(
                    stateMachines,
                    (type Type) -> type.Name.Contains("<Ref>", StringComparison.Ordinal)
                )
                let valMachine = Assert.Single(
                    stateMachines,
                    (type Type) -> type.Name.Contains("<Val>", StringComparison.Ordinal)
                )
                Assert.Contains(
                    refMachine.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
                    (field FieldInfo) -> field.Name.Contains("<value>5__", StringComparison.Ordinal) &&
                        field.FieldType == typeof(string)
                )
                Assert.Contains(
                    refMachine.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
                    (field FieldInfo) -> field.Name.Contains("<$$ncap_", StringComparison.Ordinal) &&
                        field.FieldType == typeof(string)
                )
                Assert.Contains(
                    valMachine.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
                    (field FieldInfo) -> field.Name.Contains("<value>5__", StringComparison.Ordinal) &&
                        field.FieldType == typeof(int32?)
                )
                Assert.Contains(
                    valMachine.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
                    (field FieldInfo) -> field.Name.Contains("<$$ncap_", StringComparison.Ordinal) &&
                        field.FieldType == typeof(string)
                )
            } finally {
                loadContext.Unload()
            }
        } finally {
            DeleteDirectory(directory)
        }
    }

    shared {
        func RuntimeMatrix() sequence[[]object] {
            yield Case("method, null and non-null receivers, ConfigureAwait, before and after await", `class Svc {
    async func Tick() Task[bool] {
        await Task.Yield()
        return true
    }
}

class Runner {
    async func Run(raw string?) Task[string] {
        let value string? = raw?.Trim()
        let before = value ?? "nil"
        let ok = await Svc().Tick().ConfigureAwait(false)
        return before + ":" + (value ?? "nil") + ":" + ok.ToString()
    }
}

let runner = Runner()
Console.WriteLine(runner.Run("  method  ").Result)
Console.WriteLine(runner.Run(nil).Result)`, `method:method:True
nil:nil:True
`)
            yield Case("property with nullable value result", `class Runner {
    async func Run(raw string?) Task[int32] {
        let length int32? = raw?.Length
        let before = length ?? 0
        await Task.Delay(1)
        return before + (length ?? 0)
    }
}

let runner = Runner()
Console.WriteLine(runner.Run("four").Result)
Console.WriteLine(runner.Run(nil).Result)`, `8
0
`)
            yield Case("property with nullable reference result", `class Box {
    private let text string?

    init(text string?) {
        this.text = text
    }

    prop Text string? {
        get { return this.text }
    }
}

class Runner {
    async func Run(box Box?) Task[string] {
        let text string? = box?.Text
        await Task.Yield()
        return text ?? "none"
    }
}

let runner = Runner()
Console.WriteLine(runner.Run(Box("property")).Result)
Console.WriteLine(runner.Run(nil).Result)`, `property
none
`)
            yield Case("loop preserves each conditional local", `class Runner {
    async func Run(items []string) Task[int32] {
        var total = 0
        for raw in items {
            let value string? = raw?.Trim()
            await Task.Yield()
            if value != nil {
                total = total + value!!.Length
            }
        }

        return total
    }
}

Console.WriteLine(Runner().Run([]string{" a ", "bc", ""}).Result)`, "3\n")
            yield Case("async closure preserves method result", `class Nav {
    private let label string

    init(label string) {
        this.label = label
    }

    func Label() string {
        return this.label
    }
}

class Runner {
    func Run(nav Nav?) Task[string] {
        return Task.Run(async () -> {
            let label string? = nav?.Label()
            await Task.Delay(1).ConfigureAwait(false)
            return label ?? "none"
        })
    }
}

let runner = Runner()
Console.WriteLine(runner.Run(Nav("closure")).Result)
Console.WriteLine(runner.Run(nil).Result)`, `closure
none
`)
            yield Case("plain nullable and await-free controls", `class Runner {
    async func Plain(raw string?) Task[string] {
        let value = raw
        await Task.Yield()
        return value ?? "none"
    }

    func ConditionalWithoutAwait(raw string?) string {
        let value string? = raw?.Trim()
        return value ?? "none"
    }
}

let runner = Runner()
Console.WriteLine(runner.Plain("plain").Result)
Console.WriteLine(runner.Plain(nil).Result)
Console.WriteLine(runner.ConditionalWithoutAwait(" control "))
Console.WriteLine(runner.ConditionalWithoutAwait(nil))`, `plain
none
control
none
`)
        }

        private func Case(name string, body string, expected string)[]object -> []object{name, body, expected}

        private func Wrap(body string) string -> `package issue2771
import System
import System.Threading.Tasks
` + body

        private func CompileVerifyAndRun(source string) string {
            let (directory, outputPath) = Compile(source)
            try {
                IlVerifier.Verify(outputPath)
                using let process Process? = Process.Start(
                    ProcessStartInfo("dotnet"){
                        ArgumentList = {
                            "exec",
                            "--runtimeconfig",
                            Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                            outputPath
                        },
                        WorkingDirectory = directory,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false
                    }
                )
                let output = process!!.StandardOutput.ReadToEnd()
                let error = process!!.StandardError.ReadToEnd()
                Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process!!.ExitCode == 0, error)
                return output.ReplaceLineEndings(Environment.NewLine)
            } finally {
                DeleteDirectory(directory)
            }
        }

        private func Compile(source string)(Directory string, OutputPath string) {
            let directory = Path.GetFullPath(
                Path.Combine(
                    Directory.GetCurrentDirectory(),
                    "out",
                    "test-artifacts",
                    "issue2771-" + Guid.NewGuid().ToString("N")
                )
            )
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(exitCode == 0, (`compile failed (` + "$exitCode" + `):
` + "$stdout" + `
` + "$stderr"))
            return (directory, outputPath)
        }

        private func DeleteDirectory(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }
}
