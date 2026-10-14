// <copyright file="ReadOnlyManagedSyntaxTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Linq
import Xunit

class ReadOnlyManagedSyntaxTests {
    @Fact
    func ModifiersAreSeparateSyntaxTokens() {
        const source = `func View(p readonly managed[string?]?) (readonly managed[int32], readonly slice[int32]) { }
func Main() {
    var value = 1
    let p = readonly managed(value)
    let q = readonly managed[int32].FromArray([]int32{2}, 0)
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clauses = tree
            .Root
            .DescendantNodesAndSelf()
            .OfType[TypeClauseSyntax]()
            .Where((type TypeClauseSyntax) -> type.ReadOnlyManagedModifier != nil)
            .ToArray()
        Assert.Equal(2, clauses.Length)
        Assert.All(
            clauses,
            (type TypeClauseSyntax) -> {
                Assert.Equal("readonly", type.ReadOnlyManagedModifier!!.Text)
                Assert.Equal("managed", type.Identifier!!.Text)
                Assert.Contains(type.ReadOnlyManagedModifier!!, type.GetChildren())
            }
        )
        let address = Assert.Single(
            tree.Root.DescendantNodesAndSelf().OfType[CallExpressionSyntax](),
            (call CallExpressionSyntax) -> call.ReadOnlyManagedModifier != nil
        )
        Assert.Equal("managed", address.Identifier.Text)
        Assert.Equal("readonly managed(value)", source.Substring(address.Span.Start, address.Span.Length))
        let receiver = Assert.Single(
            tree.Root.DescendantNodesAndSelf().OfType[GenericNameExpressionSyntax](),
            (name GenericNameExpressionSyntax) -> name.ReadOnlyManagedModifier != nil
        )
        Assert.Equal("managed", receiver.Identifier.Text)
    }

    @Fact
    func TypeAndBorrowedModifierPrecedenceVerifyAndExecute() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ReadonlyManagedForms
import System
import System.Collections.Generic
class Slots {
    var Writable managed[int32] = managed([]int32{1}[0])
    var Readonly readonly managed[int32] = readonly managed([]int32{2}[0])
    func WritableSlot() ref readonly managed[int32] { return ref this.Writable }
    func ReadonlySlot() ref readonly readonly managed[int32] { return ref this.Readonly }
}
func Identity[T](p readonly managed[T]) readonly managed[T] { return p }
func Pair(p readonly managed[int32]) (readonly managed[int32], (readonly managed[int32])?) { return (p, p) }
func Main() {
    var value = 3
    let view = Identity(readonly managed(value))
    let pair = Pair(view)
    let list = List[readonly managed[int32]]()
    list.Add(view)
    let array = []readonly managed[int32]{view}
    let grouped (readonly managed[int32])? = view
    let nullable readonly managed[string?]? = nil
    let native = readonly managed[int32].FromArray([]int32{7}, 0)
    let converted = readonly managed[int32]?(view)
    let slots = Slots()
    let ref readonly writableSlot = slots.WritableSlot()
    let ref readonly readonlySlot = slots.ReadonlySlot()
    *writableSlot = 9
    value = 5
    Console.WriteLine(*pair.Item1)
    Console.WriteLine(*list[0])
    Console.WriteLine(*array[0])
    Console.WriteLine(*(grouped!!))
    Console.WriteLine(nullable == nil)
    Console.WriteLine(*native)
    Console.WriteLine(*writableSlot)
    Console.WriteLine(*readonlySlot)
    Console.WriteLine(*(converted!!))
}`, "ReadonlyManagedForms", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`5
5
5
5
True
7
9
2
5
`, fixture.Run(dll))
    }

    @Theory
    @InlineData("func Bad(p readonlyManaged[int32]) { }", "GS0113")
    @InlineData("func Bad() { var value = 0\nlet p = readonlyManaged(value) }", "GS0130")
    @InlineData("func Bad() { let p = readonly managed(1 + 2) }", "GS0604")
    @InlineData(`func Bad() { var value = 0
let p = readonly managed(value)
*p = 1 }`, "GS0604")
    @InlineData(
        "func managed(value int32) int32 { return value }\nfunc Bad() { let p = readonly managed(3) }",
        "GS0604"
    )
    @InlineData("class managed[T] { }\nfunc Bad(p readonly managed[int32]) { }", "GS0604")
    func InvalidOrRetiredMagicIsNotReinterpreted(source string, diagnostic string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile("package ReadonlyManagedReject\n" + source, "reject", false)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("error " + diagnostic + ":", StringComparison.Ordinal), output)
    }

    @Fact
    func FormerMagicAndContextualWordsRemainOrdinaryNames() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ReadonlyManagedNames
import System
class readonlyManaged[T] { var Value T }
func readonly(value int32) int32 { return value + 1 }
func Main() {
    let ordinary = readonlyManaged[int32]{Value: 4}
    let managed = func (value int32) int32 { return value + 2 }
    Console.WriteLine(managed(readonly(ordinary.Value)))
    let qualified = Gsharp.Values.ReadOnlyManagedRef[int32].FromArray([]int32{8}, 0)
    Console.WriteLine(*qualified)
    let $readonlyManaged = 9
    Console.WriteLine($readonlyManaged)
}`, "ReadonlyManagedNames", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`7
8
9
`, fixture.Run(dll))
    }

    @Theory
    @InlineData("method")
    @InlineData("field")
    @InlineData("property")
    func StaticImportsAndEscapedCallablesKeepOrdinaryLookup(kind string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        for name in[]string{"managed", "readonlyManaged"} {
            let sourceMember = switch kind {
                case "method": "public func $name(value int32) int32 { return value + 1 }"
                case "field": "public var $name Func[int32, int32] = func(value int32) int32 { return value + 1 }"
                default: "public prop $name Func[int32, int32] -> func(value int32) int32 { return value + 1 }"
            }
            let clrMember = switch kind {
                case "method": "public static int $name(int value) => value + 1;"
                case "field": "public static System.Func<int, int> $name = value => value + 1;"
                default: "public static System.Func<int, int> $name => value => value + 1;"
            }
            let library = fixture.CompileCSharp(
                "namespace ImportedNames; public static class Registry { $clrMember }",
                name + kind
            )
            for imported in[]bool{false, true} {
                let declaration = if imported {
                    "import ImportedNames.Registry"
                } else {
                    (`import OrdinaryCalls.Registry
class Registry { shared { ` + "$sourceMember" + ` } }`)
                }
                let source = (`package OrdinaryCalls
import System
` + "$declaration" + `
func Main() {
    Console.WriteLine(` + "$name" + `(41))
    Console.WriteLine($` + "$name" + `(42))
}`)
                let dll = fixture.Compile(source, "ordinary", true, "/r:" + library)
                IlVerifier.Verify(dll, []string{library})
                Assert.Equal(`42
43
`, fixture.Run(dll))
                if name == "managed" {
                    let (code, output) = fixture.TryCompile(
                        source.Replace("managed(41)", "readonly managed(41)", StringComparison.Ordinal),
                        "modified",
                        true,
                        "/r:" + library
                    )
                    Assert.NotEqual(0, code)
                    Assert.Contains("error GS0604:", output)
                    Assert.DoesNotContain("error GS0005:", output)
                }
            }
        }
    }

    @Fact
    func OrdinaryTypeArityConstraintsAmbiguityAndEscapesDoNotFallBack() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`namespace First { public class managed<T> { public T Value = default!; } }
namespace Second { public class managed<T> { } }
namespace WrongArity { public class managed<T, U> { } }
namespace Constrained { public class managed<T> where T : class { } }`, "OrdinaryTypeLibrary")
        let dll = fixture.Compile(`package OrdinaryTypes
import System
import managed = First.managed
func Main() {
    let first = managed[int32]{Value: 3}
    let second = $managed[int32]{Value: 4}
    Console.WriteLine(first.Value + second.Value)
    let view = Gsharp.Values.ReadOnlyManagedRef[int32].FromArray([]int32{8}, 0)
    Console.WriteLine(*view)
}`, "ordinaryTypes", true, "/r:" + library)
        IlVerifier.Verify(dll, []string{library})
        Assert.Equal(`7
8
`, fixture.Run(dll))
        for source in[]string{
            "import WrongArity\nfunc Bad(value managed[int32]) { }",
            "import Constrained\nfunc Bad(value managed[int32]) { }",
            `import First
import Second
func Bad(value managed[int32]) { }`,
            `import First
import Second
func Bad(value readonly managed[int32]) { }`,
            "class managed[T, U] { }\nfunc Bad(value readonly managed[int32]) { }",
            "func Bad(value $$managed[int32]) { }",
            "func Bad() { var value = 1\nlet p = $$managed(value) }"
        } {
            let (code, output) = fixture.TryCompile(
                "package RejectedNames\n" + source,
                "rejectedNames",
                false,
                "/r:" + library
            )
            Assert.NotEqual(0, code)
            Assert.DoesNotContain("error GS0604:", output)
            Assert.DoesNotContain("error GS0005:", output)
            Assert.DoesNotContain("error GS9998:", output)
        }
    }
}
