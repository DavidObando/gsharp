// <copyright file="Issue2492NullableBoxedConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2492 end-to-end coverage for nullable object/interface sources
/// explicitly unboxed to nullable value types.
/// </summary>
public sealed class Issue2492NullableBoxedConversionEmitTests
{
    [Fact]
    public void NullableObject_ToNullableUInt32_ReflectsUnboxAnySemantics()
    {
        const string source = """
            package issue2492reflection

            func Convert(value object?) uint32? -> uint32?(value)
            """;

        var assembly = CompileLibrary(source);
        var method = GetProgramMethod(assembly, "Convert");

        Assert.Equal(typeof(uint?), method.ReturnType);
        Assert.Null(method.Invoke(null, new object[] { null }));
        Assert.Equal(2492u, method.Invoke(null, new object[] { 2492u }));

        var exception = Assert.Throws<TargetInvocationException>(
            () => method.Invoke(null, new object[] { 2492 }));
        Assert.IsType<InvalidCastException>(exception.InnerException);

        var il = method.GetMethodBody()!.GetILAsByteArray()!;
        Assert.Contains((byte)0xA5, il); // unbox.any
    }

    [Fact]
    public void NullableObject_ToNullableImportedStruct_PropagatesNullAndValue()
    {
        const string source = """
            package issue2492imported
            import System

            func Convert(value object?) Guid? -> Guid?(value)
            """;

        var assembly = CompileLibrary(source);
        var method = GetProgramMethod(assembly, "Convert");
        var expected = Guid.NewGuid();

        Assert.Equal(typeof(Guid?), method.ReturnType);
        Assert.Null(method.Invoke(null, new object[] { null }));
        Assert.Equal(expected, method.Invoke(null, new object[] { expected }));
    }

    [Fact]
    public void NullableValueTypeAndEnumBaseSources_UnboxCompatibleNullableTargets()
    {
        const string source = """
            package issue2492boxedbases
            import System

            func ConvertValue(value ValueType?) Guid? -> Guid?(value)
            func ConvertEnum(value Enum?) DayOfWeek? -> DayOfWeek?(value)
            """;

        var assembly = CompileLibrary(source);
        var convertValue = GetProgramMethod(assembly, "ConvertValue");
        var convertEnum = GetProgramMethod(assembly, "ConvertEnum");
        var guid = Guid.NewGuid();

        Assert.Null(convertValue.Invoke(null, new object[] { null }));
        Assert.Equal(guid, convertValue.Invoke(null, new object[] { guid }));
        Assert.Null(convertEnum.Invoke(null, new object[] { null }));
        Assert.Equal(DayOfWeek.Friday, convertEnum.Invoke(null, new object[] { DayOfWeek.Friday }));
    }

    [Fact]
    public void SameCompilationStructAndEnum_RoundTripThroughNullableObject()
    {
        const string source = """
            package issue2492user
            import System

            struct Point2492(Value int32) {}
            enum Color2492 { Red, Green }

            func Main() {
                let pointBox object? = Point2492(7)
                let point Point2492? = Point2492?(pointBox)
                Console.WriteLine(point!!.Value)

                let colorBox object? = Color2492.Green
                let color Color2492? = Color2492?(colorBox)
                Console.WriteLine(int32(color!!))

                let missing object? = nil
                let noPoint Point2492? = Point2492?(missing)
                let noColor Color2492? = Color2492?(missing)
                Console.WriteLine(noPoint == nil)
                Console.WriteLine(noColor == nil)
            }
            """;

        Assert.Equal("7\n1\nTrue\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void StructConstrainedGenericNullableTarget_RoundTrips()
    {
        const string source = """
            package issue2492generic
            import System

            func Convert[T struct](value object?) T? -> T?(value)

            func Main() {
                let boxed object? = 42
                let present int32? = Convert[int32](boxed)
                Console.WriteLine(present!!)

                let missing object? = nil
                let absent int32? = Convert[int32](missing)
                Console.WriteLine(absent == nil)
            }
            """;

        Assert.Equal("42\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void NullableImportedAndUserInterfaces_UnboxMatchingValues()
    {
        const string source = """
            package issue2492interfaces
            import System

            interface IBox2492 {}
            struct Box2492(Value int32) : IBox2492 {}

            func FromImported(value IComparable?) int32? -> int32?(value)
            func FromUser(value IBox2492?) Box2492? -> Box2492?(value)

            func Main() {
                let imported IComparable? = 17
                Console.WriteLine(FromImported(imported)!!)

                let user IBox2492? = Box2492(23)
                Console.WriteLine(FromUser(user)!!.Value)
            }
            """;

        Assert.Equal("17\n23\n", CompileAndRun(source));
    }

    [Fact]
    public void PatternNarrowedInterfaceSource_UsesCheckedUnboxing()
    {
        const string source = """
            package issue2492pattern
            import System

            func Convert(value object?) int32? {
                if value is IComparable {
                    return int32?(value)
                }

                return nil
            }

            func Main() {
                Console.WriteLine(Convert(31)!!)
                Console.WriteLine(Convert(nil) == nil)
            }
            """;

        Assert.Equal("31\nTrue\n", CompileAndRun(source));
    }

    private static MethodInfo GetProgramMethod(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        return program.GetMethod(
            name,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException($"Method '{name}' was not emitted.");
    }

    private static Assembly CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2492_lib_").FullName;
        try
        {
            var sourcePath = Path.Combine(tempDir, "test.gs");
            var outputPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(sourcePath, source);

            var (exitCode, stdout, stderr) = Compile(sourcePath, outputPath, "library");
            Assert.True(exitCode == 0, $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
            IlVerifier.Verify(outputPath);
            return Assembly.Load(File.ReadAllBytes(outputPath));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2492_exe_").FullName;
        try
        {
            var sourcePath = Path.Combine(tempDir, "test.gs");
            var outputPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(sourcePath, source);

            var (exitCode, stdout, stderr) = Compile(sourcePath, outputPath, "exe");
            Assert.True(exitCode == 0, $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
            IlVerifier.Verify(outputPath);

            var runtimeConfig = Path.ChangeExtension(outputPath, ".runtimeconfig.json");
            if (!File.Exists(runtimeConfig))
            {
                File.WriteAllText(runtimeConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(runtimeConfig);
            startInfo.ArgumentList.Add(outputPath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            var runtimeOutput = process.StandardOutput.ReadToEnd();
            var runtimeError = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            Assert.True(
                process.ExitCode == 0,
                $"dotnet exec failed ({process.ExitCode}):\nstdout:\n{runtimeOutput}\nstderr:\n{runtimeError}");
            return runtimeOutput.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static (int ExitCode, string Stdout, string Stderr) Compile(
        string sourcePath,
        string outputPath,
        string target)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(new[]
            {
                "/out:" + outputPath,
                "/target:" + target,
                "/targetframework:net10.0",
                sourcePath,
            });
            return (exitCode, stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }
}
