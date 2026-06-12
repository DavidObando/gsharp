// <copyright file="AggressiveInliningTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using Gsharp.Extensions.Optional;
using Gsharp.Extensions.Sequences;
using Xunit;

namespace GSharp.Extensions.Tests;

/// <summary>
/// Spot-check that the IL emits the <see cref="MethodImplAttributes.AggressiveInlining"/>
/// flag on the helpers ADR-0084 marks as hot. This guards against accidental
/// removal of the attribute on the helpers that benefit most from inlining
/// across the Gsharp.Extensions assembly boundary.
/// </summary>
public class AggressiveInliningTests
{
    private static readonly (System.Type Type, string Method)[] InlinedMethods = new (System.Type, string)[]
    {
        // OptionalExtensions — both class-receiver and struct-receiver
        // overloads carry [AggressiveInlining] per ADR-0084. The test iterates
        // every overload of each named method so it covers both branches.
        (typeof(OptionalExtensions), nameof(OptionalExtensions.Map)),
        (typeof(OptionalExtensions), nameof(OptionalExtensions.FlatMap)),
        (typeof(OptionalExtensions), nameof(OptionalExtensions.OrElse)),
        (typeof(OptionalExtensions), nameof(OptionalExtensions.OrCompute)),
        (typeof(OptionalExtensions), nameof(OptionalExtensions.IfPresent)),
        (typeof(OptionalExtensions), nameof(OptionalExtensions.Filter)),

        // SequenceExtensions safe terminals + Indexed. The struct-receiver
        // overloads of First/Last/SingleOrNil live in SequenceValueExtensions
        // (separate class because IEnumerable<T> shape is identical for class
        // and struct T, so C# CS0111 forbids two overloads in one class).
        (typeof(SequenceExtensions), nameof(SequenceExtensions.FirstOrNil)),
        (typeof(SequenceExtensions), nameof(SequenceExtensions.LastOrNil)),
        (typeof(SequenceExtensions), nameof(SequenceExtensions.SingleOrNil)),
        (typeof(SequenceValueExtensions), nameof(SequenceValueExtensions.FirstOrNil)),
        (typeof(SequenceValueExtensions), nameof(SequenceValueExtensions.LastOrNil)),
        (typeof(SequenceValueExtensions), nameof(SequenceValueExtensions.SingleOrNil)),
        (typeof(SequenceExtensions), nameof(SequenceExtensions.Indexed)),

        // Sequences builders (Of / Empty)
        (typeof(Sequences), nameof(Sequences.Of)),
        (typeof(Sequences), nameof(Sequences.Empty)),
    };

    private static readonly (System.Type Type, string Method)[] NotInlinedMethods = new (System.Type, string)[]
    {
        // OrThrow intentionally preserves its stack frame on both the class
        // and struct overloads.
        (typeof(OptionalExtensions), nameof(OptionalExtensions.OrThrow)),

        // Iterator-block methods are compiler-generated state machines; the
        // attribute is intentionally absent on the public entry points so the
        // class-level docs about "what is inlined" stays accurate.
        (typeof(SequenceExtensions), nameof(SequenceExtensions.Windowed)),
        (typeof(SequenceExtensions), nameof(SequenceExtensions.Chunked)),
        (typeof(SequenceExtensions), nameof(SequenceExtensions.Pairwise)),
        (typeof(SequenceExtensions), nameof(SequenceExtensions.Interleave)),
        (typeof(Sequences), nameof(Sequences.Range)),
        (typeof(Sequences), nameof(Sequences.RangeStep)),
        (typeof(Sequences), nameof(Sequences.Iterate)),
        (typeof(Sequences), nameof(Sequences.Repeat)),
    };

    [Theory]
    [MemberData(nameof(InlinedMethodCases))]
    public void HotHelper_HasAggressiveInliningFlag(System.Type declaringType, string methodName)
    {
        foreach (var m in declaringType.GetMethods(BindingFlags.Public | BindingFlags.Static).Where(m => m.Name == methodName))
        {
            Assert.True(
                (m.MethodImplementationFlags & MethodImplAttributes.AggressiveInlining) != 0,
                $"{declaringType.FullName}.{methodName} is missing MethodImplOptions.AggressiveInlining (per ADR-0084).");
        }
    }

    [Theory]
    [MemberData(nameof(NotInlinedMethodCases))]
    public void NonInlinedHelper_DoesNotHaveAggressiveInliningFlag(System.Type declaringType, string methodName)
    {
        foreach (var m in declaringType.GetMethods(BindingFlags.Public | BindingFlags.Static).Where(m => m.Name == methodName))
        {
            Assert.False(
                (m.MethodImplementationFlags & MethodImplAttributes.AggressiveInlining) != 0,
                $"{declaringType.FullName}.{methodName} unexpectedly carries MethodImplOptions.AggressiveInlining (per ADR-0084).");
        }
    }

    public static System.Collections.Generic.IEnumerable<object[]> InlinedMethodCases()
        => InlinedMethods.Select(pair => new object[] { pair.Type, pair.Method });

    public static System.Collections.Generic.IEnumerable<object[]> NotInlinedMethodCases()
        => NotInlinedMethods.Select(pair => new object[] { pair.Type, pair.Method });
}
