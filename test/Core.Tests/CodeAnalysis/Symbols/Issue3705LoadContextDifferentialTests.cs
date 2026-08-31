// <copyright file="Issue3705LoadContextDifferentialTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Issue #3705, family 3 — the load-context family — and #3705's prevention
/// option (3), the differential gate, applied to it.
/// <para>
/// <c>gsc</c> creates one <see cref="System.Reflection.MetadataLoadContext"/>
/// per compilation and never normalises the <see cref="Type"/>s it hands back
/// to host <c>RuntimeType</c>s. Every type-shape query the binder, lowerer and
/// emitter ask therefore has two possible operands for the same logical CLR
/// type, and the answer must not depend on which one it gets. That is the
/// whole invariant, and — exactly as with
/// <c>Issue3705MemberKindAccessibilityDifferentialTests</c> — the load context
/// never appears on the right-hand side of the expectation: each row states
/// one answer, and it is asserted for both contexts.
/// </para>
/// <para>
/// A silently-wrong site in this family is worse than an imprecise one: a
/// <c>typeof(X).IsAssignableFrom(importedType)</c> is unconditionally
/// <see langword="false"/>, so the compiler takes the wrong arm without
/// diagnosing anything (#3708 emitted no <c>Dispose</c>; the
/// <c>typeof(Delegate)</c> arm of #3697 dropped every event-handler
/// candidate). <see cref="NaiveIsAssignableFrom_IsSilentlyWrong_AcrossContexts"/>
/// pins that hazard directly, and doubles as proof that this fixture's MLC
/// really is a distinct reflection context rather than the host handing back
/// its own types.
/// </para>
/// </summary>
public class Issue3705LoadContextDifferentialTests
{
    /// <summary>
    /// The compiler queries in this family. Each is a "what shape is this CLR
    /// type?" question asked from <c>Binding/</c>, <c>Lowering/</c> or
    /// <c>Emit/</c> about a type that can have come from either context.
    /// </summary>
    public enum Query
    {
        /// <summary><c>ClrLoadContext.Satisfies(t, typeof(IDisposable))</c> — #3708's disposal predicate.</summary>
        SatisfiesIDisposable,

        /// <summary><c>ClrLoadContext.Satisfies(t, typeof(IEnumerable))</c> — the non-generic enumerable fallback.</summary>
        SatisfiesIEnumerable,

        /// <summary><c>ClrLoadContext.Satisfies(t, typeof(IList))</c> — #313's erased-generic indexer erasure.</summary>
        SatisfiesIList,

        /// <summary><c>ClrLoadContext.Satisfies(t, typeof(IDictionary))</c> — ditto, the map arm.</summary>
        SatisfiesIDictionary,

        /// <summary><c>ClrLoadContext.Satisfies(t, typeof(object))</c> — the universal arm.</summary>
        SatisfiesObject,

        /// <summary><c>ClrTypeUtilities.IsDelegateType(t)</c> — #3697's <c>typeof(Delegate)</c> arm.</summary>
        IsDelegate,

        /// <summary><c>MemberLookup.TryGetClrEnumerableElementType(t)</c> — the <c>for x in …</c> element type.</summary>
        EnumerableElement,

        /// <summary><c>ClrLoadContext.TryGetDelegateSignature(t)</c> — #932/#3697's signature decomposition.</summary>
        DelegateSignature,
    }

    /// <summary>
    /// The differential table. Every row is <c>(host type, query, the one
    /// answer)</c>; the reflection context is deliberately absent from the
    /// expectation.
    /// </summary>
    /// <returns>The xUnit member-data rows.</returns>
    public static TheoryData<string, Query, string> Rows()
    {
        var data = new TheoryData<string, Query, string>();

        void Add(Type hostType, Query query, string expected)
            => data.Add(hostType.AssemblyQualifiedName!, query, expected);

        // --- IDisposable: #3708's predicate. The `for x in imported` disposal
        // arm read `typeof(IDisposable).IsAssignableFrom(clrType)`.
        Add(typeof(List<int>.Enumerator), Query.SatisfiesIDisposable, "True");
        Add(typeof(MemoryStream), Query.SatisfiesIDisposable, "True");
        Add(typeof(IEnumerator<int>), Query.SatisfiesIDisposable, "True");
        Add(typeof(IDisposable), Query.SatisfiesIDisposable, "True");
        Add(typeof(StringBuilder), Query.SatisfiesIDisposable, "False");
        Add(typeof(int), Query.SatisfiesIDisposable, "False");

        // --- Non-generic IEnumerable: MemberLookup's fallback arm.
        Add(typeof(ArrayList), Query.SatisfiesIEnumerable, "True");
        Add(typeof(Hashtable), Query.SatisfiesIEnumerable, "True");
        Add(typeof(string), Query.SatisfiesIEnumerable, "True");
        Add(typeof(List<int>), Query.SatisfiesIEnumerable, "True");
        Add(typeof(int[]), Query.SatisfiesIEnumerable, "True");
        Add(typeof(StringBuilder), Query.SatisfiesIEnumerable, "False");

        // --- IList / IDictionary: emit's #313 erased-generic indexer erasure.
        Add(typeof(List<object>), Query.SatisfiesIList, "True");
        Add(typeof(ArrayList), Query.SatisfiesIList, "True");
        Add(typeof(Dictionary<string, object>), Query.SatisfiesIList, "False");
        Add(typeof(Dictionary<string, object>), Query.SatisfiesIDictionary, "True");
        Add(typeof(Hashtable), Query.SatisfiesIDictionary, "True");
        Add(typeof(List<object>), Query.SatisfiesIDictionary, "False");

        // --- The universal arm. Interfaces have a null BaseType, so a bare
        // base-chain walk misses them; value types reach object by boxing.
        Add(typeof(StringBuilder), Query.SatisfiesObject, "True");
        Add(typeof(IDisposable), Query.SatisfiesObject, "True");
        Add(typeof(int), Query.SatisfiesObject, "True");
        Add(typeof(object), Query.SatisfiesObject, "True");

        // --- Delegate-ness: #3697's `typeof(Delegate).IsAssignableFrom` arm.
        Add(typeof(Action), Query.IsDelegate, "True");
        Add(typeof(Action<int>), Query.IsDelegate, "True");
        Add(typeof(Func<int, string>), Query.IsDelegate, "True");
        Add(typeof(Predicate<string>), Query.IsDelegate, "True");
        Add(typeof(EventHandler), Query.IsDelegate, "True");
        Add(typeof(Comparison<int>), Query.IsDelegate, "True");
        Add(typeof(Delegate), Query.IsDelegate, "True");
        Add(typeof(StringBuilder), Query.IsDelegate, "False");
        Add(typeof(IDisposable), Query.IsDelegate, "False");

        // --- The `for x in …` element type. The generic arm walks the
        // interface closure by FullName (#2859); the non-generic fallback did
        // not, until #3705.
        Add(typeof(List<string>), Query.EnumerableElement, "System.String");
        Add(typeof(int[]), Query.EnumerableElement, "System.Int32");
        Add(typeof(IReadOnlyCollection<int>), Query.EnumerableElement, "System.Int32");
        Add(typeof(ArrayList), Query.EnumerableElement, "System.Object");
        Add(typeof(Hashtable), Query.EnumerableElement, "System.Object");
        Add(typeof(StringBuilder), Query.EnumerableElement, "<none>");

        // --- Delegate signature decomposition.
        Add(typeof(Action), Query.DelegateSignature, "() -> System.Void");
        Add(typeof(Action<int>), Query.DelegateSignature, "(System.Int32) -> System.Void");
        Add(typeof(Func<int, string>), Query.DelegateSignature, "(System.Int32) -> System.String");
        Add(typeof(Predicate<string>), Query.DelegateSignature, "(System.String) -> System.Boolean");
        Add(typeof(Comparison<int>), Query.DelegateSignature, "(System.Int32, System.Int32) -> System.Int32");
        Add(typeof(EventHandler), Query.DelegateSignature, "(System.Object, System.EventArgs) -> System.Void");

        return data;
    }

    /// <summary>
    /// The invariant: the answer is a property of the logical CLR type, not of
    /// the reflection context the <see cref="Type"/> was materialised in.
    /// </summary>
    /// <param name="hostTypeName">Assembly-qualified name of the host type under test.</param>
    /// <param name="query">The compiler query to ask.</param>
    /// <param name="expected">The single expected answer, for both contexts.</param>
    [Theory]
    [MemberData(nameof(Rows))]
    public void SameAnswer_ForRuntimeType_AndMetadataLoadContextTwin(string hostTypeName, Query query, string expected)
    {
        var hostType = Type.GetType(hostTypeName, throwOnError: true)!;

        using var resolver = CreateMetadataLoadContextResolver();
        var mlcType = resolver.MapClrTypeToReferences(hostType);
        Assert.True(mlcType != null, $"no MetadataLoadContext twin for '{hostType.FullName}'");
        Assert.False(
            ReferenceEquals(hostType, mlcType),
            $"'{hostType.FullName}' resolved to the host type — the fixture is not exercising two contexts");

        var hostAnswer = Ask(query, hostType);
        var mlcAnswer = Ask(query, mlcType!);

        Assert.Equal(expected, hostAnswer);
        Assert.Equal(expected, mlcAnswer);
    }

    /// <summary>
    /// The hazard this family exists for, pinned directly: a host
    /// <c>typeof(X).IsAssignableFrom(y)</c> is not merely imprecise for a
    /// MetadataLoadContext <c>y</c> — it is silently, unconditionally
    /// <see langword="false"/>. This is why every such site had to move behind
    /// <see cref="ClrLoadContext"/>, and why the guard-rail test forbids new
    /// ones.
    /// </summary>
    [Fact]
    public void NaiveIsAssignableFrom_IsSilentlyWrong_AcrossContexts()
    {
        using var resolver = CreateMetadataLoadContextResolver();

        var mlcArrayList = resolver.MapClrTypeToReferences(typeof(ArrayList));
        var mlcEnumerator = resolver.MapClrTypeToReferences(typeof(List<int>.Enumerator));
        Assert.NotNull(mlcArrayList);
        Assert.NotNull(mlcEnumerator);

        // What the sites did before #3705: false, with no diagnostic.
        Assert.False(typeof(IEnumerable).IsAssignableFrom(mlcArrayList));
        Assert.False(typeof(IDisposable).IsAssignableFrom(mlcEnumerator));

        // The same questions asked in the host context: true.
        Assert.True(typeof(IEnumerable).IsAssignableFrom(typeof(ArrayList)));
        Assert.True(typeof(IDisposable).IsAssignableFrom(typeof(List<int>.Enumerator)));

        // Through the funnel: true in both.
        Assert.True(ClrLoadContext.Satisfies(mlcArrayList, typeof(IEnumerable)));
        Assert.True(ClrLoadContext.Satisfies(mlcEnumerator, typeof(IDisposable)));
    }

    private static string Ask(Query query, Type type) => query switch
    {
        Query.SatisfiesIDisposable => ClrLoadContext.Satisfies(type, typeof(IDisposable)).ToString(),
        Query.SatisfiesIEnumerable => ClrLoadContext.Satisfies(type, typeof(IEnumerable)).ToString(),
        Query.SatisfiesIList => ClrLoadContext.Satisfies(type, typeof(IList)).ToString(),
        Query.SatisfiesIDictionary => ClrLoadContext.Satisfies(type, typeof(IDictionary)).ToString(),
        Query.SatisfiesObject => ClrLoadContext.Satisfies(type, typeof(object)).ToString(),
        Query.IsDelegate => ClrTypeUtilities.IsDelegateType(type).ToString(),
        Query.EnumerableElement => MemberLookup.TryGetClrEnumerableElementType(type, out var element)
            ? element.FullName ?? element.Name
            : "<none>",
        Query.DelegateSignature => ClrLoadContext.TryGetDelegateSignature(type, out var ps, out var ret)
            ? "(" + string.Join(", ", ps.Select(p => p.FullName ?? p.Name)) + ") -> " + (ret.FullName ?? ret.Name)
            : "<none>",
        _ => throw new ArgumentOutOfRangeException(nameof(query)),
    };

    /// <summary>
    /// Builds the reference-assembly-backed resolver <c>gsc</c> uses on every
    /// real <c>/reference:</c> compile — the same construction
    /// <c>Issue2348NotNullWhenMetadataLoadContextTests</c> relies on.
    /// </summary>
    /// <returns>A MetadataLoadContext-backed resolver.</returns>
    private static ReferenceResolver CreateMetadataLoadContextResolver()
    {
        var runtimeDir = RuntimeEnvironment.GetRuntimeDirectory();
        var refPaths = Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly);
        return ReferenceResolver.WithReferences(refPaths);
    }
}
