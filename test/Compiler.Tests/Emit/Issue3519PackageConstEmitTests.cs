// <copyright file="Issue3519PackageConstEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #3519: package constants remain constants across source files and emitted bodies.</summary>
public sealed class Issue3519PackageConstEmitTests
{
    [Fact]
    public void PackageConst_FromAnotherSourceFile_EmitsLiteralAndProcessExitsZero()
    {
        using var program = Compile(
            ("Main.gs", """
                package FindingPackageConstZero

                import System

                func Check() int32 { return Expected == 42 ? 0 : 1 }

                Environment.Exit(Check())
                """),
            ("Value.gs", """
                package FindingPackageConstZero

                const Expected int32 = 42
                """));

        var run = Run(program.OutputPath);
        Assert.True(
            run.ExitCode == 0,
            $"program exited {run.ExitCode}\nstdout:\n{run.StandardOutput}\nstderr:\n{run.StandardError}");

        var assembly = program.Load();
        var container = assembly.GetTypes().Single(type => type.Name == "<Program>");
        var expected = container.GetField("Expected", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(expected);
        Assert.True(expected!.IsLiteral);
        Assert.Equal(42, expected.GetRawConstantValue());

        var check = container.GetMethod("Check", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(check);
        var instructions = IlInstructionReader.Read(check!.GetMethodBody()!.GetILAsByteArray()!);
        Assert.DoesNotContain(instructions, instruction => instruction.OpCode == OpCodes.Ldsfld);
    }

    [Fact]
    public void PackageConsts_FromAnotherSourceFile_InlineAcrossFunctionAndLambdaBodies()
    {
        using var program = Compile(
            ("Reader.gs", """
                package FindingPackageConstSiblings

                func CheckSibling() int32 {
                    let read = func() string { return Greeting }
                    return Answer == 42 && Answer.ToString() == "42" && Enabled && read() == "ready" ? 0 : 1
                }
                """),
            ("Values.gs", """
                package FindingPackageConstSiblings

                const Answer int32 = 42
                const Enabled bool = true
                const Greeting string = "ready"
                """));

        var assembly = program.Load();
        var container = assembly.GetTypes().Single(type => type.Name == "<Program>");
        var check = container.GetMethod("CheckSibling", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(check);
        Assert.Equal(0, check!.Invoke(null, null));

        Assert.Equal(42, GetLiteral(container, "Answer").GetRawConstantValue());
        Assert.Equal(true, GetLiteral(container, "Enabled").GetRawConstantValue());
        Assert.Equal("ready", GetLiteral(container, "Greeting").GetRawConstantValue());
    }

    private static FieldInfo GetLiteral(Type container, string name)
    {
        var field = container.GetField(name, BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(field);
        Assert.True(field!.IsLiteral);
        return field;
    }

    private static CompiledProgram Compile(params (string FileName, string Source)[] sources)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue3519-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        try
        {
            var sourcePaths = new List<string>(sources.Length);
            foreach (var source in sources)
            {
                var path = Path.Combine(directory, source.FileName);
                File.WriteAllText(path, source.Source);
                sourcePaths.Add(path);
            }

            var outputPath = Path.Combine(directory, "Issue3519.dll");
            var arguments = new List<string>
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
            };
            arguments.AddRange(sourcePaths);

            var exitCode = Program.Main(arguments.ToArray());
            Assert.Equal(0, exitCode);
            Assert.True(File.Exists(outputPath));
            IlVerifier.Verify(outputPath);
            return new CompiledProgram(directory, outputPath);
        }
        catch
        {
            Directory.Delete(directory, recursive: true);
            throw;
        }
    }

    private static ProcessResult Run(string outputPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(outputPath)!,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(outputPath);

        using var process = Process.Start(startInfo)!;
        var standardOutput = process.StandardOutput.ReadToEnd();
        var standardError = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
        return new ProcessResult(process.ExitCode, standardOutput, standardError);
    }

    private sealed record ProcessResult(int ExitCode, string StandardOutput, string StandardError);

    private sealed class CompiledProgram : IDisposable
    {
        public CompiledProgram(string directory, string outputPath)
        {
            Directory = directory;
            OutputPath = outputPath;
        }

        public string Directory { get; }

        public string OutputPath { get; }

        public Assembly Load() => Assembly.Load(File.ReadAllBytes(OutputPath));

        public void Dispose()
        {
            try
            {
                System.IO.Directory.Delete(Directory, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
