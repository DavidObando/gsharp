// <copyright file="Issue826NreOnUnresolvedParameterTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
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
/// <para>
/// Issue #3887 sharpened these tests. They previously asserted
/// <c>Assert.NotEmpty(compilation.BoundProgram.Diagnostics)</c>, but that bag
/// is empty for these sources on origin/main too — the real
/// <c>GS0113 Type 'UnknownType' doesn't exist</c> is raised while binding the
/// declaration and never reaches <c>BoundProgram.Diagnostics</c>. What the old
/// assertion was actually observing was the CASCADE: the redundant
/// <c>GS0158 Cannot find member</c> raised by looking a member up on the
/// already-error-typed <c>x</c>. Suppressing that cascade (#3887) emptied the
/// bag and these tests went red — correctly flagging that they were pinned to
/// the wrong signal.
/// </para>
/// <para>
/// They now assert the compiler's real diagnostics and name the ROOT cause by
/// id, which is strictly stronger: it proves the unresolved type is still
/// reported (the program does NOT compile silently) while allowing the
/// redundant per-member cascade to disappear. The original NRE guard is
/// unchanged — every case still forces <c>BoundProgram</c> to be built.
/// The declaration heads were also updated from the ADR-0078-removed
/// <c>type Foo class</c> form, which today contributes an unrelated GS0306.
/// </para>
/// </summary>
public class Issue826NreOnUnresolvedParameterTypeTests
{
    /// <summary>
    /// Binds the source, forcing <c>BoundProgram</c> construction (the #826 NRE
    /// site) and returns the compiler's full diagnostic set.
    /// </summary>
    private static System.Collections.Immutable.ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> BindAndDiagnose(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);

        // Issue #826: merely reaching this property used to throw.
        Assert.NotNull(compilation.BoundProgram);

        using var peStream = new MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }

    [Fact]
    public void MemberAccessOnUnresolvedParameterType_DoesNotThrow()
    {
        var source = @"
class Foo {
    func DoStuff(x UnknownType) {
        let y = x.SomeMember
    }
}
";
        var diagnostics = BindAndDiagnose(source);

        // The unresolved parameter type is reported — and is the only error.
        var only = Assert.Single(diagnostics.Where(d => d.IsError));
        Assert.Equal("GS0113", only.Id);
        Assert.Contains("UnknownType", only.Message);
    }

    [Fact]
    public void ChainedMemberAccessOnUnresolvedParameterType_DoesNotThrow()
    {
        var source = @"
class Foo {
    func DoStuff(x UnknownType) {
        let y = x.A.B
    }
}
";
        var diagnostics = BindAndDiagnose(source);

        var only = Assert.Single(diagnostics.Where(d => d.IsError));
        Assert.Equal("GS0113", only.Id);
    }

    [Fact]
    public void MethodCallOnUnresolvedParameterType_DoesNotThrow()
    {
        var source = @"
class Foo {
    func DoStuff(x UnknownType) {
        let y = x.ToString().Length
    }
}
";
        var diagnostics = BindAndDiagnose(source);

        var only = Assert.Single(diagnostics.Where(d => d.IsError));
        Assert.Equal("GS0113", only.Id);
    }

    [Fact]
    public void FieldWithUnresolvedType_MemberAccess_DoesNotThrow()
    {
        // Simulates the old-syntax field declaration pattern (without var/let)
        // where the field type cannot be resolved.
        var source = @"
class Bar {
    var x UnknownType = nil

    func DoStuff() {
        let y = x.Member
    }
}
";
        var diagnostics = BindAndDiagnose(source);

        Assert.Contains(diagnostics, d => d.IsError && d.Id == "GS0113");
    }
}
