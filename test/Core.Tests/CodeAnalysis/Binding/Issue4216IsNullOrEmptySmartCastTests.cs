// <copyright file="Issue4216IsNullOrEmptySmartCastTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4216: receiver-style nullable predicates narrow their stable receiver
/// through explicit <c>[NotNullWhen]</c> contracts, with a compatibility rule
/// for established unannotated <c>IsNullOrEmpty</c> sequence extensions.
/// </summary>
public class Issue4216IsNullOrEmptySmartCastTests
{
    private const string SequenceExtension = """
        import System.Collections.Generic
        import System.Linq

        func (values IEnumerable[T]?) IsNullOrEmpty[T]() bool {
            return values == nil || values.Count() == 0
        }
        """;

    [Fact]
    public void NegatedUnannotatedSequencePredicate_NarrowsThenBranch()
    {
        var result = Evaluate(SequenceExtension + """

            func Count(values IEnumerable[int32]?) int32 {
                var count = 0
                if !values.IsNullOrEmpty() {
                    for value in values {
                        count++
                    }
                }
                return count
            }

            Count([]int32{1, 2, 3})
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void UnannotatedSequencePredicate_NarrowsElseBranch()
    {
        var result = Evaluate(SequenceExtension + """

            func First(values IEnumerable[int32]?) int32 {
                if values.IsNullOrEmpty() {
                    return -1
                } else {
                    for value in values {
                        return value
                    }
                }
                return -2
            }

            First([]int32{7})
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void UnannotatedSequencePredicate_EarlyExitLiftsNarrowing()
    {
        var result = Evaluate(SequenceExtension + """

            func Count(values IEnumerable[int32]?) int32 {
                if values.IsNullOrEmpty() {
                    return 0
                }

                var count = 0
                for value in values {
                    count++
                }
                return count
            }

            Count([]int32{1, 2})
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void AnnotatedReceiverPredicate_WithDifferentName_Narrows()
    {
        var result = Evaluate("""
            import System.Diagnostics.CodeAnalysis

            func (@NotNullWhen(false) value string?) IsMissing() bool {
                return value == nil
            }

            func Length(value string?) int32 {
                if !value.IsMissing() {
                    return value.Length
                }
                return -1
            }

            Length("hello")
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void IsNullOrEmpty_OnUnrelatedNullableReceiver_DoesNotNarrow()
    {
        var result = Evaluate("""
            func (value int32?) IsNullOrEmpty() bool {
                return false
            }

            func Read(value int32?) int32 {
                if !value.IsNullOrEmpty() {
                    return value
                }
                return 0
            }

            Read(1)
            """);

        Assert.Contains(
            result.Diagnostics,
            diagnostic => diagnostic.Message.Contains("Cannot convert type", StringComparison.Ordinal));
    }

    [Fact]
    public void IsNullOrEmpty_WithAdditionalArgument_DoesNotNarrow()
    {
        var result = Evaluate("""
            import System.Collections.Generic

            func (values IEnumerable[int32]?) IsNullOrEmpty(flag bool) bool {
                return flag
            }

            func Count(values IEnumerable[int32]?) int32 {
                if !values.IsNullOrEmpty(false) {
                    for value in values {
                        return value
                    }
                }
                return -1
            }

            Count([]int32{1})
            """);

        Assert.Contains(
            result.Diagnostics,
            diagnostic => diagnostic.Message.Contains("IEnumerable[int32]?", StringComparison.Ordinal));
    }

    [Fact]
    public void UnannotatedSequencePredicate_NarrowsStableLetFieldPath()
    {
        var result = Evaluate(SequenceExtension + """

            class Box { let Values IEnumerable[int32]? }

            func Count(box Box) int32 {
                var count = 0
                if !box.Values.IsNullOrEmpty() {
                    for value in box.Values {
                        count++
                    }
                }
                return count
            }

            Count(Box{Values: []int32{1, 2, 3}})
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void UnannotatedSequencePredicate_DoesNotNarrowMutableFieldPath()
    {
        var result = Evaluate(SequenceExtension + """

            class Box { var Values IEnumerable[int32]? }

            func Count(box Box) int32 {
                var count = 0
                if !box.Values.IsNullOrEmpty() {
                    for value in box.Values {
                        count++
                    }
                }
                return count
            }

            Count(Box{Values: []int32{1}})
            """);

        Assert.Contains(
            result.Diagnostics,
            diagnostic => diagnostic.Message.Contains("IEnumerable[int32]?", StringComparison.Ordinal));
    }

    [Fact]
    public void ExplicitOppositeReceiverContract_OverridesTheNameRule()
    {
        // [NotNullWhen(true)] on a method NAMED IsNullOrEmpty must win over the
        // compatibility rule's implied [NotNullWhen(false)], narrowing the
        // opposite arm.
        var result = Evaluate("""
            import System.Collections.Generic
            import System.Diagnostics.CodeAnalysis

            func (@NotNullWhen(true) values IEnumerable[int32]?) IsNullOrEmpty() bool {
                return values != nil
            }

            func Count(values IEnumerable[int32]?) int32 {
                var count = 0
                if values.IsNullOrEmpty() {
                    for value in values {
                        count++
                    }
                }
                return count
            }

            Count([]int32{1, 2})
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void UnconstrainedGenericReceiver_DoesNotInheritTheNameRule()
    {
        // Issue #4216 review: eligibility is decided by the DECLARED receiver
        // type. An unconstrained `T?` receiver must not pick up the contract
        // merely because this call site happens to pass a sequence.
        var result = Evaluate("""
            import System.Collections.Generic

            func (value T?) IsNullOrEmpty[T]() bool {
                return value == nil
            }

            func Count(values IEnumerable[int32]?) int32 {
                var count = 0
                if !values.IsNullOrEmpty() {
                    for value in values {
                        count++
                    }
                }
                return count
            }

            Count([]int32{1})
            """);

        Assert.Contains(
            result.Diagnostics,
            diagnostic => diagnostic.Message.Contains("IEnumerable[int32]?", StringComparison.Ordinal));
    }

    [Fact]
    public void MemberPathNarrowing_IsNotLiftedPastAnEarlyReturn()
    {
        // ADR-0069: the issue #2159 join pass lifts plain variables only, so a
        // member path narrowed by an early-exit guard is NOT non-null at the
        // join. Failing to narrow is sound; this pins the boundary so a future
        // change to the join pass is a deliberate decision, not a surprise.
        var result = Evaluate(SequenceExtension + """

            class Box { let Values IEnumerable[int32]? }

            func Count(box Box) int32 {
                if box.Values.IsNullOrEmpty() {
                    return 0
                }

                var count = 0
                for value in box.Values {
                    count++
                }
                return count
            }

            Count(Box{Values: []int32{1, 2}})
            """);

        Assert.Contains(
            result.Diagnostics,
            diagnostic => diagnostic.Message.Contains("IEnumerable[int32]?", StringComparison.Ordinal));
    }

    private static EmittedOracleResult Evaluate(string source)
        => EmittedOracle.Evaluate(source);
}
