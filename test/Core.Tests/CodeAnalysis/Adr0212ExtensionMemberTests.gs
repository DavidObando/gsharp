// <copyright file="Adr0212ExtensionMemberTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0212 question 12: extension members in (cref:SemanticModel.LookupMembers). One test per extension row
/// of the contract table in the documentation of the query. The marker `// Pname` ends the line of the
/// member access whose receiver type the row queries.
open class Adr0212ExtensionMemberTests {
    @Fact
    func SourceExtension_OfThePrimitive_IsListedAfterTheTypeMembersInFileThenStartOrder() {
        let members = Query("PInt")
        let extensions = members.OfType[FunctionSymbol]().Where((f FunctionSymbol) -> f.IsExtension).ToList()
        Assert.Equal([]string{"Abs", "Twice", "Scale"}, extensions.Select((f FunctionSymbol) -> f.Name).ToArray())
        // The CLR members of int32 come first, the extensions last.
        let firstExtension = members.IndexOf(extensions[0])
        Assert.True(firstExtension > 0, "int32 has CLR members")
        Assert.All(
            members.Skip(firstExtension),
            (m Symbol) -> Assert.True(m is FunctionSymbol{IsExtension: true}, m.Name)
        )
    }

    @Fact
    func SourceExtension_OfAnotherReceiver_IsNotListed() {
        Assert.DoesNotContain(Query("PInt"), (m Symbol) -> m.Name == "Shout")
        Assert.Contains(Query("PString"), (m Symbol) -> m.Name == "Shout")
    }

    @Fact
    func SourceExtension_WithAName_IsTheOverloadsOfThatName() {
        let members = Query("PInt", "Scale")
        let only = Assert.Single(members)
        Assert.Equal("Scale", only.Name)
        Assert.True(cast[FunctionSymbol](only).IsExtension)
    }

    @Fact
    func SourceExtension_IsTheFunctionTheBinderBound() {
        let call = AccessAt("PInt")
        let bound = ModelOf().GetSymbolInfo(call.RightPart.GetFirstToken()).Symbol
        Assert.NotNull(bound)
        Assert.Contains(Query("PInt", "Abs"), (m Symbol) -> object.ReferenceEquals(m, bound))
    }

    @Fact
    func ImportedExtension_ReceiverThatTakesIt_ListsTheMethodsOfTheImportedNamespaces() {
        let members = Query("PSlice", "Select")
        Assert.NotEmpty(members)
        Assert.All(members, (m Symbol) -> Assert.IsType[ImportedFunctionSymbol](m))
        Assert.All(
            members,
            (m Symbol) -> Assert.Equal("Enumerable", cast[ImportedFunctionSymbol](m).Method.DeclaringType!!.Name)
        )
        let tokens = members.Select((m Symbol) -> cast[ImportedFunctionSymbol](m).Method.MetadataToken).ToList()
        Assert.Equal(tokens.OrderBy((t int32) -> t).ToList(), tokens)
    }

    @Fact
    func ImportedExtension_WithoutAName_ListsTheSameSetPlusTheRest() {
        let all = Query("PSlice")
        Assert.Contains(all, (m Symbol) -> m.Name == "Where")
        Assert.Contains(all, (m Symbol) -> m.Name == "ToList")
        // `TakeWhile`'s first parameter takes IEnumerable<T>; `Append` on a string builder's extension does not.
        Assert.DoesNotContain(all, (m Symbol) -> m.Name == "Shout")
    }

    @Fact
    func ImportedExtension_ReceiverThatDoesNotTakeIt_IsNotListed() {
        // An int32 is not an IEnumerable<T>.
        Assert.DoesNotContain(
            Query("PInt"),
            (m Symbol) -> m is ImportedFunctionSymbol imported && imported.Method.DeclaringType!!.Name == "Enumerable"
        )
    }

    @Fact
    func ImportedExtension_NamespaceNotImported_IsNotListed() {
        Assert.Empty(Query("PNoLinq", "Select").OfType[ImportedFunctionSymbol]())
        Assert.NotEmpty(Query("PSlice", "Select"))
    }

    @Fact
    func ImportedExtension_ReceiverWithoutAClrShape_IsProbedThroughItsInterface() {
        Assert.NotEmpty(Query("PUserEnumerable", "Select"))
        Assert.Empty(Query("PPlainClass", "Select"))
    }

    @Fact
    func Extensions_NullableAndPlatformReceivers_AnswerForTheUnderlyingType() {
        let plain = Query("PInt").Select((m Symbol) -> m.Name).ToList()
        let nullable = ModelOf()
            .LookupMembers(Position("PInt"), NullableTypeSymbol.Get(ReceiverOf("PInt")))
            .Select((m Symbol) -> m.Name)
            .ToList()
        Assert.Equal(plain, nullable)
    }

    @Fact
    func Extensions_AreDeterministic_WhateverTheOrderOfTheFiles() {
        let forward = Names(Compilation(Trees[0], Trees[1]))
        let reverse = Names(Compilation(Trees[1], Trees[0]))
        Assert.Equal(forward, reverse)
        Assert.Equal(forward, Names(Compilation(Trees[0], Trees[1])))
    }

    @Fact
    func SourceExtension_AtATopLevelStatement_PrefersTheExtensionOfTheFilesOwnPackage() {
        // Both packages declare `Greet` on string with the same signature; the call in Baz binds Baz's.
        let compilation = Compilation(PackageTrees[0], PackageTrees[1])
        let tree = PackageTrees[1]
        let model = compilation.GetSemanticModel(tree)
        let access = tree.Root.DescendantNodes().OfType[AccessorExpressionSyntax]().First()
        let bound = model.GetSymbolInfo(access.RightPart.GetFirstToken()).Symbol
        Assert.NotNull(bound)
        let position = access.Span.Start
        let receiver = model.GetReceiverTypeInfo(access.LeftPart).Type!!
        let found = model.LookupMembers(position, receiver, "Greet").OfType[FunctionSymbol]().ToList()
        let only = Assert.Single(found)
        Assert.Equal("Baz", only.Package!!.Name)
        Assert.Same(bound, only)
    }

    @Fact
    func ImportedExtension_ClassWithAnImportedBaseAndAnInterface_KeepsTheBaseForTheProbe() {
        // The call binder erases the receiver to its imported base and projects to an interface only when
        // the erasure is absent or `object`; `GetCustomAttributes` takes a MemberInfo.
        Assert.NotEmpty(Query("PDerivedMember", "GetCustomAttributes").OfType[ImportedFunctionSymbol]())
    }

    shared {
        private let PackageTrees[]SyntaxTree = []SyntaxTree{
            SyntaxTree.Parse(
                SourceText.From("package Foo\n\nfunc (t string) Greet() string {\n    return t\n}\n", "foo.gs")
            ),
            SyntaxTree.Parse(
                SourceText.From(
                    "package Baz\n\nfunc (t string) Greet() string {\n    return t\n}\n\nlet q = \"x\".Greet()\n",
                    "baz.gs"
                )
            )
        }

        private const FileA string = `package Ext
import System
import System.Collections.Generic
import System.Linq
import System.Reflection

class Plain {
    var Id int32
}

class Numbers : IEnumerable[int32] {
    func GetEnumerator() IEnumerator[int32] { return nil!! }
}

func (value int32) Abs() int32 {
    return value
}

func (text string) Shout() string {
    return text
}

abstract class Derived : System.Reflection.MemberInfo, IDisposable {
    func Dispose() { }
}

func Use(n int32, s string, xs []int32, p Plain, u Numbers, d Derived) {
    d.ToString() // PDerivedMember
    n.Abs() // PInt
    s.Shout() // PString
    xs.Select((x int32) -> x) // PSlice
    p.ToString() // PPlainClass
    u.ToString() // PUserEnumerable
}
`

        private const FileB string = `package Ext

func (value int32) Twice() int32 {
    return value * 2
}

func (value int32) Scale(factor int32) int32 {
    return value * factor
}
`

        private const FileC string = `package Other
import System

func Use(xs []int32) {
    xs.ToString() // PNoLinq
}
`

        private let Trees[]SyntaxTree = []SyntaxTree{
            SyntaxTree.Parse(SourceText.From(FileA, "a.gs")),
            SyntaxTree.Parse(SourceText.From(FileB, "b.gs")),
            SyntaxTree.Parse(SourceText.From(FileC, "c.gs"))
        }

        private let Compiled Compilation = Compilation(Trees[1], Trees[0], Trees[2])

        private func ModelOf() SemanticModel {
            return Compiled.GetSemanticModel(Trees[0])
        }

        private func SourceOf(marker string) string -> if marker == "PNoLinq" {
            FileC
        } else {
            FileA
        }

        private func TreeOf(marker string) SyntaxTree -> if marker == "PNoLinq" {
            Trees[2]
        } else {
            Trees[0]
        }

        private func Position(marker string) int32 {
            let at = SourceOf(marker).IndexOf("// " + marker + "\n", StringComparison.Ordinal)
            Assert.True(at >= 0, "marker ${marker} is in the source")
            return at
        }

        private func AccessAt(marker string) AccessorExpressionSyntax {
            let position = Position(marker)
            let lineStart = SourceOf(marker).LastIndexOf('\n', position - 1) + 1
            var best AccessorExpressionSyntax? = nil
            for node in TreeOf(marker).Root.DescendantNodes() {
                if node is AccessorExpressionSyntax accessor &&
                    accessor
                    .Span
                    .Start >= lineStart &&
                    accessor
                    .Span
                    .End <= position &&
                    (best == nil || accessor.Span.Start <= best.Span.Start) {
                    best = accessor
                }
            }
            return Invariant.Required(best, "an access before the marker", expression: "best")
        }

        private func ReceiverOf(marker string) TypeSymbol {
            let access = AccessAt(marker)
            let type = Compiled.GetSemanticModel(TreeOf(marker)).GetReceiverTypeInfo(access.LeftPart).Type
            return Invariant.Required(type, "a receiver type", expression: "type")
        }

        private func Query(marker string, name string? = nil) ImmutableArray[Symbol] {
            return Compiled.GetSemanticModel(TreeOf(marker)).LookupMembers(Position(marker), ReceiverOf(marker), name)
        }

        private func Names(compilation Compilation)[]string {
            let model = compilation.GetSemanticModel(
                compilation.SyntaxTrees.First((t SyntaxTree) -> t.Text?.FileName == "a.gs")
            )
            let at = FileA.IndexOf("// PInt\n", StringComparison.Ordinal)
            let access = compilation
                .SyntaxTrees
                .First((t SyntaxTree) -> t.Text?.FileName == "a.gs")
                .Root
                .DescendantNodes()
                .OfType[AccessorExpressionSyntax]()
                .First((a AccessorExpressionSyntax) -> a.Span.End <= at && a.Span.Start > at - 20)
            let type = model.GetReceiverTypeInfo(access.LeftPart).Type!!
            return model.LookupMembers(at, type).Select((m Symbol) -> m.Name + "@" + m.GetType().Name).ToArray()
        }
    }
}
