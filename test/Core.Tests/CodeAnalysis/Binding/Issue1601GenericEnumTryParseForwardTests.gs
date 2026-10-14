// <copyright file="Issue1601GenericEnumTryParseForwardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #1601 (follow-up to #1599): a generic BCL method whose type parameter
/// carries a value-type/`struct` constraint — canonically
/// `Enum.TryParse<TEnum>(string, out TEnum)` — invoked with a caller
/// type argument that is itself an in-scope generic type parameter constrained
/// to `Enum`/`struct` (as opposed to a concrete enum) must resolve and
/// bind, with an inline `out var` local typed as that type parameter.
///
/// Before the fix the type parameter erased to a `System.Object` placeholder
/// that (cref:System.Reflection.GenericParameterAttributes) classified as a
/// reference type, so the value-type placeholder closure was skipped and the
/// candidate was dropped — reported as `GS0159` (Cannot find function
/// TryParse), which cascaded to `GS0125` on the inline `out var` local.
open class Issue1601GenericEnumTryParseForwardTests {
    @Fact
    func GenericForward_InlineOutVar_ResolvesAndBinds_NoGS0159OrGS0125() {
        // Exact repro from the issue: a generic function forwards its own
        // Enum/struct-constrained type parameter to Enum.TryParse[TEnum].
        const source = `
package p
import System

func Parse[TEnum Enum struct](arg string) TEnum? {
    if !Enum.TryParse[TEnum](arg, out var result) {
        return nil
    }
    return result
}

Console.WriteLine("ok")
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9999")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
        Assert.Empty(diagnostics)
    }

    @Fact
    func GenericForward_IgnoreCaseOverload_ResolvesAndBinds() {
        // The three-argument `(string, bool ignoreCase, out TEnum)` overload
        // must also close over the constrained type parameter.
        const source = `
package p
import System

func Parse[TEnum Enum struct](arg string) TEnum? {
    if !Enum.TryParse[TEnum](arg, true, out var result) {
        return nil
    }
    return result
}

Console.WriteLine("ok")
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9999")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
        Assert.Empty(diagnostics)
    }

    @Fact
    func GenericForward_PreDeclaredReceiver_Resolves_NoGS0159() {
        // The pre-declared receiver variant: `out r` where `r` is typed by the
        // value-type-constrained type parameter.
        const source = `
package p
import System

func Parse[TEnum Enum struct](arg string) TEnum {
    var r TEnum
    var ok = Enum.TryParse[TEnum](arg, out r)
    return r
}

Console.WriteLine("ok")
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Empty(diagnostics)
    }

    @Fact
    func ConcreteEnum_InlineOutVar_StillResolves_Issue1599Regression() {
        // Control: the concrete same-compilation enum case fixed by #1599 must
        // keep resolving through the placeholder-recovery path.
        const source = `
package p
import System

enum Color { Red, Green }

var ok = Enum.TryParse[Color]("Red", out var result)
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9999")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Empty(diagnostics)
    }

    @Fact
    func GenericForward_NonEnumStructConstrained_MemoryMarshalCast_Resolves() {
        // Generalization: a DIFFERENT struct-constrained BCL generic method
        // (MemoryMarshal.Cast<TFrom, TTo>, where TFrom : struct, TTo : struct)
        // must also close over a forwarded constrained type parameter — proving
        // the fix is not Enum.TryParse-specific.
        const source = `
package p
import System.Runtime.InteropServices

func Cast[TEnum Enum struct](s Span[TEnum]) Span[uint8] {
    return MemoryMarshal.Cast[TEnum, uint8](s)
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Empty(diagnostics)
    }

    @Fact
    func UnconstrainedTypeParameter_EnumTryParse_StillErrors() {
        // Negative control: an UNCONSTRAINED `[T]` must NOT satisfy
        // Enum.TryParse<TEnum>'s `where TEnum : struct, Enum` constraint. The
        // fix must not over-loosen constraint checking to admit any type
        // parameter, only ones that themselves carry a value-type constraint.
        const source = `
package p
import System

func Parse[T](arg string) T? {
    if !Enum.TryParse[T](arg, out var result) {
        return nil
    }
    return result
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    @Fact
    func UnconstrainedTypeParameter_MemoryMarshalCast_StillErrors() {
        // Negative control for the non-Enum generalization: an unconstrained
        // `[T]` must not satisfy MemoryMarshal.Cast's `where T : struct`.
        const source = `
package p
import System.Runtime.InteropServices

func Cast[T](s Span[T]) Span[uint8] {
    return MemoryMarshal.Cast[T, uint8](s)
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics.ToList()
        }
    }
}
