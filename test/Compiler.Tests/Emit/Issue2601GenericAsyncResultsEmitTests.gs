// <copyright file="Issue2601GenericAsyncResultsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #2601: generic async-enumerable elements and imported
/// `Task<T>` results must survive binding and emission.
open class Issue2601GenericAsyncResultsEmitTests {
    @Fact
    func AwaitFor_ConfiguredAsyncEnumerable_UserElement_Runs() {
        let source = `package P
import System
import System.Collections.Generic
import System.Threading.Tasks

class JobUpdate { var Value int32 = 0 }

async func Updates() IAsyncEnumerable[JobUpdate] {
    var update = JobUpdate()
    update.Value = 7
    yield update
}

async func Run() {
    await for update in Updates().ConfigureAwait(false) {
        Console.WriteLine(update.Value)
    }
}

Run().Wait()`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Await_ImportedGenericInstanceTaskOfNullable_Runs() {
        const HelperSource = `using System.Threading.Tasks;

namespace ImportedAsync;

public class Dialog
{
    public Task<T> ShowDialog<T>(object owner) =>
        Task.FromResult((T)(object)(bool?)true);
}`
        let source = `package P
import System
import ImportedAsync

class Wizard : Dialog {
    init() {}

    async func Run() {
        let result = await ShowDialog[bool?]("owner")
        Console.WriteLine(result == true)
    }
}

Wizard().Run().Wait()`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(source, HelperSource))
    }

    @Fact
    func Await_NonGenericTask_StillCannotInitializeValue() {
        let diagnostics = CompileForDiagnostics(`import System.Threading.Tasks

async func Run() {
    let result = await Task.CompletedTask
}`)
        Assert.Contains("GS0124", diagnostics)
    }

    @Fact
    func AwaitFor_GenericNonEnumerable_StillDiagnoses() {
        let diagnostics = CompileForDiagnostics(`import System.Threading.Tasks

async func Run() {
    await for value in Task.FromResult[int32](1) {
    }
}`)
        Assert.Contains("GS0134", diagnostics)
    }

    shared {
        private func CompileAndRun(source string, helperSource string? = nil) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2601_").FullName
            try {
                let helperPath string? = if helperSource == nil {
                    default(string?)
                } else {
                    BuildHelper(tempDir, helperSource)
                }
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = CompilerArguments(srcPath, outPath, helperPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let previousOut = Console.Out
                let previousErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var exitCode int32
                try {
                    exitCode = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousErr)
                }
                Assert.True(exitCode == 0, (`compile failed:
` + "$compileOut" + `
` + "$compileErr"))
                IlVerifier.Verify(
                    outPath,
                    if helperPath == nil {
                        default([]?string)
                    } else {
                        []string{helperPath}
                    },
                    if helperPath == nil {
                        []string{"StackUnexpected"}
                    } else {
                        default([]?string)
                    }
                )
                let process = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                process.ArgumentList.Add("exec")
                process.ArgumentList.Add("--runtimeconfig")
                process.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                process.ArgumentList.Add(outPath)
                using let child Process? = Process.Start(process)
                let stdout = child!!.StandardOutput.ReadToEnd()
                let stderr = child!!.StandardError.ReadToEnd()
                Assert.True(child!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(child!!.ExitCode == 0, (`exited ` + "${child!!.ExitCode}" + `
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { }
            }
        }

        private func CompileForDiagnostics(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2601_negative_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousErr = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                var exitCode int32
                try {
                    exitCode = Program.Main(CompilerArguments(srcPath, outPath, helperPath: nil).ToArray())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousErr)
                }
                Assert.NotEqual(0, exitCode)
                return stdout.ToString() + stderr.ToString()
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { }
            }
        }

        private func CompilerArguments(sourcePath string, outputPath string, helperPath string?) List[string] {
            let args = List[string]{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0"}
            if helperPath != nil {
                args.Add("/r:" + helperPath)
            }
            args.Add(sourcePath)
            return args
        }

        private func BuildHelper(directory string, source string) string {
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")))
                .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                .Where(File.Exists)
                .Select((path string) -> MetadataReference.CreateFromFile(path))
            let compilation = CSharpCompilation.Create(
                "ImportedAsync",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let path = Path.Combine(directory, "ImportedAsync.dll")
            using let stream = File.Create(path)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return path
        }
    }
}
