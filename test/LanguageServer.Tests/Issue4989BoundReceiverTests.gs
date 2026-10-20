// <copyright file="Issue4989BoundReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import System.Text
import System.Threading.Tasks
import Xunit

/// Issue #4989: the language server reports the member and receiver type the
/// binder bound, not one it recomputes from syntax. A variable declared at an
/// interface and assigned a different implementation on each branch reads,
/// after `guard let s = store`, at the interface, so hover, navigation and
/// symbol lookup on `s.LoadAsync()` resolve to the interface member, never to
/// a same-named member of one implementation.
open class Issue4989BoundReceiverTests {
    @Fact
    func Issue5035_LoweredCallArgument_PreservesStaticOverload() {
        const source = `package Repro
class Holder {
    prop Value int32 { get; set; }
    shared {
        func Values(value string) []string -> []string{"wrong"}
        func Values(value int32) []string -> []string{"right"}
    }
    func Run() {
        let unrelated = Holder.Values("wrong")
        let result = Holder.Values(this.Value)[^1]
    }
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let root = Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "result =", 0).Parent).Initializer
        let block = Assert.IsType[BoundBlockExpression](
            compilation.GetSemanticModel(content.SyntaxTree).GetBoundNode(root!!)
        )
        let call = Assert.IsType[BoundCallExpression](
            Assert.IsType[BoundVariableDeclaration](block.Statements[0]).Initializer
        )
        Assert.Same(TypeSymbol.Int32, call.Function.Parameters[0].Type)
        Assert.IsType[BoundFieldAccessExpression](Assert.Single(call.Arguments))
        let token = TokenAt(content, source, "Values(this.Value)", 0)
        Assert.Same(call.Function, BoundSemantics.GetSymbol(compilation, token))
        Assert.Same(call.Function, SemanticLookup.ResolveSymbol(compilation, token))
        let position = LanguageServerTestHelpers.PositionOf(source, "Values(this.Value)")
        AssertIndexedHover(content, position, "Values", "static func Values(value int32) []string")
        let uri = DocumentUri.From("file:///issue5035-lowered-argument.gs")!!
        let location = Assert.IsType[Location](DefinitionComputer.ComputeDefinition(uri, content, position))
        let declaration = LanguageServerTestHelpers.PositionOf(source, "Values(value int32)")
        Assert.Equal(uri, location.Uri)
        AssertPosition(declaration, location.Range.Start)
        AssertPosition(Position(declaration.Line, declaration.Character + "Values".Length), location.Range.End)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Issue5035_ImportedBaseAndTuple_PreserveExactMethod(tuple bool) {
        let source = if tuple {
            `package Repro
func Run(pair (System.Uri, int32)) {
    let unrelated = System.Text.StringBuilder().ToString()
    let result = pair.0.ToString()[^1]
}
`
        } else {
            `package Repro
class Derived : System.Exception { }
func Run() {
    let unrelated = System.Text.StringBuilder().ToString()
    let result = Derived.ReferenceEquals(nil, nil).ToString()[^1]
}
`
        }
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let root = Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "result =", 0).Parent).Initializer
        let block = Assert.IsType[BoundBlockExpression](
            compilation.GetSemanticModel(content.SyntaxTree).GetBoundNode(root!!)
        )
        let capture = Assert.IsType[BoundVariableDeclaration](block.Statements[0])
        let selected = Assert.IsType[BoundImportedInstanceCallExpression](capture.Initializer)
        if tuple {
            let element = Assert.IsType[BoundTupleElementAccessExpression](selected.Receiver)
            Assert.Equal(0, element.Index)
            Assert.Same(
                SemanticLookup.ResolveSymbol(compilation, TokenAt(content, source, "pair.0", 0)),
                Assert.IsType[BoundVariableExpression](element.Receiver).Variable
            )
        } else {
            let inherited = Assert.IsType[BoundImportedCallExpression](selected.Receiver)
            Assert.Equal(
                typeof(object).GetMethod("ReferenceEquals", []Type{typeof(object), typeof(object)}),
                inherited.Function.Method
            )
        }
        let method = (
            if tuple {
                typeof(Uri)
            } else {
                typeof(bool)
            }
        ).GetMethod("ToString", Type.EmptyTypes)
        let token = TokenAt(content, source, "ToString()[^1]", 0)
        Assert.Equal(method, BoundSemantics.GetImportedMember(compilation, token))
        Assert.True(
            ImportedClrMemberResolver.TryResolveClrMember(content.SyntaxTree, compilation, token, out var actual)
        )
        Assert.Equal(method, actual)
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]"),
            "ToString",
            if tuple {
                "func (System.Uri) ToString() string"
            } else {
                "func (bool) ToString() string"
            }
        )
    }

    @Fact
    func Hover_GuardLetReceiver_ShowsTheInterfaceMember() {
        let content = LanguageServerTestHelpers.Content(IssueSource)
        let hover = HoverText(content, IssueSource, "LoadAsync", 3)
        Assert.Contains(
            "func (IStore) LoadAsync() System.Threading.Tasks.Task[string?]",
            hover,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("MacStore", hover, StringComparison.Ordinal)
        Assert.DoesNotContain("LinuxStore", hover, StringComparison.Ordinal)
    }

    @Fact
    func ResolveSymbol_GuardLetBindingAndInterfaceCall_ResolveToTheBoundSymbols() {
        let content = LanguageServerTestHelpers.Content(IssueSource)
        let compilation = Compilation(content.SyntaxTree)
        let declaration = TokenAt(content, IssueSource, "s = store", 0)
        let use = TokenAt(content, IssueSource, "s.LoadAsync", 0)
        let declared = Assert.IsAssignableFrom[VariableSymbol](SemanticLookup.ResolveSymbol(compilation, declaration))
        Assert.Same(declared, SemanticLookup.ResolveSymbol(compilation, use))
        let member = Assert.IsAssignableFrom[FunctionSymbol](
            SemanticLookup.ResolveSymbol(compilation, TokenAt(content, IssueSource, "LoadAsync", 3))
        )
        Assert.Equal("IStore", member.ReceiverType?.Name)
    }

    @Fact
    func Definition_GuardLetReceiverCall_NavigatesToTheInterfaceMember() {
        let content = LanguageServerTestHelpers.Content(IssueSource)
        let uri = Assert.IsType[DocumentUri](DocumentUri.From("file:///issue4989.gs"))
        let location = Assert.IsType[Location](
            DefinitionComputer.ComputeDefinition(
                uri,
                content,
                LanguageServerTestHelpers.PositionOf(IssueSource, "LoadAsync", 3)
            )
        )
        // The interface's `func LoadAsync()` declaration, not an implementation's.
        Assert.Equal(LanguageServerTestHelpers.PositionOf(IssueSource, "LoadAsync", 0).Line, location.Range.Start.Line)
    }

    @Fact
    func Hover_ImportedInterfaceReceiver_ShowsTheInterfaceMember() {
        // `warm.GetEnumerator()` is bound earlier in the program on List; the
        // hovered call is bound on the IEnumerable the variable is declared as.
        let content = LanguageServerTestHelpers.Content(BclSource)
        let hover = HoverText(content, BclSource, "GetEnumerator", 1)
        Assert.Contains(
            "func (System.Collections.Generic.IEnumerable[int32]) GetEnumerator()",
            hover,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("List[int32]", hover, StringComparison.Ordinal)
    }

    @Fact
    func Hover_ReferencedInterfaceReceiver_ShowsTheInterfaceMember() {
        // The shape of the original report: the interface and both
        // implementations come from a referenced assembly, and one
        // implementation's LoadAsync is called elsewhere in the program.
        let root = Path.Combine(Directory.GetCurrentDirectory(), "issue4989-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        try {
            let assemblyPath = Path.Combine(root, "TokenFixture.dll")
            EmitClrFixture(assemblyPath, TokenFixtureSource)
            let gsPath = Path.Combine(root, "Consumer.gs")
            File.WriteAllText(gsPath, ConsumerSource)
            let project = ProjectState(Path.Combine(root, "Consumer.gsproj"))
            project.References = []string{assemblyPath}
            let tree = project.UpdateFile(gsPath, ConsumerSource)
            let lines = Enumerable
                .Range(0, ConsumerSource.Length)
                .Where((i int32) -> ConsumerSource[i] == '\n')
                .ToList()
            let content = DocumentContent(tree, lines, project, WorkspaceState())
            let hover = HoverText(content, ConsumerSource, "LoadAsync", 1)
            Assert.Contains("(TokenFixture.ITokenStore) LoadAsync()", hover, StringComparison.Ordinal)
            Assert.DoesNotContain("KeychainTokenStore", hover, StringComparison.Ordinal)
        } finally {
            try {
                Directory.Delete(root, recursive: true)
            } catch { }
        }
    }

    @Fact
    func ExpressionType_NarrowedNullableValueReceivers_AreTheUnderlyingTypes() {
        // A narrowed `S?` read is the binder's `!!` around a read still typed
        // `S?`; the receiver's flow type is the `!!`'s `S`.
        let content = LanguageServerTestHelpers.Content(ValueReceiverSource)
        let compilation = Compilation(content.SyntaxTree)
        let point = ReceiverType(compilation, content, ValueReceiverSource, "p.X")
        Assert.True(point is StructSymbol, "p reads at ${point}")
        Assert.Equal("Point", point?.Name)
        let number = ReceiverType(compilation, content, ValueReceiverSource, "n.GetHashCode")
        Assert.False(number is NullableTypeSymbol, "n reads at ${number}")
        Assert.Equal("int32", number?.Name)
    }

    @Fact
    func Completion_ChainedReceiverOnANarrowedBinding_UsesTheBoundChain() {
        let content = LanguageServerTestHelpers.Content(ChainSource)
        let items = CompletionComputer.ComputeCompletions(
            content,
            LanguageServerTestHelpers.PositionOf(ChainSource, "Count()", 1)
        )
        Assert.Contains(items, (item CompletionItem) -> item.Label == "Count")
    }

    @Theory
    @InlineData("System.DayOfWeek(2)")
    @InlineData("DayOfWeek(2)")
    @InlineData("cast[DayOfWeek](2)")
    func Completion_ExplicitConversionReceiver_KeepsTheConvertedType(receiver string) {
        let source = "package Repro\nimport System\nfunc Run() string { return " + receiver + ".ToString() }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        let accessor = Assert.IsType[AccessorExpressionSyntax](TokenAt(content, source, "ToString", 0).Parent?.Parent)
        Assert.Equal(typeof(DayOfWeek), BoundSemantics.GetExpressionType(compilation, accessor.LeftPart)?.ClrType)
        let items = CompletionComputer.ComputeCompletions(
            content,
            LanguageServerTestHelpers.PositionOf(source, "ToString")
        )
        Assert.Contains(items, (item CompletionItem) -> item.Label == "HasFlag")
    }

    @Theory
    @InlineData("Make()", "Length")
    @InlineData("(Make())", "Length")
    @InlineData("System.DayOfWeek(2)", "HasFlag")
    @InlineData("(System.DayOfWeek(2))", "HasFlag")
    func Completion_ExtensionReceiver_UsesItsTypeBeforeArgumentConversion(receiver string, member string) {
        let source = "package Repro\nimport System\n" +
            "func Make() string -> \"text\"\nfunc (value object) Tag() int32 -> 0\n" +
            "func Run() int32 { return ${receiver}.Tag() }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        let accessor = Assert.IsType[AccessorExpressionSyntax](TokenAt(content, source, "Tag()", 1).Parent?.Parent)
        let expectedType = if member == "Length" {
            typeof(string)
        } else {
            typeof(DayOfWeek)
        }
        Assert.Equal(expectedType, BoundSemantics.GetExpressionType(compilation, accessor.LeftPart)?.ClrType)
        let items = CompletionComputer.ComputeCompletions(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Tag()", 1)
        )
        Assert.Contains(items, (item CompletionItem) -> item.Label == member)
    }

    @Fact
    func Hover_ConstructedGenericMember_ShowsTheSubstitutedType() {
        let content = LanguageServerTestHelpers.Content(GenericSource)
        let hover = HoverText(content, GenericSource, "Value", 2)
        Assert.Contains("Value int32", hover, StringComparison.Ordinal)
    }

    @Fact
    func References_ConstructedGenericMember_IncludeTheDeclaration() {
        let content = LanguageServerTestHelpers.Content(GenericSource)
        let compilation = Compilation(content.SyntaxTree)
        let declaration = SemanticLookup.ResolveSymbol(compilation, TokenAt(content, GenericSource, "Value", 0))
        let use = TokenAt(content, GenericSource, "Value", 2)
        let references = SemanticLookup.FindReferences(compilation, declaration).ToList()
        Assert.Contains(references, (token SyntaxToken) -> token.Span.Start == use.Span.Start)
        let fromUse = SemanticLookup.ResolveSymbol(compilation, use)
        Assert.Contains(
            SemanticLookup.FindReferences(compilation, fromUse),
            (token SyntaxToken) -> token.Span.Start == TokenAt(content, GenericSource, "Value", 0).Span.Start
        )
    }

    @Fact
    func Hover_OverloadedMethodCall_ShowsTheBoundOverload() {
        let content = LanguageServerTestHelpers.Content(OverloadSource)
        let hover = HoverText(content, OverloadSource, "M()", 1)
        Assert.Contains("M() int32", hover, StringComparison.Ordinal)
        Assert.DoesNotContain("M(x int32)", hover, StringComparison.Ordinal)
        let uri = Assert.IsType[DocumentUri](DocumentUri.From("file:///issue4989-overload.gs"))
        let location = Assert.IsType[Location](
            DefinitionComputer.ComputeDefinition(
                uri,
                content,
                LanguageServerTestHelpers.PositionOf(OverloadSource, "M()", 1)
            )
        )
        Assert.Equal(LanguageServerTestHelpers.PositionOf(OverloadSource, "M()", 0).Line, location.Range.Start.Line)
    }

    @Fact
    func Hover_ConstructedGenericInterfaceProperty_ShowsTheSubstitutedType() {
        let content = LanguageServerTestHelpers.Content(GenericInterfaceSource)
        let hover = HoverText(content, GenericInterfaceSource, "Value", 2)
        Assert.Contains("Value int32", hover, StringComparison.Ordinal)
        Assert.Contains("The boxed value.", hover, StringComparison.Ordinal)
        let compilation = Compilation(content.SyntaxTree)
        let declaration = SemanticLookup.ResolveSymbol(
            compilation,
            TokenAt(content, GenericInterfaceSource, "Value", 0)
        )
        let use = TokenAt(content, GenericInterfaceSource, "Value", 2)
        Assert.Contains(
            SemanticLookup.FindReferences(compilation, declaration),
            (token SyntaxToken) -> token.Span.Start == use.Span.Start
        )
    }

    @Fact
    func ResolveSymbol_FieldLikeEventRead_IsTheEvent() {
        let content = LanguageServerTestHelpers.Content(EventSource)
        let compilation = Compilation(content.SyntaxTree)
        Assert.IsAssignableFrom[EventSymbol](
            SemanticLookup.ResolveSymbol(compilation, TokenAt(content, EventSource, "Click", 1))
        )
        Assert.DoesNotContain("(field)", HoverText(content, EventSource, "Click", 1), StringComparison.Ordinal)
    }

    @Theory
    @InlineData("Make", 1)
    @InlineData("maybe", 1)
    async func TypeDefinition_NullableBoundType_NavigatesToTheDeclaredType(text string, occurrence int32) {
        let root = Path.Combine(Directory.GetCurrentDirectory(), "issue4989-typedef-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        try {
            let gsPath = Path.Combine(root, "TypeDefinition.gs")
            File.WriteAllText(gsPath, TypeDefinitionSource)
            let server = GSharp.LanguageServer.Server.LspServer(DocumentContentService(), WorkspaceState())
            let uri = Assert.IsType[DocumentUri](DocumentUri.FromFileSystemPath(gsPath))
            await server.DidOpenAsync(
                DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: TypeDefinitionSource}}
            )
            let locations = await server.TypeDefinitionAsync(
                TypeDefinitionParams{
                    TextDocument: TextDocumentIdentifier{Uri: uri},
                    Position: LanguageServerTestHelpers.PositionOf(TypeDefinitionSource, text, occurrence)
                }
            )
            let location = Assert.Single(locations)
            // `class Result` is on line 2.
            Assert.Equal(2, location.Range.Start.Line)
        } finally {
            try {
                Directory.Delete(root, recursive: true)
            } catch { }
        }
    }

    @Fact
    func Hover_NullConditionalInterfaceCall_ShowsTheInterfaceMember() {
        let content = LanguageServerTestHelpers.Content(NullConditionalSource)
        let hover = HoverText(content, NullConditionalSource, "LoadAsync", 1)
        Assert.Contains("func (IStore) LoadAsync()", hover, StringComparison.Ordinal)
        let compilation = Compilation(content.SyntaxTree)
        let receiver = Assert.IsAssignableFrom[ParameterSymbol](
            SemanticLookup.ResolveSymbol(compilation, TokenAt(content, NullConditionalSource, "store?.", 0))
        )
        Assert.Equal("store", receiver.Name)
    }

    @Theory
    @InlineData("runner.Calls[Calls]", "Calls", "prop Calls System.Collections.Generic.List[RunnerCall] { get; }")
    @InlineData("runner.Calls[0].Args[Args]", "Args", "prop Args []string { get; }")
    @InlineData("runner.Calls[0].FileName[Calls]", "FileName", "prop FileName string { get; }")
    @InlineData("runner.Calls[0].Fields[Args]", "Fields", "(field) Fields []string")
    @InlineData(
        "runner.Calls[^1].Args[Args]",
        "Calls",
        "prop Calls System.Collections.Generic.List[RunnerCall] { get; }"
    )
    @InlineData("runner.Calls[0].Args[..]", "Args", "prop Args []string { get; }")
    @InlineData(
        "runner.Calls[0].Args[Args].Length",
        "Calls",
        "prop Calls System.Collections.Generic.List[RunnerCall] { get; }"
    )
    func Issue5035_IndexedSourceMembers_KeepSymbolsRangesAndDefinitions(
        expression string,
        member string,
        signature string
    ) {
        let source = IndexedSource.Replace("EXPRESSION_PLACEHOLDER", expression)
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let position = LanguageServerTestHelpers.PositionOf(source, expression)
        position.Character += expression.IndexOf("." + member, StringComparison.Ordinal) + 1
        AssertIndexedHover(content, position, member, signature)
        let uri = DocumentUri.From("file:///issue5035.gs")!!
        let location = Assert.IsType[Location](DefinitionComputer.ComputeDefinition(uri, content, position))
        let declaration = LanguageServerTestHelpers.PositionOf(
            source,
            if member == "Fields" {
                "var " + member
            } else {
                "prop " + member
            }
        )
        declaration.Character += if member == "Fields" {
            4
        } else {
            5
        }
        Assert.Equal(uri, location.Uri)
        AssertPosition(declaration, location.Range.Start)
        AssertPosition(Position(declaration.Line, declaration.Character + member.Length), location.Range.End)
        let token = SemanticLookup.FindTokenAt(content.SyntaxTree, SemanticLookup.ToOffset(content, position))!!
        Assert.Equal(member, BoundSemantics.GetSymbol(compilation, token)?.Name)

        // Index arguments are local reads, even when their names also name members.
        for name in[]string{"Calls", "Args"} {
            let argument = LanguageServerTestHelpers.PositionOf(source, "[" + name + "]")
            argument.Character++
            let local = SemanticLookup.FindTokenAt(content.SyntaxTree, SemanticLookup.ToOffset(content, argument))!!
            let resolved = Assert.IsAssignableFrom[VariableSymbol](SemanticLookup.ResolveSymbol(compilation, local))
            Assert.Equal(TypeSymbol.Int32, resolved.Type)
            let localDeclaration = LanguageServerTestHelpers.PositionOf(source, "let " + name + " = 0")
            localDeclaration.Character += 4
            let declaredToken = SemanticLookup.FindTokenAt(
                content.SyntaxTree,
                SemanticLookup.ToOffset(content, localDeclaration)
            )!!
            Assert.Same(BoundSemantics.GetSymbol(compilation, declaredToken), resolved)
            AssertIndexedHover(content, argument, name, "(local variable) " + name + " int32")
        }
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "FileName.Length"),
            "FileName",
            "prop FileName string { get; }"
        )
        let plain = LanguageServerTestHelpers.PositionOf(source, "runner.Calls")
        plain.Character += "runner.".Length
        AssertIndexedHover(content, plain, "Calls", "prop Calls System.Collections.Generic.List[RunnerCall] { get; }")
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Length"),
            "Length",
            "string.Length int32 { get; }"
        )
    }

    @Theory
    @InlineData("uri.Segments[0]", "Segments", "System.Uri.Segments []string { get; }", typeof(Uri))
    @InlineData("uri.Host[0]", "Host", "System.Uri.Host string { get; }", typeof(Uri))
    @InlineData("uri.ToString()[0]", "ToString", "func (System.Uri) ToString() string", typeof(Uri))
    @InlineData("uri.ToString()[^1]", "ToString", "func (System.Uri) ToString() string", typeof(Uri))
    @InlineData("uri.ToString()[..]", "ToString", "func (System.Uri) ToString() string", typeof(Uri))
    @InlineData("uri.ToString()[1..^1]", "ToString", "func (System.Uri) ToString() string", typeof(Uri))
    @InlineData("string.Empty[0]", "Empty", "string.Empty string", typeof(string))
    func Issue5035_IndexedImportedMembers_UseBoundIdentity(
        expression string,
        member string,
        signature string,
        declaringType Type
    ) {
        let source = `package Repro
import System
import System.Text
func Run(uri Uri) {
    let unrelated = StringBuilder().ToString()
    let result = EXPRESSION_PLACEHOLDER
}
`.Replace("EXPRESSION_PLACEHOLDER", expression)
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let position = LanguageServerTestHelpers.PositionOf(source, expression)
        position.Character += expression.IndexOf("." + member, StringComparison.Ordinal) + 1
        AssertIndexedHover(content, position, member, signature)
        let token = SemanticLookup.FindTokenAt(content.SyntaxTree, SemanticLookup.ToOffset(content, position))!!
        let imported = Assert.IsAssignableFrom[System.Reflection.MemberInfo](
            BoundSemantics.GetImportedMember(compilation, token)
        )
        Assert.Equal(declaringType, imported.DeclaringType)
        Assert.True(
            ImportedClrMemberResolver.TryResolveClrMember(content.SyntaxTree, compilation, token, out var navigation)
        )
        Assert.Equal(imported, navigation)
    }

    @Fact
    func Issue5035_IndexedCallOnNarrowedInterface_UsesTheInterfaceMember() {
        const source = `package Repro
interface IStore { func Read() string; }
class Store : IStore { func Read() string -> "store" }
func Run(store IStore?) string {
    let warm = Store().Read()
    guard let s = store else { return "" }
    return s.Read()[0].ToString()
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let position = LanguageServerTestHelpers.PositionOf(source, "Read()[0]")
        AssertIndexedHover(content, position, "Read", "func (IStore) Read() string")
        let location = Assert.IsType[Location](
            DefinitionComputer.ComputeDefinition(DocumentUri.From("file:///issue5035.gs")!!, content, position)
        )
        AssertPosition(LanguageServerTestHelpers.PositionOf(source, "Read"), location.Range.Start)
    }

    @Theory
    @InlineData("=")
    @InlineData("+=")
    func Issue5035_IndexedAssignmentTarget_PreservesTheBoundOverload(operatorText string) {
        let source = `package Repro
class Holder {
    func GetItems(value string) []int32 -> []int32{1}
    func GetItems(value int32) []int32 -> []int32{2}
}
func Run(obj Holder) {
    obj.GetItems(1)[0] OPERATOR 42
}
`.Replace("OPERATOR", operatorText)
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let position = LanguageServerTestHelpers.PositionOf(source, "GetItems(1)")
        AssertIndexedHover(content, position, "GetItems", "func (Holder) GetItems(value int32) []int32")
        let token = SemanticLookup.FindTokenAt(content.SyntaxTree, SemanticLookup.ToOffset(content, position))!!
        let selected = Assert.IsAssignableFrom[FunctionSymbol](BoundSemantics.GetSymbol(compilation, token))
        Assert.Equal(TypeSymbol.Int32, selected.Parameters[0].Type)
        let location = Assert.IsType[Location](
            DefinitionComputer.ComputeDefinition(DocumentUri.From("file:///issue5035.gs")!!, content, position)
        )
        AssertPosition(LanguageServerTestHelpers.PositionOf(source, "GetItems(value int32)"), location.Range.Start)
    }

    @Fact
    func Issue5035_CompositeBaseReceiver_KeepsItsBoundTypeAndCompletion() {
        const source = `package Repro
open class Base {
    prop Text string -> "base"
}
class Derived : Base {
    func Run() int32 -> base.Text.Length
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let token = TokenAt(content, source, "Length", 0)
        let outer = Assert.IsType[AccessorExpressionSyntax](token.Parent?.Parent)
        let receiver = Assert.IsType[AccessorExpressionSyntax](outer.LeftPart)
        Assert.Equal(typeof(string), BoundSemantics.GetExpressionType(compilation, receiver)?.ClrType)
        let position = LanguageServerTestHelpers.PositionOf(source, "Length")
        AssertIndexedHover(content, position, "Length", "string.Length int32 { get; }")
        let completions = CompletionComputer.ComputeCompletions(content, position)
        Assert.Contains(
            completions,
            (item CompletionItem) -> item.Label == "Substring" && item.Kind == CompletionItemKind.Method
        )
    }

    @Theory
    @InlineData("^1")
    @InlineData("..")
    func Issue5035_CapturedIndexTarget_PreservesTheUnqualifiedOverload(index string) {
        let source = `package Repro
func Values(value string) []int32 -> []int32{1}
func Values(value int32) []int32 -> []int32{2}
func Run() {
    let authored = {
        let unrelated = 123
        "text"
    }
    let result = Values(1)[INDEX]
}
`.Replace("INDEX", index)
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let authored = Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "authored =", 0).Parent)
        Assert.Equal(typeof(string), BoundSemantics.GetExpressionType(compilation, authored.Initializer)?.ClrType)
        let position = LanguageServerTestHelpers.PositionOf(source, "Values(1)")
        AssertIndexedHover(content, position, "Values", "func Values(value int32) []int32")
        let token = SemanticLookup.FindTokenAt(content.SyntaxTree, SemanticLookup.ToOffset(content, position))!!
        let selected = Assert.IsAssignableFrom[FunctionSymbol](BoundSemantics.GetSymbol(compilation, token))
        Assert.Equal(TypeSymbol.Int32, selected.Parameters[0].Type)
        let location = Assert.IsType[Location](
            DefinitionComputer.ComputeDefinition(DocumentUri.From("file:///issue5035.gs")!!, content, position)
        )
        AssertPosition(LanguageServerTestHelpers.PositionOf(source, "Values(value int32)"), location.Range.Start)
    }

    @Theory
    @InlineData("Memory[int32]", typeof(Memory[int32]), "System.Memory[int32].Span System.Span[int32] { get; }")
    @InlineData(
        "ReadOnlyMemory[int32]",
        typeof(ReadOnlyMemory[int32]),
        "System.ReadOnlyMemory[int32].Span System.ReadOnlySpan[int32] { get; }"
    )
    func Issue5035_RefReturningClrIndexer_PreservesTheBoundProperty(
        container string,
        declaringType Type,
        signature string
    ) {
        let source = `package Repro
import System
func Run(memory MEMORY_TYPE) string {
    let value = memory.Span[0]
    return memory.Span[0].ToString()
}
`.Replace("MEMORY_TYPE", container)
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let first = TokenAt(content, source, "Span[0]", 0)
        let indexSyntax = Assert.IsType[IndexExpressionSyntax](first.Parent?.Parent)
        let accessor = Assert.IsType[AccessorExpressionSyntax](indexSyntax.Parent)
        let dereference = Assert.IsType[BoundDereferenceExpression](
            compilation.GetSemanticModel(content.SyntaxTree).GetBoundNode(accessor)
        )
        let index = Assert.IsType[BoundClrIndexExpression](dereference.Operand)
        Assert.IsType[ByRefTypeSymbol](index.Type)
        Assert.Equal(TypeSymbol.Int32, dereference.Type)
        for var occurrence = 0; occurrence < 2; occurrence++ {
            let token = TokenAt(content, source, "Span[0]", occurrence)
            let property = Assert.IsAssignableFrom[System.Reflection.PropertyInfo](
                BoundSemantics.GetImportedMember(compilation, token)
            )
            Assert.Equal(declaringType.GetProperty("Span"), property)
            AssertIndexedHover(
                content,
                LanguageServerTestHelpers.PositionOf(source, "Span[0]", occurrence),
                "Span",
                signature
            )
            Assert.True(
                ImportedClrMemberResolver.TryResolveClrMember(
                    content.SyntaxTree,
                    compilation,
                    token,
                    out var navigation
                )
            )
            Assert.Equal(property, navigation)
        }
        let call = TokenAt(content, source, "ToString()", 0)
        let method = Assert.IsAssignableFrom[System.Reflection.MethodInfo](
            BoundSemantics.GetImportedMember(compilation, call)
        )
        Assert.Equal(typeof(int32), method.DeclaringType)
        Assert.Equal(typeof(int32), BoundSemantics.GetExpressionType(compilation, indexSyntax)?.ClrType)
    }

    @Fact
    func Issue5035_CompositeReceiver_PreservesOriginalConversionContext() {
        const source = `package Repro
func (value object) Tag() int32 -> 0
func Run(pair (string, int32)) int32 -> pair.0.Tag()
func Converted(pair (string, int32)) int32 -> cast[object](pair.0).Tag()
`
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let accessor = Assert.IsType[AccessorExpressionSyntax](TokenAt(content, source, "Tag()", 1).Parent?.Parent)
        let receiver = Assert.IsType[AccessorExpressionSyntax](accessor.LeftPart)
        Assert.Equal(typeof(string), BoundSemantics.GetExpressionType(compilation, receiver)?.ClrType)
        Assert.Contains(
            CompletionComputer.ComputeCompletions(content, LanguageServerTestHelpers.PositionOf(source, "Tag()", 1)),
            (item CompletionItem) -> item.Label == "Substring" && item.Kind == CompletionItemKind.Method
        )
        let converted = Assert.IsType[AccessorExpressionSyntax](TokenAt(content, source, "Tag()", 2).Parent?.Parent)
        Assert.Equal(typeof(object), BoundSemantics.GetExpressionType(compilation, converted.LeftPart)?.ClrType)
        Assert.DoesNotContain(
            CompletionComputer.ComputeCompletions(content, LanguageServerTestHelpers.PositionOf(source, "Tag()", 2)),
            (item CompletionItem) -> item.Label == "Substring"
        )
    }

    @Fact
    func Issue5035_DirectClrRangeAnchor_PreservesSourcePropertyAndDefinition() {
        let root = Path.Combine(
            Directory.GetCurrentDirectory(),
            "out",
            "issue5035-range-" + Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(root)
        try {
            let assemblyPath = Path.Combine(root, "RangeFixture.dll")
            EmitClrFixture(assemblyPath, `#nullable enable
namespace RangeFixture {
    public sealed class RangeBag {
        public string this[System.Range range] => "item";
    }
}
`)
            const source = `package Repro
import RangeFixture
class Holder {
    prop Items RangeBag -> RangeBag()
}
func Run(obj Holder) int32 {
    let sliced = obj.Items[1..]
    return obj.Items[1..].Length
}
`
            let path = Path.Combine(root, "Consumer.gs")
            File.WriteAllText(path, source)
            let project = ProjectState(Path.Combine(root, "Consumer.gsproj"))
            project.References = []string{assemblyPath}
            let tree = project.UpdateFile(path, source)
            let lines = Enumerable.Range(0, source.Length).Where((i int32) -> source[i] == '\n').ToList()
            let content = DocumentContent(tree, lines, project, WorkspaceState())
            let compilation = project.GetCompilation()
            Assert.Empty(compilation.GlobalScope.Diagnostics)
            Assert.Empty(compilation.BoundProgram.Diagnostics)
            let index = Assert.IsType[IndexExpressionSyntax](TokenAt(content, source, "Items[1..]", 0).Parent?.Parent)
            Assert.IsType[BoundClrIndexExpression](compilation.GetSemanticModel(tree).GetBoundNode(index.Index))
            let declaration = TokenAt(content, source, "Items RangeBag", 0)
            let declared = Assert.IsAssignableFrom[PropertySymbol](BoundSemantics.GetSymbol(compilation, declaration))
            let uri = DocumentUri.FromFileSystemPath(path)!!
            for var occurrence = 0; occurrence < 2; occurrence++ {
                let position = LanguageServerTestHelpers.PositionOf(source, "Items[1..]", occurrence)
                let token = TokenAt(content, source, "Items[1..]", occurrence)
                Assert.Same(declared, BoundSemantics.GetSymbol(compilation, token))
                AssertIndexedHover(content, position, "Items", "prop Items RangeFixture.RangeBag { get; }")
                let location = Assert.IsType[Location](DefinitionComputer.ComputeDefinition(uri, content, position))
                let expected = LanguageServerTestHelpers.PositionOf(source, "Items RangeBag")
                Assert.Equal(uri, location.Uri)
                AssertPosition(expected, location.Range.Start)
                AssertPosition(Position(expected.Line, expected.Character + "Items".Length), location.Range.End)
            }
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Theory
    @InlineData("slice[string]", false)
    @InlineData("slice[string]", true)
    @InlineData("readonly slice[string]", false)
    @InlineData("readonly slice[string]", true)
    func Issue5035_NativeSliceIndex_PreservesSourcePropertyAndDefinition(nativeType string, chained bool) {
        let source = `package Repro
class Holder {
    prop Items NATIVE_TYPE
}
func Run(h Holder, Items int32) string {
    return h.Items[Items]CHAIN
}
`.Replace("NATIVE_TYPE", nativeType).Replace(
            "CHAIN",
            if chained {
                ".ToString()"
            } else {
                ""
            }
        )
        let root = Path.Combine(
            Directory.GetCurrentDirectory(),
            "out",
            "issue5035-native-" + Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(root)
        try {
            let path = Path.Combine(root, "Consumer.gs")
            File.WriteAllText(path, source)
            let project = ProjectState(Path.Combine(root, "Consumer.gsproj"))
            let runtime = Path.Combine(AppContext.BaseDirectory, "Gsharp.Runtime.Values.dll")
            Assert.True(File.Exists(runtime), runtime)
            project.References = []string{runtime}
            let tree = project.UpdateFile(path, source)
            let lines = Enumerable.Range(0, source.Length).Where((i int32) -> source[i] == '\n').ToList()
            let content = DocumentContent(tree, lines, project, WorkspaceState())
            let compilation = project.GetCompilation()
            Assert.Empty(compilation.GlobalScope.Diagnostics)
            Assert.Empty(compilation.BoundProgram.Diagnostics)
            let position = LanguageServerTestHelpers.PositionOf(source, "Items[Items]")
            let token = TokenAt(content, source, "Items[Items]", 0)
            let index = Assert.IsType[IndexExpressionSyntax](token.Parent?.Parent)
            let dereference = Assert.IsType[BoundDereferenceExpression](
                compilation.GetSemanticModel(tree).GetBoundNode(index.Index)
            )
            let block = Assert.IsType[BoundBlockExpression](dereference.Operand)
            Assert.IsType[BoundClrIndexExpression](block.Expression)
            let declaration = TokenAt(content, source, "Items " + nativeType, 0)
            let declared = Assert.IsAssignableFrom[PropertySymbol](BoundSemantics.GetSymbol(compilation, declaration))
            Assert.Same(declared, BoundSemantics.GetSymbol(compilation, token))
            AssertIndexedHover(content, position, "Items", "prop Items " + nativeType + " { get; set; }")
            let uri = DocumentUri.FromFileSystemPath(path)!!
            let location = Assert.IsType[Location](DefinitionComputer.ComputeDefinition(uri, content, position))
            let expected = LanguageServerTestHelpers.PositionOf(source, "Items " + nativeType)
            Assert.Equal(uri, location.Uri)
            AssertPosition(expected, location.Range.Start)
            AssertPosition(Position(expected.Line, expected.Character + "Items".Length), location.Range.End)
            let argument = TokenAt(content, source, "Items]", 0)
            let parameter = Assert.IsAssignableFrom[ParameterSymbol](
                SemanticLookup.ResolveSymbol(compilation, argument)
            )
            Assert.Equal(TypeSymbol.Int32, parameter.Type)
            Assert.Same(BoundSemantics.GetSymbol(compilation, TokenAt(content, source, "Items int32", 0)), parameter)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func Issue5035_InterfaceStaticSlots_PreserveIndexedMethod(property bool, generic bool) {
        let source = `package Repro
interface IStateTYPE_PARAMETERS {
    shared {
        MEMBER
    }
}
func Run() {
    let unrelated = System.Text.StringBuilder().ToString()
    let plain = IStateTYPE_ARGUMENTS.Value
    let result = IStateTYPE_ARGUMENTS.Value.ToString()[^1]
}
`.Replace(
            "TYPE_PARAMETERS",
            if generic {
                "[T]"
            } else {
                ""
            }
        ).Replace(
            "TYPE_ARGUMENTS",
            if generic {
                "[int32?]"
            } else {
                ""
            }
        ).Replace(
            "MEMBER",
            if property {
                "prop Value string { get -> \"right\" }"
            } else {
                "var Value int32 = 1"
            }
        )
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let model = compilation.GetSemanticModel(content.SyntaxTree)
        let root = Assert.IsType[AccessorExpressionSyntax](
            Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "result =", 0).Parent).Initializer
        )
        let capture = Assert.IsType[BoundVariableDeclaration](
            Assert.IsType[BoundBlockExpression](model.GetBoundNode(root)).Statements[0]
        )
        let call = Assert.IsType[BoundImportedInstanceCallExpression](capture.Initializer)
        var owner InterfaceSymbol
        var expected Symbol
        if property {
            let getter = Assert.IsType[BoundCallExpression](call.Receiver)
            owner = Assert.IsType[InterfaceSymbol](getter.StaticGenericInterfaceOwnerType)
            let slot = (owner.Definition ?? owner).Properties.Single((p PropertySymbol) -> p.Name == "Value")
            Assert.True(slot.IsStatic)
            Assert.Same(slot.GetterSymbol, getter.Function)
            Assert.True(getter.MethodTypeArguments.IsDefaultOrEmpty)
            Assert.True(TypeMemberModel.TryGetPropertyWithOwner(owner, slot, out var canonical, out var declaredOwner))
            Assert.Same(slot, canonical)
            Assert.Same(owner, declaredOwner)
            let plainRoot = Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "plain =", 0).Parent)
                .Initializer
            Assert.Same(slot.GetterSymbol, Assert.IsType[BoundCallExpression](model.GetBoundNode(plainRoot!!)).Function)
            expected = slot
        } else {
            let field = Assert.IsType[BoundFieldAccessExpression](call.Receiver)
            owner = Assert.IsType[InterfaceSymbol](field.InterfaceType)
            expected = Assert.IsType[FieldSymbol]((owner.Definition ?? owner).GetStaticField("Value"))
            Assert.Same(expected, field.Field)
            Assert.True(field.Field.IsStatic)
            Assert.Null(field.Receiver)
        }
        if generic {
            Assert.Same(
                TypeSymbol.Int32,
                Assert.IsType[NullableTypeSymbol](Assert.Single(owner.TypeArguments)).UnderlyingType
            )
            Assert.NotSame(owner.Definition, owner)
        }
        let method = (
            if property {
                typeof(string)
            } else {
                typeof(int32)
            }
        ).GetMethod("ToString", Type.EmptyTypes)
        Assert.Equal(method, call.Method)
        let token = TokenAt(content, source, "ToString()[^1]", 0)
        Assert.Equal(method, BoundSemantics.GetImportedMember(compilation, token))
        Assert.True(
            ImportedClrMemberResolver.TryResolveClrMember(content.SyntaxTree, compilation, token, out var metadata)
        )
        Assert.Equal(method, metadata)
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]"),
            "ToString",
            if property {
                "func (string) ToString() string"
            } else {
                "func (int32) ToString() string"
            }
        )
        if !property {
            let member = TokenAt(content, source, "Value.ToString()[^1]", 0)
            Assert.Same(expected, SemanticLookup.ResolveSymbol(compilation, member))
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Issue5035_StaticInterfaceChain_PreservesSelectedMethods(generic bool) {
        let source = `package Repro
interface IFactoryTYPE_PARAMETERS {
    shared {
        func MakeMETHOD_PARAMETERS(value stringEXTRA_PARAMETER) string -> "wrong"
        func MakeMETHOD_PARAMETERS(value int32EXTRA_PARAMETER) string -> "right"
    }
}
func Run() {
    let unrelated = IFactoryTYPE_ARGUMENTS.MakeMETHOD_ARGUMENTS("warm"EXTRA_ARGUMENT)
    let result = IFactoryTYPE_ARGUMENTS.MakeMETHOD_ARGUMENTS(1EXTRA_ARGUMENT).ToString()[^1]
}
`.Replace(
            "TYPE_PARAMETERS",
            if generic {
                "[T]"
            } else {
                ""
            }
        ).Replace(
            "METHOD_PARAMETERS",
            if generic {
                "[U]"
            } else {
                ""
            }
        ).Replace(
            "EXTRA_PARAMETER",
            if generic {
                ", method U"
            } else {
                ""
            }
        ).Replace(
            "TYPE_ARGUMENTS",
            if generic {
                "[int32?]"
            } else {
                ""
            }
        ).Replace(
            "METHOD_ARGUMENTS",
            if generic {
                "[string]"
            } else {
                ""
            }
        ).Replace(
            "EXTRA_ARGUMENT",
            if generic {
                ", \"method\""
            } else {
                ""
            }
        )
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let needle = if generic {
            "Make[string](1"
        } else {
            "Make(1"
        }
        let token = TokenAt(content, source, needle, 0)
        let root = Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "result =", 0).Parent).Initializer
        let block = Assert.IsType[BoundBlockExpression](
            compilation.GetSemanticModel(content.SyntaxTree).GetBoundNode(root!!)
        )
        let sourceCapture = Assert.IsType[BoundVariableDeclaration](block.Statements[0])
        let outerCall = Assert.IsType[BoundImportedInstanceCallExpression](sourceCapture.Initializer)
        let selected = Assert.IsType[BoundCallExpression](outerCall.Receiver)
        let owner = Assert.IsType[InterfaceSymbol](selected.StaticGenericInterfaceOwnerType)
        let expected = TypeMemberModel.GetMethods(owner, "Make", MemberQuery.Static(MemberKinds.Method)).Single(
            (method FunctionSymbol) -> object.ReferenceEquals(method.Parameters[0].Type, TypeSymbol.Int32)
        )
        Assert.Same(expected, selected.Function)
        if generic {
            Assert.Same(
                TypeSymbol.Int32,
                Assert.IsType[NullableTypeSymbol](Assert.Single(owner.TypeArguments)).UnderlyingType
            )
            Assert.Same(TypeSymbol.String, Assert.Single(selected.MethodTypeArguments))
        }
        Assert.Same(expected, BoundSemantics.GetSymbol(compilation, token))
        Assert.Same(expected, SemanticLookup.ResolveSymbol(compilation, token))
        let position = LanguageServerTestHelpers.PositionOf(source, needle)
        AssertIndexedHover(
            content,
            position,
            "Make",
            if generic {
                "static func Make[U](value int32, method U) string"
            } else {
                "static func Make(value int32) string"
            }
        )
        let uri = DocumentUri.From("file:///issue5035-interface-chain.gs")!!
        let location = Assert.IsType[Location](DefinitionComputer.ComputeDefinition(uri, content, position))
        let declaration = LanguageServerTestHelpers.PositionOf(
            source,
            if generic {
                "Make[U](value int32"
            } else {
                "Make(value int32"
            }
        )
        Assert.Equal(uri, location.Uri)
        AssertPosition(declaration, location.Range.Start)
        AssertPosition(Position(declaration.Line, declaration.Character + "Make".Length), location.Range.End)
        let outerToken = TokenAt(content, source, "ToString()[^1]", 0)
        let method = typeof(string).GetMethod("ToString", Type.EmptyTypes)
        Assert.Equal(method, outerCall.Method)
        Assert.Equal(method, BoundSemantics.GetImportedMember(compilation, outerToken))
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]"),
            "ToString",
            "func (string) ToString() string"
        )
    }

    @Fact
    func Issue5035_FoldedClrConstant_PreservesExactByteMethod() {
        const source = `package Repro
func Run() {
    let unrelated = System.Text.StringBuilder().ToString()
    let result = byte.MaxValue.ToString()[^1]
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let token = TokenAt(content, source, "ToString()[^1]", 0)
        let root = Assert.IsType[AccessorExpressionSyntax](
            Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "result =", 0).Parent).Initializer
        )
        let model = compilation.GetSemanticModel(content.SyntaxTree)
        let capture = Assert.IsType[BoundVariableDeclaration](
            Assert.IsType[BoundBlockExpression](model.GetBoundNode(root)).Statements[0]
        )
        let call = Assert.IsType[BoundImportedInstanceCallExpression](capture.Initializer)
        Assert.IsType[BoundLiteralExpression](call.Receiver)
        let method = typeof(byte).GetMethod("ToString", Type.EmptyTypes)
        Assert.Equal(method, call.Method)
        Assert.Equal(method, BoundSemantics.GetImportedMember(compilation, token))
        Assert.True(
            ImportedClrMemberResolver.TryResolveClrMember(content.SyntaxTree, compilation, token, out var navigation)
        )
        Assert.Equal(method, navigation)
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]"),
            "ToString",
            "func (uint8) ToString() string"
        )
    }

    @Theory
    @InlineData("^1")
    @InlineData("..")
    func Issue5035_StaticCallIndex_PreservesSelectedOverload(indexText string) {
        let source = `package Repro
class Holder {
    shared {
        func Values(value string) []string -> []string{"string"}
        func Values(value int32) []string -> []string{"int32"}
    }
}
func Run() {
    let warm = Holder.Values("warm")
    let result = Holder.Values(1)[INDEX]
}
`.Replace("INDEX", indexText)
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let owner = compilation.GlobalScope.Structs.Single((type StructSymbol) -> type.Name == "Holder")
        let expected = owner.StaticMethods.Single(
            (method FunctionSymbol) -> method.Name == "Values" &&
                method
                .Parameters
                .Length == 1 &&
                object.ReferenceEquals(method.Parameters[0].Type, TypeSymbol.Int32)
        )
        let position = LanguageServerTestHelpers.PositionOf(source, "Values(1)")
        let token = TokenAt(content, source, "Values(1)", 0)
        Assert.Same(expected, BoundSemantics.GetSymbol(compilation, token))
        Assert.Same(expected, SemanticLookup.ResolveSymbol(compilation, token))
        AssertIndexedHover(content, position, "Values", "static func Values(value int32) []string")
        let uri = DocumentUri.From("file:///issue5035-static-call.gs")!!
        let definition = Assert.IsType[Location](DefinitionComputer.ComputeDefinition(uri, content, position))
        let declaration = LanguageServerTestHelpers.PositionOf(source, "Values(value int32)")
        Assert.Equal(uri, definition.Uri)
        AssertPosition(declaration, definition.Range.Start)
        AssertPosition(Position(declaration.Line, declaration.Character + "Values".Length), definition.Range.End)
    }

    @Fact
    func Issue5035_PrimitiveStaticPrefix_PreservesExactDecimalMetadata() {
        const source = `package Repro
func Run() {
    let unrelated = System.Text.StringBuilder().ToString()
    let result = decimal.Zero.ToString()[^1]
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let field = typeof(decimal).GetField("Zero")
        Assert.True(field?.IsInitOnly)
        Assert.Equal(field, BoundSemantics.GetImportedMember(compilation, TokenAt(content, source, "Zero.ToString", 0)))
        let method = typeof(decimal).GetMethod("ToString", Type.EmptyTypes)
        let token = TokenAt(content, source, "ToString()[^1]", 0)
        Assert.Equal(method, BoundSemantics.GetImportedMember(compilation, token))
        Assert.True(
            ImportedClrMemberResolver.TryResolveClrMember(content.SyntaxTree, compilation, token, out var navigation)
        )
        Assert.Equal(method, navigation)
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]"),
            "ToString",
            "func (decimal) ToString() string"
        )
    }

    @Theory
    @InlineData("int32", false)
    @InlineData("int32?", true)
    func Issue5035_ConstructedStaticIndex_PreservesClosedOwner(argument string, nullable bool) {
        let source = `package Repro
class Holder[T] {
    shared { prop Items []string -> []string{"one"} }
}
func Run() {
    let result = Holder[ARGUMENT].Items[^1]
}
`.Replace("ARGUMENT", argument)
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let token = TokenAt(content, source, "Items[^1]", 0)
        let index = Assert.IsType[IndexExpressionSyntax](token.Parent?.Parent)
        let accessor = Assert.IsType[AccessorExpressionSyntax](index.Parent)
        if nullable {
            Assert.IsType[GenericNameExpressionSyntax](accessor.LeftPart)
        } else {
            Assert.IsType[IndexExpressionSyntax](accessor.LeftPart)
        }
        let block = Assert.IsType[BoundBlockExpression](
            compilation.GetSemanticModel(content.SyntaxTree).GetBoundNode(accessor)
        )
        let capture = Assert.IsType[BoundVariableDeclaration](block.Statements[0])
        let property = Assert.IsType[BoundPropertyAccessExpression](capture.Initializer)
        let closed = Assert.IsType[StructSymbol](property.StructType)
        let definition = compilation.GlobalScope.Structs.Single((type StructSymbol) -> type.Name == "Holder")
        Assert.Same(definition, closed.Definition)
        let typeArgument = Assert.Single(closed.TypeArguments)
        if nullable {
            Assert.Same(TypeSymbol.Int32, Assert.IsType[NullableTypeSymbol](typeArgument).UnderlyingType)
        } else {
            Assert.Same(TypeSymbol.Int32, typeArgument)
        }
        Assert.Same(property.Property, BoundSemantics.GetSymbol(compilation, token))
        Assert.Same(property.Property, SemanticLookup.ResolveSymbol(compilation, token))
        let position = LanguageServerTestHelpers.PositionOf(source, "Items[^1]")
        AssertIndexedHover(content, position, "Items", "prop Items []string { get; }")
        let uri = DocumentUri.From("file:///issue5035-generic-static.gs")!!
        let location = Assert.IsType[Location](DefinitionComputer.ComputeDefinition(uri, content, position))
        let declaration = LanguageServerTestHelpers.PositionOf(source, "Items []string")
        Assert.Equal(uri, location.Uri)
        AssertPosition(declaration, location.Range.Start)
        AssertPosition(Position(declaration.Line, declaration.Character + "Items".Length), location.Range.End)
    }

    @Theory
    @InlineData("^1")
    @InlineData("..")
    func Issue5035_NullConditionalIndex_PreservesSourceProperty(indexText string) {
        let source = `package Repro
class Holder {
    prop Items []string -> []string{"one"}
}
func Run(h Holder?) {
    let result = h?.Items[INDEX]
}
`.Replace("INDEX", indexText)
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let declared = Assert.IsAssignableFrom[PropertySymbol](
            BoundSemantics.GetSymbol(compilation, TokenAt(content, source, "Items []string", 0))
        )
        let position = LanguageServerTestHelpers.PositionOf(source, "Items[")
        let token = TokenAt(content, source, "Items[", 0)
        Assert.Same(declared, BoundSemantics.GetSymbol(compilation, token))
        Assert.Same(declared, SemanticLookup.ResolveSymbol(compilation, token))
        Assert.Same(declared.Type, BoundSemantics.GetExpressionType(compilation, token.Parent as ExpressionSyntax))
        AssertIndexedHover(content, position, "Items", "prop Items []string { get; }")
        let uri = DocumentUri.From("file:///issue5035-null-index.gs")!!
        let definition = Assert.IsType[Location](DefinitionComputer.ComputeDefinition(uri, content, position))
        let expected = LanguageServerTestHelpers.PositionOf(source, "Items []string")
        Assert.Equal(uri, definition.Uri)
        AssertPosition(expected, definition.Range.Start)
        AssertPosition(Position(expected.Line, expected.Character + "Items".Length), definition.Range.End)
    }

    @Theory
    @InlineData("prop Items []string -> []string{\"one\"}", "Items", "prop Items []string { get; }")
    @InlineData("var Fields []string = []string{\"one\"}", "Fields", "(field) Fields []string")
    func Issue5035_StaticSourceIndex_PreservesMember(declaration string, member string, signature string) {
        let source = `package Repro
class Holder {
    shared {
        DECLARATION
    }
}
func Run() {
    let result = Holder.MEMBER[^1]
}
`.Replace("DECLARATION", declaration).Replace("MEMBER", member)
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let declared = BoundSemantics.GetSymbol(compilation, TokenAt(content, source, member + " []string", 0))
        Assert.True(declared is PropertySymbol{IsStatic: true} or FieldSymbol{IsStatic: true})
        let position = LanguageServerTestHelpers.PositionOf(source, member + "[")
        let token = TokenAt(content, source, member + "[", 0)
        Assert.Same(declared, BoundSemantics.GetSymbol(compilation, token))
        Assert.Same(declared, SemanticLookup.ResolveSymbol(compilation, token))
        Assert.Equal(
            typeof([]string),
            BoundSemantics.GetExpressionType(compilation, token.Parent as ExpressionSyntax)?.ClrType
        )
        AssertIndexedHover(content, position, member, signature)
        if declared is FieldSymbol {
            // Plain shared-field navigation already fails independently (#5043).
            return
        }
        let uri = DocumentUri.From("file:///issue5035-static-index.gs")!!
        let definition = Assert.IsType[Location](DefinitionComputer.ComputeDefinition(uri, content, position))
        let expected = LanguageServerTestHelpers.PositionOf(source, member + " []string")
        Assert.Equal(uri, definition.Uri)
        AssertPosition(expected, definition.Range.Start)
        AssertPosition(Position(expected.Line, expected.Character + member.Length), definition.Range.End)
    }

    @Theory
    @InlineData("string.Empty[..]", "Empty", typeof(string), "string.Empty string")
    @InlineData(
        "System.Environment.NewLine[^1]",
        "NewLine",
        typeof(Environment),
        "System.Environment.NewLine string { get; }"
    )
    func Issue5035_StaticClrIndex_PreservesMetadata(
        expression string,
        memberName string,
        owner Type,
        signature string
    ) {
        let source = "package Repro\nfunc Run() { let result = " + expression + " }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let token = TokenAt(content, source, memberName + "[", 0)
        let expected = cast[System.Reflection.MemberInfo?](owner.GetProperty(memberName)) ?? owner.GetField(memberName)
        Assert.NotNull(expected)
        let actual = BoundSemantics.GetImportedMember(compilation, token)
        Assert.Equal(expected, actual)
        Assert.Equal(owner, actual?.DeclaringType)
        Assert.True(
            ImportedClrMemberResolver.TryResolveClrMember(content.SyntaxTree, compilation, token, out var navigation)
        )
        Assert.Equal(expected, navigation)
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, memberName + "["),
            memberName,
            signature
        )
    }

    @Theory
    @InlineData("int32", typeof([]int32))
    @InlineData("System.Range", typeof([]System.Range))
    func Issue5035_NestedArrayArgument_PreservesInnerSourceProperty(elementType string, arrayType Type) {
        let source = `package Repro
class Other {
    prop Values []ELEMENT_TYPE
}
func Run(items []string, other Other) {
    let first = items[other.Values[^1]]
    let second = items[other.Values[^1]].ToString()
}
`.Replace("ELEMENT_TYPE", elementType)
        let root = Path.Combine(
            Directory.GetCurrentDirectory(),
            "out",
            "issue5035-array-owner-" + Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(root)
        try {
            let path = Path.Combine(root, "Consumer.gs")
            File.WriteAllText(path, source)
            let project = ProjectState(Path.Combine(root, "Consumer.gsproj"))
            let tree = project.UpdateFile(path, source)
            let lines = Enumerable.Range(0, source.Length).Where((i int32) -> source[i] == '\n').ToList()
            let content = DocumentContent(tree, lines, project, WorkspaceState())
            let compilation = project.GetCompilation()
            Assert.Empty(compilation.GlobalScope.Diagnostics)
            Assert.Empty(compilation.BoundProgram.Diagnostics)
            let values = Assert.IsAssignableFrom[PropertySymbol](
                BoundSemantics.GetSymbol(compilation, TokenAt(content, source, "Values []" + elementType, 0))
            )
            let items = Assert.IsAssignableFrom[ParameterSymbol](
                BoundSemantics.GetSymbol(compilation, TokenAt(content, source, "items []string", 0))
            )
            let uri = DocumentUri.FromFileSystemPath(path)!!
            for var occurrence = 0; occurrence < 2; occurrence++ {
                let position = LanguageServerTestHelpers.PositionOf(source, "Values[^1]", occurrence)
                let token = TokenAt(content, source, "Values[^1]", occurrence)
                Assert.Same(values, BoundSemantics.GetSymbol(compilation, token))
                Assert.Same(values, SemanticLookup.ResolveSymbol(compilation, token))
                let type = BoundSemantics.GetExpressionType(compilation, token.Parent as ExpressionSyntax)
                Assert.Same(values.Type, type)
                Assert.Equal(arrayType.FullName, type?.ClrType?.FullName)
                Assert.Equal(arrayType.Assembly.FullName, type?.ClrType?.Assembly.FullName)
                AssertIndexedHover(content, position, "Values", "prop Values []" + elementType + " { get; set; }")
                let location = Assert.IsType[Location](DefinitionComputer.ComputeDefinition(uri, content, position))
                let expected = LanguageServerTestHelpers.PositionOf(source, "Values []" + elementType)
                Assert.Equal(uri, location.Uri)
                AssertPosition(expected, location.Range.Start)
                AssertPosition(Position(expected.Line, expected.Character + "Values".Length), location.Range.End)
                Assert.Same(
                    items,
                    BoundSemantics.GetSymbol(compilation, TokenAt(content, source, "items[", occurrence))
                )
            }
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Theory
    @InlineData("slice[string]", "int32", typeof([]int32), false, "0")
    @InlineData("readonly slice[string]", "int32", typeof([]int32), false, "0")
    @InlineData("slice[string]", "System.Range", typeof([]System.Range), false, "0")
    @InlineData("readonly slice[string]", "System.Range", typeof([]System.Range), false, "0")
    @InlineData("slice[string]", "int32", typeof([]int32), true, "0")
    @InlineData("readonly slice[string]", "int32", typeof([]int32), true, "0")
    @InlineData("slice[string]", "System.Range", typeof([]System.Range), true, "0")
    @InlineData("readonly slice[string]", "System.Range", typeof([]System.Range), true, "0")
    @InlineData("slice[string]", "int32", typeof([]int32), true, "^1")
    @InlineData("readonly slice[string]", "int32", typeof([]int32), true, "^1")
    @InlineData("slice[string]", "System.Range", typeof([]System.Range), true, "^1")
    @InlineData("readonly slice[string]", "System.Range", typeof([]System.Range), true, "^1")
    func Issue5035_NestedNativeSliceArgument_KeepsParameterOwnership(
        nativeType string,
        elementType string,
        parameterType Type,
        propertyArgument bool,
        indexText string
    ) {
        let source = `package Repro
class Holder {
    prop Items NATIVE_TYPE
}
class Other {
    prop Values []ELEMENT_TYPE
}
func Run(h Holder, Items []ELEMENT_TYPE, other Other) {
    let parameterControl = Items[0]
    let first = h.Items[ARGUMENT]
    let second = h.Items[ARGUMENT].ToString()
}
`.Replace(
            "NATIVE_TYPE",
            nativeType
        ).Replace(
            "ELEMENT_TYPE",
            elementType
        ).Replace(
            "ARGUMENT",
            if propertyArgument {
                "other.Values[" + indexText + "]"
            } else {
                "Items[" + indexText + "]"
            }
        )
        let root = Path.Combine(
            Directory.GetCurrentDirectory(),
            "out",
            "issue5035-owner-" + Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(root)
        try {
            let path = Path.Combine(root, "Consumer.gs")
            File.WriteAllText(path, source)
            let project = ProjectState(Path.Combine(root, "Consumer.gsproj"))
            project.References = []string{Path.Combine(AppContext.BaseDirectory, "Gsharp.Runtime.Values.dll")}
            let tree = project.UpdateFile(path, source)
            let lines = Enumerable.Range(0, source.Length).Where((i int32) -> source[i] == '\n').ToList()
            let content = DocumentContent(tree, lines, project, WorkspaceState())
            let compilation = project.GetCompilation()
            Assert.Empty(compilation.GlobalScope.Diagnostics)
            Assert.Empty(compilation.BoundProgram.Diagnostics)
            let parameter = Assert.IsAssignableFrom[ParameterSymbol](
                BoundSemantics.GetSymbol(compilation, TokenAt(content, source, "Items []" + elementType, 0))
            )
            let property = Assert.IsAssignableFrom[PropertySymbol](
                BoundSemantics.GetSymbol(compilation, TokenAt(content, source, "Items " + nativeType, 0))
            )
            let values = Assert.IsAssignableFrom[PropertySymbol](
                BoundSemantics.GetSymbol(compilation, TokenAt(content, source, "Values []" + elementType, 0))
            )
            let expectedSymbol Symbol = if propertyArgument {
                cast[Symbol](values)
            } else {
                cast[Symbol](parameter)
            }
            let expectedType = if propertyArgument {
                values.Type
            } else {
                parameter.Type
            }
            let name = if propertyArgument {
                "Values"
            } else {
                "Items"
            }
            let declarationText = name + " []" + elementType
            let outerText = if propertyArgument {
                "Items[other.Values[" + indexText + "]]"
            } else {
                "Items[Items[" + indexText + "]]"
            }
            let uri = DocumentUri.FromFileSystemPath(path)!!
            Assert.Same(parameter, SemanticLookup.ResolveSymbol(compilation, TokenAt(content, source, "Items[0]", 0)))
            for var occurrence = 0; occurrence < 2; occurrence++ {
                let use = if propertyArgument {
                    occurrence
                } else {
                    occurrence + 1
                }
                let position = LanguageServerTestHelpers.PositionOf(source, name + "[" + indexText + "]", use)
                let argument = TokenAt(content, source, name + "[" + indexText + "]", use)
                Assert.Same(expectedSymbol, SemanticLookup.ResolveSymbol(compilation, argument))
                if propertyArgument {
                    Assert.Same(values, BoundSemantics.GetSymbol(compilation, argument))
                }
                if BoundSemantics.GetSymbol(compilation, argument) is {} bound {
                    Assert.Same(expectedSymbol, bound)
                }
                Assert.Equal(parameterType.FullName, expectedType.ClrType?.FullName)
                Assert.Equal(parameterType.Assembly.FullName, expectedType.ClrType?.Assembly.FullName)
                AssertIndexedHover(
                    content,
                    position,
                    name,
                    if propertyArgument {
                        "prop Values []" + elementType + " { get; set; }"
                    } else {
                        "(parameter) Items []" + elementType
                    }
                )
                let location = Assert.IsType[Location](DefinitionComputer.ComputeDefinition(uri, content, position))
                let expected = LanguageServerTestHelpers.PositionOf(source, declarationText)
                Assert.Equal(uri, location.Uri)
                AssertPosition(expected, location.Range.Start)
                AssertPosition(Position(expected.Line, expected.Character + name.Length), location.Range.End)
                let outer = TokenAt(content, source, outerText, occurrence)
                Assert.Same(property, BoundSemantics.GetSymbol(compilation, outer))
            }
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    shared {
        private const IndexedSource string = `package Repro
import System.Collections.Generic
let Args = "global"
class RunnerCall {
    prop Args []string -> []string{"arg"}
    prop FileName string -> "file"
    var Fields []string = []string{"field"}
}
class Runner {
    prop Calls List[RunnerCall] -> List[RunnerCall]()
}
func Run(runner Runner) {
    let Calls = 0
    let Args = 0
    let normal = runner.Calls
    let ownCalls = runner.Calls[Calls]
    let ownArgs = runner.Calls[0].Args[Args]
    let tail = runner.Calls[0].FileName.Length
    let result = EXPRESSION_PLACEHOLDER
}
`

        private func AssertIndexedHover(content DocumentContent, position Position, token string, signature string) {
            let hover = Assert.IsType[Hover](HoverComputer.ComputeHover(content, position))
            Assert.Equal(signature, hover.Contents.ToString().Split('\n')[1])
            AssertPosition(position, hover.Range.Start)
            AssertPosition(Position(position.Line, position.Character + token.Length), hover.Range.End)
        }

        private func AssertPosition(expected Position, actual Position) {
            Assert.Equal(expected.Line, actual.Line)
            Assert.Equal(expected.Character, actual.Character)
        }

        private const GenericInterfaceSource string = `package Repro

interface IBox[T] {
    /// The boxed value.
    prop Value T { get; }
}

class IntBox : IBox[int32] {
    prop Value int32 -> 3
}

func Run(b IBox[int32]) int32 {
    return b.Value
}
`

        private const EventSource string = `package Repro

import System

class Foo {
    event Click (Object, EventArgs) -> void

    func Read() bool {
        let handler = this.Click
        return handler == nil
    }
}
`

        private const TypeDefinitionSource string = `package Repro

class Result {
}

class C {
    func Make() Result -> Result()
}

func Run(c C) bool {
    let made = c?.Make()
    let maybe Result? = nil
    return made == nil && maybe == nil
}
`

        private const NullConditionalSource string = `package Repro

import System.Threading.Tasks

interface IStore {
    func LoadAsync() Task[string?];
}

func Run(store IStore?) bool {
    let pending = store?.LoadAsync()
    return pending == nil
}
`

        private const ValueReceiverSource string = `package Repro

struct Point {
    var X int32
}

func Run(p Point?, n int32?) int32 {
    if p != nil && n != nil {
        return p.X + n.GetHashCode()
    }
    return 0
}
`

        private const ChainSource string = `package Repro

class Holder {
    func Count() int32 -> 1
}

class Store {
    var Box Holder = Holder()
}

func Run(store Store?) int32 {
    guard let s = store else {
        return 0
    }
    return s.Box.Count()
}
`

        private const GenericSource string = `package Repro

class Box[T] {
    var Value T
}

func Run() int32 {
    let b = Box[int32]{Value: 3}
    return b.Value
}
`

        private const OverloadSource string = `package Repro

class C {
    func M() int32 -> 1
    func M(x int32) int32 -> x
}

func Run(c C) int32 {
    return c.M()
}
`

        /// Gets the bound type of the receiver that starts [`text`](paramref).
        private func ReceiverType(
            compilation Compilation,
            content DocumentContent,
            source string,
            text string
        ) TypeSymbol? -> BoundSemantics
            .GetExpressionType(
            compilation,
            TokenAt(content, source, text, 0).Parent as GSharp.Core.CodeAnalysis.Syntax.ExpressionSyntax
        )

        private const IssueSource string = `package Repro

import System
import System.Threading.Tasks

interface IStore {
    func LoadAsync() Task[string?];
}

class MacStore : IStore {
    func LoadAsync() Task[string?] -> Task.FromResult[string?](nil)
}

class LinuxStore : IStore {
    func LoadAsync() Task[string?] -> Task.FromResult[string?](nil)
}

async func Run() {
    var store IStore? = nil
    if OperatingSystem.IsMacOS() {
        store = MacStore()
    } else if OperatingSystem.IsLinux() {
        store = LinuxStore()
    }

    guard let s = store else {
        return
    }

    let loaded = await s.LoadAsync()
}
`

        private const BclSource string = `package Repro

import System
import System.Collections.Generic

func Run(k int32) int32 {
    let warm = List[int32]()
    let first = warm.GetEnumerator()
    var store IEnumerable[int32]? = nil
    if k == 0 {
        store = List[int32]()
    } else if k == 1 {
        store = HashSet[int32]()
    }
    guard let s = store else {
        return 0
    }
    let e = s.GetEnumerator()
    return 1
}
`

        private const TokenFixtureSource string = `#nullable enable
using System.Threading.Tasks;

namespace TokenFixture
{
    public interface ITokenStore
    {
        Task<string?> LoadAsync();
    }

    public class KeychainTokenStore : ITokenStore
    {
        public Task<string?> LoadAsync() => Task.FromResult<string?>("keychain");
    }

    public class SecretToolTokenStore : ITokenStore
    {
        public Task<string?> LoadAsync() => Task.FromResult<string?>("secret-tool");
    }
}
`

        private const ConsumerSource string = `package Consumer

import System
import System.Threading.Tasks
import TokenFixture

async func Warm() {
    let keychain = KeychainTokenStore()
    let first = await keychain.LoadAsync()
}

async func Run(mac bool, linux bool) {
    var store ITokenStore? = nil
    if mac {
        store = KeychainTokenStore()
    } else if linux {
        store = SecretToolTokenStore()
    }
    guard let s = store else {
        return
    }
    let loaded = await s.LoadAsync()
}
`

        /// Compiles a native C# contract into [`assemblyPath`](paramref).
        private func EmitClrFixture(assemblyPath string, source string) {
            let fixture = CSharpCompilation.Create(
                Path.GetFileNameWithoutExtension(assemblyPath),
                []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                []Microsoft
                    .CodeAnalysis
                    .PortableExecutableReference{
                    Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(typeof(object).Assembly.Location)
                },
                CSharpCompilationOptions(Microsoft.CodeAnalysis.OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(assemblyPath)
            let emitted = fixture.Emit(stream)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        }

        private func HoverText(
            content DocumentContent,
            source string,
            text string,
            occurrence int32
        ) string -> HoverComputer
            .ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, text, occurrence))
            ?.Contents
            .ToString() ??
            string.Empty

        private func TokenAt(content DocumentContent, source string, text string, occurrence int32) SyntaxToken {
            let position = LanguageServerTestHelpers.PositionOf(source, text, occurrence)
            return Assert.IsAssignableFrom[SyntaxToken](
                SemanticLookup.FindTokenAt(content.SyntaxTree, SemanticLookup.ToOffset(content, position))
            )
        }
    }
}
