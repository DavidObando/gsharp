// <copyright file="Issue1483ReadOnlyDictionaryForRangeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1483: <c>for k, v in &lt;collection&gt;</c> recovered the key/value
/// types for dictionary destructuring via
/// <see cref="MemberLookup.TryGetClrDictionaryTypes"/>, which previously
/// matched ONLY <c>IDictionary&lt;TKey, TValue&gt;</c> by exact name. A type
/// implementing only <c>IReadOnlyDictionary&lt;TKey, TValue&gt;</c> (not
/// <c>IDictionary</c>) fell through to the generic-<c>IEnumerable</c> path and
/// mis-lowered as <see cref="ForRangeKind.Enumerable"/> — binding
/// <c>k</c> to the <c>int32</c> running index and <c>v</c> to
/// <c>KeyValuePair&lt;,&gt;</c> instead of key/value destructuring.
///
/// The fix generalizes the probe to recognize the read-only mapping family:
/// any interface whose generic type definition is <c>IDictionary&lt;,&gt;</c>
/// or <c>IReadOnlyDictionary&lt;,&gt;</c>, preferring the writable
/// <c>IDictionary&lt;,&gt;</c> when both are present (two-pass probe). These
/// tests cover the reflection-level probe directly plus the binder-level
/// destructuring it drives.
/// </summary>
public class Issue1483ReadOnlyDictionaryForRangeTests
{
    // ---------------------------------------------------------------
    // Reflection-level probe: TryGetClrDictionaryTypes recognizes the
    // read-only mapping family and prefers IDictionary<,>.
    // ---------------------------------------------------------------

    [Fact]
    public void Probe_ReadOnlyDictionaryInterface_YieldsKeyAndValue()
    {
        var ok = MemberLookup.TryGetClrDictionaryTypes(
            typeof(IReadOnlyDictionary<string, int>),
            out var keyType,
            out var valueType);

        Assert.True(ok);
        Assert.Equal(typeof(string), keyType);
        Assert.Equal(typeof(int), valueType);
    }

    [Fact]
    public void Probe_UserTypeImplementingOnlyReadOnlyDictionary_IsRecognized()
    {
        // Generalization guard: a custom CLR type that implements ONLY
        // IReadOnlyDictionary<,> (no IDictionary) must be recognized — not
        // just the exact BCL IReadOnlyDictionary reference type.
        var ok = MemberLookup.TryGetClrDictionaryTypes(
            typeof(Issue1483ReadOnlyMapFixture),
            out var keyType,
            out var valueType);

        Assert.True(ok);
        Assert.Equal(typeof(string), keyType);
        Assert.Equal(typeof(int), valueType);
    }

    [Fact]
    public void Probe_DictionaryImplementingBoth_StillUsesIDictionaryArgs()
    {
        // Regression: Dictionary<K, V> implements both IDictionary<K, V> and
        // IReadOnlyDictionary<K, V> (same args). Behavior must be unchanged.
        var ok = MemberLookup.TryGetClrDictionaryTypes(
            typeof(Dictionary<string, int>),
            out var keyType,
            out var valueType);

        Assert.True(ok);
        Assert.Equal(typeof(string), keyType);
        Assert.Equal(typeof(int), valueType);
    }

    [Fact]
    public void Probe_IDictionaryInterface_StillRecognized()
    {
        var ok = MemberLookup.TryGetClrDictionaryTypes(
            typeof(IDictionary<string, int>),
            out var keyType,
            out var valueType);

        Assert.True(ok);
        Assert.Equal(typeof(string), keyType);
        Assert.Equal(typeof(int), valueType);
    }

    [Fact]
    public void Probe_TypeImplementingBoth_PrefersWritableIDictionary()
    {
        // CRITICAL preference rule: when a type implements BOTH contracts the
        // writable IDictionary<,> wins. The pathological fixture below carries
        // DIFFERENT type arguments on each interface so the two-pass probe's
        // preference is observable: it must return the IDictionary<int, int>
        // arguments, never the IReadOnlyDictionary<string, string> ones.
        var ok = MemberLookup.TryGetClrDictionaryTypes(
            typeof(Issue1483DualMapFixture),
            out var keyType,
            out var valueType);

        Assert.True(ok);
        Assert.Equal(typeof(int), keyType);
        Assert.Equal(typeof(int), valueType);
    }

    [Fact]
    public void Probe_PlainEnumerable_IsNotADictionary()
    {
        var ok = MemberLookup.TryGetClrDictionaryTypes(
            typeof(List<int>),
            out var keyType,
            out var valueType);

        Assert.False(ok);
        Assert.Null(keyType);
        Assert.Null(valueType);
    }

    // ---------------------------------------------------------------
    // Binder-level: `for k, v in d` destructures the read-only mapping
    // family into K/V. The body below only type-checks when k:K and v:V
    // (the Enumerable mis-binding would surface k:int32 and
    // v:KeyValuePair[K, V], failing both annotated declarations).
    // ---------------------------------------------------------------

    [Fact]
    public void ForRange_OverReadOnlyDictionaryInterface_Destructures_K_And_V()
    {
        // The issue repro: a receiver typed only as IReadOnlyDictionary[K, V].
        const string source = @"
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
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ForRange_OverUserReadOnlyDictionaryClrType_Destructures_K_And_V()
    {
        // A custom user CLR type implementing ONLY IReadOnlyDictionary<,> is
        // recognized exactly like the BCL interface.
        const string source = @"
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
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ForRange_OverDictionary_StillDestructures_K_And_V()
    {
        // Regression: Dictionary[K, V] (implements both) keeps destructuring
        // into K/V via the preferred IDictionary path.
        const string source = @"
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
";
        Assert.Empty(GetDiagnostics(source));
    }

    private static ImmutableArrayOfDiagnostic GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var parseDiagnostics = tree.Diagnostics;
        var bindDiagnostics = compilation.GlobalScope.Diagnostics;
        var programDiagnostics = compilation.BoundProgram.Diagnostics;
        var all = parseDiagnostics
            .Concat(bindDiagnostics)
            .Concat(programDiagnostics)
            .Where(d => d.IsError)
            .ToImmutableArray();
        return new ImmutableArrayOfDiagnostic(all);
    }

    /// <summary>
    /// Thin wrapper so the test cases can call <c>Assert.Empty</c> against a
    /// <see cref="ImmutableArray{T}"/> without exposing the GSharp diagnostic
    /// surface to xUnit's enumerable inference.
    /// </summary>
    private readonly struct ImmutableArrayOfDiagnostic : IReadOnlyCollection<Diagnostic>
    {
        private readonly ImmutableArray<Diagnostic> diagnostics;

        public ImmutableArrayOfDiagnostic(ImmutableArray<Diagnostic> diagnostics)
        {
            this.diagnostics = diagnostics;
        }

        public int Count => this.diagnostics.Length;

        public IEnumerator<Diagnostic> GetEnumerator()
        {
            foreach (var diagnostic in this.diagnostics)
            {
                yield return diagnostic;
            }
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}

/// <summary>
/// A functional CLR fixture implementing ONLY
/// <see cref="IReadOnlyDictionary{TKey, TValue}"/> (string -&gt; int) and not
/// <see cref="IDictionary{TKey, TValue}"/>. Models read-only mappings such as
/// immutable dictionaries surfaced through the read-only contract.
/// </summary>
public sealed class Issue1483ReadOnlyMapFixture : IReadOnlyDictionary<string, int>
{
    private readonly Dictionary<string, int> inner = new()
    {
        ["a"] = 1,
        ["bb"] = 2,
    };

    /// <inheritdoc/>
    public IEnumerable<string> Keys => this.inner.Keys;

    /// <inheritdoc/>
    public IEnumerable<int> Values => this.inner.Values;

    /// <inheritdoc/>
    public int Count => this.inner.Count;

    /// <inheritdoc/>
    public int this[string key] => this.inner[key];

    /// <inheritdoc/>
    public bool ContainsKey(string key) => this.inner.ContainsKey(key);

    /// <inheritdoc/>
    public bool TryGetValue(string key, out int value) => this.inner.TryGetValue(key, out value);

    /// <inheritdoc/>
    public IEnumerator<KeyValuePair<string, int>> GetEnumerator() => this.inner.GetEnumerator();

    /// <inheritdoc/>
    IEnumerator IEnumerable.GetEnumerator() => this.inner.GetEnumerator();
}

/// <summary>
/// A pathological CLR fixture implementing BOTH
/// <see cref="IDictionary{TKey, TValue}"/> (int -&gt; int) and
/// <see cref="IReadOnlyDictionary{TKey, TValue}"/> (string -&gt; string) with
/// DIFFERENT type arguments. Used purely to assert the two-pass probe prefers
/// the writable <c>IDictionary&lt;,&gt;</c>; its members are never invoked.
/// </summary>
public sealed class Issue1483DualMapFixture : IDictionary<int, int>, IReadOnlyDictionary<string, string>
{
    string IReadOnlyDictionary<string, string>.this[string key] => throw new NotImplementedException();

    int IDictionary<int, int>.this[int key]
    {
        get => throw new NotImplementedException();
        set => throw new NotImplementedException();
    }

    ICollection<int> IDictionary<int, int>.Keys => throw new NotImplementedException();

    ICollection<int> IDictionary<int, int>.Values => throw new NotImplementedException();

    IEnumerable<string> IReadOnlyDictionary<string, string>.Keys => throw new NotImplementedException();

    IEnumerable<string> IReadOnlyDictionary<string, string>.Values => throw new NotImplementedException();

    int ICollection<KeyValuePair<int, int>>.Count => throw new NotImplementedException();

    int IReadOnlyCollection<KeyValuePair<string, string>>.Count => throw new NotImplementedException();

    bool ICollection<KeyValuePair<int, int>>.IsReadOnly => throw new NotImplementedException();

    void IDictionary<int, int>.Add(int key, int value) => throw new NotImplementedException();

    void ICollection<KeyValuePair<int, int>>.Add(KeyValuePair<int, int> item) => throw new NotImplementedException();

    void ICollection<KeyValuePair<int, int>>.Clear() => throw new NotImplementedException();

    bool ICollection<KeyValuePair<int, int>>.Contains(KeyValuePair<int, int> item) => throw new NotImplementedException();

    bool IDictionary<int, int>.ContainsKey(int key) => throw new NotImplementedException();

    bool IReadOnlyDictionary<string, string>.ContainsKey(string key) => throw new NotImplementedException();

    void ICollection<KeyValuePair<int, int>>.CopyTo(KeyValuePair<int, int>[] array, int arrayIndex) => throw new NotImplementedException();

    bool IDictionary<int, int>.Remove(int key) => throw new NotImplementedException();

    bool ICollection<KeyValuePair<int, int>>.Remove(KeyValuePair<int, int> item) => throw new NotImplementedException();

    bool IDictionary<int, int>.TryGetValue(int key, out int value) => throw new NotImplementedException();

    bool IReadOnlyDictionary<string, string>.TryGetValue(string key, out string value) => throw new NotImplementedException();

    IEnumerator<KeyValuePair<int, int>> IEnumerable<KeyValuePair<int, int>>.GetEnumerator() => throw new NotImplementedException();

    IEnumerator<KeyValuePair<string, string>> IEnumerable<KeyValuePair<string, string>>.GetEnumerator() => throw new NotImplementedException();

    IEnumerator IEnumerable.GetEnumerator() => throw new NotImplementedException();
}
