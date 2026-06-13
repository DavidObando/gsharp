// <copyright file="Issue810OpenGenericIteratorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #810 — emit + IL-verify coverage for open-generic iterator
/// state machines. Follow-up to #798: the binder and interpreter
/// already accept <c>func Empty[T any]() IEnumerable[T] { yield ... }</c>
/// shapes; this batch exercises end-to-end IL emission. The
/// state-machine class must be generic over the outer method's type
/// parameters (mirroring how Roslyn emits <c>&lt;Empty&gt;d__0&lt;T&gt;</c>).
/// </summary>
public class Issue810OpenGenericIteratorEmitTests
{
    #region Empty[T] — exact repro from issue

    [Fact]
    public void Empty_OpenGeneric_IEnumerableT_RunsForInt32AndString()
    {
        var source = """
            package Probe
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Empty[T any]() IEnumerable[T] {
                        for v in []T{} {
                            yield v
                        }
                    }
                }
            }

            public var intCount = 0
            for x in Sequences.Empty[int32]() {
                intCount = intCount + 1
            }

            public var strCount = 0
            for s in Sequences.Empty[string]() {
                strCount = strCount + 1
            }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(0, GetIntField(assembly, "intCount"));
        Assert.Equal(0, GetIntField(assembly, "strCount"));
    }

    [Fact]
    public void Empty_OpenGeneric_SequenceT_RunsForInt32AndString()
    {
        var source = """
            package Probe

            class Sequences {
                shared {
                    func Empty[T any]() sequence[T] {
                        for v in []T{} {
                            yield v
                        }
                    }
                }
            }

            public var intCount = 0
            for x in Sequences.Empty[int32]() {
                intCount = intCount + 1
            }

            public var strCount = 0
            for s in Sequences.Empty[string]() {
                strCount = strCount + 1
            }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(0, GetIntField(assembly, "intCount"));
        Assert.Equal(0, GetIntField(assembly, "strCount"));
    }

    #endregion

    #region Of[T](values []T) — array param (variadic is top-level only per ADR-0101)

    [Fact]
    public void Of_OpenGeneric_VariadicT_IEnumerableT_SumsValues()
    {
        var source = """
            package Probe
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Of[T any](values []T) IEnumerable[T] {
                        for v in values {
                            yield v
                        }
                    }
                }
            }

            public var sum = 0
            for x in Sequences.Of[int32]([]int32{1, 2, 3, 4, 5}) {
                sum = sum + x
            }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(15, GetIntField(assembly, "sum"));
    }

    [Fact]
    public void Of_OpenGeneric_VariadicT_SequenceT_RunsForString()
    {
        var source = """
            package Probe

            class Sequences {
                shared {
                    func Of[T any](values []T) sequence[T] {
                        for v in values {
                            yield v
                        }
                    }
                }
            }

            public var concat = ""
            for s in Sequences.Of[string]([]string{"a", "b", "c"}) {
                concat = concat + s
            }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal("abc", GetStringField(assembly, "concat"));
    }

    #endregion

    #region Range[T] — closed (regression guard)

    [Fact]
    public void Range_ClosedInt32_NoOuterTypeParam_StillWorks()
    {
        var source = """
            package Probe
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Range(start int32, count int32) IEnumerable[int32] {
                        var i = 0
                        for i < count {
                            yield start + i
                            i = i + 1
                        }
                    }
                }
            }

            public var sum = 0
            for x in Sequences.Range(10, 5) {
                sum = sum + x
            }
            """;

        var assembly = CompileAndRun(source);
        // 10+11+12+13+14 = 60
        Assert.Equal(60, GetIntField(assembly, "sum"));
    }

    #endregion

    #region Iterate[T] — infinite with Take

    [Fact]
    public void Iterate_OpenGeneric_InfiniteWithTake()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Linq

            class Sequences {
                shared {
                    func Iterate[T any](seed T, next func(T) T) IEnumerable[T] {
                        var current = seed
                        for true {
                            yield current
                            current = next(current)
                        }
                    }
                }
            }

            public var sum = 0
            for x in Sequences.Iterate[int32](1, func(v int32) int32 { return v + 1 }).Take(5) {
                sum = sum + x
            }
            """;

        var assembly = CompileAndRun(source);
        // 1+2+3+4+5 = 15
        Assert.Equal(15, GetIntField(assembly, "sum"));
    }

    #endregion

    #region Repeat[T] — infinite with Take

    [Fact]
    public void Repeat_OpenGeneric_InfiniteWithTake()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Linq

            class Sequences {
                shared {
                    func Repeat[T any](value T) IEnumerable[T] {
                        for true {
                            yield value
                        }
                    }
                }
            }

            public var sum = 0
            for x in Sequences.Repeat[int32](7).Take(4) {
                sum = sum + x
            }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(28, GetIntField(assembly, "sum"));
    }

    #endregion

    #region Reflection — state-machine carries GenericParam rows

    [Fact]
    public void StateMachineClass_HasGenericParameter_MirroringOuterMethod()
    {
        var source = """
            package Probe
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Empty[T any]() IEnumerable[T] {
                        for v in []T{} {
                            yield v
                        }
                    }
                }
            }
            """;

        var assembly = CompileLibrary(source);

        // The synthesized iterator state-machine class is nested
        // inside the host <Program> (or the Sequences class). We look
        // for any private nested type whose name starts with
        // "<Empty>d__".
        var smType = assembly.GetTypes()
            .Where(t => t.IsNested && t.Name.StartsWith("<Empty>d__", StringComparison.Ordinal))
            .Single();

        Assert.True(
            smType.IsGenericTypeDefinition,
            $"State machine type '{smType.FullName}' must be a generic type definition (carry a GenericParam row).");

        var typeParams = smType.GetGenericArguments();
        Assert.Single(typeParams);
        Assert.Equal("T", typeParams[0].Name);

        // It must implement IEnumerable<T> closed over its own type
        // parameter (Var(0)), NOT over Object.
        var implementsIEnumerableOfT = smType
            .GetInterfaces()
            .Any(i => i.IsGenericType
                && i.GetGenericTypeDefinition() == typeof(IEnumerable<>)
                && i.GetGenericArguments()[0] == typeParams[0]);
        Assert.True(
            implementsIEnumerableOfT,
            $"State machine '{smType.FullName}' must implement IEnumerable<!0> (its own VAR(0)), not IEnumerable<object>.");
    }

    #endregion

    #region Helpers

    private static Assembly CompileAndRun(string source)
    {
        var outPath = CompileToFile(source, target: "exe");

        var bytes = File.ReadAllBytes(outPath);
        var assembly = Assembly.Load(bytes);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });

        return assembly;
    }

    private static Assembly CompileLibrary(string source)
    {
        var outPath = CompileToFile(source, target: "library");
        return Assembly.LoadFile(outPath);
    }

    private static string CompileToFile(string source, string target)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_810_").FullName;
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
                "/target:" + target,
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
        return outPath;
    }

    private static int GetIntField(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var field = program.GetField(name, BindingFlags.Public | BindingFlags.Static);
        return (int)field!.GetValue(null)!;
    }

    private static string GetStringField(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var field = program.GetField(name, BindingFlags.Public | BindingFlags.Static);
        return (string)field!.GetValue(null)!;
    }

    #endregion
}
