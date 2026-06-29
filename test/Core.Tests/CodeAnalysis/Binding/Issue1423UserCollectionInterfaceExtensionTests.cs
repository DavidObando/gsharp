// <copyright file="Issue1423UserCollectionInterfaceExtensionTests.cs" company="GSharp">
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
/// Issue #1423: LINQ extension methods (<c>OrderBy</c>, <c>Where</c>,
/// <c>Select</c>, …) resolve on a concrete <c>List[T]</c> but failed
/// <c>GS0159</c> on a user-defined class that implements a generic collection
/// interface such as <c>IReadOnlyCollection[T]</c> (which extends
/// <c>IEnumerable[T]</c>). They should bind via the inherited base interface
/// <c>IEnumerable[TSource]</c>.
/// <para>
/// Root cause: a user class with no imported base class erased to
/// <c>System.Object</c> for the extension-call receiver slot, so the
/// <c>this IEnumerable&lt;TSource&gt;</c> self-parameter could not match and
/// <c>TSource</c> could not be inferred. The fix projects the receiver to the
/// most-derived implemented CLR collection interface so overload resolution
/// recovers the element type.
/// </para>
/// </summary>
public class Issue1423UserCollectionInterfaceExtensionTests
{
    [Fact]
    public void OrderBy_OnUserReadOnlyCollection_Binds()
    {
        // BUG: GS0159 — `.OrderBy` self-param `IEnumerable<TSource>` unmatched
        // because EntryList erased to System.Object.
        const string source = @"
package p
import System.Collections
import System.Collections.Generic
import System.Linq
class Entry { prop Off int64 }
class EntryList : IReadOnlyCollection[Entry] {
    prop Count int32 -> 0
    func GetEnumerator() IEnumerator[Entry] -> List[Entry]().GetEnumerator()
    private func GetEnumerator() IEnumerator -> GetEnumerator()
}
class C {
    func F(e EntryList) {
        let c = e.OrderBy((s Entry) -> s.Off).ToList()
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void Where_Select_Count_OnUserReadOnlyCollection_Bind()
    {
        const string source = @"
package p
import System.Collections
import System.Collections.Generic
import System.Linq
class Entry { prop Off int64 }
class EntryList : IReadOnlyCollection[Entry] {
    prop Count int32 -> 0
    func GetEnumerator() IEnumerator[Entry] -> List[Entry]().GetEnumerator()
    private func GetEnumerator() IEnumerator -> GetEnumerator()
}
class C {
    func F(e EntryList) {
        let a = e.Where((s Entry) -> s.Off > 0).ToList()
        let b = e.Select((s Entry) -> s.Off).ToList()
        let n = e.Count((s Entry) -> s.Off > 0)
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void Select_OnUserDirectEnumerable_Binds()
    {
        // A class implementing IEnumerable[T] directly must keep working.
        const string source = @"
package p
import System.Collections
import System.Collections.Generic
import System.Linq
class Entry { prop Off int64 }
class DirectList : IEnumerable[Entry] {
    func GetEnumerator() IEnumerator[Entry] -> List[Entry]().GetEnumerator()
    private func GetEnumerator() IEnumerator -> GetEnumerator()
}
class C {
    func G(d DirectList) {
        let a = d.Select((s Entry) -> s.Off).ToList()
        let b = d.Where((s Entry) -> s.Off > 0).ToList()
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void OrderBy_OnConcreteList_StillBinds()
    {
        // Control: the concrete List[T] receiver path was never broken.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
class C {
    func F(xs List[int32]) {
        let c = xs.OrderBy((s int32) -> s).ToList()
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

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator()
        {
            return GetEnumerator();
        }
    }
}
