// <copyright file="Issue1325StructConstraintTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1325: a generic method with a <c>where T : struct</c>
/// (non-nullable value type) constraint — such as
/// <see cref="System.Runtime.InteropServices.MemoryMarshal"/>'s
/// <c>Cast&lt;TFrom, TTo&gt;</c> and <c>AsBytes&lt;T&gt;</c> — must resolve
/// when the supplied type argument is a SAME-COMPILATION user-defined struct.
/// <para>
/// Such a user struct carries no reference-context CLR type during binding and
/// is erased to a <c>System.Object</c> placeholder in the constraint check's
/// CLR type-argument vector, so the naive <c>arg.IsValueType</c> test reported
/// <see langword="false"/> and the candidate was wrongly filtered out, failing
/// the whole call with <c>GS0159</c>. The fix threads the recovered symbolic
/// type-argument vector into the constraint check so a user struct/enum is
/// recognized as a non-nullable value type — while a user CLASS and a
/// nullable value type are still correctly rejected.
/// </para>
/// </summary>
public class Issue1325StructConstraintTests
{
    [Fact]
    public void UserStruct_SatisfiesStructConstraint_MemoryMarshalCast_NoDiagnostics()
    {
        const string source = @"
package p
import System.Runtime.InteropServices

struct E { var a int32 }

class C {
    func DoCast(s Span[E]) Span[uint32] { return MemoryMarshal.Cast[E, uint32](s) }
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void UserStruct_SatisfiesStructConstraint_MemoryMarshalAsBytes_NoDiagnostics()
    {
        // AsBytes infers T = E from the Span[E] argument (no explicit `[...]`).
        const string source = @"
package p
import System.Runtime.InteropServices

struct E { var a int32 }

class C {
    func DoBytes(s Span[E]) Span[uint8] { return MemoryMarshal.AsBytes(s) }
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void PrimitiveValueType_StillSatisfiesStructConstraint_NoDiagnostics()
    {
        // Control: the primitive value-type path must keep resolving unchanged.
        const string source = @"
package p
import System.Runtime.InteropServices

class C {
    func DoCast(s Span[uint8]) Span[uint32] { return MemoryMarshal.Cast[uint8, uint32](s) }
    func DoBytes(s Span[int32]) Span[uint8] { return MemoryMarshal.AsBytes(s) }
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void UserClass_DoesNotSatisfyStructConstraint_ReportsGS0159()
    {
        // A user CLASS is a reference type and must NOT satisfy `where T : struct`,
        // so the MemoryMarshal.Cast candidate is correctly filtered out (GS0159).
        const string source = @"
package p
import System.Runtime.InteropServices

class K { var a int32 }

class C {
    func DoCast(s Span[K]) Span[uint32] { return MemoryMarshal.Cast[K, uint32](s) }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0159");
    }

    [Fact]
    public void NullableValueType_DoesNotSatisfyStructConstraint_ReportsGS0159()
    {
        // A nullable value type (Nullable<int32>) is a value type but IS nullable,
        // so `where T : struct` (non-nullable value type) must still reject it.
        const string source = @"
package p
import System.Runtime.InteropServices

class C {
    func DoCast(s Span[int32?]) Span[uint32] { return MemoryMarshal.Cast[int32?, uint32](s) }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0159");
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = Binder.BindProgram(compilation.GlobalScope, compilation.References);
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .ToList();
    }
}
