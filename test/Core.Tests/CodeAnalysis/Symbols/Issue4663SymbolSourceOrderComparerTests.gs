// <copyright file="Issue4663SymbolSourceOrderComparerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import System.Collections.Immutable
import System.Linq
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Xunit
import GSharp.Core.CodeAnalysis
import System
import System.Collections.Generic
import System.Text

/// Issue #4663: the symbol order must not tie on distinct containing-type paths.
open class Issue4663SymbolSourceOrderComparerTests {
    /// Namespace segments must not alias nested-type segments.
    @Fact
    func ConstructorsInNamespaceAndNestedType_AreDistinctInTheBoundProgram() {
        for count in[]int32{1, 7, 23, 61, 157, 401} {
            let compilation = Compilation(
                SyntaxTree.Parse(UnrelatedFunctions(count)),
                SyntaxTree.Parse("package p\nclass A { class B { init() { } } }"),
                SyntaxTree.Parse("package p.A\nclass B { init() { } }")
            )
            Assert.Empty(compilation.GlobalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
            let bound = compilation.BoundProgram
            Assert.Empty(bound.Diagnostics.Where((d Diagnostic) -> d.IsError))
            let constructors = bound
                .Structs
                .SelectMany(
                func (s StructSymbol) IEnumerable[ConstructorSymbol] {
                    return s.ExplicitConstructors
                }
            )
                .Where((c ConstructorSymbol) -> c.DeclaringType?.Name == "B")
                .ToArray()
            Assert.Equal(2, constructors.Length)
            let nested = Assert.Single(constructors, (c ConstructorSymbol) -> c.DeclaringType?.ContainingType != nil)
            let topLevel = Assert.Single(constructors, (c ConstructorSymbol) -> c.DeclaringType?.ContainingType == nil)
            // The namespace segment p precedes p.A; these are not the same containing path.
            AssertSourceOrder(nested.Function, topLevel.Function, -1)
        }
    }

    /// Explicit constructors have no FunctionDeclarationSyntax: signatures must disambiguate them.
    @Theory
    @InlineData("x Foo.X", "x Bar.X", "", int32(1))
    @InlineData("x Foo.Box[int32]", "x Bar.Box[int32]", "", int32(1))
    @InlineData("x List[Foo.X]", "x List[Bar.X]", "", int32(1))
    @InlineData("x int32", "ref x int32", "", int32(-1))
    @InlineData("x int32", "out x int32", "x = 0", int32(-1))
    func QualifiedConstructorSignatures_AreDistinctInBoundSymbols(
        first string,
        second string,
        body string,
        expectedDirection int32
    ) {
        for count in[]int32{1, 7, 23, 61, 157, 401} {
            let constructors = []string{first, second}.Select(
                (parameter string) -> {
                    let compilation = Compilation(SyntaxTree.Parse(UnrelatedFunctions(count)), SyntaxTree.Parse(`package Foo
class X { }
class Box[T] { }`), SyntaxTree.Parse(`package Bar
class X { }
class Box[T] { }`), SyntaxTree.Parse((`package P
import System.Collections.Generic
class Host { init(` + "$parameter" + `) { ` + "${(if parameter == second { body } else { string.Empty })}" + ` } }`)))
                    Assert.Empty(compilation.GlobalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
                    let bound = compilation.BoundProgram
                    Assert.Empty(bound.Diagnostics.Where((d Diagnostic) -> d.IsError))
                    return Assert.Single(
                        Assert.Single(bound.Structs, (s StructSymbol) -> s.Name == "Host").ExplicitConstructors
                    )
                        .Function
                }
            )
                .ToArray()
            Assert.Equal(2, constructors.Length)
            Assert.All(constructors, (constructor FunctionSymbol) -> Assert.Null(constructor.Declaration))
            // Equal-length package names Bar < Foo; None < Ref/Out in the retained ref-kind key.
            AssertSourceOrder(constructors[0], constructors[1], expectedDirection)
        }
    }

    /// Generic arity and lowered sequence specialization are identity, even at identical source
    /// coordinates.
    @Fact
    func ArityAndNullableSequenceSpecialization_BreakOtherwiseIdenticalKeys() {
        let ordinary = TopLevelFunction("P")
        let generic = TopLevelFunction("P")
        generic.TypeParameters = ImmutableArray.Create(
            TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        )
        AssertSourceOrder(ordinary, generic, -1)
        let reference = TopLevelFunction("P")
        let value = TopLevelFunction("P")
        reference.NullableSequenceSpecialization = NullableSequenceSpecializationKind.ReferenceType
        value.NullableSequenceSpecialization = NullableSequenceSpecializationKind.ValueType
        AssertSourceOrder(reference, value, -1)
    }

    /// Source kinds and constructed owner arguments are retained, not only their display names.
    @Fact
    func ClassStructAndConstructedOwnerKinds_AreDistinct() {
        let structure = StructSymbol(
            "Owner",
            ImmutableArray[FieldSymbol].Empty,
            Accessibility.Public,
            declaration: nil,
            packageName: "P"
        )
        let referenceType = StructSymbol(
            "Owner",
            ImmutableArray[FieldSymbol].Empty,
            Accessibility.Public,
            declaration: nil,
            packageName: "P",
            isData: false,
            isInline: false,
            isClass: true
        )
        AssertSourceOrder(FunctionIn(structure), FunctionIn(referenceType), 1)
        let compilation = Compilation(SyntaxTree.Parse("package P\nclass Owner[T] { }"))
        Assert.Empty(compilation.GlobalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
        let definition = Assert.Single(compilation.BoundProgram.Structs)
        let first = StructSymbol.Construct(definition, ImmutableArray.Create(TypeSymbol.Int32))
        let second = StructSymbol.Construct(definition, ImmutableArray.Create(TypeSymbol.String))
        AssertSourceOrder(FunctionIn(first), FunctionIn(second), -1)
    }

    /// The pre-existing untied MethodDef keys take precedence over every new identity tie-break.
    @Fact
    func HistoricalUntiedMethodDefKeysAndFilePathOrder_ArePreserved() {
        let earlier = DeclaredFunction("package Z\nfunc z() { }", "Z.gs")
        let later = DeclaredFunction(`package A

func a() { }`, "A.gs")
        Assert.True(SymbolSourceOrderComparer.Instance.Compare(earlier, later) < 0)
        Assert.True(
            SymbolSourceOrderComparer.Instance.Compare(
                DeclaredFunction("package Z\nfunc a() { }", "Z.gs"),
                DeclaredFunction("package A\nfunc z() { }", "A.gs")
            ) < 0
        )
        Assert.True(
            SymbolSourceOrderComparer.Instance.Compare(
                DeclaredFunction("package P\nfunc f() { }", "A.gs"),
                DeclaredFunction("package P\nfunc f() { }", "Z.gs")
            ) < 0
        )
    }

    /// Two functions that differ only in the outermost type of a 100-deep
    /// containing chain are ordered, not tied (a truncated chain tied them,
    /// leaving their order to the input enumeration).
    @Fact
    func FunctionsInDeeplyNestedTypes_DifferingOnlyAtTheOutermostType_AreOrdered() {
        let first = FunctionIn(NestedChain("A", depth: 100))
        let second = FunctionIn(NestedChain("B", depth: 100))
        let forward = SymbolSourceOrderComparer.Instance.Compare(first, second)
        let backward = SymbolSourceOrderComparer.Instance.Compare(second, first)
        Assert.True(forward < 0)
        Assert.True(backward > 0)
    }

    /// Same-shaped top-level functions in two packages are ordered by package,
    /// not tied (they share a name, signature and the lack of a file name).
    @Fact
    func TopLevelFunctionsInDifferentPackages_AreOrderedByPackage() {
        let inB = TopLevelFunction("B")
        let inA = TopLevelFunction("A")
        Assert.True(SymbolSourceOrderComparer.Instance.Compare(inA, inB) < 0)
        Assert.True(SymbolSourceOrderComparer.Instance.Compare(inB, inA) > 0)
    }

    /// A field-initializer view is in field source order whatever order the
    /// identity-keyed map enumerates (the lowering passes number temporaries
    /// while walking it).
    @Fact
    func FieldInitializers_AreWalkedInFieldSourceOrder() {
        const Count = 64
        let source = StringBuilder(`package P
class Holder {
`)
        for var i = 0; i < Count; i++ {
            source.Append((`    var F` + "$i" + ` int32 = ` + "$i" + `
`))
        }
        source.Append("}\n")
        let members = SyntaxTree
            .Parse(SourceText.From(source.ToString(), "Fields.gs"))
            .Root
            .DescendantNodesAndSelf()
            .OfType[FieldDeclarationSyntax]()
            .ToArray()
        Assert.Equal(Count, members.Length)
        // Insert in reverse source order; give every field its member as declaration.
        var map_ = ImmutableDictionary[FieldSymbol, BoundExpression].Empty
        for var i = Count - 1; i >= 0; i-- {
            let field = FieldSymbol("F$i", TypeSymbol.Int32, Accessibility.Public, declaration: members[i])
            map_ = map_.Add(field, BoundLiteralExpression(nil, i))
        }
        let ordered = BoundProgramOrder.FieldInitializers(map_)
        Assert.Equal(
            Enumerable.Range(0, Count).Select((i int32) -> "F$i").ToArray(),
            ordered.Select((pair KeyValuePair[FieldSymbol, BoundExpression]) -> pair.Key.Name).ToArray()
        )
    }

    shared {
        private func DeclaredFunction(source string, file string) FunctionSymbol {
            let tree = SyntaxTree.Parse(SourceText.From(source, file))
            let declaration = Assert.Single(tree.Root.DescendantNodesAndSelf().OfType[FunctionDeclarationSyntax]())
            return FunctionSymbol(
                declaration.Identifier.Text,
                ImmutableArray[ParameterSymbol].Empty,
                TypeSymbol.Void,
                declaration
            )
        }

        private func UnrelatedFunctions(count int32) string -> "package Noise4663\n" + string.Concat(
            Enumerable.Range(0, count).Select((i int32) -> (`func g` + "$i" + `(x int32) int32 { return x + ` + "$i" + ` }
`))
        )

        private func AssertSourceOrder(first FunctionSymbol, second FunctionSymbol, expectedDirection int32) {
            let forward = SymbolSourceOrderComparer.Instance.Compare(first, second)
            let backward = SymbolSourceOrderComparer.Instance.Compare(second, first)
            Assert.Equal(expectedDirection, Math.Sign(forward))
            Assert.Equal(-expectedDirection, Math.Sign(backward))
            let expected = if expectedDirection < 0 {
                []FunctionSymbol{first, second}
            } else {
                []FunctionSymbol{second, first}
            }
            Assert.Equal(
                expected,
                []FunctionSymbol{first, second}.OrderBy((s FunctionSymbol) -> s, SymbolSourceOrderComparer.Instance)
            )
            Assert.Equal(
                expected,
                []FunctionSymbol{second, first}.OrderBy((s FunctionSymbol) -> s, SymbolSourceOrderComparer.Instance)
            )
        }

        private func TopLevelFunction($package string) FunctionSymbol -> FunctionSymbol(
            "f",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Int32,
            declaration: nil,
            $package: PackageSymbol($package, declaration: nil)
        )

        private func NestedChain(outermost string, depth int32) StructSymbol {
            var outer StructSymbol? = nil
            for var i = 0; i < depth; i++ {
                let type = StructSymbol(
                    if i == 0 {
                        outermost
                    } else {
                        "Inner"
                    },
                    ImmutableArray[FieldSymbol].Empty,
                    Accessibility.Public,
                    declaration: nil,
                    packageName: "p"
                )
                if outer != nil {
                    type.SetContainingType(outer)
                }
                outer = type
            }
            return outer!!// depth is positive, so the loop assigned it.

        }

        private func FunctionIn(container TypeSymbol) FunctionSymbol {
            let function = FunctionSymbol("f", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void)
            function.AnchorContainingType(container)
            return function
        }
    }
}
