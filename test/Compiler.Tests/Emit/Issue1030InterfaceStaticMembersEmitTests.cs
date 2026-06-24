// <copyright file="Issue1030InterfaceStaticMembersEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0089 / issue #1030 — interface static *state* and default-bodied
/// static-virtual interface *properties* (follow-up to #1019). Validates the
/// CLR emit shape end-to-end:
/// <list type="bullet">
///   <item>interface <c>var</c>/<c>let</c> fields emit <c>Static</c> FieldDef
///     rows on the interface TypeDef; <c>const</c> fields emit
///     <c>Static | Literal | HasDefault</c> rows with a <c>Constant</c> row;</item>
///   <item>field initializers run in a synthesized interface <c>.cctor</c>;</item>
///   <item>a default-bodied static-virtual interface property getter is emitted
///     as <c>Static | Virtual</c> (non-abstract) with a real IL body.</item>
/// </list>
/// Runtime execution and IL verification are covered.
/// </summary>
public class Issue1030InterfaceStaticMembersEmitTests
{
    [Fact]
    public void InterfaceStaticState_EmitsStaticAndLiteralFieldDefs()
    {
        var source = """
            package Probe
            import System

            interface ICounter {
                shared {
                    var Count int32
                    let Label string = "c"
                    const Max int32 = 100
                }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            var sawCount = false;
            var sawLabel = false;
            var sawMax = false;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                if (!reader.StringComparer.Equals(td.Name, "ICounter"))
                {
                    continue;
                }

                foreach (var fh in td.GetFields())
                {
                    var fd = reader.GetFieldDefinition(fh);
                    var name = reader.GetString(fd.Name);
                    var attrs = fd.Attributes;
                    if (name == "Count")
                    {
                        sawCount = (attrs & FieldAttributes.Static) != 0
                            && (attrs & FieldAttributes.Literal) == 0;
                    }

                    if (name == "Label")
                    {
                        sawLabel = (attrs & FieldAttributes.Static) != 0;
                    }

                    if (name == "Max")
                    {
                        sawMax = (attrs & FieldAttributes.Static) != 0
                            && (attrs & FieldAttributes.Literal) != 0
                            && (attrs & FieldAttributes.HasDefault) != 0;
                    }
                }
            }

            Assert.True(sawCount, "ICounter.Count must be a non-literal Static FieldDef");
            Assert.True(sawLabel, "ICounter.Label must be a Static FieldDef");
            Assert.True(sawMax, "ICounter.Max must be a Static|Literal|HasDefault FieldDef");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void EndToEnd_InterfaceStaticState_ReadWriteAndInitializers_Runs()
    {
        var source = """
            package Probe
            import System

            interface ICounter {
                shared {
                    var Count int32 = 10
                    let Label string = "counter"
                    const Max int32 = 100
                }
            }

            func Main() {
                Console.WriteLine(ICounter.Count)
                Console.WriteLine(ICounter.Label)
                Console.WriteLine(ICounter.Max)
                ICounter.Count = ICounter.Count + 5
                Console.WriteLine(ICounter.Count)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\ncounter\n100\n15\n", output);
    }

    [Fact]
    public void EndToEnd_InterfaceStaticState_SharedAcrossConstraintDispatch_Runs()
    {
        // Default-bodied static methods on the interface mutate/read the
        // interface's static field by bare name; a generic consumer dispatches
        // through the constraint. The state is shared on the interface.
        var source = """
            package Probe
            import System

            sealed interface ICounter {
                shared {
                    var Count int32 = 0
                    func Bump() {
                        Count = Count + 1
                    }
                    func Get() int32 {
                        return Count
                    }
                }
            }

            struct C : ICounter {
            }

            func Run[T ICounter](witness T) int32 {
                T.Bump()
                T.Bump()
                T.Bump()
                return T.Get()
            }

            func Main() {
                Console.WriteLine(Run(C{}))
                Console.WriteLine(ICounter.Count)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n3\n", output);
    }

    [Fact]
    public void DefaultBodiedStaticProperty_GetterIsStaticVirtualNonAbstractWithBody()
    {
        var source = """
            package Probe
            import System

            sealed interface IData {
                shared {
                    prop Name string { get { return "default" } }
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
                    if (reader.StringComparer.Equals(md.Name, "get_Name"))
                    {
                        getterHandle = mh;
                    }
                }

                Assert.NotEmpty(td.GetProperties());
            }

            Assert.True(getterHandle.HasValue, "expected to find get_Name on IData");
            var getter = reader.GetMethodDefinition(getterHandle.Value);
            var attrs = getter.Attributes;
            Assert.True((attrs & MethodAttributes.Static) != 0, "default static property getter must be static");
            Assert.True((attrs & MethodAttributes.Virtual) != 0, "default static property getter must be virtual");
            Assert.True((attrs & MethodAttributes.Abstract) == 0, "default slot must NOT carry Abstract");
            Assert.True((attrs & MethodAttributes.SpecialName) != 0, "accessor must be SpecialName");
            Assert.NotEqual(0, getter.RelativeVirtualAddress);
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void EndToEnd_DefaultBodiedStaticProperty_DefaultAndOverride_Runs()
    {
        // The implementer that omits the property uses the interface default;
        // the implementer that provides one overrides it.
        var source = """
            package Probe
            import System

            sealed interface IData {
                shared {
                    prop Name string { get { return "default-name" } }
                }
            }

            struct Apple : IData {
            }

            struct Banana : IData {
                shared {
                    prop Name string { get { return "banana" } }
                }
            }

            func Describe[T IData](witness T) string {
                return T.Name
            }

            func Main() {
                Console.WriteLine(Describe(Apple{}))
                Console.WriteLine(Describe(Banana{}))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("default-name\nbanana\n", output);
    }

    [Fact]
    public void GenericInterfaceStaticState_EmitsStaticAndLiteralFieldDefs()
    {
        // Issue #1030 (deferred work): a *generic* interface may own static
        // state. The FieldDef rows live on the generic interface TypeDef just
        // like the non-generic case.
        var source = """
            package Probe
            import System

            interface IBox[T] {
                shared {
                    var Count int32
                    const Max int32 = 7
                }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            var sawCount = false;
            var sawMax = false;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                if (!reader.StringComparer.Equals(td.Name, "IBox`1"))
                {
                    continue;
                }

                foreach (var fh in td.GetFields())
                {
                    var fd = reader.GetFieldDefinition(fh);
                    var name = reader.GetString(fd.Name);
                    var attrs = fd.Attributes;
                    if (name == "Count")
                    {
                        sawCount = (attrs & FieldAttributes.Static) != 0
                            && (attrs & FieldAttributes.Literal) == 0;
                    }

                    if (name == "Max")
                    {
                        sawMax = (attrs & FieldAttributes.Static) != 0
                            && (attrs & FieldAttributes.Literal) != 0;
                    }
                }
            }

            Assert.True(sawCount, "expected a Static (non-literal) Count FieldDef on IBox`1");
            Assert.True(sawMax, "expected a Static | Literal Max FieldDef on IBox`1");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void EndToEnd_GenericInterfaceStaticState_IndependentStoragePerConstruction_Runs()
    {
        // CLR semantics: a generic type owns one set of static fields per closed
        // construction, so IBox[int32] and IBox[string] have independent storage.
        var source = """
            package Probe
            import System

            interface IBox[T] {
                shared {
                    var Count int32 = 10
                    let Label string = "box"
                    const Max int32 = 99
                }
            }

            func Main() {
                Console.WriteLine(IBox[int32].Count)
                Console.WriteLine(IBox[int32].Label)
                Console.WriteLine(IBox[int32].Max)
                IBox[int32].Count = IBox[int32].Count + 5
                IBox[string].Count = IBox[string].Count + 100
                Console.WriteLine(IBox[int32].Count)
                Console.WriteLine(IBox[string].Count)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\nbox\n99\n15\n110\n", output);
    }

    [Fact]
    public void EndToEnd_GenericInterfaceStaticState_CompoundAssignment_Runs()
    {
        // Issue #1030 (deferred work): compound assignment on a generic
        // interface static field, per construction.
        var source = """
            package Probe
            import System

            interface IBox[T] {
                shared {
                    var Count int32 = 0
                }
            }

            func Main() {
                IBox[int32].Count += 7
                IBox[int32].Count -= 2
                IBox[string].Count += 1
                Console.WriteLine(IBox[int32].Count)
                Console.WriteLine(IBox[string].Count)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n1\n", output);
    }

    [Fact]
    public void EndToEnd_InterfaceStaticField_CompoundAssignment_Runs()
    {
        // Issue #1030 (deferred work): compound assignment (`+=` / `-=`) on a
        // non-generic interface static field.
        var source = """
            package Probe
            import System

            interface ICounter {
                shared {
                    var Count int32 = 10
                }
            }

            func Main() {
                ICounter.Count += 5
                ICounter.Count -= 2
                Console.WriteLine(ICounter.Count)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("13\n", output);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1030_lib_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_1030_exe_").FullName;
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
