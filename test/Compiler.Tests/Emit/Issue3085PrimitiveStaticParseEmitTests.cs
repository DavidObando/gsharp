// <copyright file="Issue3085PrimitiveStaticParseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3085: canonical primitive type receivers bind imported CLR static
/// methods, and an already-invalid argument does not add a misleading call
/// resolution diagnostic.
/// </summary>
public class Issue3085PrimitiveStaticParseEmitTests
{
    [Fact]
    public void Int32Parse_CanonicalReceiver_CompilesAndRuns()
    {
        const string source = """
            package Issue3085
            import System

            Console.WriteLine(int32.Parse("314159"))
            """;

        var compilation = Compile(source, executable: true);
        try
        {
            Assert.True(compilation.ExitCode == 0, compilation.Output);
            IlVerifier.Verify(compilation.AssemblyPath);
            Assert.Equal($"314159{Environment.NewLine}", Run(compilation.AssemblyPath, compilation.WorkDirectory));
        }
        finally
        {
            DeleteDirectory(compilation.WorkDirectory);
        }
    }

    [Fact]
    public void InvalidStaticCallArgument_DoesNotCascadeCannotFindFunction()
    {
        const string source = """
            package Issue3085

            class Host {
                shared {
                    func Run() int32 {
                        return int32.Parse(Host.Missing)
                    }
                }
            }
            """;

        var compilation = Compile(source, executable: false);
        try
        {
            Assert.NotEqual(0, compilation.ExitCode);
            Assert.Contains("GS0158", compilation.Output, StringComparison.Ordinal);
            Assert.DoesNotContain("Cannot find function Parse", compilation.Output, StringComparison.Ordinal);
        }
        finally
        {
            DeleteDirectory(compilation.WorkDirectory);
        }
    }

    private static (string WorkDirectory, string AssemblyPath, int ExitCode, string Output) Compile(
        string source,
        bool executable)
    {
        string workDirectory = Path.Combine(
            AppContext.BaseDirectory,
            "issue3085",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDirectory);

        string sourcePath = Path.Combine(workDirectory, "test.gs");
        string assemblyPath = Path.Combine(workDirectory, "test.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        TextWriter previousOut = Console.Out;
        TextWriter previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                executable ? "/target:exe" : "/target:library",
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        return (workDirectory, assemblyPath, exitCode, stdout.ToString() + stderr.ToString());
    }

    private static string Run(string assemblyPath, string workDirectory)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workDirectory,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(assemblyPath);

        using Process process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start compiled program.");
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "Compiled program timed out.");
        Assert.True(process.ExitCode == 0, $"Program exited {process.ExitCode}:\n{stderr}");
        return stdout.ReplaceLineEndings(Environment.NewLine);
    }

    private static void DeleteDirectory(string path)
    {
        try
        {
            Directory.Delete(path, recursive: true);
        }
        catch
        {
        }
    }
}
