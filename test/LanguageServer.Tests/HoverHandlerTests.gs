// <copyright file="HoverHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Documentation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.IO
import System.Linq
import System.Reflection
import System.Threading
import Xunit

open class HoverHandlerTests {
    @Fact
    func ComputeHover_DestructuredLambdaParameterElement_ResolvesToItsOwnLocal_NotAShadowedOuterSymbol() {
        // Review finding (Copilot, PR #4317): a destructured arrow-lambda
        // parameter's element identifiers were invisible to
        // SemanticLookup.ComputeFunctionLocals (its syntax-side node
        // collection only walks the lambda's BODY, and a destructured
        // pattern lives in the PARAMETER LIST, a sibling of the body, not a
        // descendant of it) — so a same-named outer local would silently
        // win hover resolution instead. Outer `x` is STRING, the
        // destructured element `x` is INT32: the hover text disambiguates
        // which symbol actually resolved. (A same-typed regression test
        // here would not actually prove anything -- both wrong and right
        // resolution look identical when the two locals share a type.)
        const source = `package P
func main() int32 {
    let x = "hello"
    let f = ((x int32, y int32)) -> x + y
    return f((1, 2))
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let outerDeclHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "x", 0)
        )
        let elementDeclHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "x", 1)
        )
        let useInsideLambdaHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "x", 2)
        )
        Assert.NotNull(outerDeclHover)
        Assert.Contains("string", outerDeclHover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.NotNull(elementDeclHover)
        Assert.Contains("int32", elementDeclHover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.DoesNotContain("string", elementDeclHover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.NotNull(useInsideLambdaHover)
        Assert.Contains("int32", useInsideLambdaHover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.DoesNotContain("string", useInsideLambdaHover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_ForTupleLoopDestructuredElement_ResolvesToItsOwnLocal_NotAShadowedOuterSymbol() {
        // The pre-existing `for (a, b) in coll` deconstructing loop (issue
        // #1922) shares the exact same underlying binder helper
        // (StatementBinder.BindForTupleLoopPrelude) as the ADR-0185
        // destructured lambda parameter above, and had the identical,
        // pre-existing hover bug for the identical reason (its declarations
        // carried no real Syntax reference to match against). Fixed by the
        // same change; pinned here so it does not regress.
        const source = `package P
func main() int32 {
    let x = "hello"
    var total = 0
    var pairs = [](int32, int32){(1, 2)}
    for (x, y) in pairs {
        total = total + x + y
    }
    return total
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let outerDeclHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "x", 0)
        )
        let loopVarDeclHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "x", 1)
        )
        let loopVarUseHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "x", 2)
        )
        Assert.NotNull(outerDeclHover)
        Assert.Contains("string", outerDeclHover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.NotNull(loopVarDeclHover)
        Assert.Contains("int32", loopVarDeclHover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.DoesNotContain("string", loopVarDeclHover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.NotNull(loopVarUseHover)
        Assert.Contains("int32", loopVarUseHover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.DoesNotContain("string", loopVarUseHover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_DisplaysConstructedSourceGenericType() {
        const source = `class Box[T] {}
func main() {
    let box = Box[int32]()
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "box"))
        Assert.NotNull(hover)
        Assert.Contains("Box[int32]", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_DeclarationHeadersUseSourceGenericSyntaxAndConstruction() {
        const source = `package P
class Box[T] { var Value T }
func Use(value Box[int32]) {}
`
        let content = LanguageServerTestHelpers.Content(source)
        let definitionHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Box")
        )
        let constructionHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Box", 1)
        )
        Assert.Contains(
            "class P.Box[T] { var Value T }",
            definitionHover!!.Contents.ToString(),
            StringComparison.Ordinal
        )
        Assert.Contains(
            "class P.Box[int32] { var Value int32 }",
            constructionHover!!.Contents.ToString(),
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("<T>", definitionHover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_DistinguishesNestedEnumConstructions() {
        const source = `package P
struct Outer[T] { enum Color { Red } }
func I(c Outer[int32].Color) {}
func S(c Outer[string].Color) {}
`
        let content = LanguageServerTestHelpers.Content(source)
        let intHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Color", 1)
        )
        let stringHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Color", 2)
        )
        Assert.Contains("enum P.Outer[int32].Color { Red }", intHover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.Contains(
            "enum P.Outer[string].Color { Red }",
            stringHover!!.Contents.ToString(),
            StringComparison.Ordinal
        )
    }

    @Fact
    func ComputeHover_PreservesConstructedTypesAcrossDeclarationTypeClauses() {
        const source = `package P
class Box[T] {}
class Holder {
    var Field Box[string]
    func Method() Box[bool] { return Box[bool]() }
}
func Global() Box[float64] { return Box[float64]() }`
        let content = LanguageServerTestHelpers.Content(source)
        let fieldHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Box", 1)
        )
        let methodHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Box", 2)
        )
        let globalHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Box", 4)
        )
        Assert.Contains("class P.Box[string]", fieldHover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.Contains("class P.Box[bool]", methodHover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.Contains("class P.Box[float64]", globalHover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_PreservesRectangularArrayRank() {
        const source = `package P
func Read(matrix [,]int32) int32 { return matrix[0, 1] }
`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "matrix"))
        Assert.NotNull(hover)
        Assert.Contains("(parameter) matrix [,]int32", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_PreservesConstructedTypesInsideCompositeTypeClauses() {
        const source = `package P
class Box[T] {}
func Composite(
    m map[string, Box[int32]],
    f (Box[bool]) -> Box[string],
    t (Box[float64], Box[uint8])) {}`
        let content = LanguageServerTestHelpers.Content(source)
        let expected = []string{"int32", "bool", "string", "float64", "uint8"}
        for var i = 0; i < expected.Length; i++ {
            let hover Hover? = HoverComputer.ComputeHover(
                content,
                LanguageServerTestHelpers.PositionOf(source, "Box", i + 1)
            )
            Assert.Contains("class P.Box[${expected[i]}]", hover!!.Contents.ToString(), StringComparison.Ordinal)
        }
    }

    @Fact
    func ComputeHover_HonorsCancellation() {
        // Issue #1662: ComputeHover accepted a CancellationToken but never observed it. On a
        // cold compilation the first ResolveSymbol call triggers the (potentially expensive)
        // whole-workspace SemanticModel build; an already-cancelled token must short-circuit
        // that build instead of returning a result.
        const source = `func add(a int32, b int32) int32 { return a + b }
var x = add(1, 2)
`
        let content = LanguageServerTestHelpers.Content(source)
        using let cts = CancellationTokenSource()
        cts.Cancel()
        Assert.Throws[OperationCanceledException](
            func () object? {
                return HoverComputer.ComputeHover(
                    content,
                    LanguageServerTestHelpers.PositionOf(source, "add"),
                    cts.Token
                )
            }
        )
    }

    @Theory
    @InlineData("let answer = 42\n", "answer", "let answer int32")
    @InlineData("var count = 0\n", "count", "var count int32")
    @InlineData("func add(a int32, b int32) int32 { return a + b }\n", "add", "func add(a int32, b int32) int32")
    @InlineData("func greet(name string) { }\n", "name", "name string")
    @InlineData(`struct Point {
var X int32
var Y int32
}
`, "Point", "struct Point { var X int32; var Y int32 }")
    @InlineData("enum Color { Red, Green }\n", "Color", "enum Color { Red, Green }")
    @InlineData(`import System
func main() {
Console.WriteLine("hi")
}
`, "Console", "class System.Console")
    func ComputeHover_ReturnsMarkdownSignature(source string, token string, expected string) {
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, token))
        Assert.NotNull(hover)
        Assert.Contains(expected, hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_ResolvesLocalDeclaredInsideGeneralBlockExpression() {
        const source = `func run() int32 {
let answer = { let inner = 42
inner }
return answer
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "inner", 1))
        Assert.NotNull(hover)
        Assert.Contains("(local variable) inner int32", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Theory
    @InlineData(`package P
class Person {
    prop Name string
}
`, "Name")
    @InlineData(`package P
import sys = System
`, "sys")
    @InlineData("package Outer.Inner\n", "Outer")
    @InlineData("package Outer.Inner\n", "Inner")
    @InlineData(`package P
import System
class Foo {
  event Click (Object, EventArgs) -> void
}
`, "Click")
    func ComputeHover_ResolvesPropertyImportPackageAndEventSymbols(source string, token string) {
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, token))
        Assert.NotNull(hover)
        Assert.Contains(token, hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Theory
    @InlineData("func greet(name string) { }\n", "name", "(parameter) name string")
    @InlineData(`func f() {
var x = 5
x = x + 1
}
`, "x", "(local variable) x int32")
    @InlineData("enum Color { Red, Green }\n", "Red", "Color.Red = 0")
    @InlineData("enum Color { Red, Green }\n", "Green", "Color.Green = 1")
    @InlineData(`package P
import sys = System
`, "sys", "import sys = System")
    @InlineData("package Outer.Inner\n", "Inner", "package Outer.Inner")
    func ComputeHover_RendersEnrichedDescriptors(source string, token string, expected string) {
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, token))
        Assert.NotNull(hover)
        Assert.Contains(expected, hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_RendersPropertyAccessors() {
        const source = `package P
class Person {
    prop Name string
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Name"))
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("Name string {", value, StringComparison.Ordinal)
        Assert.Contains("get;", value, StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_ResolvesPropertyOnUserDefinedClass() {
        const source = `package P
class Person {
    /// The name
    prop Name string
}
func Main() {
    var person = Person{}
    var n = person.Name
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Name", 1))
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("Name string", value, StringComparison.Ordinal)
        Assert.Contains("The name", value, StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_ResolvesFieldOnUserDefinedStruct() {
        const source = `package P
struct Point {
    /// X coordinate
    var X int32
    var Y int32
}
func Main() {
    var p = Point{}
    var x = p.X
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "X", 1))
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("X int32", value, StringComparison.Ordinal)
        Assert.Contains("X coordinate", value, StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_ResolvesMethodOnUserDefinedClass() {
        const source = `package P
class Person {
    prop Name string
    /// Says hello
    func Greet() string { return "hi" }
}
func Main() {
    var person = Person{}
    person.Greet()
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Greet", 1))
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("Greet", value, StringComparison.Ordinal)
        Assert.Contains("Says hello", value, StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_ResolvesChainedUserDefinedAndClrMembers() {
        const source = `package P
class Person {
    /// The name of the person
    prop Name string
}
func Main() {
    var person = Person{}
    var y = person.Name.GetType()
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let nameHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Name", 1)
        )
        Assert.NotNull(nameHover)
        let nameValue = nameHover!!.Contents.ToString()
        Assert.Contains("Name string", nameValue, StringComparison.Ordinal)
        Assert.Contains("The name of the person", nameValue, StringComparison.Ordinal)
        let getTypeHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "GetType")
        )
        Assert.NotNull(getTypeHover)
        Assert.Contains("GetType", getTypeHover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_ResolvesFieldAssignmentOnUserDefinedClass() {
        const source = `package P
class Person {
    /// The age of the person
    prop Age int32
}
func Main() {
    var person = Person{}
    person.Age = 30
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Age", 1))
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("Age int32", value, StringComparison.Ordinal)
        Assert.Contains("The age of the person", value, StringComparison.Ordinal)
    }

    @Theory
    @InlineData(`func main() {
    let x = 42
}
`, "42", "int32")
    @InlineData(`func main() {
    let x = 3.14
}
`, "3.14", "float64")
    @InlineData(`func main() {
    let x = "hello"
}
`, "\"hello\"", "string")
    @InlineData(`func main() {
    let x = true
}
`, "true", "bool")
    @InlineData(`func main() {
    let x = false
}
`, "false", "bool")
    func ComputeHover_ShowsLiteralType(source string, token string, expectedType string) {
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, token))
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains(expectedType, value, StringComparison.Ordinal)
        Assert.Contains(token, value, StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_RendersImportedClrInstancePropertyDocumentation() {
        const source = `import System.Text
func main() {
    var sb = StringBuilder()
    var length = sb.Length
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Length"))
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("System.Text.StringBuilder.Length", value, StringComparison.Ordinal)
        Assert.Contains("int32", value, StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_RendersImportedClrFieldDocumentation() {
        const source = `import System
func main() {
    var pi = Math.PI
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "PI"))
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("System.Math.PI", value, StringComparison.Ordinal)
        Assert.Contains("float64", value, StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_RendersImportedClrEventDocumentation() {
        const source = `import System
func handler(sender Object, args ConsoleCancelEventArgs) { }
func main() {
    Console.CancelKeyPress += handler
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "CancelKeyPress")
        )
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("event", value, StringComparison.Ordinal)
        Assert.Contains("System.Console.CancelKeyPress", value, StringComparison.Ordinal)
        Assert.Contains("System.ConsoleCancelEventHandler", value, StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_RendersImportedClrMethodDocumentation() {
        const source = `import System
func main() {
    Console.WriteLine("hi")
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "WriteLine")
        )
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("func", value, StringComparison.Ordinal)
        Assert.Contains("System.Console", value, StringComparison.Ordinal)
        Assert.Contains("WriteLine", value, StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_ResolvesAnnotationName_WithAttributeSuffixFallback() {
        const source = `@Obsolete("Use NewApi")
func OldApi() { }
`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Obsolete"))
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("ObsoleteAttribute", value, StringComparison.Ordinal)
        Assert.Contains("System", value, StringComparison.Ordinal)
    }

    @Fact
    func AssemblyDocumentationProvider_ResolvesClrMemberDocsFromReferencePack() {
        let resolver = CreateReferencePackResolver()
        Assert.True(resolver.TryResolveType("System.Console", out var consoleType))
        Assert.True(resolver.TryResolveType("System.Math", out var mathType))
        Assert.True(resolver.TryResolveType("System.Text.StringBuilder", out var stringBuilderType))
        let title PropertyInfo? = consoleType.GetProperty("Title", BindingFlags.Public | BindingFlags.Static)
        let cancelKeyPress EventInfo? = consoleType.GetEvent(
            "CancelKeyPress",
            BindingFlags.Public | BindingFlags.Static
        )
        let writeLine = consoleType.GetMethods(BindingFlags.Public | BindingFlags.Static).First(
            (m MethodInfo) -> m.Name == "WriteLine" && m.GetParameters().Length == 1
        )
        let pi FieldInfo? = mathType.GetField("PI", BindingFlags.Public | BindingFlags.Static)
        let length PropertyInfo? = stringBuilderType.GetProperty("Length", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(title)
        Assert.NotNull(cancelKeyPress)
        Assert.NotNull(writeLine)
        Assert.NotNull(pi)
        Assert.NotNull(length)
        Assert.NotEmpty(AssemblyDocumentationProvider.Resolve(title!!)!!.Summary)
        Assert.NotEmpty(AssemblyDocumentationProvider.Resolve(cancelKeyPress!!)!!.Summary)
        Assert.NotEmpty(AssemblyDocumentationProvider.Resolve(writeLine)!!.Summary)
        Assert.NotEmpty(AssemblyDocumentationProvider.Resolve(pi!!)!!.Summary)
        Assert.NotEmpty(AssemblyDocumentationProvider.Resolve(length!!)!!.Summary)
    }

    @Fact
    func ComputeHover_DoesNotAnnotateOverloadsForSingleFunction() {
        const source = "func add(a int32, b int32) int32 { return a + b }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "add"))
        Assert.NotNull(hover)
        Assert.DoesNotContain("overload", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_ThisKeyword_InsideClassMethod_ResolvesToReceiver() {
        const source = `package P
class Person {
    prop Name string
    func ToString() string {
        return "${this.Name}"
    }
}
`
        let content = LanguageServerTestHelpers.Content(source)
        // Hover on 'this' should resolve to the implicit receiver parameter.
        let hoverThis Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "this"))
        Assert.NotNull(hoverThis)
        Assert.Contains("Person", hoverThis!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_MemberAccess_ViaThis_InsideClassMethod() {
        const source = `package P
class Person {
    prop Name string
    func ToString() string {
        return "${this.Name}"
    }
}
`
        let content = LanguageServerTestHelpers.Content(source)
        // Hover on 'Name' in 'this.Name' should resolve to the property.
        let hoverName Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Name", 1)
        )
        Assert.NotNull(hoverName)
        Assert.Contains("Name", hoverName!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.Contains("string", hoverName!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_ImplicitThis_BarePropertyName_InsideClassMethod() {
        const source = `package P
class Person {
    prop Name string
    prop Age int32
    func Greet() string {
        return Name
    }
}
`
        let content = LanguageServerTestHelpers.Content(source)
        // Hover on bare 'Name' inside method body should resolve to the property via implicit this.
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Name", 1))
        Assert.NotNull(hover)
        Assert.Contains("Name", hover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.Contains("string", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_ExtensionMethodInvocation_ResolvesToMethod_NotSameNamedType() {
        // Issue #891 (Problem C): hovering the `Single` LINQ extension method must
        // resolve to that method, not to the type `System.Single` (float32) which
        // merely shares the name. Regression: previously hover showed
        // "struct float32 / Represents a single-precision floating-point number.".
        const source = "package P\n" +
            "import System\n" +
            "import System.Linq\n" +
            "import System.Collections.Generic\n" +
            "func main() {\n" +
            "    let nums = List[int32]()\n" +
            "    nums.Add(1)\n" +
            "    let found = nums.Single((x) -> x == 1)\n" +
            "    Console.WriteLine(found)\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Single"))
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("Single", value, StringComparison.Ordinal)
        Assert.DoesNotContain("float32", value, StringComparison.Ordinal)
        Assert.DoesNotContain("single-precision", value, StringComparison.OrdinalIgnoreCase)
    }

    @Fact
    func ComputeHover_ExtensionMethodInvocation_DoesNotResolveToSameNamedStaticMethod() {
        // Issue #906: hovering an extension method invoked on a value receiver
        // (`a.Concat(b)` -> System.Linq.Enumerable.Concat) must not bind to an
        // unrelated, same-named *static* method that happens to appear elsewhere
        // in the program (`string.Concat(...)` -> System.String.Concat). The
        // whole-program same-name scan previously returned whichever bound call
        // it found first, ignoring which call the hovered token belonged to.
        const source = "package P\n" +
            "import System\n" +
            "import System.Linq\n" +
            "import System.Collections.Generic\n" +
            "func main() {\n" +
            "    let s = String.Concat(\"x\", \"y\")\n" +
            "    let a = List[int32]()\n" +
            "    let b = List[int32]()\n" +
            "    let joined = a.Concat(b)\n" +
            "    Console.WriteLine(s)\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        // Hover the `Concat` of the extension invocation `a.Concat(b)` (2nd occurrence):
        // its value receiver means it must bind to the LINQ extension method, never to
        // the unrelated same-named static `String.Concat`.
        let extHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Concat", 1)
        )
        Assert.NotNull(extHover)
        let extValue = extHover!!.Contents.ToString()
        Assert.Contains("Concat", extValue, StringComparison.Ordinal)
        Assert.Contains("Enumerable", extValue, StringComparison.Ordinal)
        // Hover the `Concat` of the static invocation `String.Concat("x", "y")` (1st occurrence):
        // its type-name receiver means it must bind to the static `String.Concat`, never
        // to the same-named LINQ extension method.
        let staticHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Concat", 0)
        )
        Assert.NotNull(staticHover)
        let staticValue = staticHover!!.Contents.ToString()
        Assert.Contains("Concat", staticValue, StringComparison.Ordinal)
        Assert.DoesNotContain("Enumerable", staticValue, StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_DottedChainExtensionInvocation_ResolvesToExtension_NotSameNamedStatic() {
        // Issue #906: the user's real failing shape is a *dotted-chain* value
        // receiver — `report.Checks.Single(pred)`. Such a chain parses
        // right-associatively, so the hovered call's enclosing accessors yield
        // several candidate receivers (the bare trailing segment `Checks` and the
        // full `report.Checks`). Classifying off the bare trailing segment misread
        // the receiver as "no receiver" and let the call bind to an unrelated
        // same-named *static* method (e.g. `Xunit.Assert.Single`). This mirrors the
        // shape with BCL-only types: `d.Keys.Concat(other)` (a value-receiver LINQ
        // extension whose receiver is a property access) must never resolve to the
        // same-named static `String.Concat(...)` that appears elsewhere — even
        // though both have the same parameter count relative to the call site.
        const source = "package P\n" +
            "import System\n" +
            "import System.Linq\n" +
            "import System.Collections.Generic\n" +
            "func main() {\n" +
            "    let d = Dictionary[string, int32]()\n" +
            "    let other = List[string]()\n" +
            "    let joined = d.Keys.Concat(other)\n" +
            "    let s = String.Concat(\"x\", \"y\")\n" +
            "    Console.WriteLine(s)\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Concat", 0)
        )
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("Concat", value, StringComparison.Ordinal)
        Assert.Contains("Enumerable", value, StringComparison.Ordinal)
        Assert.DoesNotContain("(System.String)", value, StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_ExtensionMethodInvocation_WithFuncLiteral_ResolvesToMethod() {
        // The hover bug was independent of the argument form: the explicit
        // `func(...) bool { ... }` predicate spelling must also hover to the
        // method, not the float32 type.
        const source = "package P\n" +
            "import System\n" +
            "import System.Linq\n" +
            "import System.Collections.Generic\n" +
            "func main() {\n" +
            "    let nums = List[int32]()\n" +
            "    nums.Add(1)\n" +
            "    let found = nums.Single(func(x int32) bool { return x == 1 })\n" +
            "    Console.WriteLine(found)\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Single"))
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("Single", value, StringComparison.Ordinal)
        Assert.DoesNotContain("single-precision", value, StringComparison.OrdinalIgnoreCase)
    }

    shared {
        private func CreateReferencePackResolver() ReferenceResolver {
            let TryParseVersion = func (s string) Version? {
                return if Version.TryParse(s, out var v) {
                    v
                } else {
                    Version(0, 0)
                }
            }
            let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
            let dotnetRoot = Directory.GetParent(runtimeDir!!)!!.Parent!!.Parent!!.FullName
            let major = Environment.Version.Major
            let tfm = "net$major.0"
            // Discover the actual installed ref pack directory. Globbing rather
            // than hard-coding Environment.Version.ToString(3) tolerates the
            // common CI shape where the running runtime (e.g. "10.0.0") and the
            // installed ref pack (e.g. "10.0.9") have different patch versions
            // (#858). Pick the highest-versioned ref pack whose TFM directory
            // exists.
            let packRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref")
            Assert.True(Directory.Exists(packRoot), "Ref pack root '$packRoot' not found.")
            let refDir string? = Directory
                .EnumerateDirectories(packRoot)
                .Select((d string) -> AnonymousType2_D0A851334AB60D64(d, Path.Combine(d, "ref", tfm)))
                .Where((x AnonymousType2_D0A851334AB60D64) -> Directory.Exists(x.Ref))
                .OrderByDescending((x AnonymousType2_D0A851334AB60D64) -> TryParseVersion(Path.GetFileName(x.Dir))!!)
                .Select((x AnonymousType2_D0A851334AB60D64) -> x.Ref)
                .FirstOrDefault()
            Assert.NotNull(refDir)
            return ReferenceResolver.WithReferences(Directory.GetFiles(refDir!!, "*.dll"))
        }
    }
}

internal data class AnonymousType2_D0A851334AB60D64(Dir string, Ref string) { }
