// <copyright file="Adr0212InheritedMemberTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0212 issue #5441: the members that (cref:SemanticModel.LookupMembers) takes from outside the receiver's own
/// declaration, one test group per row of the contract table in the documentation of the query. The marker
/// `// Pname` ends the line of the member access whose receiver type the row queries.
open class Adr0212InheritedMemberTests {
    @Fact
    func Fixture_HasNoDiagnostics() {
        Assert.Empty(Compiled.GetDiagnostics().Select((d Diagnostic) -> d.ToString()).ToArray())
    }

    // ---- Row: imported base class of a source class ----

    @Fact
    func ImportedBase_ListsThePublicInstanceMembersOfTheBaseAfterTheSourceMembers() {
        let members = Query("PBuffer")
        let own = members.IndexOf(members.First((m Symbol) -> m.Name == "Mark"))
        let inherited = members.IndexOf(members.First((m Symbol) -> m.Name == "SetLength"))
        Assert.True(own < inherited, "source members come before the inherited ones")
        let setLength = Assert.Single(Query("PBuffer", "SetLength"))
        Assert.Equal("SetLength", cast[ImportedFunctionSymbol](setLength).Method.Name)
        Assert.NotEmpty(Query("PBuffer", "Position"))
    }

    @Fact
    func ImportedBase_ReachedThroughASourceBase_IsListed() {
        let message = Assert.Single(Query("PGrandChild", "Message"))
        Assert.IsType[PropertySymbol](message)
        Assert.Equal("Exception", cast[PropertySymbol](message).ImportedMember!!.DeclaringType!!.Name)
    }

    @Fact
    func ImportedBase_DoesNotListStaticOrNonPublicMembersOfTheBase() {
        // `Stream.Null` is static; `Stream.Dispose(bool)` is protected.
        Assert.Empty(Query("PBuffer", "Null"))
        // `EventArgs.Empty` is a static of the base itself, and `object.ReferenceEquals` one of `object`.
        Assert.Empty(Query("PArgs", "Empty"))
        Assert.Empty(Query("PPlain", "ReferenceEquals"))
        Assert.NotEmpty(Query("PArgs", "ToString"))
        Assert.DoesNotContain(
            Query("PBuffer", "Dispose").OfType[ImportedFunctionSymbol](),
            (m ImportedFunctionSymbol) -> m.Method.GetParameters().Length == 1
        )
    }

    @Fact
    func ImportedBase_MemberTypesComeFromTheNullabilityReaders() {
        // `Exception.InnerException` is annotated `Exception?`; `Message` is `string`.
        let inner = cast[PropertySymbol](Assert.Single(Query("PGrandChild", "InnerException")))
        Assert.IsType[NullableTypeSymbol](inner.Type)
        let message = cast[PropertySymbol](Assert.Single(Query("PGrandChild", "Message")))
        Assert.Equal(TypeSymbol.String, message.Type)
    }

    @Fact
    func ImportedBase_ClassWithoutOne_ListsTheMembersOfObject() {
        let toString = Assert.Single(Query("PPlain", "ToString"))
        Assert.Equal("Object", cast[ImportedFunctionSymbol](toString).Method.DeclaringType!!.Name)
        Assert.NotEmpty(Query("PPlain", "GetHashCode"))
        Assert.Empty(Query("PPlain", "Finalize"))
    }

    @Fact
    func ImportedBase_ConstructedGenericBase_ReadsMemberTypesAtTheBase() {
        // `class Names : List[string]`: `Add` takes the base's argument, not the open `T`.
        let add = cast[ImportedFunctionSymbol](Assert.Single(Query("PNames", "Add")))
        Assert.Equal("List`1", add.Method.DeclaringType!!.Name)
        let item = Assert.Single(Query("PNames", "Count"))
        Assert.Equal(TypeSymbol.Int32, cast[PropertySymbol](item).Type)
    }

    @Fact
    func ImportedBase_AMemberTheTypeOverrides_IsListedOnceAsTheOverride() {
        // The override stands for the slot: `object.ToString`, `Stream.SetLength` and `Exception.Message` are
        // not listed again, so a hover overload count is not doubled.
        for pair in[](string, string){("PShown", "ToString"), ("PStream", "SetLength"), ("PFaulty", "Message")} {
            let only = Assert.Single(Query(pair.Item1, pair.Item2))
            Assert.IsType[StructSymbol](only.ContainingType)
        }
        // An overload the type does not override is still listed.
        Assert.NotEmpty(Query("PStream", "Write"))
        Assert.Contains(
            Query("PShown", "Equals"),
            (m Symbol) -> m is ImportedFunctionSymbol imported && imported.Method.DeclaringType!!.Name == "Object"
        )
    }

    @Fact
    func ImportedBase_ACompilerOwnedOverride_StandsForTheSlotToo() {
        // A data type's synthesized `Equals(object)` overrides `object.Equals(object)` without naming the slot.
        for marker in[]string{"PDataStruct", "PDataClass"} {
            let equals = Query(marker, "Equals")
            Assert.DoesNotContain(
                equals,
                (m Symbol) -> m is ImportedFunctionSymbol imported &&
                    imported
                    .Method
                    .DeclaringType!!.Name == "Object" &&
                    imported
                    .Method
                    .GetParameters()
                    .Length == 1
            )
            Assert.NotEmpty(equals)
        }
    }

    @Fact
    func ImportedBase_ArgumentNullability_IsReadAtTheBase() {
        // `class Maybes : List[string?]`: `GetRange` returns the base's `List<T>`, read at `T = string?`.
        let slice = cast[ImportedFunctionSymbol](Assert.Single(Query("PMaybes", "GetRange")))
        Assert.Contains("string?", SymbolDisplay.ToTypeDisplayString(slice.Type), StringComparison.Ordinal)
    }

    // ---- Row: base interfaces of an imported interface ----

    @Fact
    func ImportedInterface_ListsTheMembersOfItsBaseInterfaces() {
        let count = cast[PropertySymbol](Assert.Single(Query("PIList", "Count")))
        Assert.Equal("ICollection`1", count.ImportedMember!!.DeclaringType!!.Name)
        Assert.Equal(TypeSymbol.Int32, count.Type)
        let add = Assert.Single(Query("PIList", "Add"))
        Assert.Equal("ICollection`1", cast[ImportedFunctionSymbol](add).Method.DeclaringType!!.Name)
        // Both `IEnumerable<T>.GetEnumerator` and `IEnumerable.GetEnumerator`.
        Assert.Equal(2, Query("PIList", "GetEnumerator").Length)
    }

    @Fact
    func ImportedInterface_BaseMembersAreReadAtTheReceiversArguments() {
        let enumerator = Query("PIList", "GetEnumerator").OfType[ImportedFunctionSymbol]().First(
            (f ImportedFunctionSymbol) -> f.Method.DeclaringType!!.IsGenericType
        )
        Assert.Contains("[string]", SymbolDisplay.ToTypeDisplayString(enumerator.Type), StringComparison.Ordinal)
    }

    @Fact
    func ImportedInterface_BaseMembersAreListedOnceOnADeclaredInterface() {
        // `ICounted : IList[string]` already walks every base through the transitive list.
        Assert.Single(Query("PCounted", "Count"))
        Assert.Single(Query("PCounted", "Add"))
    }

    // ---- Row: default methods of the interfaces a class implements ----

    @Fact
    func DefaultMethod_OfAnImplementedInterface_IsListedOnTheClass() {
        let area = Assert.Single(Query("PSquare", "Area"))
        Assert.IsType[FunctionSymbol](area)
        Assert.IsType[InterfaceSymbol](area.ContainingType)
        Assert.Equal("IShape", area.ContainingType!!.Name)
    }

    @Fact
    func DefaultMethod_OfABaseInterfaceAndOfABaseClassInterface_IsListed() {
        Assert.Equal("IBase", Assert.Single(Query("PSub", "Hello")).ContainingType!!.Name)
        Assert.Equal("IShape", Assert.Single(Query("PInheritor", "Area")).ContainingType!!.Name)
    }

    @Fact
    func DefaultMethod_TheClassDeclaresAMethodOfTheName_IsHidden() {
        let area = Assert.Single(Query("PRound", "Area"))
        Assert.IsType[StructSymbol](area.ContainingType)
    }

    @Fact
    func DefaultMethod_APrivateHelper_IsNotListedOutsideTheInterface() {
        Assert.Empty(Query("PSquare", "Secret"))
        Assert.Single(Query("PSquare", "Visible"))
    }

    @Fact
    func DefaultMethod_AbstractInterfaceMethod_IsNotListedAgain() {
        // `Perimeter` is abstract and implemented by `Square`: the class's own method is the only one.
        let perimeter = Assert.Single(Query("PSquare", "Perimeter"))
        Assert.IsType[StructSymbol](perimeter.ContainingType)
    }

    // ---- Row: built-in members of the slice, array, map, channel and sequence types ----

    @Fact
    func BuiltIn_OfACollectionOfASourceType_HasTheMembersOfTheCollectionOfAPrimitive() {
        for pair in[]string{"Slice", "Array", "Map", "Channel", "Sequence"} {
            let ofSource = OwnMembers(Query("P" + pair + "Source"))
            let ofPrimitive = OwnMembers(Query("P" + pair + "Primitive"))
            Assert.NotEmpty(ofSource)
            Assert.Equal(ofPrimitive, ofSource)
        }
    }

    @Fact
    func BuiltIn_Slice_OfASourceType_ListsLengthAndTheMethodsOfSystemArray() {
        let length = cast[PropertySymbol](Assert.Single(Query("PSliceSource", "Length")))
        Assert.Equal(TypeSymbol.Int32, length.Type)
        Assert.NotEmpty(Query("PSliceSource", "Clone"))
        Assert.NotEmpty(Query("PArraySource", "GetLength"))
    }

    @Fact
    func BuiltIn_Map_OfASourceType_ReadsMemberTypesAtItsArguments() {
        let count = cast[PropertySymbol](Assert.Single(Query("PMapSource", "Count")))
        Assert.Equal(TypeSymbol.Int32, count.Type)
        let tryGetValue = cast[ImportedFunctionSymbol](Assert.Single(Query("PMapSource", "TryGetValue")))
        Assert.Equal(TypeSymbol.Bool, tryGetValue.Type)
        Assert.Equal("Dictionary`2", tryGetValue.Method.DeclaringType!!.Name)
    }

    @Fact
    func BuiltIn_Channel_OfASourceType_ListsTheReaderAndTheWriter() {
        Assert.NotEmpty(Query("PChannelSource", "Reader"))
        Assert.NotEmpty(Query("PChannelSource", "Writer"))
    }

    @Fact
    func BuiltIn_Sequence_OfASourceType_ListsGetEnumerator() {
        let enumerators = Query("PSequenceSource", "GetEnumerator")
        Assert.Equal(2, enumerators.Length)
    }

    // ---- The rows together ----

    @Fact
    func InheritedMembers_AreTheOnesTheBinderBound() {
        for marker in[]string{
            "PBuffer",
            "PGrandChild",
            "PPlain",
            "PNames",
            "PIList",
            "PSquare",
            "PSub",
            "PSliceSource"
        } {
            let access = AccessAt(marker)
            let token = access.RightPart.GetFirstToken()
            let bound = Invariant.Required(
                ModelOf().GetSymbolInfo(token).Symbol,
                "the binder bound the member",
                expression: "bound"
            )
            Assert.Contains(
                Query(marker, token.ValueText),
                (m Symbol) -> m.Name == bound.Name && m.GetType() == bound.GetType()
            )
        }
    }

    @Fact
    func InheritedMembers_NullableReceiver_AnswersForTheUnderlyingType() {
        let plain = Names(Query("PSquare"))
        let nullable = Names(
            ModelOf().LookupMembers(Position("PSquare"), NullableTypeSymbol.Get(ReceiverOf("PSquare")))
        )
        Assert.Equal(plain, nullable)
    }

    @Fact
    func InheritedMembers_AreDeterministic() {
        for marker in[]string{"PBuffer", "PIList", "PSquare", "PMapSource"} {
            let first = Names(Query(marker))
            Assert.Equal(first, Names(Query(marker)))
            Assert.Equal(
                first,
                Names(Compilation(Tree).GetSemanticModel(Tree).LookupMembers(Position(marker), ReceiverOf(marker)))
            )
        }
    }

    shared {
        private const Source string = `package Inh
import System
import System.IO
import System.Collections.Generic

class Buffer : MemoryStream {
    func Mark() int32 { return 1 }
}

open class Child : Exception { }

class GrandChild : Child { }

class Plain { }

class Names : List[string] { }

class Maybes : List[string?] { }

class Args : EventArgs { }

data struct Pt {
    let X int32
}

data class Node {
    let Id int32
}

class Shown {
    override func ToString() string { return "shown" }
}

class Raw : MemoryStream {
    override func SetLength(value int64) { }
}

class Faulty : Exception {
    override prop Message string -> "faulty"
}

interface ICounted : IList[string] { }

interface IShape {
    func Area() int32 { return 1 }
    func Perimeter() int32;
    func Visible() int32 { return Secret() }
    private func Secret() int32 { return 0 }
}

open class Square : IShape {
    func Perimeter() int32 { return 4 }
}

class Round : IShape {
    func Area() int32 { return 3 }
    func Perimeter() int32 { return 6 }
}

class Inheritor : Square { }

interface IBase {
    func Hello() int32 { return 1 }
}

interface ISub : IBase { }

class Sub : ISub { }

class Item { var X int32 = 0 }

func Use(
    b Buffer,
    g GrandChild,
    p Plain,
    n Names,
    maybes Maybes,
    args Args,
    shown Shown,
    pt Pt,
    node Node,
    raw Raw,
    faulty Faulty,
    il IList[string],
    c ICounted,
    sq Square,
    r Round,
    i Inheritor,
    s Sub,
    sliceSource []Item,
    slicePrimitive []int32,
    arraySource [3]Item,
    arrayPrimitive [3]int32,
    mapSource map[string, Item],
    mapPrimitive map[string, int32],
    channelSource chan[Item],
    channelPrimitive chan[int32],
    sequenceSource sequence[Item],
    sequencePrimitive sequence[int32]
) {
    b.Mark() // PBuffer
    let message = g.Message // PGrandChild
    p.ToString() // PPlain
    n.Add("a") // PNames
    let found = maybes.GetRange(0, 1) // PMaybes
    args.ToString() // PArgs
    shown.ToString() // PShown
    pt.Equals(pt) // PDataStruct
    node.Equals(node) // PDataClass
    raw.SetLength(1) // PStream
    let text = faulty.Message // PFaulty
    let listed = il.Count // PIList
    let counted = c.Count // PCounted
    sq.Area() // PSquare
    r.Area() // PRound
    i.Area() // PInheritor
    s.Hello() // PSub
    let sliceLength = sliceSource.Length // PSliceSource
    let primitiveLength = slicePrimitive.Length // PSlicePrimitive
    let arrayLength = arraySource.Length // PArraySource
    let arrayPrimitiveLength = arrayPrimitive.Length // PArrayPrimitive
    let mapCount = mapSource.Count // PMapSource
    let mapPrimitiveCount = mapPrimitive.Count // PMapPrimitive
    let reader = channelSource.Reader // PChannelSource
    let primitiveReader = channelPrimitive.Reader // PChannelPrimitive
    sequenceSource.GetEnumerator() // PSequenceSource
    sequencePrimitive.GetEnumerator() // PSequencePrimitive
}
`

        private let Tree SyntaxTree = SyntaxTree.Parse(SourceText.From(Source, "inh.gs"))

        private let Compiled Compilation = Compilation(Tree)

        private func ModelOf() SemanticModel {
            return Compiled.GetSemanticModel(Tree)
        }

        private func Position(marker string) int32 {
            let at = Source.IndexOf("// " + marker + "\n", StringComparison.Ordinal)
            Assert.True(at >= 0, "marker ${marker} is in the source")
            return at
        }

        private func AccessAt(marker string) AccessorExpressionSyntax {
            let position = Position(marker)
            let lineStart = Source.LastIndexOf('\n', position - 1) + 1
            var best AccessorExpressionSyntax? = nil
            for node in Tree.Root.DescendantNodes() {
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
            let type = ModelOf().GetReceiverTypeInfo(AccessAt(marker).LeftPart).Type
            return Invariant.Required(type, "a receiver type", expression: "type")
        }

        private func Query(marker string, name string? = nil) ImmutableArray[Symbol] {
            return ModelOf().LookupMembers(Position(marker), ReceiverOf(marker), name)
        }

        private func Names(members ImmutableArray[Symbol])[]string {
            return members.Select((m Symbol) -> m.Name + "@" + m.GetType().Name).ToArray()
        }

        // The extensions in scope depend on the element type (a constraint such as IEquatable), not on the
        // collection; the built-in members do not.
        private func OwnMembers(members ImmutableArray[Symbol])[]string {
            return members
                .Where(
                (m Symbol) -> !(m is FunctionSymbol{IsExtension: true}) &&
                    !(
                    m is ImportedFunctionSymbol imported && imported.Method.IsDefined(
                        typeof(System.Runtime.CompilerServices.ExtensionAttribute),
                        false
                    )
                )
            )
                .Select((m Symbol) -> m.Name + "@" + m.GetType().Name)
                .ToArray()
        }
    }
}
