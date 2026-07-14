// <copyright file="Issue2335StructConstrainedGenericPatternEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2335: a switch/<c>is</c> type pattern targeting a bare
/// value-type-constrained generic parameter (<c>where T : struct</c>,
/// optionally combined with <c>Enum</c>) emitted the reference-type
/// <c>castclass</c> path instead of <c>unbox.any</c>, producing IL that
/// ILVerify rejects (<c>StackUnexpected: found ref T, expected value T</c>)
/// and that stores a boxed reference into a value-typed pattern-variable
/// slot.
///
/// <para>
/// <b>Root cause:</b> <c>ReflectionMetadataEmitter.IsValueTypeSymbol</c> — the
/// single shared predicate every box/unbox emit decision in the compiler
/// consults (type patterns, conversions, member-access receiver dispatch,
/// closures, struct/tuple field defaulting, slot planning) — recognized
/// nullable wrappers over a value-type-constrained type parameter
/// (<c>T?</c>, issue #806) and several other symbolic value-type shapes, but
/// not a BARE (non-nullable) <see cref="Symbols.TypeParameterSymbol"/> whose
/// <see cref="Symbols.TypeParameterSymbol.HasValueTypeConstraint"/> is
/// <see langword="true"/>. <c>MethodBodyEmitter.EmitTypePattern</c> asks this
/// predicate to choose between <c>unbox.any</c> (value target) and
/// <c>castclass</c> (reference target); for a bare struct-constrained target
/// it wrongly took the reference branch.
/// </para>
///
/// <para>
/// <b>Fix:</b> <c>IsValueTypeSymbol</c> now recognizes a bare
/// <see cref="Symbols.TypeParameterSymbol"/> with
/// <c>HasValueTypeConstraint == true</c> directly (mirroring the existing
/// <c>Nullable&lt;T&gt;</c>-over-struct-constrained-T arm one level up).
/// Because every one of the ~40 <c>IsValueTypeSymbol</c> call sites in the
/// emitter shares this one predicate, the fix applies uniformly across type
/// patterns, <c>is</c>/narrowing casts, conversions (<c>box</c>/<c>unbox.any</c>
/// selection), instance-receiver addressing (<c>call</c> vs <c>callvirt</c>),
/// and struct/tuple default-value field patching — not just
/// <c>EmitTypePattern</c>.
/// </para>
///
/// <para>
/// <b>Audit follow-up (adjacent, tightly-coupled gap closed alongside):</b>
/// <c>EmitTypePattern</c>'s target-side opcode choice previously fell back to
/// <c>castclass</c> for ANY bare type parameter that <c>IsValueTypeSymbol</c>
/// did not recognize — including a genuinely UNCONSTRAINED (or class/
/// interface-constrained) <c>T</c>. Such a <c>T</c> can still close over a
/// value type at a given instantiation (e.g. <c>case v is T</c> inside
/// <c>func F[T](value object, fallback T) T</c>, called as <c>F[int32]</c>),
/// and <c>castclass !!T</c> is invalid IL for that closure — verified here to
/// have silently produced a WRONG runtime value pre-fix (reading raw stack
/// bytes as a boxed-reference target instead of unboxing), not merely an
/// ilverify failure. Per ECMA-335 III.4.32, <c>unbox.any</c> degrades to the
/// exact <c>castclass</c> behavior when the closed type turns out to be a
/// reference type, so it is the single opcode that is correct for every
/// constraint/closure combination; <c>EmitTypePattern</c> now routes every
/// bare type-parameter pattern target through it.
/// </para>
///
/// <para>
/// Every test compiles with <c>gsc</c>, IL-verifies the produced PE with
/// <c>ilverify</c>, then executes it and asserts on captured stdout. Tests
/// that closed over a value type via an unconstrained/class-constrained
/// type parameter also assert on the exact numeric/string value (not merely
/// "it didn't crash"), since the pre-fix bug for that shape was silent value
/// corruption rather than an IL-verifier rejection.
/// </para>
/// </summary>
public class Issue2335StructConstrainedGenericPatternEmitTests
{
    [Fact]
    public void SwitchCasePattern_StructConstrainedTypeParameter_Int32_MatchesAndUnwraps()
    {
        // Test #1 from the issue: `case v is T` with `T : struct`.
        var source = """
            package i2335struct
            import System

            func F[T struct](value object, fallback T) T {
                switch value {
                    default { return fallback }
                    case v is T { return v }
                }
            }

            var a object = 42
            var b object = "nope"
            Console.WriteLine(F[int32](a, -1))
            Console.WriteLine(F[int32](b, -1))
            """;

        Assert.Equal("42\n-1\n", CompileAndRun(source));
    }

    [Fact]
    public void SwitchCasePattern_StructAndEnumConstrainedTypeParameter_MatchesAndUnwraps()
    {
        // Test #2 from the issue: `T : struct, Enum` — the exact minimal
        // repro shape from the issue body (`class C[TEnum Enum struct]`).
        var source = """
            package i2335enum
            import System

            class C[TEnum Enum struct]() {
                func F(value object) string {
                    switch value {
                        default { return "other" }
                        case enm is TEnum { return enm.ToString() }
                    }
                }
            }

            let c = C[DayOfWeek]()
            Console.WriteLine(c.F(DayOfWeek.Friday))
            Console.WriteLine(c.F("nope"))
            """;

        Assert.Equal("Friday\nother\n", CompileAndRun(source));
    }

    [Fact]
    public void SwitchCasePattern_MultiArm_StringInt32EnumDefault_MatchesEachArm()
    {
        // Test #3 from the issue: a multi-arm switch mixing a reference-type
        // arm (string), a primitive value-type arm (int32), a struct+Enum
        // constrained generic arm (T), and a default arm.
        var source = """
            package i2335multiarm
            import System

            func Describe[T Enum struct](value object) string {
                switch value {
                    case s is string { return "string:" + s }
                    case n is int32 { return "int32:" + n.ToString() }
                    case enm is T { return "enum:" + enm.ToString() }
                    default { return "other" }
                }
            }

            var a object = "hi"
            var b object = 7
            var c object = DayOfWeek.Tuesday
            var d object = 3.5
            Console.WriteLine(Describe[DayOfWeek](a))
            Console.WriteLine(Describe[DayOfWeek](b))
            Console.WriteLine(Describe[DayOfWeek](c))
            Console.WriteLine(Describe[DayOfWeek](d))
            """;

        Assert.Equal("string:hi\nint32:7\nenum:Tuesday\nother\n", CompileAndRun(source));
    }

    [Fact]
    public void IfIsNarrowing_StructAndEnumConstrainedTypeParameter_ReturnsNarrowedValue()
    {
        // Test #4 from the issue: `if x is T` narrowing (as opposed to the
        // switch-statement `case v is T` capture pattern). The narrowed read
        // of `x` (declared `object`, narrowed to the struct-constrained `T`)
        // exercises `MethodBodyEmitter.EmitNarrowingCastIfNeeded`, the
        // sibling consumer of `IsValueTypeSymbol` for `is`-narrowed reads.
        var source = """
            package i2335ifis
            import System

            func Probe[T Enum struct](x object, fallback T) T {
                if x is T {
                    return x
                }
                return fallback
            }

            var a object = DayOfWeek.Wednesday
            var b object = "nope"
            Console.WriteLine(Probe[DayOfWeek](a, DayOfWeek.Monday).ToString())
            Console.WriteLine(Probe[DayOfWeek](b, DayOfWeek.Monday).ToString())
            """;

        Assert.Equal("Wednesday\nMonday\n", CompileAndRun(source));
    }

    [Fact]
    public void SwitchCasePattern_ClassConstrainedTypeParameter_StillUsesCastclass_Control()
    {
        // Test #5 (control) from the issue: a class-constrained generic type
        // parameter target must keep its existing (correct) castclass/
        // reference-type behavior — the fix must not perturb this path.
        var source = """
            package i2335classctrl
            import System

            open class Animal() {
                open func Speak() string -> "generic"
            }
            class Dog() : Animal() {
                override func Speak() string -> "Woof"
            }

            func F[T Animal](value object, fallback T) string {
                switch value {
                    default { return "other" }
                    case v is T { return v.Speak() }
                }
            }

            var a object = Dog()
            var b object = "nope"
            Console.WriteLine(F[Dog](a, Dog()))
            Console.WriteLine(F[Dog](b, Dog()))
            """;

        Assert.Equal("Woof\nother\n", CompileAndRun(source));
    }

    [Fact]
    public void SwitchCasePattern_UnconstrainedTypeParameter_ReferenceClosure_StillWorks_Control()
    {
        // Test #5 (control) from the issue: an UNCONSTRAINED type parameter
        // closed over a reference type must keep working exactly as before.
        var source = """
            package i2335unconstrctrl1
            import System

            func F[T](value object, fallback T) T {
                switch value {
                    default { return fallback }
                    case v is T { return v }
                }
            }

            var a object = "hello"
            Console.WriteLine(F[string](a, "none"))
            """;

        Assert.Equal("hello\n", CompileAndRun(source));
    }

    [Fact]
    public void SwitchCasePattern_UnconstrainedTypeParameter_ValueClosure_UnboxesCorrectly()
    {
        // Audit follow-up (see class remarks): an UNCONSTRAINED type
        // parameter closed over a VALUE type (`F[int32]`) previously emitted
        // `castclass !!T` for the pattern target — invalid IL, and (as
        // verified against pre-fix `main`) silently corrupted the observed
        // value at runtime rather than merely failing ilverify. Asserting the
        // exact numeric value (not just successful execution) pins down that
        // corruption.
        var source = """
            package i2335unconstrval
            import System

            func F[T](value object, fallback T) T {
                switch value {
                    default { return fallback }
                    case v is T { return v }
                }
            }

            var a object = 42
            var b object = "nope"
            Console.WriteLine(F[int32](a, -1))
            Console.WriteLine(F[int32](b, -1))
            """;

        Assert.Equal("42\n-1\n", CompileAndRun(source));
    }

    [Fact]
    public void OahuEnumConverterShape_ConvertToStructEnumConstrainedGeneric_MatchesAndConverts()
    {
        // Test #6 from the issue: the exact Oahu `EnumConverter<TEnum>` shape
        // (`open class ... [TEnum Enum struct] : TypeConverter` overriding
        // `ConvertTo` with `switch value { default {...}; case enm is TEnum
        // {...} }`), confirmed against the real Oahu.Foundation source during
        // the migration round that discovered this issue.
        var source = """
            package i2335oahuenumconv
            import System
            import System.ComponentModel
            import System.Globalization

            open class EnumConverterX[TEnum Enum struct] : TypeConverter {
                func ConvertTo(context ITypeDescriptorContext?, culture CultureInfo?, value object?, destinationType Type) object? {
                    switch value {
                        default {
                            return base.ConvertTo(context, culture, value, destinationType)
                        }
                        case enm is TEnum {
                            return enm.ToString()
                        }
                    }
                }
            }

            let conv = EnumConverterX[DayOfWeek]()
            Console.WriteLine(conv.ConvertTo(nil, nil, DayOfWeek.Friday, typeof(string)))
            Console.WriteLine(conv.ConvertTo(nil, nil, "hi", typeof(string)))
            """;

        Assert.Equal("Friday\nhi\n", CompileAndRun(source, requiresFullBcl: true));
    }

    [Fact]
    public void OahuEnumChainConverterShape_TwoTypeParameters_MatchesAndConverts()
    {
        // Test #6 from the issue: the exact Oahu `EnumChainConverter<TEnum,
        // TPunct>` shape — TWO type parameters, the first `Enum, struct`
        // constrained (the pattern target) and the second class-constrained
        // with an `init()` constructor constraint, both declared on the same
        // `TypeConverter`-derived open class as EnumConverter above.
        var source = """
            package i2335oahuchainconv
            import System
            import System.ComponentModel
            import System.Globalization

            class Punct() {
            }

            open class EnumChainConverterX[TEnum Enum struct, TPunct Punct init()] : TypeConverter {
                func ConvertTo(context ITypeDescriptorContext?, culture CultureInfo?, value object?, destinationType Type) object? {
                    switch value {
                        default {
                            return base.ConvertTo(context, culture, value, destinationType)
                        }
                        case enm is TEnum {
                            return ToDisplayString(enm)
                        }
                    }
                }

                private func ToDisplayString(value TEnum) string -> value.ToString()
            }

            let conv = EnumChainConverterX[DayOfWeek, Punct]()
            Console.WriteLine(conv.ConvertTo(nil, nil, DayOfWeek.Saturday, typeof(string)))
            Console.WriteLine(conv.ConvertTo(nil, nil, "hi", typeof(string)))
            """;

        Assert.Equal("Saturday\nhi\n", CompileAndRun(source, requiresFullBcl: true));
    }

    private static string CompileAndRun(string source, bool requiresFullBcl = false)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, requiresFullBcl);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(
        string source,
        bool requiresFullBcl)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2335_struct_generic_pattern_").FullName;
        try
        {
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

            if (requiresFullBcl)
            {
                foreach (var bcl in BclReferences.Value)
                {
                    args.Add("/r:" + bcl);
                }
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

            IlVerifier.Verify(outPath);

            var rtConfig = Path.ChangeExtension(outPath, ".runtimeconfig.json");
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
