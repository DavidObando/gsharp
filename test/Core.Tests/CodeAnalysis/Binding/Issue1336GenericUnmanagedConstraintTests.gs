// <copyright file="Issue1336GenericUnmanagedConstraintTests.cs" company="GSharp">
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

/// Issue #1336: unsafe generic SIMD code over an `unmanaged`-constrained
/// type parameter `T` must bind. Two capabilities are required:
/// 1. `sizeof(T)` where `T` is a generic type parameter constrained `unmanaged` (previously
/// GS0130/GS0125).
/// 2. `*T` (a pointer to a type parameter) where `T : unmanaged` (previously GS0398).
/// The `unmanaged` constraint is what makes both legal; a plain
/// (unconstrained) type parameter must still be rejected.
open class Issue1336GenericUnmanagedConstraintTests {
    @Fact
    func SizeOfTypeParameter_WithUnmanagedConstraint_NoDiagnostics() {
        const source = `
package p
class C {
    func Size[T unmanaged]() int32 {
        return sizeof(T)
    }
}
`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SizeOfTypeParameter_WithoutUnmanagedConstraint_ReportsGS0415() {
        const source = `
package p
class C {
    func Size[T any]() int32 {
        return sizeof(T)
    }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0415")
    }

    @Fact
    func SizeOfReferenceType_ReportsGS0415() {
        const source = `
package p
class C {
    func Size() int32 {
        return sizeof(string)
    }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0415")
    }

    @Fact
    func SizeOfPrimitive_NoDiagnostics() {
        const source = `
package p
class C {
    func Size() int32 {
        return sizeof(int32)
    }
}
`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func PointerToTypeParameter_WithUnmanagedConstraint_NoGS0398() {
        const source = `
package p
class C {
    unsafe func First[T unmanaged](p *T) T {
        return *p
    }
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0398")
        Assert.Empty(diagnostics)
    }

    @Fact
    func PointerToTypeParameter_WithoutUnmanagedConstraint_ReportsGS0398() {
        const source = `
package p
class C {
    unsafe func First[T any](p *T) T {
        return *p
    }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0398")
    }

    @Fact
    func UnmanagedConstraint_SatisfiedByPrimitive_NoDiagnostics() {
        const source = `
package p
class C {
    func Id[T unmanaged](x T) T { return x }
    func Use() int32 { return Id[int32](5) }
}
`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func UnmanagedConstraint_NotSatisfiedByReferenceType_ReportsGS0152() {
        const source = `
package p
class C {
    func Id[T unmanaged](x T) T { return x }
    func Use() string { return Id[string]("a") }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0152")
    }

    @Fact
    func CombinedInterfaceAndUnmanagedConstraint_PrimitiveOk_ReferenceRejected() {
        const source = `
package p
import System
class C {
    func Cmp[T IComparable[T] unmanaged](a T, b T) int32 {
        return a.CompareTo(b) + sizeof(T)
    }
    func Ok() int32 { return Cmp[int32](1, 2) }
}
`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func CombinedInterfaceAndUnmanagedConstraint_ReferenceType_Rejected() {
        const source = `
package p
import System
class C {
    func Cmp[T IComparable[T] unmanaged](a T, b T) int32 {
        return a.CompareTo(b) + sizeof(T)
    }
    func Bad() int32 { return Cmp[string]("a", "b") }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0152")
    }

    @Fact
    func UnmanagedCombinedWithStruct_ReportsGS0361() {
        // `unmanaged` already implies `struct`; spelling both is a
        // mutually-exclusive/redundant constraint conflict (ADR-0097 GS0361).
        const source = `
package p
class C {
    func F[T unmanaged struct](x T) T { return x }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0361")
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
