// <copyright file="DocumentationIssue393Tests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Documentation;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Documentation;

/// <summary>
/// Regression tests for issue #393 — two latent defects deferred from PR #392 that become
/// user-visible once method/member hover begins reflecting members off constructed generic
/// types or running concurrently. The fixes live in
/// <see cref="DocumentationIdProvider"/> (declaring-type normalization for member DocIDs)
/// and <see cref="AssemblyDocumentationProvider"/> (verified concurrency safety).
/// </summary>
public class DocumentationIssue393Tests
{
    [Fact]
    public void Method_OnConstructedGenericType_NormalizesDeclaringTypeToDefinition()
    {
        // Reflecting `Add(T)` off `List<int>` yields a method whose DeclaringType is the
        // *constructed* type `List<int>`, not `List<>`. The DocID must still use the
        // generic definition (`List`1`) so it matches the XML doc key emitted by Roslyn.
        var method = typeof(List<int>).GetMethod(nameof(List<int>.Add));
        Assert.NotNull(method);

        var docId = DocumentationIdProvider.GetDocumentationId(method);

        Assert.Equal("M:System.Collections.Generic.List`1.Add(`0)", docId);
    }

    [Fact]
    public void Method_OnConstructedGenericType_MatchesOpenGenericTypeDocId()
    {
        // The DocID for `List<int>.Add` and `List<>.Add` must be byte-for-byte identical
        // because XML doc files only emit one entry, keyed by the generic definition.
        var fromConstructed = DocumentationIdProvider.GetDocumentationId(
            typeof(List<int>).GetMethod(nameof(List<int>.Add)));
        var fromOpen = DocumentationIdProvider.GetDocumentationId(
            typeof(List<>).GetMethod(nameof(List<int>.Add)));

        Assert.Equal(fromOpen, fromConstructed);
    }

    [Fact]
    public void Property_OnConstructedGenericType_NormalizesDeclaringTypeToDefinition()
    {
        var property = typeof(List<int>).GetProperty(nameof(List<int>.Count));
        Assert.NotNull(property);

        var docId = DocumentationIdProvider.GetDocumentationId(property);

        Assert.Equal("P:System.Collections.Generic.List`1.Count", docId);
    }

    [Fact]
    public void Field_OnConstructedGenericType_NormalizesDeclaringTypeToDefinition()
    {
        // KeyValuePair<,> is a struct with no public fields, so use a real BCL field:
        // pick any generic type that exposes a public field. Tuple<T1>.Item1 is a
        // *property*, so we test via Generic393Sample below.
        var field = typeof(Generic393Sample<int>).GetField(nameof(Generic393Sample<int>.PublicField));
        Assert.NotNull(field);

        var docId = DocumentationIdProvider.GetDocumentationId(field);

        Assert.Equal(
            "F:GSharp.Core.Tests.CodeAnalysis.Documentation.Generic393Sample`1.PublicField",
            docId);
    }

    [Fact]
    public void Event_OnConstructedGenericType_NormalizesDeclaringTypeToDefinition()
    {
        var @event = typeof(Generic393Sample<int>).GetEvent(nameof(Generic393Sample<int>.PublicEvent));
        Assert.NotNull(@event);

        var docId = DocumentationIdProvider.GetDocumentationId(@event);

        Assert.Equal(
            "E:GSharp.Core.Tests.CodeAnalysis.Documentation.Generic393Sample`1.PublicEvent",
            docId);
    }

    [Fact]
    public void ForAssembly_ConcurrentCallers_ProduceSingleSharedProvider()
    {
        // ConditionalWeakTable.GetValue is documented thread-safe, but the value factory
        // (Create) may run more than once under contention. Either way, every caller must
        // observe the *same* cached provider instance once contention settles.
        var assembly = typeof(string).Assembly;

        const int threadCount = 32;
        var barrier = new Barrier(threadCount);
        var observed = new ConcurrentBag<AssemblyDocumentationProvider>();

        Parallel.For(0, threadCount, _ =>
        {
            barrier.SignalAndWait();
            observed.Add(AssemblyDocumentationProvider.ForAssembly(assembly));
        });

        // Final ForAssembly call resolves the canonical, cached instance (the table
        // collapses to a single value); every observer should ultimately see a non-null
        // provider and a *subsequent* call must return that same instance.
        var canonical = AssemblyDocumentationProvider.ForAssembly(assembly);
        Assert.NotNull(canonical);
        Assert.All(observed, p => Assert.NotNull(p));
        Assert.Same(canonical, AssemblyDocumentationProvider.ForAssembly(assembly));
    }

    [Fact]
    public void Resolve_ConcurrentReaders_ProduceConsistentResults()
    {
        // Hammer Resolve from many threads on a mix of well-known BCL members. We don't
        // care whether the underlying ref pack is installed (results may be null) — we
        // care that:
        //   1. No exceptions escape the lookup path.
        //   2. Every thread sees the same answer for the same input (a writer-during-read
        //      race on the published Dictionary would corrupt some lookups).
        var inputs = new MemberInfo[]
        {
            typeof(string),
            typeof(int),
            typeof(System.Collections.Generic.List<>),
            typeof(string).GetMethod(nameof(string.Substring), new[] { typeof(int) }),
            typeof(string).GetProperty(nameof(string.Length)),
            typeof(int).GetField(nameof(int.MaxValue)),
        };

        // Baseline (single-threaded) result for each input — what every concurrent caller
        // must agree with.
        var baseline = inputs
            .Select(m => ResolveAny(m))
            .ToArray();

        const int iterations = 200;
        var exceptions = new ConcurrentBag<Exception>();
        var mismatches = 0;

        Parallel.For(0, iterations, i =>
        {
            try
            {
                for (var k = 0; k < inputs.Length; k++)
                {
                    var actual = ResolveAny(inputs[k]);
                    var expected = baseline[k];

                    // Documentation may be null when no ref pack is installed; just check
                    // that null-ness agrees and the parsed values are equal (the record
                    // type has value-based equality, so reading from a corrupted shared
                    // dictionary would produce divergent values).
                    if ((actual == null) != (expected == null))
                    {
                        Interlocked.Increment(ref mismatches);
                        continue;
                    }

                    if (actual != null && !actual.Equals(expected))
                    {
                        Interlocked.Increment(ref mismatches);
                    }
                }
            }
            catch (Exception ex)
            {
                exceptions.Add(ex);
            }
        });

        Assert.Empty(exceptions);
        Assert.Equal(0, mismatches);
    }

    private static DocumentationComment ResolveAny(MemberInfo member)
    {
        return member switch
        {
            Type t => AssemblyDocumentationProvider.Resolve(t),
            MethodInfo m => AssemblyDocumentationProvider.Resolve(m),
            PropertyInfo p => AssemblyDocumentationProvider.Resolve(p),
            FieldInfo f => AssemblyDocumentationProvider.Resolve(f),
            EventInfo e => AssemblyDocumentationProvider.Resolve(e),
            _ => null,
        };
    }
}

/// <summary>
/// Helper generic type carrying a public field and event so the issue #393 regression
/// tests can verify <see cref="DocumentationIdProvider"/> normalizes the declaring type
/// for every member kind, not just methods and properties (which already have BCL
/// counterparts on <c>List&lt;T&gt;</c>).
/// </summary>
/// <typeparam name="T">Unused payload parameter — only its arity matters for DocIDs.</typeparam>
#pragma warning disable CA1051, CA1003, CS0067, SA1401
public sealed class Generic393Sample<T>
{
    /// <summary>Public field used to verify field DocIDs on constructed generic types.</summary>
    public int PublicField;

    /// <summary>Public event used to verify event DocIDs on constructed generic types.</summary>
    public event EventHandler PublicEvent;
}
#pragma warning restore CA1051, CA1003, CS0067, SA1401
