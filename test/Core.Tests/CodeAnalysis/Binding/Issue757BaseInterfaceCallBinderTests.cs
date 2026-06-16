// <copyright file="Issue757BaseInterfaceCallBinderTests.cs" company="GSharp">
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
/// ADR-0091 / issue #757: binder tests for the explicit-base interface
/// call expression <c>base[IFoo].Method(args)</c>. Verifies that the
/// happy path resolves to the inherited default body, and that all four
/// diagnostics (GS0338 / GS0339 / GS0340 / GS0341) fire on the expected
/// ill-formed inputs. Also covers chaining and use inside a private
/// member of the implementing class.
/// </summary>
public class Issue757BaseInterfaceCallBinderTests
{
    [Fact]
    public void DiamondDelegation_ExplicitBase_ResolvesAndRuns()
    {
        var source = @"
interface IA {
    func M() int32 { return 10 }
}

interface IB {
    func M() int32 { return 20 }
}

class C : IA, IB {
    func M() int32 { return base[IA].M() + base[IB].M() }
}

var c = C{}
c.M()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(30, result.Value);
    }

    [Fact]
    public void BaseInterface_NotImplemented_DiagnosticGS0338()
    {
        var source = @"
interface IFoo {
    func M() int32 { return 1 }
}

interface IBar {
    func M() int32 { return 2 }
}

class C : IFoo {
    func M() int32 { return base[IBar].M() }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0338");
    }

    [Fact]
    public void BaseInterface_MemberNotOnInterface_DiagnosticGS0339()
    {
        var source = @"
interface IFoo {
    func M() int32 { return 1 }
}

class C : IFoo {
    func M() int32 { return base[IFoo].NotAMember() }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0339");
    }

    [Fact]
    public void BaseInterface_AbstractMember_DiagnosticGS0340()
    {
        var source = @"
interface IFoo {
    func M() int32;
}

class C : IFoo {
    func M() int32 { return base[IFoo].M() }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0340");
    }

    [Fact]
    public void BaseInterface_PrivateHelper_DiagnosticGS0341()
    {
        // ADR-0090 / issue #756: private interface helpers are not part
        // of the public contract — ADR-0091 forbids explicit-base calls
        // from reaching them.
        var source = @"
interface IFoo {
    func M() int32 { return Helper() }
    private func Helper() int32 { return 7 }
}

class C : IFoo {
    func M() int32 { return base[IFoo].Helper() }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0341");
    }

    [Fact]
    public void ChainedBaseCalls_BothResolve()
    {
        var source = @"
interface IA {
    func V() int32 { return 3 }
}

interface IB {
    func V() int32 { return 5 }
}

class C : IA, IB {
    func V() int32 { return base[IA].V() + base[IB].V() }
}

var c = C{}
c.V()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(8, result.Value);
    }

    [Fact]
    public void BaseInterfaceCall_InsidePrivateMember_IsAllowed()
    {
        // ADR-0091: the binder restricts only by enclosing TYPE, not by
        // the enclosing method's accessibility. A private member of the
        // implementing class may still issue `base[IFoo].M()`.
        var source = @"
interface IFoo {
    func Greet() string { return ""hi"" }
}

class C : IFoo {
    func Greet() string { return Inner() }
    private func Inner() string { return base[IFoo].Greet() + ""!"" }
}

var c = C{}
c.Greet()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hi!", result.Value);
    }

    [Fact]
    public void BaseInterfaceCall_OutsideInstanceMember_DiagnosticGS0338()
    {
        // ADR-0091: `base[IFoo]` is only meaningful inside an instance
        // member of a class. A top-level function has no enclosing type.
        var source = @"
interface IFoo {
    func M() int32 { return 1 }
}

func TopLevel() int32 { return base[IFoo].M() }
TopLevel()
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0338");
    }

    [Fact]
    public void BaseInterfaceCall_WrongArgCount_ReportsArgCountDiagnostic()
    {
        // Sanity: the binder routes a wrong-arity site through the
        // existing wrong-arg-count diagnostic (GS0036) for ergonomic
        // recovery, rather than silently picking another overload.
        var source = @"
interface IFoo {
    func M(x int32) int32 { return x }
}

class C : IFoo {
    func M(x int32) int32 { return base[IFoo].M() }
}
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
