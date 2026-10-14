// <copyright file="Issue3421GenericInterfaceCastEmitTests.cs" company="GSharp">
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
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #3421: an unconstrained generic explicit cast to an interface emits
/// `box T; castclass I`. Constraint-proven implicit conversions stay
/// box-only.
class Issue3421GenericInterfaceCastEmitTests {
    @Fact
    async func GenericInterfaceCast_CompilesVerifiesAndPreservesRuntimeChecks() {
        const source = `import System

interface IValue3421 {
    func Read() int32;
}

struct CompatibleValue3421 : IValue3421 {
    func Read() int32 -> 7
}

struct IncompatibleValue3421 {}
class IncompatibleReference3421 {}

func CheckedCast3421[T](value T) IValue3421 -> cast[IValue3421](value)
func ImplicitCast3421[T IValue3421](value T) IValue3421 -> value

Console.WriteLine(CheckedCast3421[CompatibleValue3421](CompatibleValue3421{}).Read())

try {
    CheckedCast3421[IncompatibleReference3421](IncompatibleReference3421())
    Console.WriteLine("missing reference failure")
} catch (e InvalidCastException) {
    Console.WriteLine("reference failure")
}

try {
    CheckedCast3421[IncompatibleValue3421](IncompatibleValue3421{})
    Console.WriteLine("missing value failure")
} catch (e InvalidCastException) {
    Console.WriteLine("value failure")
}

Console.WriteLine(ImplicitCast3421[CompatibleValue3421](CompatibleValue3421{}).Read())`
        let result = await CompileInspectAndRun(source, "CheckedCast3421", "ImplicitCast3421")
        Assert.Equal(
            string.Join(Environment.NewLine, "7", "reference failure", "value failure", "7") + Environment.NewLine,
            result.Output
        )
        let checkedInstructions = IlInstructionReader.Read(result.MethodIl["CheckedCast3421"])
        Assert.Contains(checkedInstructions, (instruction IlInstruction) -> instruction.OpCode == OpCodes.Box)
        Assert.Contains(checkedInstructions, (instruction IlInstruction) -> instruction.OpCode == OpCodes.Castclass)
        let implicitInstructions = IlInstructionReader.Read(result.MethodIl["ImplicitCast3421"])
        Assert.Contains(implicitInstructions, (instruction IlInstruction) -> instruction.OpCode == OpCodes.Box)
        Assert.DoesNotContain(
            implicitInstructions,
            (instruction IlInstruction) -> instruction.OpCode == OpCodes.Castclass
        )
    }

    shared {
        private async func CompileInspectAndRun(source string, methods ...string)(
            Output string,
            MethodIl IReadOnlyDictionary[string, []uint8]
        ) {
            let outputDirectory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3421GenericInterfaceCastEmitTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(outputDirectory)
            try {
                let sourcePath = Path.Combine(outputDirectory, "Program.gs")
                let outputPath = Path.Combine(outputDirectory, "Issue3421.dll")
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
                let methodIl = methods.ToDictionary(
                    func (method string) string {
                        return method
                    },
                    (method string) -> ReadMethodIl(outputPath, method)
                )
                IlVerifier.Verify(outputPath)
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
                return (stdout.ReplaceLineEndings(Environment.NewLine), methodIl)
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
