package GSharp.Compiler.Tests

import System
import System.IO
import System.Linq
import System.Text
import Xunit

class Issue6015GenericConstructorConstraintTests {
    @Theory
    @InlineData("let items = List[Token]()", "(4,18,4,23)")
    @InlineData("let items = System.Collections.Generic.List[Token]()", "(4,45,4,50)")
    @InlineData("class Box[T] {}\nlet item = Box[Token]()", "(5,16,5,21)")
    @InlineData("class Box[T] { init() {} }\nlet item = Box[Token]()", "(5,16,5,21)")
    @InlineData("class Box[T](Value T) {}\nlet item = Box(Token{})", "(5,12,5,15)")
    @InlineData("class Box[T] { init(value T) {} }\nlet item = Box(Token{})", "(5,12,5,15)")
    @InlineData("func make[T]() { let items = Dictionary[T, Token]() }\nlet done = 0", "(4,44,4,49)")
    @InlineData("class Outer[T] { class Inner {} }\nlet item = Outer[Token].Inner()", "(5,18,5,23)")
    @InlineData("class Outer[T] { class Inner {} }\nlet item = Outer[ReadOnlySpan[int32]].Inner()", "(5,18,5,37)")
    @InlineData(
        "class Outer[T] { class Middle[U] { class Inner {} } }\nlet item = Outer[int32].Middle[Token].Inner()",
        "(5,32,5,37)"
    )
    @InlineData(
        "class Outer[T] { class Middle[U] { class Inner {} } }\nlet item = Outer[int32].Middle[Token].Inner{}",
        "(5,32,5,37)"
    )
    @InlineData(
        "class Outer[T] { class Middle[U] { class Inner {} } }\nlet item = Outer[int32].Middle[ReadOnlySpan[int32]].Inner()",
        "(5,32,5,51)"
    )
    func OrdinaryConstructorsRejectSymbolicRefStructArguments(body string, span string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = "import System\nimport System.Collections.Generic\nref struct Token { var Value int32 }\n" + body
        let (code, output) = fixture.TryCompile(source, "Constructor6015", executable: true)
        Assert.NotEqual(0, code)
        let diagnostic = Assert.Single(
            output.Split('\n').Where((line string) -> line.Contains(": error ", StringComparison.Ordinal))
        )
        Assert.Contains("Constructor6015.gs" + span + ": error GS0219:", diagnostic, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Constructor6015.dll")))
    }

    @Theory
    @InlineData("()")
    @InlineData(".Value")
    func NestedConstructionUsesTheOwnParameterAdmissionFlag(tail string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`namespace Constraints6015;
public class Outer<T> {
    public class Inner<U> { public static int Value => 23; }
}
`, "Constraints6015")
        let (code, output) = fixture.TryCompile(`import Constraints6015
ref struct Token { var Value int32 }
let item = Outer[int32].Inner[Token]TAIL
`.Replace("TAIL", tail), "Nested6015", executable: true, "/reference:" + library)
        Assert.NotEqual(0, code)
        let diagnostic = Assert.Single(
            output.Split('\n').Where((line string) -> line.Contains(": error ", StringComparison.Ordinal))
        )
        Assert.True(diagnostic.Contains("Nested6015.gs(3,31,3,36): error GS0219:", StringComparison.Ordinal), output)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Nested6015.dll")))
    }

    @Theory
    @InlineData("string")
    @InlineData("[]string")
    func ImportedNestedStaticAccessKeepsFlattenedAndOwnArgumentsSeparate(argument string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`namespace Receiver6015;
public class Outer<T> {
    public class Inner<U> { public static int Value => 23; }
}
`, "Receiver6015")
        let assembly = fixture.Compile(`import System
import Receiver6015
Console.Write(Outer[int32].Inner[ARGUMENT].Value)
`.Replace("ARGUMENT", argument), "Receiver6015Consumer", executable: true, "/reference:" + library)
        IlVerifier.Verify(assembly, []string{library})
        Assert.Equal(Encoding.UTF8.GetBytes("23"), fixture.RunBytes(assembly))
    }

    @Fact
    func ValidSourceOpenOwnerAndAllowsRefStructConstructionsExecute() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`namespace Allowed6015;
public class Allowed<T> where T : allows ref struct {
    public int Value => 7;
}
public class LibraryOuter<T> {
    public class Allowed<U> where U : allows ref struct {
        public int Value => 9;
        public static int StaticValue => 11;
    }
}
`, "Allowed6015")
        let assembly = fixture.Compile(`import System
import System.Collections.Generic
import Allowed6015
ref struct Token { var Value int32 }
class Node {}
class Box[T] {}
class Explicit[T] { init() {} }
class Outer[T] {
    class Inner {}
    class Middle[U] { class Inner {} }
}
class Holder[T] {
    func Make() int32 {
        let items = List[T]()
        let item = Explicit[T]()
        return items.Count
    }
}
func make[T]() int32 {
    let items = List[T]()
    let item = Box[T]()
    let nested = Outer[T].Inner()
    let composite = Outer[List[T]].Inner()
    let intermediate = Outer[T].Middle[T].Inner()
    return items.Count
}
let items = List[Node]()
items.Add(Node())
let item = Box[Node]()
Console.Write(items.Count)
Console.Write("|")
Console.Write(make[Node]())
Console.Write("|")
Console.Write(Holder[Node]().Make())
Console.Write("|")
Console.Write(Allowed[Token]().Value)
Console.Write("|")
Console.Write(LibraryOuter[int32].Allowed[Token]().Value)
Console.Write("|")
Console.Write(LibraryOuter[int32].Allowed[Token].StaticValue)
`, "Valid6015", executable: true, "/reference:" + library)
        IlVerifier.Verify(library)
        IlVerifier.Verify(assembly, []string{library})
        Assert.Equal(Encoding.UTF8.GetBytes("1|0|0|7|9|11"), fixture.RunBytes(assembly))
    }
}
