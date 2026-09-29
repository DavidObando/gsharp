// <copyright file="Issue4445DefaultDeconstructionNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4445: inferred locals initialized from <c>default(T)</c> carry
/// Roslyn's maybe-null state into G#, including tuple and nested deconstruction.
/// </summary>
public class Issue4445DefaultDeconstructionNullabilityTests
{
    private const string Source = """
        #nullable enable

        public static class Defaults
        {
            private static void Fill<T>(ref T? value, T replacement) => value = replacement;

            private static (string Text, System.Collections.Generic.List<string> Values) BuildPair() =>
                ("pair", new System.Collections.Generic.List<string>());

            private static (T? Left, T? Right) NullablePair<T>() =>
                (default, default);

            private static int Unconstrained<T>(T replacement, bool choose)
            {
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
        }
        """;

    [Fact]
    public void RoslynContracts_DefaultGenericLocalsAreAnnotatedAndMaybeNull()
    {
        LoadedCSharpProject project = Load();
        LoadedDocument document = Assert.Single(project.Documents);
        SemanticModel model = document.SemanticModel;
        SyntaxNode root = document.SyntaxTree.GetRoot();

        ILocalSymbol direct = Local(root, model, "direct");
        ILocalSymbol tupleLeaf = Local(root, model, "a");
        ILocalSymbol classLeaf = Local(root, model, "left");
        ILocalSymbol valueLeaf = Local(root, model, "leftValue");
        ILocalSymbol narrowed = Local(root, model, "narrowed");
        ILocalSymbol narrowedLeaf = Local(root, model, "narrowedLeft");
        ILocalSymbol conditionalLeft = Local(root, model, "conditionalLeft");
        ILocalSymbol conditionalRight = Local(root, model, "conditionalRight");
        ILocalSymbol switchLeft = Local(root, model, "switchLeft");
        ILocalSymbol switchRight = Local(root, model, "switchRight");
        ILocalSymbol narrowedAlias = Local(root, model, "narrowedAlias");
        ILocalSymbol narrowedWholeAlias = Local(root, model, "narrowedWholeAlias");
        ILocalSymbol conditionalNarrowed = Local(root, model, "conditionalNarrowed");
        ILocalSymbol switchNarrowed = Local(root, model, "switchNarrowed");
        ILocalSymbol coalesceLeft = Local(root, model, "coalesceLeft");
        ILocalSymbol coalesceRight = Local(root, model, "coalesceRight");
        ILocalSymbol coalescePairNarrowed = Local(root, model, "coalescePairNarrowed");
        VariableDeclaratorSyntax suppressedSyntax = root.DescendantNodes()
            .OfType<VariableDeclaratorSyntax>()
            .Single(node => node.Identifier.ValueText == "suppressed");
        VariableDeclaratorSyntax narrowedSyntax = root.DescendantNodes()
            .OfType<VariableDeclaratorSyntax>()
            .Single(node => node.Identifier.ValueText == "narrowed");

        Assert.Equal(NullableAnnotation.Annotated, direct.NullableAnnotation);
        Assert.Equal(NullableFlowState.MaybeNull, model.GetTypeInfo(
            root.DescendantNodes().OfType<VariableDeclaratorSyntax>()
                .Single(node => node.Identifier.ValueText == "direct")
                .Initializer.Value).Nullability.FlowState);
        Assert.Equal(NullableAnnotation.Annotated, tupleLeaf.NullableAnnotation);
        Assert.Equal(NullableAnnotation.Annotated, classLeaf.NullableAnnotation);
        Assert.Equal(NullableAnnotation.NotAnnotated, valueLeaf.NullableAnnotation);
        Assert.Equal(NullableAnnotation.Annotated, narrowed.NullableAnnotation);
        Assert.Equal(NullableAnnotation.Annotated, narrowedLeaf.NullableAnnotation);
        Assert.Equal(NullableAnnotation.Annotated, conditionalLeft.NullableAnnotation);
        Assert.Equal(NullableAnnotation.Annotated, conditionalRight.NullableAnnotation);
        Assert.Equal(NullableAnnotation.Annotated, switchLeft.NullableAnnotation);
        Assert.Equal(NullableAnnotation.Annotated, switchRight.NullableAnnotation);
        Assert.Equal(NullableAnnotation.Annotated, narrowedAlias.NullableAnnotation);
        Assert.Equal(NullableAnnotation.Annotated, narrowedWholeAlias.NullableAnnotation);
        Assert.Equal(NullableAnnotation.Annotated, conditionalNarrowed.NullableAnnotation);
        Assert.Equal(NullableAnnotation.Annotated, switchNarrowed.NullableAnnotation);
        Assert.Equal(NullableAnnotation.Annotated, coalesceLeft.NullableAnnotation);
        Assert.Equal(NullableAnnotation.Annotated, coalesceRight.NullableAnnotation);
        Assert.Equal(NullableAnnotation.Annotated, coalescePairNarrowed.NullableAnnotation);
        Assert.Equal(
            NullableFlowState.NotNull,
            model.GetTypeInfo(narrowedSyntax.Initializer.Value).Nullability.FlowState);
        TupleExpressionSyntax narrowedTuple = root.DescendantNodes()
            .OfType<TupleExpressionSyntax>()
            .Single(tuple => tuple.ToString() == "(maybe, maybe)");
        Assert.Equal(
            NullableFlowState.NotNull,
            model.GetSpeculativeTypeInfo(
                narrowedTuple.Arguments[0].Expression.SpanStart,
                narrowedTuple.Arguments[0].Expression,
                SpeculativeBindingOption.BindAsExpression).Nullability.FlowState);
        Assert.Equal(
            NullableFlowState.NotNull,
            model.GetTypeInfo(suppressedSyntax.Initializer.Value).Nullability.FlowState);
    }

    [Fact]
    public void Translation_CarriesMaybeNullStorageThroughEveryLocalShape()
    {
        string printed = Translate();

        foreach (string name in new[]
        {
            "direct", "alias", "branch", "switched", "a", "b", "c", "d", "e", "f", "loop",
            "nestedA", "nestedB", "nestedC", "wholeLeft", "wholeRight",
            "wholeNestedA", "wholeNestedB", "wholeNestedC",
            "castLeft", "castRight", "aliasLeft", "aliasRight",
            "designationAliasLeft", "designationAliasRight",
            "mutableAliasLeft", "mutableAliasRight",
            "capturedAliasLeft", "capturedAliasRight",
            "conditionalAliasLeft", "conditionalAliasRight",
            "assignedLeft", "assignedRight",
            "conditionallyAssignedLeft", "conditionallyAssignedRight",
            "tupleAssignedLeft", "tupleAssignedRight",
            "conditionalTupleAssignedLeft", "conditionalTupleAssignedRight",
            "duplicateLeft", "duplicateRight",
            "conditionalLeft", "conditionalRight", "switchLeft", "switchRight",
            "coalesceLeft", "coalesceRight",
            "loopLeft", "loopRight", "forAliasLeft", "forAliasRight",
            "nestedLoopLeft", "nestedLoopRight",
            "backedgeLeft", "backedgeRight", "breakLeft", "breakRight",
            "assignmentExpressionLeft", "assignmentExpressionRight",
            "operationLeft", "operationRight",
            "assignmentAlias", "coalesceAssignmentAlias",
            "initializerlessAlias",
            "sharedPathLeft", "sharedPathRight",
            "repeatedAlias",
            "lambdaLeft", "lambdaRight", "localLeft", "localRight",
            "coalesced", "left", "right",
        })
        {
            Assert.Matches($@"\b(let|var) {name} T\? =", printed);
        }

        Assert.DoesNotMatch(@"\b(let|var) (directValue|leftValue|rightValue) int32\? =", printed);
        Assert.DoesNotContain("suppressed T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("ordinary string? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("ordinaryLeft string? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("ordinaryRight string? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("callText string? =", printed, StringComparison.Ordinal);
        Assert.DoesNotMatch(@"\b(let|var) callValues [^=\r\n]*\? =", printed);
        Assert.DoesNotContain("explicitLocal T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("explicitLeft T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("explicitRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("narrowed T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("narrowedLeft T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("narrowedRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("narrowedAlias T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("narrowedWholeAlias T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("reassignedLeft T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("reassignedRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("closureLeft T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("closureRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("cycleLeft T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("cycleRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("finalReplacementLeft T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("finalReplacementRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("deadLeft T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("deadRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("exitingLeft T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("exitingRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("conditionalNarrowed T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("switchNarrowed T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("coalescePairNarrowed T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("coalesceNarrowed T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("methodLeft T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("methodRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("result T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotMatch(@"\b(let|var) lambda [^=\r\n]*\? =", printed);
        Assert.Contains("suppressed = default(T)!!", printed, StringComparison.Ordinal);
        Assert.Contains("annotated T? = default(T)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("let _ =", printed, StringComparison.Ordinal);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Defaults.Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS0612");
        Assert.Null(result.UnhandledException);
        Assert.Equal(20, result.Value);
    }

    [Fact]
    public void Translation_TracksTupleElementWrites()
    {
        const string source = """
            #nullable enable

            public static class TupleElementWrite
            {
                private static void Fill<T>(ref T? value, T replacement) =>
                    value = replacement;

                private static (T First, T Second) Pair<T>(T replacement) =>
                    (replacement, replacement);

                private static int Reset<T>(out (T First, T Second) pair)
                {
                    pair = default;
                    return 0;
                }

                private static void Replace<T>(out T value, T replacement) =>
                    value = replacement;

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

                    var duplicateWritePair =
                        (First: replacement, Second: replacement);
                    (duplicateWritePair.First, duplicateWritePair.First) =
                        (replacement, default(T));
                    var (duplicateWriteLeft, duplicateWriteRight) =
                        duplicateWritePair;
                    Fill(ref duplicateWriteLeft, replacement);

                    var mixedWritePair =
                        (First: replacement, Second: replacement);
                    (mixedWritePair, mixedWritePair.First) =
                        (default((T, T)), replacement);
                    var (_, mixedWriteRight) = mixedWritePair;
                    Fill(ref mixedWriteRight, replacement);

                    var outElementPair = (default(T), replacement);
                    Replace(out outElementPair.Item1, replacement);
                    var (outElementLeft, outElementRight) = outElementPair;
                }

                private static void Observe<T>(in (T, T) pair)
                {
                }
            }
            """;

        string printed = Translate(source);

        Assert.Matches(@"\b(let|var) left T\? =", printed);
        Assert.Matches(@"\b(let|var) loopLeft T\? =", printed);
        Assert.Matches(@"\b(let|var) callLeft T\? =", printed);
        Assert.Matches(@"\b(let|var) deconstructionWriteLeft T\? =", printed);
        Assert.Matches(@"\b(let|var) untouchedDefaultRight T\? =", printed);
        Assert.Matches(@"\b(let|var) inLeft T\? =", printed);
        Assert.Matches(@"\b(let|var) unknownLeft T\? =", printed);
        Assert.Matches(@"\b(let|var) combinedLeft T\? =", printed);
        Assert.Matches(@"\b(let|var) duplicateWriteLeft T\? =", printed);
        Assert.Matches(@"\b(let|var) mixedWriteRight T\? =", printed);
        Assert.DoesNotContain("outElementLeft T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("outElementRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("right T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("loopRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("callRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("deconstructionWriteRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("inRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("combinedRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("duplicateWriteRight T? =", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void Translation_TracksTupleElementReads()
    {
        const string source = """
            #nullable enable

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
            }
            """;

        string printed = Translate(source);

        Assert.Matches(@"\b(let|var) first T\? =", printed);
        Assert.DoesNotContain("second T? =", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void Translation_LowersParenthesizedForDeconstruction()
    {
        const string source = """
            public static class ParenthesizedFor
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
            }
            """;

        string printed = Translate(source);

        Assert.Contains("while", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void Translation_IgnoresAssignmentsInsideForInitializerLambda()
    {
        const string source = """
            public static class LambdaFor
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
            }
            """;

        string printed = Translate(source);

        Assert.Contains("for ", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void Translation_IgnoresAssignmentsInsideForInitializerQuery()
    {
        const string source = """
            using System.Linq;

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
            }
            """;

        string printed = Translate(source);

        Assert.Contains("for ", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void Translation_IgnoresDeferredQueryAssignmentsInReachingValues()
    {
        const string source = """
            #nullable enable
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
            }
            """;

        string printed = Translate(source);

        Assert.DoesNotContain("queryLeft T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("queryRight T? =", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void Translation_TracksAliasesInInitializerLambdas()
    {
        const string source = """
            #nullable enable

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
            }
            """;

        string printed = Translate(source);

        Assert.Matches(@"\b(let|var) fieldLeft string\? =", printed);
        Assert.Matches(@"\b(let|var) fieldRight string\? =", printed);
        Assert.Matches(@"\b(let|var) propertyLeft string\? =", printed);
        Assert.Matches(@"\b(let|var) propertyRight string\? =", printed);
    }

    [Fact]
    public void Translation_TracksAliasesInExpressionBodiedMembers()
    {
        const string source = """
            #nullable enable

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
            }
            """;

        string printed = Translate(source);

        Assert.Matches(@"\b(let|var) propertyBodyLeft T\? =", printed);
        Assert.Matches(@"\b(let|var) propertyBodyRight T\? =", printed);
        Assert.Matches(@"\b(let|var) indexerBodyLeft T\? =", printed);
        Assert.Matches(@"\b(let|var) indexerBodyRight T\? =", printed);
    }

    [Fact]
    public void Translation_TracksAliasesInPrimaryConstructorBaseArguments()
    {
        const string source = """
            #nullable enable

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
            }
            """;

        string printed = Translate(source);

        Assert.Matches(@"\b(let|var) baseLeft T\? =", printed);
        Assert.Matches(@"\b(let|var) baseRight T\? =", printed);
    }

    [Fact]
    public void Translation_TopLevelAliasKeepsDefaultProvenance()
    {
        const string source = """
            #nullable enable
            var pair = (default(string), default(string));
            var (left, right) = pair;
            pair = ("left", "right");
            System.Console.WriteLine(left ?? right);
            """;

        string printed = Translate(source, OutputKind.ConsoleApplication);

        Assert.Matches(@"\b(let|var) left string\? =", printed);
        Assert.Matches(@"\b(let|var) right string\? =", printed);
    }

    [Fact]
    public void Translation_DoesNotUseStaleAliasInitializerAfterReassignment()
    {
        const string source = """
            #nullable enable

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
            }
            """;

        string printed = Translate(source);

        Assert.DoesNotContain("alias T? =", printed, StringComparison.Ordinal);
    }

    private static ILocalSymbol Local(SyntaxNode root, SemanticModel model, string name)
    {
        SyntaxNode declaration = root.DescendantNodes()
            .First(node => node switch
            {
                VariableDeclaratorSyntax declarator => declarator.Identifier.ValueText == name,
                SingleVariableDesignationSyntax designation => designation.Identifier.ValueText == name,
                _ => false,
            });
        return Assert.IsAssignableFrom<ILocalSymbol>(model.GetDeclaredSymbol(declaration));
    }

    private static string Translate()
    {
        return Translate(Source);
    }

    private static string Translate(
        string source,
        OutputKind outputKind = OutputKind.DynamicallyLinkedLibrary)
    {
        LoadedCSharpProject project = Load(source, outputKind);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity != TranslationSeverity.Info);
        return printed;
    }

    private static LoadedCSharpProject Load()
    {
        return Load(Source);
    }

    private static LoadedCSharpProject Load(
        string source,
        OutputKind outputKind = OutputKind.DynamicallyLinkedLibrary)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) },
            outputKind: outputKind);
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));
        return project;
    }
}
