// <copyright file="Issue950ProtectedModifierEmitTests.cs" company="GSharp">
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
/// Issue #950 — the <c>protected</c> access modifier. A <c>protected</c> member
/// of an <c>open class</c> is accessible from the declaring type and the bodies
/// of derived types, and is emitted as CIL <c>family</c> accessibility so the
/// CLR independently enforces the same rule. External access is a compile
/// error (GS0379); <c>protected</c> on a non-inheritable type is GS0380.
/// </summary>
public class Issue950ProtectedModifierEmitTests
{
    [Fact]
    public void DerivedClass_AccessesInheritedProtectedFieldAndMethod_Runs()
    {
        CompileVerifyAndRun(
            """
            package Maui.Issue950.Tests

            import System

            open class Base {
                protected var secret int32
                protected func Reveal() int32 {
                    return secret
                }
            }

            class Derived : Base {
                func Show() int32 {
                    secret = 7
                    return secret + Reveal()
                }
            }

            func Main() {
                let d = Derived{}
                Console.WriteLine(d.Show())
            }
            """,
            "14\n");
    }

    [Fact]
    public void ProtectedVirtualMethod_OverriddenInDerived_DispatchesVirtually()
    {
        CompileVerifyAndRun(
            """
            package Maui.Issue950.Tests

            import System

            open class Animal {
                protected open func Sound() string {
                    return "..."
                }
                func Describe() string {
                    return Sound()
                }
            }

            open class Dog : Animal {
                protected override func Sound() string {
                    return "Woof"
                }
            }

            func Main() {
                let a = Animal{}
                let d = Dog{}
                Console.WriteLine(a.Describe())
                Console.WriteLine(d.Describe())
            }
            """,
            "...\nWoof\n");
    }

    /// <summary>
    /// Guard: a <c>protected</c> field and method of an <c>open class</c> must
    /// be emitted with CIL <c>family</c> accessibility.
    /// </summary>
    [Fact]
    public void ProtectedMembers_AreEmittedFamily()
    {
        var dll = CompileToDll(
            """
            package Maui.Issue950.Tests

            import System

            open class Base {
                protected var secret int32
                protected func Reveal() int32 {
                    return secret
                }
            }

            func Main() {
                let b = Base{}
            }
            """);
        try
        {
            var fieldAttrs = GetFieldAttributes(dll, "Base", "secret");
            Assert.Equal(FieldAttributes.Family, fieldAttrs & FieldAttributes.FieldAccessMask);

            var methodAttrs = GetMethodAttributes(dll, "Base", "Reveal");
            Assert.Equal(MethodAttributes.Family, methodAttrs & MethodAttributes.MemberAccessMask);
        }
        finally
        {
            TryDeleteDir(Path.GetDirectoryName(dll));
        }
    }

    [Fact]
    public void ExternalCode_AccessesProtectedField_FailsToCompile()
    {
        var (exit, output) = TryCompile(
            """
            package Maui.Issue950.Tests

            import System

            open class Base {
                protected var secret int32
            }

            func Main() {
                let b = Base{}
                Console.WriteLine(b.secret)
            }
            """);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0379", output);
    }

    [Fact]
    public void ExternalCode_CallsProtectedMethod_FailsToCompile()
    {
        var (exit, output) = TryCompile(
            """
            package Maui.Issue950.Tests

            import System

            open class Base {
                protected func Reveal() int32 {
                    return 1
                }
            }

            func Main() {
                let b = Base{}
                Console.WriteLine(b.Reveal())
            }
            """);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0379", output);
    }

    [Fact]
    public void ProtectedOnNonOpenClass_FailsToCompile()
    {
        var (exit, output) = TryCompile(
            """
            package Maui.Issue950.Tests

            class Sealed {
                protected var secret int32
            }

            func Main() {
            }
            """);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0380", output);
    }

    [Fact]
    public void ProtectedOnStruct_FailsToCompile()
    {
        var (exit, output) = TryCompile(
            """
            package Maui.Issue950.Tests

            struct Val {
                protected var x int32
            }

            func Main() {
            }
            """);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0380", output);
    }

    private static FieldAttributes GetFieldAttributes(string dllPath, string typeName, string fieldName)
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

            foreach (var fieldHandle in type.GetFields())
            {
                var field = mr.GetFieldDefinition(fieldHandle);
                if (mr.GetString(field.Name) == fieldName)
                {
                    return field.Attributes;
                }
            }
        }

        throw new Xunit.Sdk.XunitException($"field {typeName}.{fieldName} not found in {dllPath}");
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

    private static void CompileVerifyAndRun(string source, string expected)
    {
        var dll = CompileToDll(source);
        try
        {
            IlVerifier.Verify(dll);

            var runtimeConfigPath = Path.ChangeExtension(dll, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
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
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            Assert.Equal(expected, stdout.Replace("\r\n", "\n"));
        }
        finally
        {
            TryDeleteDir(Path.GetDirectoryName(dll));
        }
    }

    private static string CompileToDll(string source)
    {
        var (exit, output, outPath) = RunCompiler(source);
        Assert.True(exit == 0, $"compile failed ({exit}): {output}");
        return outPath;
    }

    private static (int Exit, string Output) TryCompile(string source)
    {
        var (exit, output, outDir) = RunCompiler(source);
        TryDeleteDir(Path.GetDirectoryName(outDir));
        return (exit, output);
    }

    private static (int Exit, string Output, string OutPath) RunCompiler(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue950_emit_").FullName;
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

        return (compileExit, compileOut.ToString() + compileErr.ToString(), outPath);
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
