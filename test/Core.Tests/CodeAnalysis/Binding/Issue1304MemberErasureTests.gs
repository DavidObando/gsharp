// <copyright file="Issue1304MemberErasureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1304: accessing a property/member on a constructed BCL/generic type
/// instantiated over a same-compilation user type erased the member type to
/// `object` instead of substituting the user element. Canonical case:
/// `IEnumerator[Ch].Current` typed `object` (GS0155) and
/// `e.Current.V` failing member lookup (GS0158) when `Ch` is a
/// user-defined struct whose backing `ClrType` is null during binding.
/// These binder-level tests assert no diagnostics on the substituted member
/// type (so `e.Current` is typed `Ch` and `e.Current.V`
/// resolves) while the primitive-element control keeps working.
open class Issue1304MemberErasureTests {
    @Fact
    func StructElementEnumerator_CurrentTypedAsElement_NoDiagnostics() {
        const source = `
package P
import System.Collections.Generic
struct Ch { prop V int32 { get; init; } }
func F(e IEnumerator[Ch]) Ch { return e.Current }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func StructElementEnumerator_CurrentMemberAccess_Resolves() {
        const source = `
package P
import System.Collections.Generic
struct Ch { prop V int32 { get; init; } }
func G(e IEnumerator[Ch]) int32 { return e.Current.V }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ClassElementEnumerator_CurrentMemberAccess_Resolves() {
        const source = `
package P
import System.Collections.Generic
class Seg { public var X int32 = 0 }
func G(e IEnumerator[Seg]) int32 { return e.Current.X }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func PrimitiveElementEnumerator_CurrentTypedAsElement_StillBinds() {
        // Regression control: the primitive (IEnumerator[int32]) path is
        // unchanged and Current keeps its int32 type.
        const source = `
package P
import System.Collections.Generic
func H(e IEnumerator[int32]) int32 { return e.Current }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func StructElementEnumerator_CurrentWrongConversion_Rejected() {
        // The substituted element type must be Ch (a struct), not object: a
        // member that does not exist on Ch is still rejected.
        const source = `
package P
import System.Collections.Generic
struct Ch { prop V int32 { get; init; } }
func G(e IEnumerator[Ch]) int32 { return e.Current.DoesNotExist }
`
        let diags = GetDiagnostics(source)
        Assert.NotEmpty(diags)
    }

    /// Thin wrapper so the test cases can call `Assert.Empty` against a
    /// (cref:ImmutableArray{T}) without exposing the GSharp diagnostic
    /// surface to xUnit's enumerable inference.
    private struct ImmutableArrayOfDiagnostic : IReadOnlyCollection[Diagnostic] {
        private let diagnostics ImmutableArray[Diagnostic]

        init(diagnostics ImmutableArray[Diagnostic]) {
            this.diagnostics = diagnostics
        }

        prop Count int32 -> this.diagnostics.Length

        func GetEnumerator() IEnumerator[Diagnostic] {
            for diagnostic in this.diagnostics {
                yield diagnostic
            }
        }

        private func (IEnumerable) GetEnumerator() IEnumerator {
            return GetEnumerator()
        }
    }

    shared {
        private func GetDiagnostics(source string) Issue1304MemberErasureTests.ImmutableArrayOfDiagnostic {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let parseDiagnostics = tree.Diagnostics
            let bindDiagnostics = compilation.GlobalScope.Diagnostics
            let programDiagnostics = compilation.BoundProgram.Diagnostics
            let all = parseDiagnostics
                .Concat(bindDiagnostics)
                .Concat(programDiagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .ToImmutableArray()
            return Issue1304MemberErasureTests.ImmutableArrayOfDiagnostic(all)
        }
    }
}
