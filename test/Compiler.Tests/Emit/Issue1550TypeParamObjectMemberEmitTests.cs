// <copyright file="Issue1550TypeParamObjectMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1550 — a member call on a value of an OPEN generic type parameter
/// failed with GS0159 when the member was a universal <c>System.Object</c>
/// member (<c>ToString</c>, <c>GetHashCode</c>, <c>Equals(object)</c>,
/// <c>GetType</c>), even though those are inherited by every type parameter.
/// The constraint-supplied member paths (#1052 / #1056 / #943) did not cover
/// them, so <c>t.ToString()</c> on a type parameter with no matching constraint
/// dead-ended, and the error-typed result cascaded into downstream String
/// calls.
/// <para>
/// The fix adds a type-parameter dispatch path (AFTER the constraint paths, so a
/// redeclaring constraint still wins) that resolves the public instance members
/// of <c>System.Object</c> on ANY <c>TypeParameterSymbol</c> receiver and emits
/// a verifiable <c>constrained. !!T  callvirt System.Object::Method(...)</c>
/// sequence. The <c>constrained.</c> prefix dispatches to any override for
/// value, struct/enum-constrained and reference type parameters alike.
/// </para>
/// Each test uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed for user types.
/// </summary>
public class Issue1550TypeParamObjectMemberEmitTests
{
    [Fact]
    public void ToString_OnStructConstrainedReceiver_Runs()
    {
        // The canonical issue repro: `default(T).ToString()` on a `T struct`
        // receiver returns the value's string form. Emitted as
        // `constrained. !!T  callvirt System.Object::ToString()`.
        const string source = """
            package i1550_struct_tostring
            import System

            func Show[T struct](v T) string -> v.ToString()

            func Main() {
                Console.WriteLine(Show[int32](42))
            }
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void GetHashCode_OnAnyConstrainedReceiver_Runs()
    {
        // The second issue repro: `t.GetHashCode()` on an unconstrained (`any`)
        // receiver. Two equal int values hash identically, proving the object
        // member dispatches correctly through the type parameter.
        const string source = """
            package i1550_any_hash
            import System

            func HashEq[T any](a T, b T) bool -> a.GetHashCode() == b.GetHashCode()

            func Main() {
                Console.WriteLine(HashEq[int32](7, 7))
            }
            """;

        Assert.Equal("True\n", CompileAndRun(source));
    }

    [Fact]
    public void Equals_WithArgument_OnAnyConstrainedReceiver_Runs()
    {
        // `Equals(object)` binds with an argument: the `T`-typed argument is
        // boxed to System.Object at the call site (the object member's real
        // parameter is System.Object, unlike a CLR-interface type variable).
        const string source = """
            package i1550_any_equals
            import System

            func Same[T any](a T, b T) bool -> a.Equals(b)

            func Main() {
                Console.WriteLine(Same[int32](3, 3))
                Console.WriteLine(Same[int32](3, 4))
            }
            """;

        Assert.Equal("True\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void GetType_OnAnyConstrainedReceiver_Runs()
    {
        // `t.GetType().Name` on an unconstrained receiver — the object member
        // returns a non-null System.Type whose Name is the runtime type.
        const string source = """
            package i1550_any_gettype
            import System

            func TypeName[T any](t T) string -> t.GetType().Name

            func Main() {
                Console.WriteLine(TypeName[int32](0))
            }
            """;

        Assert.Equal("Int32\n", CompileAndRun(source));
    }

    [Fact]
    public void ToString_OnClassConstrainedReceiver_Runs()
    {
        // A reference (`class`) type parameter: the `constrained.` prefix is
        // still required (a bare callvirt on the unboxed `!!T` is unverifiable).
        // With no user override visible through the opaque `T`, dispatch lands
        // on the default System.Object.ToString (the type's full name).
        const string source = """
            package i1550_class_tostring
            import System

            class Widget1550 { var N int32 }

            func Describe[T class](t T) string -> t.ToString()

            func Main() {
                Console.WriteLine(Describe[Widget1550](Widget1550{ N: 1 }))
            }
            """;

        Assert.Equal("i1550_class_tostring.Widget1550\n", CompileAndRun(source));
    }

    [Fact]
    public void ToString_OnEnumStructConstrainedReceiver_DispatchesOverride()
    {
        // An `Enum struct`-constrained receiver: the `constrained.` prefix
        // dispatches to the enum's own ToString override (System.Enum overrides
        // System.Object.ToString), printing the member NAME rather than the
        // underlying integer — proof the constrained call reaches the override.
        const string source = """
            package i1550_enum_tostring
            import System

            func Name[T Enum struct](e T) string -> e.ToString()

            func Main() {
                Console.WriteLine(Name[DayOfWeek](DayOfWeek.Monday))
            }
            """;

        Assert.Equal("Monday\n", CompileAndRun(source));
    }

    [Fact]
    public void Cascade_ToStringResultFeedsStringCall_NoLongerCascades()
    {
        // Regression for the cascade described in the issue: the (previously
        // error-typed) result of `v.ToString()` now has a concrete `string`
        // type, so a downstream String call (`StartsWith`) binds and runs
        // instead of losing further diagnostics.
        const string source = """
            package i1550_cascade
            import System

            func Starts[T any](v T) bool {
                let s = v.ToString()
                return s.StartsWith("4")
            }

            func Main() {
                Console.WriteLine(Starts[int32](42))
                Console.WriteLine(Starts[int32](13))
            }
            """;

        Assert.Equal("True\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void Control_UserInterfaceConstraintMember_StillBinds()
    {
        // The pre-existing #1052 constraint-dispatch path must be unaffected:
        // `t.Area()` on an interface-constrained receiver still resolves to the
        // constraint interface member (it runs BEFORE the new object path).
        const string source = """
            package i1550_control_iface
            import System

            interface IShape1550 { func Area() float64; }

            struct Sq1550 : IShape1550 {
                var Side float64
                func Area() float64 { return Side * Side }
            }

            func Describe[T IShape1550](t T) float64 -> t.Area()

            func Main() {
                Console.WriteLine(Describe[Sq1550](Sq1550{ Side: 3.0 }))
            }
            """;

        Assert.Equal("9\n", CompileAndRun(source));
    }

    [Fact]
    public void Negative_NonexistentMethodOnTypeParam_StillReportsGs0159()
    {
        // A genuinely nonexistent member on a type parameter must still report
        // GS0159 — the object-member path returns false for any name Object
        // does not define, so it does not mask real errors.
        const string source = """
            package i1550_neg159
            import System

            func Bad[T any](t T) int32 -> t.NoSuchMethod()
            """;

        var (exit, output) = CompileOnly(source);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0159", output);
    }

    private static (int Exit, string Output) CompileOnly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1550_neg_").FullName;
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

            return (compileExit, stdoutWriter + stderrWriter.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1550_exe_").FullName;
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
}
