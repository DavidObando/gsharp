// <copyright file="Issue813TupleSequenceReturnEmitTests.cs" company="GSharp">
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
/// Issue #813 — emit + IL-verify coverage for iterators whose element
/// type is a value tuple (e.g. <c>sequence[(int32, T)]</c> /
/// <c>IEnumerable[(T, T)]</c>). The fix lives across four touchpoints:
/// <list type="bullet">
///   <item>Parser — <c>yield (a, b)</c> at statement start is parsed as
///         a yield-statement (tuple literal) when the parens enclose a
///         top-level comma.</item>
///   <item>Binder — <c>SubstituteType</c> descends through
///         <c>TupleTypeSymbol.ElementTypes</c>.</item>
///   <item>Symbols — <c>TypeSymbol.ContainsTypeParameter</c> recognises
///         tuple elements so wrapping
///         <c>ImportedTypeSymbol.HasTypeParameterArgument</c> reports
///         correctly.</item>
///   <item>Emit — <c>IsValueTypeSymbol</c> /
///         <c>GetElementTypeToken</c> /
///         <c>StateMachineEmitter.ContainsOuterMethodTypeParameter</c>
///         and <c>MethodBodyPlanner.ContainsTypeParameter</c> all
///         honour tuple element types, plus the unification engine
///         (<c>TryUnify</c>) descends into tuples so generic-method
///         specs build correctly.</item>
/// </list>
/// </summary>
public class Issue813TupleSequenceReturnEmitTests
{
    #region Indexed[T] — the literal repro from the issue

    [Fact]
    public void Indexed_OpenGeneric_SequenceTupleIntT_RunsForInt32()
    {
        var source = """
            package Probe
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Indexed[T any](source IEnumerable[T]) sequence[(int32, T)] {
                        var index = 0
                        for v in source {
                            yield (index, v)
                            index = index + 1
                        }
                    }
                }
            }

            public var sumIdx = 0
            public var sumVal = 0
            for p in Sequences.Indexed[int32]([]int32{10, 20, 30}) {
                var idx = p.Item1
                var val = p.Item2
                sumIdx = sumIdx + idx
                sumVal = sumVal + val
            }
            """;

        var assembly = CompileAndRun(source);
        // indexes 0+1+2 = 3, values 10+20+30 = 60
        Assert.Equal(3, GetIntField(assembly, "sumIdx"));
        Assert.Equal(60, GetIntField(assembly, "sumVal"));
    }

    [Fact]
    public void Indexed_OpenGeneric_SequenceTupleIntT_RunsForString()
    {
        var source = """
            package Probe
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Indexed[T any](source IEnumerable[T]) sequence[(int32, T)] {
                        var index = 0
                        for v in source {
                            yield (index, v)
                            index = index + 1
                        }
                    }
                }
            }

            public var sumIdx = 0
            public var concat = ""
            for p in Sequences.Indexed[string]([]string{"a", "b", "c"}) {
                sumIdx = sumIdx + p.Item1
                concat = concat + p.Item2
            }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(3, GetIntField(assembly, "sumIdx"));
        Assert.Equal("abc", GetStringField(assembly, "concat"));
    }

    [Fact]
    public void Indexed_OpenGeneric_IEnumerableTupleIntT_RunsForInt32()
    {
        // Mirror of the sequence-returning case against the explicit
        // `IEnumerable[(int32, T)]` spelling. The kickoff method's
        // signature must encode that exact return shape so a closed
        // `Indexed[int32]` call site flows through the iterator
        // protocol uniformly.
        var source = """
            package Probe
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Indexed[T any](source IEnumerable[T]) IEnumerable[(int32, T)] {
                        var index = 0
                        for v in source {
                            yield (index, v)
                            index = index + 1
                        }
                    }
                }
            }

            public var sumIdx = 0
            public var sumVal = 0
            for p in Sequences.Indexed[int32]([]int32{5, 10, 15, 20}) {
                sumIdx = sumIdx + p.Item1
                sumVal = sumVal + p.Item2
            }
            """;

        var assembly = CompileAndRun(source);
        // indexes 0+1+2+3 = 6, values 5+10+15+20 = 50
        Assert.Equal(6, GetIntField(assembly, "sumIdx"));
        Assert.Equal(50, GetIntField(assembly, "sumVal"));
    }

    #endregion

    #region Pairwise[T] — tuple of (T, T)

    [Fact]
    public void Pairwise_OpenGeneric_SequenceTupleTT_RunsForInt32()
    {
        var source = """
            package Probe
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Pairwise[T any](source IEnumerable[T]) sequence[(T, T)] {
                        var first = true
                        var prev = default(T)
                        for v in source {
                            if !first {
                                yield (prev, v)
                            }
                            prev = v
                            first = false
                        }
                    }
                }
            }

            public var pairCount = 0
            public var sumFirst = 0
            public var sumSecond = 0
            for p in Sequences.Pairwise[int32]([]int32{1, 2, 3, 4}) {
                pairCount = pairCount + 1
                sumFirst = sumFirst + p.Item1
                sumSecond = sumSecond + p.Item2
            }
            """;

        var assembly = CompileAndRun(source);
        // pairs (1,2)(2,3)(3,4): 3 pairs; firsts=1+2+3=6, seconds=2+3+4=9
        Assert.Equal(3, GetIntField(assembly, "pairCount"));
        Assert.Equal(6, GetIntField(assembly, "sumFirst"));
        Assert.Equal(9, GetIntField(assembly, "sumSecond"));
    }

    [Fact]
    public void Pairwise_OpenGeneric_SequenceTupleTT_RunsForString()
    {
        var source = """
            package Probe
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Pairwise[T any](source IEnumerable[T]) sequence[(T, T)] {
                        var first = true
                        var prev = default(T)
                        for v in source {
                            if !first {
                                yield (prev, v)
                            }
                            prev = v
                            first = false
                        }
                    }
                }
            }

            public var concatFirst = ""
            public var concatSecond = ""
            for p in Sequences.Pairwise[string]([]string{"a", "b", "c"}) {
                concatFirst = concatFirst + p.Item1
                concatSecond = concatSecond + p.Item2
            }
            """;

        var assembly = CompileAndRun(source);
        // pairs ("a","b")("b","c"): firsts=a+b=ab, seconds=b+c=bc
        Assert.Equal("ab", GetStringField(assembly, "concatFirst"));
        Assert.Equal("bc", GetStringField(assembly, "concatSecond"));
    }

    #endregion

    #region 3-element tuple — (int32, T, U)

    [Fact]
    public void Triples_OpenGeneric_SequenceTupleIntTU_RunsForInt32String()
    {
        var source = """
            package Probe
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Triples[T any, U any](left IEnumerable[T], right IEnumerable[U]) sequence[(int32, T, U)] {
                        var index = 0
                        var rIter = right.GetEnumerator()
                        for v in left {
                            if rIter.MoveNext() {
                                yield (index, v, rIter.Current)
                            }
                            index = index + 1
                        }
                    }
                }
            }

            public var sumIdx = 0
            public var sumLeft = 0
            public var concatRight = ""
            for t in Sequences.Triples[int32, string]([]int32{10, 20, 30}, []string{"a", "b", "c"}) {
                sumIdx = sumIdx + t.Item1
                sumLeft = sumLeft + t.Item2
                concatRight = concatRight + t.Item3
            }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(3, GetIntField(assembly, "sumIdx"));
        Assert.Equal(60, GetIntField(assembly, "sumLeft"));
        Assert.Equal("abc", GetStringField(assembly, "concatRight"));
    }

    #endregion

    #region Nested tuple — (int32, (T, U))

    [Fact]
    public void NestedTuple_OpenGeneric_SequenceOfIntAndPair_RunsForInt32String()
    {
        var source = """
            package Probe
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Nested[T any, U any](left IEnumerable[T], right IEnumerable[U]) sequence[(int32, (T, U))] {
                        var index = 0
                        var rIter = right.GetEnumerator()
                        for v in left {
                            if rIter.MoveNext() {
                                yield (index, (v, rIter.Current))
                            }
                            index = index + 1
                        }
                    }
                }
            }

            public var sumIdx = 0
            public var sumLeft = 0
            public var concatRight = ""
            for t in Sequences.Nested[int32, string]([]int32{10, 20, 30}, []string{"a", "b", "c"}) {
                sumIdx = sumIdx + t.Item1
                var inner = t.Item2
                sumLeft = sumLeft + inner.Item1
                concatRight = concatRight + inner.Item2
            }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(3, GetIntField(assembly, "sumIdx"));
        Assert.Equal(60, GetIntField(assembly, "sumLeft"));
        Assert.Equal("abc", GetStringField(assembly, "concatRight"));
    }

    #endregion

    #region State-machine reflection — tuple element interfaces

    [Fact]
    public void StateMachineClass_TupleElement_ImplementsIEnumerableOfValueTuple()
    {
        // Smoke test: the synthesized SM class for an iterator with a
        // `(int32, T)` element must list a generic
        // `IEnumerable<ValueTuple<int32, T>>` interface implementation
        // closed over its own Var(0), not the type-erased
        // `IEnumerable<object>` shape.
        var source = """
            package Probe
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Indexed[T any](source IEnumerable[T]) IEnumerable[(int32, T)] {
                        var index = 0
                        for v in source {
                            yield (index, v)
                            index = index + 1
                        }
                    }
                }
            }
            """;

        var assembly = CompileLibrary(source);

        var smType = assembly.GetTypes()
            .Where(t => t.IsNested && t.Name.StartsWith("<Indexed>d__", StringComparison.Ordinal))
            .Single();

        Assert.True(smType.IsGenericTypeDefinition);
        var typeParams = smType.GetGenericArguments();
        Assert.Single(typeParams);

        // Find IEnumerable<ValueTuple<int, T>> closed over the SM's own
        // VAR(0) — i.e. the second type argument of the inner
        // ValueTuple must be ReferenceEqual to typeParams[0].
        var hasTupleEnumerable = smType.GetInterfaces().Any(i =>
        {
            if (!i.IsGenericType || i.GetGenericTypeDefinition() != typeof(IEnumerable<>))
            {
                return false;
            }

            var arg = i.GetGenericArguments()[0];
            if (!arg.IsGenericType || arg.GetGenericTypeDefinition() != typeof(ValueTuple<,>))
            {
                return false;
            }

            var tupleArgs = arg.GetGenericArguments();
            return tupleArgs[0] == typeof(int) && tupleArgs[1] == typeParams[0];
        });
        Assert.True(
            hasTupleEnumerable,
            $"State machine '{smType.FullName}' must implement IEnumerable<ValueTuple<int,!0>>. " +
            $"Actual interfaces: {string.Join(", ", smType.GetInterfaces().Select(i => i.FullName))}");
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
        var tempDir = Directory.CreateTempSubdirectory("gs_813_").FullName;
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
