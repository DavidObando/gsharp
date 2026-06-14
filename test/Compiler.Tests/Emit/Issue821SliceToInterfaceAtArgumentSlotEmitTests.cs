// <copyright file="Issue821SliceToInterfaceAtArgumentSlotEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #821: end-to-end emit + IL-verify coverage for the slice-to-interface
/// implicit conversion applied at ordinary argument slots (static-method
/// and free-function call sites). Mirrors the binder coverage in
/// <c>Issue821SliceToInterfaceAtArgumentSlotBindingTests</c> and complements
/// the receiver-call coverage that #570/#774 already pinned.
/// </summary>
/// <remarks>
/// These cases close the gap noted while shipping #813 — the sample's
/// <c>Sequences.Indexed[T](source IEnumerable[T])</c> shape now binds, emits
/// verifier-clean IL, and produces the expected runtime values when a
/// <c>[]int32</c> or <c>[]string</c> slice is passed at the static-call
/// argument slot.
/// </remarks>
public class Issue821SliceToInterfaceAtArgumentSlotEmitTests
{
    [Fact]
    public void StaticGeneric_IEnumerableOfT_AcceptsSliceLiteral_RunsForInt32()
    {
        // The literal issue repro: `Sequences.Indexed[int32](ints)`
        // with `Indexed` declared as `func Indexed[T](source IEnumerable[T])`.
        var source = """
            package Probe
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Indexed[T](source IEnumerable[T]) sequence[(int32, T)] {
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
            let ints = []int32{10, 20, 30}
            for p in Sequences.Indexed[int32](ints) {
                sumIdx = sumIdx + p.Item1
                sumVal = sumVal + p.Item2
            }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(3, GetIntField(assembly, "sumIdx"));
        Assert.Equal(60, GetIntField(assembly, "sumVal"));
    }

    [Fact]
    public void StaticGeneric_IEnumerableOfT_AcceptsSliceLiteral_RunsForString()
    {
        // String-typed closure of the same shape — confirms the runtime
        // representation is identical for value-type and reference-type
        // element types.
        var source = """
            package Probe
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Indexed[T](source IEnumerable[T]) sequence[(int32, T)] {
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
    public void FreeFunctionArgSlot_IEnumerableOfT_AcceptsSliceLiteral_Runs()
    {
        // Free-function call slot variant.
        var source = """
            package Probe
            import System.Collections.Generic

            func Count[T](source IEnumerable[T]) int32 {
                var n = 0
                for _ in source {
                    n = n + 1
                }
                return n
            }

            public var n = Count[int32]([]int32{10, 20, 30})
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(3, GetIntField(assembly, "n"));
    }

    [Fact]
    public void StaticGeneric_IListOfT_AcceptsSliceLiteral_Runs()
    {
        // `IList[T]` interface — slice satisfies it via the backing CLR array.
        var source = """
            package Probe
            import System.Collections.Generic

            class Sink {
                shared {
                    func Take[T](source IList[T]) int32 { return source.Count }
                }
            }

            public var n = Sink.Take[int32]([]int32{1, 2, 3})
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(3, GetIntField(assembly, "n"));
    }

    [Fact]
    public void StaticGeneric_ICollectionOfT_AcceptsSliceLiteral_Runs()
    {
        // `ICollection[T]` — slice satisfies it via the backing CLR array.
        var source = """
            package Probe
            import System.Collections.Generic

            class Sink {
                shared {
                    func Take[T](source ICollection[T]) int32 { return source.Count }
                }
            }

            public var n = Sink.Take[int32]([]int32{1, 2, 3, 4})
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(4, GetIntField(assembly, "n"));
    }

    [Fact]
    public void StaticGeneric_IReadOnlyListOfT_AcceptsSliceLiteral_Runs()
    {
        // `IReadOnlyList[T]` — slice satisfies it via the backing CLR
        // array. Returns `int32` (not an open `T`) to keep coverage on
        // the argument-slot conversion the issue is about and avoid the
        // unrelated indexer-on-open-generic emit shape.
        var source = """
            package Probe
            import System.Collections.Generic

            class Sink {
                shared {
                    func Take[T](source IReadOnlyList[T]) int32 { return source.Count }
                }
            }

            public var n = Sink.Take[int32]([]int32{7, 8, 9})
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(3, GetIntField(assembly, "n"));
    }

    [Fact]
    public void StaticGeneric_IEnumerableOfT_AcceptsSliceFromLocal_Runs()
    {
        // Slice held in a local variable (not just a literal) flowed into
        // an `IEnumerable[T]` static-method argument slot.
        var source = """
            package Probe
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Sum(source IEnumerable[int32]) int32 {
                        var s = 0
                        for v in source {
                            s = s + v
                        }
                        return s
                    }
                }
            }

            let ints = []int32{10, 20, 30}
            public var total = Sequences.Sum(ints)
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(60, GetIntField(assembly, "total"));
    }

    private static Assembly CompileAndRun(string source)
    {
        var outPath = CompileToFile(source);

        var bytes = File.ReadAllBytes(outPath);
        var assembly = Assembly.Load(bytes);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });

        return assembly;
    }

    private static string CompileToFile(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_821_").FullName;
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
}
