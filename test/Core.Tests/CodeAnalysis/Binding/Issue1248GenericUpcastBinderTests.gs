// <copyright file="Issue1248GenericUpcastBinderTests.cs" company="GSharp">
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
import Xunit

/// Issue #1248: an instance of a generic class must be recognized as implicitly
/// convertible to its (constructed) generic base class when the base type argument
/// is one of the derived class's OWN type parameters
/// (`TransformBase[TIn, TOut] : FilterBase[TIn]`). The implicit reference
/// upcast `Derived[...] -> Base[...]` must be classified by substituting the
/// derived instance's type arguments along the base chain before comparing against
/// the target, instead of comparing the unsubstituted base reference
/// (`FilterBase[TIn]`) against the target (`FilterBase[int32]`) and
/// failing with GS0155. Wrong type arguments and unrelated types must still fail.
open class Issue1248GenericUpcastBinderTests {
    @Fact
    func TwoLevelGenericUpcast_ParameterPassing_NoDiagnostic() {
        let source = `
open class FilterBase[T]() { }
open class TransformBase[TIn, TOut] : FilterBase[TIn] { }
class C {
    func Take(f FilterBase[int32]) { }
    func G() {
        var x = TransformBase[int32, int32]()
        Take(x)
    }
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func TwoLevelGenericUpcast_LocalInitialization_NoDiagnostic() {
        let source = `
open class FilterBase[T]() { }
open class TransformBase[TIn, TOut] : FilterBase[TIn] { }
class C {
    func G() {
        var f FilterBase[int32] = TransformBase[int32, int32]()
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func TwoLevelGenericUpcast_Assignment_NoDiagnostic() {
        let source = `
open class FilterBase[T]() { }
open class TransformBase[TIn, TOut] : FilterBase[TIn] { }
class C {
    func G() {
        var f FilterBase[int32] = FilterBase[int32]()
        f = TransformBase[int32, int32]()
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ConcreteLeafBelowGenericIntermediate_Upcast_NoDiagnostic() {
        let source = `
open class FilterBase[T]() { }
open class TransformBase[TIn, TOut] : FilterBase[TIn] { }
class LosslessFilter : TransformBase[int32, int32] { }
class C {
    func G() {
        var f FilterBase[int32] = LosslessFilter()
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func TypeParameterRenaming_ThreeLevelChain_Upcast_NoDiagnostic() {
        // Renaming the flowing type parameter at every hop must not matter:
        // Leaf[Z] : Mid[Z], Mid[A] : FilterBase[A].
        let source = `
open class FilterBase[T]() { }
open class Mid[A] : FilterBase[A] { }
open class Leaf[Z] : Mid[Z] { }
class C {
    func Take(f FilterBase[int32]) { }
    func G() {
        var x = Leaf[int32]()
        Take(x)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func PartialTypeParameterFlow_OnlyOneParameterReachesBase_NoDiagnostic() {
        // Only TIn flows to FilterBase; TOut is unused by the base. The upcast
        // must still succeed regardless of the TOut argument.
        let source = `
open class FilterBase[T]() { }
open class TransformBase[TIn, TOut] : FilterBase[TIn] { }
class C {
    func Take(f FilterBase[int32]) { }
    func G() {
        var x = TransformBase[int32, string]()
        Take(x)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func WrongTypeArgument_UsesCallArgumentDiagnostic() {
        // Negative: TransformBase[int64, int64] is NOT a FilterBase[int32].
        let source = `
open class FilterBase[T]() { }
open class TransformBase[TIn, TOut] : FilterBase[TIn] { }
class C {
    func Take(f FilterBase[int32]) { }
    func G() {
        var x = TransformBase[int64, int64]()
        Take(x)
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0154")
    }

    @Fact
    func WrongTypeArgument_FlowingParameter_UsesCallArgumentDiagnostic() {
        // Negative: the FLOWING parameter is wrong (string instead of int32),
        // even though the non-flowing TOut happens to be int32.
        let source = `
open class FilterBase[T]() { }
open class TransformBase[TIn, TOut] : FilterBase[TIn] { }
class C {
    func Take(f FilterBase[int32]) { }
    func G() {
        var x = TransformBase[string, int32]()
        Take(x)
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0154")
    }

    @Fact
    func UnrelatedType_UsesCallArgumentDiagnostic() {
        // Negative: an unrelated class is not a FilterBase at all.
        let source = `
open class FilterBase[T]() { }
class Unrelated { }
class C {
    func Take(f FilterBase[int32]) { }
    func G() {
        Take(Unrelated())
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0154")
    }

    @Fact
    func DirectOneLevelGenericUpcast_StillWorks_NoDiagnostic() {
        // Control / regression: a one-level derived class that directly closes the
        // generic base with a concrete argument already worked and must keep working.
        let source = `
open class FilterBase[T]() { }
class LosslessFilter : FilterBase[int32] { }
class C {
    func Take(f FilterBase[int32]) { }
    func G() {
        Take(LosslessFilter())
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
