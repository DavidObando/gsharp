// <copyright file="Issue1159LambdaEnclosingInstanceMemberBinderTests.cs" company="GSharp">
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
/// Issue #1159: an unqualified reference to an enclosing-instance member from
/// inside a lambda / closure body must resolve (capturing <c>this</c>) just as
/// it does when written directly in the method body or with an explicit
/// <c>this.</c> receiver. Previously the unqualified call path
/// (<c>H(d)</c> → GS0130) and the method-group-as-value path
/// (<c>let fn = H</c> → GS0125) keyed off the lambda's synthetic enclosing
/// function (which carries no receiver) instead of the enclosing instance
/// method's <c>this</c> still visible in lexical scope. Both lambda forms
/// (<c>func (…) { … }</c> and <c>(…) -&gt; …</c>) and nested lambdas are
/// covered. Static-context behavior is unchanged: a genuinely-undefined name
/// still reports its diagnostic.
/// </summary>
public class Issue1159LambdaEnclosingInstanceMemberBinderTests
{
    [Fact]
    public void UnqualifiedInstanceCall_InFuncLiteralLambda_Resolves()
    {
        var source = @"
class C {
    func H(x int32) { }
    func F() {
        let g = func (d int32) {
            H(d)
        }
        g(1)
    }
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void UnqualifiedInstanceCall_InArrowLambda_Resolves()
    {
        var source = @"
class C {
    func H(x int32) { }
    func F() {
        let g = (d int32) -> H(d)
        g(1)
    }
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void UnqualifiedInstanceCall_ValueReturningArrowLambda_Resolves()
    {
        var source = @"
class C {
    func H(x int32) int32 { return x }
    func F() {
        let g = (d int32) -> H(d)
        let r int32 = g(1)
    }
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void InstanceMethodGroupAsValue_InLambda_Resolves()
    {
        var source = @"
class C {
    func H(x int32) { }
    func F() {
        let g = func (d int32) {
            let fn = H
            fn(d)
        }
        g(1)
    }
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void UnqualifiedInstanceCall_InNestedLambda_Resolves()
    {
        var source = @"
class C {
    func H(x int32) { }
    func F() {
        let g = func (d int32) {
            let inner = func (e int32) {
                H(e)
            }
            inner(d)
        }
        g(1)
    }
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void ExplicitThisCall_InLambda_StillResolves()
    {
        // Control: the explicit `this.` receiver path already worked and must
        // keep working unchanged.
        var source = @"
class C {
    func H(x int32) { }
    func F() {
        let g = func (d int32) {
            this.H(d)
        }
        g(1)
    }
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void DirectUnqualifiedInstanceCall_StillResolves()
    {
        // Control: a non-lambda unqualified instance call must remain unaffected.
        var source = @"
class C {
    func H(x int32) { }
    func F() { H(1) }
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void UndefinedName_InLambda_InInstanceMethod_StillReportsGS0130()
    {
        // The implicit-`this` fallback must not invent a resolution for a name
        // that no enclosing instance member defines.
        var source = @"
class C {
    func F() {
        let g = func (d int32) {
            Nope(d)
        }
        g(1)
    }
}
";
        var diagnostics = Evaluate(source).Diagnostics;
        Assert.Contains(diagnostics, d => d.IsError && d.Message.Contains("Nope"));
    }

    [Fact]
    public void UndefinedName_InLambda_InStaticMethod_StillReportsGS0130()
    {
        // Static context: no `this` is in scope, so the effective-`this`
        // lookup yields null and resolution stays unchanged (still errors).
        var source = @"
class C {
    shared {
        func F() {
            let g = func (d int32) {
                Nope(d)
            }
            g(1)
        }
    }
}
";
        var diagnostics = Evaluate(source).Diagnostics;
        Assert.Contains(diagnostics, d => d.IsError && d.Message.Contains("Nope"));
    }

    [Fact]
    public void UnqualifiedFieldRead_InLambda_StillResolves()
    {
        // Control: bare instance field reads already resolved through the
        // implicit-member scope symbols; this must remain unaffected.
        var source = @"
class C {
    var state int32 = 10
    func F() int32 {
        let g = func (d int32) int32 { return state + d }
        return g(5)
    }
}
";
        AssertNoErrors(Evaluate(source));
    }

    private static void AssertNoErrors(EvaluationResult result)
    {
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
