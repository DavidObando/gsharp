package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Collections.Generic
import System.Linq
import Xunit
import Xunit.Abstractions

class Issue5492ImportedMethodDisplayTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Theory
    @InlineData("Item", "Add", "func Add(key string, value Item)", "Item", false)
    @InlineData(
        "Item",
        "GetEnumerator",
        "func GetEnumerator() IEnumerator[Item]",
        "System.Collections.Generic.IEnumerator[Item]",
        false
    )
    @InlineData("object", "Add", "func Add(key string, value object)", "object", false)
    @InlineData(
        "string",
        "GetEnumerator",
        "func GetEnumerator() IEnumerator[string]",
        "System.Collections.Generic.IEnumerator[string]",
        false
    )
    @InlineData("[]Item?", "Add", "func Add(key string, value []Item?)", "[]Item?", false)
    @InlineData(
        "[]Item?",
        "GetEnumerator",
        "func GetEnumerator() IEnumerator[[]Item?]",
        "System.Collections.Generic.IEnumerator[[]Item?]",
        false
    )
    @InlineData("Item", "Add", "func Add(key string, value Item)", "Item", true)
    @InlineData("[3]int32", "Add", "func Add(key string, value [3]int32)", "[3]int32", false)
    @InlineData(
        "[3]int32",
        "GetEnumerator",
        "func GetEnumerator() IEnumerator[[3]int32]",
        "System.Collections.Generic.IEnumerator[[3]int32]",
        false
    )
    @InlineData(
        "(line int32, column int32)",
        "Add",
        "func Add(key string, value (line int32, column int32))",
        "(line int32, column int32)",
        false
    )
    func ReceiverSignature_IsSharedByBoundSymbolHoverSignatureHelpAndCompletion(
        element string,
        member string,
        expected string,
        expectedBoundType string,
        inherited bool
    ) {
        let expression = if member == "Add" {
            if element == "Item" {
                "d.Add(\"a\", Item{})"
            } else {
                "d.Add(\"a\", value)"
            }
        } else {
            "s.GetEnumerator()"
        }
        let source = `import System.Collections.Generic
class Item { var X int32 = 0 }
INHERITED
func Use(d RECEIVER, s sequence[ELEMENT], value ELEMENT) {
    EXPRESSION
}`.Replace(
            "INHERITED",
            if inherited {
                "class Items : Dictionary[string, Item] { }"
            } else {
                ""
            }
        ).Replace(
            "RECEIVER",
            if inherited {
                "Items"
            } else {
                "Dictionary[string, ELEMENT]"
            }
        ).Replace("ELEMENT", element).Replace("EXPRESSION", expression)
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = ServerCompilation.Create(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let model = compilation.GetSemanticModel(content.SyntaxTree)
        let position = LanguageServerTestHelpers.PositionOf(source, member + "(")
        let token = Assert.IsAssignableFrom[SyntaxToken](
            SemanticLookup.FindTokenAt(content.SyntaxTree, SemanticLookup.ToOffset(content, position))
        )
        let symbol = Assert.IsType[ImportedFunctionSymbol](model.GetSymbolInfo(token).Symbol)
        let accessor = Assert.IsType[AccessorExpressionSyntax](token.Parent?.Parent)
        let call = Assert.IsType[BoundImportedInstanceCallExpression](model.GetBoundNode(accessor))
        let boundType = if member == "Add" {
            call.Arguments[^1].Type
        } else {
            call.Type
        }
        let label = HoverComputer.FormatSymbol(symbol)
        let hover = Assert.IsType[Hover](HoverComputer.ComputeHover(content, position)).Contents.ToString()
        let help = Assert.IsType[SignatureHelp](
            SignatureHelpComputer.ComputeSignatureHelp(
                content,
                Position(position.Line, position.Character + member.Length + 1)
            )
        )
        let signature = help.Signatures.ElementAt(help.ActiveSignature)
        let completion = Assert.Single(
            CompletionComputer.ComputeCompletions(content, position).Where(
                (item CompletionItem) -> item.Label == member
            )
        )
        output.WriteLine("receiver: ${SymbolDisplay.ToTypeDisplayString(call.Receiver.Type)}")
        output.WriteLine("bound type: ${SymbolDisplay.ToTypeDisplayString(boundType)}")
        output.WriteLine("symbol: $label")
        output.WriteLine("hover: $hover")
        output.WriteLine("signature: ${signature.Label}")
        output.WriteLine("completion: ${completion.Detail}")
        Assert.Equal(expectedBoundType, SymbolDisplay.ToTypeDisplayString(boundType))
        if element == "Item" {
            let item = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Item")
            Assert.Same(
                item,
                if member == "Add" {
                    boundType
                } else {
                    Assert.IsType[ImportedTypeSymbol](boundType).TypeArguments.Single()
                }
            )
        }
        Assert.Equal(expected, label)
        let expectedHover = if member == "Add" {
            "Add(key string, value " + element + ")"
        } else {
            "GetEnumerator() System.Collections.Generic.IEnumerator[" + element + "]"
        }
        Assert.Contains(expectedHover, hover, StringComparison.Ordinal)
        Assert.Equal(expected, signature.Label)
        Assert.Equal(expected, completion.Detail)
        if member == "Add" {
            Assert.Equal("value " + element, signature.Parameters.Last().Label)
        }
    }

    @Theory
    @InlineData("")
    @InlineData("[string]")
    func GenericMethod_KeepsReceiverAndMethodTypeArgumentsDistinct(typeArguments string) {
        let source = `import System
import System.Collections.Generic
class Item { }
func Use(items List[Item], converter Converter[Item, string]) {
    let result = items.ConvertAllTYPE_ARGUMENTS(converter)
}`.Replace("TYPE_ARGUMENTS", typeArguments)
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = ServerCompilation.Create(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let position = LanguageServerTestHelpers.PositionOf(source, "ConvertAll")
        let token = Assert.IsAssignableFrom[SyntaxToken](
            SemanticLookup.FindTokenAt(content.SyntaxTree, SemanticLookup.ToOffset(content, position))
        )
        let symbol = Assert.IsType[ImportedFunctionSymbol](
            compilation.GetSemanticModel(content.SyntaxTree).GetSymbolInfo(token).Symbol
        )
        let label = HoverComputer.FormatSymbol(symbol)
        let completion = Assert.Single(
            CompletionComputer.ComputeCompletions(content, position).Where(
                (item CompletionItem) -> item.Label == "ConvertAll"
            )
        )
        output.WriteLine("closed generic symbol: $label")
        output.WriteLine("open generic completion: ${completion.Detail}")
        Assert.Equal("func ConvertAll(converter Converter[Item, string]) List[string]", label)
        Assert.Equal("func ConvertAll(converter Converter[Item, TOutput]) List[TOutput]", completion.Detail)
    }

    @Fact
    func UnconstructedSymbol_KeepsItsMetadataSignature() {
        let method = typeof(Dictionary[string, object]).GetGenericTypeDefinition().GetMethod("Add")!!
        let symbol = ImportedFunctionSymbol(
            method.Name,
            ImportedClassSymbol(method.DeclaringType!!, declaration: nil),
            method,
            declaration: nil
        )
        Assert.Equal("func Add(key TKey, value TValue)", HoverComputer.FormatSymbol(symbol))
    }

    @Theory
    @InlineData("ToString", "func ToString() string?")
    @InlineData("IsNullOrEmpty", "func IsNullOrEmpty(value string) bool")
    func OrdinaryClrSignatures_PreserveReturnAnnotationsAndMetadataParameterForms(member string, expected string) {
        const source = `func Use(value object) {
    let text = value.ToString()
    let empty = string.IsNullOrEmpty(text)
}`
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = ServerCompilation.Create(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let position = LanguageServerTestHelpers.PositionOf(source, member)
        let token = Assert.IsAssignableFrom[SyntaxToken](
            SemanticLookup.FindTokenAt(content.SyntaxTree, SemanticLookup.ToOffset(content, position))
        )
        let symbol = Assert.IsType[ImportedFunctionSymbol](
            compilation.GetSemanticModel(content.SyntaxTree).GetSymbolInfo(token).Symbol
        )
        let signature = Assert.IsType[SignatureHelp](
            SignatureHelpComputer.ComputeSignatureHelp(
                content,
                Position(position.Line, position.Character + member.Length + 1)
            )
        )
        Assert.Equal(expected, HoverComputer.FormatSymbol(symbol))
        Assert.Equal(expected, signature.Signatures.ElementAt(signature.ActiveSignature).Label)
        Assert.Contains(
            expected.Substring("func ".Length),
            Assert.IsType[Hover](HoverComputer.ComputeHover(content, position)).Contents.ToString(),
            StringComparison.Ordinal
        )
        Assert.Equal(
            expected,
            Assert.Single(
                CompletionComputer.ComputeCompletions(content, position).Where(
                    (item CompletionItem) -> item.Label == member
                )
            )
                .Detail
        )
    }

    @Fact
    func SymbolicStaticContainer_PreservesParameterAndReturnArguments() {
        const source = `import System
import System.Collections.Generic
class Item { }
func Use(comparison Comparison[Item]) {
    let comparer = Comparer[Item].Create(comparison)
}`
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = ServerCompilation.Create(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let position = LanguageServerTestHelpers.PositionOf(source, "Create")
        let token = Assert.IsAssignableFrom[SyntaxToken](
            SemanticLookup.FindTokenAt(content.SyntaxTree, SemanticLookup.ToOffset(content, position))
        )
        let symbol = Assert.IsType[ImportedFunctionSymbol](
            compilation.GetSemanticModel(content.SyntaxTree).GetSymbolInfo(token).Symbol
        )
        let help = Assert.IsType[SignatureHelp](
            SignatureHelpComputer.ComputeSignatureHelp(
                content,
                Position(position.Line, position.Character + "Create(".Length)
            )
        )
        const expected = "func Create(comparison Comparison[Item]) Comparer[Item]"
        let label = HoverComputer.FormatSymbol(symbol)
        let hover = Assert.IsType[Hover](HoverComputer.ComputeHover(content, position)).Contents.ToString()
        output.WriteLine("bound return: ${SymbolDisplay.ToTypeDisplayString(symbol.Type)}")
        output.WriteLine("symbol: $label")
        output.WriteLine("hover: $hover")
        output.WriteLine("signature: ${help.Signatures.ElementAt(help.ActiveSignature).Label}")
        let staticCompletions = CompletionComputer
            .ComputeCompletions(content, position)
            .Where((item CompletionItem) -> item.Label == "Create")
            .ToArray()
        output.WriteLine("static completion count: ${staticCompletions.Length}")
        Assert.Equal("System.Collections.Generic.Comparer[Item]", SymbolDisplay.ToTypeDisplayString(symbol.Type))
        Assert.Equal(expected, label)
        Assert.Equal(expected, help.Signatures.ElementAt(help.ActiveSignature).Label)
        Assert.Contains(
            "func (System.Collections.Generic.Comparer[Item]) Create(comparison System.Comparison[Item]) System.Collections.Generic.Comparer[Item]",
            hover,
            StringComparison.Ordinal
        )
    }

    @Fact
    func StaticMethodArguments_ReachSelectedHoverAndSignatureButLeaveCompletionOpen() {
        const source = `import System.Linq
class Item { }
func Use(item Item) {
    let repeated = Enumerable.Repeat[Item](item, 2)
}`
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = ServerCompilation.Create(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let position = LanguageServerTestHelpers.PositionOf(source, "Repeat")
        let token = Assert.IsAssignableFrom[SyntaxToken](
            SemanticLookup.FindTokenAt(content.SyntaxTree, SemanticLookup.ToOffset(content, position))
        )
        let symbol = Assert.IsType[ImportedFunctionSymbol](
            compilation.GetSemanticModel(content.SyntaxTree).GetSymbolInfo(token).Symbol
        )
        let help = Assert.IsType[SignatureHelp](
            SignatureHelpComputer.ComputeSignatureHelp(
                content,
                Position(position.Line, position.Character + "Repeat[Item](".Length)
            )
        )
        let completion = Assert.Single(
            CompletionComputer.ComputeCompletions(content, position).Where(
                (item CompletionItem) -> item.Label == "Repeat"
            )
        )
        let label = HoverComputer.FormatSymbol(symbol)
        let hover = Assert.IsType[Hover](HoverComputer.ComputeHover(content, position)).Contents.ToString()
        output.WriteLine("bound return: ${SymbolDisplay.ToTypeDisplayString(symbol.Type)}")
        output.WriteLine("symbol: $label")
        output.WriteLine("hover: $hover")
        output.WriteLine("signature: ${help.Signatures.ElementAt(help.ActiveSignature).Label}")
        output.WriteLine("completion: ${completion.Detail}")
        const expected = "func Repeat(element Item, count int32) IEnumerable[Item]"
        Assert.Equal(expected, label)
        Assert.Equal(expected, help.Signatures.ElementAt(help.ActiveSignature).Label)
        Assert.Equal("element Item", help.Signatures.ElementAt(help.ActiveSignature).Parameters.First().Label)
        Assert.Equal("func Repeat(element TResult, count int32) IEnumerable[TResult]", completion.Detail)
        Assert.Contains(
            "Repeat(element Item, count int32) System.Collections.Generic.IEnumerable[Item]",
            hover,
            StringComparison.Ordinal
        )
    }
}
