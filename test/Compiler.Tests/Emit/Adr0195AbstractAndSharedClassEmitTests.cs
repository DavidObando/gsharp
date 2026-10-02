// <copyright file="Adr0195AbstractAndSharedClassEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0195 / issue #4674 — the CLR shape of the <c>abstract</c> and
/// <c>shared</c> class modifiers, read back from the emitted metadata, plus an
/// ILVerify + run of the program. The migrated GSharp.Core API depends on
/// these flags being exactly what the C# compiler emits for an abstract class
/// and for a static class.
/// </summary>
public class Adr0195AbstractAndSharedClassEmitTests
{
    private const string Source =
        """
        package Maui.Adr0195.Tests

        import System

        abstract class Walker {
            var visited int32
            func Visit() int32 {
                visited = visited + 1
                return visited
            }
        }

        open class Counting : Walker {
            func Twice() int32 {
                return Visit() + Visit()
            }
        }

        open abstract class Both {
        }

        open class Seed(N int32) {
        }

        abstract class Forwarding : Seed(1) {
        }

        open class Leaf : Forwarding {
        }

        abstract data class Shape(Sides int32) {
        }

        data class Square(Side int32) : Shape(4) {
        }

        shared class Helpers {
            const Factor int32 = 3
            var calls int32
            func Triple(x int32) int32 {
                calls = calls + 1
                return x * Factor
            }
        }

        func Main() {
            let c = Counting{}
            Console.WriteLine(c.Twice())
            Console.WriteLine(Helpers.Triple(5))
            Console.WriteLine(Helpers.Triple(2) + Helpers.calls)
            Console.WriteLine(Square(2).Sides + Square(2).Side)
            Console.WriteLine(Leaf().N)
        }
        """;

    [Fact]
    public void AbstractClass_IsAbstractNotSealed_WithFamilyConstructor()
    {
        var dll = CompileToDll(Source);
        try
        {
            foreach (var name in new[] { "Walker", "Both", "Shape" })
            {
                var attributes = GetTypeAttributes(dll, name);
                Assert.Equal(TypeAttributes.Abstract, attributes & TypeAttributes.Abstract);
                Assert.Equal(default(TypeAttributes), attributes & TypeAttributes.Sealed);
                Assert.Equal(
                    MethodAttributes.Family,
                    GetMethodAttributes(dll, name, ".ctor") & MethodAttributes.MemberAccessMask);
            }

            // The implicit constructor that chains to a base initializer is family too (a
            // primary constructor stays public).
            Assert.Equal(
                MethodAttributes.Family,
                GetMethodAttributes(dll, "Forwarding", ".ctor") & MethodAttributes.MemberAccessMask);

            // A concrete subclass is neither.
            var counting = GetTypeAttributes(dll, "Counting");
            Assert.Equal(default(TypeAttributes), counting & TypeAttributes.Abstract);
            Assert.Equal(default(TypeAttributes), counting & TypeAttributes.Sealed);
        }
        finally
        {
            TryDeleteDir(Path.GetDirectoryName(dll));
        }
    }

    [Fact]
    public void SharedClass_IsAbstractAndSealed_WithNoReachableConstructor()
    {
        var dll = CompileToDll(Source);
        try
        {
            var attributes = GetTypeAttributes(dll, "Helpers");
            Assert.Equal(TypeAttributes.Abstract | TypeAttributes.Sealed, attributes & (TypeAttributes.Abstract | TypeAttributes.Sealed));
            Assert.Equal(
                MethodAttributes.Private,
                GetMethodAttributes(dll, "Helpers", ".ctor") & MethodAttributes.MemberAccessMask);
            Assert.Equal(
                MethodAttributes.Public | MethodAttributes.Static,
                GetMethodAttributes(dll, "Helpers", "Triple") & (MethodAttributes.MemberAccessMask | MethodAttributes.Static));
        }
        finally
        {
            TryDeleteDir(Path.GetDirectoryName(dll));
        }
    }

    [Fact]
    public void AbstractAndSharedClasses_VerifyAndRun()
    {
        var dll = CompileToDll(Source);
        try
        {
            IlVerifier.Verify(dll);

            File.WriteAllText(Path.ChangeExtension(dll, "runtimeconfig.json"), """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + dll + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            Assert.True(proc.ExitCode == 0, "exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            Assert.Equal("3\n15\n8\n6\n1\n", stdout.ReplaceLineEndings("\n"));
        }
        finally
        {
            TryDeleteDir(Path.GetDirectoryName(dll));
        }
    }

    private static TypeAttributes GetTypeAttributes(string dllPath, string typeName)
    {
        using var fs = File.OpenRead(dllPath);
        using var pe = new PEReader(fs);
        var mr = pe.GetMetadataReader();
        foreach (var typeHandle in mr.TypeDefinitions)
        {
            var type = mr.GetTypeDefinition(typeHandle);
            if (mr.GetString(type.Name) == typeName)
            {
                return type.Attributes;
            }
        }

        throw new Xunit.Sdk.XunitException($"type {typeName} not found in {dllPath}");
    }

    private static MethodAttributes GetMethodAttributes(string dllPath, string typeName, string methodName)
    {
        using var fs = File.OpenRead(dllPath);
        using var pe = new PEReader(fs);
        var mr = pe.GetMetadataReader();
        foreach (var typeHandle in mr.TypeDefinitions)
        {
            var type = mr.GetTypeDefinition(typeHandle);
            if (mr.GetString(type.Name) != typeName)
            {
                continue;
            }

            foreach (var methodHandle in type.GetMethods())
            {
                var method = mr.GetMethodDefinition(methodHandle);
                if (mr.GetString(method.Name) == methodName)
                {
                    return method.Attributes;
                }
            }
        }

        throw new Xunit.Sdk.XunitException($"method {typeName}.{methodName} not found in {dllPath}");
    }

    private static string CompileToDll(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_adr0195_emit_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new[]
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
            "/nowarn:GS9100",
            srcPath,
        };

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(args);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
        return outPath;
    }

    private static void TryDeleteDir(string dir)
    {
        try
        {
            if (dir != null)
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
        }
    }
}
