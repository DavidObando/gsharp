// <copyright file="Issue2362ExplicitInterfacePropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2362: extends the issue #2010/#2181 explicit-interface-METHOD
/// <c>func (IFoo) M(...)</c> qualifier clause (ADR-0149) + CLR
/// <c>MethodImpl</c> bridge to PROPERTIES (and, via a collision-drop-only
/// fallback, indexers). A property declared with the <c>prop (IFoo) P T</c>
/// qualifier clause is linked by the binder to the specific interface
/// property it implements
/// (<see cref="GSharp.Core.CodeAnalysis.Symbols.PropertySymbol.ExplicitInterfaceMember"/>)
/// and the emitter binds a CLR <c>MethodImpl</c> row per accessor (getter
/// and/or setter) via <c>ReflectionMetadataEmitter.EmitExplicitInterfacePropertyMethodImpls</c>,
/// mirroring <c>EmitStaticVirtualPropertyMethodImpls</c> (ADR-0089/#1019). The
/// declared member name stays the plain source name (e.g. <c>Greeting</c>)
/// for both the public and explicit property — only the synthesized CLR
/// metadata name (<c>&lt;Package&gt;.&lt;Interface&gt;.&lt;Member&gt;</c>,
/// e.g. <c>GapCheck.IGreeter.Greeting</c>, and likewise for its
/// <c>get_</c>/<c>set_</c> accessors) differs, keeping the rows
/// collision-free.
/// </summary>
public class Issue2362ExplicitInterfacePropertyEmitTests
{
    private const string GetOnlyReproSource = """
        package GapCheck

        interface IGreeter {
            prop Greeting string { get; }
        }

        class Host : IGreeter {
            prop Greeting string -> "public-hi"

            private prop (IGreeter) Greeting string -> "explicit-hi"
        }
        """;

    [Fact]
    public void GetOnlyExplicitPropertyImpl_Compiles_EmitsMethodImplRow_IlVerifies()
    {
        var dllPath = CompileLibrary(GetOnlyReproSource);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            TypeDefinition host = FindType(reader, "Host");

            int getterCount = CountMethodsNamed(reader, host, "GapCheck.IGreeter.get_Greeting");
            Assert.Equal(1, getterCount);

            int methodImplRows = CountMethodImplRows(reader, host);
            Assert.Equal(1, methodImplRows);
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void GetOnlyExplicitPropertyImpl_DispatchesToOwnBodyThroughInterface()
    {
        var source = GetOnlyReproSource + """


            var obj = Host{}
            var asIface IGreeter = obj
            Console.WriteLine(obj.Greeting)
            Console.WriteLine(asIface.Greeting)
            """;

        Assert.Equal("public-hi\nexplicit-hi\n", CompileAndRun(source));
    }

    private const string GetSetReproSource = """
        package GapCheck

        interface ICounter {
            prop Count int32 { get; set; }
        }

        class Counter : ICounter {
            prop Count int32 { get; set; }

            private prop (ICounter) Count int32 {
                get { return Count * 10 }
                set { Count = value }
            }
        }
        """;

    [Fact]
    public void GetSetExplicitPropertyImpl_Compiles_EmitsTwoMethodImplRows_IlVerifies()
    {
        var dllPath = CompileLibrary(GetSetReproSource);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            TypeDefinition counter = FindType(reader, "Counter");

            Assert.Equal(1, CountMethodsNamed(reader, counter, "GapCheck.ICounter.get_Count"));
            Assert.Equal(1, CountMethodsNamed(reader, counter, "GapCheck.ICounter.set_Count"));

            // One MethodImpl row per accessor (getter + setter).
            Assert.Equal(2, CountMethodImplRows(reader, counter));
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void GetSetExplicitPropertyImpl_DispatchesThroughInterface_GetAndSet()
    {
        var source = GetSetReproSource + """


            var obj = Counter{ Count: 5 }
            var asIface ICounter = obj
            Console.WriteLine(asIface.Count)
            asIface.Count = 7
            Console.WriteLine(obj.Count)
            """;

        // The explicit getter returns Count * 10 (50); the explicit setter
        // writes straight through to Count (7) — proving both accessors
        // dispatch to the mangled property's own distinct bodies, not the
        // public sibling's.
        Assert.Equal("50\n7\n", CompileAndRun(source));
    }

    private const string GenericInterfaceReproSource = """
        package GapCheck

        interface IBox[T] {
            prop Value T { get; }
        }

        class IntBox : IBox[int32] {
            prop Value int32 -> 42

            private prop (IBox[int32]) Value int32 -> 99
        }
        """;

    [Fact]
    public void GenericInterfaceExplicitPropertyImpl_Compiles_EmitsMethodImplRow_IlVerifies()
    {
        var dllPath = CompileLibrary(GenericInterfaceReproSource);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            TypeDefinition intBox = FindType(reader, "IntBox");

            Assert.Equal(1, CountMethodsNamed(reader, intBox, "GapCheck.IBox[int32].get_Value"));
            Assert.Equal(1, CountMethodImplRows(reader, intBox));
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    // NOTE: a runtime-dispatch-through-the-interface variant of this test
    // (`var asIface IBox[int32] = obj; Console.WriteLine(asIface.Value)`) was
    // attempted but hits a PRE-EXISTING, unrelated binder gap: member access
    // through a variable typed as a *constructed* generic interface
    // (`IBox[int32]`) fails to resolve (`GS0158: Cannot find member Value`)
    // even with NO explicit interface implementation involved at all. This
    // reproduces identically on a plain `interface IBox[T] { prop Value T {
    // get; } } / class IntBox : IBox[int32] { prop Value int32 -> 42 }` with
    // no mangled member present, so it is unrelated to this fix and is left
    // as a separate, pre-existing, known gap. The IL-level test above still
    // confirms the emitter correctly binds the MethodImpl row for the
    // generic-interface case (mirroring the #2181 generic-method fix), which
    // is the part in scope for #2362.

    /// <summary>
    /// The exact Oahu <c>Profile</c>/<c>IProfile</c> shape (see
    /// <c>src/Oahu.Core/Interfaces.cs</c> and <c>src/Oahu.Core/Profile.cs</c>):
    /// four get-only explicit interface property implementations, each
    /// coexisting with a same-named public concrete property, dispatching
    /// through the interface to their own distinct body. This is the primary
    /// real-world regression this fix addresses.
    /// </summary>
    private const string OahuProfileReproSource = """
        package Oahu.Core

        class Authorization { }
        class Token { }

        interface IProfile {
            prop Authorization Authorization { get; }
            prop Token Token { get; }
        }

        class Profile : IProfile {
            prop Authorization Authorization { get; set; }
            prop Token Token { get; set; }

            private prop (IProfile) Authorization Authorization -> Authorization
            private prop (IProfile) Token Token -> Token
        }
        """;

    [Fact]
    public void OahuProfileShape_Compiles_EmitsFourQualifiedPropertiesAndMethodImplRows_IlVerifies()
    {
        var dllPath = CompileLibrary(OahuProfileReproSource);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            TypeDefinition profile = FindType(reader, "Profile");

            Assert.Equal(1, CountMethodsNamed(reader, profile, "Oahu.Core.IProfile.get_Authorization"));
            Assert.Equal(1, CountMethodsNamed(reader, profile, "Oahu.Core.IProfile.get_Token"));
            Assert.Equal(1, CountMethodsNamed(reader, profile, "get_Authorization"));
            Assert.Equal(1, CountMethodsNamed(reader, profile, "get_Token"));

            // Two get-only explicit properties => two MethodImpl rows.
            Assert.Equal(2, CountMethodImplRows(reader, profile));
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void OahuProfileShape_DispatchesToOwnBodiesThroughInterface()
    {
        var source = OahuProfileReproSource + """


            var auth = Authorization{}
            var token = Token{}
            var obj = Profile{ Authorization: auth, Token: token }
            var asIface IProfile = obj
            Console.WriteLine(object(asIface.Authorization) == object(auth))
            Console.WriteLine(object(asIface.Token) == object(token))
            """;

        Assert.Equal("True\nTrue\n", CompileAndRun(source));
    }

    private static TypeDefinition FindType(MetadataReader reader, string name)
    {
        foreach (var typeHandle in reader.TypeDefinitions)
        {
            var td = reader.GetTypeDefinition(typeHandle);
            if (reader.GetString(td.Name) == name)
            {
                return td;
            }
        }

        throw new InvalidOperationException($"expected to find the {name} type");
    }

    private static int CountMethodsNamed(MetadataReader reader, TypeDefinition type, string name)
    {
        int count = 0;
        foreach (var mh in type.GetMethods())
        {
            var md = reader.GetMethodDefinition(mh);
            if (reader.GetString(md.Name) == name)
            {
                count++;
            }
        }

        return count;
    }

    private static int CountMethodImplRows(MetadataReader reader, TypeDefinition type)
    {
        int count = 0;
        foreach (var miHandle in type.GetMethodImplementations())
        {
            reader.GetMethodImplementation(miHandle);
            count++;
        }

        return count;
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2362_lib_").FullName;
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

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2362_exe_").FullName;
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

            IlVerifier.Verify(dllPath);

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
