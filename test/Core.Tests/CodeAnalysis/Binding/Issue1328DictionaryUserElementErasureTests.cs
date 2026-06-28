// <copyright file="Issue1328DictionaryUserElementErasureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1328: enumerating a <c>Dictionary[K, V]</c> whose VALUE type
/// <c>V</c> is a same-compilation user type erased the element to
/// <c>System.Object</c> whenever the element type had to be INFERRED
/// (foreach / LINQ). Member access on the inferred element then failed
/// <c>GS0158</c> (cannot find member) and assignment failed <c>GS0155</c>
/// (cannot convert <c>object</c> to <c>V</c>). This is the
/// <c>Dictionary</c>/<c>ValueCollection</c> sibling of #1320 (which fixed the
/// same erasure for <c>sequence[T]</c> / <c>[]T</c>). The fix recovers the
/// symbolic <c>V</c> from the constructed-generic collection type
/// (<c>ValueCollection[K, V]</c>, <c>KeyCollection[K, V]</c>,
/// <c>KeyValuePair[K, V]</c>) instead of reflecting over the erased CLR
/// interface. These binder-level tests mirror the issue's repro matrix; every
/// formerly-broken inference form now binds clean, and the controls (explicit
/// element annotation, primitive value type, <c>List[E]</c>) keep working.
/// </summary>
public class Issue1328DictionaryUserElementErasureTests
{
    [Fact]
    public void ViaValues_ForIn_UserMember_Binds()
    {
        // BUG: GS0158 — `x` erased to object so `.Value` was not found.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
data class E(Value uint32) {}
class C {
    func ViaValues(d Dictionary[uint32, E]) uint32 {
        for x in d.Values { return x.Value }
        return 0
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ViaPair_ForIn_KeyValuePair_UserMember_Binds()
    {
        // BUG: GS0158 — single-var dict iteration must yield KeyValuePair[K, V]
        // whose `.Value` carries the user `V` and `.Key` the symbolic `K`.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
data class E(Value uint32) {}
class C {
    func ViaPair(d Dictionary[uint32, E]) uint32 {
        for kv in d { return kv.Key + kv.Value.Value }
        return 0
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ViaSingle_LinqTerminal_UserMember_Binds()
    {
        // BUG: GS0158 — `.Single()` return type erased to object.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
data class E(Value uint32) {}
class C {
    func ViaSingle(d Dictionary[uint32, E]) uint32 {
        let s = d.Values.Single()
        return s.Value
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ViaToList_Indexer_Assignment_Binds()
    {
        // BUG: GS0155 — `.ToList()[0]` typed as object could not convert to E.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
data class E(Value uint32) {}
class C {
    func ViaToList(d Dictionary[uint32, E]) E {
        return d.Values.ToList()[0]
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void TwoVar_ForIn_Destructures_To_UserValue_And_Key()
    {
        // The two-var form keeps destructuring into K and V; V must carry the
        // user type so `.Value` resolves.
        const string source = @"
package p
import System.Collections.Generic
data class E(Value uint32) {}
class C {
    func TwoVar(d Dictionary[uint32, E]) uint32 {
        for k, v in d { return k + v.Value }
        return 0
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void Keys_ForIn_UserKey_Member_Binds()
    {
        // `.Keys` (KeyCollection) over a user KEY type must surface the user
        // element so `.Value` resolves.
        const string source = @"
package p
import System.Collections.Generic
data class E(Value uint32) {}
class C {
    func ViaKeys(d Dictionary[E, uint32]) uint32 {
        for k in d.Keys { return k.Value }
        return 0
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void Controls_StillBind()
    {
        // Primitive value type, List[E], and explicit lambda-param annotation
        // were never broken; capture them as regression guards.
        const string primitiveValues = @"
package p
import System.Collections.Generic
import System.Linq
class C {
    func PrimValues(d Dictionary[uint32, int32]) int32 {
        for x in d.Values { return x }
        return 0
    }
}
";
        const string listSingle = @"
package p
import System.Collections.Generic
import System.Linq
data class E(Value uint32) {}
class C {
    func ListSingle(l List[E]) uint32 -> l.Single().Value
}
";
        const string selectExplicit = @"
package p
import System.Collections.Generic
import System.Linq
data class E(Value uint32) {}
class C {
    func SelectExplicit(d Dictionary[uint32, E]) uint32 -> d.Values.Select((e E) -> e.Value).First()
}
";
        Assert.Empty(GetDiagnostics(primitiveValues));
        Assert.Empty(GetDiagnostics(listSingle));
        Assert.Empty(GetDiagnostics(selectExplicit));
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

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator()
        {
            return GetEnumerator();
        }
    }
}
