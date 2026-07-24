// <copyright file="Issue519CoalesceNullableEmitTests.cs" company="GSharp">
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
/// Issue #519: applying the null-coalescing operator <c>??</c> to a CLR
/// <c>Nullable&lt;T&gt;</c> value previously crashed the emit phase silently
/// (<c>MSB4181</c> with no <c>GS####</c> diagnostic). The cause was the value-
/// type guard at the binary emit site rejecting any nullable value-type LHS
/// because <c>dup; brtrue</c> is invalid IL for a struct stack value, plus a
/// missing <c>HasValue</c>/<c>get_Value</c> lowering path.
///
/// These tests pin down the new behaviour:
/// <list type="bullet">
///   <item><c>Nullable&lt;T&gt; ?? T</c> for <c>bool?</c> and <c>int32?</c>, both
///   the present and absent branches, against locals and CLR properties.</item>
///   <item><c>Nullable&lt;T&gt; ?? Nullable&lt;T&gt;</c> preserves the wrapper
///   shape and threads <c>nil</c> through both sides.</item>
///   <item>Chained <c>a ?? b ?? c</c> over nullable operands routes through the
///   right operand correctly when the LHSs are <c>nil</c>.</item>
///   <item>Reference-typed nullables (<c>string?</c>) continue to use the
///   existing <c>dup; brtrue</c> path and are not regressed.</item>
/// </list>
/// Each test compiles via <c>gsc</c>, runs <c>ilverify</c> against the produced
/// PE, then executes the assembly under <c>dotnet exec</c> and asserts on the
/// captured stdout (so any invalid IL surfaces as a verification failure
/// rather than silently passing).
/// </summary>
public class Issue519CoalesceNullableEmitTests
{
    [Fact]
    public void CoalesceNullableBool_HasValue_Local_ReturnsLeftUnderlying()
    {
        var source = """
            package P

            import System

            var a bool? = true
            var v bool = a ?? false
            Console.WriteLine(v)

            var b bool? = false
            var w bool = b ?? true
            Console.WriteLine(w)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void CoalesceNullableBool_NoValue_Local_ReturnsRightLiteral()
    {
        var source = """
            package P

            import System

            var a bool? = nil
            var v bool = a ?? true
            Console.WriteLine(v)

            var b bool? = nil
            var w bool = b ?? false
            Console.WriteLine(w)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void CoalesceNullableInt_HasValue_Local_ReturnsLeftUnderlying()
    {
        var source = """
            package P

            import System

            var a int32? = 7
            var v int32 = a ?? 99
            Console.WriteLine(v)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void CoalesceNullableInt_NoValue_Local_ReturnsRightLiteral()
    {
        var source = """
            package P

            import System

            var a int32? = nil
            var v int32 = a ?? 99
            Console.WriteLine(v)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    [Fact]
    public void CoalesceNullableInt_BothNullable_HasValue_PreservesLeftWrapper()
    {
        // RHS is also `int32?`, so the operator's result type is the wrapper
        // `Nullable<int32>` rather than `int32`. The non-null branch must
        // reload the spilled `Nullable<T>` value (not unwrap and re-wrap),
        // so that `r` observes the original wrapper's identity.
        var source = """
            package P

            import System

            var a int32? = 7
            var b int32? = 99
            var r int32? = a ?? b
            Console.WriteLine(r!!)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void CoalesceNullableInt_BothNullable_LeftNil_UsesRightWrapper()
    {
        var source = """
            package P

            import System

            var a int32? = nil
            var b int32? = 42
            var r int32? = a ?? b
            Console.WriteLine(r!!)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void CoalesceNullableInt_BothNullable_BothNil_PropagatesAbsence()
    {
        // When both sides carry no value, the result must remain absent —
        // a literal `nil` wrapper must reach the consumer (here observed
        // through `object` widening so `Console.Write` prints empty).
        var source = """
            package P

            import System

            var a int32? = nil
            var b int32? = nil
            var r int32? = a ?? b
            var o object = r
            Console.Write("[")
            Console.Write(o)
            Console.WriteLine("]")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("[]\n", output);
    }

    [Fact]
    public void CoalesceNullableInt_Chained_AllNil_ReturnsLastLiteral()
    {
        // `a ?? b ?? c` parses right-associatively as `a ?? (b ?? c)`.
        // Both `a` and `b` are value-type Nullable<int>, so the emitter
        // pre-allocates two separate scratch slots (one per BoundBinary
        // expression). When all left operands are nil the final literal
        // wins.
        var source = """
            package P

            import System

            var a int32? = nil
            var b int32? = nil
            var c int32 = 99
            var r int32 = a ?? b ?? c
            Console.WriteLine(r)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    [Fact]
    public void CoalesceNullableInt_Chained_MiddleHasValue_ReturnsMiddle()
    {
        var source = """
            package P

            import System

            var a int32? = nil
            var b int32? = 7
            var c int32 = 99
            var r int32 = a ?? b ?? c
            Console.WriteLine(r)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void CoalesceNullableInt_Chained_FirstHasValue_ReturnsFirst()
    {
        var source = """
            package P

            import System

            var a int32? = 1
            var b int32? = 7
            var c int32 = 99
            var r int32 = a ?? b ?? c
            Console.WriteLine(r)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void CoalesceClrNullableBoolProperty_HasValue_ReturnsUnderlying()
    {
        // End-to-end reproducer mirroring the issue: a sibling CLR type
        // exposes `bool? Flag`. GSharp reads through the getter and
        // coalesces with a literal. Each step must produce verifiable IL —
        // before #519 the compile crashed silently as MSB4181.
        var source = """
            package P

            import System
            import Probe

            var s = Settings()
            s.Flag = true
            var v bool = s.Flag ?? false
            Console.WriteLine(v)

            s.Flag = false
            var w bool = s.Flag ?? true
            Console.WriteLine(w)
            """;

        var output = CompileAndRunWithProbe(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void CoalesceClrNullableBoolProperty_NoValue_ReturnsFallback()
    {
        var source = """
            package P

            import System
            import Probe

            var s = Settings()
            s.Flag = nil
            var v bool = s.Flag ?? true
            Console.WriteLine(v)

            s.Flag = nil
            var w bool = s.Flag ?? false
            Console.WriteLine(w)
            """;

        var output = CompileAndRunWithProbe(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void CoalesceClrNullableIntProperty_RoundTripsThroughCoalesce()
    {
        var source = """
            package P

            import System
            import Probe

            var s = Settings()
            s.Count = 7
            var v int32 = s.Count ?? 99
            Console.WriteLine(v)

            s.Count = nil
            var w int32 = s.Count ?? 99
            Console.WriteLine(w)
            """;

        var output = CompileAndRunWithProbe(source);
        Assert.Equal("7\n99\n", output);
    }

    [Fact]
    public void CoalesceNullConditionalBoolResult_UsesFallbackWhenReceiverIsNil()
    {
        var source = """
            package P

            import System

            class Items {
                public func HasItems() bool {
                    return true
                }
            }

            class Probe {
                public prop Items Items { get; set; }
            }

            var missing Probe? = nil
            var absent bool = missing?.Items!!.HasItems() ?? false
            Console.WriteLine(absent)

            var present Probe? = Probe() { Items = Items() }
            var found bool = present?.Items!!.HasItems() ?? false
            Console.WriteLine(found)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nTrue\n", output);
    }

    [Fact]
    public void CoalesceReferenceNullableString_StillUsesShortCircuitPath()
    {
        // Regression guard: a reference-typed nullable continues to use the
        // existing `dup; brtrue; pop; rhs` short-circuit, which is legal IL
        // for object references. The value-type emit branch added for #519
        // must not capture this case.
        var source = """
            package P

            import System

            var s string? = "hello"
            var r string = s ?? "fallback"
            Console.WriteLine(r)

            var t string? = nil
            var u string = t ?? "fallback"
            Console.WriteLine(u)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello\nfallback\n", output);
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue519_").FullName;
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
