// <copyright file="AggressiveInliningTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using Gsharp.Extensions.Sequences;
using Xunit;

namespace GSharp.Extensions.Tests;

/// <summary>
/// Spot-check that the IL emits the <see cref="MethodImplAttributes.AggressiveInlining"/>
/// flag on the helpers ADR-0084 marks as hot. This guards against accidental
/// removal of the attribute on the helpers that benefit most from inlining
/// across the Gsharp.Extensions assembly boundary.
/// </summary>
/// <remarks>
/// Issue #806 ported `Gsharp.Extensions.Optional` and the transformer / terminal
/// helpers under `Gsharp.Extensions.Sequences` from C# to idiomatic G#.
/// Top-level extension funcs in G# lower to static methods on a compiler-
/// generated `&lt;Program&gt;` host typedef inside the package namespace; the
/// original C# host classes (<c>OptionalExtensions</c>, <c>SequenceExtensions</c>,
/// <c>SequenceValueExtensions</c>) no longer exist as real types. The tests
/// therefore resolve the host by `(namespace, &lt;Program&gt;)` reflection
/// instead of `typeof(OptionalExtensions)` etc. `Sequences` (the named class
/// for builders) is unaffected and still resolves via `typeof`.
/// </remarks>
public class AggressiveInliningTests
{
    private static readonly Assembly ExtensionsAssembly = typeof(Sequences).Assembly;

    private static System.Type ResolveHost(string namespaceName)
    {
        // G# emits each package's free-standing functions into a
        // compiler-generated `<Program>` host typedef under the
        // package namespace. The angle brackets are part of the metadata
        // name; reflection's GetType() accepts them literally.
        var full = namespaceName + ".<Program>";
        return ExtensionsAssembly.GetType(full, throwOnError: true)!;
    }

    private static readonly System.Type OptionalHost = ResolveHost("Gsharp.Extensions.Optional");
    private static readonly System.Type SequencesHost = ResolveHost("Gsharp.Extensions.Sequences");

    private static readonly (System.Type Type, string Method)[] InlinedMethods = new (System.Type, string)[]
    {
        // OptionalExtensions — both class-receiver and struct-receiver
        // overloads carry [AggressiveInlining] per ADR-0084. The test iterates
        // every overload of each named method so it covers both branches.
        (OptionalHost, "Map"),
        (OptionalHost, "FlatMap"),
        (OptionalHost, "OrElse"),
        (OptionalHost, "OrCompute"),
        (OptionalHost, "IfPresent"),
        (OptionalHost, "Filter"),

        // SequenceExtensions safe terminals + Indexed. The struct-receiver
        // overloads of First/Last/SingleOrNil are siblings of the class-
        // receiver overloads on the same `<Program>` host typedef (G#'s
        // `[T class]` / `[T struct]` constraint-paired overloads coexist
        // without the C# CS0111 problem).
        (SequencesHost, "FirstOrNil"),
        (SequencesHost, "LastOrNil"),
        (SequencesHost, "SingleOrNil"),
        (SequencesHost, "Indexed"),

        // Sequences builders (Of / Empty)
        (typeof(Sequences), nameof(Sequences.Of)),
        (typeof(Sequences), nameof(Sequences.Empty)),
    };

    private static readonly (System.Type Type, string Method)[] NotInlinedMethods = new (System.Type, string)[]
    {
        // OrThrow intentionally preserves its stack frame on both the class
        // and struct overloads.
        (OptionalHost, "OrThrow"),

        // Iterator-block methods are compiler-generated state machines; the
        // attribute is intentionally absent on the public entry points so the
        // class-level docs about "what is inlined" stays accurate.
        (SequencesHost, "Windowed"),
        (SequencesHost, "Chunked"),
        (SequencesHost, "Pairwise"),
        (SequencesHost, "Interleave"),
        (typeof(Sequences), nameof(Sequences.Range)),
        (typeof(Sequences), nameof(Sequences.RangeStep)),
        (typeof(Sequences), nameof(Sequences.Iterate)),
        (typeof(Sequences), nameof(Sequences.Repeat)),
    };

    [Theory]
    [MemberData(nameof(InlinedMethodCases))]
    public void HotHelper_HasAggressiveInliningFlag(System.Type declaringType, string methodName)
    {
        var matched = false;
        foreach (var m in declaringType.GetMethods(BindingFlags.Public | BindingFlags.Static).Where(m => m.Name == methodName))
        {
            matched = true;
            Assert.True(
                (m.MethodImplementationFlags & MethodImplAttributes.AggressiveInlining) != 0,
                $"{declaringType.FullName}.{methodName} is missing MethodImplOptions.AggressiveInlining (per ADR-0084).");
        }

        Assert.True(matched, $"{declaringType.FullName}.{methodName} not found.");
    }

    [Theory]
    [MemberData(nameof(NotInlinedMethodCases))]
    public void NonInlinedHelper_DoesNotHaveAggressiveInliningFlag(System.Type declaringType, string methodName)
    {
        var matched = false;
        foreach (var m in declaringType.GetMethods(BindingFlags.Public | BindingFlags.Static).Where(m => m.Name == methodName))
        {
            matched = true;
            Assert.False(
                (m.MethodImplementationFlags & MethodImplAttributes.AggressiveInlining) != 0,
                $"{declaringType.FullName}.{methodName} unexpectedly carries MethodImplOptions.AggressiveInlining (per ADR-0084).");
        }

        Assert.True(matched, $"{declaringType.FullName}.{methodName} not found.");
    }

    public static System.Collections.Generic.IEnumerable<object[]> InlinedMethodCases()
        => InlinedMethods.Select(pair => new object[] { pair.Type, pair.Method });

    public static System.Collections.Generic.IEnumerable<object[]> NotInlinedMethodCases()
        => NotInlinedMethods.Select(pair => new object[] { pair.Type, pair.Method });
}
