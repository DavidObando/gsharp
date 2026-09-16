// <copyright file="Issue4219NonGenericLocalRecursionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #4219 umbrella remainder, workstream A: mutual-recursion groups for
/// NON-generic local functions. <see cref="Issue4219GenericLocalRecursionTests"/>
/// covers the GENERIC case (b84bf800 and its #4221/#4223 follow-ups), which
/// already supports forward references and call cycles among a consecutive
/// run of <c>let name[T] = func (...) ... {...}</c> declarations. Plain
/// <c>let name = func (...) ... {...}</c> declarations had no such
/// mechanism — <c>StatementBinder.IsGenericLocalFunctionDeclaration</c>
/// required a type-parameter list, so a forward reference among non-generic
/// siblings reported GS0130 exactly like an ordinary undeclared name.
/// <para>
/// This extends the SAME prepare-then-bind signature-registration mechanism
/// (<c>StatementBinder.BindLocalFunctionLiteralGroup</c>,
/// <c>LambdaBinder.PrepareGenericLocalFunctionDeclaration</c> generalized to
/// tolerate a null type-parameter list) to a run of TWO OR MORE consecutive
/// non-generic local-function-literal <c>let</c> declarations — see
/// <c>StatementBinder.IsNonGenericLocalFunctionLiteralDeclaration</c> for why
/// the 2-or-more gate exists (a LONE non-generic literal keeps its existing
/// delegate-valued-variable representation, so no previously-legal program's
/// representation silently changes).
/// </para>
/// </summary>
public class Issue4219NonGenericLocalRecursionTests
{
    [Fact]
    public void TwoMember_NonCapturing_ForwardReferenceCycle()
    {
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                let first = func(x int32, n int32) int32 {
                    if n == 0 { return x }
                    return second(x + 1, n - 1)
                }
                let second = func(x int32, n int32) int32 {
                    if n == 0 { return x }
                    return first(x + 1, n - 1)
                }
                return first(0, 4)
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void ThreeMember_NonCapturing_ForwardReferenceCycle()
    {
        var result = EmittedOracle.Evaluate("""
            func Run() string {
                let first = func(n int32) string {
                    if n == 0 { return "f" }
                    return second(n - 1)
                }
                let second = func(n int32) string {
                    if n == 0 { return "s" }
                    return third(n - 1)
                }
                let third = func(n int32) string {
                    if n == 0 { return "t" }
                    return first(n - 1)
                }
                return first(5)
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("t", result.Value);
    }

    [Fact]
    public void TwoMember_Capturing_ForwardReferenceCycle_SharesCapture()
    {
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                var outer = 1
                let first = func(x int32) int32 {
                    if x == 0 { return outer }
                    return second(x - 1)
                }
                let second = func(x int32) int32 {
                    if x == 0 { return outer }
                    return first(x - 1)
                }
                return first(3) + first(4)
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void MutationInOneMember_VisibleToSiblingAcrossSeparateCalls()
    {
        // Each direct call to a capturing group member materializes its own
        // closure instance (ClosureEmitter.EmitGenericLocalClosureInstance);
        // correctness here relies on the pre-existing CaptureBoxingRewriter
        // boxing `outer` into a shared cell because it is reassigned, so
        // every instance's copy of the captured field aliases the same
        // storage. Confirms that mechanism composes with direct-call
        // dispatch for the non-generic case exactly as it already does for
        // the generic one (#4221).
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                var outer = 0
                let bump = func() { outer = outer + 1 }
                let readIt = func() int32 { return outer }
                bump()
                bump()
                return readIt()
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void SelfRecursion_StillWorksInsideAGroup()
    {
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                let fact = func(n int32) int32 {
                    if n <= 1 { return 1 }
                    return n * fact(n - 1)
                }
                let unrelated = func(x int32) int32 { return x }
                return fact(5)
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(120, result.Value);
    }

    [Fact]
    public void LoneNonGenericLocal_UnaffectedByGrouping()
    {
        // Sanity: a single non-generic local (no sibling to form a run with)
        // is not part of any group and keeps working exactly as before.
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                let first = func(x int32) int32 { return x + 1 }
                return first(41)
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void DuplicateName_StillReportsGS0102()
    {
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                let first = func(x int32) int32 { return x }
                let first = func(x int32) int32 { return x + 1 }
                return first(0)
            }
            Run()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0102");
    }

    [Fact]
    public void OuterNameShadowedBySiblingInSameRun_ReportsAmbiguous()
    {
        // A group member's forward reference resolves the sibling name
        // BEFORE the sequential declaration that would otherwise shadow the
        // outer same-named function — matching the pre-existing generic-
        // group behavior (SameSignatureInOuterScope_RemainsAmbiguous in
        // Issue4219GenericLocalRecursionTests) rather than silently picking
        // one or the other.
        var result = EmittedOracle.Evaluate("""
            func helper(x int32) int32 { return 100 }
            func Run() int32 {
                let a = func(x int32) int32 { return helper(x) }
                let helper = func(x int32) int32 { return 7 }
                return a(1)
            }
            Run()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0266");
    }

    [Fact]
    public void ExplicitOuterTypeClause_FallsBackToOrdinaryDelegatePath_AndTypeChecks()
    {
        // A `let` with an explicit outer type clause is excluded from the
        // direct-call group (IsNonGenericLocalFunctionLiteralDeclaration
        // requires TypeClause: null) precisely because the group's
        // signature comes entirely from the literal itself — a declared
        // outer type would otherwise be silently ignored instead of type-
        // checked. Falling back to the ordinary path means a genuine
        // mismatch is still caught.
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                let f (int32) -> string = func(x int32) int32 { return x }
                return 0
            }
            Run()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0155");
    }

    [Fact]
    public void MixedGenericThenNonGenericSibling_ForwardReference_StillGS0130()
    {
        // Deliberately out of scope here (matches the existing generic/non-
        // generic mixed-group exclusion, see #4219's umbrella comment on
        // "mixed groups" being broader-parity, not this milestone): a
        // generic member's forward reference to a non-generic sibling
        // declared after it still fails exactly as before.
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                let first[T] = func(x T) int32 { return second(0) }
                let second = func(x int32) int32 { return first(x) }
                return first(1)
            }
            Run()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0130");
    }

    [Fact]
    public void NonCapturingGroupMember_MethodGroupConversion_StillWorks()
    {
        // Regression pin: before this change, EVERY non-generic
        // `let f = func ...` was a plain delegate-valued variable, so
        // converting its bare name to an explicit delegate type trivially
        // worked. Switching a 2+-member group's representation to a direct-
        // call FunctionSymbol (ExpressionBinder.IsMethodGroupCandidateUsable)
        // must not break that for a NON-capturing member.
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                let first = func(x int32) int32 { return x + 1 }
                let second = func(x int32) int32 { return first(x) }
                let callback (int32) -> int32 = first
                return callback(41)
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void CapturingGroupMember_MethodGroupConversion_KnownDeferredLimitation()
    {
        // Documented, deliberately deferred limitation: a CAPTURING member
        // of a 2+ non-generic local-function group has no single stable
        // closure instance to bind a bare-name delegate conversion to (each
        // direct call it makes materializes its own instance). This matches
        // the PRE-EXISTING behavior of a capturing GENERIC local function —
        // not a new restriction introduced for the non-generic case — but IS
        // a narrowing relative to the old non-generic delegate-variable
        // baseline, where this converted trivially. Reported here so the
        // gap is pinned, not silently regressed without a test.
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                var outer = 41
                let first = func(x int32) int32 { return outer + x }
                let second = func(x int32) int32 { return first(x) }
                let callback (int32) -> int32 = first
                return callback(1)
            }
            Run()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0126");
    }
}
