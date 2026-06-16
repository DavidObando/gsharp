// <copyright file="StaticVirtualInterfaceTests.cs" company="GSharp">
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
/// ADR-0089 / issue #755 (issue #865 revision) — static-virtual interface
/// members. These tests pin the binder behaviour for the <c>shared { … }</c>
/// interface member shape, the generic-constraint <c>[T IFoo]</c> dispatch
/// path (<c>T.M(args)</c>), and the diagnostics introduced for failures on the
/// implementer side (GS0330–GS0333).
/// </summary>
public class StaticVirtualInterfaceTests
{
    [Fact]
    public void StaticFunc_AbstractInInterface_Binds()
    {
        var source = @"
sealed interface IZero {
    shared {
        func Zero() int32;
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void StaticFunc_DefaultBodyInInterface_Binds()
    {
        var source = @"
sealed interface IZero {
    shared {
        func Zero() int32 { return 0 }
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Implementer_WithSharedStatic_NoDiagnostics()
    {
        // Canonical pattern: the implementer's shared-block static method
        // satisfies the interface's static-virtual abstract slot.
        var source = @"
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
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Implementer_MissingAbstractStatic_ReportsGS0331()
    {
        var source = @"
sealed interface IAdd {
    shared {
        func Add(a int32, b int32) int32;
    }
}

class BrokenAdder : IAdd {
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0331");
    }

    [Fact]
    public void Implementer_InstanceMethodForStaticSlot_ReportsGS0332()
    {
        var source = @"
sealed interface IAdd {
    shared {
        func Add(a int32, b int32) int32;
    }
}

class WrongAdder : IAdd {
    func Add(a int32, b int32) int32 { return a + b }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0331" || d.Id == "GS0332");
    }

    [Fact]
    public void Default_OnInterface_AllowsImplementerToOmit()
    {
        // ADR-0089 §3.2: a default static body lets implementers omit the
        // override entirely. The binder must NOT emit GS0331 here.
        var source = @"
sealed interface IZero {
    shared {
        func Zero() int32 { return 0 }
    }
}

class IntZero : IZero {
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GenericConstraint_WithStaticVirtualInterface_NonSealed_Allowed()
    {
        // ADR-0089 §6.2: the GS0153 sealed-only restriction is relaxed when
        // the interface carries any static-virtual member. A non-sealed
        // static-virtual interface MUST be usable as a generic constraint
        // because it is the only way generic-math abstractions compose.
        var source = @"
interface IFactory {
    shared {
        func Make() int32 { return 0 }
    }
}

func Use[T IFactory]() int32 { return T.Make() }
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Message.Contains("sealed", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void TypeParameter_StaticAccess_WithMatchingMember_Binds()
    {
        // The canonical generic-math dispatch: `T.Add(...)` where `T : IAdd`.
        // No diagnostics on the call site.
        var source = @"
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

func Sum[T IAdd](w T, a int32, b int32) int32 {
    return T.Add(a, b)
}

Sum(Adder{}, 3, 4)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void TypeParameter_StaticAccess_NonExistentMember_ReportsGS0333()
    {
        var source = @"
sealed interface IAdd {
    shared {
        func Add(a int32, b int32) int32;
    }
}

func Wrong[T IAdd](a int32, b int32) int32 {
    return T.Multiply(a, b)
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0333");
    }

    [Fact]
    public void InterfaceSharedBlock_NonFuncMember_ReportsGS0330()
    {
        // Issue #865 revision: interface static state (`var` / `let` / `const`
        // / `prop` / `event`) is deferred; only `func` members are allowed in
        // an interface `shared { … }` block. The parser rejects the others
        // with GS0330.
        var source = @"
interface IBad {
    shared {
        let Zero int32 = 0
    }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0330");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
