package GSharp.Compiler.Tests

import Xunit

class Issue5471SharedFieldDeclarationDriverTests {
    @Fact
    func DefaultBody_MutatesLaterSharedField() {
        const source = `interface IBox[T] {
    func Echo(value T) T {
        Trace.Events += "D"
        return value
    }
}
class Trace { shared { var Events string = "" } }
class Default : IBox[int32] { }
let item IBox[int32] = Default()
System.Console.Write(item.Echo(9))
System.Console.Write("|")
System.Console.Write(Trace.Events)
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "9|D", "5471")
    }

    @Theory
    @InlineData("int32", "9", "9", false)
    @InlineData("int32", "9", "9", true)
    @InlineData("string", `"value"`, "value", false)
    @InlineData("string", `"value"`, "value", true)
    func DefaultBody_PreservesSharedStorageInitializationAndEffects(
        type string,
        argument string,
        expected string,
        storageFirst bool
    ) {
        const declarations = `open class Storage {
    var Instance int32 = 3
    prop Number int32 { get; set; }
    shared {
        var Events string = Initialize()
        var Calls int32 = 0
        func Initialize() string {
            System.Console.Write("I")
            return "i"
        }
        func Mark() string {
            Calls++
            System.Console.Write("S")
            return "D"
        }
    }
}
class Trace : Storage { }
`
        const interfaces = `interface IBox[T] {
    func Echo(value T) T {
        Trace.Events += Trace.Mark()
        return value
    }
}
interface Forward[T] : IBox[T] {
    func Read(value T) T { return Echo(value) }
}
`
        let source = (
            if storageFirst {
                declarations + interfaces
            } else {
                interfaces + declarations
            }
        ) +
            `
class Default : Forward[` +
            type +
            `] { }
class Factory {
    shared {
        func Target() Forward[` +
            type +
            `] {
            Trace.Events += "R"
            return Default()
        }
        func Argument() ` +
            type +
            ` {
            Trace.Events += "A"
            return ` +
            argument +
            `
        }
    }
}
System.Console.Write(Factory.Target().Read(Factory.Argument()))
System.Console.Write("|")
System.Console.Write(Trace.Events)
System.Console.Write("|")
System.Console.Write(Trace.Calls)
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "IS" + expected + "|iRAD|1", "5471")
    }

    @Fact
    func DefaultBody_PreservesLaterInstanceFieldRowAndEffects() {
        const source = `interface IEditor {
    func Edit(value Payload) int32 {
        let before = value.Target
        value.Target += Trace.Delta()
        return before
    }
}
class Payload {
    var Sentinel int32 = 41
    var Target int32 = 7
}
class Trace {
    shared {
        var Item Payload = Payload()
        var Events string = ""
        var Calls int32 = 0
        func Receiver() Payload {
            Events += "R"
            return Item
        }
        func Delta() int32 {
            Events += "D"
            Calls++
            return 3
        }
    }
}
class Default : IEditor { }
let editor IEditor = Default()
System.Console.Write(editor.Edit(Trace.Receiver()))
System.Console.Write("|")
System.Console.Write(Trace.Item.Target)
System.Console.Write("|")
System.Console.Write(Trace.Item.Sentinel)
System.Console.Write("|")
System.Console.Write(Trace.Events)
System.Console.Write("|")
System.Console.Write(Trace.Calls)
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "7|10|41|RD|1", "5471")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func DefaultBody_PreservesInheritedFieldBackedClrProperty(derivedFirst bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = System.IO.Path.Combine(fixture.Directory, "InheritedContract.ref.dll")
        let implementation = fixture.CompileCSharpWithReference(`namespace InheritedContract {
public interface IValue { int Value { get; set; } }
public static class Probe {
    public static int Add(IValue item, int amount) {
        item.Value += amount;
        return item.Value;
    }
}
}`, "InheritedContract", reference)
        const baseType = `open class Base {
    var Before int32 = 41
    var Value int32 = 7
    var After int32 = 43
}
`
        const derivedType = `class Derived : Base, InheritedContract.IValue {
    var Own int32 = 97
}
`
        let source = `interface IEditor {
    func Edit(value Base) int32 {
        let before = value.Value
        value.Value += Trace.Delta()
        return before
    }
}
` + (
            if derivedFirst {
                derivedType + baseType
            } else {
                baseType + derivedType
            }
        ) + `
class Tail { var Canary int32 = 89 }
class Trace {
    shared {
        var Item Derived = Derived()
        var Events string = ""
        var Calls int32 = 0
        func Receiver() Derived {
            Events += "R"
            return Item
        }
        func Delta() int32 {
            Events += "D"
            Calls++
            return 3
        }
    }
}
class Default : IEditor { }
let editor IEditor = Default()
System.Console.Write(editor.Edit(Trace.Receiver()))
let inherited Base = Trace.Item
System.Console.Write("|")
System.Console.Write(inherited.Value)
System.Console.Write("|")
System.Console.Write(inherited.Before)
System.Console.Write("|")
System.Console.Write(inherited.After)
System.Console.Write("|")
System.Console.Write(Trace.Item.Own)
System.Console.Write("|")
System.Console.Write(Tail().Canary)
System.Console.Write("|")
System.Console.Write(InheritedContract.Probe.Add(Trace.Item, 5))
System.Console.Write("|")
System.Console.Write(inherited.Value)
System.Console.Write("|")
System.Console.Write(Trace.Events)
System.Console.Write("|")
System.Console.Write(Trace.Calls)
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(
            source,
            "7|10|41|43|97|89|15|15|RD|1",
            "5471",
            reference,
            implementation
        )
    }
}
