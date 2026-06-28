// <copyright file="Issue1320UserElementGetEnumeratorTests.cs" company="GSharp">
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
/// Issue #1320: <c>GetEnumerator()</c> (and the <c>IEnumerable&lt;T&gt;</c>
/// member surface generally) could not be resolved on a <c>sequence[UserType]</c>
/// (an iterator return type, alias for <c>IEnumerable&lt;UserType&gt;</c>) or on
/// a user-element array <c>[]UserType</c>, while the identical call resolved on a
/// primitive element type and on an explicitly-typed <c>IEnumerable[UserType]</c>
/// / <c>List[UserType]</c>. The root cause: those receivers have a
/// <see langword="null"/> <c>ClrType</c> during binding (the element type is not
/// yet emitted), so the CLR member-lookup path dead-ended with GS0159. These
/// binder-level tests mirror the issue's repro matrix: the formerly broken
/// <c>sequence[UserType]</c> case now resolves to the generic
/// <c>IEnumerator[UserType]</c> overload, the user-element array now finds the
/// member at parity with a primitive array, and every control keeps working.
/// </summary>
public class Issue1320UserElementGetEnumeratorTests
{
    [Fact]
    public void SequenceUserElement_GetEnumerator_ResolvesGenericOverload()
    {
        // BUG line (Oahu blocker): SeqUser().GetEnumerator() must resolve to
        // IEnumerator[E] so the IEnumerator[E] return type binds.
        const string source = @"
package p
import System.Collections.Generic
struct E { var X int32 }
class C {
    func SeqUser() sequence[E] { yield E{X:1} }
    func UseSeq() IEnumerator[E] -> SeqUser().GetEnumerator()
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void SequenceClassElement_GetEnumerator_ResolvesGenericOverload()
    {
        const string source = @"
package p
import System.Collections.Generic
class Seg { public var X int32 = 0 }
class C {
    func SeqSeg() sequence[Seg] { yield Seg() }
    func UseSeq() IEnumerator[Seg] -> SeqSeg().GetEnumerator()
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void SequencePrimitiveElement_GetEnumerator_StillResolves()
    {
        // Control: the primitive sequence path is unchanged.
        const string source = @"
package p
import System.Collections.Generic
class C {
    func SeqPrim() sequence[int32] { yield 1 }
    func UsePrim() IEnumerator[int32] -> SeqPrim().GetEnumerator()
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void IEnumerableUserElement_GetEnumerator_StillResolves()
    {
        // Control: the explicitly-typed IEnumerable[E] parameter path is unchanged.
        const string source = @"
package p
import System.Collections.Generic
struct E { var X int32 }
class C {
    func FromIface(xs IEnumerable[E]) IEnumerator[E] -> xs.GetEnumerator()
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ListUserElement_GetEnumerator_StillResolves()
    {
        // Control: the explicitly-typed List[E] parameter path is unchanged.
        const string source = @"
package p
import System.Collections.Generic
struct E { var X int32 }
class C {
    func FromList(xs List[E]) IEnumerator[E] -> xs.GetEnumerator()
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void UserElementArray_GetEnumerator_FindsMemberAtPrimitiveParity()
    {
        // The user-element array now FINDS GetEnumerator (resolving the
        // non-generic IEnumerator overload), exactly like a primitive array —
        // previously GS0159 ("Cannot find function GetEnumerator"). Both the
        // user-element and primitive arrays must produce identical diagnostics.
        const string userSource = @"
package p
import System.Collections
struct E { var X int32 }
class C {
    func FromArr(xs []E) IEnumerator -> xs.GetEnumerator()
}
";
        const string primitiveSource = @"
package p
import System.Collections
class C {
    func FromArr(xs []int32) IEnumerator -> xs.GetEnumerator()
}
";
        Assert.Empty(GetDiagnostics(userSource));
        Assert.Empty(GetDiagnostics(primitiveSource));
    }

    [Fact]
    public void UserElementArray_GetEnumerator_NoLongerReportsCannotFindFunction()
    {
        // Even when forced to the generic IEnumerator[E] return (which, at
        // parity with a primitive array, the non-generic GetEnumerator cannot
        // satisfy → GS0155), the member is now FOUND: the diagnostic is a
        // conversion error, never GS0159 ("Cannot find function").
        const string userSource = @"
package p
import System.Collections.Generic
struct E { var X int32 }
class C {
    func FromArr(xs []E) IEnumerator[E] -> xs.GetEnumerator()
}
";
        const string primitiveSource = @"
package p
import System.Collections.Generic
class C {
    func FromArr(xs []int32) IEnumerator[int32] -> xs.GetEnumerator()
}
";
        var userDiags = GetDiagnostics(userSource);
        var primitiveDiags = GetDiagnostics(primitiveSource);

        // Parity: the user-element array now behaves exactly like the primitive
        // array (both GS0155), where it previously reported GS0159.
        Assert.DoesNotContain(userDiags, d => d.Id == "GS0159");
        Assert.Equal(
            primitiveDiags.Select(d => d.Id).OrderBy(id => id),
            userDiags.Select(d => d.Id).OrderBy(id => id));
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
