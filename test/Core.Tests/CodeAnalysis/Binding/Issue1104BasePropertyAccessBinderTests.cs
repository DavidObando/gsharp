// <copyright file="Issue1104BasePropertyAccessBinderTests.cs" company="GSharp">
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
/// Issue #1104: binder/interpreter tests for base-class property access
/// <c>base.Prop</c> (read) and <c>base.Prop = value</c> (write). Verifies the
/// happy paths bind with no GS0157 ("cannot find type base"), resolve to the
/// nearest base implementation, and run without infinite recursion through the
/// derived override. Also verifies the GS0383 / GS0384 diagnostics still fire
/// on the expected ill-formed inputs, mirroring the base-method-call path.
/// </summary>
public class Issue1104BasePropertyAccessBinderTests
{
    [Fact]
    public void BaseDotProperty_Read_BindsWithoutGS0157_AndRunsBaseImplementation()
    {
        var source = @"
open class Base {
    open prop RenderSize int64 {
        get { return 10L }
    }
}

open class Deriv() : Base {
    override prop RenderSize int64 {
        get { return base.RenderSize + 5L }
    }
}

var d = Deriv()
d.RenderSize
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0157");

        // base.RenderSize == 10 (base impl, no recursion), override adds 5 → 15.
        Assert.Equal(15L, result.Value);
    }

    [Fact]
    public void BaseDotProperty_ReachesGrandparentImplementation()
    {
        var source = @"
open class A {
    open prop Tag int64 {
        get { return 1L }
    }
}

open class B() : A {
}

open class C() : B {
    override prop Tag int64 {
        get { return base.Tag + 40L }
    }
}

var c = C()
c.Tag
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);

        // B does not override Tag, so base.Tag resolves to A::get_Tag == 1.
        Assert.Equal(41L, result.Value);
    }

    [Fact]
    public void BaseDotProperty_Write_BindsWithoutGS0157_AndCallsBaseSetter()
    {
        var source = @"
open class Base {
    var stored int64 = 100L
    open prop Stored int64 {
        get { return stored }
        set { stored = value }
    }
}

open class Deriv() : Base {
    func SetBase(v int64) {
        base.Stored = v
    }
    func ReadBase() int64 {
        return base.Stored
    }
}

var d = Deriv()
d.SetBase(42L)
d.ReadBase()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0157");
        Assert.Equal(42L, result.Value);
    }

    [Fact]
    public void BaseDotProperty_OutsideDerivedInstanceMember_DiagnosticGS0383()
    {
        var source = @"
func standalone() int64 {
    return base.RenderSize
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0383");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0157");
    }

    [Fact]
    public void BaseDotProperty_NoBaseClass_DiagnosticGS0383()
    {
        var source = @"
class Solo() {
    func Read() int64 { return base.RenderSize }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0383");
    }

    [Fact]
    public void BaseDotProperty_MemberNotOnBase_DiagnosticGS0384()
    {
        var source = @"
open class Base {
    open prop RenderSize int64 {
        get { return 10L }
    }
}

open class Deriv() : Base {
    func Read() int64 { return base.NotAProperty }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0384");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
