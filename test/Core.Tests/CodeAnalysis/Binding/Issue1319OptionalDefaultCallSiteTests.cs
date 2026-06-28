// <copyright file="Issue1319OptionalDefaultCallSiteTests.cs" company="GSharp">
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
/// Issue #1319 (ADR-0063 follow-up): a call to a user-defined <em>instance</em>
/// method or constructor must honor declared parameter defaults when trailing
/// optional arguments are omitted at the call site. Before the fix, only
/// top-level functions, static (<c>shared</c>) methods, and constructors
/// consumed the captured defaults; instance-method calls (both implicit-<c>this</c>
/// and explicit-receiver) wrongly reported GS0144 ("requires N arguments").
/// </summary>
public class Issue1319OptionalDefaultCallSiteTests
{
    [Fact]
    public void InstanceMethod_TrailingOptionalOmitted_ViaReceiver_UsesDefault()
    {
        var source = @"
class C {
    func F(x int32 = 7) int32 { return x }
}

var c = C()
c.F()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void InstanceMethod_TrailingOptionalSupplied_ViaReceiver_UsesArgument()
    {
        var source = @"
class C {
    func F(x int32 = 7) int32 { return x }
}

var c = C()
c.F(5)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void InstanceMethod_ImplicitThis_TrailingOptionalOmitted_UsesDefault()
    {
        var source = @"
class C {
    func F(x int32 = 9) int32 { return x }
    func G() int32 { return F() }
}

var c = C()
c.G()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void InstanceMethod_MultipleTrailingOptionals_OmitOne_UsesDefault()
    {
        var source = @"
class C {
    func F(a int32, b int32 = 1, c int32 = 2) int32 { return a + b + c }
}

var c = C()
c.F(10, 20)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(32, result.Value);
    }

    [Fact]
    public void InstanceMethod_MultipleTrailingOptionals_OmitAll_UsesDefaults()
    {
        var source = @"
class C {
    func F(a int32, b int32 = 1, c int32 = 2) int32 { return a + b + c }
}

var c = C()
c.F(10)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(13, result.Value);
    }

    [Fact]
    public void InstanceMethod_MultipleTrailingOptionals_AllSupplied_UsesArguments()
    {
        var source = @"
class C {
    func F(a int32, b int32 = 1, c int32 = 2) int32 { return a + b + c }
}

var c = C()
c.F(10, 20, 30)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(60, result.Value);
    }

    [Fact]
    public void Constructor_TrailingOptionalOmitted_UsesDefault()
    {
        var source = @"
class C {
    var X int32
    init(x int32 = 100) { X = x }
}

var c = C()
c.X
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(100, result.Value);
    }

    [Fact]
    public void InstanceMethod_TooFewRequiredArguments_StillDiagnosesGS0144()
    {
        // The required (non-optional) leading parameter `a` is still mandatory.
        var source = @"
class C {
    func F(a int32, b int32 = 1) int32 { return a + b }
}

var c = C()
c.F()
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0144");
    }

    [Fact]
    public void InstanceMethod_TooManyArguments_StillDiagnosesGS0144()
    {
        var source = @"
class C {
    func F(a int32, b int32 = 1) int32 { return a + b }
}

var c = C()
c.F(1, 2, 3)
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0144");
    }

    [Fact]
    public void InstanceMethod_OverloadResolution_ExactArityNotPenalized()
    {
        // An exact-arity overload must win over a defaulted-slot candidate so
        // existing passing code is not made ambiguous by the new behavior.
        var source = @"
class C {
    func F(a int32) int32 { return a }
    func F(a int32, b int32 = 100) int32 { return a + b }
}

var c = C()
c.F(5)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void InstanceMethod_StringDefault_TrailingOptionalOmitted_UsesDefault()
    {
        var source = @"
class C {
    func Tag(s string = ""hello"") string { return s }
}

var c = C()
c.Tag()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hello", result.Value);
    }

    private static void AssertHasDiagnosticId(IEnumerable<Diagnostic> diagnostics, string id)
    {
        foreach (var diagnostic in diagnostics)
        {
            if (diagnostic.Id == id)
            {
                return;
            }
        }

        Assert.Fail($"Expected diagnostic '{id}' was not reported.");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
