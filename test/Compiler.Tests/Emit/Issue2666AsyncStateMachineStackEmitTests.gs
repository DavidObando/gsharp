// <copyright file="Issue2666AsyncStateMachineStackEmitTests.cs" company="GSharp">
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

/// Issue #2666: preserve constructed stack types in async state machines.
/// Cycle 7 reported `Task<object>` versus `Task<T0>` in
/// `ToolDispatcher.InvokeAsync.MoveNext`, and
/// `KeyValuePair<string, ConversionItemViewModel>` versus
/// `KeyValuePair<object, object>` in
/// `MainWindow.OnRunDownloadPipeline.MoveNext`.
open class Issue2666AsyncStateMachineStackEmitTests {
    @Fact
    func ExactToolDispatcherGenericAsyncDelegate_VerifiesAndRuns() {
        let source = `package Oahu.Cli.Server.Hosting

import System
import System.Collections.Generic
import System.Diagnostics
import System.Threading.Tasks

enum CapabilityClass { Read }
enum ServerTransport { Stdio, Http }

class CapabilityPolicy {
    prop Transport ServerTransport -> ServerTransport.Stdio
    func Require(toolName string, capability CapabilityClass, confirmed bool) {}
}

class AuditLog {
    func Write(transport string, principal string, toolName string, args IReadOnlyDictionary[string, object?]?, outcome string, latencyMs int64) {}
}

class ToolDispatcher(policy CapabilityPolicy, audit AuditLog) {
    async func InvokeAsync[T](toolName string, capability CapabilityClass, args IReadOnlyDictionary[string, object?]?, body async () -> T, confirmed bool = false, principal string = "stdio") T {
        let transport = if policy.Transport == ServerTransport.Http { "http" } else { "stdio" }
        let sw = Stopwatch.StartNew()
        try {
            policy.Require(toolName, capability, confirmed)
        } catch (ex UnauthorizedAccessException) {
            SafeAudit(transport!!, principal, toolName, args, "denied", sw!!.ElapsedMilliseconds)
            throw ex
        }
        try {
            let result = await body().ConfigureAwait(false)
            SafeAudit(transport!!, principal, toolName, args, "ok", sw!!.ElapsedMilliseconds)
            return result
        } catch (ex Exception) {
            SafeAudit(transport!!, principal, toolName, args, "error", sw!!.ElapsedMilliseconds)
            throw ex
        }
    }

    private func SafeAudit(transport string, principal string, toolName string, args IReadOnlyDictionary[string, object?]?, outcome string, latencyMs int64) {
        audit.Write(transport, principal, toolName, args, outcome, latencyMs)
    }
}

let dispatcher = ToolDispatcher(CapabilityPolicy(), AuditLog())
let result = dispatcher.InvokeAsync[int32]("probe", CapabilityClass.Read, nil, () -> Task.FromResult(42)).GetAwaiter().GetResult()
Console.WriteLine(result)`
        Assert.Equal("42${Environment.NewLine}", CompileVerifyAndRun(source))
    }

    @Fact
    func ExactOnRunDownloadPipelineCapturedDictionaryPair_VerifiesAndRuns() {
        const HelperSource = `namespace ImportedPipeline;

public sealed class ConversionItemViewModel
{
    public ConversionItemViewModel(string asin) => Asin = asin;
    public string Asin { get; }
}`
        let source = `package Oahu.App

import System
import System.Collections.Generic
import System.Linq
import System.Threading.Tasks
import ImportedPipeline

class MainWindow {
    async func OnRunDownloadPipeline(items IReadOnlyList[ConversionItemViewModel]) int32 {
        await Task.Yield()
        let lookup = items.ToDictionary((i ConversionItemViewModel) -> i.Asin)
        var matched = 0
        for kvp in lookup {
            let item = items.FirstOrDefault((i ConversionItemViewModel) -> i.Asin == kvp.Key)
            if item != nil {
                matched += 1
            }
        }
        return matched
    }
}

let items = List[ConversionItemViewModel]()
items.Add(ConversionItemViewModel("A"))
Console.WriteLine(MainWindow().OnRunDownloadPipeline(items).GetAwaiter().GetResult())`
        Assert.Equal("1${Environment.NewLine}", CompileVerifyAndRun(source, HelperSource))
    }

    shared {
        private func CompileVerifyAndRun(source string, helperSource string? = nil) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue2666_").FullName
            try {
                let helperPath string? = if helperSource == nil {
                    default(string?)
                } else {
                    BuildHelper(directory, helperSource)
                }
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                let arguments = List[string]{
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100"
                }
                if helperPath != nil {
                    arguments.Add("/reference:" + helperPath)
                }
                arguments.Add(sourcePath)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                var exitCode int32
                try {
                    exitCode = Program.Main(arguments.ToArray())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, (`compile failed (` + "$exitCode" + `):
` + "$stdout" + `
` + "$stderr"))
                IlVerifier.Verify(
                    outputPath,
                    if helperPath == nil {
                        default([]?string)
                    } else {
                        []string{helperPath}
                    }
                )
                File.WriteAllText(Path.ChangeExtension(outputPath, ".runtimeconfig.json"), `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add(outputPath)
                using let process Process? = Process.Start(startInfo)
                let output = process!!.StandardOutput.ReadToEnd()
                let error = process!!.StandardError.ReadToEnd()
                Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process!!.ExitCode == 0, (`exited ` + "${process!!.ExitCode}" + `:
` + "$error"))
                return output.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch (IOException) { }
            }
        }

        private func BuildHelper(directory string, source string) string {
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")))
                .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                .Where(File.Exists)
                .Select((path string) -> MetadataReference.CreateFromFile(path))
            let compilation = CSharpCompilation.Create(
                "ImportedPipeline",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let path = Path.Combine(directory, "ImportedPipeline.dll")
            using let stream = File.Create(path)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return path
        }
    }
}
