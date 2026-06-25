// <copyright file="Issue1136ObjectMembersBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1136: the inherited <see cref="object"/> instance members
/// (<c>GetType</c>, <c>ToString</c>, <c>GetHashCode</c>, <c>Equals(object)</c>)
/// must be callable on a user <c>class</c>/<c>struct</c> instance that does not
/// declare its own override. Previously a qualified call failed with
/// <c>GS0159</c> and a bare implicit-<c>this</c> call with <c>GS0130</c>. A
/// user-declared override must still resolve to the override.
/// </summary>
public class Issue1136ObjectMembersBinderTests
{
    [Fact]
    public void ImplicitThis_InheritedObjectMembers_Resolve_NoDiagnostics()
    {
        const string source = @"
package p
class C {
    func F() int32 {
        let h = this.GetHashCode()
        let s = this.ToString()
        let t = this.GetType()
        let e = this.Equals(this)
        return h
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void BareImplicitThis_GetType_Resolves_NoGS0130()
    {
        const string source = @"
package p
class C { func F() string { return GetType().Name } }
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0130");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ExplicitReceiver_InheritedObjectMembers_Resolve_NoGS0159()
    {
        const string source = @"
package p
class C { }
class D {
    func F() string {
        let c = C{ }
        let n = c.GetType().Name
        return c.ToString()
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ValueTypeStruct_InheritedObjectMembers_Resolve_NoDiagnostics()
    {
        const string source = @"
package p
struct S {
    var x int32
    func F() int32 {
        let h = this.GetHashCode()
        let s = this.ToString()
        let t = this.GetType()
        return h
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void UserToStringOverride_StillResolves_NoDiagnostics()
    {
        // A user-declared ToString() override must still bind (the inherited
        // fallback only fires when no user method matches).
        const string source = @"
package p
class C {
    func ToString() string { return ""custom"" }
    func F() string { return this.ToString() }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void UnknownMethod_OnUserClass_StillReportsUnableToFind()
    {
        // Regression guard: a genuinely unknown method must still report
        // GS0159 (the Object fallback must not mask real errors).
        const string source = @"
package p
class C {
    func F() int32 {
        return this.NoSuchMethod()
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0159");
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
