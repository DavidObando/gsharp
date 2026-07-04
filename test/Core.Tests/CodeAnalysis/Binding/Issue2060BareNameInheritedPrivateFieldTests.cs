// <copyright file="Issue2060BareNameInheritedPrivateFieldTests.cs" company="GSharp">
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
/// Issue #2060 (follow-up to #2044/#2048): a bare (unqualified, no
/// <c>this.</c>/receiver) reference inside a derived class's method body that
/// names an inherited base field resolved via a binder-internal
/// <see cref="Symbols.ImplicitFieldVariableSymbol"/> pseudo-variable that
/// bypassed <c>AccessibilityChecker</c> entirely. A base class's <c>private</c>
/// field was therefore both readable and writable by bare name from a derived
/// type with no diagnostic. <c>BindVariableReference</c> now runs every
/// resolved <see cref="Symbols.ImplicitFieldVariableSymbol"/> through
/// <c>AccessibilityChecker.IsAccessible</c>, reporting GS0472 for both the
/// read and write paths — mirroring the qualified <c>receiver.field</c> checks
/// already in place. Inherited <c>protected</c> fields and a type's own
/// <c>private</c> fields (declared directly in the accessing type) remain
/// reachable by bare name with no diagnostic.
/// </summary>
public class Issue2060BareNameInheritedPrivateFieldTests
{
    [Fact]
    public void DerivedClass_BareNameReadOfInheritedPrivateField_ReportsGS0472()
    {
        var source = @"
open class Base {
    private var Secret int32
}

class Derived : Base {
    func Poke() int32 {
        return Secret
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void DerivedClass_BareNameWriteOfInheritedPrivateField_ReportsGS0472()
    {
        var source = @"
open class Base {
    private var Secret int32
}

class Derived : Base {
    func Poke() int32 {
        Secret = 42
        return 0
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void DerivedClass_BareNameOfInheritedProtectedField_NoDiagnostics()
    {
        // `protected` IS inherited-visible (unlike `private`): a derived
        // type's bare-name read/write of an inherited protected field must
        // keep compiling cleanly.
        var source = @"
open class Base {
    protected var Secret int32
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
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void SameType_BareNameOfOwnPrivateField_NoDiagnostics()
    {
        // A type's own private field, declared directly in the same type as
        // the accessing code (not inherited), must remain legal by bare name.
        var source = @"
class Foo {
    private var Secret int32
    func Poke() int32 {
        Secret = 5
        return Secret
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
