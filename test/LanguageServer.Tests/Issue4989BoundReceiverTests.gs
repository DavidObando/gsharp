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

    shared {
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
