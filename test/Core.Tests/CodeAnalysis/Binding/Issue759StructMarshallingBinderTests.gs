// <copyright file="Issue759StructMarshallingBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import System.Runtime.InteropServices
import Xunit

/// Binder coverage for ADR-0093 / issue #759 struct- and class-marshalling.
/// Validates the GS0346–GS0351 diagnostic range and the
/// (cref:StructSymbol.LayoutMetadata) / (cref:FieldSymbol.ExplicitOffset)
/// values that feed the emitter.
open class Issue759StructMarshallingBinderTests {
    @Fact
    func Sequential_StructLayout_Without_PInvoke_Records_Metadata() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var X int32
    var Y int32
}
`
        let scope_ = BindSource(source)
        let s = scope_.Structs.Single((t StructSymbol) -> t.Name == "Point")
        Assert.NotNull(s.LayoutMetadata)
        Assert.Equal(LayoutKind.Sequential, s.LayoutMetadata!!.Layout)
        Assert.DoesNotContain(
            scope_.Diagnostics,
            (d Diagnostic) -> (d.Id is "GS0346" or "GS0347" or "GS0348" or "GS0349" or "GS0350" or "GS0351")
        )
    }

    @Fact
    func Explicit_StructLayout_With_FieldOffsets_Records_All_Offsets() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit, Size: 8)
struct Pair {
    @FieldOffset(0) var Low uint32
    @FieldOffset(4) var High int32
    @FieldOffset(0) var Quad int64
}
`
        let scope_ = BindSource(source)
        Assert.DoesNotContain(
            scope_.Diagnostics,
            (d Diagnostic) -> (d.Id is "GS0346" or "GS0347" or "GS0348" or "GS0350")
        )
        let s = scope_.Structs.Single((t StructSymbol) -> t.Name == "Pair")
        Assert.Equal(LayoutKind.Explicit, s.LayoutMetadata!!.Layout)
        Assert.Equal(8, s.LayoutMetadata!!.Size)
        Assert.Equal(0, s.Fields.Single((f FieldSymbol) -> f.Name == "Low").ExplicitOffset)
        Assert.Equal(4, s.Fields.Single((f FieldSymbol) -> f.Name == "High").ExplicitOffset)
        Assert.Equal(0, s.Fields.Single((f FieldSymbol) -> f.Name == "Quad").ExplicitOffset)
    }

    @Fact
    func Auto_LayoutKind_Reports_GS0346() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Auto)
struct Bad {
    var X int32
}
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0346")
    }

    @Fact
    func FieldOffset_Without_Explicit_Layout_Reports_GS0348() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Bad {
    @FieldOffset(0) var X int32
    @FieldOffset(4) var Y int32
}
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0348")
    }

    @Fact
    func Missing_FieldOffset_On_Explicit_Struct_Reports_GS0347() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit)
struct Bad {
    @FieldOffset(0) var X int32
    var Y int32
}
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0347")
    }

    @Fact
    func Negative_FieldOffset_Reports_GS0350() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit)
struct Bad {
    @FieldOffset(-4) var X int32
}
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0350")
    }

    @Fact
    func Blittable_Struct_Accepted_In_PInvoke_Signature() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct TimeSpec {
    var TvSec int64
    var TvNsec int64
}

@DllImport("libc", EntryPoint: "nope")
func Foo(ts TimeSpec) int32;
`
        let scope_ = BindSource(source)
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0349")
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0323")
    }

    @Fact
    func NonBlittable_Struct_With_String_Field_Reports_GS0349() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Bad {
    var Name string
    var Count int32
}

@DllImport("libc", EntryPoint: "nope")
func Nope(arg Bad) int32;
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0349")
    }

    @Fact
    func NonBlittable_Struct_With_Bool_Field_Reports_GS0349() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Bad {
    var Flag bool
    var Count int32
}

@DllImport("libc", EntryPoint: "nope")
func Nope(arg Bad) int32;
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0349")
    }

    @Fact
    func Class_Without_StructLayout_In_PInvoke_Parameter_Reports_GS0349() {
        const source = `
package P
import System.Runtime.InteropServices

class Ctx {
    var Handle nint
}

@DllImport("libc", EntryPoint: "nope")
func Nope(arg Ctx) int32;
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0349")
    }

    @Fact
    func Class_As_PInvoke_Return_Type_Reports_GS0351() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
class Ctx {
    var Handle nint
}

@DllImport("libc", EntryPoint: "nope")
func Nope() Ctx;
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0351")
    }

    shared {
        private func BindSource(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }
    }
}
