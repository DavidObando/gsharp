// <copyright file="Issue4989BoundReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

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
            EmitTokenFixture(assemblyPath)
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

        /// Compiles the C# token-store contract into [`assemblyPath`](paramref).
        private func EmitTokenFixture(assemblyPath string) {
            let fixture = CSharpCompilation.Create(
                "TokenFixture",
                []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(TokenFixtureSource)},
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
