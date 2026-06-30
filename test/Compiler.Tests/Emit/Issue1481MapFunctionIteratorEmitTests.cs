// <copyright file="Issue1481MapFunctionIteratorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1481 — a generic iterator whose element type is built from a
/// <c>map[K, T]</c> or a function type (<c>func(T) -&gt; int32</c>) must emit
/// strongly-typed <c>IEnumerable&lt;…&gt;</c> / <c>IEnumerator&lt;…&gt;</c>
/// interface rows that preserve the iterator's type parameter as a reified
/// <c>Var(0)</c> slot — not the type-erased <c>&lt;object&gt;</c> shape.
/// <para>
/// Before the fix, the emit layer re-implemented the "does this type
/// structurally reference a type parameter?" walk three separate times, and
/// the two emit-layer copies omitted <c>MapTypeSymbol</c> /
/// <c>FunctionTypeSymbol</c>. A generic iterator yielding <c>map[string, T]</c>
/// could not even be emitted (the signature encoder threw
/// "Cannot encode signature for type 'map[string,T]'"). The fix:
/// </para>
/// <list type="bullet">
///   <item>Consolidates the three walks into the single canonical
///         <c>TypeSymbol.AnyTypeParameter</c> walker (covered by the
///         Core-side unit tests).</item>
///   <item>Teaches the signature encoder to reify a null-ClrType
///         <c>map[K, V]</c> as <c>GENERICINST Dictionary`2&lt;K, V&gt;</c>,
///         with a matching reified body construction
///         (<c>GetMapCtorReference</c> / <c>GetMapSetItemReference</c>).</item>
///   <item>Recognises that <c>map</c> / function reference values widen to
///         <c>object</c> as a no-op in the non-generic
///         <c>IEnumerator.Current</c> getter.</item>
///   <item>Substitutes through <c>map[K, V]</c> at a closed generic call site
///         so the consuming <c>for</c>-loop binds the strongly-typed
///         element.</item>
/// </list>
/// Every user type in this file carries a unique <c>Issue1481</c>-prefixed
/// name because the name-keyed function-type cache is not cleared between
/// in-process emit tests.
/// </summary>
public class Issue1481MapFunctionIteratorEmitTests
{
    #region State-machine reflection — reified interface rows

    [Fact]
    public void StateMachineClass_MapElement_ImplementsIEnumerableOfReifiedDictionary()
    {
        // `sequence[map[string, T]]`: the synthesized SM class must list a
        // generic `IEnumerable<Dictionary<string, T>>` interface closed over
        // its own Var(0), not the type-erased `IEnumerable<object>` shape.
        var source = """
            package Probe
            import System.Collections.Generic

            class Issue1481MapRows {
                shared {
                    func MapRowsEntries[T any](items []T) sequence[map[string, T]] {
                        for v in items {
                            let m = map[string, T]{}
                            yield m
                        }
                    }
                }
            }
            """;

        var assembly = CompileLibrary(source);
        var smType = SingleStateMachine(assembly, "<MapRowsEntries>d__");

        Assert.True(smType.IsGenericTypeDefinition);
        var typeParams = smType.GetGenericArguments();
        Assert.Single(typeParams);

        AssertImplementsEnumerableOf(smType, i =>
        {
            if (!i.IsGenericType || i.GetGenericTypeDefinition() != typeof(Dictionary<,>))
            {
                return false;
            }

            var dictArgs = i.GetGenericArguments();
            return dictArgs[0] == typeof(string) && dictArgs[1] == typeParams[0];
        });

        // The `<>2__current` field and get_Current must agree with the rows.
        var currentField = smType.GetField("<>2__current", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.NotNull(currentField);
        var fieldType = currentField!.FieldType;
        Assert.True(fieldType.IsGenericType && fieldType.GetGenericTypeDefinition() == typeof(Dictionary<,>));
        Assert.Equal(typeof(string), fieldType.GetGenericArguments()[0]);
        Assert.Equal(typeParams[0], fieldType.GetGenericArguments()[1]);
    }

    [Fact]
    public void StateMachineClass_FunctionElement_ImplementsIEnumerableOfReifiedFunc()
    {
        // `sequence[(T) -> int32]`: the SM must list a generic
        // `IEnumerable<Func<T, int>>` interface closed over its own Var(0).
        var source = """
            package Probe
            import System.Collections.Generic

            class Issue1481FuncRows {
                shared {
                    func FuncRowsEntries[T any](items []T) sequence[(T) -> int32] {
                        for v in items {
                            yield func(x T) int32 { return 0 }
                        }
                    }
                }
            }
            """;

        var assembly = CompileLibrary(source);
        var smType = SingleStateMachine(assembly, "<FuncRowsEntries>d__");

        var typeParams = smType.GetGenericArguments();
        Assert.Single(typeParams);

        AssertImplementsEnumerableOf(smType, i =>
        {
            if (!i.IsGenericType || i.GetGenericTypeDefinition() != typeof(Func<,>))
            {
                return false;
            }

            var funcArgs = i.GetGenericArguments();
            return funcArgs[0] == typeParams[0] && funcArgs[1] == typeof(int);
        });
    }

    [Fact]
    public void StateMachineClass_MapOfListElement_StaysErased_AndVerifies()
    {
        // `sequence[map[string, List[T]]]`: under the type-erased generic
        // model (ADR-0004) `List[T]` is genuinely `List<object>` at runtime,
        // so this map has a non-null erased ClrType and MUST stay
        // `Dictionary<string, List<object>>` — reifying it would be a lie.
        // This guards against over-reification: the rows stay erased AND the
        // assembly still ilverifies (verified inside CompileLibrary).
        var source = """
            package Probe
            import System.Collections.Generic

            class Issue1481MapListRows {
                shared {
                    func MapListEntries[T any](items []T) sequence[map[string, List[T]]] {
                        for v in items {
                            let m = map[string, List[T]]{}
                            yield m
                        }
                    }
                }
            }
            """;

        var assembly = CompileLibrary(source);
        var smType = SingleStateMachine(assembly, "<MapListEntries>d__");

        AssertImplementsEnumerableOf(smType, i =>
        {
            if (!i.IsGenericType || i.GetGenericTypeDefinition() != typeof(Dictionary<,>))
            {
                return false;
            }

            var dictArgs = i.GetGenericArguments();
            if (dictArgs[0] != typeof(string))
            {
                return false;
            }

            // Value is the erased List<object> — NOT closed over the SM's Var(0).
            return dictArgs[1].IsGenericType
                && dictArgs[1].GetGenericTypeDefinition() == typeof(List<>)
                && dictArgs[1].GetGenericArguments()[0] == typeof(object);
        });
    }

    #endregion

    #region End-to-end execution — strongly-typed element values

    [Fact]
    public void MapIterator_RunsEndToEnd_WithStronglyTypedIntValues()
    {
        // Consuming a closed `MapRun[int32]` must surface `map[string, int32]`
        // elements whose indexer returns a strongly-typed `int32` (not `T`),
        // proving the closed call-site substitution descends into the map.
        var source = """
            package Probe
            import System.Collections.Generic

            class Issue1481MapRun {
                shared {
                    func MapRunEntries[T any](items []T) sequence[map[string, T]] {
                        for v in items {
                            let m = map[string, T]{"key": v}
                            yield m
                        }
                    }
                }
            }

            public var total = 0
            public var count = 0
            for d in Issue1481MapRun.MapRunEntries[int32]([]int32{5, 9, 14}) {
                total = total + d["key"]
                count = count + 1
            }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(3, GetIntField(assembly, "count"));
        Assert.Equal(28, GetIntField(assembly, "total"));
    }

    [Fact]
    public void MapIterator_RunsEndToEnd_WithStronglyTypedStringValues()
    {
        var source = """
            package Probe
            import System.Collections.Generic

            class Issue1481MapRunStr {
                shared {
                    func MapRunStrEntries[T any](items []T) sequence[map[string, T]] {
                        for v in items {
                            let m = map[string, T]{"key": v}
                            yield m
                        }
                    }
                }
            }

            public var concat = ""
            for d in Issue1481MapRunStr.MapRunStrEntries[string]([]string{"a", "b", "c"}) {
                concat = concat + d["key"]
            }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal("abc", GetStringField(assembly, "concat"));
    }

    [Fact]
    public void FunctionIterator_RunsEndToEnd()
    {
        // A generic iterator yielding `func(T) -> int32` values must emit and
        // verify, and the yielded delegates must be invokable at runtime.
        var source = """
            package Probe
            import System.Collections.Generic

            class Issue1481FuncRun {
                shared {
                    func FuncRunEntries[T any](items []T) sequence[(T) -> int32] {
                        for v in items {
                            yield func(x T) int32 { return 11 }
                        }
                    }
                }
            }

            public var total = 0
            for f in Issue1481FuncRun.FuncRunEntries[int32]([]int32{1, 2, 3}) {
                total = total + f(0)
            }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(33, GetIntField(assembly, "total"));
    }

    #endregion

    #region Helpers

    private static Type SingleStateMachine(Assembly assembly, string prefix)
        => assembly.GetTypes()
            .Single(t => t.IsNested && t.Name.StartsWith(prefix, StringComparison.Ordinal));

    private static void AssertImplementsEnumerableOf(Type smType, Func<Type, bool> elementMatches)
    {
        var ok = smType.GetInterfaces().Any(i =>
            i.IsGenericType
            && i.GetGenericTypeDefinition() == typeof(IEnumerable<>)
            && elementMatches(i.GetGenericArguments()[0]));
        Assert.True(
            ok,
            $"State machine '{smType.FullName}' must implement the expected reified IEnumerable<…> row. " +
            $"Actual interfaces: {string.Join(", ", smType.GetInterfaces().Select(i => i.FullName))}");
    }

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
        var tempDir = Directory.CreateTempSubdirectory("gs_1481_").FullName;
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
