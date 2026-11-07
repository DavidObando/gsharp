// <copyright file="Issue4445DefaultDeconstructionNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Linq
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp.Syntax
import Xunit
import GSharp.Core.CodeAnalysis

/// Issue #4445: inferred locals initialized from `default(T)` carry
/// Roslyn's maybe-null state into G#, including tuple and nested deconstruction.
open class Issue4445DefaultDeconstructionNullabilityTests {
    @Fact
    func RoslynContracts_DefaultGenericLocalsAreAnnotatedAndMaybeNull() {
        let project = Load()
        let document = Assert.Single(project.Documents)
        let model = document.SemanticModel
        let root = document.SyntaxTree.GetRoot()
        let direct = Local(root, model, "direct")
        let tupleLeaf = Local(root, model, "a")
        let classLeaf = Local(root, model, "left")
        let valueLeaf = Local(root, model, "leftValue")
        let narrowed = Local(root, model, "narrowed")
        let narrowedLeaf = Local(root, model, "narrowedLeft")
        let conditionalLeft = Local(root, model, "conditionalLeft")
        let conditionalRight = Local(root, model, "conditionalRight")
        let switchLeft = Local(root, model, "switchLeft")
        let switchRight = Local(root, model, "switchRight")
        let narrowedAlias = Local(root, model, "narrowedAlias")
        let narrowedWholeAlias = Local(root, model, "narrowedWholeAlias")
        let conditionalNarrowed = Local(root, model, "conditionalNarrowed")
        let switchNarrowed = Local(root, model, "switchNarrowed")
        let coalesceLeft = Local(root, model, "coalesceLeft")
        let coalesceRight = Local(root, model, "coalesceRight")
        let coalescePairNarrowed = Local(root, model, "coalescePairNarrowed")
        let suppressedSyntax = root
            .DescendantNodes()
            .OfType[VariableDeclaratorSyntax]()
            .Single((node VariableDeclaratorSyntax) -> node.Identifier.ValueText == "suppressed")
        let narrowedSyntax = root
            .DescendantNodes()
            .OfType[VariableDeclaratorSyntax]()
            .Single((node VariableDeclaratorSyntax) -> node.Identifier.ValueText == "narrowed")
        Assert.Equal(NullableAnnotation.Annotated, direct.NullableAnnotation)
        Assert.Equal(
            NullableFlowState.MaybeNull,
            model
                .GetTypeInfo(
                root
                    .DescendantNodes()
                    .OfType[VariableDeclaratorSyntax]()
                    .Single((node VariableDeclaratorSyntax) -> node.Identifier.ValueText == "direct")
                    .Initializer!!.Value
            )
                .Nullability
                .FlowState
        )
        Assert.Equal(NullableAnnotation.Annotated, tupleLeaf.NullableAnnotation)
        Assert.Equal(NullableAnnotation.Annotated, classLeaf.NullableAnnotation)
        Assert.Equal(NullableAnnotation.NotAnnotated, valueLeaf.NullableAnnotation)
        Assert.Equal(NullableAnnotation.Annotated, narrowed.NullableAnnotation)
        Assert.Equal(NullableAnnotation.Annotated, narrowedLeaf.NullableAnnotation)
        Assert.Equal(NullableAnnotation.Annotated, conditionalLeft.NullableAnnotation)
        Assert.Equal(NullableAnnotation.Annotated, conditionalRight.NullableAnnotation)
        Assert.Equal(NullableAnnotation.Annotated, switchLeft.NullableAnnotation)
        Assert.Equal(NullableAnnotation.Annotated, switchRight.NullableAnnotation)
        Assert.Equal(NullableAnnotation.Annotated, narrowedAlias.NullableAnnotation)
        Assert.Equal(NullableAnnotation.Annotated, narrowedWholeAlias.NullableAnnotation)
        Assert.Equal(NullableAnnotation.Annotated, conditionalNarrowed.NullableAnnotation)
        Assert.Equal(NullableAnnotation.Annotated, switchNarrowed.NullableAnnotation)
        Assert.Equal(NullableAnnotation.Annotated, coalesceLeft.NullableAnnotation)
        Assert.Equal(NullableAnnotation.Annotated, coalesceRight.NullableAnnotation)
        Assert.Equal(NullableAnnotation.Annotated, coalescePairNarrowed.NullableAnnotation)
        Assert.Equal(
            NullableFlowState.NotNull,
            model.GetTypeInfo(narrowedSyntax.Initializer!!.Value).Nullability.FlowState
        )
        let narrowedTuple = root
            .DescendantNodes()
            .OfType[TupleExpressionSyntax]()
            .Single((tuple TupleExpressionSyntax) -> tuple.ToString() == "(maybe, maybe)")
        Assert.Equal(
            NullableFlowState.NotNull,
            model
                .GetSpeculativeTypeInfo(
                narrowedTuple.Arguments[0].Expression.SpanStart,
                narrowedTuple.Arguments[0].Expression,
                SpeculativeBindingOption.BindAsExpression
            )
                .Nullability
                .FlowState
        )
        Assert.Equal(
            NullableFlowState.NotNull,
            model.GetTypeInfo(suppressedSyntax.Initializer!!.Value).Nullability.FlowState
        )
    }

    @Fact
    func Translation_CarriesMaybeNullStorageThroughEveryLocalShape() {
        let printed = Translate()
        for name in[]string{
            "direct",
            "alias",
            "branch",
            "switched",
            "a",
            "b",
            "c",
            "d",
            "e",
            "f",
            "loop",
            "nestedA",
            "nestedB",
            "nestedC",
            "wholeLeft",
            "wholeRight",
            "wholeNestedA",
            "wholeNestedB",
            "wholeNestedC",
            "castLeft",
            "castRight",
            "aliasLeft",
            "aliasRight",
            "designationAliasLeft",
            "designationAliasRight",
            "mutableAliasLeft",
            "mutableAliasRight",
            "capturedAliasLeft",
            "capturedAliasRight",
            "conditionalAliasLeft",
            "conditionalAliasRight",
            "assignedLeft",
            "assignedRight",
            "conditionallyAssignedLeft",
            "conditionallyAssignedRight",
            "tupleAssignedLeft",
            "tupleAssignedRight",
            "conditionalTupleAssignedLeft",
            "conditionalTupleAssignedRight",
            "duplicateLeft",
            "duplicateRight",
            "conditionalLeft",
            "conditionalRight",
            "switchLeft",
            "switchRight",
            "coalesceLeft",
            "coalesceRight",
            "loopLeft",
            "loopRight",
            "forAliasLeft",
            "forAliasRight",
            "nestedLoopLeft",
            "nestedLoopRight",
            "backedgeLeft",
            "backedgeRight",
            "breakLeft",
            "breakRight",
            "assignmentExpressionLeft",
            "assignmentExpressionRight",
            "operationLeft",
            "operationRight",
            "assignmentAlias",
            "coalesceAssignmentAlias",
            "initializerlessAlias",
            "sharedPathLeft",
            "sharedPathRight",
            "repeatedAlias",
            "conditionalCycle",
            "switchCycle",
            "nestedRead",
            "capturedLambdaLeft",
            "capturedLambdaRight",
            "capturedLocalLeft",
            "capturedLocalRight",
            "postCaptureLambdaLeft",
            "postCaptureLocalLeft",
            "wrappedCaptureLeft",
            "conditionalCaptureLeft",
            "conditionalDelegateLeft",
            "returnedCaptureLeft",
            "aliasedCaptureLeft",
            "retainedFieldLeft",
            "escapedFieldAliasLeft",
            "nestedReceiverLeft",
            "nestedCaptureLeft",
            "nestedCaptureRight",
            "lambdaLeft",
            "lambdaRight",
            "localLeft",
            "localRight",
            "coalesced",
            "left",
            "right"
        } {
            Assert.Matches("\\b(let|var) $name T\\? =", printed)
        }
        Assert.DoesNotMatch("\\b(let|var) (directValue|leftValue|rightValue) int32\\? =", printed)
        Assert.DoesNotContain("suppressed T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("ordinary string? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("ordinaryLeft string? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("ordinaryRight string? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("callText string? =", printed, StringComparison.Ordinal)
        Assert.DoesNotMatch("\\b(let|var) callValues [^=\\r\\n]*\\? =", printed)
        Assert.DoesNotContain("explicitLocal T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("explicitLeft T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("explicitRight T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("narrowed T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("narrowedLeft T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("narrowedRight T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("narrowedAlias T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("narrowedWholeAlias T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("reassignedLeft T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("reassignedRight T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("closureLeft T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("closureRight T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("cycleLeft T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("cycleRight T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("finalReplacementLeft T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("finalReplacementRight T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("deadLeft T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("deadRight T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("deadCaptureLeft T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("reassignedCaptureLeft T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("fieldCaptureLeft T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("exitingLeft T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("exitingRight T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("conditionalNarrowed T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("switchNarrowed T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("coalescePairNarrowed T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("coalesceNarrowed T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("methodLeft T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("methodRight T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("result T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotMatch("\\b(let|var) lambda [^=\\r\\n]*\\? =", printed)
        Assert.Contains("suppressed = default(T)!!", printed, StringComparison.Ordinal)
        Assert.Contains("annotated T? = default(T)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let _ =", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Defaults.Run()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0612"
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(20, result.Value)
    }

    @Fact
    func Translation_TracksTupleElementWrites() {
        const source = `#nullable enable

public static class TupleElementWrite
{
    private static void Fill<T>(ref T? value, T replacement) =>
        value = replacement;

    private static void Keep<T>(ref T value)
    {
    }

    [return: System.Diagnostics.CodeAnalysis.MaybeNull]
    private static T Maybe<T>(T replacement) => replacement;

    private static (T First, T Second) Pair<T>(T replacement) =>
        (replacement, replacement);

    private static int Reset<T>(out (T First, T Second) pair)
    {
        pair = default;
        return 0;
    }

    private static void Replace<T>(out T value, T replacement) =>
        value = replacement;

    private static void ResetAfter<T>(
        out (T First, T Second) pair,
        T ignored,
        T replacement) =>
        pair = (replacement, replacement);

    private static void M<T>(T replacement)
    {
        (T First, T Second) pair = (replacement, replacement);
        pair.First = default;
        var (left, right) = pair;
        Fill(ref left, replacement);

        var loopPair = (First: replacement, Second: replacement);
        var again = true;
        while (again)
        {
            loopPair.First = default;
            again = false;
        }

        var (loopLeft, loopRight) = loopPair;
        Fill(ref loopLeft, replacement);

        var markerPair =
            (First: replacement, Second: replacement);
        for (var iteration = 0; iteration < 2; iteration++)
        {
            markerPair.First = Maybe(replacement);
            var (markerLeft, _) = markerPair;
            Keep(ref markerLeft);
            markerPair.First = default;
        }

        var callPair = Pair(replacement);
        callPair.First = default;
        var (callLeft, callRight) = callPair;
        Fill(ref callLeft, replacement);

        var deconstructionWritePair =
            (First: replacement, Second: replacement);
        var other = replacement;
        (deconstructionWritePair.First, other) =
            (default(T), replacement);
        var (deconstructionWriteLeft, deconstructionWriteRight) =
            deconstructionWritePair;
        Fill(ref deconstructionWriteLeft, replacement);

        var wholeDefault = default((T, T));
        wholeDefault.Item1 = replacement;
        var (_, untouchedDefaultRight) = wholeDefault;
        Fill(ref untouchedDefaultRight, replacement);

        var inPair = (default(T), replacement);
        Observe(in inPair);
        var (inLeft, inRight) = inPair;
        Fill(ref inLeft, replacement);
        Keep(ref inRight);

        var refElementPair = (default(T), replacement);
        ObserveRef(ref refElementPair.Item1);
        var (refElementLeft, refElementRight) = refElementPair;
        Fill(ref refElementLeft, replacement);

        var refPair = (default(T), replacement);
        ObserveRef(ref refPair);
        var (refLeft, refRight) = refPair;
        Fill(ref refLeft, replacement);

        var unknownPair = (First: replacement, Second: replacement);
        Reset(out unknownPair);
        unknownPair.First = default;
        var (unknownLeft, unknownRight) = unknownPair;
        Fill(ref unknownLeft, replacement);

        var combinedPair = (First: replacement, Second: replacement);
        var (_, _, (combinedLeft, combinedRight)) =
            (Reset(out combinedPair),
                combinedPair.First = default(T),
                combinedPair);
        Fill(ref combinedLeft, replacement);
        Keep(ref combinedRight);

        var duplicateWritePair =
            (First: replacement, Second: replacement);
        (duplicateWritePair.First, duplicateWritePair.First) =
            (replacement, default(T));
        var (duplicateWriteLeft, duplicateWriteRight) =
            duplicateWritePair;
        Fill(ref duplicateWriteLeft, replacement);
        Keep(ref duplicateWriteRight);

        T preservedSource = default(T);
        var preservedPair = (preservedSource, replacement);
        preservedPair.Item2 = replacement;
        var (preservedLeft, preservedRight) = preservedPair;
        Fill(ref preservedLeft, replacement);
        Keep(ref preservedRight);

        var mixedWritePair =
            (First: replacement, Second: replacement);
        (mixedWritePair, mixedWritePair.First) =
            (default((T, T)), replacement);
        var (_, mixedWriteRight) = mixedWritePair;
        Fill(ref mixedWriteRight, replacement);

        var mixedJoinPair =
            (First: replacement, Second: replacement);
        if (replacement is null)
        {
            mixedJoinPair = (replacement, replacement);
        }
        else
        {
            mixedJoinPair = (replacement, replacement);
        }
        (mixedJoinPair, mixedJoinPair.First) =
            (default((T, T)), replacement);
        var (_, joinedMixedRight) = mixedJoinPair;
        Fill(ref joinedMixedRight, replacement);

        var outElementPair = (default(T), replacement);
        Replace(out outElementPair.Item1, replacement);
        var (outElementLeft, outElementRight) = outElementPair;

        var orderedOutPair =
            (First: replacement, Second: replacement);
        ResetAfter(
            out orderedOutPair,
            orderedOutPair.First = default(T),
            replacement);
        var (orderedOutLeft, orderedOutRight) = orderedOutPair;
    }

    private static void Observe<T>(in (T, T) pair)
    {
    }

    private static void ObserveRef<T>(ref T value)
    {
    }
}`
        let printed = Translate(source)
        Assert.Matches("\\b(let|var) left T\\? =", printed)
        Assert.Matches("\\b(let|var) loopLeft T\\? =", printed)
        Assert.DoesNotContain("markerLeft T? =", printed, StringComparison.Ordinal)
        Assert.Matches("\\b(let|var) callLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) deconstructionWriteLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) untouchedDefaultRight T\\? =", printed)
        Assert.Matches("\\b(let|var) inLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) refElementLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) refLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) unknownLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) combinedLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) duplicateWriteLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) preservedLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) mixedWriteRight T\\? =", printed)
        Assert.Matches("\\b(let|var) joinedMixedRight T\\? =", printed)
        Assert.DoesNotContain("outElementLeft T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("outElementRight T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("refElementRight T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("refRight T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("orderedOutLeft T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("orderedOutRight T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("right T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("loopRight T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("callRight T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("deconstructionWriteRight T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("preservedRight T? =", printed, StringComparison.Ordinal)
    }

    @Fact
    func Translation_CapturesArgumentWritesBeforeCallback() {
        const source = `#nullable enable

public static class ArgumentCapture
{
    private static void Fill<T>(ref T? value, T replacement) =>
        value = replacement;

    private static void Keep<T>(ref T value)
    {
    }

    private static void M<T>(T replacement)
    {
        var pair = (First: replacement, Second: replacement);
        System.Action<T> callback = ignored =>
        {
            var (left, right) = pair;
            Fill(ref left, replacement);
            Keep(ref right);
        };
        callback(pair.First = default(T));
    }
}`
        let printed = Translate(source)
        Assert.Matches("\\b(let|var) left T\\? =", printed)
        Assert.DoesNotContain("right T? =", printed, StringComparison.Ordinal)
    }

    @Fact
    func Translation_DistinguishesTextuallyEqualJoinStates() {
        const source = `#nullable enable

public static class JoinStates
{
    private static void Fill<T>(ref T? value, T replacement) =>
        value = replacement;

    public static void M<T>(T replacement, bool choose)
    {
        var pair = (replacement, replacement);
        if (choose)
        {
            T same = replacement;
            pair = (same, replacement);
        }
        else
        {
            T? same = default;
            pair = (same, replacement);
        }

        pair.Item2 = replacement;
        var (collisionLeft, _) = pair;
        Fill(ref collisionLeft, replacement);
    }
}`
        let printed = Translate(source)
        Assert.Matches("\\b(let|var) collisionLeft T\\? =", printed)
    }

    @Fact
    func Translation_TracksEscapedLocalFunctionCallbacks() {
        const source = `#nullable enable

public static class LocalFunctionCallbacks
{
    private static System.Action stored = () => { };

    private static void Fill<T>(ref T? value, T replacement) =>
        value = replacement;

    private static void Invoke(System.Action callback) =>
        callback();

    public static void M<T>(T replacement, bool choose)
    {
        var pair = (replacement, replacement);
        void Local()
        {
            var (callbackLeft, _) = pair;
            Fill(ref callbackLeft, replacement);
        }

        pair = (default(T), replacement);
        Invoke(Local);

        var composedPair = (replacement, replacement);
        void Composed()
        {
            var (composedLeft, _) = composedPair;
            Fill(ref composedLeft, replacement);
        }

        composedPair = (default(T), replacement);
        (choose ? (System.Action)Composed : () => { })();

        var storedPair = (replacement, replacement);
        void Stored()
        {
            var (storedLeft, _) = storedPair;
            Fill(ref storedLeft, replacement);
        }

        stored = Stored;
        storedPair = (default(T), replacement);
        stored();
    }
}`
        let printed = Translate(source)
        Assert.Matches("\\b(let|var) callbackLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) composedLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) storedLeft T\\? =", printed)
    }

    @Fact
    func Translation_TracksTupleElementReads() {
        const source = `#nullable enable

public static class TupleElementRead
{
    private static void Fill<T>(ref T? value, T replacement) =>
        value = replacement;

    private static void M<T>(T replacement)
    {
        (T First, T Second) pair = (default(T), replacement);
        var first = pair.First;
        var second = pair.Second;
        Fill(ref first, replacement);
    }
}`
        let printed = Translate(source)
        Assert.Matches("\\b(let|var) first T\\? =", printed)
        Assert.DoesNotContain("second T? =", printed, StringComparison.Ordinal)
    }

    @Fact
    func Translation_LowersParenthesizedForDeconstruction() {
        const source = `public static class ParenthesizedFor
{
    private static void Consume((int, int) value)
    {
    }

    private static void M()
    {
        var left = 0;
        var right = 0;
        for (Consume((left, right) = (1, 2)); left < 1;)
        {
            break;
        }
    }
}`
        let printed = Translate(source)
        Assert.Contains("while", printed, StringComparison.Ordinal)
    }

    @Fact
    func Translation_IgnoresAssignmentsInsideForInitializerLambda() {
        const source = `public static class LambdaFor
{
    private static void Consume(System.Action action)
    {
    }

    private static void M()
    {
        var left = 0;
        var right = 0;
        for (Consume(() => (left, right) = (1, 2)); left < 1; left++)
        {
            continue;
        }
    }
}`
        let printed = Translate(source)
        Assert.Contains("for ", printed, StringComparison.Ordinal)
    }

    @Fact
    func Translation_IgnoresAssignmentsInsideForInitializerQuery() {
        const source = `using System.Linq;

public static class QueryFor
{
    private static void M((int, int)[] values)
    {
        var left = 0;
        var right = 0;
        var query = values.AsEnumerable();
        for (query = from value in values
                     select ((left, right) = value);
            left < 1;
            left++)
        {
            continue;
        }
    }
}`
        let printed = Translate(source)
        Assert.Contains("for ", printed, StringComparison.Ordinal)
    }

    @Fact
    func Translation_IgnoresDeferredQueryAssignmentsInReachingValues() {
        const source = `#nullable enable
using System.Collections.Generic;
using System.Linq;

public static class QueryReaching
{
    private static (T, T) Snapshot<T>(
        IEnumerable<(T, T)> deferred,
        (T, T) current) => current;

    private static void M<T>(T replacement, (T, T)[] values)
    {
        var pair = (replacement, replacement);
        var snapshot = Snapshot(
            from value in values
            select pair = (default(T), default(T)),
            pair);
        var (queryLeft, queryRight) = snapshot;
    }
}`
        let printed = Translate(source)
        Assert.DoesNotContain("queryLeft T? =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("queryRight T? =", printed, StringComparison.Ordinal)
    }

    @Fact
    func Translation_TracksAliasesInInitializerLambdas() {
        const source = `#nullable enable

public static class InitializerLambdas
{
    public static System.Func<string?> Field = () =>
    {
        var pair = ("left", "right");
        pair = (default(string), default(string));
        var (fieldLeft, fieldRight) = pair;
        return fieldLeft ?? fieldRight;
    };

    public static System.Func<string?> Property { get; } = () =>
    {
        var pair = ("left", "right");
        pair = (default(string), default(string));
        var (propertyLeft, propertyRight) = pair;
        return propertyLeft ?? propertyRight;
    };
}`
        let printed = Translate(source)
        Assert.Matches("\\b(let|var) fieldLeft string\\? =", printed)
        Assert.Matches("\\b(let|var) fieldRight string\\? =", printed)
        Assert.Matches("\\b(let|var) propertyLeft string\\? =", printed)
        Assert.Matches("\\b(let|var) propertyRight string\\? =", printed)
    }

    @Fact
    func Translation_TracksAliasesInExpressionBodiedMembers() {
        const source = `#nullable enable

public class ExpressionBodiedMembers<T>
{
    private static void Fill(ref T? value, T replacement) =>
        value = replacement;

    public System.Func<int> Property => () =>
    {
        var pair = (default(T), default(T));
        var (propertyBodyLeft, propertyBodyRight) = pair;
        Fill(ref propertyBodyLeft, default!);
        Fill(ref propertyBodyRight, default!);
        return 1;
    };

    public System.Func<int> this[int index] => () =>
    {
        var pair = (default(T), default(T));
        var (indexerBodyLeft, indexerBodyRight) = pair;
        Fill(ref indexerBodyLeft, default!);
        Fill(ref indexerBodyRight, default!);
        return index;
    };
}`
        let printed = Translate(source)
        Assert.Matches("\\b(let|var) propertyBodyLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) propertyBodyRight T\\? =", printed)
        Assert.Matches("\\b(let|var) indexerBodyLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) indexerBodyRight T\\? =", printed)
    }

    @Fact
    func Translation_TracksAliasesInPrimaryConstructorBaseArguments() {
        const source = `#nullable enable

public class Base
{
    public Base(System.Func<int> action)
    {
    }
}

public class Derived<T>(T replacement)
    : Base(() =>
    {
        var pair = (default(T), default(T));
        var (baseLeft, baseRight) = pair;
        return (baseLeft is null ? 0 : 1)
            + (baseRight is null ? 0 : 1);
    })
{
}`
        let printed = Translate(source)
        Assert.Matches("\\b(let|var) baseLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) baseRight T\\? =", printed)
    }

    @Fact
    func Translation_MutuallyAssignedTupleAliasesTerminate() {
        const source = `#nullable enable

public static class Program
{
    public static string Run(bool choose)
    {
        var first = (default(string), default(string));
        var second = first;
        if (choose)
        {
            first = second;
        }
        else
        {
            second = first;
        }

        var (left, right) = choose ? first : second;
        return left ?? right ?? "";
    }
}`
        let printed = Translate(source)
        Assert.Matches("\\b(let|var) left string\\? =", printed)
        Assert.Matches("\\b(let|var) right string\\? =", printed)
    }

    @Fact
    func Translation_KeepsProjectedNestedTupleDefaultsThroughConditionalAssignment() {
        const source = `#nullable enable

public static class Program
{
    public static T? Run<T>(bool choose, T replacement)
    {
        (T, T) pair = (replacement, replacement);
        T other = replacement;
        (pair, other) = choose
            ? ((default(T), default(T)), replacement)
            : ((replacement, replacement), replacement);
        var (projectedLeft, projectedRight) = pair;
        return projectedLeft ?? projectedRight;
    }
}`
        let printed = Translate(source)
        Assert.Matches("\\b(let|var) projectedLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) projectedRight T\\? =", printed)
    }

    @Fact
    func Translation_TracksEventDelegateStorage() {
        const source = `#nullable enable

public sealed class EventStorage<T>
{
    public event System.Action? Changed;

    private static void Fill(ref T? value, T replacement) =>
        value = replacement;

    private static void Keep(ref T value)
    {
    }

    public void Observed(T replacement)
    {
        var pair = (replacement, replacement);
        System.Action callback = () =>
        {
            var (eventObservedLeft, _) = pair;
            Fill(ref eventObservedLeft, replacement);
        };
        Changed += callback;
        pair = (default(T), replacement);
        Changed?.Invoke();
    }

    public void Removed(T replacement)
    {
        var pair = (replacement, replacement);
        System.Action callback = () =>
        {
            var (eventRemovedLeft, _) = pair;
            Keep(ref eventRemovedLeft);
        };
        Changed += callback;
        Changed -= callback;
        pair = (default(T), replacement);
        Changed?.Invoke();
    }
}`
        let printed = Translate(source)
        Assert.Matches("\\b(let|var) eventObservedLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) eventRemovedLeft T\\? =", printed)
    }

    @Fact
    func Translation_TreatsDelegateValuedPropertiesAsOpaqueStorage() {
        const source = `#nullable enable

public sealed class PropertyStorage<T>
{
    private System.Action? stored;

    private System.Action? Callback
    {
        get => stored;
        set => stored ??= value;
    }

    private static void Fill(ref T? value, T replacement) =>
        value = replacement;

    public void M(T replacement)
    {
        var pair = (replacement, replacement);
        Callback = () =>
        {
            var (propertyStorageLeft, _) = pair;
            Fill(ref propertyStorageLeft, replacement);
        };
        Callback = () => { };
        pair = (default(T), replacement);
        Callback?.Invoke();
    }
}`
        let printed = Translate(source)
        Assert.Matches("\\b(let|var) propertyStorageLeft T\\? =", printed)
    }

    @Fact
    func Translation_MatchesEquivalentConstantIndexerOrigins() {
        const source = `#nullable enable

public static class ConstantIndexer
{
    private static void Keep<T>(ref T value)
    {
    }

    public static void M<T>(T replacement)
    {
        var callbacks = new System.Action[1];
        var pair = (replacement, replacement);
        callbacks[0] = () =>
        {
            var (constantIndexLeft, _) = pair;
            Keep(ref constantIndexLeft);
        };
        var index = 0;
        callbacks[index] = () => { };
        pair = (default(T), replacement);
        callbacks[0]();
    }
}`
        let printed = Translate(source)
        Assert.DoesNotMatch("\\b(let|var) constantIndexLeft T\\? =", printed)
    }

    @Fact
    func Translation_TopLevelAliasKeepsDefaultProvenance() {
        const source = `#nullable enable
var pair = (default(string), default(string));
var (left, right) = pair;
pair = ("left", "right");
System.Console.WriteLine(left ?? right);`
        let printed = Translate(source, OutputKind.ConsoleApplication)
        Assert.Matches("\\b(let|var) left string\\? =", printed)
        Assert.Matches("\\b(let|var) right string\\? =", printed)
    }

    @Fact
    func Translation_DoesNotUseStaleAliasInitializerAfterReassignment() {
        const source = `#nullable enable

public static class StaleAlias
{
    [return: System.Diagnostics.CodeAnalysis.MaybeNull]
    private static T Maybe<T>() => default;

    private static void M<T>()
    {
        T source = default(T)!;
        source = Maybe<T>();
        var alias = source;
    }
}`
        let printed = Translate(source)
        Assert.DoesNotContain("alias T? =", printed, StringComparison.Ordinal)
    }

    @Fact
    func Translation_RemovedDelegateDoesNotSeedCapturedDefault() {
        const source = `#nullable enable

public static class RemovedDelegate
{
    private static void Keep<T>(ref T value)
    {
    }

    private static void M<T>(T replacement)
    {
        var pair = (replacement, replacement);
        System.Action first = () =>
        {
            var (removedCaptureLeft, _) = pair;
            Keep(ref removedCaptureLeft);
        };
        System.Action? callback = first;
        callback -= first;
        pair = (default(T), replacement);
        callback?.Invoke();
    }
}`
        let project = Load(source)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Single(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("delegate multicast", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("removedCaptureLeft T? =", printed, StringComparison.Ordinal)
    }

    @Fact
    func Translation_DuplicateFieldDelegateSurvivesOneRemoval() {
        const source = `#nullable enable

public sealed class DuplicateFieldDelegate<T>
{
    private System.Action callback = () => { };

    private static void Fill(ref T? value, T replacement) =>
        value = replacement;

    public void M(T replacement)
    {
        var pair = (replacement, replacement);
        System.Action first = () =>
        {
            var (duplicateFieldLeft, _) = pair;
            Fill(ref duplicateFieldLeft, replacement);
        };
        this.callback = first;
        this.callback += first;
        this.callback += first;
        this.callback -= first + first;
        pair = (default(T), replacement);
        this.callback();
    }
}`
        let project = Load(source)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.True(
            context.Diagnostics.Count(
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                    diagnostic.Message!!.Contains("delegate multicast", StringComparison.Ordinal)
            ) >= 3
        )
        Assert.Matches("\\b(let|var) duplicateFieldLeft T\\? =", printed)
    }

    @Fact
    func Translation_TracksGenericAndAliasedLocalFunctionInvocations() {
        const source = `#nullable enable

public static class LocalFunctionInvocations
{
    private static void Fill<T>(ref T? value, T replacement) =>
        value = replacement;

    public static int M<T>(T replacement)
    {
        var genericPair = (replacement, replacement);
        int Generic<TIgnored>()
        {
            var (genericLeft, _) = genericPair;
            Fill(ref genericLeft, replacement);
            return 1;
        }

        genericPair = (default(T), replacement);
        var result = Generic<int>();

        var aliasedPair = (replacement, replacement);
        int Aliased()
        {
            var (aliasedLeft, _) = aliasedPair;
            Fill(ref aliasedLeft, replacement);
            return 1;
        }

        System.Func<int> first = Aliased;
        System.Func<int> alias = first;
        aliasedPair = (default(T), replacement);
        return result + alias();
    }
}`
        let printed = Translate(source)
        Assert.Matches("\\b(let|var) genericLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) aliasedLeft T\\? =", printed)
    }

    @Fact
    func Translation_TracksRefAliasesAndIndexedDelegateStorage() {
        const source = `#nullable enable

public static class ReachingStorage
{
    private static System.Action[] fieldReceiver =
        new System.Action[2];
    private static int fieldIndex;

    private static void Fill<T>(ref T? value, T replacement) =>
        value = replacement;

    private static void Keep<T>(ref T value)
    {
    }

    private static System.Action[] GetCallbacks() =>
        new System.Action[1];

    private static void InvokeAlias(System.Action callback)
    {
        var alias = callback;
        alias();
    }

    private static void InvokeNestedAlias(System.Action callback)
    {
        var alias = callback;
        void Run() => alias();
        Run();
    }

    private static void ParameterStorage<T>(
        T replacement,
        System.Action[] receiver,
        int index)
    {
        var pair = (replacement, replacement);
        System.Action callback = () =>
        {
            var (parameterStorageLeft, _) = pair;
            Keep(ref parameterStorageLeft);
        };
        receiver[index] = callback;
        receiver = new System.Action[2];
        index = 1;
        pair = (default(T), replacement);
        receiver[index]();
    }

    private static void BranchParameterStorage<T>(
        T replacement,
        System.Action[] receiver,
        int index,
        bool flag)
    {
        var pair = (replacement, replacement);
        System.Action callback = () =>
        {
            var (branchParameterLeft, _) = pair;
            Keep(ref branchParameterLeft);
        };
        receiver[index] = callback;
        if (flag)
        {
            receiver = new System.Action[2];
        }
        else
        {
            receiver = new System.Action[2];
        }
        pair = (default(T), replacement);
        receiver[index]();
    }

    private static void FieldStorage<T>(T replacement)
    {
        var pair = (replacement, replacement);
        System.Action callback = () =>
        {
            var (fieldStorageLeft, _) = pair;
            Keep(ref fieldStorageLeft);
        };
        fieldReceiver[fieldIndex] = callback;
        fieldReceiver = new System.Action[2];
        fieldIndex = 1;
        pair = (default(T), replacement);
        fieldReceiver[fieldIndex]();
    }

    private static void BranchFieldStorage<T>(
        T replacement,
        bool flag)
    {
        fieldReceiver = new System.Action[1];
        fieldIndex = 0;
        var pair = (replacement, replacement);
        System.Action callback = () =>
        {
            var (branchFieldLeft, _) = pair;
            Keep(ref branchFieldLeft);
        };
        fieldReceiver[fieldIndex] = callback;
        if (flag)
        {
            fieldReceiver = new System.Action[1];
        }
        else
        {
            fieldReceiver = new System.Action[1];
        }
        pair = (default(T), replacement);
        fieldReceiver[fieldIndex]();
    }

    private static void CompoundFieldStorage<T>(T replacement)
    {
        fieldReceiver = new System.Action[1];
        fieldIndex = 0;
        var pair = (replacement, replacement);
        System.Action callback = () =>
        {
            var (compoundFieldLeft, _) = pair;
            Fill(ref compoundFieldLeft, replacement);
        };
        fieldReceiver[fieldIndex] = callback;
        fieldIndex += 0;
        pair = (default(T), replacement);
        fieldReceiver[fieldIndex]();
    }

    public static void M<T>(T replacement, bool flag)
    {
        var directTupleMember = default((T, T)).Item1;
        Fill(ref directTupleMember, replacement);
        var castTupleMember =
            (((T, T))default((T, T))).Item1;
        Fill(ref castTupleMember, replacement);

        var refDeclarationPair = (default(T), replacement);
        ref var refDeclarationAlias = ref refDeclarationPair;
        var (refDeclarationLeft, _) = refDeclarationPair;
        Fill(ref refDeclarationLeft, replacement);

        var aliasInvocationPair = (replacement, replacement);
        System.Action aliasInvocation = () =>
        {
            var (aliasInvocationLeft, _) = aliasInvocationPair;
            Keep(ref aliasInvocationLeft);
        };
        InvokeAlias(aliasInvocation);
        aliasInvocationPair = (default(T), replacement);

        var nestedAliasPair = (replacement, replacement);
        System.Action nestedAliasInvocation = () =>
        {
            var (nestedAliasInvocationLeft, _) = nestedAliasPair;
            Fill(ref nestedAliasInvocationLeft, replacement);
        };
        nestedAliasPair = (default(T), replacement);
        InvokeNestedAlias(nestedAliasInvocation);

        var firstRefPair = (replacement, replacement);
        var secondRefPair = (replacement, replacement);
        ref var refAlias = ref firstRefPair;
        refAlias = ref secondRefPair;
        refAlias = (default(T), replacement);
        var (firstRefAliasLeft, _) = firstRefPair;
        var (secondRefAliasLeft, _) = secondRefPair;
        Keep(ref firstRefAliasLeft);
        Fill(ref secondRefAliasLeft, replacement);

        var indexedPair = (replacement, replacement);
        System.Action indexed = () =>
        {
            var (indexedLeft, _) = indexedPair;
            Fill(ref indexedLeft, replacement);
        };
        var callbacks = new System.Action[2];
        var stableIndex = 0;
        callbacks[stableIndex] = indexed;
        callbacks[1] = () => { };
        var callbackAlias = callbacks;
        indexedPair = (default(T), replacement);
        callbackAlias[stableIndex]();

        var shiftedPair = (replacement, replacement);
        System.Action shifted = () =>
        {
            var (shiftedLeft, _) = shiftedPair;
            Keep(ref shiftedLeft);
        };
        var shiftedCallbacks = new System.Action[2];
        var index = 0;
        shiftedCallbacks[index] = shifted;
        index = 1;
        shiftedPair = (default(T), replacement);
        shiftedCallbacks[index]();

        var movedReceiverPair = (replacement, replacement);
        System.Action movedReceiver = () =>
        {
            var (movedReceiverLeft, _) = movedReceiverPair;
            Keep(ref movedReceiverLeft);
        };
        var firstCallbacks = new System.Action[1];
        var secondCallbacks = new System.Action[1];
        var receiver = firstCallbacks;
        receiver[0] = movedReceiver;
        receiver = secondCallbacks;
        movedReceiverPair = (default(T), replacement);
        receiver[0]();

        var ambiguousPair = (replacement, replacement);
        System.Action ambiguous = () =>
        {
            var (ambiguousLeft, _) = ambiguousPair;
            Fill(ref ambiguousLeft, replacement);
        };
        System.Action[] ambiguousReceiver;
        if (flag)
        {
            ambiguousReceiver = new System.Action[1];
        }
        else
        {
            ambiguousReceiver = new System.Action[1];
        }
        ambiguousReceiver[0] = ambiguous;
        ambiguousPair = (default(T), replacement);
        ambiguousReceiver[0]();

        var conditionalPair = (replacement, replacement);
        System.Action conditional = () =>
        {
            var (conditionalLeft, _) = conditionalPair;
            Fill(ref conditionalLeft, replacement);
        };
        var conditionalReceiver = new System.Action[1];
        conditionalReceiver[0] = conditional;
        if (flag)
        {
            conditionalReceiver = new System.Action[1];
        }
        conditionalPair = (default(T), replacement);
        conditionalReceiver[0]();

        var correlatedPair = (replacement, replacement);
        System.Action correlated = () =>
        {
            var (correlatedLeft, _) = correlatedPair;
            Keep(ref correlatedLeft);
        };
        System.Action[] correlatedReceiver;
        int correlatedIndex;
        if (flag)
        {
            correlatedReceiver = new System.Action[2];
            correlatedIndex = 0;
        }
        else
        {
            correlatedReceiver = new System.Action[2];
            correlatedIndex = 1;
        }
        correlatedReceiver[correlatedIndex] = correlated;
        if (flag)
        {
            correlatedReceiver = new System.Action[2];
            correlatedIndex = 1;
        }
        else
        {
            correlatedReceiver = new System.Action[2];
            correlatedIndex = 0;
        }
        correlatedPair = (default(T), replacement);
        correlatedReceiver[correlatedIndex]();

        var freshPair = (replacement, replacement);
        System.Action fresh = () =>
        {
            var (freshLeft, _) = freshPair;
            Keep(ref freshLeft);
        };
        GetCallbacks()[0] = fresh;
        freshPair = (default(T), replacement);
        GetCallbacks()[0]();

        ParameterStorage(
            replacement,
            new System.Action[2],
            0);
        BranchParameterStorage(
            replacement,
            new System.Action[2],
            0,
            flag);
        FieldStorage(replacement);
        BranchFieldStorage(replacement, flag);
        CompoundFieldStorage(replacement);
    }
}`
        let printed = Translate(source)
        Assert.Matches("\\b(let|var) directTupleMember T\\? =", printed)
        Assert.Matches("\\b(let|var) castTupleMember T\\? =", printed)
        Assert.Matches("\\b(let|var) refDeclarationLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) aliasInvocationLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) nestedAliasInvocationLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) firstRefAliasLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) secondRefAliasLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) indexedLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) shiftedLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) movedReceiverLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) ambiguousLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) conditionalLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) correlatedLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) freshLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) parameterStorageLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) branchParameterLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) fieldStorageLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) branchFieldLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) compoundFieldLeft T\\? =", printed)
    }

    @Fact
    func Translation_DoesNotEscapeIncomingOutDelegate() {
        const source = `#nullable enable

public static class OutDelegate
{
    private static void Keep<T>(ref T value)
    {
    }

    private static void Fill<T>(ref T? value, T replacement) =>
        value = replacement;

    private static void Overwrite(out System.Action callback) =>
        callback = () => { };

    private static void Observe(System.Action callback)
    {
    }

    private static void ObserveHash(System.Action callback) =>
        _ = callback.GetHashCode();

    private static void ObserveAliasHash(System.Action callback)
    {
        var alias = callback;
        _ = alias.GetHashCode();
    }

    private static void InvokeFirst(System.Action callback) =>
        callback.GetInvocationList()[0].DynamicInvoke();

    public static void M<T>(T replacement)
    {
        var pair = (replacement, replacement);
        System.Action callback = () =>
        {
            var (deadLeft, _) = pair;
            Keep(ref deadLeft);
        };
        Overwrite(out callback);
        pair = (default(T), replacement);
        callback();

        var observedPair = (replacement, replacement);
        System.Action observed = () =>
        {
            var (observedLeft, _) = observedPair;
            Keep(ref observedLeft);
        };
        Observe(observed);
        observedPair = (default(T), replacement);

        var hashPair = (replacement, replacement);
        System.Action hash = () =>
        {
            var (hashLeft, _) = hashPair;
            Keep(ref hashLeft);
        };
        ObserveHash(hash);
        hashPair = (default(T), replacement);

        var aliasHashPair = (replacement, replacement);
        System.Action aliasHash = () =>
        {
            var (aliasHashLeft, _) = aliasHashPair;
            Keep(ref aliasHashLeft);
        };
        ObserveAliasHash(aliasHash);
        aliasHashPair = (default(T), replacement);

        var invocationListPair = (default(T), replacement);
        System.Action invocationList = () =>
        {
            var (invocationListLeft, _) = invocationListPair;
            Fill(ref invocationListLeft, replacement);
        };
        InvokeFirst(invocationList);
    }
}`
        let printed = Translate(source)
        Assert.DoesNotMatch("\\b(let|var) deadLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) observedLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) hashLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) aliasHashLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) invocationListLeft T\\? =", printed)
    }

    @Fact
    func Translation_TreatsVirtualDelegateCalleeAsEscape() {
        const source = `#nullable enable

public class VirtualDelegateCallee<T>
{
    private static void Fill(ref T? value, T replacement) =>
        value = replacement;

    protected virtual void Observe(System.Action callback)
    {
    }

    public void M(T replacement)
    {
        var pair = (replacement, replacement);
        System.Action callback = () =>
        {
            var (virtualLeft, _) = pair;
            Fill(ref virtualLeft, replacement);
        };
        Observe(callback);
        pair = (default(T), replacement);
    }
}`
        let printed = Translate(source)
        Assert.Matches("\\b(let|var) virtualLeft T\\? =", printed)
    }

    @Fact
    func Translation_TracksWrappedReturnedAndRecursiveCallbacks() {
        const source = `#nullable enable

public static class CallbackShapes
{
    private static void Fill<T>(ref T? value, T replacement) =>
        value = replacement;

    private static void Keep<T>(ref T value)
    {
    }

    private static void InvokeNested(System.Action callback)
    {
        void Run() => callback();
        Run();
    }

    public static void M<T>(T replacement, bool choose)
    {
        var wrappedPair = (replacement, replacement);
        System.Action wrapped = () =>
        {
            var (wrappedLeft, _) = wrappedPair;
            Fill(ref wrappedLeft, replacement);
        };
        wrappedPair = (default(T), replacement);
        ((System.Action)wrapped)();

        var nestedPair = (replacement, replacement);
        System.Action nested = () =>
        {
            var (nestedHelperLeft, _) = nestedPair;
            Fill(ref nestedHelperLeft, replacement);
        };
        nestedPair = (default(T), replacement);
        InvokeNested(nested);

        var hashPair = (replacement, replacement);
        System.Action hash = () =>
        {
            var (hashLeft, _) = hashPair;
            Keep(ref hashLeft);
        };
        hashPair = (default(T), replacement);
        _ = hash.GetHashCode();

        var returnedPair = (replacement, replacement);
        void Returned()
        {
            var (returnedLeft, _) = returnedPair;
            Fill(ref returnedLeft, replacement);
        }

        System.Action Make() => Returned;
        System.Action escaped = Make();
        returnedPair = (default(T), replacement);
        escaped();

        var recursivePair = (replacement, replacement);
        void Recursive(bool recurse)
        {
            if (recurse)
            {
                recursivePair = (default(T), replacement);
                Recursive(false);
                return;
            }

            var (recursiveLeft, _) = recursivePair;
            Fill(ref recursiveLeft, replacement);
        }

        Recursive(choose);
    }
}`
        let printed = Translate(source)
        Assert.Matches("\\b(let|var) wrappedLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) nestedHelperLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) hashLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) returnedLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) recursiveLeft T\\? =", printed)
    }

    @Fact
    func LocalFunctionDelegateStorage_TracksFieldOverwriteAndEventUnsubscribeBeforeDefaultWrite() {
        let source = `#nullable enable

public sealed class Probe<T>
{
    private System.Action? callback;
    private event System.Action? Happened;

    private static void Keep(ref T value) { }
    private static void Fill(ref T? value, T replacement) => value = replacement;

    public void CheckFieldOverwrite(T replacement)
    {
        var overwrittenPair = (replacement, replacement);
        void OverwrittenLocal()
        {
            var (overwrittenFieldLeft, _) = overwrittenPair;
            Keep(ref overwrittenFieldLeft);
        }

        this.callback = OverwrittenLocal;
        this.callback = null;
        overwrittenPair = (default(T), replacement);
        this.callback?.Invoke();

        var retainedPair = (replacement, replacement);
        void RetainedLocal()
        {
            var (retainedFieldLeft, _) = retainedPair;
            Fill(ref retainedFieldLeft, replacement);
        }

        this.callback = RetainedLocal;
        retainedPair = (default(T), replacement);
        this.callback?.Invoke();
    }

    public void CheckEventUnsubscribe(T replacement)
    {
        var unsubscribedPair = (replacement, replacement);
        void UnsubscribedLocal()
        {
            var (unsubscribedEventLeft, _) = unsubscribedPair;
            Keep(ref unsubscribedEventLeft);
        }

        this.Happened += UnsubscribedLocal;
        this.Happened -= UnsubscribedLocal;
        unsubscribedPair = (default(T), replacement);
        this.Happened?.Invoke();

        var twiceSubscribedPair = (replacement, replacement);
        void TwiceSubscribedLocal()
        {
            var (twiceSubscribedEventLeft, _) = twiceSubscribedPair;
            Fill(ref twiceSubscribedEventLeft, replacement);
        }

        this.Happened += TwiceSubscribedLocal;
        this.Happened += TwiceSubscribedLocal;
        this.Happened -= TwiceSubscribedLocal;
        twiceSubscribedPair = (default(T), replacement);
        this.Happened?.Invoke();
    }

    private System.Action? secondCallback;
    private event System.Action? secondHappened;
    private event System.Action? CustomHappened
    {
        add { this.callback = value; }
        remove { }
    }
    private System.Action? GetSaved() => this.secondCallback;
    private static void Other() { }

    public void CheckCyclicAliasedAndConditionalStorage(T replacement, bool choose)
    {
        var cyclicPair = (replacement, replacement);
        void CyclicLocal()
        {
            var (cyclicFieldLeft, _) = cyclicPair;
            Fill(ref cyclicFieldLeft, replacement);
        }

        this.callback = CyclicLocal;
        this.secondCallback = this.callback;
        this.callback = this.secondCallback;
        cyclicPair = (default(T), replacement);
        this.callback?.Invoke();

        var copiedMulticastPair = (replacement, replacement);
        void CopiedMulticastLocal()
        {
            var (copiedMulticastLeft, _) = copiedMulticastPair;
            Fill(ref copiedMulticastLeft, replacement);
        }

        this.Happened = CopiedMulticastLocal;
        this.Happened += CopiedMulticastLocal;
        this.secondHappened = this.Happened;
        this.callback = null;
        this.Happened = null;
        this.secondHappened -= CopiedMulticastLocal;
        copiedMulticastPair = (default(T), replacement);
        this.secondHappened?.Invoke();

        var conditionalUnsubscribePair = (replacement, replacement);
        void ConditionalUnsubscribeLocal()
        {
            var (conditionalUnsubscribeLeft, _) = conditionalUnsubscribePair;
            Fill(ref conditionalUnsubscribeLeft, replacement);
        }

        this.Happened += ConditionalUnsubscribeLocal;
        this.Happened -= choose ? ConditionalUnsubscribeLocal : Other;
        conditionalUnsubscribePair = (default(T), replacement);
        this.Happened?.Invoke();

        var customEventPair = (replacement, replacement);
        void CustomEventLocal()
        {
            var (customEventLeft, _) = customEventPair;
            Fill(ref customEventLeft, replacement);
        }

        this.CustomHappened += CustomEventLocal;
        this.CustomHappened -= CustomEventLocal;
        customEventPair = (default(T), replacement);
        this.callback?.Invoke();

        var combinedRemovePair = (replacement, replacement);
        void CombinedRemoveLocal()
        {
            var (combinedRemoveLeft, _) = combinedRemovePair;
            Fill(ref combinedRemoveLeft, replacement);
        }

        this.Happened = null;
        this.Happened += CombinedRemoveLocal;
        this.Happened -= (System.Action)CombinedRemoveLocal + Other;
        combinedRemovePair = (default(T), replacement);
        this.Happened?.Invoke();

        var genericMismatchPair = (replacement, replacement);
        void GenericMismatchLocal<U>()
        {
            var (genericMismatchLeft, _) = genericMismatchPair;
            Fill(ref genericMismatchLeft, replacement);
        }

        this.Happened = null;
        this.Happened += GenericMismatchLocal<int>;
        this.Happened -= GenericMismatchLocal<string>;
        genericMismatchPair = (default(T), replacement);
        this.Happened?.Invoke();

        var genericMatchedPair = (replacement, replacement);
        void GenericMatchedLocal<U>()
        {
            var (genericMatchedLeft, _) = genericMatchedPair;
            Keep(ref genericMatchedLeft);
        }

        this.Happened = null;
        this.Happened += GenericMatchedLocal<int>;
        this.Happened -= GenericMatchedLocal<int>;
        genericMatchedPair = (default(T), replacement);
        this.Happened?.Invoke();

        var savedHelperPair = (replacement, replacement);
        void SavedHelperLocal()
        {
            var (savedHelperLeft, _) = savedHelperPair;
            Fill(ref savedHelperLeft, replacement);
        }

        this.callback = SavedHelperLocal;
        this.secondCallback = this.callback;
        this.callback = this.GetSaved();
        this.secondCallback = null;
        savedHelperPair = (default(T), replacement);
        this.callback?.Invoke();

        var twoHolderA = new Probe<T>();
        var twoHolderB = new Probe<T>();
        var twoHolderPair = (replacement, replacement);
        void TwoHolderLocal()
        {
            var (twoHolderLeft, _) = twoHolderPair;
            Fill(ref twoHolderLeft, replacement);
        }

        twoHolderA.callback = TwoHolderLocal;
        twoHolderB.callback = twoHolderA.callback;
        twoHolderA.callback = twoHolderB.callback;
        twoHolderB.callback = null;
        twoHolderPair = (default(T), replacement);
        twoHolderA.callback?.Invoke();

        var paramHelperA = new Probe<T>();
        var paramHelperB = new Probe<T>();
        var paramHelperPair = (replacement, replacement);
        void ParameterHelperLocal()
        {
            var (parameterHelperLeft, _) = paramHelperPair;
            Fill(ref parameterHelperLeft, replacement);
        }

        paramHelperA.callback = ParameterHelperLocal;
        paramHelperB.callback = GetFromHolder(paramHelperA);
        paramHelperA.callback = null;
        paramHelperPair = (default(T), replacement);
        paramHelperB.callback?.Invoke();

        var instanceHelperHolder = new Probe<T>();
        var instanceHelperPair = (replacement, replacement);
        void InstanceHelperLocal()
        {
            var (instanceHelperLeft, _) = instanceHelperPair;
            Fill(ref instanceHelperLeft, replacement);
        }

        instanceHelperHolder.secondCallback = InstanceHelperLocal;
        this.callback = instanceHelperHolder.GetSaved();
        instanceHelperHolder.secondCallback = null;
        instanceHelperPair = (default(T), replacement);
        this.callback?.Invoke();

        var coalesceFieldPair = (replacement, replacement);
        void CoalesceFieldLocal()
        {
            var (coalesceFieldLeft, _) = coalesceFieldPair;
            Fill(ref coalesceFieldLeft, replacement);
        }

        this.callback = CoalesceFieldLocal;
        this.callback ??= Other;
        coalesceFieldPair = (default(T), replacement);
        this.callback?.Invoke();

        var coalesceLocalPair = (replacement, replacement);
        void CoalesceLocalStorageLocal()
        {
            var (coalesceLocalStorageLeft, _) = coalesceLocalPair;
            Fill(ref coalesceLocalStorageLeft, replacement);
        }

        System.Action? localDelegate = CoalesceLocalStorageLocal;
        localDelegate ??= Other;
        this.callback = localDelegate;
        coalesceLocalPair = (default(T), replacement);
        this.callback?.Invoke();

        var restoredPair = (replacement, replacement);
        void RestoredLocal()
        {
            var (restoredFieldLeft, _) = restoredPair;
            Fill(ref restoredFieldLeft, replacement);
        }
        void Restore()
        {
            this.callback = RestoredLocal;
        }

        this.callback = RestoredLocal;
        this.callback = null;
        Restore();
        restoredPair = (default(T), replacement);
        this.callback?.Invoke();

        var savedPropertyPair = (replacement, replacement);
        void SavedPropertyLocal()
        {
            var (savedPropertyLeft, _) = savedPropertyPair;
            Fill(ref savedPropertyLeft, replacement);
        }

        this.callback = SavedPropertyLocal;
        this.secondCallback = this.callback;
        this.callback = this.Saved;
        this.secondCallback = null;
        savedPropertyPair = (default(T), replacement);
        this.callback?.Invoke();

        var chainPair = (replacement, replacement);
        void ChainLocal()
        {
            var (chainLocalLeft, _) = chainPair;
            Fill(ref chainLocalLeft, replacement);
        }

        System.Action d0 = ChainLocal;
        System.Action d1 = d0;
        System.Action d2 = d1;
        System.Action d3 = d2;
        System.Action d4 = d3;
        System.Action d5 = d4;
        System.Action d6 = d5;
        System.Action d7 = d6;
        System.Action d8 = d7;
        System.Action d9 = d8;
        System.Action d10 = d9;
        System.Action d11 = d10;
        System.Action d12 = d11;
        System.Action d13 = d12;
        System.Action d14 = d13;
        System.Action d15 = d14;
        System.Action d16 = d15;
        System.Action d17 = d16;
        System.Action d18 = d17;
        System.Action d19 = d18;
        System.Action d20 = d19;
        System.Action d21 = d20;
        System.Action d22 = d21;
        System.Action d23 = d22;
        System.Action d24 = d23;
        this.callback = d24;
        chainPair = (default(T), replacement);
        this.callback?.Invoke();
    }

    public void CheckHolderReassignmentForwardingEarlyReturnAndSiblingLocals(T replacement, bool skip)
    {
        var reassignedHolderPair = (replacement, replacement);
        void ReassignedHolderLocal()
        {
            var (reassignedHolderLeft, _) = reassignedHolderPair;
            Fill(ref reassignedHolderLeft, replacement);
        }

        var reassignedHolder = new Probe<T>();
        var firstHolderRef = reassignedHolder;
        reassignedHolder.callback = ReassignedHolderLocal;
        reassignedHolder = new Probe<T>();
        reassignedHolder.callback = null;
        reassignedHolderPair = (default(T), replacement);
        firstHolderRef.callback?.Invoke();

        var localRestoredPair = (replacement, replacement);
        void LocalRestoredLocal()
        {
            var (localRestoredLeft, _) = localRestoredPair;
            Fill(ref localRestoredLeft, replacement);
        }
        System.Action? restoredLocalDelegate = LocalRestoredLocal;
        void RestoreLocalDelegate()
        {
            restoredLocalDelegate = LocalRestoredLocal;
        }

        restoredLocalDelegate = null;
        RestoreLocalDelegate();
        this.callback = restoredLocalDelegate;
        localRestoredPair = (default(T), replacement);
        this.callback?.Invoke();

        var forwardRestoredPair = (replacement, replacement);
        void ForwardRestoredLocal()
        {
            var (forwardRestoredLeft, _) = forwardRestoredPair;
            Fill(ref forwardRestoredLeft, replacement);
        }
        void RestoreForForward()
        {
            this.callback = ForwardRestoredLocal;
        }
        void ForwardRestore()
        {
            RestoreForForward();
        }

        this.callback = ForwardRestoredLocal;
        this.callback = null;
        ForwardRestore();
        forwardRestoredPair = (default(T), replacement);
        this.callback?.Invoke();

        var earlyReturnClearPair = (replacement, replacement);
        void EarlyReturnClearLocal()
        {
            var (earlyReturnClearLeft, _) = earlyReturnClearPair;
            Fill(ref earlyReturnClearLeft, replacement);
        }
        void ClearWithSkip(bool shouldSkip)
        {
            if (shouldSkip)
            {
                return;
            }
            this.callback = null;
        }

        this.callback = EarlyReturnClearLocal;
        ClearWithSkip(skip);
        earlyReturnClearPair = (default(T), replacement);
        this.callback?.Invoke();

        {
            var firstSiblingPair = (replacement, replacement);
            void SiblingLocal()
            {
                var (firstSiblingLeft, _) = firstSiblingPair;
                Keep(ref firstSiblingLeft);
            }

            this.callback = SiblingLocal;
            this.callback = null;
            firstSiblingPair = (default(T), replacement);
            this.callback?.Invoke();
        }

        {
            var secondSiblingPair = (replacement, replacement);
            void SiblingLocal()
            {
                var (secondSiblingLeft, _) = secondSiblingPair;
                Fill(ref secondSiblingLeft, replacement);
            }

            this.callback = SiblingLocal;
            secondSiblingPair = (default(T), replacement);
            this.callback?.Invoke();
        }

        var argSideEffectPair = (replacement, replacement);
        void ArgSideEffectLocal()
        {
            var (argSideEffectLeft, _) = argSideEffectPair;
            Fill(ref argSideEffectLeft, replacement);
        }
        System.Action? GetAfterSideEffect(bool unused) => this.callback;

        this.secondCallback = GetAfterSideEffect((this.callback = ArgSideEffectLocal) != null);
        this.callback = null;
        argSideEffectPair = (default(T), replacement);
        this.secondCallback?.Invoke();

        var mayAliasHolderPair = (replacement, replacement);
        void MayAliasHolderLocal()
        {
            var (mayAliasHolderLeft, _) = mayAliasHolderPair;
            Fill(ref mayAliasHolderLeft, replacement);
        }
        var holderA = new Probe<T>();
        var holderB = new Probe<T>();
        holderA.callback = MayAliasHolderLocal;
        Probe<T> chosenHolder;
        if (skip)
        {
            chosenHolder = holderA;
        }
        else
        {
            chosenHolder = holderB;
        }
        chosenHolder.callback = null;
        mayAliasHolderPair = (default(T), replacement);
        holderA.callback?.Invoke();

        var lambdaFieldRestorePair = (replacement, replacement);
        void LambdaFieldRestoreLocal()
        {
            var (lambdaFieldRestoreLeft, _) = lambdaFieldRestorePair;
            Fill(ref lambdaFieldRestoreLeft, replacement);
        }
        System.Action restoreFieldViaLambda = () => this.callback = LambdaFieldRestoreLocal;
        this.callback = LambdaFieldRestoreLocal;
        this.callback = null;
        restoreFieldViaLambda();
        lambdaFieldRestorePair = (default(T), replacement);
        this.callback?.Invoke();

        var lambdaLocalRestorePair = (replacement, replacement);
        void LambdaLocalRestoreLocal()
        {
            var (lambdaLocalRestoreLeft, _) = lambdaLocalRestorePair;
            Fill(ref lambdaLocalRestoreLeft, replacement);
        }
        System.Action? capturedDelegateLocal = LambdaLocalRestoreLocal;
        System.Action restoreLocalViaLambda = () => capturedDelegateLocal = LambdaLocalRestoreLocal;
        capturedDelegateLocal = null;
        restoreLocalViaLambda();
        this.callback = capturedDelegateLocal;
        lambdaLocalRestorePair = (default(T), replacement);
        this.callback?.Invoke();

        var asyncClearFieldPair = (replacement, replacement);
        void AsyncClearFieldLocal()
        {
            var (asyncClearFieldLeft, _) = asyncClearFieldPair;
            Fill(ref asyncClearFieldLeft, replacement);
        }
        async System.Threading.Tasks.Task ClearFieldAsync()
        {
            await System.Threading.Tasks.Task.Yield();
            this.callback = null;
        }
        this.callback = AsyncClearFieldLocal;
        _ = ClearFieldAsync();
        asyncClearFieldPair = (default(T), replacement);
        this.callback?.Invoke();

        var asyncDelegateClearFieldPair = (replacement, replacement);
        void AsyncDelegateClearFieldLocal()
        {
            var (asyncDelegateClearFieldLeft, _) = asyncDelegateClearFieldPair;
            Fill(ref asyncDelegateClearFieldLeft, replacement);
        }
        System.Func<System.Threading.Tasks.Task> clearFieldViaAsyncDelegate = async () =>
        {
            await System.Threading.Tasks.Task.Yield();
            this.callback = null;
        };
        this.callback = AsyncDelegateClearFieldLocal;
        _ = clearFieldViaAsyncDelegate();
        asyncDelegateClearFieldPair = (default(T), replacement);
        this.callback?.Invoke();

        var asyncClearLocalPair = (replacement, replacement);
        void AsyncClearLocalFn()
        {
            var (asyncClearLocalLeft, _) = asyncClearLocalPair;
            Fill(ref asyncClearLocalLeft, replacement);
        }
        System.Action? asyncClearedLocal = AsyncClearLocalFn;
        async System.Threading.Tasks.Task ClearLocalDelegateAsync()
        {
            await System.Threading.Tasks.Task.Yield();
            asyncClearedLocal = null;
        }
        _ = ClearLocalDelegateAsync();
        this.callback = asyncClearedLocal;
        asyncClearLocalPair = (default(T), replacement);
        this.callback?.Invoke();

        var iteratorClearFieldPair = (replacement, replacement);
        void IteratorClearFieldLocal()
        {
            var (iteratorClearFieldLeft, _) = iteratorClearFieldPair;
            Fill(ref iteratorClearFieldLeft, replacement);
        }
        System.Collections.Generic.IEnumerable<int> ClearFieldLater()
        {
            this.callback = null;
            yield break;
        }
        this.callback = IteratorClearFieldLocal;
        _ = ClearFieldLater();
        iteratorClearFieldPair = (default(T), replacement);
        this.callback?.Invoke();

        var iteratorClearLocalPair = (replacement, replacement);
        void IteratorClearLocalFn()
        {
            var (iteratorClearLocalLeft, _) = iteratorClearLocalPair;
            Fill(ref iteratorClearLocalLeft, replacement);
        }
        System.Action? iteratorClearedLocal = IteratorClearLocalFn;
        System.Collections.Generic.IEnumerable<int> ClearLocalLater()
        {
            iteratorClearedLocal = null;
            yield break;
        }
        _ = ClearLocalLater();
        this.callback = iteratorClearedLocal;
        iteratorClearLocalPair = (default(T), replacement);
        this.callback?.Invoke();

        var takeSavedFieldPair = (replacement, replacement);
        void TakeSavedFieldLocal()
        {
            var (takeSavedFieldLeft, _) = takeSavedFieldPair;
            Fill(ref takeSavedFieldLeft, replacement);
        }
        System.Action? TakeSavedField()
        {
            this.callback = null;
            return this.secondCallback;
        }
        this.callback = TakeSavedFieldLocal;
        this.secondCallback = this.callback;
        this.callback = TakeSavedField();
        this.secondCallback = null;
        takeSavedFieldPair = (default(T), replacement);
        this.callback?.Invoke();

        var takeSavedLocalPair = (replacement, replacement);
        void TakeSavedLocalFn()
        {
            var (takeSavedLocalLeft, _) = takeSavedLocalPair;
            Fill(ref takeSavedLocalLeft, replacement);
        }
        System.Action? trackedLocal = TakeSavedLocalFn;
        System.Action? backupLocal = trackedLocal;
        System.Action? TakeSavedLocalDelegate()
        {
            trackedLocal = null;
            return backupLocal;
        }
        trackedLocal = TakeSavedLocalDelegate();
        backupLocal = null;
        this.callback = trackedLocal;
        takeSavedLocalPair = (default(T), replacement);
        this.callback?.Invoke();

        var aliasRestorePair = (replacement, replacement);
        void AliasRestoreLocal()
        {
            var (aliasRestoreLeft, _) = aliasRestorePair;
            Fill(ref aliasRestoreLeft, replacement);
        }
        System.Action restoreViaLambda = () => this.callback = AliasRestoreLocal;
        System.Action aliasOfRestore = restoreViaLambda;
        this.callback = null;
        aliasOfRestore();
        aliasRestorePair = (default(T), replacement);
        this.callback?.Invoke();

        var finallyFieldPair = (replacement, replacement);
        void FinallyFieldLocal()
        {
            var (finallyFieldLeft, _) = finallyFieldPair;
            Fill(ref finallyFieldLeft, replacement);
        }
        void RestoreFieldInFinally()
        {
            try
            {
            }
            finally
            {
                this.callback = FinallyFieldLocal;
            }
        }
        this.callback = null;
        RestoreFieldInFinally();
        finallyFieldPair = (default(T), replacement);
        this.callback?.Invoke();

        var finallyLocalPair = (replacement, replacement);
        void FinallyLocalFn()
        {
            var (finallyLocalLeft, _) = finallyLocalPair;
            Fill(ref finallyLocalLeft, replacement);
        }
        System.Action? finallyLocalDelegate = null;
        void RestoreLocalInFinally()
        {
            try
            {
            }
            finally
            {
                finallyLocalDelegate = FinallyLocalFn;
            }
        }
        RestoreLocalInFinally();
        this.callback = finallyLocalDelegate;
        finallyLocalPair = (default(T), replacement);
        this.callback?.Invoke();

        var genericHelperRestorePair = (replacement, replacement);
        void GenericHelperRestoreLocal()
        {
            var (genericHelperRestoreLeft, _) = genericHelperRestorePair;
            Fill(ref genericHelperRestoreLeft, replacement);
        }
        this.callback = GenericHelperRestoreLocal;
        this.secondCallback = this.callback;
        this.callback = null;
        RestoreFromSecondGeneric<int>(this);
        this.secondCallback = null;
        genericHelperRestorePair = (default(T), replacement);
        this.callback?.Invoke();
    }

    private System.Action? Saved => this.secondCallback;

    private static System.Action? GetFromHolder(Probe<T> holder) => holder.callback;

    private static void RestoreFromSecondGeneric<U>(Probe<T> holder)
    {
        holder.callback = holder.secondCallback;
    }
}

public class VirtualClearBase<T>
{
    protected System.Action? callback;
    protected System.Action? saved;

    protected static void Fill(ref T? value, T replacement) => value = replacement;

    protected virtual void Clear()
    {
        this.callback = null;
    }

    protected virtual void Restore()
    {
    }

    protected virtual System.Action? GetSavedVirtual() => null;

    protected virtual System.Action? SavedVirtual => null;

    public void CheckVirtualClear(T replacement)
    {
        var virtualClearPair = (replacement, replacement);
        void VirtualClearLocal()
        {
            var (virtualClearLeft, _) = virtualClearPair;
            Fill(ref virtualClearLeft, replacement);
        }

        this.callback = VirtualClearLocal;
        this.Clear();
        virtualClearPair = (default(T), replacement);
        this.callback?.Invoke();

        var virtualFactoryPair = (replacement, replacement);
        void VirtualFactoryLocal()
        {
            var (virtualFactoryLeft, _) = virtualFactoryPair;
            Fill(ref virtualFactoryLeft, replacement);
        }

        this.callback = VirtualFactoryLocal;
        this.callback = this.GetSavedVirtual();
        virtualFactoryPair = (default(T), replacement);
        this.callback?.Invoke();

        var virtualGetterPair = (replacement, replacement);
        void VirtualGetterLocal()
        {
            var (virtualGetterLeft, _) = virtualGetterPair;
            Fill(ref virtualGetterLeft, replacement);
        }

        this.callback = VirtualGetterLocal;
        this.callback = this.SavedVirtual;
        virtualGetterPair = (default(T), replacement);
        this.callback?.Invoke();

        var virtualRestorePair = (replacement, replacement);
        void VirtualRestoreLocal()
        {
            var (virtualRestoreLeft, _) = virtualRestorePair;
            Fill(ref virtualRestoreLeft, replacement);
        }

        this.callback = VirtualRestoreLocal;
        this.saved = this.callback;
        this.callback = null;
        this.Restore();
        this.saved = null;
        virtualRestorePair = (default(T), replacement);
        this.callback?.Invoke();
    }
}

public sealed class VirtualClearDerived<T> : VirtualClearBase<T>
{
    protected override void Clear()
    {
    }

    protected override void Restore()
    {
        this.callback = this.saved;
    }

    protected override System.Action? GetSavedVirtual() => this.callback;

    protected override System.Action? SavedVirtual => this.callback;
}`
        let printed = Translate(source)
        Assert.DoesNotMatch("\\b(let|var) overwrittenFieldLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) retainedFieldLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) unsubscribedEventLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) twiceSubscribedEventLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) cyclicFieldLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) copiedMulticastLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) conditionalUnsubscribeLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) customEventLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) combinedRemoveLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) genericMismatchLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) genericMatchedLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) savedHelperLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) twoHolderLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) parameterHelperLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) instanceHelperLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) coalesceFieldLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) coalesceLocalStorageLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) restoredFieldLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) savedPropertyLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) chainLocalLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) reassignedHolderLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) localRestoredLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) forwardRestoredLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) earlyReturnClearLeft T\\? =", printed)
        Assert.DoesNotMatch("\\b(let|var) firstSiblingLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) secondSiblingLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) argSideEffectLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) virtualClearLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) mayAliasHolderLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) lambdaFieldRestoreLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) lambdaLocalRestoreLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) virtualFactoryLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) virtualGetterLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) virtualRestoreLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) asyncClearFieldLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) asyncDelegateClearFieldLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) asyncClearLocalLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) iteratorClearFieldLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) iteratorClearLocalLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) takeSavedFieldLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) takeSavedLocalLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) aliasRestoreLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) finallyFieldLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) finallyLocalLeft T\\? =", printed)
        Assert.Matches("\\b(let|var) genericHelperRestoreLeft T\\? =", printed)

        let part1 = `#nullable enable
public sealed partial class SplitProbe<T>
{
    private System.Action? callback;
    private static void Keep(ref T value) { }
    private static void Fill(ref T? value, T replacement) => value = replacement;
    public void PartA(T replacement)
    {
        var pair = (replacement, replacement);
        void Local()
        {
            var (firstPartLeft, _) = pair;
            Keep(ref firstPartLeft);
        }
        this.callback = Local;
        this.callback = null;
        pair = (default(T), replacement);
        this.callback?.Invoke();
    }
    public void CrossFileRestore(T replacement)
    {
        var crossRestorePair = (replacement, replacement);
        void CrossRestoreLocal()
        {
            var (crossRestoreLeft, _) = crossRestorePair;
            Fill(ref crossRestoreLeft, replacement);
        }
        this.callback = CrossRestoreLocal;
        this.unusedCb = this.callback;
        this.callback = null;
        this.RestoreFromSaved();
        this.unusedCb = null;
        crossRestorePair = (default(T), replacement);
        this.callback?.Invoke();
    }
}`
        let part2 = `#nullable enable
public sealed partial class SplitProbe<T>
{
    private System.Action? unusedCb;
    private static void Noop(ref T value) { }
    private static void SetV(ref T? value, T replacement) => value = replacement;
    public void PartB(T replacement)
    {
        var pair = (replacement, replacement);
        void Local()
        {
            var (secondPartLeft, _) = pair;
            Fill(ref secondPartLeft, replacement);
        }
        this.callback = Local;
        pair = (default(T), replacement);
        this.callback?.Invoke();
    }
    private void RestoreFromSaved()
    {
        this.callback = this.unusedCb;
    }
}`
        let splitProject = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("Part1.cs", part1), ("Part2.cs", part2)}
        )
        Assert.True(splitProject.BoundWithoutErrors, string.Join(Environment.NewLine, splitProject.ErrorDiagnostics))
        let splitDoc = splitProject.Documents[0]
        let splitContext = TranslationContext(splitProject.Compilation, splitDoc.SemanticModel, splitDoc.FilePath)
        let splitPrinted = GSharpPrinter.Print(
            CSharpToGSharpTranslator(preservePartialParts: false).TranslateDocument(splitDoc, splitContext)
        )
        Assert.DoesNotMatch("\\b(let|var) firstPartLeft T\\? =", splitPrinted)
        Assert.Matches("\\b(let|var) secondPartLeft T\\? =", splitPrinted)
        Assert.Matches("\\b(let|var) crossRestoreLeft T\\? =", splitPrinted)
    }

    shared {
        private const Source string = `#nullable enable

public static class Defaults
{
    private static void Fill<T>(ref T? value, T replacement) => value = replacement;
    private static void Keep<T>(ref T value) { }

    private static (string Text, System.Collections.Generic.List<string> Values) BuildPair() =>
        ("pair", new System.Collections.Generic.List<string>());

    private static (T? Left, T? Right) NullablePair<T>() =>
        (default, default);

    private sealed class FieldCallbacks<T>
    {
        public System.Action callback = () => { };

        public void Check(T replacement)
        {
            var pair = (replacement, replacement);
            this.callback = () =>
            {
                var (fieldCaptureLeft, _) = pair;
                Keep(ref fieldCaptureLeft);
            };
            this.callback = () => { };
            pair = (default(T), replacement);
            this.callback();
        }

        public void CheckOther(T replacement, FieldCallbacks<T> other)
        {
            var pair = (replacement, replacement);
            this.callback = () =>
            {
                var (retainedFieldLeft, _) = pair;
                Fill(ref retainedFieldLeft, replacement);
            };
            other.callback = () => { };
            pair = (default(T), replacement);
            this.callback();
        }

        public void StoreAlias(T replacement)
        {
            var pair = (replacement, replacement);
            System.Action first = () =>
            {
                var (escapedFieldAliasLeft, _) = pair;
                Fill(ref escapedFieldAliasLeft, replacement);
            };
            this.callback = first;
            pair = (default(T), replacement);
        }
    }

    private sealed class ReceiverContainer<T>
    {
        public FieldCallbacks<T> Holder = new FieldCallbacks<T>();
    }

    private static int Unconstrained<T>(T replacement, bool choose)
    {
        var fieldCallbacks = new FieldCallbacks<T>();
        fieldCallbacks.Check(replacement);
        fieldCallbacks.CheckOther(replacement, new FieldCallbacks<T>());
        fieldCallbacks.StoreAlias(replacement);

        var firstContainer = new ReceiverContainer<T>();
        var secondContainer = new ReceiverContainer<T>();
        var nestedReceiverPair = (replacement, replacement);
        System.Action nestedReceiver = () =>
        {
            var (nestedReceiverLeft, _) = nestedReceiverPair;
            Fill(ref nestedReceiverLeft, replacement);
        };
        firstContainer.Holder.callback = nestedReceiver;
        secondContainer.Holder.callback = () => { };
        nestedReceiverPair = (default(T), replacement);
        firstContainer.Holder.callback();

        var direct = default(T);
        var alias = direct;
        var branch = choose ? default(T) : alias;
        var switched = choose switch { true => default(T), _ => replacement };
        var (a, _) = (default(T), 0);
        (var b, var c) = (default(T), default(T));
        var ((d, e), f) = ((default(T), default(T)), default(T));
        (var (nestedA, nestedB), var nestedC) =
            ((default(T), default(T)), default(T));
        var (wholeLeft, wholeRight) = default((T, T));
        var ((wholeNestedA, wholeNestedB), wholeNestedC) =
            default(((T, T), T));
        var (castLeft, castRight) = ((T, T))(default(T), default(T));
        var defaultPair = (default(T), default(T));
        var (aliasLeft, aliasRight) = defaultPair;
        var (designationPair, _) = ((default(T), default(T)), 0);
        var (designationAliasLeft, designationAliasRight) = designationPair;
        var mutablePair = (default(T), default(T));
        var (mutableAliasLeft, mutableAliasRight) = mutablePair;
        mutablePair = (replacement, replacement);
        var upstreamPair = (default(T), default(T));
        var savedPair = upstreamPair;
        upstreamPair = (replacement, replacement);
        var (capturedAliasLeft, capturedAliasRight) = savedPair;
        var conditionalPair = (default(T), default(T));
        if (choose)
        {
            conditionalPair = (replacement, replacement);
        }
        var (conditionalAliasLeft, conditionalAliasRight) = conditionalPair;
        var assignedPair = (replacement, replacement);
        assignedPair = (default(T), default(T));
        var (assignedLeft, assignedRight) = assignedPair;
        var conditionallyAssignedPair = (replacement, replacement);
        if (choose)
        {
            conditionallyAssignedPair = (default(T), default(T));
        }
        var (conditionallyAssignedLeft, conditionallyAssignedRight) =
            conditionallyAssignedPair;
        var tupleAssignedPair = (replacement, replacement);
        var tupleAssignmentOther = replacement;
        var incomingTupleAssignment =
            ((default(T), default(T)), replacement);
        (tupleAssignedPair, tupleAssignmentOther) =
            incomingTupleAssignment;
        var (tupleAssignedLeft, tupleAssignedRight) = tupleAssignedPair;
        var conditionalTupleAssignedPair = (replacement, replacement);
        (conditionalTupleAssignedPair, tupleAssignmentOther) = choose
            ? ((default(T), default(T)), replacement)
            : ((replacement, replacement), replacement);
        var (conditionalTupleAssignedLeft, conditionalTupleAssignedRight) =
            conditionalTupleAssignedPair;
        var duplicatePair = (replacement, replacement);
        (duplicatePair, duplicatePair) =
            ((replacement, replacement), (default(T), default(T)));
        var (duplicateLeft, duplicateRight) = duplicatePair;
        var finalReplacementPair = (default(T), default(T));
        (finalReplacementPair, finalReplacementPair) =
            ((default(T), default(T)), (replacement, replacement));
        var (finalReplacementLeft, finalReplacementRight) =
            finalReplacementPair;
        var closurePair = (replacement, replacement);
        System.Action deferredDefault = () =>
            closurePair = (default(T), default(T));
        var (closureLeft, closureRight) = closurePair;
        var cycleA = (replacement, replacement);
        var cycleB = (replacement, replacement);
        if (choose)
        {
            cycleA = cycleB;
        }
        else
        {
            cycleB = cycleA;
        }
        var (cycleLeft, cycleRight) = cycleA;
        var exitingPair = (replacement, replacement);
        if (!choose)
        {
            exitingPair = (default(T), default(T));
            return 0;
        }
        var (exitingLeft, exitingRight) = exitingPair;
        var reassignedPair = (default(T), default(T));
        reassignedPair = (replacement, replacement);
        var (reassignedLeft, reassignedRight) = reassignedPair;
        var (conditionalLeft, conditionalRight) = choose
            ? (default(T), replacement)
            : (replacement, default(T));
        var (switchLeft, switchRight) = choose switch
        {
            true => (default(T), replacement),
            _ => (replacement, default(T)),
        };
        (T, T)? nullablePair = choose ? (replacement, replacement) : null;
        var (coalesceLeft, coalesceRight) =
            nullablePair ?? (default(T), default(T));
        var (methodLeft, methodRight) = NullablePair<T>();
        var assignmentExpressionPair = (replacement, replacement);
        (var assignmentExpressionLeft, var assignmentExpressionRight) =
            (assignmentExpressionPair = (default(T), default(T)));
        var operationPair = (replacement, replacement);
        var (_, operationSnapshot) =
            (operationPair = (default(T), default(T)), operationPair);
        var (operationLeft, operationRight) = operationSnapshot;
        T assignmentSource = replacement;
        var assignmentAlias = (assignmentSource = default(T));
        T? coalesceAssignmentSource = default;
        var coalesceAssignmentAlias =
            (coalesceAssignmentSource ??= default(T));
        T initializerless;
        initializerless = default;
        var initializerlessAlias = initializerless;
        var sharedPathSource = (replacement, replacement);
        var sharedPathChoice = sharedPathSource;
        if (choose)
        {
            sharedPathChoice = sharedPathSource;
        }
        else
        {
            sharedPathSource = (default(T), default(T));
            sharedPathChoice = sharedPathSource;
        }
        var (sharedPathLeft, sharedPathRight) = sharedPathChoice;
        T repeatedSource = default;
        var (_, repeatedAlias) = (repeatedSource, repeatedSource);
        T conditionalCycleSource = replacement;
        T conditionalCycleAlias = conditionalCycleSource;
        var conditionalCycle =
            (conditionalCycleSource = default(T)) is not null
                ? conditionalCycleAlias
                : conditionalCycleSource;
        T switchCycleSource = replacement;
        T switchCycleAlias = switchCycleSource;
        var switchCycle = (switchCycleSource = default(T)) switch
        {
            { } => switchCycleAlias,
            _ => switchCycleSource,
        };
        var nestedReadPair =
            ((default(T), replacement), replacement);
        var nestedRead = nestedReadPair.Item1.Item1;
        var deadPair = NullablePair<T>();
        goto afterDeadAssignment;
        deadPair = (default(T), default(T));
    afterDeadAssignment:
        var (deadLeft, deadRight) = deadPair;

        Fill(ref direct, replacement);
        Fill(ref alias, replacement);
        Fill(ref branch, replacement);
        Fill(ref switched, replacement);
        Fill(ref a, replacement);
        Fill(ref b, replacement);
        Fill(ref c, replacement);
        Fill(ref d, replacement);
        Fill(ref e, replacement);
        Fill(ref f, replacement);
        Fill(ref nestedA, replacement);
        Fill(ref nestedB, replacement);
        Fill(ref nestedC, replacement);
        Fill(ref wholeLeft, replacement);
        Fill(ref wholeRight, replacement);
        Fill(ref wholeNestedA, replacement);
        Fill(ref wholeNestedB, replacement);
        Fill(ref wholeNestedC, replacement);
        Fill(ref castLeft, replacement);
        Fill(ref castRight, replacement);
        Fill(ref aliasLeft, replacement);
        Fill(ref aliasRight, replacement);
        Fill(ref designationAliasLeft, replacement);
        Fill(ref designationAliasRight, replacement);
        Fill(ref mutableAliasLeft, replacement);
        Fill(ref mutableAliasRight, replacement);
        Fill(ref capturedAliasLeft, replacement);
        Fill(ref capturedAliasRight, replacement);
        Fill(ref conditionalAliasLeft, replacement);
        Fill(ref conditionalAliasRight, replacement);
        Fill(ref assignedLeft, replacement);
        Fill(ref assignedRight, replacement);
        Fill(ref conditionallyAssignedLeft, replacement);
        Fill(ref conditionallyAssignedRight, replacement);
        Fill(ref tupleAssignedLeft, replacement);
        Fill(ref tupleAssignedRight, replacement);
        Fill(ref conditionalTupleAssignedLeft, replacement);
        Fill(ref conditionalTupleAssignedRight, replacement);
        Fill(ref duplicateLeft, replacement);
        Fill(ref duplicateRight, replacement);
        Fill(ref conditionalLeft, replacement);
        Fill(ref conditionalRight, replacement);
        Fill(ref switchLeft, replacement);
        Fill(ref switchRight, replacement);
        Fill(ref coalesceLeft, replacement);
        Fill(ref coalesceRight, replacement);
        Fill(ref methodLeft, replacement);
        Fill(ref methodRight, replacement);
        Fill(ref assignmentExpressionLeft, replacement);
        Fill(ref assignmentExpressionRight, replacement);
        Fill(ref operationLeft, replacement);
        Fill(ref operationRight, replacement);
        Fill(ref assignmentAlias, replacement);
        Fill(ref coalesceAssignmentAlias, replacement);
        Fill(ref initializerlessAlias, replacement);
        Fill(ref sharedPathLeft, replacement);
        Fill(ref sharedPathRight, replacement);
        Fill(ref repeatedAlias, replacement);
        Fill(ref conditionalCycle, replacement);
        Fill(ref switchCycle, replacement);

        for (var loop = default(T); choose;)
        {
            Fill(ref loop, replacement);
            break;
        }

        for (var (loopLeft, loopRight) = (default(T), default(T)); choose;)
        {
            Fill(ref loopLeft, replacement);
            Fill(ref loopRight, replacement);
            break;
        }

        for (var loopPair = (default(T), default(T));
            choose;
            loopPair = (replacement, replacement))
        {
            var (forAliasLeft, forAliasRight) = loopPair;
            Fill(ref forAliasLeft, replacement);
            Fill(ref forAliasRight, replacement);
            break;
        }

        for (var nestedLoopPair = (replacement, replacement); choose;)
        {
            if (choose)
            {
                nestedLoopPair = (default(T), default(T));
                var (nestedLoopLeft, nestedLoopRight) = nestedLoopPair;
                Fill(ref nestedLoopLeft, replacement);
                Fill(ref nestedLoopRight, replacement);
            }

            break;
        }

        var backedgePair = (replacement, replacement);
        var again = choose;
        while (again)
        {
            var (backedgeLeft, backedgeRight) = backedgePair;
            Fill(ref backedgeLeft, replacement);
            Fill(ref backedgeRight, replacement);
            backedgePair = (default(T), default(T));
            again = false;
        }

        var breakPair = (replacement, replacement);
        while (choose)
        {
            breakPair = (default(T), default(T));
            break;
        }
        var (breakLeft, breakRight) = breakPair;
        Fill(ref breakLeft, replacement);
        Fill(ref breakRight, replacement);

        var capturedLambdaPair = (replacement, replacement);
        System.Action capturedLambda = () =>
        {
            capturedLambdaPair = (default(T), default(T));
            var (capturedLambdaLeft, capturedLambdaRight) =
                capturedLambdaPair;
            Fill(ref capturedLambdaLeft, replacement);
            Fill(ref capturedLambdaRight, replacement);
        };
        capturedLambda();

        var capturedLocalPair = (replacement, replacement);
        void CapturedLocal()
        {
            capturedLocalPair = (default(T), default(T));
            var (capturedLocalLeft, capturedLocalRight) =
                capturedLocalPair;
            Fill(ref capturedLocalLeft, replacement);
            Fill(ref capturedLocalRight, replacement);
        }
        CapturedLocal();

        var postCaptureLambdaPair = (replacement, replacement);
        System.Action postCaptureLambda = () =>
        {
            var (postCaptureLambdaLeft, postCaptureLambdaRight) =
                postCaptureLambdaPair;
            Fill(ref postCaptureLambdaLeft, replacement);
        };
        postCaptureLambdaPair = (default(T), replacement);
        postCaptureLambda();

        var postCaptureLocalPair = (replacement, replacement);
        void PostCaptureLocal()
        {
            var (postCaptureLocalLeft, postCaptureLocalRight) =
                postCaptureLocalPair;
            Fill(ref postCaptureLocalLeft, replacement);
        }
        postCaptureLocalPair = (default(T), replacement);
        PostCaptureLocal();

        var wrappedCapturePair = (replacement, replacement);
        System.Action wrappedCapture = (System.Action)(() =>
        {
            var (wrappedCaptureLeft, _) = wrappedCapturePair;
            Fill(ref wrappedCaptureLeft, replacement);
        });
        wrappedCapturePair = (default(T), replacement);
        wrappedCapture();

        var conditionalCapturePair = (replacement, replacement);
        System.Action conditionalCapture = () =>
        {
            var (conditionalCaptureLeft, _) = conditionalCapturePair;
            Fill(ref conditionalCaptureLeft, replacement);
        };
        conditionalCapturePair = (default(T), replacement);
        conditionalCapture?.Invoke();

        var conditionalDelegatePair = (replacement, replacement);
        System.Action conditionalDelegate = choose
            ? () =>
            {
                var (conditionalDelegateLeft, _) =
                    conditionalDelegatePair;
                Fill(ref conditionalDelegateLeft, replacement);
            }
            : () => { };
        conditionalDelegatePair = (default(T), replacement);
        conditionalDelegate();

        System.Action MakeReturnedCapture()
        {
            var returnedCapturePair = (replacement, replacement);
            System.Action returnedCapture = () =>
            {
                var (returnedCaptureLeft, _) = returnedCapturePair;
                Fill(ref returnedCaptureLeft, replacement);
            };
            returnedCapturePair = (default(T), replacement);
            return returnedCapture;
        }
        var escapedCapture = MakeReturnedCapture();

        var aliasedCapturePair = (replacement, replacement);
        System.Action originalCapture = () =>
        {
            var (aliasedCaptureLeft, _) = aliasedCapturePair;
            Fill(ref aliasedCaptureLeft, replacement);
        };
        System.Action aliasedCapture = originalCapture;
        aliasedCapturePair = (default(T), replacement);
        aliasedCapture();

        var reassignedCapturePair = (replacement, replacement);
        System.Action reassignedCapture = () =>
        {
            var (reassignedCaptureLeft, _) = reassignedCapturePair;
            Keep(ref reassignedCaptureLeft);
        };
        reassignedCapture();
        reassignedCapture = () => { };
        reassignedCapturePair = (default(T), replacement);
        reassignedCapture();

        var deadCapturePair = (replacement, replacement);
        System.Action deadCapture = () =>
        {
            var (deadCaptureLeft, _) = deadCapturePair;
            Keep(ref deadCaptureLeft);
        };
        goto afterDeadCapture;
        deadCapturePair = (default(T), replacement);
        deadCapture();
    afterDeadCapture:

        var nestedCapturePair = (replacement, replacement);
        System.Action outerCapture = () =>
        {
            nestedCapturePair = (default(T), default(T));
            System.Action innerCapture = () =>
            {
                var (nestedCaptureLeft, nestedCaptureRight) =
                    nestedCapturePair;
                Fill(ref nestedCaptureLeft, replacement);
                Fill(ref nestedCaptureRight, replacement);
            };
            innerCapture();
        };
        outerCapture();

        return 8;
    }

    private static int ClassConstrained<T>(T replacement)
        where T : class
    {
        T? maybe = replacement;
        if (maybe is null)
        {
            throw new System.Exception();
        }
        var narrowed = maybe;
        var (narrowedLeft, narrowedRight) = (maybe, maybe);
        var narrowedPair = (default(T), replacement);
        if (narrowedPair.Item1 is null)
        {
            return 2;
        }
        var (narrowedAlias, _) = narrowedPair;
        var narrowedWholePair = default((T, T));
        if (narrowedWholePair.Item1 is null)
        {
            return 2;
        }
        var (narrowedWholeAlias, _) = narrowedWholePair;
        T? branchValue = default;
        var (conditionalNarrowed, _) = branchValue is null
            ? (replacement, 0)
            : (branchValue, 0);
        var (switchNarrowed, _) = branchValue switch
        {
            null => (replacement, 0),
            { } => (branchValue, 0),
        };
        (T, T)? defaultPair = default;
        var (coalescePairNarrowed, _) =
            defaultPair ?? (replacement, replacement);
        var coalesced = default(T) ?? default(T);
        var coalesceNarrowed = default(T) ?? replacement;
        var (left, right) = (default(T), default(T));
        Fill(ref coalesced, replacement);
        Fill(ref left, replacement);
        Fill(ref right, replacement);
        return 2;
    }

    private static int ValueTypeControl()
    {
        var directValue = default(int);
        var (leftValue, rightValue) = (default(int), default(int));
        return directValue + leftValue + rightValue + 3;
    }

    private static (T Left, T Right) Next<T>(ref int count, T replacement)
    {
        count++;
        return (replacement, replacement);
    }

    private static int IncrementorControl<T>(T replacement)
    {
        T? left = default;
        T? right = default;
        var count = 0;
        for (; count < 3; (left, right) = Next(ref count, replacement))
        {
            if (count < 2)
            {
                continue;
            }
        }

        return count + (left is null ? 0 : 1) + (right is null ? 0 : 1);
    }

    private static int NestedFunctionControls<T>(T replacement)
    {
        System.Func<int> lambda = () =>
        {
            var lambdaPair = (default(T), default(T));
            var (lambdaLeft, lambdaRight) = lambdaPair;
            lambdaPair = (replacement, replacement);
            Fill(ref lambdaLeft, replacement);
            Fill(ref lambdaRight, replacement);
            return 1;
        };

        int Local()
        {
            var localPair = (default(T), default(T));
            var (localLeft, localRight) = localPair;
            localPair = (replacement, replacement);
            Fill(ref localLeft, replacement);
            Fill(ref localRight, replacement);
            return 1;
        }

        return lambda() + Local();
    }

    private static async System.Threading.Tasks.Task<T> AwaitControl<T>(
        System.Func<System.Threading.Tasks.Task<T>> body)
    {
        var result = await body().ConfigureAwait(false);
        return result;
    }

    private static int Controls<T>(T replacement)
    {
        var suppressed = default(T)!;
        var ordinary = "text";
        T explicitLocal = default(T);
        T? annotated = default(T);
        (T explicitLeft, T explicitRight) = (default(T), default(T));
        var (ordinaryLeft, ordinaryRight) = ("left", "right");
        var (callText, callValues) = BuildPair();
        var lambda = (int value = 1) => value;
        return ordinary.Length + ordinaryLeft.Length + ordinaryRight.Length
            + callText.Length + callValues.Count + lambda();
    }

    public static int Run() =>
        Unconstrained<string>("u", true)
        + ClassConstrained<string>("c")
        + ValueTypeControl()
        + IncrementorControl<string>("i")
        + NestedFunctionControls<string>("n");
}`

        private func Local(root SyntaxNode, model Microsoft.CodeAnalysis.SemanticModel, name string) ILocalSymbol {
            let declaration = root.DescendantNodes().First(
                (node SyntaxNode) -> switch node {
                    case declarator is VariableDeclaratorSyntax: declarator.Identifier.ValueText == name
                    case designation is SingleVariableDesignationSyntax: designation.Identifier.ValueText == name
                    default: false
                }
            )
            return Assert.IsAssignableFrom[ILocalSymbol](model.GetDeclaredSymbol(declaration))
        }

        private func Translate() string {
            return Translate(Source)
        }

        private func Translate(source string, outputKind OutputKind = OutputKind.DynamicallyLinkedLibrary) string {
            let project = Load(source, outputKind)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            // Issue #4612: a `default!` on a type parameter is reported as a
            // generic-store bridge; that report is expected here.
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity != TranslationSeverity.Info &&
                    diagnostic.DiagnosticId != CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
            )
            return printed
        }

        private func Load() LoadedCSharpProject {
            return Load(Source)
        }

        private func Load(
            source string,
            outputKind OutputKind = OutputKind.DynamicallyLinkedLibrary
        ) LoadedCSharpProject {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Snippet.cs", source)},
                outputKind: outputKind
            )
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            return project
        }
    }
}
