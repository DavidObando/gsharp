// <copyright file="Issue2044PrivateAccessibilityTests.cs" company="GSharp">
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
/// Issue #2044: a <c>private</c> member read or written from outside its
/// declaring type is now diagnosed (GS0472), mirroring the existing
/// <c>protected</c> enforcement (issue #950 / GS0379). Covers plain field
/// reads/writes, compound assignment (<c>+=</c>), null-coalescing assignment
/// (<c>??=</c>), and <c>private</c> properties — from outside the declaring
/// type (must report) and from inside it, including nested types of the same
/// top-level type (must not report).
/// </summary>
public class Issue2044PrivateAccessibilityTests
{
    [Fact]
    public void ExternalCode_WritesPrivateField_ReportsGS0472()
    {
        var source = @"
class Foo {
    private var Secret int32
}

class Other {
    func Poke(f Foo) int32 {
        f.Secret = 42
        return f.Secret
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_ReadsPrivateField_ReportsGS0472()
    {
        var source = @"
class Foo {
    private var Secret int32
}

class Other {
    func Poke(f Foo) int32 {
        return f.Secret
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_CompoundAssignsPrivateField_ReportsGS0472()
    {
        var source = @"
class Foo {
    private var Secret int32
}

class Other {
    func Poke(f Foo) int32 {
        f.Secret += 1
        return f.Secret
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_NullCoalescingAssignsPrivateField_ReportsGS0472()
    {
        var source = @"
class Foo {
    private var Secret int32?
}

class Other {
    func Poke(f Foo) int32? {
        f.Secret ??= 5
        return f.Secret
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_WritesPrivateProperty_ReportsGS0472()
    {
        var source = @"
class Foo {
    private prop Secret int32 { get; set }
}

class Other {
    func Poke(f Foo) int32 {
        f.Secret = 3
        return f.Secret
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void InternalCode_ReadsAndWritesPrivateFieldFromSameType_NoDiagnostics()
    {
        var source = @"
class Foo {
    private var Secret int32
    func SetIt(v int32) int32 {
        Secret = v
        Secret += 1
        return Secret
    }
}

class Other {
    func Poke(f Foo) int32 {
        return f.SetIt(9)
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void NestedType_AccessesEnclosingTypePrivateField_NoDiagnostics()
    {
        // Issue #2044: `private` is visible throughout the enclosing
        // top-level type's body, including its nested types — mirroring C#'s
        // rule that private members are accessible anywhere within the
        // containing type.
        var source = @"
class Outer {
    private var Secret int32

    class Inner {
        func Poke(o Outer) int32 {
            o.Secret = 7
            return o.Secret
        }
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void DerivedClass_BareNameDoesNotSeeBasePrivateField()
    {
        // Unlike `protected`, `private` is NOT inherited: a base class's
        // private field must not be exposed as a bare name inside a derived
        // type's methods (matching C#: unqualified lookup never finds a
        // base's private members, so the name simply doesn't resolve).
        var source = @"
open class Base {
    private var Secret int32
}

class Derived : Base {
    func Poke() int32 {
        Secret = 5
        return Secret
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0125");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
