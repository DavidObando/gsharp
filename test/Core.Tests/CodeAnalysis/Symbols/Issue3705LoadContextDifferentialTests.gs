// <copyright file="Issue3705LoadContextDifferentialTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections
import System.Collections.Generic
import System.IO
import System.Linq
import System.Runtime.InteropServices
import System.Text
import Xunit

/// Issue #3705, family 3 — the load-context family — and #3705's prevention
/// option (3), the differential gate, applied to it.
///
/// `gsc` creates one (cref:System.Reflection.MetadataLoadContext)
/// per compilation and never normalises the (cref:Type)s it hands back
/// to host `RuntimeType`s. Every type-shape query the binder, lowerer and
/// emitter ask therefore has two possible operands for the same logical CLR
/// type, and the answer must not depend on which one it gets. That is the
/// whole invariant, and — exactly as with
/// `Issue3705MemberKindAccessibilityDifferentialTests` — the load context
/// never appears on the right-hand side of the expectation: each row states
/// one answer, and it is asserted for both contexts.
///
/// A silently-wrong site in this family is worse than an imprecise one: a
/// `typeof(X).IsAssignableFrom(importedType)` is unconditionally
/// `false`, so the compiler takes the wrong arm without
/// diagnosing anything (#3708 emitted no `Dispose`; the
/// `typeof(Delegate)` arm of #3697 dropped every event-handler
/// candidate). (cref:NaiveIsAssignableFrom_IsSilentlyWrong_AcrossContexts)
/// pins that hazard directly, and doubles as proof that this fixture's MLC
/// really is a distinct reflection context rather than the host handing back
/// its own types.
open class Issue3705LoadContextDifferentialTests {
    /// The compiler queries in this family. Each is a "what shape is this CLR
    /// type?" question asked from `Binding/`, `Lowering/` or
    /// `Emit/` about a type that can have come from either context.
    enum Query {
        SatisfiesIDisposable,
        SatisfiesIEnumerable,
        SatisfiesIList,
        SatisfiesIDictionary,
        SatisfiesObject,
        IsDelegate,
        EnumerableElement,
        DelegateSignature
    }

    /// The invariant: the answer is a property of the logical CLR type, not of
    /// the reflection context the (cref:Type) was materialised in.
    /// @param hostTypeName Assembly-qualified name of the host type under test.
    /// @param query The compiler query to ask.
    /// @param expected The single expected answer, for both contexts.
    @Theory
    @MemberData("Rows")
    func SameAnswer_ForRuntimeType_AndMetadataLoadContextTwin(
        hostTypeName string,
        query Issue3705LoadContextDifferentialTests.Query,
        expected string
    ) {
        let hostType = Type.GetType(hostTypeName, throwOnError: true)!!
        using let resolver = CreateMetadataLoadContextResolver()
        let mlcType Type? = resolver.MapClrTypeToReferences(hostType)
        Assert.True(mlcType != nil, "no MetadataLoadContext twin for '${hostType.FullName}'")
        Assert.False(
            object.ReferenceEquals(hostType, mlcType),
            "'${hostType.FullName}' resolved to the host type — the fixture is not exercising two contexts"
        )
        let hostAnswer = Ask(query, hostType)
        let mlcAnswer = Ask(query, mlcType!!)
        Assert.Equal(expected, hostAnswer)
        Assert.Equal(expected, mlcAnswer)
    }

    /// The hazard this family exists for, pinned directly: a host
    /// `typeof(X).IsAssignableFrom(y)` is not merely imprecise for a
    /// MetadataLoadContext `y` — it is silently, unconditionally
    /// `false`. This is why every such site had to move behind
    /// (cref:ClrLoadContext), and why the guard-rail test forbids new
    /// ones.
    @Fact
    func NaiveIsAssignableFrom_IsSilentlyWrong_AcrossContexts() {
        using let resolver = CreateMetadataLoadContextResolver()
        let mlcArrayList = resolver.MapClrTypeToReferences(typeof(ArrayList))
        let mlcEnumerator = resolver.MapClrTypeToReferences(typeof(List[int32].Enumerator))
        Assert.NotNull(mlcArrayList)
        Assert.NotNull(mlcEnumerator)
        // What the sites did before #3705: false, with no diagnostic.
        Assert.False(typeof(IEnumerable).IsAssignableFrom(mlcArrayList))
        Assert.False(typeof(IDisposable).IsAssignableFrom(mlcEnumerator))
        // The same questions asked in the host context: true.
        Assert.True(typeof(IEnumerable).IsAssignableFrom(typeof(ArrayList)))
        Assert.True(typeof(IDisposable).IsAssignableFrom(typeof(List[int32].Enumerator)))
        // Through the funnel: true in both.
        Assert.True(ClrLoadContext.Satisfies(mlcArrayList, typeof(IEnumerable)))
        Assert.True(ClrLoadContext.Satisfies(mlcEnumerator, typeof(IDisposable)))
    }

    shared {
        /// The differential table. Every row is `(host type, query, the one
        /// answer)`; the reflection context is deliberately absent from the
        /// expectation.
        /// @returns The xUnit member-data rows.
        func Rows() TheoryData[string, Issue3705LoadContextDifferentialTests.Query, string] {
            let data = TheoryData[string, Issue3705LoadContextDifferentialTests.Query, string]()
            let Add = func (hostType Type, query Issue3705LoadContextDifferentialTests.Query, expected string) {
                data.Add(hostType.AssemblyQualifiedName!!, query, expected)
            }
            // --- IDisposable: #3708's predicate. The `for x in imported` disposal
            // arm read `typeof(IDisposable).IsAssignableFrom(clrType)`.
            Add(
                typeof(List[int32].Enumerator),
                Issue3705LoadContextDifferentialTests.Query.SatisfiesIDisposable,
                "True"
            )
            Add(typeof(MemoryStream), Issue3705LoadContextDifferentialTests.Query.SatisfiesIDisposable, "True")
            Add(typeof(IEnumerator[int32]), Issue3705LoadContextDifferentialTests.Query.SatisfiesIDisposable, "True")
            Add(typeof(IDisposable), Issue3705LoadContextDifferentialTests.Query.SatisfiesIDisposable, "True")
            Add(typeof(StringBuilder), Issue3705LoadContextDifferentialTests.Query.SatisfiesIDisposable, "False")
            Add(typeof(int32), Issue3705LoadContextDifferentialTests.Query.SatisfiesIDisposable, "False")
            // --- Non-generic IEnumerable: MemberLookup's fallback arm.
            Add(typeof(ArrayList), Issue3705LoadContextDifferentialTests.Query.SatisfiesIEnumerable, "True")
            Add(typeof(Hashtable), Issue3705LoadContextDifferentialTests.Query.SatisfiesIEnumerable, "True")
            Add(typeof(string), Issue3705LoadContextDifferentialTests.Query.SatisfiesIEnumerable, "True")
            Add(typeof(List[int32]), Issue3705LoadContextDifferentialTests.Query.SatisfiesIEnumerable, "True")
            Add(typeof([]int32), Issue3705LoadContextDifferentialTests.Query.SatisfiesIEnumerable, "True")
            Add(typeof(StringBuilder), Issue3705LoadContextDifferentialTests.Query.SatisfiesIEnumerable, "False")
            // --- IList / IDictionary: emit's #313 erased-generic indexer erasure.
            Add(typeof(List[object]), Issue3705LoadContextDifferentialTests.Query.SatisfiesIList, "True")
            Add(typeof(ArrayList), Issue3705LoadContextDifferentialTests.Query.SatisfiesIList, "True")
            Add(typeof(Dictionary[string, object]), Issue3705LoadContextDifferentialTests.Query.SatisfiesIList, "False")
            Add(
                typeof(Dictionary[string, object]),
                Issue3705LoadContextDifferentialTests.Query.SatisfiesIDictionary,
                "True"
            )
            Add(typeof(Hashtable), Issue3705LoadContextDifferentialTests.Query.SatisfiesIDictionary, "True")
            Add(typeof(List[object]), Issue3705LoadContextDifferentialTests.Query.SatisfiesIDictionary, "False")
            // --- The universal arm. Interfaces have a null BaseType, so a bare
            // base-chain walk misses them; value types reach object by boxing.
            Add(typeof(StringBuilder), Issue3705LoadContextDifferentialTests.Query.SatisfiesObject, "True")
            Add(typeof(IDisposable), Issue3705LoadContextDifferentialTests.Query.SatisfiesObject, "True")
            Add(typeof(int32), Issue3705LoadContextDifferentialTests.Query.SatisfiesObject, "True")
            Add(typeof(object), Issue3705LoadContextDifferentialTests.Query.SatisfiesObject, "True")
            // --- Delegate-ness: #3697's `typeof(Delegate).IsAssignableFrom` arm.
            Add(typeof(() -> void), Issue3705LoadContextDifferentialTests.Query.IsDelegate, "True")
            Add(typeof((int32) -> void), Issue3705LoadContextDifferentialTests.Query.IsDelegate, "True")
            Add(typeof((int32) -> string), Issue3705LoadContextDifferentialTests.Query.IsDelegate, "True")
            Add(typeof(Predicate[string]), Issue3705LoadContextDifferentialTests.Query.IsDelegate, "True")
            Add(typeof(EventHandler), Issue3705LoadContextDifferentialTests.Query.IsDelegate, "True")
            Add(typeof(Comparison[int32]), Issue3705LoadContextDifferentialTests.Query.IsDelegate, "True")
            Add(typeof(Delegate), Issue3705LoadContextDifferentialTests.Query.IsDelegate, "True")
            Add(typeof(StringBuilder), Issue3705LoadContextDifferentialTests.Query.IsDelegate, "False")
            Add(typeof(IDisposable), Issue3705LoadContextDifferentialTests.Query.IsDelegate, "False")
            // --- The `for x in …` element type. The generic arm walks the
            // interface closure by FullName (#2859); the non-generic fallback did
            // not, until #3705.
            Add(typeof(List[string]), Issue3705LoadContextDifferentialTests.Query.EnumerableElement, "System.String")
            Add(typeof([]int32), Issue3705LoadContextDifferentialTests.Query.EnumerableElement, "System.Int32")
            Add(
                typeof(IReadOnlyCollection[int32]),
                Issue3705LoadContextDifferentialTests.Query.EnumerableElement,
                "System.Int32"
            )
            Add(typeof(ArrayList), Issue3705LoadContextDifferentialTests.Query.EnumerableElement, "System.Object")
            Add(typeof(Hashtable), Issue3705LoadContextDifferentialTests.Query.EnumerableElement, "System.Object")
            Add(typeof(StringBuilder), Issue3705LoadContextDifferentialTests.Query.EnumerableElement, "<none>")
            // --- Delegate signature decomposition.
            Add(typeof(() -> void), Issue3705LoadContextDifferentialTests.Query.DelegateSignature, "() -> System.Void")
            Add(
                typeof((int32) -> void),
                Issue3705LoadContextDifferentialTests.Query.DelegateSignature,
                "(System.Int32) -> System.Void"
            )
            Add(
                typeof((int32) -> string),
                Issue3705LoadContextDifferentialTests.Query.DelegateSignature,
                "(System.Int32) -> System.String"
            )
            Add(
                typeof(Predicate[string]),
                Issue3705LoadContextDifferentialTests.Query.DelegateSignature,
                "(System.String) -> System.Boolean"
            )
            Add(
                typeof(Comparison[int32]),
                Issue3705LoadContextDifferentialTests.Query.DelegateSignature,
                "(System.Int32, System.Int32) -> System.Int32"
            )
            Add(
                typeof(EventHandler),
                Issue3705LoadContextDifferentialTests.Query.DelegateSignature,
                "(System.Object, System.EventArgs) -> System.Void"
            )
            return data
        }

        private func Ask(query Issue3705LoadContextDifferentialTests.Query, type Type?) string -> switch query {
            case Issue3705LoadContextDifferentialTests.Query.SatisfiesIDisposable: ClrLoadContext.Satisfies(
                type,
                typeof(IDisposable)
            )
                .ToString()
            case Issue3705LoadContextDifferentialTests.Query.SatisfiesIEnumerable: ClrLoadContext.Satisfies(
                type,
                typeof(IEnumerable)
            )
                .ToString()
            case Issue3705LoadContextDifferentialTests.Query.SatisfiesIList: ClrLoadContext.Satisfies(
                type,
                typeof(IList)
            )
                .ToString()
            case Issue3705LoadContextDifferentialTests.Query.SatisfiesIDictionary: ClrLoadContext.Satisfies(
                type,
                typeof(IDictionary)
            )
                .ToString()
            case Issue3705LoadContextDifferentialTests.Query.SatisfiesObject: ClrLoadContext.Satisfies(
                type,
                typeof(object)
            )
                .ToString()
            case Issue3705LoadContextDifferentialTests.Query.IsDelegate: ClrTypeUtilities.IsDelegateType(type)
                .ToString()
            case Issue3705LoadContextDifferentialTests
                .Query
                .EnumerableElement: if MemberLookup.TryGetClrEnumerableElementType(type!!, out var element) {
                element.FullName ?? element.Name
            } else {
                "<none>"
            }
            case Issue3705LoadContextDifferentialTests
                .Query
                .DelegateSignature: if ClrLoadContext
                .TryGetDelegateSignature(type, out var ps, out var ret) {
                "(" + string.Join(", ", ps.Select((p Type) -> p.FullName ?? p.Name)) +
                    ") -> " +
                    (ret.FullName ?? ret.Name)
            } else {
                "<none>"
            }
            default: throw ArgumentOutOfRangeException("query")
        }

        /// Builds the reference-assembly-backed resolver `gsc` uses on every
        /// real `/reference:` compile — the same construction
        /// `Issue2348NotNullWhenMetadataLoadContextTests` relies on.
        /// @returns A MetadataLoadContext-backed resolver.
        private func CreateMetadataLoadContextResolver() ReferenceResolver {
            let runtimeDir = RuntimeEnvironment.GetRuntimeDirectory()
            let refPaths = Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            return ReferenceResolver.WithReferences(refPaths)
        }
    }
}
