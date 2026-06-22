// <copyright file="Issue940StaticOverloadArityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #940 — emit + IL-verify coverage for static (<c>shared</c>) user-type
/// method overload resolution.
///
/// The reported symptom was a BINDER refusal
/// (<c>GS0144: Function 'Round' requires 1 arguments but was given 2.</c>) when
/// a <c>shared</c> method had multiple overloads: the static-call path
/// (<c>ExpressionBinder.BindUserTypeStaticCall</c>) took the FIRST by-name
/// match via <c>StructSymbol.TryGetStaticMethod</c> and then arity-checked it,
/// so any call to an overload other than the first failed. Instance-method
/// overloads on the same type already resolved correctly.
///
/// The fix builds the full static method GROUP through the ADR-0112 canonical
/// member-resolution layer and runs <c>OverloadResolver</c> — identical to the
/// instance-method path. These tests cover the shapes the fix unblocks:
///   - the exact repro (calling the 2-arg overload from inside the 1-arg one),
///   - overloads differing by parameter TYPE at the same arity,
///   - a static overload set combined with a default/optional parameter.
/// </summary>
public class Issue940StaticOverloadArityEmitTests
{
    #region Exact repro — overloads differ by arity

    [Fact]
    public void SharedStatic_OverloadsByArity_ResolvesTwoArgFromOneArg()
    {
        var source = """
            package Probe

            class Geometry {
                shared {
                    func Round(value float64) float64 { return Geometry.Round(value, 2) }
                    func Round(value float64, digits int32) float64 { return System.Math.Round(value, digits) }
                }
            }

            public var result = Geometry.Round(1.234)
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(1.23, GetResult<double>(assembly), 3);
    }

    #endregion

    #region Overloads differ by parameter TYPE at the same arity

    [Fact]
    public void SharedStatic_OverloadsByParameterType_ResolveCorrectOverload()
    {
        var source = """
            package Probe

            class Fmt {
                shared {
                    func Describe(value int32) string { return "int:${value}" }
                    func Describe(value string) string { return "str:${value}" }
                }
            }

            public var fromInt = Fmt.Describe(42)
            public var fromString = Fmt.Describe("hi")
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal("int:42", GetField<string>(assembly, "fromInt"));
        Assert.Equal("str:hi", GetField<string>(assembly, "fromString"));
    }

    #endregion

    #region Overload set combined with an optional / default parameter

    [Fact]
    public void SharedStatic_OverloadSetWithOptionalParameter_ResolvesAndDefaults()
    {
        var source = """
            package Probe

            class Calc {
                shared {
                    func Scale(value int32) int32 { return value }
                    func Scale(value int32, factor int32, offset int32 = 100) int32 {
                        return (value * factor) + offset
                    }
                }
            }

            public var single = Calc.Scale(7)
            public var defaultedOffset = Calc.Scale(2, 3)
            public var allSupplied = Calc.Scale(2, 3, 1)
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(7, GetField<int>(assembly, "single"));
        Assert.Equal(106, GetField<int>(assembly, "defaultedOffset"));
        Assert.Equal(7, GetField<int>(assembly, "allSupplied"));
    }

    #endregion

    #region Helpers

    private static Assembly CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_940_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            });
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

        var bytes = File.ReadAllBytes(outPath);
        var assembly = Assembly.Load(bytes);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });

        return assembly;
    }

    private static T GetResult<T>(Assembly assembly) => GetField<T>(assembly, "result");

    private static T GetField<T>(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var resultField = program.GetField(name, BindingFlags.Public | BindingFlags.Static);
        return (T)resultField!.GetValue(null)!;
    }

    #endregion
}
