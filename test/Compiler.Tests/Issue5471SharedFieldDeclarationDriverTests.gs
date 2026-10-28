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
}
