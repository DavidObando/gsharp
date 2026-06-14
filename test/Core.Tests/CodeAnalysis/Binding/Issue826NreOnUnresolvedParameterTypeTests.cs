// <copyright file="Issue826NreOnUnresolvedParameterTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #826 — the language server crashed with a NullReferenceException
/// when binding member access on a receiver whose type could not be resolved
/// (e.g. parameter typed with an unknown CLR type). The binder must report
/// diagnostics gracefully instead of throwing.
/// </summary>
public class Issue826NreOnUnresolvedParameterTypeTests
{
    [Fact]
    public void MemberAccessOnUnresolvedParameterType_DoesNotThrow()
    {
        var source = @"
type Foo class {
    func DoStuff(x UnknownType) {
        let y = x.SomeMember
    }
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var diagnostics = compilation.BoundProgram.Diagnostics;

        // Must report diagnostics (unresolved type) but not throw.
        Assert.NotEmpty(diagnostics);
    }

    [Fact]
    public void ChainedMemberAccessOnUnresolvedParameterType_DoesNotThrow()
    {
        var source = @"
type Foo class {
    func DoStuff(x UnknownType) {
        let y = x.A.B
    }
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var diagnostics = compilation.BoundProgram.Diagnostics;

        Assert.NotEmpty(diagnostics);
    }

    [Fact]
    public void MethodCallOnUnresolvedParameterType_DoesNotThrow()
    {
        var source = @"
type Foo class {
    func DoStuff(x UnknownType) {
        let y = x.ToString().Length
    }
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var diagnostics = compilation.BoundProgram.Diagnostics;

        Assert.NotEmpty(diagnostics);
    }

    [Fact]
    public void FieldWithUnresolvedType_MemberAccess_DoesNotThrow()
    {
        // Simulates the old-syntax field declaration pattern (without var/let)
        // where the field type cannot be resolved.
        var source = @"
type Bar class {
    var x UnknownType = nil

    func DoStuff() {
        let y = x.Member
    }
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var diagnostics = compilation.BoundProgram.Diagnostics;

        Assert.NotEmpty(diagnostics);
    }
}
