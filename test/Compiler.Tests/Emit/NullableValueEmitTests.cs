// <copyright file="NullableValueEmitTests.cs" company="GSharp">
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
/// Issue #504 (remaining emit-side gaps after PR #513): exercises code paths
/// that move <c>Nullable&lt;T&gt;</c> values through the emitter — `!!`
/// unwrap, generic call boundaries (type-erased boxing), and the full
/// CLR-property write/read/unwrap pipeline used by the original reproducer.
///
/// Each test compiles the GSharp source with gsc, runs <c>ilverify</c> against
/// the produced PE to confirm the IL is verifiable (the original bugs all
/// emitted invalid IL that the JIT caught at runtime as
/// <c>InvalidProgramException</c>), then executes the assembly under
/// <c>dotnet exec</c> and asserts on the captured stdout.
/// </summary>
public class NullableValueEmitTests
{
    [Fact]
    public void UnwrapBangBang_OnNullableBool_HasValue_ReturnsUnderlying()
    {
        // Original reproducer from #504 follow-up: `s.ExportToAax!!` (where
        // the property is `bool?`) compiled successfully but threw
        // InvalidProgramException at runtime because the emitter used the
        // reference-type `dup; brtrue` pattern on a struct stack value.
        // Modelled here without the CLR property dependency — see
        // RoundTripWriteReadUnwrap_OnClrNullableBoolProperty for the
        // end-to-end shape.
        var source = """
            package P

            import System

            var a Nullable[bool] = true
            var v = a!!
            Console.WriteLine(v)

            var b Nullable[bool] = false
            var w = b!!
            Console.WriteLine(w)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void UnwrapBangBang_OnNullableInt_HasValue_ReturnsUnderlying()
    {
        // Verifies the same path for a value type with a non-trivial size
        // (Nullable<int32> is 8 bytes — the `Nullable<T>::get_Value` call
        // must take the slot's address, not its value).
        var source = """
            package P

            import System

            var a Nullable[int32] = 42
            var v = a!!
            Console.WriteLine(v)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void UnwrapBangBang_OnNullableBool_NoValue_ThrowsInvalidOperation()
    {
        // The emitted IL routes the unwrap through
        // `Nullable<T>::get_Value()`, which the BCL implements as
        // `if (!HasValue) throw new InvalidOperationException(...);` — match
        // that exact behaviour so `!!` on a value-type Nullable mirrors the
        // C# `nullable.Value` property surface, and so the failure mode is
        // surfaced to the user (not silently zeroed).
        var source = """
            package P

            import System

            var a Nullable[bool] = nil
            var v = a!!
            Console.WriteLine(v)
            """;

        var (exitCode, _, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("InvalidOperationException", stderr);
    }

    [Fact]
    public void GenericMethod_PassNullableArg_RoundTripsThroughObjectBoundary()
    {
        // Phase 4 emit treats generic functions as type-erased — every `T`
        // parameter is encoded as `System.Object`, so value-type arguments
        // are boxed at the call boundary and unboxed at the return. Issue
        // #504 originally claimed `Assert.Equal[bool?](a, b)` (both bool?)
        // hit InvalidProgramException through this same code path. Confirm
        // the boundary handles a `Nullable<T>` argument correctly: the CLR
        // boxes a `Nullable<T>` as either a boxed T or a null reference.
        // Route everything through an `object` slot before printing so the
        // test asserts only on the box/unbox round-trip, not on
        // overload-resolution for Console.WriteLine(Nullable<bool>).
        var source = """
            package P

            import System

            func Id[T](a T) T {
                return a
            }

            var a Nullable[bool] = false
            var r1 Nullable[bool] = Id[Nullable[bool]](a)
            var o1 object = r1
            Console.WriteLine(o1)

            var b Nullable[bool] = nil
            var r2 Nullable[bool] = Id[Nullable[bool]](b)
            var o2 object = r2
            Console.Write("[")
            Console.Write(o2)
            Console.WriteLine("]")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\n[]\n", output);
    }

    [Fact]
    public void GenericMethod_TwoNullableArgs_PassedAsObjectsRoundTrip()
    {
        // Mirrors the reported `Assert.Equal[bool?](a, b)` shape: two
        // distinct `Nullable<bool>` locals threaded through a generic
        // method whose body re-emits `box Nullable<bool>` on each arg.
        // Each call boundary must box `Nullable<T>` correctly so the call
        // site's stack shape matches the type-erased `(object, object)`
        // signature, and the return must `unbox.any` back to `Nullable<T>`.
        var source = """
            package P

            import System

            func TwoArgs[T](a T, b T) T {
                return a
            }

            var x Nullable[bool] = true
            var y Nullable[bool] = false
            var first Nullable[bool] = TwoArgs[Nullable[bool]](x, y)
            var o1 object = first
            Console.WriteLine(o1)

            var second Nullable[bool] = TwoArgs[Nullable[bool]](y, x)
            var o2 object = second
            Console.WriteLine(o2)

            var nilHs Nullable[bool] = nil
            var third Nullable[bool] = TwoArgs[Nullable[bool]](nilHs, x)
            var o3 object = third
            Console.Write("[")
            Console.Write(o3)
            Console.WriteLine("]")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n[]\n", output);
    }

    [Fact]
    public void BoxNullable_ToObject_PreservesPresenceAndUnderlyingValue()
    {
        // `box Nullable<T>` is CLR-special-cased: the result is either a
        // boxed T (when HasValue) or a null reference (when !HasValue). The
        // emitter must therefore emit `box Nullable<T>` (not `box T`) on a
        // `Nullable<T>` stack value crossing into an `object` slot.
        var source = """
            package P

            import System

            var a Nullable[bool] = true
            var o1 object = a
            Console.WriteLine(o1)

            var b Nullable[bool] = false
            var o2 object = b
            Console.WriteLine(o2)

            var c Nullable[bool] = nil
            var o3 object = c
            Console.Write("[")
            Console.Write(o3)
            Console.WriteLine("]")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n[]\n", output);
    }

    [Fact]
    public void UnboxNullable_FromObject_ThroughGenericIdentity()
    {
        // The "unbox.any Nullable<T>" path is hit on the return value of a
        // generic method whose return is `T`. The emitter's
        // EmitErasedObjectReturnWidening must select the right closed
        // `Nullable<T>` token when widening the `object` placeholder back
        // to the caller's expected slot type.
        var source = """
            package P

            import System

            func Echo[T](a T) T {
                return a
            }

            var src Nullable[int32] = 7
            var dst Nullable[int32] = Echo[Nullable[int32]](src)
            Console.WriteLine(dst!!)

            var srcNil Nullable[int32] = nil
            var dstNil Nullable[int32] = Echo[Nullable[int32]](srcNil)
            var o object = dstNil
            Console.Write("[")
            Console.Write(o)
            Console.WriteLine("]")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n[]\n", output);
    }

    [Fact]
    public void RoundTripWriteReadUnwrap_OnClrNullableBoolProperty()
    {
        // End-to-end reproducer mirroring the original issue: a sibling CLR
        // type exposes `bool? Flag`. GSharp writes through the setter,
        // reads back through the getter, and unwraps with `!!`. Each step
        // must produce verifiable IL.
        var source = """
            package P

            import System
            import Probe

            var s = Settings()
            s.Flag = true
            var v = s.Flag!!
            Console.WriteLine(v)

            s.Flag = false
            var v2 = s.Flag!!
            Console.WriteLine(v2)
            """;

        var output = CompileAndRunWithProbe(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void UnwrapClrNullableProperty_NoValue_ThrowsInvalidOperation()
    {
        // `s.Flag!!` when the underlying value is `nil` must throw
        // InvalidOperationException (not InvalidProgramException, not
        // NullReferenceException) so the call surface matches
        // `Nullable<T>.Value`.
        var source = """
            package P

            import System
            import Probe

            var s = Settings()
            s.Flag = nil
            var v = s.Flag!!
            Console.WriteLine(v)
            """;

        var (exitCode, _, stderr) = CompileAndRunRaw(source, expectSuccess: false, withProbe: true);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("InvalidOperationException", stderr);
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
        var tempDir = Directory.CreateTempSubdirectory("gs_nullable_value_").FullName;
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
