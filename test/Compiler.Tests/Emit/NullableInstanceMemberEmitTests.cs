// <copyright file="NullableInstanceMemberEmitTests.cs" company="GSharp">
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
/// Issue #517 — end-to-end emit + execute coverage for
/// <c>System.Nullable&lt;T&gt;</c>'s instance API surfaced through the binder
/// (<c>Value</c>, <c>HasValue</c>, <c>GetValueOrDefault()</c>,
/// <c>GetValueOrDefault(T)</c>). Each source compiles to a verifiable PE
/// (asserted via <c>ilverify</c>) and is then executed under
/// <c>dotnet exec</c>; the captured stdout is compared against the BCL's
/// semantics. The IL must take the receiver by managed pointer (the
/// instance methods on <c>Nullable&lt;T&gt;</c> require a <c>ref</c>
/// <c>this</c>), so this test also exercises the receiver-spill and
/// field-address paths the existing <c>!!</c> emitter relies on.
/// </summary>
public class NullableInstanceMemberEmitTests
{
    [Fact]
    public void Value_OnNullableInt32_Local_WithValue_ReturnsUnderlying()
    {
        var source = """
            package P

            import System

            var a Nullable[int32] = 42
            Console.WriteLine(a.Value)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void Value_OnNullableInt32_Local_WithoutValue_ThrowsInvalidOperation()
    {
        // `a.Value` on a nil-valued nullable must throw
        // InvalidOperationException — the same observable failure mode
        // produced by `!!` (issue #504) and by `Nullable<T>.Value` in C#.
        var source = """
            package P

            import System

            var a Nullable[int32] = nil
            var v = a.Value
            Console.WriteLine(v)
            """;

        var (exitCode, _, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("InvalidOperationException", stderr);
    }

    [Fact]
    public void HasValue_OnNullableInt32_Local_BothBranches_RoundTrip()
    {
        var source = """
            package P

            import System

            var a Nullable[int32] = 7
            Console.WriteLine(a.HasValue)

            var b Nullable[int32] = nil
            Console.WriteLine(b.HasValue)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void GetValueOrDefault_NoArg_OnNullableInt32_Local_BothBranches()
    {
        var source = """
            package P

            import System

            var a Nullable[int32] = 7
            Console.WriteLine(a.GetValueOrDefault())

            var b Nullable[int32] = nil
            Console.WriteLine(b.GetValueOrDefault())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n0\n", output);
    }

    [Fact]
    public void GetValueOrDefault_WithFallback_OnNullableInt32_Local_BothBranches()
    {
        var source = """
            package P

            import System

            var a Nullable[int32] = 7
            Console.WriteLine(a.GetValueOrDefault(99))

            var b Nullable[int32] = nil
            Console.WriteLine(b.GetValueOrDefault(99))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n99\n", output);
    }

    [Fact]
    public void Value_OnNullableBool_Local_BothLiterals()
    {
        var source = """
            package P

            import System

            var a Nullable[bool] = true
            Console.WriteLine(a.Value)

            var b Nullable[bool] = false
            Console.WriteLine(b.Value)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void HasValue_AndValue_OnNullableDateTime_NonPrimitiveStruct()
    {
        // Covers a non-primitive (8-byte trivially-blittable) struct: the
        // `Nullable<DateTime>` slot is larger than a `Nullable<int32>` and
        // exercises the `ldloca` + `call` path on a struct with managed
        // ref semantics. The DateTime value is built inside ProbeLib's
        // `MakeDate` helper so the test never depends on the still-open
        // source-side `var x Nullable[DateTime] = DateTime(...)` lifting
        // limitation tracked separately. Comparing whole-DateTime values
        // is brittle across machines; checking only HasValue + the Year
        // accessor (which is chained off `.Value` — a property access on
        // the unwrapped DateTime — exercises receiver chaining too).
        var source = """
            package P

            import System
            import Probe

            var a = Settings.MakeDate(2026, 6, 6)
            Console.WriteLine(a.HasValue)
            Console.WriteLine(a.Value.Year)

            var b = Settings.NoDate()
            Console.WriteLine(b.HasValue)
            """;

        var output = CompileAndRunWithProbe(source);
        Assert.Equal("True\n2026\nFalse\n", output);
    }

    [Fact]
    public void HasValue_OnParameter_DispatchesThroughLdarga()
    {
        // A `Nullable<T>` parameter is already in addressable storage
        // (`ldarga`). Verify the binder + emit produces a call against
        // the parameter's address rather than copying it to a fresh slot.
        var source = """
            package P

            import System

            func describe(x Nullable[int32]) {
                Console.WriteLine(x.HasValue)
                Console.WriteLine(x.GetValueOrDefault(-1))
            }

            var a Nullable[int32] = 5
            describe(a)
            var b Nullable[int32] = nil
            describe(b)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n5\nFalse\n-1\n", output);
    }

    [Fact]
    public void HasValue_OnClassField_DispatchesThroughLdflda()
    {
        // A `Nullable<T>` field on a class receiver must take the field
        // address (`ldflda`) before the `call instance` so the struct
        // instance method's `this` is a managed pointer to the actual
        // field, not a copy on the eval stack.
        var source = """
            package P

            import System

            type Holder class {
                var Flag bool?

                init() {
                    Flag = nil
                }
            }

            var h = Holder()
            Console.WriteLine(h.Flag.HasValue)
            Console.WriteLine(h.Flag.GetValueOrDefault(false))

            h.Flag = true
            Console.WriteLine(h.Flag.HasValue)
            Console.WriteLine(h.Flag.Value)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nFalse\nTrue\nTrue\n", output);
    }

    [Fact]
    public void Value_OnClrPropertyReturning_NullableBool_FullPipeline()
    {
        // Reproduces the exact `Assert.Equal(true, prop.Value)` shape from
        // the upstream Oahu workaround for #504. The receiver is a CLR
        // property's return value (an rvalue) — the emit pipeline must
        // spill it to a `Nullable<bool>`-typed scratch slot before taking
        // the address for the `Nullable<bool>::get_Value` call.
        var source = """
            package P

            import System
            import Probe

            var s = Settings()
            s.Flag = true
            Console.WriteLine(s.Flag.Value)
            Console.WriteLine(s.Flag.HasValue)
            Console.WriteLine(s.Flag.GetValueOrDefault(false))

            s.Flag = nil
            Console.WriteLine(s.Flag.HasValue)
            Console.WriteLine(s.Flag.GetValueOrDefault(false))
            """;

        var output = CompileAndRunWithProbe(source);
        Assert.Equal("True\nTrue\nTrue\nFalse\nFalse\n", output);
    }

    [Fact]
    public void Value_OnClrPropertyReturning_NullableInt32_Nil_ThrowsInvalidOperation()
    {
        // Same property-as-receiver pipeline, but the underlying value is
        // `nil` — the unwrap call into `Nullable<T>::get_Value` must throw
        // InvalidOperationException end-to-end, not InvalidProgramException
        // or NullReferenceException.
        var source = """
            package P

            import System
            import Probe

            var s = Settings()
            s.Count = nil
            var v = s.Count.Value
            Console.WriteLine(v)
            """;

        var (exitCode, _, stderr) = CompileAndRunRaw(source, expectSuccess: false, withProbe: true);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("InvalidOperationException", stderr);
    }

    [Fact]
    public void GetValueOrDefault_OnClrProperty_PropagatesFallback()
    {
        // CLR-property receiver + `GetValueOrDefault(fallback)`. Exercises
        // the spill-to-Nullable<T>-slot + ldloca + call sequence with a
        // non-zero argument flowing through to the BCL implementation.
        var source = """
            package P

            import System
            import Probe

            var s = Settings()
            s.Count = nil
            Console.WriteLine(s.Count.GetValueOrDefault(-1))

            s.Count = 7
            Console.WriteLine(s.Count.GetValueOrDefault(-1))
            """;

        var output = CompileAndRunWithProbe(source);
        Assert.Equal("-1\n7\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: true);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static string CompileAndRunWithProbe(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: true, withProbe: true);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(
        string source,
        bool expectSuccess,
        bool withProbe = false)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_nullable_instance_").FullName;
        try
        {
            string probeDllPath = null;
            if (withProbe)
            {
                probeDllPath = Path.Combine(tempDir, "ProbeLib.dll");
                BuildProbeLibrary(probeDllPath);
            }

            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };
            if (probeDllPath != null)
            {
                args.Add("/r:" + probeDllPath);
            }

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

            var verifyRefs = probeDllPath != null ? new[] { probeDllPath } : null;
            IlVerifier.Verify(outPath, additionalReferences: verifyRefs);

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
            return (proc.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

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
        EmitMakeDate(typeBuilder);
        EmitNoDate(typeBuilder);

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

    private static void EmitAutoProperty(TypeBuilder typeBuilder, string name, Type clrType)
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

    private static void EmitMakeDate(TypeBuilder typeBuilder)
    {
        // Static method `MakeDate(year, month, day) -> Nullable<DateTime>`.
        // Sidesteps the pre-existing source-side `var x Nullable[DateTime] =
        // DateTime(...)` lifting limitation by handing the binder a value
        // that is already typed as `Nullable<DateTime>` at the call site.
        var method = typeBuilder.DefineMethod(
            "MakeDate",
            MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.HideBySig,
            typeof(DateTime?),
            new[] { typeof(int), typeof(int), typeof(int) });
        var il = method.GetILGenerator();
        var dtCtor = typeof(DateTime).GetConstructor(new[] { typeof(int), typeof(int), typeof(int) });
        var nullableCtor = typeof(DateTime?).GetConstructor(new[] { typeof(DateTime) });
        il.Emit(OpCodes.Ldarg_0);
        il.Emit(OpCodes.Ldarg_1);
        il.Emit(OpCodes.Ldarg_2);
        il.Emit(OpCodes.Newobj, dtCtor!);
        il.Emit(OpCodes.Newobj, nullableCtor!);
        il.Emit(OpCodes.Ret);
    }

    private static void EmitNoDate(TypeBuilder typeBuilder)
    {
        // Static method `NoDate() -> Nullable<DateTime>` returning the
        // default (HasValue == false) value.
        var method = typeBuilder.DefineMethod(
            "NoDate",
            MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.HideBySig,
            typeof(DateTime?),
            Type.EmptyTypes);
        var il = method.GetILGenerator();
        var local = il.DeclareLocal(typeof(DateTime?));
        il.Emit(OpCodes.Ldloca_S, (byte)local.LocalIndex);
        il.Emit(OpCodes.Initobj, typeof(DateTime?));
        il.Emit(OpCodes.Ldloc, local);
        il.Emit(OpCodes.Ret);
    }

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
