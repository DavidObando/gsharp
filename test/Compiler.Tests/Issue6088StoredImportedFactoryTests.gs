package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.Text
import Xunit

class Issue6088StoredImportedFactoryTests {
    @Fact
    func ImportedGenericFactory_PreservesStoredDelegatesAndSingleInvocation() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.Compile(`package Fixture6088
import System
public open class Cell {
    shared {
        public func Mount[TInput any, TCell Cell[TInput]](key string?, input TInput, factory Func[TCell]) object -> factory()
    }
}
public open class Cell[TInput] : Cell { }
`, "Fixture6088", executable: false)
        let consumer = fixture.Compile(`import System
import Fixture6088
data struct Input { var Value int32 }
class Child : Cell[Input] { }
shared class Program {
    var Calls int32
    var Reads int32
    let Expected Child = Child()
    func Create() Child {
        Calls++
        return Expected
    }
    func ReadFactory() Func[Child] {
        Reads++
        return () -> Create()
    }
    func MountLocal(factory Func[Child]) Child -> factory()
    func Main() {
        let factory Func[Child] = () -> Create()
        Console.WriteLine(object.ReferenceEquals(Expected, Cell.Mount[Input, Child]("stored", Input{}, factory)))
        Console.WriteLine(Calls)
        Console.WriteLine(object.ReferenceEquals(Expected, Cell.Mount[Input, Child](factory: factory, input: Input{}, key: "named")))
        Console.WriteLine(Calls)
        Console.WriteLine(object.ReferenceEquals(Expected, Cell.Mount[Input, Child]("read", Input{}, ReadFactory())))
        Console.WriteLine(Calls)
        Console.WriteLine(Reads)
        Console.WriteLine(object.ReferenceEquals(Expected, MountLocal(factory)))
        Console.WriteLine(Calls)
        Console.WriteLine(object.ReferenceEquals(Expected, Cell.Mount[Input, Child]("inline", Input{}, () -> Create())))
        Console.WriteLine(Calls)
        let structural () -> Child = () -> Create()
        Console.WriteLine(object.ReferenceEquals(Expected, Cell.Mount[Input, Child]("structural", Input{}, structural)))
        Console.WriteLine(Calls)
    }
}
`, "Consumer6088", executable: true, "/r:" + library)
        IlVerifier.Verify(consumer, []string{library})
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                "True\n1\nTrue\n2\nTrue\n3\n1\nTrue\n4\nTrue\n5\nTrue\n6\n".Replace("\n", Environment.NewLine)
            ),
            fixture.RunBytes(consumer)
        )
    }
}
