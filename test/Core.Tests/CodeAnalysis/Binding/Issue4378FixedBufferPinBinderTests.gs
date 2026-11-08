// <copyright file="Issue4378FixedBufferPinBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
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
    @Theory
    @InlineData(true)
    @InlineData(false)
    func InlineAwaitBufferPointer_ReportsGS0638(parameter bool) {
        let source = Prelude + `unsafe async func f(PARAMETER) int32 {
    LOCAL
    let p *int8 = ({ await System.Threading.Tasks.Task.Yield()
        b }).Name
    return int32(p[0])
}`.Replace(
            "PARAMETER",
            if parameter {
                "b Bone"
            } else {
                string.Empty
            }
        )
            .Replace(
            "LOCAL",
            if parameter {
                string.Empty
            } else {
                "var b = Bone{}"
            }
        )
        let error = Assert.Single(GetDiagnostics(source), (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0638", error.Id)
        Assert.Equal(source.LastIndexOf("Name", StringComparison.Ordinal), error.Location.Span.Start)
        Assert.Equal("Name", error.Location.Text!!.ToString(error.Location.Span))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func BoxedTupleElement_IsMovableStorage(nested bool) {
        // Tuple aliases do not parse yet; exercise the storage node directly.
        let compilation = Compilation(SyntaxTree.Parse(Prelude))
        let bone = Assert.Single(compilation.GlobalScope.Structs, (s StructSymbol) -> s.Name == "Bone")
        let field = Assert.Single(bone.Fields, (f FieldSymbol) -> f.IsFixedBuffer)
        let pair = TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](bone, TypeSymbol.Int32))
        let outer = if nested {
            TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](pair, TypeSymbol.Int32))
        } else {
            pair
        }
        let boxed = BoundVariableExpression(nil, LocalVariableSymbol("boxed", false, TypeSymbol.Object), outer)
        let receiver BoundExpression = if nested {
            BoundTupleElementAccessExpression(nil, boxed, outer, 0)
        } else {
            boxed
        }
        let element = BoundTupleElementAccessExpression(nil, receiver, pair, 0)
        let buffer = BoundFieldAccessExpression(nil, element, bone, field)
        Assert.False(StatementBinder.IsFixedVariable(buffer))
    }

    @Theory
    @InlineData("boxed.Item1.Name")
    @InlineData("boxed.Item2.Item1.Name")
    @InlineData("&boxed.Item2.Item1.Name[0]")
    func BoxedTupleStorage_ReportsGS0638(expression string) {
        let source = Prelude + `unsafe func f(boxed object) *int8 {
    if boxed is ValueTuple[Bone, ValueTuple[Bone, int32]] {
        return ` + expression + `
    }
    return nil
}`
        let error = Assert.Single(GetDiagnostics(source), (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0638", error.Id)
        Assert.Equal(source.LastIndexOf("Name", StringComparison.Ordinal), error.Location.Span.Start)
        Assert.Equal("Name", error.Location.Text!!.ToString(error.Location.Span))
    }

    @Theory
    @InlineData(`unsafe func f() {
    var b = Bone{}
    let p *int8 = b.Name
    let read = func() int32 { return b.Parent }
    Console.WriteLine(int32(p[0]) + read())
}`)
    @InlineData(`unsafe func f(b Bone) {
    let read = func() int32 { return b.Parent }
    let p *int8 = b.Name
    Console.WriteLine(int32(p[0]) + read())
}`)
    @InlineData(`unsafe func f() {
    var b = Bone{}
    let read = func() int32 {
        let p *int8 = b.Name
        return int32(p[0])
    }
    Console.WriteLine(read())
}`)
    @InlineData(`unsafe func f() {
    var b = Bone{}
    let read[T] = func(value T) int32 { return b.Parent }
    let p *int8 = b.Name
    Console.WriteLine(int32(p[0]) + read[int32](0))
}`)
    @InlineData(`unsafe async func f(b Bone) int32 {
    await System.Threading.Tasks.Task.Yield()
    let p *int8 = b.Name
    return int32(p[0])
}`)
    @InlineData(`unsafe async func f() int32 {
    var b = Bone{}
    await System.Threading.Tasks.Task.Yield()
    let p *int8 = b.Name
    return int32(p[0])
}`)
    @InlineData(`unsafe func f() sequence[int32] {
    var b = Bone{}
    yield 0
    let p *int8 = b.Name
    yield int32(p[0])
}`)
    @InlineData(`unsafe async func f(b Bone) sequence[int32] {
    await System.Threading.Tasks.Task.Yield()
    let p *int8 = b.Name
    yield int32(p[0])
}`)
    @InlineData(`unsafe func f() {
    let build = func() int32 {
        var b = Bone{}
        let read = func() int32 { return b.Parent }
        let p *int8 = b.Name
        return int32(p[0]) + read()
    }
    Console.WriteLine(build())
}`)
    @InlineData(`unsafe func f() {
    let read = async func(b Bone) int32 {
        await System.Threading.Tasks.Task.Yield()
        let p *int8 = b.Name
        return int32(p[0])
    }
    let ignored = read(Bone{})
}`)
    @InlineData(`unsafe func f() {
    var pair = (Bone{}, 0)
    let read = func() int32 { return pair.Item2 }
    let p *int8 = pair.Item1.Name
    Console.WriteLine(int32(p[0]) + read())
}`)
    func HeapPromotedBufferPointer_ReportsGS0638(function string) {
        let source = Prelude + function
        let error = Assert.Single(GetDiagnostics(source), (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0638", error.Id)
        Assert.Equal(source.LastIndexOf("Name", StringComparison.Ordinal), error.Location.Span.Start)
        Assert.Equal("Name", error.Location.Text!!.ToString(error.Location.Span))
    }

    @Theory
    @InlineData("({ let marker = 0\n b }).Name")
    @InlineData("pair.Item1.Name")
    @InlineData("pair.Item2.Item1.Name")
    @InlineData("(b, 0).Item1.Name")
    @InlineData("({ let marker = 0\n pair }).Item2.Item1.Name")
    @InlineData("({ var inner = Bone{}\n inner }).Name")
    func LocalBlockAndTupleStorage_AllowsBufferDecay(expression string) {
        AssertNoErrors(Prelude + `unsafe func f() {
    var b = Bone{}
    var pair = (b, (b, 0))
    let p *int8 = ` + expression + `
    Console.WriteLine(int32(p[0]))
}`)
    }

    @Theory
    @InlineData(`unsafe func f() {
    var b = Bone{}
    let read = func() int32 { return b.Parent }
    fixed p *int8 = b.Name { p[0] = 3 }
    Console.WriteLine(read())
}`)
    @InlineData(`unsafe func f(b Bone) {
    let read = func() int32 {
        fixed p *int8 = b.Name { return int32(p[0]) }
    }
    Console.WriteLine(read())
}`)
    @InlineData(`unsafe async func f() int32 {
    var b = Bone{}
    await System.Threading.Tasks.Task.Yield()
    fixed p *int8 = b.Name { return int32(p[0]) }
}`)
    @InlineData(`unsafe func f() sequence[int32] {
    var b = Bone{}
    yield 0
    var result = 0
    fixed p *int8 = b.Name { result = int32(p[0]) }
    yield result
}`)
    func HeapPromotedBufferStorage_AllowsPinning(function string) {
        AssertNoErrors(Prelude + function)
    }

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
