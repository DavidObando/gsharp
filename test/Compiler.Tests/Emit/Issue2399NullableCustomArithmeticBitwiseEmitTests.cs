// <copyright file="Issue2399NullableCustomArithmeticBitwiseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2399: same-compilation value structs with custom arithmetic and
/// bitwise operators lift over <c>Nullable&lt;T&gt;</c> using CLR nullable
/// semantics. Present operands unwrap and call the emitted <c>op_*</c> method;
/// any missing operand propagates a missing nullable result.
/// </summary>
public class Issue2399NullableCustomArithmeticBitwiseEmitTests
{
    [Fact]
    public void ArithmeticBitwiseAndShiftOperators_LiftRunAndVerify()
    {
        const string source = """
            package Issue2399Runtime
            import System

            struct Word2399(Value int32) { }

            func (left Word2399) operator +(right Word2399) Word2399 {
                return Word2399(left.Value + right.Value)
            }
            func (left Word2399) operator -(right Word2399) Word2399 {
                return Word2399(left.Value - right.Value)
            }
            func (left Word2399) operator *(right Word2399) Word2399 {
                return Word2399(left.Value * right.Value)
            }
            func (left Word2399) operator /(right Word2399) Word2399 {
                return Word2399(left.Value / right.Value)
            }
            func (left Word2399) operator %(right Word2399) Word2399 {
                return Word2399(left.Value % right.Value)
            }
            func (left Word2399) operator &(right Word2399) Word2399 {
                return Word2399(left.Value & right.Value)
            }
            func (left Word2399) operator |(right Word2399) Word2399 {
                return Word2399(left.Value | right.Value)
            }
            func (left Word2399) operator ^(right Word2399) Word2399 {
                return Word2399(left.Value ^ right.Value)
            }
            func (left Word2399) operator <<(count int32) Word2399 {
                return Word2399(left.Value << count)
            }
            func (left Word2399) operator >>(count int32) Word2399 {
                return Word2399(left.Value >> count)
            }

            let left Word2399? = Word2399(12)
            let right Word2399? = Word2399(10)
            let missing Word2399? = nil
            let shift int32? = 2
            let missingShift int32? = nil

            Console.WriteLine((left + right)!!.Value)
            Console.WriteLine((left - right)!!.Value)
            Console.WriteLine((left * right)!!.Value)
            Console.WriteLine((left / right)!!.Value)
            Console.WriteLine((left % right)!!.Value)
            Console.WriteLine((left & right)!!.Value)
            Console.WriteLine((left | right)!!.Value)
            Console.WriteLine((left ^ right)!!.Value)
            Console.WriteLine((left << shift)!!.Value)
            Console.WriteLine((left >> shift)!!.Value)

            Console.WriteLine(left + missing == nil)
            Console.WriteLine(left & missing == nil)
            Console.WriteLine(left << missingShift == nil)

            Console.WriteLine((left + Word2399(1))!!.Value)
            Console.WriteLine((Word2399(1) + right)!!.Value)
            """;

        Assert.Equal(
            "22\n2\n120\n1\n2\n8\n14\n6\n48\n3\nTrue\nTrue\nTrue\n13\n11\n",
            CompileAndRun(source));
    }

    [Fact]
    public void LiftedApiAndOperatorMetadata_UseNullableResultShapeAndVerify()
    {
        const string source = """
            package Issue2399Metadata

            struct Word2399Metadata(Value int32) { }

            func (left Word2399Metadata) operator +(right Word2399Metadata) Word2399Metadata {
                return Word2399Metadata(left.Value + right.Value)
            }

            func (left Word2399Metadata) operator &(right Word2399Metadata) Word2399Metadata {
                return Word2399Metadata(left.Value & right.Value)
            }

            func Add2399(left Word2399Metadata?, right Word2399Metadata?) Word2399Metadata? -> left + right
            func And2399(left Word2399Metadata?, right Word2399Metadata?) Word2399Metadata? -> left & right
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)
                ?? throw new InvalidOperationException("Runtime directory not found.");
            var resolver = new PathAssemblyResolver(
                Directory.GetFiles(runtimeDir, "*.dll").Concat(new[] { dllPath }));
            using var metadataContext = new MetadataLoadContext(resolver, "System.Private.CoreLib");
            var assembly = metadataContext.LoadFromAssemblyPath(dllPath);
            var word = assembly.GetType("Issue2399Metadata.Word2399Metadata")
                ?? throw new InvalidOperationException("Word2399Metadata type not found.");
            var program = assembly.GetTypes().Single(type => type.Name == "<Program>");

            AssertOperatorMetadata(word, "op_Addition");
            AssertOperatorMetadata(word, "op_BitwiseAnd");
            AssertLiftedApiMetadata(program, "Add2399", word);
            AssertLiftedApiMetadata(program, "And2399", word);
        }
        finally
        {
            TryDeleteDirectory(Path.GetDirectoryName(dllPath));
        }
    }

    private static void AssertOperatorMetadata(Type word, string methodName)
    {
        var method = word.GetMethod(methodName, BindingFlags.Public | BindingFlags.Static)
            ?? throw new InvalidOperationException($"{methodName} not found.");
        Assert.True(method.IsSpecialName);
        Assert.Equal(word, method.ReturnType);
        Assert.Equal(new[] { word, word }, method.GetParameters().Select(parameter => parameter.ParameterType));
    }

    private static void AssertLiftedApiMetadata(Type program, string methodName, Type word)
    {
        var method = program.GetMethod(methodName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException($"{methodName} not found.");
        AssertNullableOf(method.ReturnType, word);
        foreach (var parameter in method.GetParameters())
        {
            AssertNullableOf(parameter.ParameterType, word);
        }
    }

    private static void AssertNullableOf(Type type, Type underlying)
    {
        Assert.True(type.IsGenericType);
        Assert.Equal("System.Nullable`1", type.GetGenericTypeDefinition().FullName);
        Assert.Equal(underlying, type.GetGenericArguments()[0]);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2399_run_").FullName;
        try
        {
            var dllPath = Compile(source, tempDir, isLibrary: false);
            IlVerifier.Verify(dllPath);

            var processInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            processInfo.ArgumentList.Add("exec");
            processInfo.ArgumentList.Add("--runtimeconfig");
            processInfo.ArgumentList.Add(Path.ChangeExtension(dllPath, ".runtimeconfig.json"));
            processInfo.ArgumentList.Add(dllPath);

            using var process = Process.Start(processInfo)
                ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            Assert.True(
                process.ExitCode == 0,
                $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            TryDeleteDirectory(tempDir);
        }
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2399_lib_").FullName;
        var dllPath = Compile(source, tempDir, isLibrary: true);
        IlVerifier.Verify(dllPath);
        return dllPath;
    }

    private static string Compile(string source, string tempDir, bool isLibrary)
    {
        var sourcePath = Path.Combine(tempDir, "test.gs");
        var dllPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(sourcePath, source);

        var args = new List<string>
        {
            "/out:" + dllPath,
            isLibrary ? "/target:library" : "/target:exe",
            "/targetframework:net10.0",
            "/nowarn:GS9100",
            sourcePath,
        };

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

        Assert.True(
            exitCode == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
        return dllPath;
    }

    private static void TryDeleteDirectory(string directory)
    {
        try
        {
            if (directory != null && Directory.Exists(directory))
            {
                Directory.Delete(directory, recursive: true);
            }
        }
        catch
        {
        }
    }
}
