// <copyright file="Issue1535NullCompareReferenceTypesBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1535. The binder rejected <c>== nil</c> / <c>!= nil</c> for several
/// reference-typed shapes (arrays / slices, user classes, user and imported
/// interfaces, <c>object</c>, imported reference types) with <c>GS0129</c>,
/// even though it already accepted the comparison for nullable wrappers,
/// function types, delegates, and sequences (issue #796). C# permits
/// <c>x == null</c> for any reference or array type.
/// <para>
/// The fix extends <c>BoundBinaryOperator.IsNullCompare</c> to accept any
/// reference-shaped type: the structural shapes plus any type whose CLR
/// representation is a managed reference (<c>ClrType.IsValueType == false</c>).
/// Value types (<c>int32</c>, user <c>struct</c>, <c>DateTime</c>, enums) still
/// carry a value CLR type and continue to report <c>GS0129</c> — the negative
/// controls below lock that in.
/// </para>
/// </summary>
public class Issue1535NullCompareReferenceTypesBinderTests
{
    [Fact]
    public void Object_Vs_Nil_Equality_Binds()
    {
        const string source = @"
package P

func A(o object) bool {
    return o == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void Object_Vs_Nil_Inequality_Binds()
    {
        const string source = @"
package P

func A(o object) bool {
    return o != nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void Slice_Vs_Nil_Equality_Binds()
    {
        const string source = @"
package P

func B(b []uint8) bool {
    return b == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void NullableElementSlice_Vs_Nil_Equality_Binds()
    {
        // `[]int32?` is array-of-nullable-element, NOT a nullable wrapper, so
        // it is not caught by the NullableTypeSymbol arm — it must bind via the
        // reference-type arm.
        const string source = @"
package P

func B(b []int32?) bool {
    return b == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void ImportedInterface_Vs_Nil_Equality_Binds()
    {
        const string source = @"
package P
import System.Collections.Generic

func C(e IEnumerable[int32]) bool {
    return e == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void UserClass_Vs_Nil_Equality_Binds()
    {
        const string source = @"
package P

class K { }

func D(k K) bool {
    return k == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void UserClass_Vs_Nil_Inequality_Binds()
    {
        const string source = @"
package P

class K { }

func D(k K) bool {
    return k != nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void UserInterface_Vs_Nil_Equality_Binds()
    {
        const string source = @"
package P

interface IShape { }

func D(s IShape) bool {
    return s == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void Nil_Vs_UserClass_Symmetric_Binds()
    {
        const string source = @"
package P

class K { }

func D(k K) bool {
    return nil == k
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void ImportedReferenceType_Vs_Nil_Equality_Binds()
    {
        const string source = @"
package P
import System.Threading

func E(c SynchronizationContext) bool {
    return c == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void Int32_Vs_Nil_Still_Reports_GS0129()
    {
        // Negative control: a non-nullable value type must STILL reject
        // `== nil`. Only `int32?` (NullableTypeSymbol) compares to nil.
        const string source = @"
package P

func Neg(i int32) bool {
    return i == nil
}
";
        Assert.Contains(GetErrors(source), d => d.Message.Contains("'=='") && d.Message.Contains("nil"));
    }

    [Fact]
    public void UserStruct_Vs_Nil_Still_Reports_GS0129()
    {
        // Negative control: a non-class user struct is a value type.
        const string source = @"
package P

struct S { var x int32 }

func Neg(s S) bool {
    return s == nil
}
";
        Assert.Contains(GetErrors(source), d => d.Message.Contains("'=='") && d.Message.Contains("nil"));
    }

    [Fact]
    public void ImportedValueType_Vs_Nil_Still_Reports_GS0129()
    {
        // Negative control: an imported value type (System.DateTime) must not
        // be treated as a reference type.
        const string source = @"
package P
import System

func Neg(d DateTime) bool {
    return d == nil
}
";
        Assert.Contains(GetErrors(source), d => d.Message.Contains("'=='") && d.Message.Contains("nil"));
    }

    private static ImmutableArray<Diagnostic> GetErrors(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree) { IsLibrary = true };
        var parseDiagnostics = tree.Diagnostics;
        var bindDiagnostics = compilation.GlobalScope.Diagnostics;
        var programDiagnostics = compilation.BoundProgram.Diagnostics;
        return parseDiagnostics
            .Concat(bindDiagnostics)
            .Concat(programDiagnostics)
            .Where(d => d.IsError)
            .ToImmutableArray();
    }
}
