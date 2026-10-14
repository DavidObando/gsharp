// <copyright file="Issue3464ConstructorInlineOutTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Linq
import Xunit

class Issue3464ConstructorInlineOutTests {
    @Fact
    func ImportedMutex_MixedNamedAndPositionalOutVar_BindsAndRuns() {
        let result = Evaluate(`import System.Threading

let guardName string? = nil
let processGuard = Mutex(initiallyOwned: false, guardName, out var createdNew)
processGuard.Dispose()
createdNew`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func ImportedMutex_ReorderedNamedOutLet_BindsAndRuns() {
        let result = Evaluate(`import System.Threading

let processGuard = Mutex(
    createdNew: out let createdNew,
    name: nil,
    initiallyOwned: false)
processGuard.Dispose()
createdNew`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func ImportedMutex_ExplicitlyTypedOutVar_BindsAndRuns() {
        let result = Evaluate(`import System.Threading

let processGuard = Mutex(false, nil, out var createdNew bool)
processGuard.Dispose()
createdNew`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func ImportedMutex_OutDiscard_BindsAndPreservesResultType() {
        let result = Evaluate(`import System.Threading

let processGuard = Mutex(false, nil, out _)
processGuard.Dispose()
42`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ImportedMutex_InvalidExplicitTypedOut_DeclaresLocal() {
        let result = Evaluate(`import System.Threading

Mutex(out var invalid bool, nil, out _)
invalid`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0236")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125"))
    }

    @Fact
    func ImportedMutex_NamedInvalidExplicitTypedOut_DeclaresLocal() {
        let result = Evaluate(`import System.Threading

Mutex(
    createdNew: out _,
    name: nil,
    initiallyOwned: out var invalid bool)
invalid`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0236")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125"))
    }

    @Fact
    func ImportedMutex_MismatchedExplicitTypedOutReportsConstructorDiagnostic() {
        let result = Evaluate(`import System.Threading

Mutex(false, nil, out var value int64)
value`)
        AssertImportedTypedOutMismatchWithoutCascades(result)
    }

    @Fact
    func ImportedMutex_NamedMismatchedExplicitTypedOutReportsConstructorDiagnostic() {
        let result = Evaluate(`import System.Threading

Mutex(
    createdNew: out var value int64,
    name: nil,
    initiallyOwned: false)
value`)
        AssertImportedTypedOutMismatchWithoutCascades(result)
    }

    @Fact
    func ImportedConstructor_MismatchedTypedOutDeclaresInferredSibling() {
        let result = EvaluateFixture(`import GSharp.Core.Tests.CodeAnalysis.Binding

Issue3464TwoOutConstructor(out var invalid int64, out var sibling)
invalid + sibling`)
        AssertImportedTypedOutMismatchWithoutCascades(result)
    }

    @Fact
    func ImportedConstructor_ErrorArgumentConsumesConstructorFailureOnce() {
        let result = EvaluateFixture(`import GSharp.Core.Tests.CodeAnalysis.Binding

Issue3464FailureConstructor(missing, out var value int32, 1)
value`)
        Assert.Equal(1, result.Diagnostics.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0125"))
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0130"))
    }

    @Fact
    func ImportedConstructor_ConversionFailureConsumesConstructorFailureOnce() {
        let result = EvaluateFixture(`import GSharp.Core.Tests.CodeAnalysis.Binding

Issue3464FailureConstructor(1, out var value int32, "bad")
value`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0154")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125" or "GS0130")
        )
    }

    @Fact
    func NonexistentCallableStillReportsFunctionNotFound() {
        let result = Evaluate("DefinitelyMissingIssue3464Callable(1)")
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0130")
    }

    @Fact
    func ImportedGenericConstructor_InfersOutVarType() {
        let result = EvaluateFixture(`import GSharp.Core.Tests.CodeAnalysis.Binding

let fixture = Issue3464GenericConstructor[int32](out var value)
value + fixture.Value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(84, result.Value)
    }

    @Fact
    func ImportedNestedConstructor_InfersOutVarType() {
        let result = EvaluateFixture(`import GSharp.Core.Tests.CodeAnalysis.Binding

let fixture = Issue3464Outer.Nested(out var value)
value + fixture.Value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(84, result.Value)
    }

    @Fact
    func SourceGenericConstructor_WrongTypeArgumentArity_DeclaresOutLocal() {
        let result = Evaluate(`class WrongArityGenericOutBox[T] {
    init(seed int32, out flag bool) {
        flag = seed > 0
    }
}

WrongArityGenericOutBox[int32, int32](5, out var flag)
flag`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0148")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125"))
    }

    @Fact
    func SourceGenericConstructor_UnknownTypeArgument_DeclaresOutLocal() {
        let result = Evaluate(`class UnknownTypeGenericOutBox[T] {
    init(seed int32, out flag bool) {
        flag = seed > 0
    }
}

UnknownTypeGenericOutBox[MissingIssue3464Type](5, out var flag)
flag`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0113")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125"))
    }

    @Fact
    func SourceGenericConstructor_UnknownExplicitOutTypeReportsOnceAndDeclaresLocal() {
        let result = Evaluate(`class UnknownExplicitGenericOutType[T] {
    init(out value T) {
        value = default(T)
    }
}

UnknownExplicitGenericOutType(out var value NoSuchIssue3464GenericType)
value`)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0113", diagnostic.Id)
    }

    @Fact
    func SourceGenericConstructor_InferenceReportsActualUnresolvedTypeParameter() {
        let result = Evaluate(`class PartialGenericInference[T,U] {
    init(value T) {
    }
}

PartialGenericInference(42)`)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0151", diagnostic.Id)
        Assert.Contains("'U'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func SourceGenericConstructor_InferenceIgnoresInapplicablePartialCandidate() {
        let result = Evaluate(`class ApplicablePartialInference[T,U] {
    init(value T, marker string) {
    }

    init(value int32, marker U) {
    }
}

ApplicablePartialInference(42, true)`)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0151", diagnostic.Id)
        Assert.Contains("'T'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func SourceGenericConstructor_ReversedInferenceIgnoresInapplicablePartialCandidate() {
        let result = Evaluate(`class ReversedApplicablePartialInference[T,U] {
    init(value int32, marker U) {
    }

    init(value T, marker string) {
    }
}

ReversedApplicablePartialInference(42, true)`)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0151", diagnostic.Id)
        Assert.Contains("'T'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func SourceGenericConstructor_NamedInferenceIgnoresInapplicablePartialCandidate() {
        let result = Evaluate(`class NamedApplicablePartialInference[T,U] {
    init(value T, marker string) {
    }

    init(value int32, marker U) {
    }
}

NamedApplicablePartialInference(marker: true, value: 42)`)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0151", diagnostic.Id)
        Assert.Contains("'T'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func SourceGenericConstructor_ExplicitArgumentsBypassPartialInference() {
        let result = Evaluate(`class ExplicitApplicablePartialInference[T,U] {
    init(value T, marker string) {
    }

    init(value int32, marker U) {
    }
}

ExplicitApplicablePartialInference[int32,bool](42, true)
42`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericConstructor_InferenceIgnoresInaccessibleCandidate() {
        let result = Evaluate(`class AccessibilityInferenceChoice[T] {
    init(value T, marker string) {
    }

    private init(value int32, marker T) {
    }
}

AccessibilityInferenceChoice(42, "x")
42`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericConstructor_ReversedInferenceIgnoresInaccessibleCandidate() {
        let result = Evaluate(`class ReversedAccessibilityInferenceChoice[T] {
    private init(value int32, marker T) {
    }

    init(value T, marker string) {
    }
}

ReversedAccessibilityInferenceChoice(42, "x")
42`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericConstructor_NamedInferenceIgnoresInaccessibleCandidate() {
        let result = Evaluate(`class NamedAccessibilityInferenceChoice[T] {
    init(value T, marker string) {
    }

    private init(value int32, marker T) {
    }
}

NamedAccessibilityInferenceChoice(marker: "x", value: 42)
42`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericConstructor_InlineOutInferenceIgnoresInaccessibleCandidate() {
        let result = Evaluate(`class InlineOutAccessibilityInferenceChoice[T] {
    init(out value T, seed T, marker string) {
        value = seed
    }

    private init(out value int32, seed int32, marker T) {
        value = seed
    }
}

InlineOutAccessibilityInferenceChoice(out var value, 42, "x")
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericConstructor_AllInaccessibleReportsAccessibility() {
        let result = Evaluate(`class InaccessibleGenericConstructor[T] {
    private init(value T) {
    }
}

InaccessibleGenericConstructor(42)`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0472")
    }

    @Fact
    func SourceGenericConstructor_InaccessibleOutDoesNotValidateLayout() {
        let result = Evaluate(`class InaccessibleOutLayoutChoice[T] {
    init(value T, marker T) {
    }

    private init(out value T, marker T) {
        value = marker
    }
}

InaccessibleOutLayoutChoice(out var value, 42)
value`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0236")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0125" or "GS0151"))
    }

    @Fact
    func SourceGenericConstructor_ReversedInaccessibleOutDoesNotValidateLayout() {
        let result = Evaluate(`class ReversedInaccessibleOutLayoutChoice[T] {
    private init(out value T, marker T) {
        value = marker
    }

    init(value T, marker T) {
    }
}

ReversedInaccessibleOutLayoutChoice(out var value, 42)
value`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0236")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0125" or "GS0151"))
    }

    @Fact
    func SourceGenericConstructor_NamedInaccessibleOutDoesNotValidateLayout() {
        let result = Evaluate(`class NamedInaccessibleOutLayoutChoice[T] {
    init(value T, marker T) {
    }

    private init(out value T, marker T) {
        value = marker
    }
}

NamedInaccessibleOutLayoutChoice(marker: 42, value: out var value)
value`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0236")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0125" or "GS0151"))
    }

    @Fact
    func SourceGenericConstructor_ProtectedOutDoesNotValidateLayout() {
        let result = Evaluate(`open class ProtectedOutLayoutChoice[T] {
    init(value T, marker T) {
    }

    protected init(out value T, marker T) {
        value = marker
    }
}

ProtectedOutLayoutChoice(out var value, 42)
value`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0236")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0125" or "GS0151"))
    }

    @Fact
    func SourceGenericConstructor_InternalOutRemainsAccessible() {
        let result = Evaluate(`class InternalOutLayoutChoice[T] {
    init(value T, marker T) {
    }

    internal init(out value T, marker T) {
        value = marker
    }
}

InternalOutLayoutChoice(out var value, 42)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericConstructor_AllPrivateOutPreservesAccessibilityDiagnostic() {
        let result = Evaluate(`class AllPrivateOutLayoutChoice[T] {
    private init(out value T, marker T) {
        value = marker
    }
}

AllPrivateOutLayoutChoice(out var value, 42)
value`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0472")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic Diagnostic) -> (diagnostic.Id is "GS0125" or "GS0151" or "GS0236")
        )
    }

    @Fact
    func SourceGenericConstructor_OptionalOmittedReportsActualUnresolvedTypeParameter() {
        let result = Evaluate(`class OptionalPartialInference[T,U] {
    init(value T, marker string = "x") {
    }
}

OptionalPartialInference(42)`)
        AssertUnresolvedTypeParameter(result, "U")
    }

    @Fact
    func SourceGenericConstructor_OptionalSuppliedReportsActualUnresolvedTypeParameter() {
        let result = Evaluate(`class SuppliedOptionalPartialInference[T,U] {
    init(value T, marker string = "x") {
    }
}

SuppliedOptionalPartialInference(42, "y")`)
        AssertUnresolvedTypeParameter(result, "U")
    }

    @Fact
    func SourceGenericConstructor_NamedOptionalReportsActualUnresolvedTypeParameter() {
        let result = Evaluate(`class NamedOptionalPartialInference[T,U] {
    init(value T, marker string = "x") {
    }
}

NamedOptionalPartialInference(value: 42)`)
        AssertUnresolvedTypeParameter(result, "U")
    }

    @Fact
    func SourceGenericConstructor_ZeroVariadicReportsActualUnresolvedTypeParameter() {
        let result = Evaluate(`class ZeroVariadicPartialInference[T,U] {
    init(value T, items ...string) {
    }
}

ZeroVariadicPartialInference(42)`)
        AssertUnresolvedTypeParameter(result, "U")
    }

    @Fact
    func SourceGenericConstructor_MultipleVariadicReportsActualUnresolvedTypeParameter() {
        let result = Evaluate(`class MultipleVariadicPartialInference[T,U] {
    init(value T, items ...string) {
    }
}

MultipleVariadicPartialInference(42, "x", "y")`)
        AssertUnresolvedTypeParameter(result, "U")
    }

    @Fact
    func SourceGenericConstructor_PassThroughVariadicReportsActualUnresolvedTypeParameter() {
        let result = Evaluate(`class PassThroughVariadicPartialInference[T,U] {
    init(value T, items ...string) {
    }
}

let items = []string{"x", "y"}
PassThroughVariadicPartialInference(42, items)`)
        AssertUnresolvedTypeParameter(result, "U")
    }

    @Fact
    func SourceGenericConstructor_UninferableOutDeclarations_DoNotDuplicateLocals() {
        let result = Evaluate(`class UninferableVarGenericOutBox[T] {
    init(out value T) { }
}

class UninferableLetGenericOutBox[T] {
    init(out value T) { }
}

class UninferableDiscardGenericOutBox[T] {
    init(out value T) { }
}

UninferableVarGenericOutBox(out var varValue)
varValue
UninferableLetGenericOutBox(out let letValue)
letValue
UninferableDiscardGenericOutBox(out _)`)
        Assert.Equal(3, result.Diagnostics.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0151"))
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125"))
    }

    @Fact
    func SourceGenericConstructor_PartialInferenceFailure_DeclaresExplicitTypedOutLocal() {
        let result = Evaluate(`class PhantomBox[T, U] {
    init(out value T) {
        value = default(T)
    }
}

PhantomBox(out var made int32)
made`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0151")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125"))
    }

    @Fact
    func SourceGenericConstructor_ConcreteOutVar_BindsAndRuns() {
        let result = Evaluate(`class ConcreteGenericOutBox[T] {
    init(seed T, out value T) {
        value = seed
    }
}

ConcreteGenericOutBox[int32](42, out var value)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericConstructor_LeadingOutVar_InfersFromLaterArgument() {
        let result = Evaluate(`class LeadingOutGenericBox[T] {
    init(out value T, seed T) {
        value = seed
    }
}

LeadingOutGenericBox(out var value, 42)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericConstructor_TrailingOutLet_InfersFromEarlierArgument() {
        let result = Evaluate(`class TrailingOutGenericBox[T] {
    init(seed T, out value T) {
        value = seed
    }
}

TrailingOutGenericBox(42, out let value)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericConstructor_ReorderedNamedOutVar_InfersFromNamedArgument() {
        let result = Evaluate(`class NamedOutGenericBox[T] {
    init(out value T, seed T) {
        value = seed
    }
}

NamedOutGenericBox(seed: 42, value: out var value)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericConstructor_MultipleLeadingOuts_InferEachTypeParameter() {
        let result = Evaluate(`class MultipleOutGenericBox[T, U] {
    init(out first T, out second U, seed T, other U) {
        first = seed
        second = other
    }
}

MultipleOutGenericBox(out var first, out let second, 40, 2)
first + second`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericConstructor_ExplicitTypedOut_IsInferenceEvidence() {
        let result = Evaluate(`class TypedOutGenericBox[T] {
    init(out value T) {
        value = default(T)
    }
}

TypedOutGenericBox(out var value int32)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func SourceGenericVariadicConstructor_LeadingOutVar_InfersFromPackedTail() {
        let result = Evaluate(`class LeadingOutVariadicBox[T] {
    init(out value T, items ...T) {
        value = items[0]
    }
}

LeadingOutVariadicBox(out var value, 42)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericVariadicConstructor_InfersFromMultiplePackedTailArguments() {
        let result = Evaluate(`class MultiTailVariadicBox[T] {
    init(out value T, items ...T) {
        value = items[2]
    }
}

MultiTailVariadicBox(out var value, 40, 41, 42)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericVariadicConstructor_InfersFromPassThroughSlice() {
        let result = Evaluate(`class SliceTailVariadicBox[T] {
    init(out value T, items ...T) {
        value = items[0]
    }
}

let items = []int32{42}
SliceTailVariadicBox(out var value, items)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericVariadicConstructor_TrailingOut_UsesFixedArgumentEvidence() {
        let result = Evaluate(`class TrailingOutVariadicBox[T] {
    init(seed T, out value T, items ...T) {
        value = seed
    }
}

TrailingOutVariadicBox(42, out let value)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericVariadicConstructor_MultipleTypeParameters_InferFixedAndTail() {
        let result = Evaluate(`class MultipleTypeVariadicBox[T, U] {
    init(out value T, marker U, items ...T) {
        value = items[0]
    }
}

MultipleTypeVariadicBox(out var value, "marker", 42)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericVariadicConstructor_ExplicitTypedOut_AllowsZeroTail() {
        let result = Evaluate(`class TypedOutVariadicBox[T] {
    init(out value T, items ...T) {
        value = default(T)
    }
}

TypedOutVariadicBox(out var value int32)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func SourceGenericVariadicConstructor_ZeroTailWithoutEvidence_ReportsInference() {
        let result = Evaluate(`class NoEvidenceVariadicBox[T] {
    init(out value T, items ...T) {
        value = default(T)
    }
}

NoEvidenceVariadicBox(out var value)
value`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0151")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125"))
    }

    @Fact
    func SourceGenericVariadicConstructor_MixedNamedArguments_PreservePrimaryDiagnostic() {
        let result = Evaluate(`class NamedVariadicInferenceBox[T] {
    init(out value T, marker int32, items ...T) {
        value = items[0]
    }
}

NamedVariadicInferenceBox(value: out var value, 0, 42)
value`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0246")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125" or "GS0151")
        )
    }

    @Fact
    func SourceGenericConstructor_InvalidOutPositions_ReportGs0236BeforeInference() {
        let result = Evaluate(`class GenericValuePosition[T] {
    init(value T) { }
}

class GenericTypedValuePosition[T] {
    init(value T) { }
}

class GenericRefPosition[T] {
    init(ref value T) { }
}

class GenericInPosition[T] {
    init(in value T) { }
}

GenericValuePosition(out var value)
value
GenericTypedValuePosition(out var typedValue int32)
typedValue
GenericRefPosition(out let refValue)
refValue
GenericInPosition(out var inValue)
inValue`)
        Assert.Equal(4, result.Diagnostics.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0236"))
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125" or "GS0151")
        )
    }

    @Fact
    func SourceGenericConstructor_NamedInvalidOut_ReportsActualOffender() {
        let result = Evaluate(`class NamedInvalidGenericOut[T] {
    init(seed T, value T) { }
}

NamedInvalidGenericOut(value: out var invalid, seed: 42)
invalid`)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0236", diagnostic.Id)
        Assert.Equal("out var invalid", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func SourceGenericConstructor_OpenOverloads_UseValidOutLayoutForInference() {
        let result = Evaluate(`class GenericOpenOutChoice[T] {
    init(value T, marker int32) { }

    init(out value T, seed T) {
        value = seed
    }
}

GenericOpenOutChoice(out var value, 42)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericConstructor_ValidOutLayouts_RemainAmbiguous() {
        let result = Evaluate(`class AmbiguousGenericOutChoice[T] {
    init(out value T) {
        value = default(T)
    }

    init(out value int32) {
        value = 0
    }
}

AmbiguousGenericOutChoice[int32](out var value)
value`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0266")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0125" or "GS0236"))
    }

    @Fact
    func SourceGenericConstructor_InferenceUsesApplicableOutLayoutCandidate() {
        let result = Evaluate(`class CandidateSpecificGenericChoice[T] {
    init(out value int32, seed string) {
        value = 0
    }

    init(out value T, seed T) {
        value = seed
    }
}

CandidateSpecificGenericChoice(out var value, 42)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericConstructor_NamedInferenceUsesApplicableOutLayoutCandidate() {
        let result = Evaluate(`class NamedCandidateGenericChoice[T] {
    init(out value int32, seed string) {
        value = 0
    }

    init(out value T, seed T) {
        value = seed
    }
}

NamedCandidateGenericChoice(seed: 42, value: out var value)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericConstructor_ExplicitTypedOutFiltersInferredCandidates() {
        let result = Evaluate(`class TypedGenericChoice[T] {
    init(out value int32, seed T) {
        value = 40
    }

    init(out value string, seed T) {
        value = ""
    }
}

TypedGenericChoice(out var value int32, 2)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(40, result.Value)
    }

    @Fact
    func SourceGenericConstructor_ExplicitTypedOutFiltersReversedCandidates() {
        let result = Evaluate(`class ReversedTypedGenericChoice[T] {
    init(out value string, seed T) {
        value = ""
    }

    init(out value int32, seed T) {
        value = 40
    }
}

ReversedTypedGenericChoice(out var value int32, 2)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(40, result.Value)
    }

    @Fact
    func SourceGenericConstructor_NamedExplicitTypedOutFiltersMultipleTypeParameters() {
        let result = Evaluate(`class NamedTypedGenericChoice[T,U] {
    init(out value int32, first T, second U) {
        value = 42
    }

    init(out value string, first T, second U) {
        value = ""
    }
}

NamedTypedGenericChoice(second: "x", value: out var value int32, first: 42)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericConstructor_PositionalExplicitTypedOutFiltersMultipleTypeParameters() {
        let result = Evaluate(`class PositionalTypedGenericChoice[T,U] {
    init(out value int32, first T, second U) {
        value = 42
    }

    init(out value string, first T, second U) {
        value = ""
    }
}

PositionalTypedGenericChoice(out var value int32, 2, "x")
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericConstructor_IncompatibleExplicitTypedOutReportsNoApplicable() {
        let result = Evaluate(`class IncompatibleTypedGenericChoice[T] {
    init(out value int32, seed T) {
        value = 0
    }

    init(out value string, seed T) {
        value = ""
    }
}

IncompatibleTypedGenericChoice(out var value bool, 2)
value`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0267")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125"))
    }

    @Fact
    func SourceConstructor_SplitOutLayoutsReportNoApplicable() {
        let result = Evaluate(`class SplitOutLayoutChoice {
    init(out first int32, second int32) {
        first = second
    }

    init(first int32, out second int32) {
        second = first
    }
}

SplitOutLayoutChoice(out var first, out var second)
first + second`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0267")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125" or "GS0236")
        )
    }

    @Fact
    func SourceConstructor_ReversedSplitOutLayoutsReportNoApplicable() {
        let result = Evaluate(`class ReversedSplitOutLayoutChoice {
    init(first int32, out second int32) {
        second = first
    }

    init(out first int32, second int32) {
        first = second
    }
}

ReversedSplitOutLayoutChoice(out var first, out var second)
first + second`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0267")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125" or "GS0236")
        )
    }

    @Fact
    func SourceConstructor_DuplicateNamedArgumentsWithoutInlineOutDoesNotCrash() {
        let result = Evaluate(`class DuplicateNamedWithoutOut {
    init(first int32, second int32) {
    }
}

DuplicateNamedWithoutOut(first: 1, first: 2)`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0245")
    }

    @Fact
    func SourceConstructor_NoApplicableOverloadWithoutInlineOutDoesNotCrash() {
        let result = Evaluate(`class NoApplicableWithoutOut {
    init(value int32) {
    }

    init(value string) {
    }
}

NoApplicableWithoutOut(true)`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0266" or "GS0267"))
    }

    @Fact
    func SourceConstructor_UnknownExplicitOutTypeReportsOnceAndDeclaresLocal() {
        let result = Evaluate(`class UnknownExplicitOutTypeChoice {
    init(out value int32) {
        value = 0
    }
}

UnknownExplicitOutTypeChoice(out var value NoSuchIssue3464SourceType)
value`)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0113", diagnostic.Id)
    }

    @Fact
    func SourceConstructor_UnknownExplicitOutTypeStopsOverloadSelection() {
        let result = Evaluate(`class UnknownExplicitOutOverloadChoice {
    init(out value int32) {
        value = 0
    }

    init(out value string) {
        value = ""
    }
}

UnknownExplicitOutOverloadChoice(out var value MissingIssue3464OutType)
value`)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0113", diagnostic.Id)
    }

    @Fact
    func ImportedConstructor_UnknownExplicitOutTypeReportsOnceAndDeclaresLocal() {
        let result = Evaluate(`import System.Threading

Mutex(false, nil, out var value NoSuchIssue3464ImportedType)
value`)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0113", diagnostic.Id)
    }

    @Fact
    func SourceClosedGenericConstructor_RanksSubstitutedParameterTypes() {
        let result = Evaluate(`class ClosedGenericChoice[T] {
    init(out value T, seed T) {
        value = seed
    }

    init(out value int32, seed int64) {
        value = 0
    }
}

ClosedGenericChoice[int32](out var value, 42)
value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceGenericConstructor_BadTypeArity_DeclaresExplicitTypedOutLocal() {
        let result = Evaluate(`class ExplicitTypedRecoveryBox[T] {
    init(out value T) {
        value = default(T)
    }
}

ExplicitTypedRecoveryBox[int32, string](out var value int32)
value`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0148")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125"))
    }

    @Fact
    func SourceGenericConstructor_BadTypeArityNamedOut_DeclaresExplicitTypedLocal() {
        let result = Evaluate(`class NamedExplicitTypedRecoveryBox[T] {
    init(out value T) {
        value = default(T)
    }
}

NamedExplicitTypedRecoveryBox[int32, string](value: out var value int32)
value`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0148")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125"))
    }

    @Fact
    func SourceConstructor_ReorderedNamedOutVar_IsVisibleAndAssigned() {
        let result = Evaluate(`class Box {
    var Value int32

    init(prefix int32, out result int32) {
        result = prefix + 2
        Value = result
    }
}

let box = Box(result: out var result, prefix: 40)
result + box.Value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(84, result.Value)
    }

    @Fact
    func SourceConstructor_OutVar_SelectsOutOverRefAndIn() {
        let result = Evaluate(`class RefKindChoice {
    var Tag int32

    init(out value int32) {
        value = 41
        Tag = 1
    }

    init(ref value string) {
        Tag = 2
    }

    init(in value bool) {
        Tag = 3
    }
}

let choice = RefKindChoice(out var value)
value + choice.Tag`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceConstructor_ReorderedAndMixedNamedOutVar_SelectOutOverRefAndIn() {
        let result = Evaluate(`class NamedRefKindChoice {
    var Tag int32

    init(prefix int32, out value int32) {
        value = prefix + 1
        Tag = 1
    }

    init(prefix int32, ref value string) {
        Tag = 2
    }

    init(prefix int32, in value bool) {
        Tag = 3
    }
}

let reordered = NamedRefKindChoice(value: out var first, prefix: 40)
let mixed = NamedRefKindChoice(prefix: 20, out var second)
first + second + reordered.Tag + mixed.Tag`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(64, result.Value)
    }

    @Fact
    func SourceConstructor_OutLetAndDiscard_SelectOutOverRefAndIn() {
        let result = Evaluate(`class LetDiscardRefKindChoice {
    var Tag int32

    init(out value int32) {
        value = 20
        Tag = 1
    }

    init(ref value string) {
        Tag = 2
    }

    init(in value bool) {
        Tag = 3
    }
}

let kept = LetDiscardRefKindChoice(out let value)
let discarded = LetDiscardRefKindChoice(out _)
value + kept.Tag + discarded.Tag`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(22, result.Value)
    }

    @Fact
    func SourceConstructor_ExplicitTypedOut_SelectsMatchingOutOverRef() {
        let result = Evaluate(`class TypedRefKindChoice {
    var Tag int32

    init(out value int32) {
        value = 40
        Tag = 2
    }

    init(out value string) {
        value = ""
        Tag = 3
    }

    init(ref value bool) {
        Tag = 4
    }
}

let choice = TypedRefKindChoice(out var value int32)
value + choice.Tag`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SourceConstructor_OrdinaryRefAndInCallsStillBind() {
        let result = Evaluate(`class RefOnly {
    init(ref value string) {
        value = value + "!"
    }
}

class InOnly {
    var Value bool

    init(in value bool) {
        Value = value
    }
}

var text = "ok"
RefOnly(&text)
let flag = true
let captured = InOnly(in flag)
text.Length + (captured.Value ? 1 : 0)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4, result.Value)
    }

    @Fact
    func ImportedConstructor_OutDeclarationAtValuePosition_ReportsOnlyGs0236() {
        let result = Evaluate(`import System.Threading

Mutex(out var invalid, nil, out _)`)
        Assert.Equal([]string{"GS0236"}, result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Id).Distinct())
    }

    @Fact
    func ImportedConstructor_OutDeclarationAtRefPosition_ReportsGs0236() {
        let result = EvaluateFixture(`import GSharp.Core.Tests.CodeAnalysis.Binding

Issue3464RefConstructor(out var value)`)
        Assert.Equal("GS0236", Assert.Single(result.Diagnostics).Id)
    }

    @Fact
    func ImportedConstructor_OutVarOverloads_RemainAmbiguous() {
        let result = EvaluateFixture(`import GSharp.Core.Tests.CodeAnalysis.Binding

Issue3464AmbiguousConstructor(out var value)`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0160")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0236")
    }

    @Fact
    func ImportedConstructor_ExplicitTypedOutAmbiguity_DoesNotRedeclareLocal() {
        let result = EvaluateFixture(`import GSharp.Core.Tests.CodeAnalysis.Binding

Issue3464AmbiguousTypedConstructor(out var value int32)
value`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0160")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125"))
    }

    @Fact
    func ImportedConstructor_DuplicateNamedOutVar_DeclaresErrorLocal() {
        let result = EvaluateFixture(`import GSharp.Core.Tests.CodeAnalysis.Binding

Issue3464FailureConstructor(value: out var value, value: 1)
value`)
        AssertImportedPrimaryWithoutCascades(result, "GS0245")
    }

    @Fact
    func ImportedConstructor_OutVarAtNonOutPosition_DeclaresErrorLocal() {
        let result = EvaluateFixture(`import GSharp.Core.Tests.CodeAnalysis.Binding

Issue3464FailureConstructor(out var value, 1)
value`)
        AssertImportedPrimaryWithoutCascades(result, "GS0236")
    }

    @Fact
    func ImportedConstructor_ConversionFailure_DeclaresTypedOutLocal() {
        let result = EvaluateFixture(`import GSharp.Core.Tests.CodeAnalysis.Binding

Issue3464FailureConstructor(1, out var value, "bad")
value + 1`)
        AssertImportedPrimaryWithoutCascades(result, "GS0154")
    }

    @Fact
    func ImportedConstructor_MissingRequiredArgument_DeclaresTypedOutLocal() {
        let result = EvaluateFixture(`import GSharp.Core.Tests.CodeAnalysis.Binding

Issue3464FailureConstructor(1, out var value)
value + 1`)
        AssertImportedPrimaryWithoutCascades(result, "GS0267")
    }

    @Fact
    func ImportedConstructor_UnknownNamedArgument_DeclaresTypedOutLocal() {
        let result = EvaluateFixture(`import GSharp.Core.Tests.CodeAnalysis.Binding

Issue3464FailureConstructor(1, value: out var value, missing: 2)
value + 1`)
        AssertImportedPrimaryWithoutCascades(result, "GS0246")
    }

    @Fact
    func ImportedMutex_DuplicateNamedOutVar_DeclaresErrorLocal() {
        let result = Evaluate(`import System.Threading

Mutex(false, createdNew: out var createdNew, createdNew: out _)
createdNew`)
        AssertImportedPrimaryWithoutCascades(result, "GS0245")
    }

    @Fact
    func SourceConstructor_OutDeclarationAtValuePosition_ReportsGs0236() {
        let result = Evaluate(`class ValueCtor {
    init(value int32) {
    }
}

ValueCtor(out var value)`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0236")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0130")
    }

    @Fact
    func SourceConstructor_NoOutOverload_ReportsOnlyGs0236AndDeclaresErrorLocal() {
        let result = Evaluate(`class NoOutChoice {
    init(value int32) {
    }

    init(ref value string) {
    }

    init(in value bool) {
    }
}

NoOutChoice(out var value)
value`)
        Assert.Equal("GS0236", Assert.Single(result.Diagnostics).Id)
    }

    @Fact
    func SourceConstructor_NamedInlineOutMappedToRef_ReportsOnlyGs0236() {
        let result = Evaluate(`class NamedNoOutChoice {
    init(out result int32, ref other string) {
        result = 0
    }
}

NamedNoOutChoice(other: out var value, result: out _)
value`)
        Assert.Equal("GS0236", Assert.Single(result.Diagnostics).Id)
    }

    @Fact
    func SourceConstructor_Gs0236PointsToActualInvalidInlineOutArgument() {
        let result = Evaluate(`class LocatedNoOutChoice {
    init(out result int32, ref other string) {
        result = 0
    }
}

LocatedNoOutChoice(result: out _, other: out var invalid)`)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0236", diagnostic.Id)
        Assert.Equal("out var invalid", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func SourceConstructor_OutVarOverloads_RemainAmbiguous() {
        let result = Evaluate(`class AmbiguousCtor {
    init(out value int32) {
        value = 0
    }

    init(out value string) {
        value = ""
    }

    init(ref value bool) {
    }

    init(in value int64) {
    }
}

AmbiguousCtor(out var value)
value`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0266")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0125" or "GS0236"))
    }

    @Fact
    func SourceConstructor_OutLetAmbiguity_DeclaresErrorLocal() {
        let result = Evaluate(`class AmbiguousLetCtor {
    init(out value int32) {
        value = 0
    }

    init(out value string) {
        value = ""
    }
}

AmbiguousLetCtor(out let value)
value`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0266")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0125")
    }

    @Fact
    func SourceConstructor_OutDiscardAmbiguity_PreservesPrimaryDiagnostic() {
        let result = Evaluate(`class AmbiguousDiscardCtor {
    init(out value int32) {
        value = 0
    }

    init(out value string) {
        value = ""
    }
}

AmbiguousDiscardCtor(out _)`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0266")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0125")
    }

    @Fact
    func SourceConstructor_NoApplicableOutVar_DeclaresErrorLocal() {
        let result = Evaluate(`class NoApplicableOutCtor {
    init(out value int32, first int32, second int32) {
        value = first + second
    }

    init(out value string, first string, second string, third string) {
        value = first + second + third
    }
}

NoApplicableOutCtor(out var value, 1)
value`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0267")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0125")
    }

    @Fact
    func SourceConstructor_TypedFilterFailure_DeclaresSiblingInferredOutLocal() {
        let result = Evaluate(`class TypedSiblingFailureCtor {
    init(out first int32, out second int32) {
        first = 0
        second = 0
    }

    init(out first int32, out second string) {
        first = 0
        second = ""
    }
}

TypedSiblingFailureCtor(out var first, out var second bool)
first`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0267")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125"))
    }

    @Fact
    func SourceConstructor_MissingRequiredAfterOutVar_DeclaresLocal() {
        let result = Evaluate(`class MissingRequiredCtor {
    init(out value int32, other int32) {
        value = other
    }
}

MissingRequiredCtor(out var value)
value + 1`)
        AssertPrimaryWithoutUndefined(result, "GS0144")
    }

    @Fact
    func SourceConstructor_TooManyArgumentsAfterOutLet_DeclaresLocal() {
        let result = Evaluate(`class TooManyCtor {
    init(out value int32) {
        value = 0
    }
}

TooManyCtor(out let value, 1)
value + 1`)
        AssertPrimaryWithoutUndefined(result, "GS0144")
    }

    @Fact
    func SourceConstructor_InvalidNamedOrderAfterTypedOut_DeclaresLocal() {
        let result = Evaluate(`class NamedOrderCtor {
    init(other int32, out value int32) {
        value = other
    }
}

NamedOrderCtor(value: out var value int32, 1)
value + 1`)
        AssertPrimaryWithoutUndefined(result, "GS0244")
    }

    @Fact
    func SourceConstructor_DuplicateNamedArgumentWithOutVar_DeclaresErrorLocal() {
        let result = Evaluate(`class DuplicateNamedCtor {
    init(out value int32, other int32 = 0) {
        value = other
    }
}

DuplicateNamedCtor(value: out var value, value: 1)
value`)
        AssertPrimaryWithoutUndefined(result, "GS0245")
    }

    @Fact
    func SourceConstructor_UnknownNamedArgumentAfterOutVar_DeclaresLocal() {
        let result = Evaluate(`class UnknownNamedCtor {
    init(out value int32, other int32 = 0) {
        value = other
    }
}

UnknownNamedCtor(value: out var value, missing: 1)
value`)
        AssertPrimaryWithoutUndefined(result, "GS0246")
    }

    @Fact
    func SourceConstructor_VariadicMismatchAfterOutDiscard_PreservesPrimaryDiagnostic() {
        let result = Evaluate(`class VariadicMismatchCtor {
    init(out value int32, rest ...int32) {
        value = 0
    }
}

VariadicMismatchCtor(out _, "bad")`)
        AssertPrimaryWithoutUndefined(result, "GS0154")
    }

    @Fact
    func SourceConstructor_ConversionFailureAfterOutVar_DeclaresLocal() {
        let result = Evaluate(`class ConversionFailureCtor {
    init(out value int32, other int32) {
        value = other
    }
}

ConversionFailureCtor(out var value, "bad")
value + 1`)
        AssertPrimaryWithoutUndefined(result, "GS0154")
    }

    shared {
        private func AssertPrimaryWithoutUndefined(result EmittedOracleResult, primaryId string) {
            Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == primaryId)
            Assert.DoesNotContain(
                result.Diagnostics,
                (diagnostic Diagnostic) -> (diagnostic.Id is "GS0125" or "GS0236")
            )
        }

        private func AssertImportedPrimaryWithoutCascades(result EmittedOracleResult, primaryId string) {
            Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == primaryId)
            Assert.DoesNotContain(
                result.Diagnostics,
                (diagnostic Diagnostic) -> (diagnostic.Id is "GS0125" or "GS0159" or "GS0285")
            )
        }

        private func AssertImportedTypedOutMismatchWithoutCascades(result EmittedOracleResult) {
            Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0154")
            Assert.DoesNotContain(
                result.Diagnostics,
                (diagnostic Diagnostic) -> (diagnostic.Id is "GS0102" or "GS0125" or "GS0130")
            )
        }

        private func AssertUnresolvedTypeParameter(result EmittedOracleResult, typeParameter string) {
            let diagnostic = Assert.Single(result.Diagnostics)
            Assert.Equal("GS0151", diagnostic.Id)
            Assert.Contains("'$typeParameter'", diagnostic.Message, StringComparison.Ordinal)
        }

        private func Evaluate(source string) EmittedOracleResult -> EmittedOracle.Evaluate(source)

        private func EvaluateFixture(source string) EmittedOracleResult -> EmittedOracle.Evaluate(
            source,
            []string{typeof(Issue3464GenericConstructor[_]).Assembly.Location}
        )
    }
}

class Issue3464GenericConstructor[T] {
    init(out value T) {
        value = T(object(42))
        Value = value
    }

    prop Value T {
        get;
    }
}

class Issue3464RefConstructor {
    init(ref value int32) { }
}

class Issue3464Outer {
    class Nested {
        init(out value int32) {
            value = 42
            Value = value
        }

        prop Value int32 {
            get;
        }
    }
}

class Issue3464AmbiguousConstructor {
    init(out value int32) {
        value = 0
    }

    init(out value string) {
        value = string.Empty
    }
}

class Issue3464AmbiguousTypedConstructor {
    init(out value int32, tag string? = nil) {
        value = tag?.Length ?? 0
    }

    init(out value int32, tag Uri? = nil) {
        value = if tag == nil {
            0
        } else {
            1
        }
    }
}

class Issue3464FailureConstructor {
    init(prefix int32, out value int32, required int32) {
        value = prefix + required
    }
}

class Issue3464TwoOutConstructor {
    init(out first bool, out second int32) {
        first = true
        second = 42
    }
}
