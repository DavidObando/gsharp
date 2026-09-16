// <copyright file="Issue4223And4221CompositionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Adversarial coverage for the point where issue #4223 (reifying an
/// enclosing method/type type parameter for a capture-free generic local
/// function, <c>UserTokenResolver.TryPromoteNonCapturingGenericLambda</c>)
/// and issue #4221/#4252/#4261 (a generic local function transitively
/// capturing outer state through a sibling call, reconciled to a fixed
/// point by <c>LambdaBinder.ReconcileGenericLocalFunctionGroupCaptures</c>)
/// meet in the same program. The two mechanisms are independent — a member
/// is routed through exactly one of them, decided by whether it ends up
/// capturing anything, direct or transitive — but they run in the same
/// binder pass over the same declaration group and must not corrupt one
/// another.
/// </summary>
public class Issue4223And4221CompositionTests
{
    [Fact]
    public void SiblingsSplitCapabilities_CaptureAndReification_BothWork()
    {
        // `capturer` captures `outer` only transitively, through `helper`
        // (issue #4221/#4261's capability, no enclosing type parameter
        // involved at all). `reifier` references the enclosing `Outer`
        // type parameter and captures nothing (issue #4223's capability,
        // no outer-variable capture involved at all). Both are members of
        // the SAME consecutive generic-local-function region, so they go
        // through the SAME PrepareGenericLocalFunctionDeclaration group and
        // the SAME ReconcileGenericLocalFunctionGroupCaptures fixed point —
        // exactly where the two mechanisms could interfere.
        var result = EmittedOracle.Evaluate("""
            func Run[Outer]() string {
                var outer = 3
                let capturer[T] = func(a T) int32 { return helper(a) }
                let helper[H] = func(a H) int32 { return outer }
                let reifier[R] = func(a R) string {
                    let v Outer = default(Outer)
                    return typeof(Outer).Name
                }
                return capturer(1).ToString() + "|" + reifier(1)
            }
            Run[string]() + "/" + Run[int32]()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("3|String/3|Int32", result.Value);
    }

    [Fact]
    public void ForwardReferenceWidensCaptureAfterReificationDecided_StillRejectedNotCrashed()
    {
        // Regression pin for the merge-time gap between the two fixed-point
        // mechanisms: `first` is declared BEFORE `second` (a forward
        // reference) and references the enclosing `Outer` type parameter in
        // its own PARAMETER type. At `first`'s own bind time `second` has
        // not bound yet, so `first` looks capture-free and would be
        // eligible for #4223's zero-capture reification. Only after both
        // members bind does ReconcileGenericLocalFunctionGroupCaptures fold
        // `second`'s capture of `outer` into `first` transitively. Before
        // the fix, the GS0468 gate — evaluated once, before that widening —
        // never re-ran, so this compiled clean and crashed the CLR with
        // "invalid program" (a capturing generic local referencing an
        // enclosing type parameter in its own signature is an unsupported
        // combination, issue #4221/#4252's closure-class path was never
        // extended to carry the extra type parameter). It must now be
        // rejected at compile time (GS0468) instead of reaching the
        // emitter.
        var result = EmittedOracle.Evaluate("""
            func Run[Outer]() int32 {
                var outer = 1
                let first[T] = func(a T, y Outer) int32 { return second(a) }
                let second[U] = func(a U) int32 { return outer }
                return first(1, default(Outer))
            }
            Run[int32]()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0468");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardReferenceWidensCaptureAfterReificationDecided_BodyOnlyReference_StillRejectedNotCrashed()
    {
        // Same gap as above, but the enclosing type parameter is referenced
        // only in `first`'s BODY (not its own signature) — confirming the
        // re-check is not accidentally scoped to signature references only.
        var result = EmittedOracle.Evaluate("""
            func Run[Outer]() string {
                var outer = "!"
                let first[T] = func(a T) string {
                    let v Outer = default(Outer)
                    return typeof(Outer).Name + second(a)
                }
                let second[U] = func(a U) string {
                    return outer
                }
                return first(1)
            }
            Run[string]() + "|" + Run[int32]()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0468");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardReferenceWithNoEnclosingTypeParameter_StillCompilesAndRuns()
    {
        // Sanity check that the new post-reconcile re-check does not
        // introduce a false positive for the ordinary #4221 forward-
        // reference/transitive-capture shape that never touches an
        // enclosing type parameter at all.
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                var outer = 9
                let first[T] = func(a T) int32 { return second(a) }
                let second[U] = func(a U) int32 { return outer }
                return first(1) + first("z")
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(18, result.Value);
    }
}
