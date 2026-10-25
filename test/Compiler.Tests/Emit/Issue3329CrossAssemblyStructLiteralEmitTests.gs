// <copyright file="Issue3329CrossAssemblyStructLiteralEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Reflection
import Xunit

/// Issue #3329 — a struct literal (`S{}`) for a struct type declared in
/// ANOTHER (already-compiled) assembly lost its ADR-0159 "sound zero value"
/// instance-field initializer for a magic-collection-typed field (map/slice/
/// fixed array/sequence), leaving the field at its raw CLR default (a null
/// reference for a reference-backed collection) and NREing at runtime the
/// first time the field is used. The REPL hits this identically on a
/// cross-cell struct, since each submission is a distinct assembly (ADR-0156)
/// — these tests exercise the SAME code paths (`ImportedTypeSymbol.
/// BuildSemanticAggregate` for a `data struct`/primary-ctor struct,
/// `ExpressionBinder.BindImportedTypeObjectInitializer` for a plain
/// struct) through ordinary cross-assembly `gsc` compilation plus ILVerify,
/// which is more convenient to drive from a test than a REPL session and
/// confirms the fix is not REPL-specific.
open class Issue3329CrossAssemblyStructLiteralEmitTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_PrimaryConstructorsDoNotExportLiteralInitializers(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package i5296primary
public class Effects {
    shared {
        public var Trace string = ""
        public func Next(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct EmptyPrimary() {
    public var X int32 = Effects.Next("I", 1)
}
public data struct Primary(Seed int32 = 0) {
    public var X int32 = Effects.Next("I", 1)
}
public data struct NonPrimary {
    public var X int32 = Effects.Next("I", 1)
}`, "i5296primary", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import System
import i5296primary
data struct LocalPrimary() {
    public var X int32 = Effects.Next("I", 1)
}
data struct LocalNonPrimary {
    public var X int32 = Effects.Next("I", 1)
}
let local = LocalPrimary{X: Effects.Next("E", 9)}
Console.WriteLine(Effects.Trace + ":" + local.X.ToString())
Effects.Trace = ""
let explicit = Effects.Next("E", 9)
var imported = EmptyPrimary()
imported.X = explicit
Console.WriteLine(Effects.Trace + ":" + imported.X.ToString())
Effects.Trace = ""
Console.WriteLine(LocalPrimary{}.X)
Console.WriteLine(Effects.Trace)
Effects.Trace = ""
Console.WriteLine(EmptyPrimary().X)
Console.WriteLine(Effects.Trace)
Effects.Trace = ""
let localNonPrimary = LocalNonPrimary{X: Effects.Next("E", 9)}
Console.WriteLine(Effects.Trace + ":" + localNonPrimary.X.ToString())
Effects.Trace = ""
let importedNonPrimary = NonPrimary{X: Effects.Next("E", 9)}
Console.WriteLine(Effects.Trace + ":" + importedNonPrimary.X.ToString())
Effects.Trace = ""
Console.WriteLine(NonPrimary{}.X)
Console.WriteLine(Effects.Trace)`, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("EI:9\nEI:9\n1\nI\n1\nI\nE:9\nE:9\n1\nI\n"),
            System.Text.Encoding.UTF8.GetBytes(fixture.Run(consumer))
        )
        let assembly = EmittedFixture.Load(producer)
        for name in[]string{"EmptyPrimary", "Primary"} {
            let type = assembly.GetType("i5296primary." + name, throwOnError: true)
            Assert.Null(type!!.GetNestedType("<>FieldInitializers", BindingFlags.Public))
        }
        let nonPrimary = assembly.GetType("i5296primary.NonPrimary", throwOnError: true)
        Assert.NotNull(nonPrimary!!.GetNestedType("<>FieldInitializers", BindingFlags.Public))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_NestedReadonlyCollectionDiagnosticsRetainConsumerAnchors(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package i5296anchors
public data struct ReadonlyItems {
    public let Items []int32
    private var Marker int32 = 0
    public func Count() int32 -> Marker + Items.Length
}
public data struct Outer {
    public var Child ReadonlyItems
}
public data struct MutableItems {
    public var Items []int32
}
public data struct MutableOuter {
    public var Child MutableItems
}`, "i5296anchors", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let rejectedReference = Path.Combine(fixture.Directory, "rejected.ref.dll")
        let (code, output) = fixture.TryCompile(`import i5296anchors
class Holder {
    public var Value Outer = Outer{}
}
let first = Holder{}
let second = Holder{}`, "rejected", executable: true, "/r:" + selected, "/refout:" + rejectedReference)
        Assert.True(code != 0, output)
        for location in[]string{"(3,30,3,35)", "(5,13,5,19)", "(6,14,6,20)"} {
            Assert.True(output.Contains("rejected.gs" + location + ": error GS0127:", StringComparison.Ordinal), output)
        }
        Assert.Equal(3, output.Split("error GS0127:", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
        let consumer = fixture.Compile(`import i5296anchors
class Holder {
    public var Value MutableOuter = MutableOuter{}
}
let omitted = Holder{}
System.Console.WriteLine(omitted.Value.Child.Items.Length)
let supplied = Holder{Value: MutableOuter{Child: MutableItems{Items: []int32{1, 2}}}}
System.Console.WriteLine(supplied.Value.Child.Items.Length)`, "control", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("0\n2\n"),
            System.Text.Encoding.UTF8.GetBytes(fixture.Run(consumer))
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_ReadonlyProjectionRejectsExternalWrites(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package i5296projection
public data struct Target {
    public var A int32
    public let X int32 = 7
}
public data struct Mutable {
    public var A int32
    public var X int32 = 7
}`, "i5296projection", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let rejectedReference = Path.Combine(fixture.Directory, "rejected.ref.dll")
        let (code, output) = fixture.TryCompile(`import i5296projection
data struct Source { public var A int32 }
let source = Source{A: 3}
let target Target = source
System.Console.WriteLine(target.X)`, "rejected", executable: true, "/r:" + selected, "/refout:" + rejectedReference)
        if code == 0 {
            IlVerifier.Verify(Path.Combine(fixture.Directory, "rejected.dll"), []string{producer})
        }
        Assert.True(code != 0, output)
        Assert.Contains("rejected.gs(4,21,4,27): error GS0127:", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
        let consumer = fixture.Compile(`import i5296projection
data struct Source {
    public var A int32
    public var X int32
}
let source = Source{A: 3, X: 9}
let target Mutable = source
System.Console.WriteLine(target.A)
System.Console.WriteLine(target.X)
System.Console.WriteLine(default(Target).X)`, "control", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("3\n9\n0\n"),
            System.Text.Encoding.UTF8.GetBytes(fixture.Run(consumer))
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_FriendMixedInitializerSeedsInternalCollection(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package i5296friend
@assembly:InternalsVisibleTo("FriendConsumer")
public class Effects {
    shared {
        public var Trace string = ""
        public func ExplicitItems() []int32 {
            Trace = Trace + "E"
            return []int32{8, 9, 10}
        }
    }
}
public data struct Basket {
    public var Tag int32
    internal var Items []int32
    public func Add(value int32) {
        Effects.Trace = Effects.Trace + "A"
        Tag = Tag + value + Items.Length
    }
}`, "i5296friend", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let imported = EmittedFixture.Load(File.ReadAllBytes(producer), fixture.Directory).GetType("i5296friend.Basket")
        let field = imported!!.GetField("Items", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
        Assert.True(field!!.IsAssembly)
        Assert.Null(imported!!.GetField("Items", BindingFlags.Instance | BindingFlags.Public))
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import System
import i5296friend
data struct LocalBasket {
    public var Tag int32
    internal var Items []int32
    public func Add(value int32) {
        Effects.Trace = Effects.Trace + "A"
        Tag = Tag + value + Items.Length
    }
}
let local = LocalBasket{Tag: 0, 1, Items: Effects.ExplicitItems()}
Console.WriteLine(Effects.Trace + ":" + local.Tag.ToString() + "," + local.Items.Length.ToString())
Effects.Trace = ""
let imported = Basket{Tag: 0, 1, Items: Effects.ExplicitItems()}
Console.WriteLine(Effects.Trace + ":" + imported.Tag.ToString() + "," + imported.Items.Length.ToString())`, "FriendConsumer", executable: true, "/assemblyname:FriendConsumer", "/r:" +
                selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("AE:1,3\nAE:1,3\n"),
            System.Text.Encoding.UTF8.GetBytes(fixture.Run(consumer))
        )
        let (code, output) = fixture.TryCompile(`import i5296friend
let value = Basket{Items: []int32{}}`, "NonFriend", executable: true, "/assemblyname:NonFriend", "/r:" + selected)
        Assert.True(code != 0, output)
        Assert.Contains("NonFriend.gs(2,20,2,25): error GS0158:", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "NonFriend.dll")))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_ReadonlyInitializerRejectsExternalWrites(useReferenceAssembly bool) {
        const library = `package i5296readonly
public data struct Readonly {
    public let X int32 = 7
}`
        let directory = Directory.CreateDirectory(
            Path.Combine(AppContext.BaseDirectory, "gs_5296_readonly_" + Guid.NewGuid().ToString("N"))
        )
            .FullName
        try {
            let producer = Path.Combine(directory, "i5296readonly.dll")
            let reference = Path.Combine(directory, "reference.dll")
            let producerSource = Path.Combine(directory, "library.gs")
            let consumerSource = Path.Combine(directory, "consumer.gs")
            let consumer = Path.Combine(directory, "consumer.dll")
            File.WriteAllText(producerSource, library)
            Compile([]string{"/target:library", "/out:" + producer, "/refout:" + reference, producerSource})
            IlVerifier.Verify(producer)
            for (literal, location) in[](Literal string, Location string){
                ("Readonly{}", "(2,13,2,21)"),
                ("Readonly{X: 9}", "(2,22,2,23)")
            } {
                File.WriteAllText(
                    consumerSource,
                    "import i5296readonly\nlet value = " + literal + "\nSystem.Console.WriteLine(value.X)"
                )
                let rejected = TryCompile(
                    []string{
                        "/target:exe",
                        "/out:" + consumer,
                        "/r:" +
                            (
                            if useReferenceAssembly {
                                reference
                            } else {
                                producer
                            }
                        ),
                        consumerSource
                    }
                )
                if rejected.Code == 0 {
                    IlVerifier.Verify(consumer, []string{producer})
                }
                Assert.NotEqual(0, rejected.Code)
                Assert.True(
                    rejected.Output.Contains("consumer.gs" + location + ": error GS0127:", StringComparison.Ordinal),
                    rejected.Output
                )
                Assert.False(File.Exists(consumer), rejected.Output)
            }
            Assert.Equal(
                System.Text.Encoding.UTF8.GetBytes("0" + Environment.NewLine),
                System
                    .Text
                    .Encoding
                    .UTF8
                    .GetBytes(
                    CompileAndRun(
                        "import i5296readonly\nSystem.Console.WriteLine(default(Readonly).X)",
                        library,
                        "i5296readonly",
                        useReferenceAssembly
                    )
                )
            )
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func ImportedDataStruct_MixedInitializersUseCollectionZerosNotDeclarationValues() {
        const expression = "Basket{Tag: 0, 1, Items: Effects.ExplicitItems()}"
        const library = `package i5296mixed
public class Effects {
    shared {
        public var Trace string = ""
        public func DefaultItems() []int32 {
            Trace = Trace + "D"
            return []int32{10, 11}
        }
        public func ExplicitItems() []int32 {
            Trace = Trace + "E"
            return []int32{8, 9, 10}
        }
    }
}
public data struct Basket {
    public var Tag int32
    public var Items []int32 = Effects.DefaultItems()
    public func Add(value int32) {
        Effects.Trace = Effects.Trace + "A"
        Tag = Tag + value + Items.Length
    }
}`
        let source = `import System
import i5296mixed
data struct LocalBasket {
    public var Tag int32
    public var Items []int32 = Effects.DefaultItems()
    public func Add(value int32) {
        Effects.Trace = Effects.Trace + "A"
        Tag = Tag + value + Items.Length
    }
}
let local = ` + expression.Replace("Basket", "LocalBasket", StringComparison.Ordinal) + `
Console.WriteLine(Effects.Trace + ":" + local.Tag.ToString() + "," + local.Items.Length.ToString())
Effects.Trace = ""
let imported = ` + expression + `
Console.WriteLine(Effects.Trace + ":" + imported.Tag.ToString() + "," + imported.Items.Length.ToString())`
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("AE:1,3\nAE:1,3\n".ReplaceLineEndings(Environment.NewLine)),
            System.Text.Encoding.UTF8.GetBytes(CompileAndRun(source, library, "i5296mixed"))
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_ConstantInitializerDoesNotTriggerStaticConstructor(throws bool) {
        let initialization = if throws {
            `throw System.InvalidOperationException("unexpected static initialization")`
        } else {
            `System.Console.Write("S")`
        }
        let members = `public var Value int32 = 1
    shared { init { ` + initialization + ` } }`
        let library = "package i5296static\npublic data struct Imported {\n" + members + "\n}"
        let source = "import i5296static\ndata struct Local {\n" + members + `
}
System.Console.WriteLine(Local{}.Value)
System.Console.WriteLine(Imported{}.Value)`
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("1\n1\n".ReplaceLineEndings(Environment.NewLine)),
            System.Text.Encoding.UTF8.GetBytes(CompileAndRun(source, library, "i5296static"))
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_OmittedInlineInitializersMatchLocalLiterals(useReferenceAssembly bool) {
        const library = `package i5296defaults
public enum Layout { Stacked, Compact }
public data struct PropertyGrid {
    public var Layout Layout
    public var LabelWidth float64 = 160
}
public data struct SettingsLayoutInput {
    public var SidebarWidth float64 = 180
}`
        const source = `import System
import i5296defaults
data struct LocalGrid {
    public var LabelWidth float64 = 160
}
Console.WriteLine(LocalGrid{}.LabelWidth)
Console.WriteLine(PropertyGrid{Layout: Layout.Compact}.LabelWidth)
Console.WriteLine(SettingsLayoutInput{}.SidebarWidth)
Console.WriteLine(PropertyGrid{Layout: Layout.Compact, LabelWidth: 160}.LabelWidth)`
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("160\n160\n180\n160\n".ReplaceLineEndings(Environment.NewLine)),
            System.Text.Encoding.UTF8.GetBytes(CompileAndRun(source, library, "i5296defaults", useReferenceAssembly))
        )
    }

    @Fact
    func ImportedDataStruct_InlineInitializersPreserveOverridesAndEvaluationOrder() {
        const library = `package i5296order
public class Effects {
    shared {
        public var Trace string = ""
        public func Next(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct Imported {
    public var A int32 = Effects.Next("A", 1)
    public var B int32 = Effects.Next("B", 2)
    public var C int32 = Effects.Next("C", 3)
}`
        const source = `import System
import i5296order
data struct Local {
    public var A int32 = Effects.Next("A", 1)
    public var B int32 = Effects.Next("B", 2)
    public var C int32 = Effects.Next("C", 3)
}
let local = Local{C: Effects.Next("X", 9)}
Console.WriteLine(Effects.Trace + ":" + local.A.ToString() + "," + local.B.ToString() + "," + local.C.ToString())
Effects.Trace = ""
let imported = Imported{C: Effects.Next("X", 9)}
Console.WriteLine(Effects.Trace + ":" + imported.A.ToString() + "," + imported.B.ToString() + "," + imported.C.ToString())
Effects.Trace = ""
let empty = Imported{}
Console.WriteLine(Effects.Trace + ":" + empty.A.ToString() + "," + empty.B.ToString() + "," + empty.C.ToString())
Effects.Trace = ""
let explicit = Imported{C: Effects.Next("X", 9), B: Effects.Next("Y", 8), A: Effects.Next("Z", 7)}
Console.WriteLine(Effects.Trace + ":" + explicit.A.ToString() + "," + explicit.B.ToString() + "," + explicit.C.ToString())
Effects.Trace = ""
Console.WriteLine(default(Imported).A)
let array = [1]Imported{}
Console.WriteLine(array[0].A)
Console.WriteLine(Effects.Trace.Length)`
        Assert.Equal(
            System
                .Text
                .Encoding
                .UTF8
                .GetBytes(
                "XAB:1,2,9\nXAB:1,2,9\nABC:1,2,3\nXYZ:7,8,9\n0\n0\n0\n".ReplaceLineEndings(Environment.NewLine)
            ),
            System.Text.Encoding.UTF8.GetBytes(CompileAndRun(source, library, "i5296order"))
        )
    }

    @Fact
    func ImportedDataStruct_InlineInitializersRetainPrivateCallsAndCollectionValues() {
        const library = `package i5296expressions
public data struct Input {
    public var Values []int32 = []int32{Seed()}
    public var Text string = "seed:${Seed()}"
    shared {
        private func Seed() int32 -> 4
    }
}`
        const source = `import System
import i5296expressions
let input = Input{}
Console.WriteLine(input.Values.Length)
if input.Values.Length != 0 {
    Console.WriteLine(input.Values[0])
}
Console.WriteLine(input.Text)`
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("1\n4\nseed:4\n".ReplaceLineEndings(Environment.NewLine)),
            System.Text.Encoding.UTF8.GetBytes(CompileAndRun(source, library, "i5296expressions"))
        )
    }

    @Fact
    func PlainStruct_EmptyLiteral_SliceField_ZeroInitializesToEmptyNotNull() {
        const library = `package i3329lib1

struct S {
    public var Items []int32
}`
        const source = `package i3329a
import i3329lib1

func Main() {
    let s = S{}
    System.Console.WriteLine(s.Items.Length)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib1"))
    }

    @Fact
    func DataStruct_EmptyLiteral_SliceField_ZeroInitializesToEmptyNotNull() {
        const library = `package i3329lib2

data struct S {
    public var Items []int32
}`
        const source = `package i3329b
import i3329lib2

func Main() {
    let s = S{}
    System.Console.WriteLine(s.Items.Length)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib2"))
    }

    @Fact
    func PlainStruct_EmptyLiteral_MapField_ZeroInitializesToEmptyNotNull() {
        const library = `package i3329lib3

struct S {
    public var M map[string, int32]
}`
        const source = `package i3329c
import i3329lib3

func Main() {
    let s = S{}
    System.Console.WriteLine(s.M.Count)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib3"))
    }

    @Fact
    func PlainStruct_EmptyLiteral_SequenceField_ZeroInitializesToEmptyNotNull() {
        const library = `package i3329lib4

struct S {
    public var Seq sequence[int32]
}`
        const source = `package i3329d
import i3329lib4

func Main() {
    let s = S{}
    var n = 0
    for x in s.Seq {
        n = n + 1
    }
    System.Console.WriteLine(n)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib4"))
    }

    @Fact
    func PlainStruct_EmptyLiteral_FixedArrayField_ZeroInitializesToDeclaredLength() {
        const library = `package i3329lib5

struct S {
    public var Buf [4]int32
}`
        const source = `package i3329e
import i3329lib5

func Main() {
    let s = S{}
    System.Console.WriteLine(s.Buf.Length)
}`
        Assert.Equal("4${Environment.NewLine}", CompileAndRun(source, library, "i3329lib5"))
    }

    @Fact
    func PlainStruct_LiteralWithExplicitFieldInitializer_MagicCollectionFieldStillZeroInits() {
        // The literal explicitly sets ONE field; the OTHER (magic-collection)
        // field is left unset and must still get its sound zero value.
        const library = `package i3329lib6

struct S {
    public var X int32
    public var Items []int32
}`
        const source = `package i3329f
import i3329lib6

func Main() {
    let s = S{X: 7}
    System.Console.WriteLine(s.X.ToString() + "," + s.Items.Length.ToString())
}`
        Assert.Equal("7,0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib6"))
    }

    @Fact
    func NestedStructInStruct_BothDeclaredInLibrary_OuterLiteralWithExplicitInnerWorks() {
        // Issue #3329 scope note: recursing an OUTER struct literal's own
        // zero-value synthesis INTO an inner struct-typed field that itself
        // needs a magic-collection zero value is issue #3319 (same-assembly
        // recursion — reproduces identically with no library reference at
        // all, confirmed unrelated to #3329's cross-assembly token gap and
        // deliberately left out of this issue's scope). This test instead
        // pins the shape #3329 IS responsible for: an outer struct literal
        // for a type whose nested-struct field is ALSO declared in another
        // assembly, explicitly initialized (not recursively zero-valued).
        const library = `package i3329lib7

struct Inner {
    public var X int32
}

struct Outer {
    public var I Inner
}`
        const source = `package i3329g
import i3329lib7

func Main() {
    let o = Outer{I: Inner{X: 5}}
    System.Console.WriteLine(o.I.X)
}`
        Assert.Equal("5${Environment.NewLine}", CompileAndRun(source, library, "i3329lib7"))
    }

    @Fact
    func NestedStructInStruct_BothDeclaredInLibrary_OuterLiteralZeroInitsInnerMagicField() {
        // Issue #3329 x #3330 composition: PR #3330 (issue #3319) added
        // SAME-ASSEMBLY recursion so an outer struct literal's own
        // zero-value synthesis walks INTO an inner struct-typed field that
        // itself needs a magic-collection zero value. #3330 postdates this
        // PR's original design (which explicitly scoped that case OUT, see
        // the test above), so this pins the case the two fixes need to get
        // right TOGETHER: `Outer{}` constructed from ANOTHER (consumer)
        // assembly, where `Outer.I Inner` is left unset and `Inner` itself
        // has an unset magic-collection field — the composed zero value must
        // reach all the way through the cross-assembly reconstruction AND
        // the nested-struct recursion.
        const library = `package i3329lib8

struct Inner {
    public var Items []int32
}

struct Outer {
    public var I Inner
}`
        const source = `package i3329i
import i3329lib8

func Main() {
    let o = Outer{}
    System.Console.WriteLine(o.I.Items.Length)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib8"))
    }

    @Fact
    func DataStructNestedInStruct_BothDeclaredInLibrary_OuterLiteralZeroInitsInnerMagicField() {
        // Same composed shape as above, but the INNER struct is a `data
        // struct` (routes through ImportedTypeSymbol.BuildSemanticAggregate
        // on reconstruction, rather than ExpressionBinder.
        // BindImportedTypeObjectInitializer's plain-struct fallback) —
        // confirms the composition holds on both cross-assembly
        // reconstruction paths, not just the plain-struct one.
        const library = `package i3329lib9

data struct Inner {
    public var Items []int32
}

struct Outer {
    public var I Inner
}`
        const source = `package i3329j
import i3329lib9

func Main() {
    let o = Outer{}
    System.Console.WriteLine(o.I.Items.Length)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib9"))
    }

    @Fact
    func SameAssembly_StructLiteral_SliceField_RegressionPin() {
        // Control: a same-compilation struct literal must keep working
        // exactly as before (no library reference at all).
        const source = `package i3329h

struct S {
    public var Items []int32
}

func Main() {
    let s = S{}
    System.Console.WriteLine(s.Items.Length)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PlainStruct_MixedCompositeInitializerAddTouchesOmittedField_ZeroInitBeforeOrderedAdd() {
        // ADR-0180 reviewer finding: the ordered content-element/spread Add(...)
        // calls a mixed composite initializer lowers to (Basket{ Touches: 0, 1, 2,
        // ...extra }) must not run before this struct's own #3329/ADR-0159
        // magic-collection zero-value reconstruction — otherwise Add's own body,
        // which reads the omitted `Items` slice field, observes the raw (unsound)
        // CLR null instead of a zero-initialized empty slice and NREs on the very
        // first Add.
        const library = `package i3785lib1

struct Basket {
    public var Items []int32
    public var Touches int32
    func Add(item int32) {
        Touches = Touches + Items.Length + item
    }
}`
        const source = `package i3785a
import System.Collections.Generic
import i3785lib1

func Main() {
    let extra = List[int32]{ 3, 4 }
    let b = Basket{ Touches: 0, 1, 2, ...extra }
    System.Console.WriteLine(b.Touches)
    System.Console.WriteLine(b.Items.Length)
}`
        Assert.Equal("10${Environment.NewLine}0${Environment.NewLine}", CompileAndRun(source, library, "i3785lib1"))
    }

    @Theory
    @InlineData("", "Basket{ Touches: 0, 1, Items: []int32{ 2 }, Counts: map[string, int32]{ \"last\": 3 } }")
    @InlineData("data ", "Basket{ Touches: 0, 1, Items: []int32{ 2 }, Counts: map[string, int32]{ \"last\": 3 } }")
    @InlineData("", "Basket(){ .Touches: 0, 1, .Items: []int32{ 2 }, .Counts: map[string, int32]{ \"last\": 3 } }")
    @InlineData("data ", "Basket(){ .Touches: 0, 1, .Items: []int32{ 2 }, .Counts: map[string, int32]{ \"last\": 3 } }")
    func MixedInitializer_LaterExplicitMagicFieldsAreSoundBeforeAdd(modifier string, initializer string) {
        let library = (`package i3785later
` + "$modifier" + `struct Basket {
    public var Items []int32
    public var Counts map[string, int32]
    public var Touches int32
    func Add(item int32) {
        Touches = Touches + Items.Length + Counts.Count + item
    }
}`)
        let source = (`import i3785later
let value = ` + "$initializer" + `
System.Console.WriteLine(value.Touches)
System.Console.WriteLine(value.Items.Length)
System.Console.WriteLine(value.Counts.Count)`)
        Assert.Equal(
            "1${Environment.NewLine}1${Environment.NewLine}1${Environment.NewLine}",
            CompileAndRun(source, library, "i3785later")
        )
    }

    shared {
        private func CompileAndRun(
            source string,
            library string? = nil,
            libraryAssemblyName string? = nil,
            useReferenceAssembly bool = false
        ) string {
            let tempDir = Directory.CreateDirectory(
                Path.Combine(AppContext.BaseDirectory, "gs_3329_" + Guid.NewGuid().ToString("N"))
            )
                .FullName
            try {
                let dllPath = BuildExecutable(
                    tempDir,
                    source,
                    library,
                    libraryAssemblyName,
                    out var libDll,
                    useReferenceAssembly
                )
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                IlVerifier.Verify(
                    dllPath,
                    if libDll != nil {
                        []string{libDll}
                    } else {
                        default([]?string)
                    }
                )
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { }
            }
        }

        private func BuildExecutable(
            tempDir string,
            source string,
            library string?,
            libraryAssemblyName string?,
            out libDll string?,
            useReferenceAssembly bool
        ) string {
            libDll = nil
            var libReference string? = nil
            if library != nil {
                // ilverify resolves `-r` references by FILE NAME, so the library
                // must be written out under its assembly identity.
                let libSrc = Path.Combine(tempDir, libraryAssemblyName + ".gs")
                libDll = Path.Combine(tempDir, libraryAssemblyName + ".dll")
                File.WriteAllText(libSrc, library)
                let libraryArgs = List[string]{"/out:" + libDll, "/target:library", "/targetframework:net10.0", libSrc}
                if useReferenceAssembly {
                    libReference = Path.Combine(
                        Directory.CreateDirectory(Path.Combine(tempDir, "ref")).FullName,
                        libraryAssemblyName + ".dll"
                    )
                    libraryArgs.Add("/refout:" + libReference)
                }
                Compile(libraryArgs.ToArray())
                IlVerifier.Verify(libDll!!)
            }
            let srcPath = Path.Combine(tempDir, "test.gs")
            let dllPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0"}
            if libDll != nil {
                args.Add("/r:" + (libReference ?? libDll))
            }
            args.Add(srcPath)
            Compile(args.ToArray())
            return dllPath
        }

        private func Compile(args[]string) {
            let result = TryCompile(args)
            Assert.True(result.Code == 0, result.Output)
        }

        private func TryCompile(args[]string)(Code int32, Output string) {
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (compileExit, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
        }
    }
}
