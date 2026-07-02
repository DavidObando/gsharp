// <copyright file="RefKindDefiniteAssignmentTests.cs" company="GSharp">
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
/// ADR-0060 items #4 and #5 — definite-assignment analysis specialized
/// for ref-kind parameters: GS0238 for out-parameters not assigned on
/// every return path, GS0239 for variables passed by `ref` while still
/// unassigned at the call site.
/// </summary>
public class RefKindDefiniteAssignmentTests
{
    private static EvaluationResult Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    [Fact]
    public void OutParameterNotAssigned_ReportsGS0238()
    {
        const string Source = @"package OutDA1

func bad(out a int32) {
    return
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0238");
    }

    [Fact]
    public void OutParameterAssignedOnAllPaths_NoDiagnostic()
    {
        const string Source = @"package OutDA2

func ok(out a int32, cond bool) {
    if cond {
        a = 1
    } else {
        a = 2
    }
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0238");
    }

    [Fact]
    public void OutParameterAssignedOnOnlyOneBranch_ReportsGS0238()
    {
        const string Source = @"package OutDA3

func bad(out a int32, cond bool) {
    if cond {
        a = 1
    }
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0238");
    }

    [Fact]
    public void OutParameterAssignedUnconditionally_NoDiagnostic()
    {
        const string Source = @"package OutDA4

func ok(out a int32) {
    a = 99
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0238");
    }

    [Fact]
    public void RefArgumentUnassigned_ReportsGS0239()
    {
        const string Source = @"package RefDA1

func bump(ref x int32) {
    x = x + 1
}

func caller() {
    var x int32
    bump(&x)
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0239");
    }

    [Fact]
    public void RefArgumentAssigned_NoDiagnostic()
    {
        const string Source = @"package RefDA2

func bump(ref x int32) {
    x = x + 1
}

func caller() {
    var x = 0
    bump(&x)
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0239");
    }

    [Fact]
    public void OutArgumentAssignsForRef_NoDiagnostic()
    {
        const string Source = @"package RefDA3

func produce(out x int32) {
    x = 42
}

func bump(ref x int32) {
    x = x + 1
}

func caller() {
    var x int32
    produce(&x)
    bump(&x)
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0239");
    }

    // Issue #1642 — the definite-assignment CFG previously treated
    // try/select/scope/fixed bodies as opaque, so assignments inside them
    // were invisible and produced false GS0238/GS0239 errors on valid code.

    [Fact]
    public void OutParameterAssignedInTryAndFinally_NoDiagnostic()
    {
        // Exact repro from issue #1642.
        const string Source = @"package TryDA1

func ok(out a int32) {
    try { a = 1 } finally { }
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0238");
    }

    [Fact]
    public void OutParameterAssignedOnlyInFinally_NoDiagnostic()
    {
        // `finally` always runs, so an assignment made only there is
        // guaranteed regardless of what happens in the try body.
        const string Source = @"package TryDA2

func ok(out a int32) {
    try { } finally { a = 1 }
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0238");
    }

    [Fact]
    public void OutParameterAssignedInTryBodyOnly_CatchDoesNotAssign_ReportsGS0238()
    {
        // An exception could skip the try-body assignment, and the catch
        // clause (which can complete normally without assigning `a`)
        // doesn't guarantee it either — must still be rejected.
        const string Source = @"package TryDA3

import System

func bad(out a int32) {
    try {
        a = 1
    } catch (e Exception) {
    }
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0238");
    }

    [Fact]
    public void OutParameterAssignedInTryAndEveryCatch_NoDiagnostic()
    {
        const string Source = @"package TryDA4

import System

func ok(out a int32) {
    try {
        a = 1
    } catch (e Exception) {
        a = 2
    }
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0238");
    }

    [Fact]
    public void OutParameterAssignedInScopeBody_NoDiagnostic()
    {
        const string Source = @"package ScopeDA1

func ok(out a int32) {
    scope {
        a = 1
    }
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0238");
    }

    [Fact]
    public void OutParameterAssignedInFixedBody_NoDiagnostic()
    {
        const string Source = @"package FixedDA1

unsafe func ok(out a int32, arr []int32) {
    fixed p *int32 = arr {
        a = 1
    }
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0238");
    }

    [Fact]
    public void OutParameterAssignedInEveryExhaustiveSelectArm_NoDiagnostic()
    {
        // `select` always blocks until exactly one arm runs its body, so an
        // assignment made on every arm is guaranteed afterward.
        const string Source = @"package SelectDA1

func ok(out a int32) {
    let ch = make(chan int32, 1)
    ch <- 1
    select {
    case let v = <-ch {
        a = v
    }
    default {
        a = 0
    }
    }
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0238");
    }

    [Fact]
    public void IndirectAssignmentThroughPointer_CountsAsAssignment()
    {
        // `*p = expr` (BoundIndirectAssignmentExpression) through a pointer
        // known to alias the out parameter must count as an assignment.
        const string Source = @"package IndirectDA1

unsafe func ok(out a int32) {
    var p *int32 = &a
    *p = 5
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0238");
    }

    [Fact]
    public void ReturnInsideTryWithoutAssigningOutParameter_ReportsGS0238()
    {
        // A `return` nested inside a try body still leaves the function; the
        // out parameter must be assigned before it, same as a top-level return.
        const string Source = @"package TryDA5

func bad(out a int32, cond bool) {
    try {
        if cond {
            return
        }

        a = 1
    } finally {
    }
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0238");
    }
}
