package GSharp.Compiler.Tests

import System
import System.IO
import System.Text
import Xunit

class Issue5263UnsafeConstructorTests {
    @Theory
    @InlineData("conversion")
    @InlineData("receiver")
    @InlineData("extension")
    func MetadataOwner_DoesNotSupplyLexicalUnsafeContext(kind string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let isExtension = kind == "extension"
        let owner = if isExtension {
            "class"
        } else {
            "struct"
        }
        let annotation = if isExtension {
            "@ExtensionOwner(typeof(Owner))\n"
        } else {
            ""
        }
        let declaration = if kind == "conversion" {
            "func operator implicit(value Owner) int32"
        } else if kind == "receiver" {
            "func (value Owner) operator +(right Owner) int32"
        } else {
            "func (value string) Read() int32"
        }
        let invocation = if kind == "conversion" {
            "let value int32 = Owner{}"
        } else if kind == "receiver" {
            "let owner = Owner{}\n    let value = owner + owner"
        } else {
            "let value = \"owner\".Read()"
        }
        for modifier in[]string{"", "unsafe "} {
            let source = `package Metadata5263
import System
unsafe ` + owner + ` Owner {}
` + annotation + modifier + declaration + ` {
    fixed text *char = "X" { Console.Write(text[0]) }
    return 7
}
func Main() {
    ` + invocation + `
    Console.Write(value)
}`
            if modifier.Length == 0 {
                let (code, output) = fixture.TryCompile(source, "MetadataSafe5263", true)
                Assert.NotEqual(0, code)
                let line = if isExtension {
                    6
                } else {
                    5
                }
                Assert.Contains(
                    "MetadataSafe5263.gs($line,5,$line,10): error GS0400:",
                    output,
                    StringComparison.Ordinal
                )
                Assert.Equal(1, output.Split(": error ", StringSplitOptions.None).Length - 1)
                Assert.False(File.Exists(Path.Combine(fixture.Directory, "MetadataSafe5263.dll")))
            } else {
                let assembly = fixture.Compile(source, "MetadataUnsafe5263", true)
                IlVerifier.Verify(
                    assembly,
                    nil,
                    []string{
                        "UnmanagedPointer",
                        "StackUnexpected",
                        "StackByRef",
                        "ExpectedPtr",
                        "StackUnexpectedArrayType"
                    }
                )
                Assert.Equal(Encoding.UTF8.GetBytes("X7"), Encoding.UTF8.GetBytes(fixture.Run(assembly)))
            }
        }
    }

    @Theory
    @InlineData("class")
    @InlineData("struct")
    func UnsafeType_ConstructorsAndMembersInheritContext(kind string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package Unsafe5263
import System
internal unsafe ` + kind + ` Holder {
    internal init(value string) {
        fixed text *char = value { Console.Write(text[0]) }
    }
    func Read(value string) {
        fixed text *char = value { Console.Write(text[0]) }
    }
    shared {
        init {
            fixed text *char = "S" { Console.Write(text[0]) }
        }
        func ReadStatic(value string) {
            fixed text *char = value { Console.Write(text[0]) }
        }
    }
}
func Main() {
    let holder = Holder("C")
    holder.Read("M")
    Holder.ReadStatic("F")
}`
        let assembly = fixture.Compile(source, "Members5263", true)
        IlVerifier.Verify(
            assembly,
            nil,
            []string{"UnmanagedPointer", "StackUnexpected", "StackByRef", "ExpectedPtr", "StackUnexpectedArrayType"}
        )
        Assert.Equal(Encoding.UTF8.GetBytes("SCMF"), Encoding.UTF8.GetBytes(fixture.Run(assembly)))
    }

    @Fact
    func PartialAndNestedConstructors_KeepLexicalContext() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let part = Path.Combine(fixture.Directory, "Part.gs")
        File.WriteAllText(part, `package Unsafe5263
unsafe partial class Outer { }`)
        let assembly = fixture.Compile(`package Unsafe5263
import System
partial class Outer {
    init(value string) {
        fixed text *char = value { Console.Write(text[0]) }
    }
    interface Reader {
        func ReadInterface() {
            fixed text *char = "I" { Console.Write(text[0]) }
        }
    }
    class Inner : Reader {
        init(value string) {
            fixed text *char = value { Console.Write(text[0]) }
        }
        func Read() {
            fixed text *char = "M" { Console.Write(text[0]) }
        }
        prop Value char {
            get {
                fixed text *char = "G" { return text[0] }
            }
        }
        shared {
            init {
                fixed text *char = "S" { Console.Write(text[0]) }
            }
        }
    }
}
func Main() {
    let outer = Outer("P")
    let inner = Outer.Inner("N")
    inner.Read()
    Console.Write(inner.Value)
    let reader Outer.Reader = inner
    reader.ReadInterface()
}`, "Nested5263", true, part)
        IlVerifier.Verify(
            assembly,
            nil,
            []string{"UnmanagedPointer", "StackUnexpected", "StackByRef", "ExpectedPtr", "StackUnexpectedArrayType"}
        )
        Assert.Equal(Encoding.UTF8.GetBytes("PSNMGI"), Encoding.UTF8.GetBytes(fixture.Run(assembly)))
    }

    @Fact
    func ConstructorInitializers_KeepUnsafePointerType() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`package Unsafe5263
import System
open unsafe class Base {
    init(value *int32) { Console.Write(value == nil) }
}
unsafe class Explicit : Base {
    init() : base(default(*int32)) { }
}
unsafe class Primary() : Base(default(*int32)) { }
unsafe class Fields {
    var Value *int32 = default(*int32)
    shared { var StaticValue *int32 = default(*int32) }
    init() { Console.Write(Value == nil) }
}
func Main() {
    let explicitValue = Explicit()
    let primaryValue = Primary()
    let fields = Fields()
}`, "Initializers5263", true)
        IlVerifier.Verify(
            assembly,
            nil,
            []string{"UnmanagedPointer", "StackUnexpected", "StackByRef", "ExpectedPtr", "StackUnexpectedArrayType"}
        )
        Assert.Equal(Encoding.UTF8.GetBytes("TrueTrueTrue"), Encoding.UTF8.GetBytes(fixture.Run(assembly)))
    }

    @Theory
    @InlineData("class Safe", "}")
    @InlineData("class Container { class Safe", "} }")
    func SafeConstructors_RejectFixedWithoutEmitting(header string, footer string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile("unsafe class Unrelated {}\n" + header + ` {
    init(value string) {
        fixed text *char = value {}
    }
` + footer, "Safe5263", false)
        Assert.NotEqual(0, code)
        Assert.Contains("Safe5263.gs(4,9,4,14): error GS0400:", output, StringComparison.Ordinal)
        Assert.Equal(1, output.Split(": error ", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Safe5263.dll")))
    }
}
