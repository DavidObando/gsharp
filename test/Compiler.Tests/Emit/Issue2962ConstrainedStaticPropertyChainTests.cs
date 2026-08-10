// <copyright file="Issue2962ConstrainedStaticPropertyChainTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using Xunit;
using Xunit.Sdk;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2962: constrained static-virtual property reads remain valid receivers
/// for every supported member-chain suffix.
/// </summary>
public class Issue2962ConstrainedStaticPropertyChainTests
{
    [Fact]
    public void ChainedAccesses_LoadAndExecute()
    {
        const string Source = """
            package Issue2962.Chains
            import System

            sealed interface IValue[T] {
                shared { prop V T { get; } }
            }

            struct TextProvider : IValue[string] {
                shared { prop V string -> "value" }
            }

            struct ControlProvider : IValue[string] {
                shared { prop V string -> "broken" }
            }

            struct FieldHolder {
                var Field string
            }

            struct FieldProvider : IValue[FieldHolder] {
                shared { prop V FieldHolder -> FieldHolder{ Field: "value" } }
            }

            struct Leaf {
                prop X string -> "value"
            }

            struct Middle {
                prop W Leaf -> Leaf{}
            }

            struct NestedProvider : IValue[Middle] {
                shared { prop V Middle -> Middle{} }
            }

            struct Box[T] {
                var Item T
            }

            struct GenericProvider : IValue[Box[string]] {
                shared { prop V Box[string] -> Box[string]{ Item: "value" } }
            }

            sealed interface INullable[T] {
                shared { prop V T? { get; } }
            }

            struct NullableProvider : INullable[string] {
                shared { prop V string -> "value" }
            }

            func ReadValue[T IValue[string]](w T) string { return T.V }
            func ReadLength[T IValue[string]](w T) int32 { return T.V.Length }
            func ReadMethod[T IValue[string]](w T) string { return T.V.ToUpper() }
            func ReadIndex[T IValue[string]](w T) char { return T.V[0] }
            func ReadField[T IValue[FieldHolder]](w T) string { return T.V.Field }
            func ReadNested[T IValue[Middle]](w T) string { return T.V.W.X }
            func ReadGeneric[T IValue[Box[string]]](w T) int32 { return T.V.Item.Length }
            func ReadNullable[T INullable[string]](w T) int32? { return T.V?.Length }
            func ReadNullableIndex[T INullable[string]](w T) char? { return T.V?[0] }

            func Main() {
                Console.WriteLine(ReadValue(TextProvider{}))
                Console.WriteLine(ReadLength(TextProvider{}))
                Console.WriteLine(ReadMethod(TextProvider{}))
                Console.WriteLine(ReadIndex(TextProvider{}))
                Console.WriteLine(ReadField(FieldProvider{}))
                Console.WriteLine(ReadNested(NestedProvider{}))
                Console.WriteLine(ReadGeneric(GenericProvider{}))
                Console.WriteLine(ReadNullable(NullableProvider{}))
                Console.WriteLine(ReadNullableIndex(NullableProvider{}))
                Console.WriteLine(ReadValue(ControlProvider{}))
                Console.WriteLine(ReadLength(ControlProvider{}))
            }
            """;
        const string Expected = """
            value
            5
            VALUE
            v
            value
            value
            5
            5
            v
            broken
            6

            """;

        var directory = CreateWorkDirectory();
        try
        {
            var assemblyPath = CompileSource(Source, directory, "Issue2962Chains.dll", target: "exe");
            _ = Assembly.Load(File.ReadAllBytes(assemblyPath)).GetTypes();
            Assert.Equal(Expected, RunChild(assemblyPath, directory));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void NullableDirectChain_ReportsMemberDiagnosticInsteadOfIce()
    {
        const string Source = """
            package Issue2962.Nullable

            sealed interface I[T] {
                shared { prop V T? { get; } }
            }

            struct C : I[string] {
                shared { prop V string -> "value" }
            }

            func Read[T I[string]](w T) int32 {
                return T.V.Length
            }
            """;

        var directory = CreateWorkDirectory();
        try
        {
            var sourcePath = Path.Combine(directory, "Issue2962Nullable.gs");
            var outputPath = Path.Combine(directory, "Issue2962Nullable.dll");
            File.WriteAllText(sourcePath, Source);

            var (exitCode, output) = Compile(
                "/out:" + outputPath,
                "/target:library",
                "/targetframework:net10.0",
                sourcePath);

            Assert.Equal(1, exitCode);
            Assert.Contains("error GS0158: Cannot find member Length.", output, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void NullablePropertyRead_RejectsAssignmentToNonNullableSlot()
    {
        const string Source = """
            package Issue2962.NullableAssignment

            sealed interface I[T] {
                shared { prop V T? { get; } }
            }

            struct C : I[string] {
                shared { prop V string -> "value" }
            }

            func Read[T I[string]](w T) string {
                let value string = T.V
                return value
            }
            """;

        var directory = CreateWorkDirectory();
        try
        {
            var sourcePath = Path.Combine(directory, "Issue2962NullableAssignment.gs");
            var outputPath = Path.Combine(directory, "Issue2962NullableAssignment.dll");
            File.WriteAllText(sourcePath, Source);

            var (exitCode, output) = Compile(
                "/out:" + outputPath,
                "/target:library",
                "/targetframework:net10.0",
                sourcePath);

            Assert.Equal(1, exitCode);

            // #3296 retired the legacy any-to-string conversion arm and
            // re-anchored the string? -> string rejection to GS0155 (the
            // #1627 Kotlin-model nullability rule); same message, new id.
            Assert.Contains("error GS0155: Cannot convert type 'string?' to 'string'.", output, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void NonMemberStaticSuffix_ReportsSourceTextInsteadOfIce()
    {
        const string Source = """
            package Issue2962.InvalidSuffix

            sealed interface I[T] {
                shared { prop V T { get; } }
            }

            struct C : I[string] {
                shared { prop V string -> "value" }
            }

            func Read[T I[string]](w T) int32 {
                return T.sizeof(int32)
            }

            func Main() {
                Read(C{})
            }
            """;

        var directory = CreateWorkDirectory();
        try
        {
            var sourcePath = Path.Combine(directory, "Issue2962InvalidSuffix.gs");
            var outputPath = Path.Combine(directory, "Issue2962InvalidSuffix.dll");
            File.WriteAllText(sourcePath, Source);

            var (exitCode, output) = Compile(
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath);

            Assert.Equal(1, exitCode);
            Assert.Contains(
                "error GS0333: Constrained static access 'sizeof(int32)' on type parameter 'T' must name a static-virtual member declared by an interface constraint (ADR-0089).",
                output,
                StringComparison.Ordinal);
            Assert.DoesNotContain("GS9999", output, StringComparison.Ordinal);
            Assert.DoesNotContain("member '?'", output, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string CompileSource(string source, string directory, string outputName, string target)
    {
        var sourcePath = Path.Combine(directory, Path.GetFileNameWithoutExtension(outputName) + ".gs");
        var outputPath = Path.Combine(directory, outputName);
        File.WriteAllText(sourcePath, source);

        var (exitCode, output) = Compile(
            "/out:" + outputPath,
            "/target:" + target,
            "/targetframework:net10.0",
            sourcePath);
        Assert.True(exitCode == 0, "gsc failed:\n" + output);
        return outputPath;
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
            return (exitCode, stdout.ToString() + stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string RunChild(string assemblyPath, string workingDirectory)
    {
        var runtimeConfig = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json");
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = workingDirectory,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(runtimeConfig);
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet child process.");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
            var timedOutStdout = stdoutTask.GetAwaiter().GetResult();
            var timedOutStderr = stderrTask.GetAwaiter().GetResult();
            throw new XunitException(
                $"dotnet child timed out.\nstdout:\n{timedOutStdout}\nstderr:\n{timedOutStderr}");
        }

        var stdout = stdoutTask.GetAwaiter().GetResult();
        var stderr = stderrTask.GetAwaiter().GetResult();
        Assert.True(
            process.ExitCode == 0,
            $"dotnet child exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.ReplaceLineEndings(Environment.NewLine);
    }

    private static string CreateWorkDirectory()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue2962-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }
}
