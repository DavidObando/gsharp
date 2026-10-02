// <copyright file="Issue4676ProgramHostAccessibilityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #4676: every package of a G# assembly gets a synthesized
/// <c>&lt;Program&gt;</c> host type, and it was always <c>public</c>. For a
/// library package that hosts nothing another assembly can reach, that exported
/// one empty public type per namespace (22 in the migrated GSharp.Core, none in
/// the C# build), which then leaks into reflection-based API enumeration. The
/// host is now emitted NotPublic unless it carries a public function or global
/// (it is how a package exposes those) or the compilation has an entry point.
/// </summary>
public class Issue4676ProgramHostAccessibilityEmitTests
{
    [Fact]
    public void LibraryPackageOfOnlyTypes_HasNoPublicProgramHost()
    {
        var dll = CompileLibrary(
            """
            package Lib.Types

            class Foo {
            }

            enum Color { Red, Green }
            """);
        try
        {
            Assert.Equal(TypeAttributes.NotPublic, GetProgramHostVisibility(dll));
            Assert.Empty(GetPublicSynthesizedTypeNames(dll));
        }
        finally
        {
            TryDeleteDir(Path.GetDirectoryName(dll));
        }
    }

    [Fact]
    public void LibraryPackageWithOnlyInternalAndPrivateFunctions_HasNoPublicProgramHost()
    {
        var dll = CompileLibrary(
            """
            package Lib.Internal

            internal func Hidden() int32 {
                return 41
            }

            private func AlsoHidden() int32 {
                return 1
            }

            class Foo {
            }
            """);
        try
        {
            Assert.Equal(TypeAttributes.NotPublic, GetProgramHostVisibility(dll));
        }
        finally
        {
            TryDeleteDir(Path.GetDirectoryName(dll));
        }
    }

    [Fact]
    public void LibraryPackageWithAPublicFunction_KeepsAPublicProgramHost_AndAConsumerCallsIt()
    {
        var lib = CompileLibrary(
            """
            package Lib.Api

            func Add(a int32, b int32) int32 {
                return a + b
            }
            """);
        try
        {
            Assert.Equal(TypeAttributes.Public, GetProgramHostVisibility(lib));

            // The host is how another assembly reaches the function, so the
            // consumer must still bind and run through it.
            var consumerSource =
                """
                package Consumer

                import Lib.Api
                import System

                func Main() {
                    Console.WriteLine(Add(40, 2))
                }
                """;
            // The assembly is named after its package, so a reference to it
            // has to be found by that file name (ILVerify and the runtime).
            var libByName = Path.Combine(Path.GetDirectoryName(lib), "Lib.Api.dll");
            File.Copy(lib, libByName);
            var exe = Compile(consumerSource, "exe", libByName);
            File.Copy(libByName, Path.Combine(Path.GetDirectoryName(exe), "Lib.Api.dll"));
            try
            {
                Assert.Equal("42\n", Run(exe));
            }
            finally
            {
                TryDeleteDir(Path.GetDirectoryName(exe));
            }
        }
        finally
        {
            TryDeleteDir(Path.GetDirectoryName(lib));
        }
    }

    [Fact]
    public void Executable_KeepsItsEntryPointProgramHostPublic()
    {
        var exe = Compile(
            """
            package App

            import System

            class Foo {
            }

            func Main() {
                Console.WriteLine("hi")
            }
            """,
            "exe");
        try
        {
            Assert.Equal(TypeAttributes.Public, GetProgramHostVisibility(exe));
            Assert.Equal("hi\n", Run(exe));
        }
        finally
        {
            TryDeleteDir(Path.GetDirectoryName(exe));
        }
    }

    private static TypeAttributes GetProgramHostVisibility(string dllPath)
    {
        using var fs = File.OpenRead(dllPath);
        using var pe = new PEReader(fs);
        var mr = pe.GetMetadataReader();
        foreach (var typeHandle in mr.TypeDefinitions)
        {
            var type = mr.GetTypeDefinition(typeHandle);
            if (mr.GetString(type.Name) == "<Program>")
            {
                return type.Attributes & TypeAttributes.VisibilityMask;
            }
        }

        throw new Xunit.Sdk.XunitException($"no <Program> host in {dllPath}");
    }

    private static string[] GetPublicSynthesizedTypeNames(string dllPath)
    {
        using var fs = File.OpenRead(dllPath);
        using var pe = new PEReader(fs);
        var mr = pe.GetMetadataReader();
        return mr.TypeDefinitions
            .Select(handle => mr.GetTypeDefinition(handle))
            .Where(type => mr.GetString(type.Name).StartsWith('<') && mr.GetString(type.Name) != "<Module>")
            .Where(type => (type.Attributes & TypeAttributes.VisibilityMask) is TypeAttributes.Public or TypeAttributes.NestedPublic)
            .Select(type => mr.GetString(type.Name))
            .ToArray();
    }

    private static string CompileLibrary(string source) => Compile(source, "library");

    private static string Compile(string source, string target, string reference = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue4676_emit_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new System.Collections.Generic.List<string>
        {
            "/out:" + outPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        if (reference != null)
        {
            args.Add("/r:" + reference);
        }

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
        IlVerifier.Verify(outPath, reference == null ? Array.Empty<string>() : new[] { reference });
        return outPath;
    }

    private static string Run(string dll)
    {
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
        using var proc = Process.Start(psi);
        string stdout = proc.StandardOutput.ReadToEnd();
        string stderr = proc.StandardError.ReadToEnd();
        proc.WaitForExit();
        Assert.True(proc.ExitCode == 0, "exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
        return stdout.ReplaceLineEndings("\n");
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
