// <copyright file="Issue1483ReadOnlyDictionaryForRangeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1483: `for k, v in <collection>` recovered the key/value
/// types for dictionary destructuring via
/// (cref:MemberLookup.TryGetClrDictionaryTypes), which previously
/// matched ONLY `IDictionary<TKey, TValue>` by exact name. A type
/// implementing only `IReadOnlyDictionary<TKey, TValue>` (not
/// `IDictionary`) fell through to the generic-`IEnumerable` path and
/// mis-lowered as (cref:ForRangeKind.Enumerable) — binding
/// `k` to the `int32` running index and `v` to
/// `KeyValuePair<,>` instead of key/value destructuring.
///
/// The fix generalizes the probe to recognize the read-only mapping family:
/// any interface whose generic type definition is `IDictionary<,>`
/// or `IReadOnlyDictionary<,>`, preferring the writable
/// `IDictionary<,>` when both are present (two-pass probe). These
/// tests cover the reflection-level probe directly plus the binder-level
/// destructuring it drives.
open class Issue1483ReadOnlyDictionaryForRangeTests {
    // ---------------------------------------------------------------
    // Reflection-level probe: TryGetClrDictionaryTypes recognizes the
    // read-only mapping family and prefers IDictionary<,>.
    // ---------------------------------------------------------------
    @Fact
    func Probe_ReadOnlyDictionaryInterface_YieldsKeyAndValue() {
        let ok = MemberLookup.TryGetClrDictionaryTypes(
            typeof(IReadOnlyDictionary[string, int32]),
            out var keyType,
            out var valueType
        )
        Assert.True(ok)
        Assert.Equal(typeof(string), keyType)
        Assert.Equal(typeof(int32), valueType)
    }

    @Fact
    func Probe_UserTypeImplementingOnlyReadOnlyDictionary_IsRecognized() {
        // Generalization guard: a custom CLR type that implements ONLY
        // IReadOnlyDictionary<,> (no IDictionary) must be recognized — not
        // just the exact BCL IReadOnlyDictionary reference type.
        let ok = MemberLookup.TryGetClrDictionaryTypes(
            typeof(Issue1483ReadOnlyMapFixture),
            out var keyType,
            out var valueType
        )
        Assert.True(ok)
        Assert.Equal(typeof(string), keyType)
        Assert.Equal(typeof(int32), valueType)
    }

    @Fact
    func Probe_DictionaryImplementingBoth_StillUsesIDictionaryArgs() {
        // Regression: Dictionary<K, V> implements both IDictionary<K, V> and
        // IReadOnlyDictionary<K, V> (same args). Behavior must be unchanged.
        let ok = MemberLookup.TryGetClrDictionaryTypes(
            typeof(Dictionary[string, int32]),
            out var keyType,
            out var valueType
        )
        Assert.True(ok)
        Assert.Equal(typeof(string), keyType)
        Assert.Equal(typeof(int32), valueType)
    }

    @Fact
    func Probe_IDictionaryInterface_StillRecognized() {
        let ok = MemberLookup.TryGetClrDictionaryTypes(
            typeof(IDictionary[string, int32]),
            out var keyType,
            out var valueType
        )
        Assert.True(ok)
        Assert.Equal(typeof(string), keyType)
        Assert.Equal(typeof(int32), valueType)
    }

    @Fact
    func Probe_TypeImplementingBoth_PrefersWritableIDictionary() {
        // CRITICAL preference rule: when a type implements BOTH contracts the
        // writable IDictionary<,> wins. The pathological fixture below carries
        // DIFFERENT type arguments on each interface so the two-pass probe's
        // preference is observable: it must return the IDictionary<int, int>
        // arguments, never the IReadOnlyDictionary<string, string> ones.
        let ok = MemberLookup.TryGetClrDictionaryTypes(
            typeof(Issue1483DualMapFixture),
            out var keyType,
            out var valueType
        )
        Assert.True(ok)
        Assert.Equal(typeof(int32), keyType)
        Assert.Equal(typeof(int32), valueType)
    }

    @Fact
    func Probe_PlainEnumerable_IsNotADictionary() {
        let ok = MemberLookup.TryGetClrDictionaryTypes(typeof(List[int32]), out var keyType, out var valueType)
        Assert.False(ok)
        Assert.Null(keyType)
        Assert.Null(valueType)
    }

    // ---------------------------------------------------------------
    // Binder-level: `for k, v in d` destructures the read-only mapping
    // family into K/V. The body below only type-checks when k:K and v:V
    // (the Enumerable mis-binding would surface k:int32 and
    // v:KeyValuePair[K, V], failing both annotated declarations).
    // ---------------------------------------------------------------
    @Fact
    func ForRange_OverReadOnlyDictionaryInterface_Destructures_K_And_V() {
        // The issue repro: a receiver typed only as IReadOnlyDictionary[K, V].
        const source = `
package p
import System.Collections.Generic
class C {
    func dump(d IReadOnlyDictionary[string, int32]) int32 {
        for k, v in d {
            var ks string = k
            var vi int32 = v
        }
        return 0
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ForRange_OverUserReadOnlyDictionaryClrType_Destructures_K_And_V() {
        // A custom user CLR type implementing ONLY IReadOnlyDictionary<,> is
        // recognized exactly like the BCL interface.
        const source = `
package p
import GSharp.Core.Tests.CodeAnalysis.Binding
class C {
    func dump(d Issue1483ReadOnlyMapFixture) int32 {
        for k, v in d {
            var ks string = k
            var vi int32 = v
        }
        return 0
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ForRange_OverDictionary_StillDestructures_K_And_V() {
        // Regression: Dictionary[K, V] (implements both) keeps destructuring
        // into K/V via the preferred IDictionary path.
        const source = `
package p
import System.Collections.Generic
class C {
    func dump(d Dictionary[string, int32]) int32 {
        for k, v in d {
            var ks string = k
            var vi int32 = v
        }
        return 0
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    /// Thin wrapper so the test cases can call `Assert.Empty` against a
    /// (cref:ImmutableArray{T}) without exposing the GSharp diagnostic
    /// surface to xUnit's enumerable inference.
    private struct ImmutableArrayOfDiagnostic : IReadOnlyCollection[Diagnostic] {
        private let diagnostics ImmutableArray[Diagnostic]

        init(diagnostics ImmutableArray[Diagnostic]) {
            this.diagnostics = diagnostics
        }

        prop Count int32 -> this.diagnostics.Length

        func GetEnumerator() IEnumerator[Diagnostic] {
            for diagnostic in this.diagnostics {
                yield diagnostic
            }
        }

        private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
    }

    shared {
        private func GetDiagnostics(source string) Issue1483ReadOnlyDictionaryForRangeTests.ImmutableArrayOfDiagnostic {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let parseDiagnostics = tree.Diagnostics
            let bindDiagnostics = compilation.GlobalScope.Diagnostics
            let programDiagnostics = compilation.BoundProgram.Diagnostics
            let all = parseDiagnostics
                .Concat(bindDiagnostics)
                .Concat(programDiagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .ToImmutableArray()
            return Issue1483ReadOnlyDictionaryForRangeTests.ImmutableArrayOfDiagnostic(all)
        }
    }
}

/// A functional CLR fixture implementing ONLY
/// (cref:IReadOnlyDictionary{TKey, TValue}) (string -> int) and not
/// (cref:IDictionary{TKey, TValue}). Models read-only mappings such as
/// immutable dictionaries surfaced through the read-only contract.
class Issue1483ReadOnlyMapFixture : IReadOnlyDictionary[string, int32] {
    private let inner Dictionary[string, int32] = Dictionary[string, int32]{["a"] = 1, ["bb"] = 2}

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    prop Keys IEnumerable[string] -> this.inner.Keys

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    prop Values IEnumerable[int32] -> this.inner.Values

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    prop Count int32 -> this.inner.Count

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    prop this[key string]int32 -> this.inner[key]

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func ContainsKey(key string) bool -> this.inner.ContainsKey(key)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func TryGetValue(key string, out value int32) bool -> this.inner.TryGetValue(key, out value)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func GetEnumerator() IEnumerator[KeyValuePair[string, int32]] -> this.inner.GetEnumerator()

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IEnumerable) GetEnumerator() IEnumerator -> this.inner.GetEnumerator()
}

/// A pathological CLR fixture implementing BOTH
/// (cref:IDictionary{TKey, TValue}) (int -> int) and
/// (cref:IReadOnlyDictionary{TKey, TValue}) (string -> string) with
/// DIFFERENT type arguments. Used purely to assert the two-pass probe prefers
/// the writable `IDictionary<,>`; its members are never invoked.
class Issue1483DualMapFixture : IDictionary[int32, int32], IReadOnlyDictionary[string, string] {
    private prop(IReadOnlyDictionary[string, string]) this[key string]string {
        get {
            throw NotImplementedException()
        }
    }

    private prop(IDictionary[int32, int32]) this[key int32]int32 {
        get {
            throw NotImplementedException()
        }
        set {
            throw NotImplementedException()
        }
    }

    private prop(IDictionary[int32, int32]) Keys ICollection[int32] {
        get {
            throw NotImplementedException()
        }
    }

    private prop(IDictionary[int32, int32]) Values ICollection[int32] {
        get {
            throw NotImplementedException()
        }
    }

    private prop(IReadOnlyDictionary[string, string]) Keys IEnumerable[string] {
        get {
            throw NotImplementedException()
        }
    }

    private prop(IReadOnlyDictionary[string, string]) Values IEnumerable[string] {
        get {
            throw NotImplementedException()
        }
    }

    private prop(ICollection[KeyValuePair[int32, int32]]) Count int32 {
        get {
            throw NotImplementedException()
        }
    }

    private prop(IReadOnlyCollection[KeyValuePair[string, string]]) Count int32 {
        get {
            throw NotImplementedException()
        }
    }

    private prop(ICollection[KeyValuePair[int32, int32]]) IsReadOnly bool {
        get {
            throw NotImplementedException()
        }
    }

    private func (IDictionary[int32, int32]) Add(key int32, value int32) {
        throw NotImplementedException()
    }

    private func (ICollection[KeyValuePair[int32, int32]]) Add(item KeyValuePair[int32, int32]) {
        throw NotImplementedException()
    }

    private func (ICollection[KeyValuePair[int32, int32]]) Clear() {
        throw NotImplementedException()
    }

    private func (ICollection[KeyValuePair[int32, int32]]) Contains(item KeyValuePair[int32, int32]) bool {
        throw NotImplementedException()
    }

    private func (IDictionary[int32, int32]) ContainsKey(key int32) bool {
        throw NotImplementedException()
    }

    private func (IReadOnlyDictionary[string, string]) ContainsKey(key string) bool {
        throw NotImplementedException()
    }

    private func (ICollection[KeyValuePair[int32, int32]]) CopyTo(array[]KeyValuePair[int32, int32], arrayIndex int32) {
        throw NotImplementedException()
    }

    private func (IDictionary[int32, int32]) Remove(key int32) bool {
        throw NotImplementedException()
    }

    private func (ICollection[KeyValuePair[int32, int32]]) Remove(item KeyValuePair[int32, int32]) bool {
        throw NotImplementedException()
    }

    private func (IDictionary[int32, int32]) TryGetValue(key int32, out value int32) bool {
        throw NotImplementedException()
    }

    private func (IReadOnlyDictionary[string, string]) TryGetValue(key string, out value string) bool {
        throw NotImplementedException()
    }

    private func (IEnumerable[KeyValuePair[int32, int32]]) GetEnumerator() IEnumerator[KeyValuePair[int32, int32]] {
        throw NotImplementedException()
    }

    private func (IEnumerable[KeyValuePair[string, string]]) GetEnumerator() IEnumerator[KeyValuePair[string, string]] {
        throw NotImplementedException()
    }

    private func (IEnumerable) GetEnumerator() IEnumerator {
        throw NotImplementedException()
    }
}
