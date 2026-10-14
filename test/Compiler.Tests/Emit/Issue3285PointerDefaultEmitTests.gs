// <copyright file="Issue3285PointerDefaultEmitTests.cs" company="GSharp">
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
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #3285: pointer defaults materialize as native-int zero, never `ldnull`.
open class Issue3285PointerDefaultEmitTests {
    @Fact
    async func PointerDefaults_AllSupportedPositions_CompileAndRun() {
        const Source = `package Issue3285
import System

struct Point {
    var X int32
    var Y int32
}

class RefBox {}

unsafe class PointerFields {
    var Raw *int32 = default
    var Fn *func(int32) int32 = default
}

unsafe func rawOptional(value *int32 = nil) {
    Console.WriteLine(nint(value))
}

unsafe func fnOptional(value *func(int32) int32 = default(*func(int32) int32)) {
    Console.WriteLine(nint(value))
}

unsafe func rawDefault() *int32 { return default(*int32) }
unsafe func fnDefault() *func(int32) int32 { return default(*func(int32) int32) }
unsafe func rawNil() *int32 { return nil }
unsafe func fnNil() *func(int32) int32 { return nil }
func refDefault() RefBox? { return default(RefBox?) }
func nullableDefault() int32? { return default(int32?) }
func pointDefault() Point { return default(Point) }

unsafe {
    rawOptional()
    fnOptional()

    var fields = PointerFields()
    Console.WriteLine(nint(fields.Raw))
    Console.WriteLine(nint(fields.Fn))

    let rawBare *int32 = default
    let fnBare *func(int32) int32 = default
    Console.WriteLine(nint(rawBare))
    Console.WriteLine(nint(fnBare))
    Console.WriteLine(nint(rawDefault()))
    Console.WriteLine(nint(fnDefault()))
    Console.WriteLine(nint(rawNil()))
    Console.WriteLine(nint(fnNil()))

    var rawElements = []*int32{default(*int32), default, nil}
    var fnElements = []*func(int32) int32{default(*func(int32) int32), default, nil}
    Console.WriteLine(nint(rawElements[0]))
    Console.WriteLine(nint(rawElements[1]))
    Console.WriteLine(nint(rawElements[2]))
    Console.WriteLine(nint(fnElements[0]))
    Console.WriteLine(nint(fnElements[1]))
    Console.WriteLine(nint(fnElements[2]))

    var rawZeros = [2]*int32
    var fnZeros = [2]*func(int32) int32
    Console.WriteLine(nint(rawZeros[0]))
    Console.WriteLine(nint(rawZeros[1]))
    Console.WriteLine(nint(fnZeros[0]))
    Console.WriteLine(nint(fnZeros[1]))

    Console.WriteLine(refDefault() == nil)
    Console.WriteLine(nullableDefault() == nil)
    var point = pointDefault()
    Console.WriteLine(point.X)
    var delegateDefault () -> int32 = default(() -> int32)
    Console.WriteLine(delegateDefault == nil)
}`
        let (output, opcodes) = await CompileInspectAndRun(
            Source,
            "rawDefault",
            "fnDefault",
            "rawNil",
            "fnNil",
            "refDefault"
        )
        Assert.Equal(
            string.Concat(Enumerable.Repeat("0${Environment.NewLine}", 20)) +
                "True${Environment.NewLine}" +
                "True${Environment.NewLine}" +
                "0${Environment.NewLine}" +
                "True${Environment.NewLine}",
            output
        )
        let nativeZero = []uint8{uint8(ILOpCode.Ldc_i4_0), uint8(ILOpCode.Conv_i), uint8(ILOpCode.Ret)}
        Assert.Equal(nativeZero, opcodes["rawDefault"])
        Assert.Equal(nativeZero, opcodes["fnDefault"])
        Assert.Equal(nativeZero, opcodes["rawNil"])
        Assert.Equal(nativeZero, opcodes["fnNil"])
        Assert.Equal([]uint8{uint8(ILOpCode.Ldnull), uint8(ILOpCode.Ret)}, opcodes["refDefault"])
    }

    shared {
        private let UnsafeIlVerifyIgnored[]string = []string{
            "UnmanagedPointer",
            "StackUnexpected",
            "StackByRef",
            "ExpectedPtr",
            "StackUnexpectedArrayType"
        }

        private async func CompileInspectAndRun(source string, methods ...string)(
            Output string,
            OpCodes IReadOnlyDictionary[string, []uint8]
        ) {
            let outputDirectory = Path.Combine(AppContext.BaseDirectory, "issue3285", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(outputDirectory)
            try {
                let sourcePath = Path.Combine(outputDirectory, "Program.gs")
                let outputPath = Path.Combine(outputDirectory, "Issue3285.dll")
                File.WriteAllText(sourcePath, source)
                using let standardOut = StringWriter()
                using let standardError = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(standardOut)
                Console.SetError(standardError)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, (`gsc failed (exit ` + "$exitCode" + `):
stdout:
` + "$standardOut" + `
stderr:
` + "$standardError"))
                let opcodes = methods.ToDictionary(
                    func (method string) string {
                        return method
                    },
                    (method string) -> ReadMethodIl(outputPath, method)
                )
                IlVerifier.Verify(outputPath, nil, UnsafeIlVerifyIgnored)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = outputDirectory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(outputPath)
                using let process = Process.Start(startInfo) ??
                    throw InvalidOperationException("Failed to start dotnet exec.")
                let stdoutTask = process.StandardOutput.ReadToEndAsync()
                let stderrTask = process.StandardError.ReadToEndAsync()
                using let timeout = CancellationTokenSource(TimeSpan.FromSeconds(30))
                try {
                    await process.WaitForExitAsync(timeout.Token)
                } catch (OperationCanceledException) {
                    process.Kill(entireProcessTree: true)
                    Assert.Fail("dotnet exec timed out.")
                }
                let stdout = await stdoutTask
                let stderr = await stderrTask
                Assert.True(process.ExitCode == 0, (`sample exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return (stdout.ReplaceLineEndings(Environment.NewLine), opcodes)
            } finally {
                try {
                    Directory.Delete(outputDirectory, recursive: true)
                } catch { }
            }
        }

        private func ReadMethodIl(assemblyPath string, methodName string)[]uint8 {
            using let stream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(stream)
            let metadata = peReader.GetMetadataReader()
            for methodHandle in metadata.MethodDefinitions {
                let method = metadata.GetMethodDefinition(methodHandle)
                if metadata.GetString(method.Name) != methodName || method.RelativeVirtualAddress == 0 {
                    continue
                }
                return peReader.GetMethodBody(method.RelativeVirtualAddress).GetILBytes() ?? Array.Empty[uint8]()
            }
            throw InvalidOperationException("Method '$methodName' was not found in '$assemblyPath'.")
        }
    }
}
