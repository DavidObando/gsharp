// <copyright file="Issue2300InterfaceAndTypeParameterNilCompareTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #2300: `x == nil` / `x != nil` reported `GS0129` when
/// `x` was of an interface type or an unconstrained/class-constrained
/// type-parameter type, even though both shapes are managed references at
/// the CLR layer (an interface reference, or an open type parameter whose
/// substitution may be a reference type). C#/Kotlin both allow a reference
/// operand to be compared against `null` unconditionally.
///
/// The fix lives in two places:
/// *
/// (cref:GSharp.Core.CodeAnalysis.Binding.BoundBinaryOperator.IsNullCompare(GSharp.Core.CodeAnalysis.Symbols.TypeSymbol,
/// GSharp.Core.CodeAnalysis.Symbols.TypeSymbol))
/// (private — exercised indirectly here) now accepts a bare
/// `InterfaceSymbol` (including imported CLR interfaces) and a bare
/// `TypeParameterSymbol` whose constraint does not guarantee a
/// non-nullable value type (i.e. everything except a
/// `struct`-constrained type parameter).
/// * The emitter's `TryMatchTypeParameterNilCompare` /
/// `IsOpenTypeParameterOrNullable` (MethodBodyEmitter.Operators.cs)
/// now also matches a BARE open type parameter (not just its `T?`
/// wrapper), so the `box; ldnull; ceq` lowering used for `T? == nil`
/// since issue #831 covers the new bare-`T` shape too.
///
/// A `struct`-constrained type parameter is deliberately excluded: such
/// a `T` can never be nil, and its `T?` spelling erases to
/// `Nullable<T>` rather than a bare reference slot.
open class Issue2300InterfaceAndTypeParameterNilCompareTests {
    @Fact
    func Interface_Vs_Nil_Equality_Binds() {
        const source = `
package P

interface IProfile {
    func Name() string;
}

func Guard(p IProfile) bool {
    return p == nil
}
`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func Interface_Vs_Nil_Inequality_Binds() {
        const source = `
package P

interface IProfile {
    func Name() string;
}

func Guard(p IProfile) bool {
    return p != nil
}
`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func Nil_Vs_Interface_Symmetric_Binds() {
        // The IsNullCompare arm is symmetric — `nil == p` must bind the
        // same as `p == nil`.
        const source = `
package P

interface IProfile {
    func Name() string;
}

func Guard(p IProfile) bool {
    return nil == p
}
`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func ImportedClass_Vs_Nil_Binds() {
        const source = `
package P

import System.Text

func Guard(value StringBuilder) bool {
    return value == nil
}
`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func GenericInterface_Vs_Nil_Equality_Binds() {
        const source = `
package P

interface Iter[T any] {
    func Next() T;
}

func Guard(it Iter[int32]) bool {
    return it == nil
}
`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func UnconstrainedTypeParameter_Vs_Nil_Equality_Binds() {
        // Verbatim shape from the issue body — `TPerson == nil` where
        // TPerson is a free (unconstrained) type parameter.
        const source = `
package P

func Guard[TPerson](value TPerson) bool {
    return value == nil
}
`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func UnconstrainedTypeParameter_Vs_Nil_Inequality_Binds() {
        const source = `
package P

func Guard[TPerson](value TPerson) bool {
    return value != nil
}
`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func Nil_Vs_UnconstrainedTypeParameter_Symmetric_Binds() {
        const source = `
package P

func Guard[T](value T) bool {
    return nil == value
}
`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func ClassConstrainedTypeParameter_Vs_Nil_Equality_Binds() {
        const source = `
package P

func Guard[T class](value T) bool {
    return value == nil
}
`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func InterfaceConstrainedTypeParameter_Vs_Nil_Equality_Binds() {
        const source = `
package P

interface IProfile {
    func Name() string;
}

func Guard[T IProfile](value T) bool {
    return value == nil
}
`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func StructConstrainedTypeParameter_Vs_Nil_StillDiagnoses() {
        // Guard-rail: a `struct`-constrained type parameter can never be
        // nil (its `T?` spelling erases to Nullable<T>), so bare `T == nil`
        // must continue to report GS0129 — the fix must not over-generalize
        // to value-typed type parameters.
        const source = `
package P

func Guard[T struct](value T) bool {
    return value == nil
}
`
        let errors = GetErrors(source)
        Assert.Contains(errors, (e Diagnostic) -> e.Message.Contains("is not defined for types"))
    }

    @Fact
    func Interface_Vs_Nil_RuntimeEquality_FalseForNonNullInstance() {
        // Runtime check: a non-nil interface-typed argument must compare
        // unequal to nil (and equal-inequality must yield `true`).
        const source = `
interface IProfile {
    func Name() string;
}
class Person(N string) : IProfile {
    func Name() string { return N }
}
func IsNil(p IProfile) bool {
    return p == nil
}
func IsNotNil(p IProfile) bool {
    return p != nil
}
let person = Person("Ann")
(IsNil(person), IsNotNil(person))
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal((false, true), result.Value)
    }

    @Fact
    func TypeParameter_Vs_Nil_RuntimeEquality_TrueForDefaultReferenceValue() {
        // Runtime check: `default(T)` for a reference-type instantiation of
        // an unconstrained generic function is the CLR null reference, so
        // the nil-comparison must observe it as equal to nil.
        const source = `
func IsNil[T](value T) bool {
    return value == nil
}
func IsNotNil[T](value T) bool {
    return value != nil
}
(IsNil(default(string)), IsNotNil(default(string)), IsNil("hi"), IsNotNil("hi"))
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal((true, false, false, true), result.Value)
    }

    shared {
        private func GetErrors(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree){IsLibrary = true}
            let parseDiagnostics = tree.Diagnostics
            let bindDiagnostics = compilation.GlobalScope.Diagnostics
            let programDiagnostics = compilation.BoundProgram.Diagnostics
            return parseDiagnostics
                .Concat(bindDiagnostics)
                .Concat(programDiagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .ToImmutableArray()
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
