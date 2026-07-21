// <copyright file="Issue2666AsyncStateMachineStackEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2666: preserve constructed stack types in async state machines.
/// Cycle 7 reported <c>Task&lt;object&gt;</c> versus <c>Task&lt;T0&gt;</c> in
/// <c>ToolDispatcher.InvokeAsync.MoveNext</c>, and
/// <c>KeyValuePair&lt;string, ConversionItemViewModel&gt;</c> versus
/// <c>KeyValuePair&lt;object, object&gt;</c> in
/// <c>MainWindow.OnRunDownloadPipeline.MoveNext</c>.
/// </summary>
public class Issue2666AsyncStateMachineStackEmitTests
{
    [Fact]
    public void ExactToolDispatcherGenericAsyncDelegate_VerifiesAndRuns()
    {
        var source = """
            package Oahu.Cli.Server.Hosting

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
            Console.WriteLine(result)
            """;

        Assert.Equal("42\n", CompileVerifyAndRun(source));
    }

    [Fact]
    public void ExactOnRunDownloadPipelineCapturedDictionaryPair_VerifiesAndRuns()
    {
        const string HelperSource = """
            namespace ImportedPipeline;

            public sealed class ConversionItemViewModel
            {
                public ConversionItemViewModel(string asin) => Asin = asin;
                public string Asin { get; }
            }
            """;
        var source = """
            package Oahu.App

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
            Console.WriteLine(MainWindow().OnRunDownloadPipeline(items).GetAwaiter().GetResult())
            """;

        Assert.Equal("1\n", CompileVerifyAndRun(source, HelperSource));
    }

    private static string CompileVerifyAndRun(string source, string helperSource = null)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2666_").FullName;
        try
        {
            var helperPath = helperSource == null ? null : BuildHelper(directory, helperSource);
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            var arguments = new List<string>
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };
            if (helperPath != null)
            {
                arguments.Add("/reference:" + helperPath);
            }

            arguments.Add(sourcePath);
            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            int exitCode;
            try
            {
                exitCode = Program.Main(arguments.ToArray());
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(exitCode == 0, $"compile failed ({exitCode}):\n{stdout}\n{stderr}");
            IlVerifier.Verify(outputPath, helperPath == null ? null : new[] { helperPath });

            File.WriteAllText(Path.ChangeExtension(outputPath, ".runtimeconfig.json"), """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);
            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add(outputPath);

            using var process = Process.Start(startInfo);
            var output = process.StandardOutput.ReadToEnd();
            var error = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}:\n{error}");
            return output.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }

    private static string BuildHelper(string directory, string source)
    {
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Where(File.Exists)
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "ImportedPipeline",
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var path = Path.Combine(directory, "ImportedPipeline.dll");
        using var stream = File.Create(path);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return path;
    }
}
