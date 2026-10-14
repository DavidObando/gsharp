// <copyright file="Issue2851GenericDiagnosticDisplayTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Runtime.InteropServices
import Xunit

/// Issue #2851: diagnostic type display preserves constructed generic arguments
/// without changing metadata-facing symbol names.
open class Issue2851GenericDiagnosticDisplayTests {
    @Fact
    func Gs0155_DisplaysConstructedSourceTypesAndNullableForms() {
        const source = `package P

class Box[T] {}
struct Cell[T] { var Value T }
delegate Conv[T](v T) void;

func Test() {
    var box Box[int32] = Box[int32]()
    var classText string = box

    var nullableBox Box[int32]? = nil
    var nullableClassText string = nullableBox

    var nested Box[Box[int32]] = Box[Box[int32]]()
    var nestedText string = nested

    var nullableConv Conv[int32]? = nil
    nullableConv = (s string) -> {}

    var conv Conv[int32] = (v int32) -> {}
    var delegateText string = conv
    var nullableDelegateText string = nullableConv

    var cell Cell[int32] = Cell[int32]{Value: 1}
    var structText string = cell

    var nullableCell Cell[int32]? = nil
    var nullableStructText string = nullableCell
}`
        let diagnostics = GetDiagnostics(source)
        AssertDiagnostic(diagnostics, "GS0155", "Cannot convert type 'Box[int32]' to 'string'.")
        AssertDiagnostic(diagnostics, "GS0155", "Cannot convert type 'Box[int32]?' to 'string'.")
        AssertDiagnostic(diagnostics, "GS0155", "Cannot convert type 'Box[Box[int32]]' to 'string'.")
        AssertDiagnostic(diagnostics, "GS0155", "Cannot convert type '(string) -> void' to 'Conv[int32]?'.")
        AssertDiagnostic(diagnostics, "GS0155", "Cannot convert type 'Conv[int32]' to 'string'.")
        AssertDiagnostic(diagnostics, "GS0155", "Cannot convert type 'Conv[int32]?' to 'string'.")
        AssertDiagnostic(diagnostics, "GS0155", "Cannot convert type 'Cell[int32]' to 'string'.")
        AssertDiagnostic(diagnostics, "GS0155", "Cannot convert type 'Cell[int32]?' to 'string'.")
    }

    @Fact
    func DiagnosticDisplay_RecursesThroughConstructedTypeWrappers() {
        let compilation = CreateCompilation("package P\nclass Box[T] {}")
        let definition = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Box")
        let box = StructSymbol.Construct(definition, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        let cases = [](Type TypeSymbol, Display string){
            (ArrayTypeSymbol.Get(box, 3), "[3]Box[int32]"),
            (SliceTypeSymbol.Get(box), "[]Box[int32]"),
            (SequenceTypeSymbol.Get(box), "sequence[Box[int32]]"),
            (MapTypeSymbol.Get(TypeSymbol.String, box), "map[string,Box[int32]]"),
            (ChannelTypeSymbol.Get(box), "chan[Box[int32]]"),
            (TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](box, TypeSymbol.Int32)), "(Box[int32], int32)"),
            (FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](box), TypeSymbol.Void), "(Box[int32]) -> void"),
            (
                FunctionPointerTypeSymbol.GetManaged(ImmutableArray.Create[TypeSymbol](box), box),
                "*func(Box[int32]) Box[int32]"
            ),
            (
                FunctionPointerTypeSymbol.Get(CallingConvention.Cdecl, ImmutableArray.Create[TypeSymbol](box), box),
                "unmanaged[Cdecl] (Box[int32]) -> Box[int32]"
            ),
            (PointerTypeSymbol.Get(box), "*Box[int32]"),
            (PinnedTypeSymbol(box), "pinned Box[int32]")
        }
        for (type, display) in cases {
            let bag = DiagnosticBag()
            bag.ReportCannotConvert(MakeLocation(), type, TypeSymbol.String)
            let diagnostic = Assert.Single(bag)
            Assert.Equal("Cannot convert type '$display' to 'string'.", diagnostic.Message)
        }
    }

    @Fact
    func FixedArrayDisplay_DistinguishesNullableArrayFromNullableElements() {
        let nullableArray = NullableTypeSymbol.Get(ArrayTypeSymbol.Get(TypeSymbol.Int32, 3))
        let nullableElements = ArrayTypeSymbol.Get(NullableTypeSymbol.Get(TypeSymbol.Int32), 3)
        let nullableArrayAndElements = NullableTypeSymbol.Get(nullableElements)
        Assert.Equal("[3]?int32", SymbolDisplay.ToTypeDisplayString(nullableArray))
        Assert.Equal("[3]int32?", SymbolDisplay.ToTypeDisplayString(nullableElements))
        Assert.Equal("[3]?int32?", SymbolDisplay.ToTypeDisplayString(nullableArrayAndElements))
        Assert.NotEqual(
            SymbolDisplay.ToTypeDisplayString(nullableArray),
            SymbolDisplay.ToTypeDisplayString(nullableElements)
        )
    }

    @Fact
    func SymbolDisplay_CoversInterfacesMultipleArgumentsDefinitionsAndNestedTypes() {
        let compilation = CreateCompilation(`package P

interface Contract[T] {}
class Pair[T, U] {}
struct Outer[T] {
    struct Tag {}
    struct Inner[U] {}
}

func Use(tag Outer[int32].Tag, inner Outer[int32].Inner[string]) {}`)
        let contractDefinition = compilation.GlobalScope.Interfaces.Single((i InterfaceSymbol) -> i.Name == "Contract")
        let pairDefinition = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Pair")
        let contract = InterfaceSymbol.Construct(
            contractDefinition,
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32)
        )
        let pair = StructSymbol.Construct(
            pairDefinition,
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32, TypeSymbol.String)
        )
        let use = compilation.GlobalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Use")
        Assert.Equal("Contract[T]", SymbolDisplay.ToTypeDisplayString(contractDefinition))
        Assert.Equal("Contract[int32]", SymbolDisplay.ToTypeDisplayString(contract))
        Assert.Equal("Pair[T, U]", SymbolDisplay.ToTypeDisplayString(pairDefinition))
        Assert.Equal("Pair[int32, string]", SymbolDisplay.ToTypeDisplayString(pair))
        Assert.Equal("Outer[int32].Tag", SymbolDisplay.ToTypeDisplayString(use.Parameters[0].Type))
        Assert.Equal("Outer[int32].Inner[string]", SymbolDisplay.ToTypeDisplayString(use.Parameters[1].Type))
    }

    @Fact
    func ImportedTypes_DisplayAnnotatedNestedAndOpenGenericForms() {
        let annotated = NullabilityAnnotatedTypeSymbol(
            ImportedTypeSymbol.Get(typeof(List[int32])),
            ImmutableArray.Create[uint8](uint8(1), uint8(1))
        )
        Assert.Equal("System.Collections.Generic.List[int32]", SymbolDisplay.ToTypeDisplayString(annotated))
        Assert.Equal(
            "System.Collections.Generic.Dictionary[int32, string].Enumerator",
            SymbolDisplay.ToTypeDisplayString(ImportedTypeSymbol.Get(typeof(Dictionary[int32, string].Enumerator)))
        )
        Assert.Equal(
            "GSharp.Core.Tests.CodeAnalysis.Binding.Issue2851ImportedOuter[int32].Inner[string]",
            SymbolDisplay.ToTypeDisplayString(
                ImportedTypeSymbol.Get(typeof(Issue2851ImportedOuter[int32].Inner[string]))
            )
        )
        Assert.Equal(
            "GSharp.Core.Tests.CodeAnalysis.Binding.Issue2851ImportedOuter[int32].Inner[string]",
            SymbolDisplay.ToTypeDisplayString(
                ImportedTypeSymbol.GetConstructed(
                    typeof(Issue2851ImportedOuter[int32].Inner[string]),
                    typeof(Issue2851ImportedOuter[_].Inner[_]),
                    ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32, TypeSymbol.String)
                )
            )
        )
        Assert.Equal(
            "System.Collections.Generic.List[T]",
            SymbolDisplay.ToTypeDisplayString(ImportedTypeSymbol.Get(typeof(System.Collections.Generic.List[_])))
        )
    }

    @Fact
    func Gs0156_UsesSameConstructedTypeDisplayWithoutChangingName() {
        let compilation = CreateCompilation(`package P
class Box[T] {}
delegate Conv[T](v T) void;
func Make() Box[int32] { return Box[int32]() }`)
        let boxDefinition = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Box")
        let delegateDefinition = compilation.GlobalScope.Delegates.Single((d DelegateTypeSymbol) -> d.Name == "Conv")
        let make = compilation.GlobalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Make")
        let box = StructSymbol.Construct(boxDefinition, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        let conv = DelegateTypeSymbol.Construct(delegateDefinition, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        let nullableBox = NullableTypeSymbol.Get(box)
        let nullableConv = NullableTypeSymbol.Get(conv)
        let bag = DiagnosticBag()
        let location = MakeLocation()
        bag.ReportCannotConvertImplicitly(location, box, nullableBox)
        bag.ReportCannotConvertImplicitly(location, nullableConv, conv)
        Assert.Equal("Box", box.Name)
        Assert.Equal("Conv", conv.Name)
        Assert.Equal("Box[T]", SymbolDisplay.ToTypeDisplayString(boxDefinition))
        Assert.Equal("Conv[T]", SymbolDisplay.ToTypeDisplayString(delegateDefinition))
        Assert.Contains("Box[int32]", make.ToString(), StringComparison.Ordinal)
        Assert.Collection(
            bag,
            (diagnostic Diagnostic) -> Assert.Equal(
                "Cannot convert type 'Box[int32]' to 'Box[int32]?'. An explicit conversion exists (are you missing a cast?)",
                diagnostic.Message
            ),
            (diagnostic Diagnostic) -> Assert.Equal(
                "Cannot convert type 'Conv[int32]?' to 'Conv[int32]'. An explicit conversion exists (are you missing a cast?)",
                diagnostic.Message
            )
        )
    }

    @Fact
    func ImportedConstructedGeneric_UsesGSharpSyntaxWithoutClrArity() {
        let bag = DiagnosticBag()
        bag.ReportCannotConvertImplicitly(
            MakeLocation(),
            ImportedTypeSymbol.Get(typeof(List[int32])),
            TypeSymbol.String
        )
        let diagnostic = Assert.Single(bag)
        Assert.Equal(
            "Cannot convert type 'System.Collections.Generic.List[int32]' to 'string'. An explicit conversion exists (are you missing a cast?)",
            diagnostic.Message
        )
    }

    shared {
        private func GetDiagnostics(source string) ImmutableArray[Diagnostic] {
            let compilation = CreateCompilation(source)
            return compilation
                .SyntaxTrees
                .SelectMany(
                func (tree SyntaxTree) IEnumerable[Diagnostic] {
                    return tree.Diagnostics
                }
            )
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((diagnostic Diagnostic) -> diagnostic.IsError)
                .ToImmutableArray()
        }

        private func CreateCompilation(source string) Compilation -> Compilation(
            SyntaxTree.Parse(SourceText.From(source))
        )

        private func AssertDiagnostic(
            diagnostics ImmutableArray[Diagnostic],
            id string,
            message string
        ) -> Assert.Contains(
            diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Id == id && diagnostic.Message == message
        )

        private func MakeLocation() TextLocation -> TextLocation(SourceText.From("x"), TextSpan(0, 1))
    }
}

internal class Issue2851ImportedOuter[T] {
    internal class Inner[TValue] { }
}
