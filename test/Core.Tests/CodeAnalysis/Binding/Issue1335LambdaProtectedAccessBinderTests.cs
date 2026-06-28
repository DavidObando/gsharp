// <copyright file="Issue1335LambdaProtectedAccessBinderTests.cs" company="GSharp">
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
/// Issue #1335: a <c>protected</c>/<c>private</c> member of the enclosing class
/// referenced from inside a lambda / function-literal declared in the same class
/// must have the same access as the enclosing member (matching C#). Previously
/// the bind-time accessibility check lost the enclosing-type context inside the
/// closure body — it keyed off the lambda's synthetic function (which carries no
/// receiver) — and wrongly reported <c>GS0379</c>. These binder tests pin the
/// fix for both lambda forms (<c>func (…) { … }</c> and <c>(…) -&gt; …</c>),
/// nested lambdas, and inherited <c>protected</c> members, while confirming that
/// genuine inaccessibility (an unrelated class's <c>protected</c> member) still
/// reports <c>GS0379</c>.
/// </summary>
public class Issue1335LambdaProtectedAccessBinderTests
{
    [Fact]
    public void ProtectedAndPrivateCall_InFuncLiteralLambda_NoGS0379()
    {
        var source = @"
open class C {
    protected func Prot() int32 { return 1 }
    private func Priv() int32 { return 2 }
    func F() int32 {
        let g = func () int32 { return Prot() + Priv() }
        return g()
    }
}
";
        AssertNoGS0379(Evaluate(source));
    }

    [Fact]
    public void ProtectedAndPrivateCall_InArrowLambda_NoGS0379()
    {
        var source = @"
open class C {
    protected func Prot() int32 { return 1 }
    private func Priv() int32 { return 2 }
    func F() int32 {
        let g = (d int32) -> Prot() + Priv() + d
        return g(1)
    }
}
";
        AssertNoGS0379(Evaluate(source));
    }

    [Fact]
    public void PrivateFieldAndProtectedProperty_InLambda_NoGS0379()
    {
        var source = @"
open class C {
    private var f int32 = 5
    protected prop P int32 { get { return 9 } }
    func F() int32 {
        let g = func () int32 { return f + P }
        return g()
    }
}
";
        AssertNoGS0379(Evaluate(source));
    }

    [Fact]
    public void InheritedProtectedMember_InLambda_NoGS0379()
    {
        var source = @"
open class Base {
    protected func BaseHelper() int32 { return 7 }
}
open class Derived : Base {
    func F() int32 {
        let g = func () int32 { return BaseHelper() }
        return g()
    }
}
";
        AssertNoGS0379(Evaluate(source));
    }

    [Fact]
    public void NestedLambda_ProtectedAndPrivate_NoGS0379()
    {
        var source = @"
open class C {
    protected func Prot() int32 { return 1 }
    private func Priv() int32 { return 2 }
    func F() int32 {
        let outer = func () int32 {
            let inner = func () int32 { return Prot() + Priv() }
            return inner()
        }
        return outer()
    }
}
";
        AssertNoGS0379(Evaluate(source));
    }

    [Fact]
    public void UnrelatedClassProtectedMember_InLambda_StillReportsGS0379()
    {
        // Genuine inaccessibility must still be reported: a `protected` member of
        // an unrelated class accessed from a lambda is not made accessible by the
        // enclosing-type fallback.
        var source = @"
open class Other {
    protected func Secret() int32 { return 1 }
}
class C {
    func F() int32 {
        let o = Other{}
        let g = func () int32 { return o.Secret() }
        return g()
    }
}
";
        var diagnostics = Evaluate(source).Diagnostics;
        Assert.Contains(diagnostics, d => d.Id == "GS0379");
    }

    private static void AssertNoGS0379(EvaluationResult result)
    {
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0379");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
