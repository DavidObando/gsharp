// <copyright file="NullablePropertyEmitTests.cs" company="GSharp">
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
/// Issue #504 regression tests: reading/writing a CLR property whose declared
/// type is <c>Nullable&lt;T&gt;</c> (e.g. <c>bool?</c>, <c>int?</c>) must emit
/// verifiable IL and execute without
/// <c>System.InvalidProgramException</c>.
///
/// Each test builds a small CLR library in-process via
/// <see cref="PersistedAssemblyBuilder"/> exposing <c>Probe.Settings</c> with
/// <c>bool? Flag</c> and <c>int? Count</c> auto-properties, then compiles a
/// GSharp program that exercises the assignment/read paths and runs it.
/// </summary>
public class NullablePropertyEmitTests
{
    [Fact]
    public void Set_BoolProperty_FromBoolLiteral_IsVerifiable()
    {
        var source = """
            package P

            import System
            import Probe

            var s = Settings()
            s.Flag = false
            var o object = s.Flag
            Console.WriteLine(o)
            s.Flag = true
            var o2 object = s.Flag
            Console.WriteLine(o2)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nTrue\n", output);
    }

    [Fact]
    public void Set_BoolProperty_FromNilLiteral_IsVerifiable()
    {
        // Boxing a `Nullable<bool>` with HasValue == false yields the CLR
        // null reference. Console.Write(null) writes the empty string, so
        // bracket the output to make the null/non-null distinction visible
        // (G#'s `==` is undefined for `object` against `nil`, so we cannot
        // assert in-program).
        var source = """
            package P

            import System
            import Probe

            var s = Settings()
            s.Flag = nil
            var o object = s.Flag
            Console.Write("[")
            Console.Write(o)
            Console.WriteLine("]")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("[]\n", output);
    }

    [Fact]
    public void Set_BoolProperty_FromExplicitNullableCtor_IsVerifiable()
    {
        var source = """
            package P

            import System
            import Probe

            var s = Settings()
            s.Flag = Nullable[bool](true)
            var o object = s.Flag
            Console.WriteLine(o)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void RoundTrip_BoolProperty_TrueFalseNil_BoxesCorrectly()
    {
        var source = """
            package P

            import System
            import Probe

            var s = Settings()
            s.Flag = true
            var o1 object = s.Flag
            Console.WriteLine(o1)

            s.Flag = false
            var o2 object = s.Flag
            Console.WriteLine(o2)

            s.Flag = nil
            var o3 object = s.Flag
            Console.Write("[")
            Console.Write(o3)
            Console.WriteLine("]")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n[]\n", output);
    }

    [Fact]
    public void Read_BoolProperty_IntoLocal_IsVerifiable()
    {
        // Just reading `var v = s.Flag` (the second repro from #504) must
        // produce verifiable IL even when the value is never observed. Use
        // boxing afterwards so the local is alive for a real round-trip
        // assertion.
        var source = """
            package P

            import System
            import Probe

            var s = Settings()
            s.Flag = true
            var v = s.Flag
            var o object = v
            Console.WriteLine(o)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void RoundTrip_IntProperty_FromLiteralAndExplicitCtor()
    {
        var source = """
            package P

            import System
            import Probe

            var s = Settings()
            s.Count = 42
            var o1 object = s.Count
            Console.WriteLine(o1)

            s.Count = Nullable[int32](7)
            var o2 object = s.Count
            Console.WriteLine(o2)

            s.Count = nil
            var o3 object = s.Count
            Console.Write("[")
            Console.Write(o3)
            Console.WriteLine("]")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n7\n[]\n", output);
    }

    [Fact]
    public void ClrPropertyOfNullableReferenceType_AllowsNilComparison()
    {
        // Issue #504 related observation: a CLR property typed as a
        // reference type with `[NullableAttribute]` (e.g. C# `string?`
        // declared on a non-generic `[NullableContext]` class) must be
        // surfaced as a NullableTypeSymbol so `prop != nil` does not
        // surface GS0129. Probe.Settings.Name is declared as `string?`
        // by the in-process helper library below.
        var source = """
            package P

            import System
            import Probe

            var s = Settings()
            s.Name = "alice"
            if s.Name != nil {
                Console.WriteLine(s.Name)
            }
            s.Name = nil
            if s.Name == nil {
                Console.WriteLine("cleared")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("alice\ncleared\n", output);
    }

    /// <summary>
    /// Compiles the supplied GSharp source against an in-process
    /// <c>Probe.Settings</c> CLR library, IL-verifies the produced assembly,
    /// then runs it with <c>dotnet exec</c> and returns stdout. The Probe
    /// library and the host's BCL <c>System.*</c> assemblies are all passed
    /// via <c>/r:</c> so <c>import System</c> resolves (issue #504 tests
    /// always reference a user assembly, which forces the host BCL closure
    /// to be enumerated explicitly).
    /// </summary>
    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_nullable_prop_").FullName;
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

                // GS9100 is advisory: the per-test Probe library only links
                // against System.Private.CoreLib, but the host BCL closure
                // routinely pulls in extras (System.Drawing.Common etc.) that
                // tests never touch. Suppress so the diagnostic doesn't
                // pollute compile output assertions.
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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    /// <summary>
    /// Emits a minimal <c>ProbeLib.dll</c> exposing
    /// <c>Probe.Settings { public bool? Flag; public int? Count }</c> via
    /// <see cref="PersistedAssemblyBuilder"/>. Building in-process avoids
    /// spawning <c>dotnet build</c> for the helper library and keeps tests
    /// hermetic.
    /// </summary>
    private static void BuildProbeLibrary(string dllPath)
    {
        var coreAssembly = typeof(object).Assembly;

        var asmName = new AssemblyName("ProbeLib") { Version = new Version(1, 0, 0, 0) };
        var asmBuilder = new PersistedAssemblyBuilder(asmName, coreAssembly);
        var moduleBuilder = asmBuilder.DefineDynamicModule("ProbeLib");

        var typeBuilder = moduleBuilder.DefineType(
            "Probe.Settings",
            TypeAttributes.Public | TypeAttributes.Class | TypeAttributes.AutoLayout | TypeAttributes.BeforeFieldInit,
            parent: typeof(object));

        EmitAutoProperty(typeBuilder, "Flag", typeof(bool?));
        EmitAutoProperty(typeBuilder, "Count", typeof(int?));
        EmitAutoProperty(typeBuilder, "Name", typeof(string), referenceTypeIsNullable: true);

        // Parameterless ctor that chains to object::.ctor — required for
        // `Settings()` to be valid IL when invoked from GSharp.
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

    private static void EmitAutoProperty(TypeBuilder typeBuilder, string name, Type clrType, bool referenceTypeIsNullable = false)
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

        if (referenceTypeIsNullable && !clrType.IsValueType)
        {
            // Emit `[NullableAttribute((byte)2)]` on the property so the
            // GSharp binder surfaces the property type as a
            // NullableTypeSymbol over the reference type (issue #209 /
            // #504 follow-up). The single-byte ctor matches what csc emits
            // for a top-level `T?` annotation.
            var nullableAttrType = typeof(object).Assembly
                .GetType("System.Runtime.CompilerServices.NullableAttribute", throwOnError: false);
            if (nullableAttrType != null)
            {
                var ctorByte = nullableAttrType.GetConstructor(new[] { typeof(byte) });
                if (ctorByte != null)
                {
                    property.SetCustomAttribute(new CustomAttributeBuilder(ctorByte, new object[] { (byte)2 }));
                }
            }
        }

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

        var setter = typeBuilder.DefineMethod(
            "set_" + name,
            accessorAttrs,
            returnType: null,
            parameterTypes: new[] { clrType });
        var setterIl = setter.GetILGenerator();
        setterIl.Emit(OpCodes.Ldarg_0);
        setterIl.Emit(OpCodes.Ldarg_1);
        setterIl.Emit(OpCodes.Stfld, field);
        setterIl.Emit(OpCodes.Ret);

        property.SetGetMethod(getter);
        property.SetSetMethod(setter);
    }

    /// <summary>
    /// Host BCL assemblies passed via <c>/r:</c> so <c>import System</c>
    /// resolves when the test program also references a user-supplied
    /// library. Mirrors <see cref="IlVerifier"/>'s runtime-reference
    /// discovery.
    /// </summary>
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
