// <copyright file="Issue1799MapAndInterfaceSlotConcurrencyInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #1799 residue after the tree-walking evaluator retired (ADR-0156
/// Phase 3c, #3176).
///
/// The four skipped map-concurrency stress tests that lived here pinned the
/// EVALUATOR's implicit per-instance map lock — a guarantee the emitted
/// engines deliberately do not provide (a G# <c>map[K]V</c> is a plain
/// <c>Dictionary&lt;,&gt;</c> in IL, matching Go's own "maps are not safe for
/// concurrent use" stance). They were deleted with the evaluator; issue #3205
/// records the language-level decision and #3209 tracks the fresh
/// synchronized-map design, which brings its own guarantees and tests.
///
/// What remains engine-independent — and is pinned here — is deterministic
/// constrained-static interface-slot resolution: under emitted execution
/// <c>T.Add</c> resolves through the inferred type argument itself (real
/// generics, no frame scanning), so the same call site picks the same
/// implementer on every run by construction.
/// </summary>
public class Issue1799MapAndInterfaceSlotConcurrencyInterpreterTests
{
    [Fact]
    public void InterfaceSlotResolution_ResolvesThroughInferredTypeArgumentEveryRun()
    {
        // Historically the evaluator's "Strategy 2" frame scan had TWO valid
        // in-scope candidates (`w` Adder and `other` Adder2) and picked by
        // ordinal variable-name order, yielding Adder2's 3*4=12. Emitted
        // execution has no frame scan: `T` infers to Adder from `w`, so
        // `T.Add` IS Adder.Add and yields 3+4=7 — deterministically, on
        // every run.
        var source = """
            import System

            sealed interface IAdd {
                shared {
                    func Add(a int32, b int32) int32;
                }
            }

            class Adder : IAdd {
                shared {
                    func Add(a int32, b int32) int32 { return a + b }
                }
            }

            class Adder2 : IAdd {
                shared {
                    func Add(a int32, b int32) int32 { return a * b }
                }
            }

            func Compute[T IAdd](w T, other Adder2, a int32, b int32) int32 {
                return T.Add(a, b)
            }

            Console.WriteLine(Compute(Adder{}, Adder2{}, 3, 4))
            """;

        for (var i = 0; i < 5; i++)
        {
            var result = EmittedOracle.Evaluate(source);
            Assert.DoesNotContain(result.Diagnostics, d => d.Id != "GS0286");
            Assert.Equal($"7{Environment.NewLine}", result.Output.ReplaceLineEndings(Environment.NewLine));
        }
    }
}
