// <copyright file="Issue2613StaticDelegateMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue2613StaticDelegateMemberEmitTests
{
    private const string Source = """
        package Issue2613
        import System

        type Transform = delegate func(value int32) int32

        class Callbacks {
            shared {
                var Field (int32) -> int32 = (value int32) -> value + 1
                private var propertyValue (int32) -> int32 = (value int32) -> value + 2
                prop Property (int32) -> int32 {
                    get -> propertyValue
                    set { propertyValue = value }
                }
                var Named Transform = (value int32) -> value + 3
            }
        }

        func Main() {
            Callbacks.Field = (value int32) -> value + 10
            Callbacks.Property = (value int32) -> value + 20
            Callbacks.Named = (value int32) -> value + 30
            let copy = Callbacks.Field
            Console.WriteLine(copy(2))
            Console.WriteLine(Callbacks.Field(2))
            Console.WriteLine(Callbacks.Property(2))
            Console.WriteLine(Callbacks.Named(2))
        }
        """;

    [Fact]
    public void StaticDelegateMembers_AssignReadAndInvoke_CompileWithoutLookupDiagnostics()
    {
        var (exitCode, diagnostics, _, directory) = Compile(
            Source.Replace("Issue2613", "Issue2613Compile", StringComparison.Ordinal));
        try
        {
            Assert.True(exitCode == 0, diagnostics);
            Assert.DoesNotContain("GS0158", diagnostics, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0159", diagnostics, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void StaticDelegateMembers_AssignReadAndInvoke_Run()
    {
        var (exitCode, diagnostics, assembly, directory) = Compile(
            Source.Replace("Issue2613", "Issue2613Runtime", StringComparison.Ordinal));
        try
        {
            Assert.True(exitCode == 0, diagnostics);
            IlVerifier.Verify(assembly);

            File.WriteAllText(Path.ChangeExtension(assembly, "runtimeconfig.json"), """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var startInfo = new ProcessStartInfo("dotnet", "exec \"" + assembly + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var process = Process.Start(startInfo)!;
            string output = process.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            process.WaitForExit();

            Assert.True(process.ExitCode == 0, error);
            Assert.Equal("12\n12\n22\n32\n", output.Replace("\r\n", "\n"));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static (int ExitCode, string Diagnostics, string Assembly, string Directory) Compile(string source)
    {
        string directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2613",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        string sourcePath = Path.Combine(directory, "test.gs");
        string assemblyPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        TextWriter previousOut = Console.Out;
        TextWriter previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            int exitCode = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
            return (exitCode, stdout.ToString() + stderr.ToString(), assemblyPath, directory);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }
}
