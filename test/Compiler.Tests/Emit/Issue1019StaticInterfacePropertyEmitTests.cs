// <copyright file="Issue1019StaticInterfacePropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0089 / issue #1019 — static-virtual interface *properties*. Validates
/// the CLR emit shape end-to-end: the interface TypeDef carries a
/// <c>get_Name</c> accessor with <c>Static | Virtual | Abstract</c>, plus a
/// <c>Property</c> row; the implementer's static property accessor is paired
/// to the slot via a <c>MethodImpl</c> row; and a generic consumer reads the
/// property through the constraint via <c>constrained. !!T  call</c>. Runtime
/// execution and IL verification (with the known static-virtual ilverify
/// suppression) are covered.
/// </summary>
public class Issue1019StaticInterfacePropertyEmitTests
{
    [Fact]
    public void StaticAbstractProperty_InterfaceMetadata_GetterIsStaticVirtualAbstract()
    {
        var source = """
            package Probe
            import System

            sealed interface IData {
                shared {
                    prop SizeInBytes int32 { get; }
                }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            MethodDefinitionHandle? getterHandle = null;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                if (!reader.StringComparer.Equals(td.Name, "IData"))
                {
                    continue;
                }

                foreach (var mh in td.GetMethods())
                {
                    var md = reader.GetMethodDefinition(mh);
                    if (reader.StringComparer.Equals(md.Name, "get_SizeInBytes"))
                    {
                        getterHandle = mh;
                    }
                }

                Assert.NotEmpty(td.GetProperties());
            }

            Assert.True(getterHandle.HasValue, "expected to find get_SizeInBytes on IData");
            var getter = reader.GetMethodDefinition(getterHandle.Value);
            var attrs = getter.Attributes;
            Assert.True((attrs & System.Reflection.MethodAttributes.Static) != 0, "static-virtual property getter must be static");
            Assert.True((attrs & System.Reflection.MethodAttributes.Virtual) != 0, "static-virtual property getter must be virtual");
            Assert.True((attrs & System.Reflection.MethodAttributes.Abstract) != 0, "abstract slot must carry Abstract flag");
            Assert.True((attrs & System.Reflection.MethodAttributes.SpecialName) != 0, "accessor must be SpecialName");
            Assert.Equal(0, getter.RelativeVirtualAddress);
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void StaticAbstractProperty_Implementer_HasMethodImplForGetter()
    {
        var source = """
            package Probe
            import System

            sealed interface IData {
                shared {
                    prop SizeInBytes int32 { get; }
                }
            }

            struct AppleData : IData {
                shared {
                    prop SizeInBytes int32 { get { return 8 } }
                }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            var sawMethodImpl = false;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                if (!reader.StringComparer.Equals(td.Name, "AppleData"))
                {
                    continue;
                }

                foreach (var mih in td.GetMethodImplementations())
                {
                    var mi = reader.GetMethodImplementation(mih);

                    string DeclName(EntityHandle h)
                    {
                        if (h.Kind == HandleKind.MethodDefinition)
                        {
                            return reader.GetString(reader.GetMethodDefinition((MethodDefinitionHandle)h).Name);
                        }

                        if (h.Kind == HandleKind.MemberReference)
                        {
                            return reader.GetString(reader.GetMemberReference((MemberReferenceHandle)h).Name);
                        }

                        return string.Empty;
                    }

                    if (DeclName(mi.MethodDeclaration) == "get_SizeInBytes"
                        && DeclName(mi.MethodBody) == "get_SizeInBytes")
                    {
                        sawMethodImpl = true;
                    }
                }
            }

            Assert.True(sawMethodImpl, "expected a MethodImpl pairing AppleData.get_SizeInBytes to IData.get_SizeInBytes");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void EndToEnd_GenericReadThroughConstraint_RunsAndReturnsExpected()
    {
        // The headline ADR-0089/#1019 path: an interface declares an abstract
        // static property; a struct implements it; a generic consumer reads
        // the property through the constraint via `constrained. !!T  call`.
        var source = """
            package Probe
            import System

            sealed interface IData {
                shared {
                    prop Name string { get; }
                }
            }

            struct AppleData : IData {
                shared {
                    prop Name string { get { return "apple" } }
                }
            }

            func Describe[T IData](witness T) string {
                return T.Name
            }

            func Main() {
                Console.WriteLine(Describe(AppleData{}))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("apple\n", output);
    }

    [Fact]
    public void EndToEnd_GetSetProperty_BothAccessorsAbstractStaticVirtual()
    {
        var source = """
            package Probe
            import System

            sealed interface IData {
                shared {
                    prop Tag int32 { get; set }
                }
            }

            struct Box : IData {
                shared {
                    var Stored int32
                    prop Tag int32 { get { return Box.Stored } set { Box.Stored = value } }
                }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            var foundGetter = false;
            var foundSetter = false;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                if (!reader.StringComparer.Equals(td.Name, "IData"))
                {
                    continue;
                }

                foreach (var mh in td.GetMethods())
                {
                    var md = reader.GetMethodDefinition(mh);
                    var name = reader.GetString(md.Name);
                    var attrs = md.Attributes;
                    var isStaticVirtualAbstract =
                        (attrs & System.Reflection.MethodAttributes.Static) != 0
                        && (attrs & System.Reflection.MethodAttributes.Virtual) != 0
                        && (attrs & System.Reflection.MethodAttributes.Abstract) != 0;

                    if (name == "get_Tag")
                    {
                        foundGetter = isStaticVirtualAbstract;
                    }

                    if (name == "set_Tag")
                    {
                        foundSetter = isStaticVirtualAbstract;
                    }
                }
            }

            Assert.True(foundGetter, "get_Tag must be Static|Virtual|Abstract");
            Assert.True(foundSetter, "set_Tag must be Static|Virtual|Abstract");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_sviprop_lib_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_sviprop_exe_").FullName;
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
