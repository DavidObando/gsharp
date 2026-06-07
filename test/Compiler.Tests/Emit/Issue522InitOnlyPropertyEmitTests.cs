// <copyright file="Issue522InitOnlyPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #522 regression tests. Two facets are exercised end-to-end:
///   * Facet 1 — plain assignment to a CLR <c>init</c>-only property must
///     emit IL whose setter reference carries the
///     <c>modreq(IsExternalInit)</c> signature; previously the modreq was
///     dropped and the runtime failed with <c>MissingMethodException</c>.
///   * Facet 2 — the C#-style object initializer suffix
///     <c>T(args) { Prop1 = v1, … }</c> must parse, bind, and execute,
///     covering init-only and regular setters, the zero-property degenerate,
///     and a writable-field regression guard.
/// Each test builds a hermetic <c>ProbeLib.dll</c> in-process with
/// <see cref="PersistedAssemblyBuilder"/>, compiles a small G# program
/// against it, ilverifies the produced assembly, and runs it with
/// <c>dotnet exec</c>.
/// </summary>
public class Issue522InitOnlyPropertyEmitTests
{
    [Fact]
    public void PlainAssignment_ToInitOnlyProperty_RunsWithoutMissingMethodException()
    {
        // Facet 1: the emitter previously dropped modreq(IsExternalInit) on
        // the setter return parameter, so the runtime couldn't resolve
        // set_Asin and threw MissingMethodException.
        var source = """
            package P

            import System
            import Probe

            var w = WithInit()
            w.Asin = "X"
            Console.WriteLine(w.Asin)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("X\n", output);
    }

    [Fact]
    public void ObjectInitializer_SetsInitOnlyAndRegularProperties()
    {
        // Facet 2: object initializer suffix lowers to a synthetic local plus
        // a chain of property assignments. Mixes init-only (Asin) and regular
        // set (Title) — both reach their setters on the constructed instance.
        var source = """
            package P

            import System
            import Probe

            var w = WithInit() { Asin = "Y", Title = "T" }
            Console.WriteLine(w.Asin)
            Console.WriteLine(w.Title)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Y\nT\n", output);
    }

    [Fact]
    public void ObjectInitializer_ZeroProperties_IsDegenerateButLegal()
    {
        var source = """
            package P

            import System
            import Probe

            var w = WithInit() { }
            Console.WriteLine(w.Asin)
            """;

        var output = CompileAndRun(source);

        // Asin defaults to null because the auto-property backing field is
        // never assigned. Console.WriteLine renders that as an empty line.
        Assert.Equal("\n", output);
    }

    [Fact]
    public void ObjectInitializer_SinglePropertyForm_Parses()
    {
        var source = """
            package P

            import System
            import Probe

            var w = WithInit() { Title = "only" }
            Console.WriteLine(w.Title)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("only\n", output);
    }

    [Fact]
    public void PlainAssignment_ToRegularSetterProperty_StillWorks()
    {
        // Regression guard: the modreq encoding now runs for every void
        // setter; this test pins that the no-modreq path still emits a
        // method reference the runtime can resolve.
        var source = """
            package P

            import System
            import Probe

            var w = WithInit()
            w.Title = "Z"
            Console.WriteLine(w.Title)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Z\n", output);
    }

    /// <summary>
    /// Compiles the supplied G# source against an in-process
    /// <c>Probe.WithInit</c> CLR library, IL-verifies the produced
    /// assembly, then runs it with <c>dotnet exec</c> and returns stdout.
    /// </summary>
    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue522_").FullName;
        try
        {
            var probeDllPath = Path.Combine(tempDir, "ProbeLib.dll");
            BuildProbeLibrary(probeDllPath);

            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                "/r:" + probeDllPath,
            };

            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
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

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath, additionalReferences: new[] { probeDllPath });

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

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
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // Best-effort cleanup; the OS will reclaim per-test scratch
                // directories on the next reboot.
            }
        }
    }

    /// <summary>
    /// Emits a minimal <c>ProbeLib.dll</c> exposing
    /// <c>Probe.WithInit { public string Asin { get; init; } public string Title { get; set; } }</c>.
    /// The init-only accessor is materialised by tagging the setter's
    /// return-parameter with <c>modreq(System.Runtime.CompilerServices.IsExternalInit)</c>,
    /// matching what the C# compiler emits for a <c>{ init; }</c> accessor.
    /// </summary>
    private static void BuildProbeLibrary(string dllPath)
    {
        var coreAssembly = typeof(object).Assembly;

        var asmName = new AssemblyName("ProbeLib") { Version = new Version(1, 0, 0, 0) };
        var asmBuilder = new PersistedAssemblyBuilder(asmName, coreAssembly);
        var moduleBuilder = asmBuilder.DefineDynamicModule("ProbeLib");

        var typeBuilder = moduleBuilder.DefineType(
            "Probe.WithInit",
            TypeAttributes.Public | TypeAttributes.Class | TypeAttributes.AutoLayout | TypeAttributes.BeforeFieldInit,
            parent: typeof(object));

        EmitProperty(typeBuilder, "Asin", typeof(string), initOnly: true);
        EmitProperty(typeBuilder, "Title", typeof(string), initOnly: false);

        var ctor = typeBuilder.DefineConstructor(
            MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName | MethodAttributes.HideBySig,
            CallingConventions.Standard,
            Type.EmptyTypes);
        var ctorIl = ctor.GetILGenerator();
        ctorIl.Emit(OpCodes.Ldarg_0);
        ctorIl.Emit(OpCodes.Call, typeof(object).GetConstructor(Type.EmptyTypes)!);
        ctorIl.Emit(OpCodes.Ret);

        typeBuilder.CreateType();
        asmBuilder.Save(dllPath);
    }

    private static void EmitProperty(TypeBuilder typeBuilder, string name, Type clrType, bool initOnly)
    {
        var field = typeBuilder.DefineField(
            "<" + name + ">k__BackingField",
            clrType,
            FieldAttributes.Private);

        var property = typeBuilder.DefineProperty(
            name,
            PropertyAttributes.HasDefault,
            clrType,
            parameterTypes: null);

        const MethodAttributes accessorAttrs = MethodAttributes.Public
            | MethodAttributes.SpecialName
            | MethodAttributes.HideBySig;

        var getter = typeBuilder.DefineMethod(
            "get_" + name,
            accessorAttrs,
            clrType,
            Type.EmptyTypes);
        var getterIl = getter.GetILGenerator();
        getterIl.Emit(OpCodes.Ldarg_0);
        getterIl.Emit(OpCodes.Ldfld, field);
        getterIl.Emit(OpCodes.Ret);

        // Init-only setters carry modreq(IsExternalInit) on the void return
        // type. PersistedAssemblyBuilder.DefineMethod's overload taking
        // returnTypeRequiredCustomModifiers encodes this directly into the
        // method's metadata signature — which is exactly what set-property
        // reference resolution in the runtime uses to bind the call.
        var isExternalInit = coreOf(typeof(object)).GetType(
            "System.Runtime.CompilerServices.IsExternalInit",
            throwOnError: false);

        var returnRequiredMods = initOnly && isExternalInit != null
            ? new[] { isExternalInit }
            : Type.EmptyTypes;

        var setter = typeBuilder.DefineMethod(
            "set_" + name,
            accessorAttrs,
            CallingConventions.HasThis,
            returnType: null,
            returnTypeRequiredCustomModifiers: returnRequiredMods,
            returnTypeOptionalCustomModifiers: null,
            parameterTypes: new[] { clrType },
            parameterTypeRequiredCustomModifiers: null,
            parameterTypeOptionalCustomModifiers: null);
        var setterIl = setter.GetILGenerator();
        setterIl.Emit(OpCodes.Ldarg_0);
        setterIl.Emit(OpCodes.Ldarg_1);
        setterIl.Emit(OpCodes.Stfld, field);
        setterIl.Emit(OpCodes.Ret);

        property.SetGetMethod(getter);
        property.SetSetMethod(setter);
    }

    private static Assembly coreOf(Type t) => t.Assembly;

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}
