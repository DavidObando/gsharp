// <copyright file="Issue2601GenericAsyncResultsEmitTests.cs" company="GSharp">
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
/// Issue #2601: generic async-enumerable elements and imported
/// <c>Task&lt;T&gt;</c> results must survive binding and emission.
/// </summary>
public class Issue2601GenericAsyncResultsEmitTests
{
    [Fact]
    public void AwaitFor_ConfiguredAsyncEnumerable_UserElement_Runs()
    {
        var source = """
            package P
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

            Run().Wait()
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void Await_ImportedGenericInstanceTaskOfNullable_Runs()
    {
        const string HelperSource = """
            using System.Threading.Tasks;

            namespace ImportedAsync;

            public class Dialog
            {
                public Task<T> ShowDialog<T>(object owner) =>
                    Task.FromResult((T)(object)(bool?)true);
            }
            """;
        var source = """
            package P
            import System
            import ImportedAsync

            class Wizard : Dialog {
                init() {}

                async func Run() {
                    let result = await ShowDialog[bool?]("owner")
                    Console.WriteLine(result == true)
                }
            }

            Wizard().Run().Wait()
            """;

        Assert.Equal("True\n", CompileAndRun(source, HelperSource));
    }

    [Fact]
    public void Await_NonGenericTask_StillCannotInitializeValue()
    {
        var diagnostics = CompileForDiagnostics("""
            import System.Threading.Tasks

            async func Run() {
                let result = await Task.CompletedTask
            }
            """);

        Assert.Contains("GS0124", diagnostics);
    }

    [Fact]
    public void AwaitFor_GenericNonEnumerable_StillDiagnoses()
    {
        var diagnostics = CompileForDiagnostics("""
            import System.Threading.Tasks

            async func Run() {
                await for value in Task.FromResult[int32](1) {
                }
            }
            """);

        Assert.Contains("GS0134", diagnostics);
    }

    private static string CompileAndRun(string source, string helperSource = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2601_").FullName;
        try
        {
            var helperPath = helperSource == null
                ? null
                : BuildHelper(tempDir, helperSource);
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = CompilerArguments(srcPath, outPath, helperPath);
            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var previousOut = Console.Out;
            var previousErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int exitCode;
            try
            {
                exitCode = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousErr);
            }

            Assert.True(exitCode == 0, $"compile failed:\n{compileOut}\n{compileErr}");
            IlVerifier.Verify(
                outPath,
                helperPath == null ? null : new[] { helperPath },
                helperPath == null ? new[] { "StackUnexpected" } : null);

            var process = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            process.ArgumentList.Add("exec");
            process.ArgumentList.Add("--runtimeconfig");
            process.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            process.ArgumentList.Add(outPath);

            using var child = Process.Start(process);
            var stdout = child.StandardOutput.ReadToEnd();
            var stderr = child.StandardError.ReadToEnd();
            Assert.True(child.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(child.ExitCode == 0, $"exited {child.ExitCode}\n{stderr}");
            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }

    private static string CompileForDiagnostics(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2601_negative_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousErr = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            int exitCode;
            try
            {
                exitCode = Program.Main(CompilerArguments(srcPath, outPath, helperPath: null).ToArray());
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousErr);
            }

            Assert.NotEqual(0, exitCode);
            return stdout.ToString() + stderr;
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }

    private static List<string> CompilerArguments(string sourcePath, string outputPath, string helperPath)
    {
        var args = new List<string>
        {
            "/out:" + outputPath,
            "/target:exe",
            "/targetframework:net10.0",
        };
        if (helperPath != null)
        {
            args.Add("/r:" + helperPath);
        }

        args.Add(sourcePath);
        return args;
    }

    private static string BuildHelper(string directory, string source)
    {
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Where(File.Exists)
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "ImportedAsync",
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var path = Path.Combine(directory, "ImportedAsync.dll");
        using var stream = File.Create(path);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return path;
    }
}
