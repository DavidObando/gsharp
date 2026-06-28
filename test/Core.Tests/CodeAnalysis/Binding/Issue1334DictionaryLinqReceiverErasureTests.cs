// <copyright file="Issue1334DictionaryLinqReceiverErasureTests.cs" company="GSharp">
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
/// Issue #1334 (follow-up to #1328): when a <c>Dictionary[K, V].Values</c> /
/// <c>.Keys</c> collection over a same-compilation user element <c>V</c> / <c>K</c>
/// is used as the RECEIVER of a LINQ operator (<c>.Select</c>, <c>.Where</c>,
/// <c>.OrderBy</c>, …), the projected/result element type erased to
/// <c>System.Object</c>. A subsequent member access on the loop / chain variable
/// then failed <c>GS0159</c> (cannot find function) or <c>GS0158</c> even though
/// the source element type is the symbolic user type and the lambda is
/// explicitly annotated.
/// <para>
/// Root cause: the LINQ overload's generic inference reflected over the receiver's
/// type-erased CLR <c>IEnumerable&lt;object&gt;</c> shape and inferred
/// <c>TSource = object</c>, which poisoned the projection result <c>TResult</c> to
/// <c>object</c>. The fix unifies the arrow/lambda argument
/// (<c>FunctionTypeSymbol</c>) against the open delegate formal
/// (<c>Func&lt;TSource, TResult&gt;</c>) during symbolic method-type-argument
/// inference, so <c>TResult</c> recovers the same-compilation user type from the
/// lambda's symbolic return while the receiver supplies <c>TSource</c>.
/// </para>
/// <para>
/// These binder-level tests mirror the issue's repro matrix; every formerly-broken
/// LINQ-receiver form now binds clean. Controls (projection to a primitive, a
/// <c>List[E]</c> receiver, and the direct non-LINQ enumeration) keep working.
/// </para>
/// </summary>
public class Issue1334DictionaryLinqReceiverErasureTests
{
    [Fact]
    public void ValuesSelect_ProjectsUserType_ForIn_UserMember_Binds()
    {
        // BUG: GS0159 — `.Select` projection result erased to object so the
        // loop variable lost the user `Filter` identity and `.Go()` was not found.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
class Filter { func Go() {} }
class Entry { prop FirstFilter Filter -> Filter() }
class C {
    func ViaSelect(d Dictionary[uint32, Entry]) {
        for f in d.Values.Select((e Entry) -> e.FirstFilter) { f.Go() }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ValuesWhere_ForIn_UserMember_Binds()
    {
        // BUG: GS0159/GS0158 — `.Where` result element erased to object.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
class Filter { func Go() {} }
class Entry { prop FirstFilter Filter -> Filter() }
class C {
    func ViaWhere(d Dictionary[uint32, Entry]) {
        for e in d.Values.Where((x Entry) -> true) { e.FirstFilter.Go() }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ValuesWhereThenSelect_Chained_ForIn_UserMember_Binds()
    {
        // BUG: GS0159 — the chained `.Where(...).Select(...)` projection result
        // erased to object across both operators.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
class Filter { func Go() {} }
class Entry { prop FirstFilter Filter -> Filter() }
class C {
    func Chained(d Dictionary[uint32, Entry]) {
        for f in d.Values.Where((x Entry) -> true).Select((e Entry) -> e.FirstFilter) { f.Go() }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ValuesSelect_ThenLinqTerminal_UserMember_Binds()
    {
        // BUG: GS0159 — `.Select(...).First()` terminal returned object.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
class Filter { func Go() {} }
class Entry { prop FirstFilter Filter -> Filter() }
class C {
    func SelectFirst(d Dictionary[uint32, Entry]) {
        d.Values.Select((e Entry) -> e.FirstFilter).First().Go()
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ValuesSelect_OrderBy_ForIn_UserMember_Binds()
    {
        // BUG: GS0159 — `.OrderBy` on a user-projected sequence erased the
        // ordered element to object.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
class Filter { prop Tag uint32 -> 0 func Go() {} }
class Entry { prop FirstFilter Filter -> Filter() }
class C {
    func ViaOrderBy(d Dictionary[uint32, Entry]) {
        for f in d.Values.Select((e Entry) -> e.FirstFilter).OrderBy((g Filter) -> g.Tag) { f.Go() }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void KeysSelect_ProjectsUserType_ForIn_UserMember_Binds()
    {
        // BUG: GS0159 — `.Keys` receiver erased the user key element through
        // the `.Select` projection.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
class Filter { func Go() {} }
class Entry { prop FirstFilter Filter -> Filter() }
class C {
    func ViaKeys(d Dictionary[Entry, uint32]) {
        for f in d.Keys.Select((e Entry) -> e.FirstFilter) { f.Go() }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ListSelect_ProjectsUserType_ForIn_UserMember_Binds()
    {
        // Sibling: a plain List[Entry] LINQ receiver projecting to a user type
        // shares the same recovery path.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
class Filter { func Go() {} }
class Entry { prop FirstFilter Filter -> Filter() }
class C {
    func ViaList(items List[Entry]) {
        for f in items.Select((e Entry) -> e.FirstFilter) { f.Go() }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void Controls_PrimitiveProjection_And_DirectEnumeration_Bind()
    {
        // Control 1: projecting to a primitive still binds (closed-CLR path).
        const string primitiveProjection = @"
package p
import System.Collections.Generic
import System.Linq
data class E(Value uint32) {}
class C {
    func SelectPrimitive(d Dictionary[uint32, E]) uint32 -> d.Values.Select((e E) -> e.Value).First()
}
";

        // Control 2: direct (non-LINQ) enumeration of the user values keeps
        // working (#1328).
        const string directEnumeration = @"
package p
import System.Collections.Generic
import System.Linq
data class E(Value uint32) {}
class C {
    func Direct(d Dictionary[uint32, E]) uint32 {
        for x in d.Values { return x.Value }
        return 0
    }
}
";
        Assert.Empty(GetDiagnostics(primitiveProjection));
        Assert.Empty(GetDiagnostics(directEnumeration));
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
