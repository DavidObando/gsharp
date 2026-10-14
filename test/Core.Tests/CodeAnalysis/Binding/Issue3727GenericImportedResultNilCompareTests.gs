// <copyright file="Issue3727GenericImportedResultNilCompareTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #3727: `Volatile.Read(&x) != nil` over a nullable reference
/// reported `GS0129`. The nil-comparison table itself was never consulted:
/// an earlier arm in the binary-operator binder rejects
/// `importedCall == nil` when the imported method's METADATA declares a
/// non-null reference return (so a genuine `string` result is not
/// pointlessly compared against nil), and that check asked
/// `ClrNullability.GetReturnTypeSymbol` about the DECLARED return type.
/// For `T Read<T>(ref T location)` the declared return type is the
/// open type parameter, which carries no nullable annotation — its nullability
/// comes from the type argument at the call site. Inference had already
/// substituted `C?`, so the binder's own result type was nullable while
/// the metadata check said "explicitly non-null", and the comparison the call
/// exists for was rejected. `GS0154` at the enclosing lambda
/// (`() -> ?` against `() -> bool`) was pure cascade.
open class Issue3727GenericImportedResultNilCompareTests {
    @Fact
    func VolatileRead_OverANullableClass_ComparesAgainstNil() {
        const source = `
package P

import System.Threading

class Result {
    var Value int32
}

func Guard() bool {
    var r Result? = nil
    return Volatile.Read(&r) != nil
}
`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func VolatileRead_OverANullableString_ComparesAgainstNil() {
        const source = `
package P

import System.Threading

func Guard() bool {
    var s string? = nil
    return Volatile.Read(&s) == nil
}
`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func VolatileReadNilCompare_BindsInsideALambdaArgument() {
        // The reported shape: `await WaitForAsync(() -> Volatile.Read(&x) !=
        // nil)`. A failed body degraded the lambda to `() -> ?` and cascaded
        // into GS0154 at the `() -> bool` parameter.
        const source = `
package P

import System.Threading

class Result {
    var Value int32
}

func Wait(condition () -> bool) bool {
    return condition()
}

func Guard() bool {
    var r Result? = nil
    return Wait(() -> Volatile.Read(&r) != nil)
}
`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func AnExplicitlyNonNullImportedResult_StillRejectsANilComparison() {
        // The guard the fix narrows is otherwise unchanged: a NON-generic
        // imported member whose metadata declares a non-null reference return
        // is still not comparable against nil.
        const source = `
package P

func Guard() bool {
    return "abc".ToUpperInvariant() != nil
}
`
        Assert.Contains(GetErrors(source), (d Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func VolatileReadNilCompare_EvaluatesTheRealNullState() {
        const source = `
package P

import System.Threading

class Result {
    var Value int32
}

func Read(value Result?) bool {
    var slot = value
    return Volatile.Read(&slot) != nil
}

let empty Result? = nil
(Read(empty), Read(Result()))
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal((false, true), result.Value)
    }

    shared {
        private func GetErrors(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree){IsLibrary = true}
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .ToImmutableArray()
        }
    }
}
