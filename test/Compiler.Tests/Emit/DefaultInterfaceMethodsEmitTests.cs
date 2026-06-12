// <copyright file="DefaultInterfaceMethodsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0085 / issue #726: default-interface methods (DIM). Validates the
/// CLR emit shape — interface TypeDef carries a virtual non-abstract method
/// with a body, and an implementer that omits the method inherits the
/// default at runtime through normal virtual dispatch. A cross-language
/// test compiles G# as a library and consumes it from a C# program that
/// calls the default through an interface reference.
/// </summary>
public class DefaultInterfaceMethodsEmitTests
{
    [Fact]
    public void DefaultInterfaceMethod_InterfaceMetadata_IsVirtualNotAbstract()
    {
        var source = """
            package Probe
            import System

            interface IGreeter {
                func Hello() string { return "hi" }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            MethodDefinitionHandle? helloHandle = null;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                if (!reader.StringComparer.Equals(td.Name, "IGreeter"))
                {
                    continue;
                }

                foreach (var mh in td.GetMethods())
                {
                    var md = reader.GetMethodDefinition(mh);
                    if (reader.StringComparer.Equals(md.Name, "Hello"))
                    {
                        helloHandle = mh;
                        break;
                    }
                }
            }

            Assert.True(helloHandle.HasValue, "expected to find Hello on IGreeter");
            var hello = reader.GetMethodDefinition(helloHandle.Value);

            // Default interface methods must be virtual but NOT abstract,
            // and must carry a body (RVA != 0).
            Assert.True((hello.Attributes & MethodAttributes.Virtual) != 0, "DIM must be virtual");
            Assert.True((hello.Attributes & MethodAttributes.Abstract) == 0, "DIM must not be abstract");
            Assert.True(hello.RelativeVirtualAddress != 0, "DIM must carry a body (non-zero RVA)");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void DefaultInterfaceMethod_InheritedAtRuntime_ViaInterfaceReceiver()
    {
        // Cross-language: emit G# library with an interface that exposes a
        // default and a class that inherits it. A small C# consumer then
        // calls the default through an interface-typed reference. The
        // observable behavior must match the G#-side dispatch.
        var gsource = """
            package Probe
            import System

            public interface IGreeter {
                func Hello() string { return "hi (default)" }
            }

            public class Quiet : IGreeter {
            }

            public class Loud : IGreeter {
                func Hello() string { return "LOUD" }
            }
            """;

        var consumerCs = """
            using System;
            using Probe;

            class Program
            {
                static int Main()
                {
                    IGreeter q = new Quiet();
                    IGreeter l = new Loud();
                    Console.WriteLine(q.Hello());
                    Console.WriteLine(l.Hello());
                    return 0;
                }
            }
            """;

        var output = CompileGsharpLibAndRunCsharpConsumer(gsource, consumerCs);
        Assert.Equal("hi (default)\nLOUD\n", output);
    }

    [Fact]
    public void DefaultInterfaceMethod_ConflictingDefaults_ReportsGS0318()
    {
        // Diamond-conflict diagnostic surfaces from gsc when two unrelated
        // interfaces both provide a default for the same signature and the
        // implementing class fails to disambiguate.
        var source = """
            package Probe

            interface IA {
                func F() int32 { return 1 }
            }

            interface IB {
                func F() int32 { return 2 }
            }

            class C : IA, IB {
            }
            """;

        var diagnostics = CompileExpectingErrors(source);
        Assert.Contains(diagnostics, d => d.Contains("GS0318"));
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_dim_lib_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new[]
        {
            "/out:" + outPath,
            "/target:library",
            "/targetframework:net10.0",
            srcPath,
        };

        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
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

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static string[] CompileExpectingErrors(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_dim_err_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            File.WriteAllText(srcPath, source);
            var args = new[]
            {
                "/out:" + Path.Combine(tempDir, "test.dll"),
                "/target:library",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            try
            {
                _ = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            return stdoutWriter.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileGsharpLibAndRunCsharpConsumer(string gsource, string csource)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_dim_xlang_").FullName;
        try
        {
            // Step 1: emit the G# library.
            var gSrcPath = Path.Combine(tempDir, "lib.gs");
            var gDllPath = Path.Combine(tempDir, "Probe.dll");
            File.WriteAllText(gSrcPath, gsource);

            var gscArgs = new List<string>
            {
                "/out:" + gDllPath,
                "/target:library",
                "/targetframework:net10.0",
                gSrcPath,
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
                compileExit = Program.Main(gscArgs.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(gDllPath);

            // Step 2: scaffold a C# console consumer that references the
            // G# library through a /reference and runs through `dotnet`.
            var csDir = Path.Combine(tempDir, "consumer");
            Directory.CreateDirectory(csDir);
            File.WriteAllText(Path.Combine(csDir, "Program.cs"), csource);
            File.WriteAllText(Path.Combine(csDir, "Consumer.csproj"), $"""
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <OutputType>Exe</OutputType>
                    <TargetFramework>net10.0</TargetFramework>
                    <AssemblyName>Consumer</AssemblyName>
                    <RootNamespace>Consumer</RootNamespace>
                  </PropertyGroup>
                  <ItemGroup>
                    <Reference Include="Probe">
                      <HintPath>{gDllPath}</HintPath>
                    </Reference>
                  </ItemGroup>
                </Project>
                """);

            RunDotnet(csDir, "restore");
            _ = RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore");

            var consumerDll = Path.Combine(csDir, "bin", "Release", "net10.0", "Consumer.dll");
            Assert.True(File.Exists(consumerDll), $"consumer not found at {consumerDll}");

            // Step 3: copy the G# library next to the consumer so the
            // runtime probing path resolves it, then exec.
            File.Copy(gDllPath, Path.Combine(Path.GetDirectoryName(consumerDll), Path.GetFileName(gDllPath)), overwrite: true);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(consumerDll),
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(consumerDll, ".runtimeconfig.json"));
            psi.ArgumentList.Add(consumerDll);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string RunDotnet(string workingDir, params string[] args)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDir,
        };
        foreach (var a in args)
        {
            psi.ArgumentList.Add(a);
        }

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException($"failed to start dotnet {string.Join(" ", args)}");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(180_000), $"dotnet {args[0]} timed out");
        Assert.True(
            proc.ExitCode == 0,
            $"dotnet {string.Join(" ", args)} failed (exit {proc.ExitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static void TryCleanup(string dllPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(dllPath);
            if (dir != null && Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
        }
    }
}
