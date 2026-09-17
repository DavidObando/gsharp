// <copyright file="Issue4285GotoNarrowingReachabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4285 (PR A of the ADR-0183 sequence): a user-written <c>goto</c>
/// that jumps PAST a nil-guard's implicit exit — landing directly at (or
/// inside) the region the guard's else-frame narrowing was lifted into —
/// bypasses the guard entirely while <see cref="EndsInUnconditionalExit"/>
/// (a purely structural, single-statement check) still sees the then-branch
/// as "always exits" and lets the lift through. The fix is deliberately
/// conservative: <c>ApplyEarlyExitNarrowings</c> no-ops for the WHOLE
/// function whenever its body contains any user goto/label at all
/// (<see cref="BinderContext.FunctionContainsUserGotoOrLabel"/>), rather than
/// a precise CFG-based check of which lift site a given goto can actually
/// reach.
/// <para>
/// Minimal repro from the filed issue, verbatim
/// (<c>this.name string?</c> / <c>this.name.ToUpper()</c>), does NOT exercise
/// this defect end-to-end: calling a CLR-imported instance method
/// (<c>System.String.ToUpper</c>) through a nullable receiver is never
/// null-checked by this binder at all, narrowed or not — a separate,
/// pre-existing gap, out of scope here (ADR-0183 PR A touches only the
/// narrowing-lift soundness bug), tracked as issue #4287. Verified directly:
/// the literal repro still compiles with zero diagnostics and still throws
/// at runtime after this fix, and reproduces identically with NO `goto` and
/// NO narrowing involved at all (a plain, unconditional
/// `this.name.ToUpper()` with no guard anywhere in the function already
/// throws) — confirming it is wholly unrelated to this issue's mechanism.
/// These tests instead use a call to a USER-DEFINED function through a
/// nullable field/type-tested field, which IS validated
/// (<c>DiagnosticBag.ReportUnableToFindFunction</c> / GS0159, "receiver may
/// be nil" or "Cannot find function") — the same diagnostic style
/// <c>Issue1180SmartCastMembersBinderTests</c> uses for its negative
/// (non-narrowing) cases.
/// </para>
/// </summary>
public class Issue4285GotoNarrowingReachabilityTests
{
    private const string Hierarchy = @"
open class Animal {
    var Name string
    open func Describe() string { return Name }
}
class Dog : Animal {
    func Bark() string { return ""woof"" }
}
";

    [Fact]
    public void Goto_BypassesNilGuard_DoesNotNarrowFieldPath()
    {
        // Mirrors the filed issue's shape exactly, substituting a
        // user-defined nullable field/call (which IS null-checked) for the
        // literal `string?`/`ToUpper()` repro (which is not, for the
        // unrelated reason documented on the type). Without the fix, the
        // `goto Skip` structurally "ends the then-branch in an unconditional
        // exit", so the else-frame narrowing (`b.Pet` non-nil) was
        // incorrectly lifted past `Skip:`, and this compiled with zero
        // diagnostics before throwing a NullReferenceException at runtime.
        var result = Evaluate(Hierarchy + @"
class Box { let Pet Animal? }
func Run(b Box) string {
    if b.Pet == nil {
        goto Skip
    }
    Skip:
    return b.Pet.Describe()
}
Run(Box{Pet: nil})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("may be nil", StringComparison.Ordinal));
    }

    [Fact]
    public void Goto_BypassesTypeGuard_SwitchVariant_DoesNotNarrowFieldPath()
    {
        // Same defect, but through the post-switch narrowing lift (ADR-0069
        // addendum / issue #712) rather than the post-if lift: a `case is
        // Dog {}` arm falls through with the discriminant narrowed to `Dog`,
        // and (with a `default { return "" }` arm) issue #712 lifts that
        // narrowing past the switch. The `goto`/`Never:` pair here is
        // syntactically unreachable (`if false`) and has nothing to do with
        // the switch — its mere PRESENCE anywhere in the function is what
        // must suppress the lift under this conservative fix.
        var result = Evaluate(Hierarchy + @"
class Box { let Pet Animal }
func Run(b Box) string {
    switch b.Pet {
        case d is Dog {}
        default { return """" }
    }
    if false {
        goto Never
    }
    Never:
    return b.Pet.Bark()
}
Run(Box{Pet: Dog{Name: ""Rex""}})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", StringComparison.Ordinal));
    }

    [Fact]
    public void Goto_UnrelatedToNarrowing_LoopUnrollingStyle_StillCompilesCleanly()
    {
        // Negative control: an ordinary goto/label loop with no narrowing
        // anywhere nearby. This fix must not break plain goto/label
        // compilation — it only ever suppresses a narrowing LIFT, never
        // goto/label binding itself.
        var result = Evaluate(@"
func Sum() int32 {
    var total = 0
    var i = 0
Loop:
    if i >= 5 {
        goto Done
    }
    total = total + i
    i = i + 1
    goto Loop
Done:
    return total
}
Sum()
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Goto_BypassesGuardLetElse_DoesNotNarrowBoundVariable()
    {
        // ADR-0071 `guard let` (issue #708) threads its narrowing directly
        // into the persistent frame in BindGuardLetStatementInBlock rather
        // than through ApplyEarlyExitNarrowings/PendingEarlyExitFrames (see
        // that method's own comment: "We *cannot* round-trip through
        // ApplyEarlyExitNarrowings..."), so it needs its own copy of the
        // same whole-function goto/label suppression. Without it, `guard let
        // p = b.Pet else { goto Skip }` followed by a reachable `Skip:`
        // would let `p.Describe()` bind as if `p` were proven non-nil, for
        // the identical reason the if-statement case does.
        var result = Evaluate(Hierarchy + @"
class Box { let Pet Animal? }
func Run(b Box) string {
    guard let p = b.Pet else {
        goto Skip
    }
    Skip:
    return p.Describe()
}
Run(Box{Pet: nil})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("may be nil", StringComparison.Ordinal));
    }

    [Fact]
    public void NoGotoOrLabel_GuardLet_StillNarrowsBoundVariable()
    {
        // Regression check: guard-let's normal narrowing lift is unaffected
        // for a function with no goto/label anywhere.
        var result = Evaluate(Hierarchy + @"
class Box { let Pet Animal? }
func Run(b Box) string {
    guard let p = b.Pet else {
        return """"
    }
    return p.Describe()
}
Run(Box{Pet: Dog{Name: ""Rex""}})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NoGotoOrLabel_StillLiftsNarrowingAfterEarlyReturn()
    {
        // Regression check: a function with NO goto/label anywhere must keep
        // today's early-exit narrowing lift exactly as before (the fix is a
        // pure no-op for such functions). Mirrors
        // Issue1180SmartCastMembersBinderTests.If_NegatedIsTest_NarrowsStableFieldPathAfterEarlyReturn.
        var result = Evaluate(Hierarchy + @"
class Box { let Pet Animal }
func Run(b Box) string {
    if b.Pet !is Dog { return """" }
    return b.Pet.Bark()
}
Run(Box{Pet: Dog{Name: ""Rex""}})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void OuterFunctionGotoLabel_DoesNotSuppressNestedLambdaOwnNarrowing()
    {
        // ADR-0070's "label namespace is local to the enclosing function"
        // rule means a nested function-literal/lambda body gets its OWN
        // fresh goto/label frame (LambdaBinder.EnterNestedFrame) — and so
        // must get its own fresh FunctionContainsUserGotoOrLabel flag. The
        // OUTER function's unrelated goto/label must not suppress the
        // narrowing lift inside a lambda that itself contains no goto/label.
        var result = Evaluate(Hierarchy + @"
class Box { let Pet Animal }
func Outer(b Box) string {
    if false {
        goto Never
    }
    Never:
    var f = func(inner Box) string {
        if inner.Pet !is Dog { return """" }
        return inner.Pet.Bark()
    }
    return f(b)
}
Outer(Box{Pet: Dog{Name: ""Rex""}})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NestedLambdaGotoLabel_DoesNotSuppressOuterFunctionOwnNarrowing()
    {
        // The reverse direction of the scoping nuance above: the OUTER
        // function has no goto/label of its own and must keep its normal
        // narrowing lift even though a NESTED lambda it declares has its own
        // (properly isolated) goto/label.
        var result = Evaluate(Hierarchy + @"
class Box { let Pet Animal }
func Outer(b Box) string {
    if b.Pet !is Dog { return """" }
    var f = func() int32 {
        if false {
            goto Never
        }
        Never:
        return 1
    }
    return b.Pet.Bark() + f().ToString()
}
Outer(Box{Pet: Dog{Name: ""Rex""}})
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Goto_BypassesPatternVariableLeakElse_DoesNotLeakUnassignedVariable()
    {
        // A third sibling of the same defect class: ADR-0166's pattern-
        // variable "leak" (RecordPatternVariableLeak / ApplyEarlyExitPatternVariables,
        // StatementBinder.Conditionals.cs) declares a pattern variable into
        // the ENCLOSING scope when the opposite arm unconditionally exits —
        // using the same EndsInUnconditionalExit structural check as the
        // narrowing lift. A goto that bypasses the whole if-statement (never
        // running the pattern test OR the exiting else) reaches `Skip:` with
        // `s` never assigned on that path — worse than a narrowing bug, since
        // an uninitialized read is not merely "wrongly proven non-nil", it is
        // undefined. Before the fix this compiled with ZERO diagnostics and
        // threw a NullReferenceException at runtime (verified directly:
        // EmittedOracleResult wraps it as a synthesized GS9999, "Object
        // reference not set to an instance of an object"). After the fix,
        // `s` is never declared into the enclosing scope, so it reports the
        // ordinary GS0532 pattern-variable-outside-dominated-region
        // diagnostic instead — a real compile-time error, not a disguised
        // runtime crash.
        var result = Evaluate(@"
func Run(cond bool, value object) int32 {
    if cond { goto Skip }
    if value is string s {} else { return 0 }
    Skip:
    return s.Length
}
Console.WriteLine(Run(true, 42))
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("not definitely assigned", StringComparison.Ordinal));
    }

    [Fact]
    public void NoGotoOrLabel_PatternVariableLeak_StillLeaksIntoEnclosingScope()
    {
        // Regression check: a function with NO goto/label anywhere must keep
        // today's ADR-0166 pattern-variable leak exactly as before.
        var result = Evaluate(@"
func Use(value object) int32 {
    if value is string s {} else { return 0 }
    return s.Length
}
Console.WriteLine(Use(""hi""))
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GotoFreeLambdaDeclaredBeforeGuard_DoesNotLeakSuppressionIntoOuterFunction()
    {
        // Regression coverage for LambdaBinder.RestoreNestedFrame's restore
        // of FunctionContainsUserGotoOrLabel: a goto-FREE lambda declared
        // BEFORE the outer function's own goto/label narrows nothing itself,
        // but binding it must not leave the outer function's flag clobbered
        // with the lambda's own (false) value once binding returns to the
        // outer function's statements. Without the restore, the outer
        // function's later early-exit lift would incorrectly re-enable
        // itself here even though the outer function DOES contain a goto.
        var result = Evaluate(Hierarchy + @"
class Box { let Pet Animal? }
func Run(b Box) string {
    var f = func() int32 { return 1 }
    if b.Pet == nil {
        goto Skip
    }
    Skip:
    return b.Pet.Describe() + f().ToString()
}
Run(Box{Pet: nil})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("may be nil", StringComparison.Ordinal));
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}
