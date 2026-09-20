// <copyright file="ReadOnlyManagedSyntaxTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Compiler.Tests;

public sealed class ReadOnlyManagedSyntaxTests
{
    [Fact]
    public void ModifiersAreSeparateSyntaxTokens()
    {
        const string source = """
            func View(p readonly managed[string?]?) (readonly managed[int32], readonly slice[int32]) { }
            func Main() {
                var value = 1
                let p = readonly managed(value)
                let q = readonly managed[int32].FromArray([]int32{2}, 0)
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var clauses = tree.Root.DescendantNodesAndSelf().OfType<TypeClauseSyntax>()
            .Where(type => type.ReadOnlyManagedModifier != null).ToArray();
        Assert.Equal(2, clauses.Length);
        Assert.All(clauses, type =>
        {
            Assert.Equal("readonly", type.ReadOnlyManagedModifier.Text);
            Assert.Equal("managed", type.Identifier.Text);
            Assert.Contains(type.ReadOnlyManagedModifier, type.GetChildren());
        });
        var address = Assert.Single(tree.Root.DescendantNodesAndSelf().OfType<CallExpressionSyntax>(),
            call => call.ReadOnlyManagedModifier != null);
        Assert.Equal("managed", address.Identifier.Text);
        Assert.Equal("readonly managed(value)", source.Substring(address.Span.Start, address.Span.Length));
        var receiver = Assert.Single(tree.Root.DescendantNodesAndSelf().OfType<GenericNameExpressionSyntax>(),
            name => name.ReadOnlyManagedModifier != null);
        Assert.Equal("managed", receiver.Identifier.Text);
    }

    [Fact]
    public void TypeAndBorrowedModifierPrecedenceVerifyAndExecute()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            """
            package ReadonlyManagedForms
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
            }
            """, "ReadonlyManagedForms", true);
        IlVerifier.Verify(dll);
        Assert.Equal("5\n5\n5\n5\nTrue\n7\n9\n2\n5\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData("func Bad(p readonlyManaged[int32]) { }", "GS0113")]
    [InlineData("func Bad() { var value = 0\nlet p = readonlyManaged(value) }", "GS0130")]
    [InlineData("func Bad() { let p = readonly managed(1 + 2) }", "GS0604")]
    [InlineData("func Bad() { var value = 0\nlet p = readonly managed(value)\n*p = 1 }", "GS0604")]
    [InlineData("func managed(value int32) int32 { return value }\nfunc Bad() { let p = readonly managed(3) }", "GS0604")]
    [InlineData("class managed[T] { }\nfunc Bad(p readonly managed[int32]) { }", "GS0604")]
    public void InvalidOrRetiredMagicIsNotReinterpreted(string source, string diagnostic)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile("package ReadonlyManagedReject\n" + source, "reject", false);
        Assert.NotEqual(0, code);
        Assert.True(output.Contains("error " + diagnostic + ":", StringComparison.Ordinal), output);
    }

    [Fact]
    public void FormerMagicAndContextualWordsRemainOrdinaryNames()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            """
            package ReadonlyManagedNames
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
            }
            """, "ReadonlyManagedNames", true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n8\n9\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData("method")]
    [InlineData("field")]
    [InlineData("property")]
    public void StaticImportsAndEscapedCallablesKeepOrdinaryLookup(string kind)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        foreach (var name in new[] { "managed", "readonlyManaged" })
        {
            var sourceMember = kind switch
            {
                "method" => $"public func {name}(value int32) int32 {{ return value + 1 }}",
                "field" => $"public var {name} Func[int32, int32] = func(value int32) int32 {{ return value + 1 }}",
                _ => $"public prop {name} Func[int32, int32] -> func(value int32) int32 {{ return value + 1 }}",
            };
            var clrMember = kind switch
            {
                "method" => $"public static int {name}(int value) => value + 1;",
                "field" => $"public static System.Func<int, int> {name} = value => value + 1;",
                _ => $"public static System.Func<int, int> {name} => value => value + 1;",
            };
            var library = fixture.CompileCSharp(
                $"namespace ImportedNames; public static class Registry {{ {clrMember} }}", name + kind);
            foreach (var imported in new[] { false, true })
            {
                var declaration = imported
                    ? "import ImportedNames.Registry"
                    : $"import OrdinaryCalls.Registry\nclass Registry {{ shared {{ {sourceMember} }} }}";
                var source = $$"""
                    package OrdinaryCalls
                    import System
                    {{declaration}}
                    func Main() {
                        Console.WriteLine({{name}}(41))
                        Console.WriteLine(${{name}}(42))
                    }
                    """;
                var dll = fixture.Compile(source, "ordinary", true, "/r:" + library);
                IlVerifier.Verify(dll, new[] { library });
                Assert.Equal("42\n43\n", fixture.Run(dll));
                if (name == "managed")
                {
                    var (code, output) = fixture.TryCompile(
                        source.Replace("managed(41)", "readonly managed(41)", StringComparison.Ordinal),
                        "modified", true, "/r:" + library);
                    Assert.NotEqual(0, code);
                    Assert.Contains("error GS0604:", output);
                    Assert.DoesNotContain("error GS0005:", output);
                }
            }
        }
    }

    [Fact]
    public void OrdinaryTypeArityConstraintsAmbiguityAndEscapesDoNotFallBack()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var library = fixture.CompileCSharp(
            """
            namespace First { public class managed<T> { public T Value = default!; } }
            namespace Second { public class managed<T> { } }
            namespace WrongArity { public class managed<T, U> { } }
            namespace Constrained { public class managed<T> where T : class { } }
            """, "OrdinaryTypeLibrary");
        var dll = fixture.Compile(
            """
            package OrdinaryTypes
            import System
            import managed = First.managed
            func Main() {
                let first = managed[int32]{Value: 3}
                let second = $managed[int32]{Value: 4}
                Console.WriteLine(first.Value + second.Value)
                let view = Gsharp.Values.ReadOnlyManagedRef[int32].FromArray([]int32{8}, 0)
                Console.WriteLine(*view)
            }
            """, "ordinaryTypes", true, "/r:" + library);
        IlVerifier.Verify(dll, new[] { library });
        Assert.Equal("7\n8\n", fixture.Run(dll));
        foreach (var source in new[]
        {
            "import WrongArity\nfunc Bad(value managed[int32]) { }",
            "import Constrained\nfunc Bad(value managed[int32]) { }",
            "import First\nimport Second\nfunc Bad(value managed[int32]) { }",
            "import First\nimport Second\nfunc Bad(value readonly managed[int32]) { }",
            "class managed[T, U] { }\nfunc Bad(value readonly managed[int32]) { }",
            "func Bad(value $managed[int32]) { }",
            "func Bad() { var value = 1\nlet p = $managed(value) }",
        })
        {
            var (code, output) = fixture.TryCompile("package RejectedNames\n" + source, "rejectedNames", false, "/r:" + library);
            Assert.NotEqual(0, code);
            Assert.DoesNotContain("error GS0604:", output);
            Assert.DoesNotContain("error GS0005:", output);
            Assert.DoesNotContain("error GS9998:", output);
        }
    }
}
