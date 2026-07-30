// <copyright file="Issue2875DataClassSettableInterfaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2875: an init-only positional data member cannot implement an
/// interface property that requires an ordinary setter.
/// </summary>
public class Issue2875DataClassSettableInterfaceTests
{
    [Fact]
    public void PositionalDataClassMember_SettableInterfaceProperty_ReportsGS0502AndDoesNotEmit()
    {
        const string source = """
            package S1

            interface IBox {
                prop Value int32 { get; set; }
            }

            data class Box(Value int32) : IBox
            """;

        var output = CompileExpectingFailure(source);

        Assert.Contains("GS0502", output, StringComparison.Ordinal);
        Assert.Contains(
            "Type 'Box' cannot use positional member 'Value' to implement settable interface property 'IBox.Value' because the member is init-only; declare property 'Value' explicitly with a 'set' accessor.",
            output,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ExplicitSettableProperty_StillVerifiesAndRuns()
    {
        const string source = """
            package S2
            import System

            interface IBox2 {
                prop Value int32 { get; set; }
            }

            data class Box2 : IBox2 {
                prop Value int32 { get; set; }
            }

            func Main() {
                let box IBox2 = Box2()
                box.Value = 7
                Console.WriteLine(box.Value)
            }
            """;

        Assert.Equal("7\n", CompileVerifyAndRun(source));
    }

    [Fact]
    public void PositionalDataClassMember_GetOnlyInterfaceProperty_StillVerifiesAndRuns()
    {
        const string source = """
            package S3
            import System

            interface IBox3 {
                prop Value int32 { get; }
            }

            data class Box3(Value int32) : IBox3

            func Main() {
                let box IBox3 = Box3(11)
                Console.WriteLine(box.Value)
            }
            """;

        Assert.Equal("11\n", CompileVerifyAndRun(source));
    }

    [Fact]
    public void PositionalDataStructMember_SettableInterfaceProperty_ReportsGS0502AndDoesNotEmit()
    {
        const string source = """
            package S4

            interface IBox4 {
                prop Value int32 { get; set; }
            }

            data struct Box4(Value int32) : IBox4
            """;

        var output = CompileExpectingFailure(source);

        Assert.Contains("GS0502", output, StringComparison.Ordinal);
        Assert.Contains("positional member 'Value'", output, StringComparison.Ordinal);
        Assert.Contains("IBox4.Value", output, StringComparison.Ordinal);
    }

    private static string CompileExpectingFailure(string source)
    {
        var directory = CreateWorkDirectory();
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            var (exitCode, output) = Compile(
                "/out:" + outputPath,
                "/target:library",
                "/targetframework:net10.0",
                sourcePath);

            Assert.NotEqual(0, exitCode);
            Assert.False(File.Exists(outputPath), "gsc must not emit an assembly after GS0502");
            return output;
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string CompileVerifyAndRun(string source)
    {
        var directory = CreateWorkDirectory();
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            var (exitCode, output) = Compile(
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath);

            Assert.True(exitCode == 0, "gsc failed:\n" + output);
            IlVerifier.Verify(outputPath);

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add(outputPath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start emitted program.");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "Emitted program timed out.");
            Assert.True(process.ExitCode == 0, $"Program exited {process.ExitCode}:\n{stderr}");
            return stdout.Replace("\r\n", "\n", StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static (int ExitCode, string Output) Compile(params string[] arguments)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(arguments);
            return (exitCode, stdout.ToString() + stderr);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string CreateWorkDirectory()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue2875",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }
}
