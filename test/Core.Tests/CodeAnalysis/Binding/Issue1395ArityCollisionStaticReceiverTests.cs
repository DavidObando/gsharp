// <copyright file="Issue1395ArityCollisionStaticReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1395: when a non-generic (arity-0) type and a generic type share the
/// same simple name (arity overloading, e.g. <c>Box</c> and <c>Box[T]</c>,
/// mirroring BCL <c>Task</c>/<c>Task&lt;T&gt;</c>), a generic static
/// member-access receiver <c>Name[TypeArg].StaticMember(...)</c> must resolve
/// the receiver to the arity-N generic type — selected by the supplied
/// type-argument count — rather than the arity-0 type. Before the fix the
/// arity-unaware type lookup preferred the non-generic type, so the generic
/// type's static member could not be found (GS0125 / GS0159). This is the
/// arity-collision counterpart to #1323 (generic static receiver binding) and
/// #1379 (return-type substitution), both of which assumed a single same-name
/// type.
/// </summary>
public class Issue1395ArityCollisionStaticReceiverTests
{
    [Fact]
    public void ReproB_MinimalArityCollision_BindsWithoutDiagnostics()
    {
        const string source = @"
package p
class Box { shared { func Make() Box -> Box() } }
class Box[T] { let v T?  shared { func Make(v T) Box[T] -> Box[T]() } }
class C { func F() Box[int32] { return Box[int32].Make(5) } }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ReproA_ArityCollisionWithInheritance_BindsWithoutDiagnostics()
    {
        const string source = @"
package p
import System.Threading
import System.Threading.Tasks

class Mp4File {}
class ChapterInfo {}

open class Op {
    protected init(mp4File Mp4File?) {}
    shared { func FromCompleted(mp4File Mp4File?) Op -> Op(mp4File) }
}

open class Op[TOutput] : Op {
    init(mp4File Mp4File, result TOutput) : base(mp4File) {}
    shared { func FromCompleted(mp4File Mp4File, result TOutput) Op[TOutput] -> Op[TOutput](mp4File, result) }
}

class Caller {
    func Get() Op[ChapterInfo?] {
        return Op[ChapterInfo?].FromCompleted(Mp4File(), nil)
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void NullableTypeArg_ArityCollision_BindsWithoutDiagnostics()
    {
        const string source = @"
package p
class Box { shared { func Make() Box -> Box() } }
class Box[T] { let v T?  shared { func Make(v T) Box[T] -> Box[T]() } }
class C { func F() Box[int32?] { return Box[int32?].Make(5) } }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void NonGenericSameNameStaticCall_StillBindsWithoutDiagnostics()
    {
        const string source = @"
package p
class Box { shared { func Make() Box -> Box() } }
class Box[T] { let v T?  shared { func Make(v T) Box[T] -> Box[T]() } }
class C { func F() Box { return Box.Make() } }
";
        Assert.Empty(GetDiagnostics(source));
    }

    private static IReadOnlyList<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree) { IsLibrary = true };
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return result.Diagnostics;
    }
}
