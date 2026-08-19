// <copyright file="Issue3421GenericInterfaceCastEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3421: an unconstrained generic explicit cast to an interface emits
/// <c>box T; castclass I</c>. Constraint-proven implicit conversions stay
/// box-only.
/// </summary>
public sealed class Issue3421GenericInterfaceCastEmitTests
{
    [Fact]
    public async Task GenericInterfaceCast_CompilesVerifiesAndPreservesRuntimeChecks()
    {
        const string source = """
            import System

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

            Console.WriteLine(ImplicitCast3421[CompatibleValue3421](CompatibleValue3421{}).Read())
            """;

        var result = await CompileInspectAndRun(
            source,
            "CheckedCast3421",
            "ImplicitCast3421");

        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "7",
                "reference failure",
                "value failure",
                "7") + Environment.NewLine,
            result.Output);

        var checkedInstructions = IlInstructionReader.Read(result.MethodIl["CheckedCast3421"]);
        Assert.Contains(checkedInstructions, instruction => instruction.OpCode == OpCodes.Box);
        Assert.Contains(checkedInstructions, instruction => instruction.OpCode == OpCodes.Castclass);

        var implicitInstructions = IlInstructionReader.Read(result.MethodIl["ImplicitCast3421"]);
        Assert.Contains(implicitInstructions, instruction => instruction.OpCode == OpCodes.Box);
        Assert.DoesNotContain(implicitInstructions, instruction => instruction.OpCode == OpCodes.Castclass);
    }

    private static async Task<(string Output, IReadOnlyDictionary<string, byte[]> MethodIl)> CompileInspectAndRun(
        string source,
        params string[] methods)
    {
        string outputDirectory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3421GenericInterfaceCastEmitTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        try
        {
            string sourcePath = Path.Combine(outputDirectory, "Program.gs");
            string outputPath = Path.Combine(outputDirectory, "Issue3421.dll");
            File.WriteAllText(sourcePath, source);

            using var standardOut = new StringWriter();
            using var standardError = new StringWriter();
            TextWriter previousOut = Console.Out;
            TextWriter previousError = Console.Error;
            Console.SetOut(standardOut);
            Console.SetError(standardError);
            int exitCode;
            try
            {
                exitCode = Program.Main(new[]
                {
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(
                exitCode == 0,
                $"gsc failed (exit {exitCode}):\nstdout:\n{standardOut}\nstderr:\n{standardError}");

            var methodIl = methods.ToDictionary(
                method => method,
                method => ReadMethodIl(outputPath, method));

            IlVerifier.Verify(outputPath);

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = outputDirectory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"));
            startInfo.ArgumentList.Add(outputPath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
            Task<string> stderrTask = process.StandardError.ReadToEndAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                process.Kill(entireProcessTree: true);
                Assert.Fail("dotnet exec timed out.");
            }

            string stdout = await stdoutTask;
            string stderr = await stderrTask;
            Assert.True(
                process.ExitCode == 0,
                $"sample exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return (stdout.ReplaceLineEndings(Environment.NewLine), methodIl);
        }
        finally
        {
            try
            {
                Directory.Delete(outputDirectory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static byte[] ReadMethodIl(string assemblyPath, string methodName)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        MetadataReader metadata = peReader.GetMetadataReader();
        foreach (MethodDefinitionHandle methodHandle in metadata.MethodDefinitions)
        {
            MethodDefinition method = metadata.GetMethodDefinition(methodHandle);
            if (metadata.GetString(method.Name) != methodName || method.RelativeVirtualAddress == 0)
            {
                continue;
            }

            return peReader.GetMethodBody(method.RelativeVirtualAddress).GetILBytes()
                ?? Array.Empty<byte>();
        }

        throw new InvalidOperationException($"Method '{methodName}' was not found in '{assemblyPath}'.");
    }
}
