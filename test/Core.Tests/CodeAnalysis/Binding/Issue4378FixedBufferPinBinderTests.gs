// <copyright file="Issue4378FixedBufferPinBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #4378 / ADR-0125 amendment: binder coverage for a `fixed`
/// statement whose source is a fixed-size buffer field (ADR-0122 §10). The
/// accept/reject rules follow C#'s movable/fixed variable classification:
/// a buffer reached through a movable variable (struct `this`, a
/// `ref` parameter, a class field, an array element) is pinnable; one
/// reached through an already-fixed variable (a local, a by-value parameter,
/// a pointer dereference) is rejected with GS0507 (C# CS0213); a buffer of a
/// value that is not a variable, or a pointee mismatch, is GS0401 (C# CS1708 /
/// CS0266). Also covers the bare-name decay of issue #4377.
open class Issue4378FixedBufferPinBinderTests {
    @Fact
    func BareName_InsideDeclaringStruct_Pins() {
        const source = `
package P

unsafe struct Bone {
    fixed Name [32]int8

    func First() int8 {
        fixed p *int8 = Name {
            return p[0]
        }
    }
}
`
        AssertNoErrors(source)
    }

    @Fact
    func ExplicitThis_InsideDeclaringStruct_Pins() {
        const source = `
package P

unsafe struct Bone {
    fixed Name [32]int8

    func First() int8 {
        fixed p *int8 = this.Name {
            return p[0]
        }
    }
}
`
        AssertNoErrors(source)
    }

    @Fact
    func BareName_IndexReadAndWrite_Decays() {
        // Issue #4377: `Name[i]` inside the declaring struct indexes the buffer.
        const source = `
package P

unsafe struct Bone {
    fixed Name [32]int8

    func Get(i int32) int8 {
        return Name[i]
    }

    func Set(i int32, v int8) {
        Name[i] = v
    }

    func Bump(i int32) {
        Name[i] += 1
    }
}
`
        AssertNoErrors(source)
    }

    @Theory
    @InlineData("unsafe func f(h Holder) *int8 { return h.B.Name }")
    @InlineData("unsafe func f(h Holder) { let q *int8 = h.B.Name }")
    @InlineData("unsafe func f(ref b Bone) *int8 { return b.Name }")
    @InlineData("unsafe func f(bones []Bone) *int8 { return bones[0].Name }")
    @InlineData("unsafe func f(h Holder) *int8 { return &h.B.Name[0] }")
    @InlineData("unsafe func f(h Holder) *int8 { return &{ let marker = 0\n h.B.Name[0] } }")
    @InlineData(
        "unsafe func f(h Holder, flag bool) *int8 { var local = Bone{}\n return &{ let marker = 0\n flag ? local.Name[0] : h.B.Name[1] } }"
    )
    @InlineData(
        "unsafe func f(h Holder, maybe int32?) *int8 { var local = Bone{}\n return &(if let n = maybe { local.Name[0] } else { h.B.Name[1] }) }"
    )
    @InlineData(
        "unsafe func f(h Holder, flag bool) { var local = Bone{}\n let _ = &(flag ? ref local.Name[0] : ref h.B.Name[1]) }"
    )
    @InlineData(
        "unsafe func f() *int8 { var boxed object = Bone{}\n if boxed is Bone { return boxed.Name }\n return nil }"
    )
    @InlineData("unsafe struct S { fixed Name [4]int8\n func Ptr() *int8 { return Name } }")
    @InlineData("unsafe struct S { fixed Name [4]int8\n func Ptr() *int8 { return this.Name } }")
    func MovableBufferPointerOutsideFixed_ReportsGS0638(function string) {
        let diagnostics = GetDiagnostics(Prelude + function).ToList()
        let error = Assert.Single(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal("GS0638", error.Id)
        Assert.Contains("'Name'", error.Message)
    }

    @Theory
    @InlineData("unsafe func f(h Holder) int8 { return h.B.Name[0] }")
    @InlineData("unsafe func f(h Holder) int8 { return unchecked(h.B.Name)[0] }")
    @InlineData("unsafe func f(h Holder) int8 { return ({ let marker = 0\n h.B.Name })[0] }")
    @InlineData("unsafe func f(h Holder) { h.B.Name[0] = 1\n h.B.Name[0] += 2 }")
    @InlineData(
        "unsafe func f() int8 { var boxed object = Bone{}\n if boxed is Bone { return boxed.Name[0] }\n return int8(0) }"
    )
    @InlineData("unsafe func f(h Holder) *int8 { var local = Bone{}\n return &local.Name[int32(h.B.Name[0])] }")
    @InlineData("unsafe func f() *int8 { var b = Bone{}\n return b.Name }")
    @InlineData("unsafe func f(b Bone) *int8 { return b.Name }")
    @InlineData("unsafe func f(p *Bone) *int8 { return p->Name }")
    @InlineData("unsafe func f() *int8 { var w = Wrap{}\n return w.B.Name }")
    func FixedBufferDirectIndexOrFixedReceiver_AllowsDecay(function string) {
        AssertNoErrors(Prelude + function)
    }

    @Theory
    @InlineData("unsafe func f(h Holder) { fixed p *int8 = h.B.Name { } }")
    @InlineData("unsafe func f(h Holder) { fixed p *int8 = unchecked(h.B.Name) { } }")
    @InlineData("unsafe func f(ref b Bone) { fixed p *int8 = b.Name { } }")
    @InlineData("unsafe func f(bones []Bone) { fixed p *int8 = bones[0].Name { } }")
    @InlineData("unsafe func f(ws []Wrap) { fixed p *int8 = ws[0].B.Name { } }")
    func MovableReceiver_Pins(function string) {
        AssertNoErrors(Prelude + function)
    }

    @Fact
    func BufferDeclaredOnClass_ThroughLocalReference_Pins() {
        // The local holds a reference; the buffer lives in the heap object, so
        // the storage is movable even though the receiver is a local.
        const function = `
unsafe class CBuf {
    fixed Data [4]int32
}

unsafe func f() {
    var c = CBuf()
    fixed p *int32 = c.Data { }
}
`
        AssertNoErrors(Prelude + function)
    }

    @Theory
    @InlineData("unsafe func f() { var b = Bone{}\n fixed p *int8 = b.Name { } }")
    @InlineData("unsafe func f(b Bone) { fixed p *int8 = b.Name { } }")
    @InlineData("unsafe func f(b *Bone) { fixed p *int8 = b->Name { } }")
    @InlineData("unsafe func f(b *Bone) { fixed p *int8 = (*b).Name { } }")
    @InlineData("unsafe func f() { var w = Wrap{}\n fixed p *int8 = w.B.Name { } }")
    func AlreadyFixedReceiver_ReportsGS0507(function string) {
        let diagnostics = GetDiagnostics(Prelude + function).ToList()
        let error = Assert.Single(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal("GS0507", error.Id)
        Assert.Contains("'Name'", error.Message)
    }

    @Fact
    func ValueReceiver_NotAVariable_ReportsGS0401() {
        const function = `
func make() Bone { return Bone{} }
unsafe func f() { fixed p *int8 = make().Name { } }
`
        let diagnostics = GetDiagnostics(Prelude + function).ToList()
        let error = Assert.Single(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal("GS0401", error.Id)
    }

    @Fact
    func PointeeMismatch_ReportsGS0401() {
        const function = "unsafe func f(h Holder) { fixed p *uint8 = h.B.Name { } }"
        let diagnostics = GetDiagnostics(Prelude + function).ToList()
        let error = Assert.Single(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal("GS0401", error.Id)
        Assert.Contains("'*int8'", error.Message)
    }

    @Fact
    func OutsideUnsafe_ReportsGS0400() {
        const function = "func f(h Holder) { fixed p *int8 = h.B.Name { } }"
        let diagnostics = GetDiagnostics(Prelude + function).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0400")
    }

    shared {
        private const Prelude string = `
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
`

        private func AssertNoErrors(source string) {
            let errors = GetDiagnostics(source).Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error).ToList()
            Assert.True(errors.Count == 0, string.Join("\n", errors.Select((e Diagnostic) -> "${e.Id}: ${e.Message}")))
        }

        private func GetDiagnostics(source string) IEnumerable[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics
        }
    }
}
