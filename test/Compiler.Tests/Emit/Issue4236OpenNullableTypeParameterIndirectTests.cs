// <copyright file="Issue4236OpenNullableTypeParameterIndirectTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #4236: <c>EmitStoreIndirect</c>/<c>EmitLoadIndirect</c> fell through to
/// <c>stind.ref</c>/<c>ldind.ref</c> for a <c>T?</c> pointee whose underlying
/// type is an OPEN, unconstrained type parameter (no <c>struct</c>/<c>class</c>
/// constraint) — a shape neither the "provably a value type" arm nor the bare
/// <c>TypeParameterSymbol</c> arm recognised. <c>stind.ref</c>/<c>ldind.ref</c>
/// treat the pointee as an object reference; once T is JIT-instantiated as a
/// real (non-primitive) value type this is invalid IL that ILVerify's
/// abstract-over-open-T checking does not catch but the runtime rejects with
/// <see cref="InvalidProgramException"/> — exactly the self-hosted
/// <c>Gsharp.Concurrency.Chan&lt;T&gt;.ReceiveOrPark</c> / <c>ReceiveValueAsync</c>
/// failure this issue reduces (its <c>out T? value</c> parameter). A CoreLib
/// primitive element type (<c>int32</c>, etc.) never exercises the faulty arm —
/// only a non-primitive struct does, which is why this needs a user struct, not
/// just <c>int32</c>, to fail before the fix.
/// </summary>
public class Issue4236OpenNullableTypeParameterIndirectTests
{
    [Fact]
    public void OutAndRefOpenNullableTypeParameter_UserStruct_LoadsVerifiesAndRuns()
    {
        const string Source = """
            package Issue4236
            import System

            data struct Pair(Value int32)

            class Box[T] {
                func TrySet(input T, out value T?) bool {
                    value = input
                    return true
                }

                func Reassign(ref value T?, replacement T) T {
                    let old = value!!
                    value = replacement
                    return old
                }

                func RoundTripOut(input T) T {
                    TrySet(input, out var captured)
                    return captured!!
                }

                func RoundTripRef(input T, replacement T) T {
                    var value T? = input
                    return Reassign(ref value, replacement)
                }
            }

            let pairBox = Box[Pair]()
            Console.WriteLine(pairBox.RoundTripOut(Pair(7)).Value)
            let intBox = Box[int32]()
            Console.WriteLine(intBox.RoundTripOut(9))
            Console.WriteLine(pairBox.RoundTripRef(Pair(11), Pair(12)).Value)
            Console.WriteLine(intBox.RoundTripRef(13, 14))
            """;

        AssertRuns(
            Source,
            nameof(OutAndRefOpenNullableTypeParameter_UserStruct_LoadsVerifiesAndRuns),
            "7\n9\n11\n13\n");
    }

    private static void AssertRuns(string source, string name, string expected)
    {
        var assemblyPath = Compile(source, name);
        var assembly = EmittedFixture.Load(assemblyPath);
        Assert.NotEmpty(assembly.GetTypes());

        Assert.Equal(expected, RunBounded(assemblyPath, name));

        IlVerifier.Verify(assemblyPath);
    }

    private static string Compile(string source, string name)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue4236OpenNullableTypeParameterIndirectTests),
            name);
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyPath = Path.Combine(directory, name + ".dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousErr = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }

        Assert.True(exitCode == 0, $"{name}: gsc failed:\n{stdout}\n{stderr}");
        return assemblyPath;
    }

    private static string RunBounded(string assemblyPath, string name)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                assemblyPath,
            },
            WorkingDirectory = Path.GetDirectoryName(assemblyPath),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });

        Assert.NotNull(process);
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        var exited = process.WaitForExit(10_000);
        if (!exited)
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
        }

        Assert.True(exited, $"{name}: emitted program timed out");
        var output = outputTask.GetAwaiter().GetResult();
        var error = errorTask.GetAwaiter().GetResult();
        Assert.True(process.ExitCode == 0, $"{name}: emitted program failed:\n{error}");
        return output.ReplaceLineEndings(Environment.NewLine);
    }
}
