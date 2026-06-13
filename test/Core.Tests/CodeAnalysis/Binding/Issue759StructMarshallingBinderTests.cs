// <copyright file="Issue759StructMarshallingBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using System.Runtime.InteropServices;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Binder coverage for ADR-0093 / issue #759 struct- and class-marshalling.
/// Validates the GS0346–GS0351 diagnostic range and the
/// <see cref="StructSymbol.LayoutMetadata"/> / <see cref="FieldSymbol.ExplicitOffset"/>
/// values that feed the emitter.
/// </summary>
public class Issue759StructMarshallingBinderTests
{
    [Fact]
    public void Sequential_StructLayout_Without_PInvoke_Records_Metadata()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var X int32
    var Y int32
}
";
        var scope = BindSource(source);
        var s = scope.Structs.Single(t => t.Name == "Point");
        Assert.NotNull(s.LayoutMetadata);
        Assert.Equal(LayoutKind.Sequential, s.LayoutMetadata.Layout);
        Assert.DoesNotContain(scope.Diagnostics, d => d.Id is "GS0346" or "GS0347" or "GS0348" or "GS0349" or "GS0350" or "GS0351");
    }

    [Fact]
    public void Explicit_StructLayout_With_FieldOffsets_Records_All_Offsets()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit, Size: 8)
struct Pair {
    @FieldOffset(0) var Low uint32
    @FieldOffset(4) var High int32
    @FieldOffset(0) var Quad int64
}
";
        var scope = BindSource(source);
        Assert.DoesNotContain(scope.Diagnostics, d => d.Id is "GS0346" or "GS0347" or "GS0348" or "GS0350");
        var s = scope.Structs.Single(t => t.Name == "Pair");
        Assert.Equal(LayoutKind.Explicit, s.LayoutMetadata.Layout);
        Assert.Equal(8, s.LayoutMetadata.Size);
        Assert.Equal(0, s.Fields.Single(f => f.Name == "Low").ExplicitOffset);
        Assert.Equal(4, s.Fields.Single(f => f.Name == "High").ExplicitOffset);
        Assert.Equal(0, s.Fields.Single(f => f.Name == "Quad").ExplicitOffset);
    }

    [Fact]
    public void Auto_LayoutKind_Reports_GS0346()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Auto)
struct Bad {
    var X int32
}
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0346");
    }

    [Fact]
    public void FieldOffset_Without_Explicit_Layout_Reports_GS0348()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Bad {
    @FieldOffset(0) var X int32
    @FieldOffset(4) var Y int32
}
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0348");
    }

    [Fact]
    public void Missing_FieldOffset_On_Explicit_Struct_Reports_GS0347()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit)
struct Bad {
    @FieldOffset(0) var X int32
    var Y int32
}
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0347");
    }

    [Fact]
    public void Negative_FieldOffset_Reports_GS0350()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit)
struct Bad {
    @FieldOffset(-4) var X int32
}
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0350");
    }

    [Fact]
    public void Blittable_Struct_Accepted_In_PInvoke_Signature()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct TimeSpec {
    var TvSec int64
    var TvNsec int64
}

@DllImport(""libc"", EntryPoint: ""nope"")
func Foo(ts TimeSpec) int32;
";
        var scope = BindSource(source);
        Assert.DoesNotContain(scope.Diagnostics, d => d.Id == "GS0349");
        Assert.DoesNotContain(scope.Diagnostics, d => d.Id == "GS0323");
    }

    [Fact]
    public void NonBlittable_Struct_With_String_Field_Reports_GS0349()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Bad {
    var Name string
    var Count int32
}

@DllImport(""libc"", EntryPoint: ""nope"")
func Nope(arg Bad) int32;
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0349");
    }

    [Fact]
    public void NonBlittable_Struct_With_Bool_Field_Reports_GS0349()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Bad {
    var Flag bool
    var Count int32
}

@DllImport(""libc"", EntryPoint: ""nope"")
func Nope(arg Bad) int32;
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0349");
    }

    [Fact]
    public void Class_Without_StructLayout_In_PInvoke_Parameter_Reports_GS0349()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

class Ctx {
    var Handle nint
}

@DllImport(""libc"", EntryPoint: ""nope"")
func Nope(arg Ctx) int32;
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0349");
    }

    [Fact]
    public void Class_As_PInvoke_Return_Type_Reports_GS0351()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
class Ctx {
    var Handle nint
}

@DllImport(""libc"", EntryPoint: ""nope"")
func Nope() Ctx;
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0351");
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }
}
