// <copyright file="Adr0212MemberQueryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Text
import Xunit

/// ADR-0212 slice S4: (cref:SemanticModel.LookupMembers) and (cref:SemanticModel.GetMemberGroup).
/// One test per row of the contract tables in the documentation of the two queries. The marker
/// `// Pname` ends the line of the call or member access that the row queries.
open class Adr0212MemberQueryTests {
    // ---- GetMemberGroup, one test per row ----

    @Fact
    func MemberGroup_ImportedFunction_IsTheReflectionOverloadSetInMetadataOrder() {
        let group = Group("PConsole")
        Assert.True(group.Length > 5, "Console.WriteLine has many overloads: ${group.Length}")
        Assert.All(group, (s Symbol) -> Assert.IsType[ImportedFunctionSymbol](s))
        let tokens = group.Select((s Symbol) -> cast[ImportedFunctionSymbol](s).Method.MetadataToken).ToList()
        Assert.Equal(tokens.OrderBy((t int32) -> t).ToList(), tokens)
        Assert.All(group, (s Symbol) -> Assert.Equal("WriteLine", s.Name))
    }

    @Fact
    func MemberGroup_ImportedInstanceMethod_IsTheOverloadSetOfTheReceiverType() {
        let group = Group("PAppend")
        Assert.True(group.Length > 5, "StringBuilder.Append has many overloads: ${group.Length}")
        Assert.All(
            group,
            (s Symbol) -> Assert.Equal("StringBuilder", cast[ImportedFunctionSymbol](s).Method.DeclaringType!!.Name)
        )
    }

    @Fact
    func MemberGroup_LocalFunction_IsTheFunctionAlone() {
        let group = Group("PLocal")
        let only = Assert.Single(group)
        Assert.Equal("local", only.Name)
    }

    @Fact
    func MemberGroup_FreeFunction_IsOrderedByFilePathThenStart() {
        let group = Group("PFree")
        Assert.Equal(4, group.Length)
        let shapes = group.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToList()
        // a.gs declares the first two, in source order; b.gs the others.
        Assert.Equal([]string{"Free(int32)", "Free(string)", "Free(int32, int32)", "Free(bool)"}, shapes)
    }

    @Fact
    func MemberGroup_DeclaredMethods_AreTheMethodsOfTheReceiverType() {
        let group = Group("PCat")
        Assert.Equal(
            []string{"Purr(int32)", "Purr(string)"},
            group.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToArray()
        )
    }

    @Fact
    func MemberGroup_InheritedCall_ListsTheDerivedMethodsBeforeTheBase() {
        let group = Group("PInherited")
        Assert.Equal(
            []string{"Speak(bool)", "Speak(int32)", "Speak(string)", "Speak()"},
            group.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToList()
        )
    }

    @Fact
    func MemberGroup_InterfaceCall_ListsTheInterfaceMethodsNotItsPrivateHelpers() {
        let group = Group("PInterface")
        Assert.Equal(
            []string{"Read(int32)", "Read(string)"},
            group.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToArray()
        )
    }

    @Fact
    func MemberGroup_ConstructedGenericInterface_ListsTheMethodsAtTheConstructedType() {
        let group = Group("PBoxed")
        Assert.Equal(
            []string{"Put(int32)", "Put(int32, int32)"},
            group.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToList()
        )
    }

    @Fact
    func MemberGroup_TypeParameterWithConstraint_ListsTheMethodsOfTheConstraint() {
        let group = Group("PConstraint")
        Assert.Equal(
            []string{"Read(int32)", "Read(string)"},
            group.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToArray()
        )
    }

    @Fact
    func MemberGroup_PartialType_ListsThePartsByFilePath() {
        let group = Group("PPartial")
        Assert.Equal(
            []string{"Go(int32)", "Go(string)", "Go(bool)"},
            group.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToArray()
        )
    }

    @Fact
    func MemberGroup_FieldRead_IsTheMemberAlone() {
        let name = Names(Trees[0].Root).Last(
            (n NameExpressionSyntax) -> n.IdentifierToken.Text == "Legs" && n.Span.End <= Position("PProperty")
        )
        let only = Assert.Single(ModelOf(name).GetMemberGroup(name))
        Assert.IsType[FieldSymbol](only)
        Assert.Equal("Legs", only.Name)
    }

    @Fact
    func MemberGroup_NodeThatNamesNothing_IsEmpty() {
        let tree = Trees[0]
        let model = Compiled.GetSemanticModel(tree)
        Assert.True(model.GetMemberGroup(tree.Root).IsEmpty)
    }

    @Fact
    func MemberGroup_CallExpressionAndItsIdentifier_AnswerTheSameGroup() {
        let call = CallAt("PFree")
        let model = ModelOf(call)
        Assert.Equal(model.GetMemberGroup(call).ToArray(), model.GetMemberGroup(call.Identifier).ToArray())
    }

    @Fact
    func MemberGroup_IsDeterministic_WhateverTheOrderOfTheTrees() {
        let forward = Compilation(Trees[0], Trees[1])
        let backward = Compilation(Trees[1], Trees[0])
        let call = CallAt("PFree")
        let names = (model SemanticModel, c CallExpressionSyntax) -> model
            .GetMemberGroup(c)
            .Select((s Symbol) -> Describe(cast[FunctionSymbol](s)))
            .ToList()
        let first = names(forward.GetSemanticModel(Trees[0]), call)
        let second = names(backward.GetSemanticModel(Trees[0]), call)
        Assert.Equal(first, second)
    }

    // ---- LookupMembers, one test per row ----

    @Fact
    func LookupMembers_Struct_ListsInstanceMembersWithBasesLastThenOwnStatics() {
        let members = Members("PLookup", "Dog")
        let names = members.Select((s Symbol) -> s.Name).ToList()
        // The type's own members, then its base class's, then the static members of the type itself.
        Assert.Equal([]string{"Tag", "Speak", "Use", "Legs", "Speak", "Speak", "Speak", "Inside", "Make"}, names)
    }

    @Fact
    func LookupMembers_Struct_DoesNotOfferAStaticOfABaseClass() {
        Assert.DoesNotContain("BaseStatic", Members("PLookup", "Dog").Select((s Symbol) -> s.Name))
        Assert.Contains("BaseStatic", Members("PLookup", "Animal").Select((s Symbol) -> s.Name))
    }

    @Fact
    func LookupMembers_PrivateMember_IsOfferedOnlyInsideItsType() {
        Assert.DoesNotContain("Secret", Members("PLookup", "Animal").Select((s Symbol) -> s.Name))
        Assert.Contains("Secret", Members("PInsideAnimal", "Animal").Select((s Symbol) -> s.Name))
    }

    @Fact
    func LookupMembers_WithName_ReturnsEveryOverload() {
        let model = ModelOf(Trees[0].Root)
        let position = Position("PLookup")
        let speak = model.LookupMembers(position, TypeNamed("Dog"), "Speak")
        Assert.Equal(4, speak.Length)
        Assert.True(model.LookupMembers(position, TypeNamed("Dog"), "NoSuchMember").IsEmpty)
    }

    @Fact
    func LookupMembers_Interface_ListsInterfaceAndBaseInterfaceMembers() {
        let names = Members("PLookup", "ISub").Select((s Symbol) -> s.Name).ToList()
        Assert.Equal([]string{"Sub", "Read", "Read"}, names.Take(3).ToArray())
    }

    @Fact
    func LookupMembers_Enum_ListsTheEnumMembers() {
        let names = Members("PLookup", "Color").Select((s Symbol) -> s.Name).ToList()
        Assert.Equal([]string{"Red", "Green"}, names)
    }

    @Fact
    func LookupMembers_Tuple_ListsDeclaredNamesThenPositionalNames() {
        let model = ModelOf(Trees[0].Root)
        let pair = TupleTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32, TypeSymbol.String),
            ImmutableArray.Create[string?]("left", "right")
        )
        let names = model.LookupMembers(Position("PLookup"), pair).Select((s Symbol) -> s.Name).ToList()
        Assert.Equal([]string{"left", "Item1", "right", "Item2"}, names)
    }

    @Fact
    func LookupMembers_NullableReceiver_AnswersForTheUnderlyingType() {
        let model = ModelOf(Trees[0].Root)
        let nullable = NullableTypeSymbol.Get(TypeNamed("Dog"))
        let plain = model.LookupMembers(Position("PLookup"), TypeNamed("Dog"))
        Assert.Equal(plain.ToArray(), model.LookupMembers(Position("PLookup"), nullable).ToArray())
        Assert.NotEmpty(plain)
    }

    @Fact
    func LookupMembers_ImportedType_ListsPublicInstanceAndStaticMembers() {
        let model = ModelOf(Trees[0].Root)
        let console = model.LookupMembers(Position("PLookup"), ImportedTypeSymbol.Get(typeof(Console)), "WriteLine")
        Assert.True(console.Length > 5)
        Assert.All(console, (s Symbol) -> Assert.IsType[ImportedFunctionSymbol](s))
        let builder = model.LookupMembers(Position("PLookup"), ImportedTypeSymbol.Get(typeof(StringBuilder)))
        Assert.Contains(builder, (s Symbol) -> s is PropertySymbol && s.Name == "Length")
        Assert.Contains(builder, (s Symbol) -> s is ImportedFunctionSymbol && s.Name == "Append")
        Assert.DoesNotContain(builder, (s Symbol) -> s.Name == "get_Length")
        Assert.DoesNotContain(builder, (s Symbol) -> s.Name == "Item")
    }

    @Fact
    func LookupMembers_ImportedMember_CarriesItsReflectedMember() {
        let model = ModelOf(Trees[0].Root)
        let length = Assert.Single(
            model.LookupMembers(Position("PLookup"), ImportedTypeSymbol.Get(typeof(StringBuilder)), "Length")
        )
        Assert.Equal(typeof(StringBuilder).GetProperty("Length"), cast[PropertySymbol](length).ImportedMember)
    }

    @Fact
    func LookupMembers_ImportedMemberTypes_ComeFromTheNullabilityReaders() {
        // `Path.GetDirectoryName(string)` is annotated `string?`; `Environment.NewLine` is `string`.
        let model = ModelOf(Trees[0].Root)
        let position = Position("PLookup")
        let directory = Assert.Single(
            model
                .LookupMembers(position, ImportedTypeSymbol.Get(typeof(System.IO.Path)), "GetDirectoryName")
                .OfType[ImportedFunctionSymbol]()
                .Where((f ImportedFunctionSymbol) -> f.Method.GetParameters()[0].ParameterType == typeof(string))
        )
        Assert.IsType[NullableTypeSymbol](directory.Type)
        let newLine = Assert.Single(
            model.LookupMembers(position, ImportedTypeSymbol.Get(typeof(Environment)), "NewLine")
        )
        Assert.IsNotType[NullableTypeSymbol](cast[PropertySymbol](newLine).Type)
    }

    @Fact
    func LookupMembers_IsDeterministic() {
        let model = ModelOf(Trees[0].Root)
        let position = Position("PLookup")
        let first = model.LookupMembers(position, ImportedTypeSymbol.Get(typeof(StringBuilder)))
        let second = ModelOf(Trees[0].Root).LookupMembers(position, ImportedTypeSymbol.Get(typeof(StringBuilder)))
        Assert.Equal(
            first.Select((s Symbol) -> s.Name + ":" + s.Kind.ToString()).ToList(),
            second.Select((s Symbol) -> s.Name + ":" + s.Kind.ToString()).ToList()
        )
    }

    // ---- Support ----

    shared {
        private func Describe(function FunctionSymbol) string {
            return function.Name + "(" + string.Join(
                ", ",
                function.Parameters.Select((p ParameterSymbol) -> p.Type.Name)
            ) +
                ")"
        }

        private const FileA string = `package Members
import System
import System.Text

func Free(x int32) int32 { return x }
func Free(s string) string { return s }

enum Color { Red, Green }

interface IRead {
    func Read(a int32) int32
    func Read(a string) int32
}

interface ISub : IRead {
    func Sub() int32
}

interface IBoxed[T] {
    func Put(v T) int32
    func Put(v T, n int32) int32
}

open class Animal {
    var Legs int32
    private var Secret int32
    func Speak(a int32) string { return "" }
    func Speak(a string) string { return a }
    func Speak() string { return "" }
    func Inside() int32 {
        return Secret // PInsideAnimal
    }
    shared {
        var BaseStatic int32 = 1
    }
}

class Dog : Animal {
    var Tag string
    func Speak(a bool) string { return "" }
    func Use(d Dog) {
        d.Speak(1) // PInherited
        let n = d.Legs // PProperty
    }
    shared {
        func Make() Dog {
            return Dog{}
        }
    }
}

class Cat {
    func Purr(a int32) int32 { return a }
    func Purr(a string) int32 { return 0 }
}

partial class Parts {
    func Go(a int32) int32 { return a }
    func Go(a string) int32 { return 0 }
}

func Constrained[T IRead](t T) int32 {
    return t.Read(1) // PConstraint
}

func UseAll(c Cat, r IRead, b IBoxed[int32], p Parts, sb StringBuilder) {
    Console.WriteLine("x") // PConsole
    sb.Append(1) // PAppend
    let local = func(q int32) int32 { return q }
    local(1) // PLocal
    Free(1) // PFree
    c.Purr(1) // PCat
    r.Read(1) // PInterface
    b.Put(1) // PBoxed
    p.Go(1) // PPartial
    // PLookup
}
`

        private const FileB string = `package Members

func Free(x int32, y int32) int32 { return x + y }
func Free(flag bool) bool { return flag }

partial class Parts {
    func Go(a bool) int32 { return 0 }
}
`

        private let Trees[]SyntaxTree = []SyntaxTree{
            SyntaxTree.Parse(SourceText.From(FileA, "a.gs")),
            SyntaxTree.Parse(SourceText.From(FileB, "b.gs"))
        }

        // One compilation for every row, with the trees in reverse path order.
        private let Compiled Compilation = CreateCompilation()

        private func CreateCompilation() Compilation {
            let compilation = Compilation(Trees[1], Trees[0])
            Assert.Empty(compilation.GlobalScope.Diagnostics)
            Assert.Empty(compilation.BoundProgram.Diagnostics)
            return compilation
        }

        private func ModelOf(node SyntaxNode) SemanticModel {
            return Compiled.GetSemanticModel(node.SyntaxTree)
        }

        private func Position(marker string) int32 {
            let at = FileA.IndexOf("// " + marker + "\n", StringComparison.Ordinal)
            Assert.True(at >= 0, "marker ${marker} is in the source")
            return at
        }

        private func CallAt(marker string) CallExpressionSyntax {
            let position = Position(marker)
            let lineStart = FileA.LastIndexOf('\n', position - 1) + 1
            var best CallExpressionSyntax? = nil
            for call in Calls(Trees[0].Root) {
                if call
                    .Span
                    .Start >= lineStart &&
                    call
                    .Span
                    .End <= position &&
                    (best == nil || call.Span.End >= best.Span.End) {
                    best = call
                }
            }
            return Invariant.Required(best, "a call before the marker", expression: "best")
        }

        private func Names(node SyntaxNode) sequence[NameExpressionSyntax] {
            if node is NameExpressionSyntax name {
                yield name
            }
            for child in node.GetChildren() {
                for nested in Names(child) {
                    yield nested
                }
            }
        }

        private func Calls(node SyntaxNode) sequence[CallExpressionSyntax] {
            if node is CallExpressionSyntax call {
                yield call
            }
            for child in node.GetChildren() {
                for nested in Calls(child) {
                    yield nested
                }
            }
        }

        private func Group(marker string) ImmutableArray[Symbol] {
            let call = CallAt(marker)
            return ModelOf(call).GetMemberGroup(call)
        }

        private func TypeNamed(name string) TypeSymbol {
            return Assert.IsAssignableFrom[TypeSymbol](
                ModelOf(Trees[0].Root).LookupSymbols(Position("PLookup"), name).Single()
            )
        }

        private func Members(marker string, typeName string) ImmutableArray[Symbol] {
            return ModelOf(Trees[0].Root).LookupMembers(Position(marker), TypeNamed(typeName))
        }
    }
}
