// <copyright file="Issue826NreOnUnresolvedParameterTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #826 — the language server crashed with a NullReferenceException
/// when binding member access on a receiver whose type could not be resolved
/// (e.g. parameter typed with an unknown CLR type). The binder must report
/// diagnostics gracefully instead of throwing.
///
/// Issue #3887 sharpened these tests. They previously asserted
/// `Assert.NotEmpty(compilation.BoundProgram.Diagnostics)`, but that bag
/// is empty for these sources on origin/main too — the real
/// `GS0113 Type 'UnknownType' doesn't exist` is raised while binding the
/// declaration and never reaches `BoundProgram.Diagnostics`. What the old
/// assertion was actually observing was the CASCADE: the redundant
/// `GS0158 Cannot find member` raised by looking a member up on the
/// already-error-typed `x`. Suppressing that cascade (#3887) emptied the
/// bag and these tests went red — correctly flagging that they were pinned to
/// the wrong signal.
///
/// They now assert the compiler's real diagnostics and name the ROOT cause by
/// id, which is strictly stronger: it proves the unresolved type is still
/// reported (the program does NOT compile silently) while allowing the
/// redundant per-member cascade to disappear. The original NRE guard is
/// unchanged — every case still forces `BoundProgram` to be built.
/// The declaration heads were also updated from the ADR-0078-removed
/// `type Foo class` form, which today contributes an unrelated GS0306.
open class Issue826NreOnUnresolvedParameterTypeTests {
    @Fact
    func MemberAccessOnUnresolvedParameterType_DoesNotThrow() {
        let source = `
class Foo {
    func DoStuff(x UnknownType) {
        let y = x.SomeMember
    }
}
`
        let diagnostics = BindAndDiagnose(source)
        // The unresolved parameter type is reported — and is the only error.
        let only = Assert.Single(diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("GS0113", only.Id)
        Assert.Contains("UnknownType", only.Message)
    }

    @Fact
    func ChainedMemberAccessOnUnresolvedParameterType_DoesNotThrow() {
        let source = `
class Foo {
    func DoStuff(x UnknownType) {
        let y = x.A.B
    }
}
`
        let diagnostics = BindAndDiagnose(source)
        let only = Assert.Single(diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("GS0113", only.Id)
    }

    @Fact
    func MethodCallOnUnresolvedParameterType_DoesNotThrow() {
        let source = `
class Foo {
    func DoStuff(x UnknownType) {
        let y = x.ToString().Length
    }
}
`
        let diagnostics = BindAndDiagnose(source)
        let only = Assert.Single(diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("GS0113", only.Id)
    }

    @Fact
    func FieldWithUnresolvedType_MemberAccess_DoesNotThrow() {
        // Simulates the old-syntax field declaration pattern (without var/let)
        // where the field type cannot be resolved.
        let source = `
class Bar {
    var x UnknownType = nil

    func DoStuff() {
        let y = x.Member
    }
}
`
        let diagnostics = BindAndDiagnose(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.IsError && d.Id == "GS0113")
    }

    shared {
        /// Binds the source, forcing `BoundProgram` construction (the #826 NRE
        /// site) and returns the compiler's full diagnostic set.
        private func BindAndDiagnose(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            // Issue #826: merely reaching this property used to throw.
            Assert.NotNull(compilation.BoundProgram)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics
        }
    }
}
