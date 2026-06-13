// <copyright file="StaticVirtualInterfaceMembersEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0089 / issue #755 — static-virtual interface members (SVIM).
/// Validates the full CLR emit shape end-to-end: the interface TypeDef
/// carries a method with <c>Static | Virtual | Abstract</c>, the
/// implementer's static method is paired to the slot via a
/// <c>MethodImpl</c> row (required by ECMA-335 §II.10.3.3 with the .NET 7
/// extension because static methods cannot be paired by name+signature
/// alone), and a generic consumer dispatches through
/// <c>constrained. !!T  call</c>. Runtime execution, IL verification,
/// and cross-language interop with C# 11 are all covered.
/// </summary>
public class StaticVirtualInterfaceMembersEmitTests
{
    [Fact]
    public void StaticVirtualAbstract_InterfaceMetadata_HasStaticVirtualAbstractFlags()
    {
        var source = """
            package Probe
            import System

            sealed interface IAdd {
                static func Add(a int32, b int32) int32
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            MethodDefinitionHandle? addHandle = null;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                if (!reader.StringComparer.Equals(td.Name, "IAdd"))
                {
                    continue;
                }

                foreach (var mh in td.GetMethods())
                {
                    var md = reader.GetMethodDefinition(mh);
                    if (reader.StringComparer.Equals(md.Name, "Add"))
                    {
                        addHandle = mh;
                        break;
                    }
                }
            }

            Assert.True(addHandle.HasValue, "expected to find Add on IAdd");
            var add = reader.GetMethodDefinition(addHandle.Value);
            var attrs = add.Attributes;
            Assert.True((attrs & MethodAttributes.Static) != 0, "static-virtual must be static");
            Assert.True((attrs & MethodAttributes.Virtual) != 0, "static-virtual must be virtual");
            Assert.True((attrs & MethodAttributes.Abstract) != 0, "abstract form must carry Abstract flag");
            Assert.Equal(0, add.RelativeVirtualAddress);
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void StaticVirtualDefault_InterfaceMetadata_VirtualNotAbstract()
    {
        var source = """
            package Probe
            import System

            sealed interface IZero {
                static func Zero() int32 { return 0 }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            MethodDefinitionHandle? handle = null;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                if (!reader.StringComparer.Equals(td.Name, "IZero"))
                {
                    continue;
                }

                foreach (var mh in td.GetMethods())
                {
                    var md = reader.GetMethodDefinition(mh);
                    if (reader.StringComparer.Equals(md.Name, "Zero"))
                    {
                        handle = mh;
                        break;
                    }
                }
            }

            Assert.True(handle.HasValue);
            var m = reader.GetMethodDefinition(handle.Value);
            Assert.True((m.Attributes & MethodAttributes.Static) != 0);
            Assert.True((m.Attributes & MethodAttributes.Virtual) != 0);
            Assert.True((m.Attributes & MethodAttributes.Abstract) == 0, "default form must NOT be Abstract");
            Assert.True(m.RelativeVirtualAddress != 0, "default body must have a real RVA");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void Implementer_Emits_MethodImpl_PairingSlotAndImpl()
    {
        var source = """
            package Probe
            import System

            sealed interface IAdd {
                static func Add(a int32, b int32) int32
            }

            class Adder : IAdd {
                shared {
                    func Add(a int32, b int32) int32 { return a + b }
                }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            TypeDefinition? adder = null;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                if (reader.StringComparer.Equals(td.Name, "Adder"))
                {
                    adder = td;
                    break;
                }
            }

            Assert.True(adder.HasValue, "expected to find Adder TypeDef");
            var implsCollection = adder.Value.GetMethodImplementations();
            var impls = new List<MethodImplementationHandle>();
            foreach (var h in implsCollection)
            {
                impls.Add(h);
            }

            Assert.NotEmpty(impls);

            // Verify at least one MethodImpl row points the body to a static
            // method on Adder and the declaration to IAdd::Add.
            var found = false;
            foreach (var implHandle in impls)
            {
                var mi = reader.GetMethodImplementation(implHandle);
                if (mi.MethodBody.Kind != HandleKind.MethodDefinition || mi.MethodDeclaration.Kind != HandleKind.MethodDefinition)
                {
                    continue;
                }

                var body = reader.GetMethodDefinition((MethodDefinitionHandle)mi.MethodBody);
                var decl = reader.GetMethodDefinition((MethodDefinitionHandle)mi.MethodDeclaration);
                if (reader.StringComparer.Equals(body.Name, "Add") && reader.StringComparer.Equals(decl.Name, "Add"))
                {
                    Assert.True((body.Attributes & MethodAttributes.Static) != 0, "impl body must be static");
                    Assert.True((decl.Attributes & MethodAttributes.Abstract) != 0, "decl slot must be abstract");
                    found = true;
                    break;
                }
            }

            Assert.True(found, "expected MethodImpl pairing Adder.Add -> IAdd.Add");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void EndToEnd_GenericDispatch_RunsAndReturnsExpected()
    {
        // Full ADR-0089 happy path: interface declares an abstract static
        // method; a class implements via shared-block; a generic consumer
        // dispatches through `constrained. !!T  call`. Compile, run, and
        // confirm the runtime returns the implementer's body output.
        var source = """
            package Probe
            import System

            sealed interface IAdd {
                static func Add(a int32, b int32) int32
            }

            class Adder : IAdd {
                shared {
                    func Add(a int32, b int32) int32 { return a + b }
                }
            }

            func Compute[T IAdd](w T, a int32, b int32) int32 {
                return T.Add(a, b)
            }

            func Main() {
                Console.WriteLine(Compute(Adder{}, 3, 4))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void EndToEnd_DefaultBody_Inherited_WhenImplementerOmits()
    {
        // ADR-0089 §3.2: implementer that does NOT supply the static
        // override picks up the interface's default body at runtime. The
        // dispatch routes through a generic method so the witness-T
        // pattern handles type-arg inference (ADR-0087 R5/R6/R7).
        var source = """
            package Probe
            import System

            sealed interface IGreet {
                static func Hello() string { return "default-hello" }
            }

            class Quiet : IGreet {
            }

            func Use[T IGreet](w T) string {
                return T.Hello()
            }

            func Main() {
                Console.WriteLine(Use(Quiet{}))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("default-hello\n", output);
    }

    [Fact]
    public void CrossLanguage_CsharpConsumer_CallsGSharpStaticVirtual()
    {
        // A C# 11 consumer must be able to use a G#-declared static-virtual
        // interface: declare a struct/class that implements the interface
        // via the standard C# `static` member shape, and dispatch through
        // the interface's static-virtual slot in a generic method.
        var gsource = """
            package Probe
            import System

            public sealed interface IAdd {
                static func Add(a int32, b int32) int32
            }

            public class Adder : IAdd {
                shared {
                    func Add(a int32, b int32) int32 { return a + b }
                }
            }
            """;

        var consumerCs = """
            using System;
            using Probe;

            class Program
            {
                static int Sum<T>(T w, int a, int b) where T : IAdd
                {
                    _ = w;
                    return T.Add(a, b);
                }

                static int Main()
                {
                    Console.WriteLine(Sum(new Adder(), 10, 32));
                    return 0;
                }
            }
            """;

        var output = CompileGsharpLibAndRunCsharpConsumer(gsource, consumerCs);
        Assert.Equal("42\n", output);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_svim_lib_").FullName;
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

        IlVerifier.Verify(outPath, ignoredErrorCodes: IlVerifier.KnownIssues.StaticVirtualInterface);
        return outPath;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_svim_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
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

            IlVerifier.Verify(dllPath, ignoredErrorCodes: IlVerifier.KnownIssues.StaticVirtualInterface);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

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

    private static string CompileGsharpLibAndRunCsharpConsumer(string gsource, string csource)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_svim_xlang_").FullName;
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

            IlVerifier.Verify(gDllPath, ignoredErrorCodes: IlVerifier.KnownIssues.StaticVirtualInterface);

            // Step 2: scaffold a C# console consumer.
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
                    <LangVersion>preview</LangVersion>
                    <RunAnalyzers>false</RunAnalyzers>
                    <EnableNETAnalyzers>false</EnableNETAnalyzers>
                    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
                  </PropertyGroup>
                  <ItemGroup>
                    <Reference Include="Probe">
                      <HintPath>{gDllPath}</HintPath>
                    </Reference>
                  </ItemGroup>
                </Project>
                """);

            RunDotnet(csDir, "restore");
            _ = RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore", "/p:RunAnalyzers=false", "/p:TreatWarningsAsErrors=false");

            var consumerDll = Path.Combine(csDir, "bin", "Release", "net10.0", "Consumer.dll");
            Assert.True(File.Exists(consumerDll), $"consumer not found at {consumerDll}");

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
