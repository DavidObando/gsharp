// <copyright file="Issue1620FunctionTypeCacheNestedTypeParamTests.cs" company="GSharp">
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

/// Issue #1620: the process-wide (cref:FunctionTypeSymbol) cache keyed a
/// composite parameter type (`List[T]`, `[]T`, `T?`, tuples) by
/// its display NAME whenever the type parameter was nested rather than a
/// direct slot. Two distinct generic declarations that both spell their type
/// parameter `T` and both take a function-typed parameter shaped
/// `(List[T]) -> int32` produced the SAME name ("(List<T>) -> int32")
/// and therefore aliased in the cache: whichever declaration bound SECOND
/// reused the FIRST declaration's (cref:TypeParameterSymbol) instance,
/// so substitution / lambda-parameter inference at its call sites silently
/// failed (GS0304 / GS0158). Each test below uses a UNIQUE package name
/// because the cache is not cleared between tests (see
/// (cref:Issue1537GenericNestedInGenericBinderTests)).
open class Issue1620FunctionTypeCacheNestedTypeParamTests {
    @Fact
    func TwoGenericFunctions_SameLetterListOfT_FirstDeclarationOrder_BothBind() {
        AssertBothOrdersBind($package: "Issue1620ListOrderA", declareApplyAFirst: true)
    }

    @Fact
    func TwoGenericFunctions_SameLetterListOfT_SecondDeclarationOrder_BothBind() {
        // Swapping declaration order is the crux of the repro: before the fix
        // whichever of applyA/applyB was declared SECOND lost its own
        // TypeParameterSymbol identity to the cache alias.
        AssertBothOrdersBind($package: "Issue1620ListOrderB", declareApplyAFirst: false)
    }

    @Fact
    func TwoGenericFunctions_SameLetterNestedListOfListOfT_BothBind() {
        let source = `package Issue1620NestedListList
import System.Collections.Generic

func applyA[T](xs List[List[T]], f (List[List[T]]) -> int32) int32 {
    return f(xs)
}
func applyB[T](xs List[List[T]], f (List[List[T]]) -> int32) int32 {
    return f(xs)
}
func Main() {
    var la = List[List[int32]]()
    var ra = applyA(la, (l) -> l.Count)
    var lb = List[List[string]]()
    var rb = applyB(lb, (l) -> l.Count)
}`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func TwoGenericFunctions_SameLetterTupleOfT_BothBind() {
        let source = `package Issue1620TupleT

func applyA[T](x T, f ((T, int32)) -> int32) int32 {
    return f((x, 1))
}
func applyB[T](x T, f ((T, int32)) -> int32) int32 {
    return f((x, 2))
}
func Main() {
    var ra = applyA(1, (t) -> t.Item2)
    var rb = applyB("s", (t) -> t.Item2)
}`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func TwoGenericFunctions_SameLetterNullableT_BothBind() {
        let source = `package Issue1620NullableT

func applyA[T](x T, f (T?) -> int32) int32 {
    return f(x)
}
func applyB[T](x T, f (T?) -> int32) int32 {
    return f(x)
}
func Main() {
    var ra = applyA(1, (x) -> 1)
    var rb = applyB("s", (x) -> 2)
}`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func TwoGenericFunctions_SameLetterArrayOfT_BothBind() {
        let source = `package Issue1620ArrayT

func applyA[T](xs []T, f ([]T) -> int32) int32 {
    return f(xs)
}
func applyB[T](xs []T, f ([]T) -> int32) int32 {
    return f(xs)
}
func Main() {
    var ra = applyA([]int32{1, 2}, (s) -> s.Length)
    var rb = applyB([]string{"a", "b", "c"}, (s) -> s.Length)
}`
        Assert.Empty(GetDiagnostics(source))
    }

    shared {
        private func AssertBothOrdersBind($package string, declareApplyAFirst bool) {
            let applyA = `func applyA[T](xs List[T], f (List[T]) -> int32) int32 {
    return f(xs)
}`
            let applyB = `func applyB[T](xs List[T], f (List[T]) -> int32) int32 {
    return f(xs)
}`
            let first = if declareApplyAFirst {
                applyA
            } else {
                applyB
            }
            let second = if declareApplyAFirst {
                applyB
            } else {
                applyA
            }
            let source = (`package ` + "$$package" + `
import System.Collections.Generic

` + "$first" + `
` + "$second" + `
func Main() {
    var la = List[int32]{1, 2, 3}
    var ra = applyA(la, (l) -> l.Count)
    var lb = List[string]{"a", "b"}
    var rb = applyB(lb, (l) -> l.Count)
}`)
            Assert.Empty(GetDiagnostics(source))
        }

        private func GetDiagnostics(source string) IReadOnlyList[Diagnostic] {
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics
        }
    }
}
