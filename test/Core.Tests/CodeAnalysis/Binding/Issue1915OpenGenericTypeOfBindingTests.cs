// <copyright file="Issue1915OpenGenericTypeOfBindingTests.cs" company="GSharp">
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
/// Issue #1915 (sub-bug b, binder side): <c>typeof(List)</c> — the bare
/// generic-definition name cs2gs already emits for a C# unbound generic
/// (<c>typeof(List&lt;&gt;)</c>) — reported GS0113 "Type 'List' doesn't
/// exist" because <c>BoundScope.TryLookupImportedClass</c> only ever tried
/// the exact, non-generic reflection name. <c>Binder.BindTypeOfExpression</c>
/// now falls back, for a bare simple type-clause with no type-argument list,
/// qualifier, array shape, or nullable suffix, to an arity-suffixed
/// (<c>`1</c>, <c>`2</c>, …) reflection lookup across the file's imports —
/// binding to the CLR open generic type definition when exactly one match
/// exists. This fallback is scoped to <c>typeof(...)</c> only; a bare
/// generic name elsewhere (e.g. a variable's declared type) still reports
/// GS0113, since an open generic has no usable members/constructors there.
/// </summary>
public class Issue1915OpenGenericTypeOfBindingTests
{
    [Fact]
    public void BareImportedGenericName_TypeOf_BindsToOpenGenericDefinition()
    {
        var source = @"
import System.Collections.Generic

class C {
    func run() {
        let t = typeof(List)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void BareImportedGenericName_TwoArity_TypeOf_BindsToOpenGenericDefinition()
    {
        var source = @"
import System.Collections.Generic

class C {
    func run() {
        let t = typeof(Dictionary)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void BareGenericName_OutsideTypeOf_StillReportsUndefinedType()
    {
        // The fallback is intentionally scoped to `typeof(...)` — a bare
        // generic name used as an ordinary variable type has no usable
        // open-generic members/constructors, so it must keep reporting
        // GS0113 rather than silently binding to something unusable.
        var source = @"
import System.Collections.Generic

class C {
    func run() {
        let x List = null
    }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0113");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
