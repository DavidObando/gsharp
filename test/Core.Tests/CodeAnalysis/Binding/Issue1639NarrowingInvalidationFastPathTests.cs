// <copyright file="Issue1639NarrowingInvalidationFastPathTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1639 — <c>InvalidateNarrowingsForAssignedVariables</c> used to walk
/// every statement's full syntax subtree twice (once via
/// <c>CollectAssignedNames</c>, once via <c>StatementMayMutateMemberPaths</c>)
/// even when zero narrowings were active, because
/// <c>BinderContext.NarrowedVariables.Count == 0</c> never fires — a block
/// pushes a (usually empty) persistent frame unconditionally. The fix adds a
/// real "any frame non-empty" fast-path guard and merges the two walks into
/// one. These tests pin the invariant: no active narrowing ⇒ the walk is
/// skipped with no diagnostic change, and whenever a narrowing IS active,
/// invalidation behaves exactly as before — including across nested blocks,
/// loops, and branches, and for both plain-variable and member-path
/// narrowings.
/// </summary>
public class Issue1639NarrowingInvalidationFastPathTests
{
    [Fact]
    public void NoActiveNarrowing_PlainStatements_FastPathProducesNoDiagnostics()
    {
        // No `is`/nil-guard/assignment narrowing is ever established here, so
        // every block's persistent frame stays empty for the whole function.
        // This exercises the fast path (HasAnyActiveNarrowings == false) on a
        // variety of statement shapes: plain assignment, a call, a loop, and a
        // branch — none of which should trigger a syntax walk, and none of
        // which should change binding results.
        var result = Evaluate(@"
class C {
    func Helper() int32 { return 1 }
    func F(n int32) int32 {
        var total = 0
        var i = 0
        while i < n {
            total = total + Helper()
            i = i + 1
        }
        if total > 0 {
            total = total + 1
        }
        return total
    }
}
C{}.F(3)
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ActiveLocalNarrowing_InvalidatingAssignment_StillInvalidates()
    {
        // A narrowing is active (assignment smart cast on `x`); a subsequent
        // possibly-null reassignment must still clear it, even with the new
        // fast-path guard in place.
        var result = Evaluate(@"
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E, maybe E?) int32 {
        var x E? = nil
        x = fresh
        x = maybe
        return x.M()
    }
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("M", System.StringComparison.Ordinal));
    }

    [Fact]
    public void ActiveLocalNarrowing_NonInvalidatingStatement_NarrowingSurvives()
    {
        // Control for the above: with the same active narrowing, a statement
        // that does NOT reassign `x` must leave the narrowing intact.
        var result = Evaluate(@"
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E) int32 {
        var x E? = nil
        x = fresh
        var unrelated = 1
        return x.M() + unrelated
    }
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ActiveMemberPathNarrowing_InterveningMemberAssignment_StillInvalidates()
    {
        // Mirrors Issue1180's member-path invalidation coverage: an active
        // member-path narrowing must still be dropped by an intervening
        // member-mutating assignment, exercising the merged single-pass walk.
        var result = Evaluate(@"
open class Animal { var Name string }
class Dog : Animal { func Bark() string { return ""woof"" } }
class Box { var Other int32 = 0 let Pet Animal }
func Run(b Box) string {
    if b.Pet !is Dog { return """" }
    b.Other = 1
    return b.Pet.Bark()
}
Run(Box{Pet: Dog{Name: ""Rex""}})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Bark", System.StringComparison.Ordinal));
    }

    [Fact]
    public void ActiveNarrowing_InvalidatedInsideNestedLoopAndBranch_DoesNotEscape()
    {
        // The narrowing on `x` is invalidated by a reassignment nested two
        // levels deep (inside an if inside a while). The invalidation must
        // still propagate to all active frames (per-block persistent frames
        // up the stack), so the member access after the loop sees the
        // original nullable type again.
        var result = Evaluate(@"
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E, maybe E?, n int32) int32 {
        var x E? = nil
        x = fresh
        var i = 0
        while i < n {
            if i == 0 {
                x = maybe
            }
            i = i + 1
        }
        return x.M()
    }
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("M", System.StringComparison.Ordinal));
    }

    [Fact]
    public void ActiveNarrowing_ReNarrowedInsideBranch_ReachesNestedBlock()
    {
        // Positive nested-block control: narrowing established, then
        // re-affirmed inside a branch, must still reach a further-nested
        // block without any diagnostic.
        var result = Evaluate(@"
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E) int32 {
        var x E? = nil
        x = fresh
        if true {
            x = fresh
            if true {
                return x.M()
            }
        }
        return 0
    }
}
");

        Assert.Empty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
