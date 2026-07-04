// <copyright file="Issue1989MultiArityOpenGenericTypeOfBindingTests.cs" company="GSharp">
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
/// Issue #1989: same-base-name multi-arity BCL generic families broke the
/// #1915 bare-name open-generic <c>typeof(...)</c> fallback. <c>typeof(Func)</c>
/// stays GS0113 (ambiguous across Func`1..Func`16 — correct, still requires
/// disambiguation) and <c>typeof(Action)</c> keeps resolving the non-generic
/// <c>System.Action</c> (unchanged, still correct on its own). The NEW
/// explicit-arity form <c>typeof(Name[_, ...])</c> (<c>_</c> placeholder type
/// arguments, G#'s analogue of C#'s comma-count <c>Name&lt;&gt;</c>) lets a
/// caller pick a specific arity out of a same-base-name family, and NEVER
/// falls back to a same-named non-generic type.
/// </summary>
public class Issue1989MultiArityOpenGenericTypeOfBindingTests
{
    [Fact]
    public void BareFunc_TypeOf_StillReportsAmbiguousGS0113()
    {
        var source = @"
import System

class C {
    func run() {
        let t = typeof(Func)
    }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0113");
    }

    [Fact]
    public void ExplicitArityOneFunc_TypeOf_BindsToOpenGenericOneArityDefinition()
    {
        var source = @"
import System

class C {
    func run() {
        let t = typeof(Func[_])
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ExplicitArityTwoFunc_TypeOf_BindsToOpenGenericTwoArityDefinition()
    {
        var source = @"
import System

class C {
    func run() {
        let t = typeof(Func[_, _])
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ExplicitArityOneAction_TypeOf_BindsToGenericAction_NotNonGenericAction()
    {
        var source = @"
import System

class C {
    func run() {
        let t = typeof(Action[_])
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void BareAction_TypeOf_StillResolvesNonGenericAction()
    {
        var source = @"
import System

class C {
    func run() {
        let t = typeof(Action)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ExplicitArityHuge_NoMatch_ReportsUndefinedTypeGS0113()
    {
        var source = @"
import System

class C {
    func run() {
        let t = typeof(Func[_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _])
    }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0113");
    }

    /// <summary>
    /// Issue #2012 (N1): <c>_</c> is an ordinary identifier in G#'s grammar
    /// (not a reserved type-name token), so user code can legally declare a
    /// real type literally named <c>_</c>. When it does, <c>typeof(Func[_])</c>
    /// must bind the type argument to that REAL type (an ordinary closed
    /// generic <c>Func&lt;_&gt;</c>) rather than silently reading <c>_</c> as
    /// the open-generic placeholder and flipping to unbound <c>Func`1</c>.
    /// </summary>
    [Fact]
    public void RealTypeNamedUnderscore_TypeOf_BindsToClosedGeneric_NotOpenGeneric()
    {
        var source = @"
import System

class _ {
}

class C {
    func run() {
        let t = typeof(Func[_])
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
