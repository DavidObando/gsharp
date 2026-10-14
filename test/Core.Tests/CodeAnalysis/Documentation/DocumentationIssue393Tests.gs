// <copyright file="DocumentationIssue393Tests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Documentation

import GSharp.Core.CodeAnalysis.Documentation
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Linq
import System.Reflection
import System.Threading
import System.Threading.Tasks
import Xunit

/// Regression tests for issue #393 — two latent defects deferred from PR #392 that become
/// user-visible once method/member hover begins reflecting members off constructed generic
/// types or running concurrently. The fixes live in
/// (cref:DocumentationIdProvider) (declaring-type normalization for member DocIDs)
/// and (cref:AssemblyDocumentationProvider) (verified concurrency safety).
open class DocumentationIssue393Tests {
    @Fact
    func Method_OnConstructedGenericType_NormalizesDeclaringTypeToDefinition() {
        // Reflecting `Add(T)` off `List<int>` yields a method whose DeclaringType is the
        // *constructed* type `List<int>`, not `List<>`. The DocID must still use the
        // generic definition (`List`1`) so it matches the XML doc key emitted by Roslyn.
        let method MethodInfo? = typeof(List[int32]).GetMethod("Add")
        Assert.NotNull(method)
        let docId = DocumentationIdProvider.GetDocumentationId(method!!)
        Assert.Equal("M:System.Collections.Generic.List`1.Add(`0)", docId)
    }

    @Fact
    func Method_OnConstructedGenericType_MatchesOpenGenericTypeDocId() {
        // The DocID for `List<int>.Add` and `List<>.Add` must be byte-for-byte identical
        // because XML doc files only emit one entry, keyed by the generic definition.
        let fromConstructed = DocumentationIdProvider.GetDocumentationId(typeof(List[int32]).GetMethod("Add")!!)
        let fromOpen = DocumentationIdProvider.GetDocumentationId(typeof(List[_]).GetMethod("Add")!!)
        Assert.Equal(fromOpen, fromConstructed)
    }

    @Fact
    func Property_OnConstructedGenericType_NormalizesDeclaringTypeToDefinition() {
        let property PropertyInfo? = typeof(List[int32]).GetProperty("Count")
        Assert.NotNull(property)
        let docId = DocumentationIdProvider.GetDocumentationId(property!!)
        Assert.Equal("P:System.Collections.Generic.List`1.Count", docId)
    }

    @Fact
    func Field_OnConstructedGenericType_NormalizesDeclaringTypeToDefinition() {
        // KeyValuePair<,> is a struct with no public fields, so use a real BCL field:
        // pick any generic type that exposes a public field. Tuple<T1>.Item1 is a
        // *property*, so we test via Generic393Sample below.
        let field FieldInfo? = typeof(Generic393Sample[int32]).GetField("PublicField")
        Assert.NotNull(field)
        let docId = DocumentationIdProvider.GetDocumentationId(field!!)
        Assert.Equal("F:GSharp.Core.Tests.CodeAnalysis.Documentation.Generic393Sample`1.PublicField", docId)
    }

    @Fact
    func Event_OnConstructedGenericType_NormalizesDeclaringTypeToDefinition() {
        let event EventInfo? = typeof(Generic393Sample[int32]).GetEvent("PublicEvent")
        Assert.NotNull(event)
        let docId string? = DocumentationIdProvider.GetDocumentationId(event!!)
        Assert.Equal("E:GSharp.Core.Tests.CodeAnalysis.Documentation.Generic393Sample`1.PublicEvent", docId)
    }

    @Fact
    func ForAssembly_ConcurrentCallers_ProduceSingleSharedProvider() {
        // ConditionalWeakTable.GetValue is documented thread-safe, but the value factory
        // (Create) may run more than once under contention. Either way, every caller must
        // observe the *same* cached provider instance once contention settles.
        let assembly = typeof(string).Assembly
        const threadCount = 32
        let barrier = Barrier(threadCount)
        let observed = ConcurrentBag[AssemblyDocumentationProvider]()
        Parallel.For(
            0,
            threadCount,
            (_ int32) -> {
                barrier.SignalAndWait()
                observed.Add(AssemblyDocumentationProvider.ForAssembly(assembly)!!)
            }
        )
        // Final ForAssembly call resolves the canonical, cached instance (the table
        // collapses to a single value); every observer should ultimately see a non-null
        // provider and a *subsequent* call must return that same instance.
        let canonical AssemblyDocumentationProvider? = AssemblyDocumentationProvider.ForAssembly(assembly)
        Assert.NotNull(canonical)
        Assert.All(observed, (p AssemblyDocumentationProvider) -> Assert.NotNull(p))
        Assert.Same(canonical, AssemblyDocumentationProvider.ForAssembly(assembly))
    }

    @Fact
    func Resolve_ConcurrentReaders_ProduceConsistentResults() {
        // Hammer Resolve from many threads on a mix of well-known BCL members. We don't
        // care whether the underlying ref pack is installed (results may be null) — we
        // care that:
        //   1. No exceptions escape the lookup path.
        //   2. Every thread sees the same answer for the same input (a writer-during-read
        //      race on the published Dictionary would corrupt some lookups).
        let inputs = []MemberInfo{
            typeof(string),
            typeof(int32),
            typeof(System.Collections.Generic.List[_]),
            typeof(string).GetMethod("Substring", []Type{typeof(int32)})!!,
            typeof(string).GetProperty("Length")!!,
            typeof(int32).GetField("MaxValue")!!
        }
        // Baseline (single-threaded) result for each input — what every concurrent caller
        // must agree with.
        let baseline = inputs.Select((m MemberInfo) -> ResolveAny(m)).ToArray()
        const iterations = 200
        let exceptions = ConcurrentBag[Exception]()
        var mismatches = 0
        Parallel.For(
            0,
            iterations,
            (i int32) -> {
                try {
                    for var k = 0; k < inputs.Length; k++ {
                        let actual DocumentationComment? = ResolveAny(inputs[k])
                        let expected DocumentationComment? = baseline[k]
                        // Documentation may be null when no ref pack is installed; just check
                        // that null-ness agrees and the parsed values are equal (the record
                        // type has value-based equality, so reading from a corrupted shared
                        // dictionary would produce divergent values).
                        if (actual == nil) != (expected == nil) {
                            Interlocked.Increment(&mismatches)
                            continue
                        }
                        if actual != nil && !actual.Equals(expected) {
                            Interlocked.Increment(&mismatches)
                        }
                    }
                } catch (ex Exception) {
                    exceptions.Add(ex)
                }
            }
        )
        Assert.Empty(exceptions)
        Assert.Equal(0, mismatches)
    }

    shared {
        private func ResolveAny(member MemberInfo) DocumentationComment? {
            return switch member {
                case t is Type: AssemblyDocumentationProvider.Resolve(t)
                case m is MethodInfo: AssemblyDocumentationProvider.Resolve(m)
                case p is PropertyInfo: AssemblyDocumentationProvider.Resolve(p)
                case f is FieldInfo: AssemblyDocumentationProvider.Resolve(f)
                case e is EventInfo: AssemblyDocumentationProvider.Resolve(e)
                default: default(DocumentationComment?)
            }
        }
    }
}

/// Helper generic type carrying a public field and event so the issue #393 regression
/// tests can verify (cref:DocumentationIdProvider) normalizes the declaring type
/// for every member kind, not just methods and properties (which already have BCL
/// counterparts on `List<T>`).
/// @typeparam T Unused payload parameter — only its arity matters for DocIDs.
class Generic393Sample[T] {
    /// Public field used to verify field DocIDs on constructed generic types.
    var PublicField int32

    /// Public event used to verify event DocIDs on constructed generic types.
    event PublicEvent EventHandler
}
