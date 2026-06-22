// <copyright file="Issue936StaticOptionalParameterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #936 / ADR-0063 — emit + IL-verify coverage for default/optional
/// parameter values on static (<c>shared</c>) user-type method calls.
///
/// The reported symptom was a BINDER refusal
/// (<c>GS0144: Function 'Req' requires 1 arguments but was given 0.</c>)
/// when a <c>shared</c> method declaring a default parameter value was
/// called while omitting that argument. Instance methods already honored
/// the declared default; the static-call path
/// (<c>ExpressionBinder.BindUserTypeStaticCall</c>) refused the call on a
/// strict arity check and never synthesized the omitted default.
///
/// These tests cover the end-to-end PE-emission path with
/// <c>ilverify</c> for the shapes the binder fix unblocks:
///   - single trailing optional parameter omitted,
///   - required + multiple optional parameters with a mix of supplied and
///     omitted trailing arguments,
///   - all optional parameters supplied explicitly (regression guard).
/// </summary>
public class Issue936StaticOptionalParameterEmitTests
{
    #region Single optional parameter omitted

    [Fact]
    public void SharedStatic_SingleOptional_Omitted_UsesDefault()
    {
        var source = """
            package Probe

            class Greeter {
                shared {
                    func Greeting(title string = "Book") string {
                        return "Hello ${title}"
                    }
                }
            }

            public var result = Greeter.Greeting()
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<string>(assembly);
        Assert.Equal("Hello Book", result);
    }

    #endregion

    #region Mix of required + optional parameters

    [Fact]
    public void SharedStatic_RequiredPlusOptionals_OmittedTrailing_UsesDefaults()
    {
        var source = """
            package Probe

            class Greeter {
                shared {
                    func Make(prefix string, title string = "Book", count int32 = 3) string {
                        return "${prefix}:${title}:${count}"
                    }
                }
            }

            public var allDefaults = Greeter.Make("A")
            public var oneSupplied = Greeter.Make("B", "Mag")
            public var allSupplied = Greeter.Make("C", "Cd", 9)
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal("A:Book:3", GetField<string>(assembly, "allDefaults"));
        Assert.Equal("B:Mag:3", GetField<string>(assembly, "oneSupplied"));
        Assert.Equal("C:Cd:9", GetField<string>(assembly, "allSupplied"));
    }

    #endregion

    #region Numeric defaults

    [Fact]
    public void SharedStatic_NumericOptional_Omitted_UsesDefault()
    {
        var source = """
            package Probe

            class Calc {
                shared {
                    func Add(a int32, b int32 = 40) int32 {
                        return a + b
                    }
                }
            }

            public var result = Calc.Add(2)
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(42, GetResult<int>(assembly));
    }

    #endregion

    #region Helpers

    private static Assembly CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_936_").FullName;
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
