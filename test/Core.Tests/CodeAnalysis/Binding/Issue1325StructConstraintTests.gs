// <copyright file="Issue1325StructConstraintTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #1325: a generic method with a `where T : struct`
/// (non-nullable value type) constraint — such as
/// (cref:System.Runtime.InteropServices.MemoryMarshal)'s
/// `Cast<TFrom, TTo>` and `AsBytes<T>` — must resolve
/// when the supplied type argument is a SAME-COMPILATION user-defined struct.
///
/// Such a user struct carries no reference-context CLR type during binding and
/// is erased to a `System.Object` placeholder in the constraint check's
/// CLR type-argument vector, so the naive `arg.IsValueType` test reported
/// `false` and the candidate was wrongly filtered out, failing
/// the whole call with `GS0159`. The fix threads the recovered symbolic
/// type-argument vector into the constraint check so a user struct/enum is
/// recognized as a non-nullable value type — while a user CLASS and a
/// nullable value type are still correctly rejected.
open class Issue1325StructConstraintTests {
    @Fact
    func UserStruct_SatisfiesStructConstraint_MemoryMarshalCast_NoDiagnostics() {
        const source = `
package p
import System.Runtime.InteropServices

struct E { var a int32 }

class C {
    func DoCast(s Span[E]) Span[uint32] { return MemoryMarshal.Cast[E, uint32](s) }
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Empty(diagnostics)
    }

    @Fact
    func UserStruct_SatisfiesStructConstraint_MemoryMarshalAsBytes_NoDiagnostics() {
        // AsBytes infers T = E from the Span[E] argument (no explicit `[...]`).
        const source = `
package p
import System.Runtime.InteropServices

struct E { var a int32 }

class C {
    func DoBytes(s Span[E]) Span[uint8] { return MemoryMarshal.AsBytes(s) }
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Empty(diagnostics)
    }

    @Fact
    func PrimitiveValueType_StillSatisfiesStructConstraint_NoDiagnostics() {
        // Control: the primitive value-type path must keep resolving unchanged.
        const source = `
package p
import System.Runtime.InteropServices

class C {
    func DoCast(s Span[uint8]) Span[uint32] { return MemoryMarshal.Cast[uint8, uint32](s) }
    func DoBytes(s Span[int32]) Span[uint8] { return MemoryMarshal.AsBytes(s) }
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Empty(diagnostics)
    }

    @Fact
    func UserClass_DoesNotSatisfyStructConstraint_ReportsGS0159() {
        // A user CLASS is a reference type and must NOT satisfy `where T : struct`,
        // so the MemoryMarshal.Cast candidate is correctly filtered out (GS0159).
        const source = `
package p
import System.Runtime.InteropServices

class K { var a int32 }

class C {
    func DoCast(s Span[K]) Span[uint32] { return MemoryMarshal.Cast[K, uint32](s) }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    @Fact
    func NullableValueType_DoesNotSatisfyStructConstraint_ReportsGS0159() {
        // A nullable value type (Nullable<int32>) is a value type but IS nullable,
        // so `where T : struct` (non-nullable value type) must still reject it.
        const source = `
package p
import System.Runtime.InteropServices

class C {
    func DoCast(s Span[int32?]) Span[uint32] { return MemoryMarshal.Cast[int32?, uint32](s) }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let program = Binder.BindProgram(compilation.GlobalScope, compilation.References)
            return tree.Diagnostics.Concat(compilation.GlobalScope.Diagnostics).Concat(program.Diagnostics).ToList()
        }
    }
}
