// <copyright file="Issue1136ObjectMemberBinderTests.cs" company="GSharp">
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
/// Issue #1136: inherited <see cref="object"/> instance members
/// (<c>GetType()</c>, <c>ToString()</c>, <c>GetHashCode()</c>,
/// <c>Equals(object)</c>) must be callable on user <c>class</c>/<c>struct</c>
/// instances even when the user type declares no explicit imported base. The
/// binder's inherited-CLR fallback previously only fired when
/// <c>StructSymbol.ImportedBaseType</c> was set; it now falls back to
/// <c>typeof(object)</c> so the universally-inherited members resolve in
/// <c>this.M()</c>, <c>receiver.M()</c>, and bare implicit-<c>this</c> (<c>M()</c>)
/// positions. The return types are validated through explicit type annotations
/// (<c>System.Type</c>/<c>string</c>/<c>int32</c>/<c>bool</c>): a mismatch would
/// surface a conversion diagnostic. Method bodies are bound (and their
/// diagnostics captured) without being executed, so these tests are pure binder
/// coverage independent of the tree interpreter.
/// </summary>
public class Issue1136ObjectMemberBinderTests
{
    [Fact]
    public void ThisReceiver_ObjectMembers_BindWithCorrectTypes_OnClass()
    {
        var source = @"
import System
class C {
    func F() int32 {
        let h int32 = this.GetHashCode()
        let s string? = this.ToString()
        let t Type = this.GetType()
        let e bool = this.Equals(this)
        return h
    }
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void LocalReceiver_ObjectMembers_BindOnClassInstance()
    {
        var source = @"
import System
class C { }
class D {
    func F() string? {
        let c = C{ }
        let t Type = c.GetType()
        let s string? = c.ToString()
        return s
    }
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void BareImplicitThis_GetType_ResolvesAsThisGetType()
    {
        var source = @"
class C {
    func F() string {
        return GetType().Name
    }
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void StructReceiver_GetHashCode_BindsOnValueType()
    {
        var source = @"
struct S { let X int32 }
class C {
    func F() int32 {
        let s = S{ X: 1 }
        return s.GetHashCode()
    }
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void StructReceiver_ObjectMembers_BindWithCorrectTypes()
    {
        var source = @"
import System
struct S { let X int32 }
class C {
    func F() int32 {
        let a = S{ X: 1 }
        let b = S{ X: 1 }
        let h int32 = a.GetHashCode()
        let s string? = a.ToString()
        let t Type = a.GetType()
        let e bool = a.Equals(b)
        return h
    }
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void UnknownMethod_StillReportsGS0159()
    {
        var source = @"
class C {
    func F() {
        let x = this.NoSuchMethod()
    }
}
";
        var diagnostics = Evaluate(source).Diagnostics;
        Assert.Contains(diagnostics, d => d.Message.Contains("NoSuchMethod"));
    }

    [Fact]
    public void UserToStringOverride_TakesPrecedenceOverInheritedMember()
    {
        // A user-declared `func ToString() string` must win over the inherited
        // System.Object.ToString(); the interpreter executes the user method.
        var source = @"
class C {
    func ToString() string { return ""custom"" }
}
let c = C{ }
c.ToString()
";
        var result = Evaluate(source);
        AssertNoErrors(result);
        Assert.Equal("custom", result.Value);
    }

    [Fact]
    public void ExplicitImportedBase_StillResolvesInheritedMembers()
    {
        // Control: a user class with an explicit imported CLR base must keep
        // resolving members against its actual base (and Object transitively).
        var source = @"
import System
class MyErr : Exception {
    func F() int32 {
        let h int32 = this.GetHashCode()
        let s string = this.ToString()
        return h
    }
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void MethodGroup_InheritedObjectMember_BindsOnClassReceiver()
    {
        // ADR-0112 method-group position: a bare `obj.ToString` (no call) on a
        // user class with no explicit imported base captures the inherited
        // System.Object.ToString as a CLR method group convertible to a delegate.
        var source = @"
class C { }
func Use(f () -> string) string { return f() }
class D {
    func F() string {
        let c = C{ }
        let f () -> string = c.ToString
        return Use(f)
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
