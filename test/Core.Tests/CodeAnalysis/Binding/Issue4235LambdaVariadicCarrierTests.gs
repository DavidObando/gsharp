// <copyright file="Issue4235LambdaVariadicCarrierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #4235: a named delegate's variadic carrier (ADR-0173 / #3627, e.g.
/// `...List[T]`) was resolved correctly for the DELEGATE declaration
/// but not for a LAMBDA assigned to it — `LambdaBinder` still had the
/// pre-ADR-0173 unconditional `...T` -> `[]T` wrap left over from
/// #812, so an explicitly typed `xs ...List[int32]` lambda parameter
/// bound as `[]List[int32]` (a slice OF the carrier) instead of the
/// carrier itself, and assigning the lambda to the delegate failed GS0155
/// ("Cannot convert type 'List[int32]' to '[]List[int32]'"). Fixed by
/// routing both lambda-parameter binding sites (function-literal and arrow
/// lambda) through the same `VariadicCarriers.ResolveDeclaredParameterType`
/// helper that delegate/function declarations already used.
open class Issue4235LambdaVariadicCarrierTests {
    @Fact
    func ArrowLambda_ListCarrier_AssignsToMatchingDelegate() {
        // The issue's standalone repro, made runtime-observable: the
        // assignment itself is the defect (no invocation was needed to
        // reproduce GS0155), but a real call proves the carrier is bound
        // correctly end to end, not just "no longer rejected".
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic

delegate D(a int32, xs ...List[int32]) int32;
let d D = (a int32, xs ...List[int32]) -> a + xs.Count
d(1, 2, 3)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func ArrowLambda_ListCarrier_TargetTypedInference_OmittedParameterTypes() {
        // Every other test in this file writes the lambda parameter types out
        // explicitly (the shape the issue's own repro uses, and the one the
        // defect lived in). This one omits them so the target-typed
        // inference path (p.Type == null in LambdaBinder) is also exercised
        // end to end, confirming it was already correct and stayed so.
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic

delegate D(a int32, xs ...List[int32]) int32;
let d D = (a, xs) -> a + xs.Count
d(1, 2, 3)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func ArrowLambda_ListCarrier_ZeroVariadicArguments() {
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic

delegate D(a int32, xs ...List[int32]) int32;
let d D = (a int32, xs ...List[int32]) -> a + xs.Count
d(10)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(10, result.Value)
    }

    @Fact
    func ArrowLambda_ListCarrier_PassThroughExistingList() {
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic

delegate D(xs ...List[int32]) int32;
let d D = (xs ...List[int32]) -> xs.Count
let existing = List[int32]()
existing.Add(1)
existing.Add(2)
d(existing)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func FunctionLiteral_ListCarrier_AssignsToMatchingDelegate() {
        // Same defect, second binding site: `func(...) {}` function-literal
        // lambdas (LambdaBinder.PrepareFunctionLiteralSignature) had the
        // identical unconditional slice wrap.
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic

delegate D(xs ...List[int32]) int32;
let d D = func(xs ...List[int32]) int32 {
    return xs.Count
}
d(1, 2, 3, 4)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4, result.Value)
    }

    @Fact
    func ArrowLambda_ListCarrier_InferredFunctionType_NoNamedDelegate() {
        // No named delegate: the lambda's own inferred function type must
        // carry the resolved carrier, exercising the indirect-call packing
        // path in OverloadResolver.Arguments for a lambda-typed callee.
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic

let f = (xs ...List[int32]) -> xs.Count
f(1, 2, 3)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func ArrowLambda_ArrayOfListCarrier_StillBindsAsArray() {
        // The real "array of List" shape (`...[]List[T]`) must keep meaning
        // an array whose elements are List[T] — the fix must not collapse
        // this distinct, intentional shape into the List[T] carrier.
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic

delegate D(xs ...[]List[int32]) int32;
let d D = (xs ...[]List[int32]) -> xs.Length
let inner = List[int32]()
inner.Add(9)
d(inner, inner)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func ArrowLambda_NestedListOfListCarrier() {
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic

delegate D(xs ...List[List[int32]]) int32;
let d D = (xs ...List[List[int32]]) -> xs.Count
let inner = List[int32]()
inner.Add(1)
d(inner, inner)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func ArrowLambda_DictionaryElement_KeepsElementInterpretation() {
        // Dictionary[K, V] is not an allowlisted carrier shape (it takes two
        // type arguments; VariadicCarriers only recognizes the
        // single-argument carrier family), so `...Dictionary[K, V]` keeps
        // the ADR-0101 element meaning: an implicit `[]Dictionary[K, V]`
        // carrier of Dictionary elements. Both the delegate and the
        // assigned lambda must agree on that, same as before this fix.
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic

delegate D(xs ...Dictionary[string, int32]) int32;
let d D = (xs ...Dictionary[string, int32]) -> xs.Length
let m = Dictionary[string, int32]()
d(m, m)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func ArrowLambda_IEnumerableCarrier_AssignsToMatchingDelegate() {
        // A second carrier family (interface, not List) proves the fix is
        // not List-specific — it routes through the same
        // VariadicCarriers.IsCarrierType classification as every other shape.
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic

delegate D(xs ...IEnumerable[int32]) int32;
let d D = (xs ...IEnumerable[int32]) -> {
    var t = 0
    for v in xs {
        t = t + v
    }
    return t
}
d(1, 2, 3)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func ArrowLambda_MismatchedCarrier_StillReportsGS0155() {
        // Regression safety: a genuinely mismatched carrier (delegate wants
        // List[int32], lambda declares plain int32 -> implicit []int32) must
        // still be rejected. The fix must not silently widen conversions.
        let diagnostics = Errors(`import System.Collections.Generic

delegate D(a int32, xs ...List[int32]) int32;
let d D = (a int32, xs ...int32) -> a + xs.Length`)
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0155")
    }

    shared {
        private func Errors(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation
                .Emit(peStream)
                .Diagnostics
                .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                .ToList()
        }
    }
}
