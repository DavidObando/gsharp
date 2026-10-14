// <copyright file="Issue2962ConstrainedStaticPropertyChainTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Tests
import System
import System.Diagnostics
import System.IO
import System.Reflection
import Xunit
import Xunit.Sdk

/// Issue #2962: constrained static-virtual property reads remain valid receivers
/// for every supported member-chain suffix.
open class Issue2962ConstrainedStaticPropertyChainTests {
    @Fact
    func ChainedAccesses_LoadAndExecute() {
        const Source = `package Issue2962.Chains
import System

sealed interface IValue[T] {
    shared { prop V T { get; } }
}

struct TextProvider : IValue[string] {
    shared { prop V string -> "value" }
}

struct ControlProvider : IValue[string] {
    shared { prop V string -> "broken" }
}

struct FieldHolder {
    var Field string
}

struct FieldProvider : IValue[FieldHolder] {
    shared { prop V FieldHolder -> FieldHolder{ Field: "value" } }
}

struct Leaf {
    prop X string -> "value"
}

struct Middle {
    prop W Leaf -> Leaf{}
}

struct NestedProvider : IValue[Middle] {
    shared { prop V Middle -> Middle{} }
}

struct Box[T] {
    var Item T
}

struct GenericProvider : IValue[Box[string]] {
    shared { prop V Box[string] -> Box[string]{ Item: "value" } }
}

sealed interface INullable[T] {
    shared { prop V T? { get; } }
}

struct NullableProvider : INullable[string] {
    shared { prop V string -> "value" }
}

func ReadValue[T IValue[string]](w T) string { return T.V }
func ReadLength[T IValue[string]](w T) int32 { return T.V.Length }
func ReadMethod[T IValue[string]](w T) string { return T.V.ToUpper() }
func ReadIndex[T IValue[string]](w T) char { return T.V[0] }
func ReadField[T IValue[FieldHolder]](w T) string { return T.V.Field }
func ReadNested[T IValue[Middle]](w T) string { return T.V.W.X }
func ReadGeneric[T IValue[Box[string]]](w T) int32 { return T.V.Item.Length }
func ReadNullable[T INullable[string]](w T) int32? { return T.V?.Length }
func ReadNullableIndex[T INullable[string]](w T) char? { return T.V?[0] }

func Main() {
    Console.WriteLine(ReadValue(TextProvider{}))
    Console.WriteLine(ReadLength(TextProvider{}))
    Console.WriteLine(ReadMethod(TextProvider{}))
    Console.WriteLine(ReadIndex(TextProvider{}))
    Console.WriteLine(ReadField(FieldProvider{}))
    Console.WriteLine(ReadNested(NestedProvider{}))
    Console.WriteLine(ReadGeneric(GenericProvider{}))
    Console.WriteLine(ReadNullable(NullableProvider{}))
    Console.WriteLine(ReadNullableIndex(NullableProvider{}))
    Console.WriteLine(ReadValue(ControlProvider{}))
    Console.WriteLine(ReadLength(ControlProvider{}))
}`
        const Expected = `value
5
VALUE
v
value
value
5
5
v
broken
6
`
        let directory = CreateWorkDirectory()
        try {
            let assemblyPath = CompileSource(Source, directory, "Issue2962Chains.dll", target: "exe")
            let _ = EmittedFixture.Load(assemblyPath).GetTypes()
            Assert.Equal(Expected, RunChild(assemblyPath, directory))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func NullableDirectChain_ReportsMemberDiagnosticInsteadOfIce() {
        const Source = `package Issue2962.Nullable

sealed interface I[T] {
    shared { prop V T? { get; } }
}

struct C : I[string] {
    shared { prop V string -> "value" }
}

func Read[T I[string]](w T) int32 {
    return T.V.Length
}`
        let directory = CreateWorkDirectory()
        try {
            let sourcePath = Path.Combine(directory, "Issue2962Nullable.gs")
            let outputPath = Path.Combine(directory, "Issue2962Nullable.dll")
            File.WriteAllText(sourcePath, Source)
            let (exitCode, output) = Compile(
                "/out:" + outputPath,
                "/target:library",
                "/targetframework:net10.0",
                sourcePath
            )
            Assert.Equal(1, exitCode)
            Assert.Contains("error GS0158: Cannot find member Length.", output, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func NullablePropertyRead_RejectsAssignmentToNonNullableSlot() {
        const Source = `package Issue2962.NullableAssignment

sealed interface I[T] {
    shared { prop V T? { get; } }
}

struct C : I[string] {
    shared { prop V string -> "value" }
}

func Read[T I[string]](w T) string {
    let value string = T.V
    return value
}`
        let directory = CreateWorkDirectory()
        try {
            let sourcePath = Path.Combine(directory, "Issue2962NullableAssignment.gs")
            let outputPath = Path.Combine(directory, "Issue2962NullableAssignment.dll")
            File.WriteAllText(sourcePath, Source)
            let (exitCode, output) = Compile(
                "/out:" + outputPath,
                "/target:library",
                "/targetframework:net10.0",
                sourcePath
            )
            Assert.Equal(1, exitCode)
            // #3296 retired the legacy any-to-string conversion arm and
            // re-anchored the string? -> string rejection to GS0155 (the
            // #1627 Kotlin-model nullability rule); same message, new id.
            Assert.Contains(
                "error GS0155: Cannot convert type 'string?' to 'string'.",
                output,
                StringComparison.Ordinal
            )
            Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func NonMemberStaticSuffix_ReportsSourceTextInsteadOfIce() {
        const Source = `package Issue2962.InvalidSuffix

sealed interface I[T] {
    shared { prop V T { get; } }
}

struct C : I[string] {
    shared { prop V string -> "value" }
}

func Read[T I[string]](w T) int32 {
    return T.sizeof(int32)
}

func Main() {
    Read(C{})
}`
        let directory = CreateWorkDirectory()
        try {
            let sourcePath = Path.Combine(directory, "Issue2962InvalidSuffix.gs")
            let outputPath = Path.Combine(directory, "Issue2962InvalidSuffix.dll")
            File.WriteAllText(sourcePath, Source)
            let (exitCode, output) = Compile(
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath
            )
            Assert.Equal(1, exitCode)
            Assert.Contains(
                "error GS0333: Constrained static access 'sizeof' on type parameter 'T' must name a static-virtual member declared by an interface constraint (ADR-0089).",
                output,
                StringComparison.Ordinal
            )
            Assert.DoesNotContain("GS9999", output, StringComparison.Ordinal)
            Assert.DoesNotContain("member '?'", output, StringComparison.Ordinal)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func CompileSource(source string, directory string, outputName string, target string) string {
            let sourcePath = Path.Combine(directory, Path.GetFileNameWithoutExtension(outputName) + ".gs")
            let outputPath = Path.Combine(directory, outputName)
            File.WriteAllText(sourcePath, source)
            let (exitCode, output) = Compile(
                "/out:" + outputPath,
                "/target:" + target,
                "/targetframework:net10.0",
                sourcePath
            )
            Assert.True(exitCode == 0, "gsc failed:\n" + output)
            return outputPath
        }

        private func Compile(arguments ...string)(ExitCode int32, Output string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(arguments)
                return (exitCode, stdout.ToString() + stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func RunChild(assemblyPath string, workingDirectory string) string {
            let runtimeConfig = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json")
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = workingDirectory
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(runtimeConfig)
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet child process.")
            let stdoutTask = process.StandardOutput.ReadToEndAsync()
            let stderrTask = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                let timedOutStdout = stdoutTask.GetAwaiter().GetResult()
                let timedOutStderr = stderrTask.GetAwaiter().GetResult()
                throw XunitException((`dotnet child timed out.
stdout:
` + "$timedOutStdout" + `
stderr:
` + "$timedOutStderr"))
            }
            let stdout = stdoutTask.GetAwaiter().GetResult()
            let stderr = stderrTask.GetAwaiter().GetResult()
            Assert.True(process.ExitCode == 0, (`dotnet child exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        private func CreateWorkDirectory() string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2962-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            return directory
        }
    }
}
