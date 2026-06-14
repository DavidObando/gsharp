// <copyright file="Issue836IteratorTryFinallyBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #836 — the binder's acceptance contract for <c>yield</c>
/// statements nested inside <c>try</c> blocks. Pure <c>try</c>/
/// <c>finally</c> around <c>yield</c> binds cleanly; the presence of
/// any <c>catch</c> clause on the same <c>try</c> raises GS0367 (the
/// state machine cannot resume into a protected region that doubles as
/// a CLR exception-handler frame).
/// </summary>
public class Issue836IteratorTryFinallyBinderTests
{
    [Fact]
    public void YieldInsideTryFinally_Accepted()
    {
        var (result, _) = Compile("""
            import System
            import System.Collections.Generic
            func gen() IEnumerable[int32] {
                try {
                    yield 1
                    yield 2
                } finally {
                    var done = true
                }
            }
            """);

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void YieldInsideTryWithCatch_RejectedWithGS0367()
    {
        var (result, _) = Compile("""
            import System
            import System.Collections.Generic
            func gen() IEnumerable[int32] {
                try {
                    yield 1
                } catch (e Exception) {
                    var caught = true
                }
            }
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0367");
    }

    [Fact]
    public void YieldInsideTryCatchFinally_RejectedWithGS0367()
    {
        var (result, _) = Compile("""
            import System
            import System.Collections.Generic
            func gen() IEnumerable[int32] {
                try {
                    yield 1
                } catch (e Exception) {
                    var caught = true
                } finally {
                    var done = true
                }
            }
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0367");
    }

    [Fact]
    public void NestedTryFinally_BothLevelsContainYields_Accepted()
    {
        var (result, _) = Compile("""
            import System
            import System.Collections.Generic
            func gen() IEnumerable[int32] {
                try {
                    try {
                        yield 1
                        yield 2
                    } finally {
                        var inner = true
                    }
                } finally {
                    var outer = true
                }
            }
            """);

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NestedTryFinally_InnerHasCatchWithYield_InnerRejected()
    {
        var (result, _) = Compile("""
            import System
            import System.Collections.Generic
            func gen() IEnumerable[int32] {
                try {
                    try {
                        yield 1
                    } catch (e Exception) {
                        var caught = true
                    }
                } finally {
                    var done = true
                }
            }
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0367");
    }

    [Fact]
    public void TryWithCatch_NoYield_StillBinds()
    {
        // Non-iterator try/catch is unaffected.
        var (result, _) = Compile("""
            import System
            func gen() int32 {
                try {
                    return 1
                } catch (e Exception) {
                    return 0
                }
            }
            """);

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void TryWithCatch_YieldInNestedLambda_NotRejected()
    {
        // A `yield` lexically inside a nested function body should not
        // count as belonging to the outer try/catch (different lexical
        // scope; the inner lambda would have its own iterator semantics
        // if it returned a sequence).
        var (result, _) = Compile("""
            import System
            import System.Collections.Generic
            func gen() IEnumerable[int32] {
                try {
                    let inner = func() IEnumerable[int32] {
                        yield 1
                    }
                    for v in inner() {
                        yield v
                    }
                    yield 99
                } finally {
                    var done = true
                }
            }
            """);

        // The outer try has only a finally, not a catch — should be
        // accepted regardless of where the inner lambda's yield lives.
        Assert.Empty(result.Diagnostics);
    }

    private static (EvaluationResult Result, Compilation Compilation) Compile(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return (result, compilation);
    }
}
