// <copyright file="Issue3285PointerDefaultEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #3285: pointer defaults materialize as native-int zero, never <c>ldnull</c>.</summary>
public class Issue3285PointerDefaultEmitTests
{
    private static readonly string[] UnsafeIlVerifyIgnored =
    {
        "UnmanagedPointer",
        "StackUnexpected",
        "StackByRef",
        "ExpectedPtr",
        "StackUnexpectedArrayType",
    };

    [Fact]
    public async Task PointerDefaults_AllSupportedPositions_CompileAndRun()
    {
        const string Source = """
            package Issue3285
            import System

            struct Point {
                var X int32
                var Y int32
            }

            class RefBox {}

            unsafe class PointerFields {
                var Raw *int32 = default
                var Fn *func(int32) int32 = default
            }

            unsafe func rawOptional(value *int32 = nil) {
                Console.WriteLine(nint(value))
            }

            unsafe func fnOptional(value *func(int32) int32 = default(*func(int32) int32)) {
                Console.WriteLine(nint(value))
            }

            unsafe func rawDefault() *int32 { return default(*int32) }
            unsafe func fnDefault() *func(int32) int32 { return default(*func(int32) int32) }
            unsafe func rawNil() *int32 { return nil }
            unsafe func fnNil() *func(int32) int32 { return nil }
            func refDefault() RefBox? { return default(RefBox?) }
            func nullableDefault() int32? { return default(int32?) }
            func pointDefault() Point { return default(Point) }

            unsafe {
                rawOptional()
                fnOptional()

                var fields = PointerFields()
                Console.WriteLine(nint(fields.Raw))
                Console.WriteLine(nint(fields.Fn))

                let rawBare *int32 = default
                let fnBare *func(int32) int32 = default
                Console.WriteLine(nint(rawBare))
                Console.WriteLine(nint(fnBare))
                Console.WriteLine(nint(rawDefault()))
                Console.WriteLine(nint(fnDefault()))
                Console.WriteLine(nint(rawNil()))
                Console.WriteLine(nint(fnNil()))

                var rawElements = []*int32{default(*int32), default, nil}
                var fnElements = []*func(int32) int32{default(*func(int32) int32), default, nil}
                Console.WriteLine(nint(rawElements[0]))
                Console.WriteLine(nint(rawElements[1]))
                Console.WriteLine(nint(rawElements[2]))
                Console.WriteLine(nint(fnElements[0]))
                Console.WriteLine(nint(fnElements[1]))
                Console.WriteLine(nint(fnElements[2]))

                var rawZeros = [2]*int32
                var fnZeros = [2]*func(int32) int32
                Console.WriteLine(nint(rawZeros[0]))
                Console.WriteLine(nint(rawZeros[1]))
                Console.WriteLine(nint(fnZeros[0]))
                Console.WriteLine(nint(fnZeros[1]))

                Console.WriteLine(refDefault() == nil)
                Console.WriteLine(nullableDefault() == nil)
                var point = pointDefault()
                Console.WriteLine(point.X)
                var delegateDefault () -> int32 = default(() -> int32)
                Console.WriteLine(delegateDefault == nil)
            }
            """;

        var (output, opcodes) = await CompileInspectAndRun(
            Source,
            "rawDefault",
            "fnDefault",
            "rawNil",
            "fnNil",
            "refDefault");

        Assert.Equal(
            string.Concat(Enumerable.Repeat($"0{Environment.NewLine}", 20))
                + $"True{Environment.NewLine}"
                + $"True{Environment.NewLine}"
                + $"0{Environment.NewLine}"
                + $"True{Environment.NewLine}",
            output);

        var nativeZero = new[] { (byte)ILOpCode.Ldc_i4_0, (byte)ILOpCode.Conv_i, (byte)ILOpCode.Ret };
        Assert.Equal(nativeZero, opcodes["rawDefault"]);
        Assert.Equal(nativeZero, opcodes["fnDefault"]);
        Assert.Equal(nativeZero, opcodes["rawNil"]);
        Assert.Equal(nativeZero, opcodes["fnNil"]);
        Assert.Equal(new[] { (byte)ILOpCode.Ldnull, (byte)ILOpCode.Ret }, opcodes["refDefault"]);
    }

    private static async Task<(string Output, IReadOnlyDictionary<string, byte[]> OpCodes)> CompileInspectAndRun(
        string source,
        params string[] methods)
    {
        var outputDirectory = Path.Combine(AppContext.BaseDirectory, "issue3285", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        try
        {
            var sourcePath = Path.Combine(outputDirectory, "Program.gs");
            var outputPath = Path.Combine(outputDirectory, "Issue3285.dll");
            File.WriteAllText(sourcePath, source);

            using var standardOut = new StringWriter();
            using var standardError = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
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

            var opcodes = methods.ToDictionary(
                method => method,
                method => ReadMethodIl(outputPath, method));

            IlVerifier.Verify(outputPath, null, UnsafeIlVerifyIgnored);

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
            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var stderrTask = process.StandardError.ReadToEndAsync();
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

            var stdout = await stdoutTask;
            var stderr = await stderrTask;
            Assert.True(
                process.ExitCode == 0,
                $"sample exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return (stdout.ReplaceLineEndings(Environment.NewLine), opcodes);
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
        var metadata = peReader.GetMetadataReader();
        foreach (var methodHandle in metadata.MethodDefinitions)
        {
            var method = metadata.GetMethodDefinition(methodHandle);
            if (metadata.GetString(method.Name) != methodName || method.RelativeVirtualAddress == 0)
            {
                continue;
            }

            return peReader.GetMethodBody(method.RelativeVirtualAddress).GetILBytes() ?? Array.Empty<byte>();
        }

        throw new InvalidOperationException($"Method '{methodName}' was not found in '{assemblyPath}'.");
    }
}
