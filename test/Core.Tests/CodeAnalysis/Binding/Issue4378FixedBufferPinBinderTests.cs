// <copyright file="Issue4378FixedBufferPinBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4378 / ADR-0125 amendment: binder coverage for a <c>fixed</c>
/// statement whose source is a fixed-size buffer field (ADR-0122 §10). The
/// accept/reject rules follow C#'s movable/fixed variable classification:
/// a buffer reached through a movable variable (struct <c>this</c>, a
/// <c>ref</c> parameter, a class field, an array element) is pinnable; one
/// reached through an already-fixed variable (a local, a by-value parameter,
/// a pointer dereference) is rejected with GS0507 (C# CS0213); a buffer of a
/// value that is not a variable, or a pointee mismatch, is GS0401 (C# CS1708 /
/// CS0266). Also covers the bare-name decay of issue #4377.
/// </summary>
public class Issue4378FixedBufferPinBinderTests
{
    private const string Prelude = @"
package P
import System

unsafe struct Bone {
    fixed Name [32]int8
    var Parent int32
}

unsafe struct Wrap {
    var B Bone
}

unsafe class Holder {
    var B Bone
}
";

    [Fact]
    public void BareName_InsideDeclaringStruct_Pins()
    {
        const string source = @"
package P

unsafe struct Bone {
    fixed Name [32]int8

    func First() int8 {
        fixed p *int8 = Name {
            return p[0]
        }
    }
}
";
        AssertNoErrors(source);
    }

    [Fact]
    public void ExplicitThis_InsideDeclaringStruct_Pins()
    {
        const string source = @"
package P

unsafe struct Bone {
    fixed Name [32]int8

    func First() int8 {
        fixed p *int8 = this.Name {
            return p[0]
        }
    }
}
";
        AssertNoErrors(source);
    }

    [Fact]
    public void BareName_IndexReadAndWrite_Decays()
    {
        // Issue #4377: `Name[i]` inside the declaring struct indexes the buffer.
        const string source = @"
package P

unsafe struct Bone {
    fixed Name [32]int8

    func Get(i int32) int8 {
        return Name[i]
    }

    func Set(i int32, v int8) {
        Name[i] = v
    }

    func Ptr() *int8 {
        return Name
    }
}
";
        AssertNoErrors(source);
    }

    [Theory]
    [InlineData("unsafe func f(h Holder) { fixed p *int8 = h.B.Name { } }")]
    [InlineData("unsafe func f(ref b Bone) { fixed p *int8 = b.Name { } }")]
    [InlineData("unsafe func f(bones []Bone) { fixed p *int8 = bones[0].Name { } }")]
    [InlineData("unsafe func f(ws []Wrap) { fixed p *int8 = ws[0].B.Name { } }")]
    public void MovableReceiver_Pins(string function)
    {
        AssertNoErrors(Prelude + function);
    }

    [Fact]
    public void BufferDeclaredOnClass_ThroughLocalReference_Pins()
    {
        // The local holds a reference; the buffer lives in the heap object, so
        // the storage is movable even though the receiver is a local.
        const string function = @"
unsafe class CBuf {
    fixed Data [4]int32
}

unsafe func f() {
    var c = CBuf()
    fixed p *int32 = c.Data { }
}
";
        AssertNoErrors(Prelude + function);
    }

    [Theory]
    [InlineData("unsafe func f() { var b = Bone{}\n fixed p *int8 = b.Name { } }")]
    [InlineData("unsafe func f(b Bone) { fixed p *int8 = b.Name { } }")]
    [InlineData("unsafe func f(b *Bone) { fixed p *int8 = b->Name { } }")]
    [InlineData("unsafe func f(b *Bone) { fixed p *int8 = (*b).Name { } }")]
    [InlineData("unsafe func f() { var w = Wrap{}\n fixed p *int8 = w.B.Name { } }")]
    public void AlreadyFixedReceiver_ReportsGS0507(string function)
    {
        var diagnostics = GetDiagnostics(Prelude + function).ToList();
        var error = Assert.Single(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Equal("GS0507", error.Id);
        Assert.Contains("'Name'", error.Message);
    }

    [Fact]
    public void ValueReceiver_NotAVariable_ReportsGS0401()
    {
        const string function = @"
func make() Bone { return Bone{} }
unsafe func f() { fixed p *int8 = make().Name { } }
";
        var diagnostics = GetDiagnostics(Prelude + function).ToList();
        var error = Assert.Single(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Equal("GS0401", error.Id);
    }

    [Fact]
    public void PointeeMismatch_ReportsGS0401()
    {
        const string function = "unsafe func f(h Holder) { fixed p *uint8 = h.B.Name { } }";
        var diagnostics = GetDiagnostics(Prelude + function).ToList();
        var error = Assert.Single(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Equal("GS0401", error.Id);
        Assert.Contains("'*int8'", error.Message);
    }

    [Fact]
    public void OutsideUnsafe_ReportsGS0400()
    {
        const string function = "func f(h Holder) { fixed p *int8 = h.B.Name { } }";
        var diagnostics = GetDiagnostics(Prelude + function).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0400");
    }

    private static void AssertNoErrors(string source)
    {
        var errors = GetDiagnostics(source).Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
        Assert.True(errors.Count == 0, string.Join("\n", errors.Select(e => $"{e.Id}: {e.Message}")));
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
