// <copyright file="Issue798SharedStaticIteratorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #798 / ADR-0084 §L5 — emit + IL-verify coverage for the
/// shared-static-iterator binding path enabled by the binder fix.
///
/// The reported symptom was a BINDER refusal (<c>GS0136</c>) and a
/// CFG crash (<c>GS9998</c>) when <c>yield</c> appeared in a method
/// inside a <c>shared</c> block. These tests cover the end-to-end
/// PE-emission path with <c>ilverify</c> for the spellings the
/// binder fix unblocks at IL level:
///   - <c>IEnumerable[int32]</c> shared-static iterator,
///   - <c>sequence[int32]</c> shared-static iterator,
///   - <c>IAsyncEnumerable[int32]</c> shared-static async iterator,
///   - <c>async sequence[int32]</c> shared-static async iterator.
///
/// Generic-iterator IL emission
/// (<c>shared func F[T any]() IEnumerable[T]</c>) surfaces a deeper,
/// pre-existing emitter gap: the synthesized state-machine class is
/// not made generic over the outer method's type parameters, so its
/// hoisted fields' signatures reference a method-generic slot that
/// doesn't exist on the SM class. That gap is tracked as a follow-up;
/// binder-level acceptance of the generic shapes is covered in
/// <c>Issue798SharedStaticIteratorBindingTests</c>.
/// </summary>
public class Issue798SharedStaticIteratorEmitTests
{
    #region IEnumerable[int32] return — shared-static iterator

    [Fact]
    public void SharedStatic_IEnumerableInt_EmitAndRun()
    {
        var source = """
            package Probe
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Of(a int32, b int32, c int32) IEnumerable[int32] {
                        yield a
                        yield b
                        yield c
                    }
                }
            }

            public var result = 0
            for x in Sequences.Of(10, 20, 12) {
                result = result + x
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        Assert.Equal(42, result);
    }

    #endregion

    #region sequence[int32] return — shared-static iterator

    [Fact]
    public void SharedStatic_SequenceInt_EmitAndRun()
    {
        var source = """
            package Probe

            class Sequences {
                shared {
                    func Of(a int32, b int32, c int32) sequence[int32] {
                        yield a
                        yield b
                        yield c
                    }
                }
            }

            public var result = 0
            for x in Sequences.Of(1, 2, 3) {
                result = result + x
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        Assert.Equal(6, result);
    }

    #endregion

    #region IAsyncEnumerable[int32] return — shared-static async iterator

    [Fact]
    public void SharedStatic_AsyncIEnumerableInt_EmitAndRun()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            class Sequences {
                shared {
                    async func Of(a int32, b int32) IAsyncEnumerable[int32] {
                        yield a
                        await Task.Delay(1)
                        yield b
                    }
                }
            }

            public var result = 0
            let e = Sequences.Of(10, 32).GetAsyncEnumerator()
            for e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        Assert.Equal(42, result);
    }

    #endregion

    #region async sequence[int32] return — shared-static async iterator

    [Fact]
    public void SharedStatic_AsyncSequenceInt_EmitAndRun()
    {
        // ADR-0041: `async func ... sequence[T]` resolves to
        // AsyncSequenceTypeSymbol. Issue #798 ensured the binder +
        // lowering predicates accept its symbolic form alongside
        // IAsyncEnumerable[T] / IAsyncEnumerator[T].
        var source = """
            package Probe
            import System.Threading.Tasks

            class Sequences {
                shared {
                    async func Of(a int32, b int32) sequence[int32] {
                        yield a
                        await Task.Delay(1)
                        yield b
                    }
                }
            }

            public var result = 0
            let e = Sequences.Of(100, 23).GetAsyncEnumerator()
            for e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        Assert.Equal(123, result);
    }

    #endregion

    #region Exact issue repro shape (non-generic instantiation)

    [Fact]
    public void Issue798_SharedStatic_Empty_NonGeneric_EmitAndRun()
    {
        // The literal `Sequences.Empty[T]` from the issue requires
        // generic-iterator IL emission (a state machine made generic
        // over the outer method's type parameters), which is a
        // separate, pre-existing emitter gap not in scope for issue
        // #798's binder fix. Verify the issue's shape at a concrete
        // instantiation; binder-level acceptance of the open T form
        // is covered in the binder tests.
        var source = """
            package Probe
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Empty() IEnumerable[int32] {
                        for v in []int32{} {
                            yield v
                        }
                    }

                    func Of(v int32) IEnumerable[int32] {
                        yield v
                    }
                }
            }

            public var result = 0
            for x in Sequences.Empty() {
                result = result + x
            }
            for y in Sequences.Of(7) {
                result = result + y
            }
            for z in Sequences.Of(35) {
                result = result + z
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        Assert.Equal(42, result);
    }

    #endregion

    #region Helpers

    private static Assembly CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_798_").FullName;
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

    private static T GetResult<T>(Assembly assembly)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);
        return (T)resultField!.GetValue(null)!;
    }

    #endregion
}
