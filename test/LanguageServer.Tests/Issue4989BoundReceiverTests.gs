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
    @Theory
    @InlineData(0, false)
    @InlineData(0, true)
    @InlineData(1, false)
    @InlineData(1, true)
    @InlineData(2, false)
    @InlineData(2, true)
    func Issue5035_ImportedAndBaseLoweredArgument_PublishesAwait(mode int32, asyncCaller bool) {
        let root = Path.Combine(
            Directory.GetCurrentDirectory(),
            "issue5035-imported-completion-" + Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(root)
        try {
            let assemblyPath = Path.Combine(root, "CompletionContracts.dll")
            EmitClrFixture(assemblyPath, `using System.Threading.Tasks;
using Gsharp.Concurrency;
namespace CompletionContracts {
    public class Api {
        [Suspending] public ValueTask<string> Read(int value, Context context = default) => new("selected");
        public string Read(string value) => "decoy";
    }
}`, []string{
                    Path.Combine(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "System.Runtime.dll"),
                    typeof(Gsharp.Concurrency.SuspendingAttribute).Assembly.Location
                })
            let source = `package Repro
BASE_DECLARATION
class Holder BASE_TYPE {
    prop Value int32 { get; set; }
    CALLERfunc Run(PARAMETER) {
        let competing = System.Text.StringBuilder().ToString()
        let indexed = RECEIVER.Read(this.Value).ToString()[^1]
    }
}
`.Replace(
                "BASE_DECLARATION",
                if mode == 2 {
                    "open class SourceBase { suspend func Read(value int32) string -> \"selected\" }"
                } else {
                    ""
                }
            ).Replace(
                "BASE_TYPE",
                if mode == 0 {
                    ""
                } else if mode == 1 {
                    ": CompletionContracts.Api"
                } else {
                    ": SourceBase"
                }
            ).Replace(
                "CALLER",
                if asyncCaller {
                    "async "
                } else {
                    ""
                }
            ).Replace(
                "PARAMETER",
                if mode == 0 {
                    "api CompletionContracts.Api"
                } else {
                    ""
                }
            ).Replace(
                "RECEIVER",
                if mode == 0 {
                    "api"
                } else {
                    "base"
                }
            )
            let path = Path.Combine(root, "Consumer.gs")
            File.WriteAllText(path, source)
            let project = ProjectState(Path.Combine(root, "Consumer.gsproj"))
            project.References = []string{
                assemblyPath,
                typeof(Gsharp.Concurrency.SuspendingAttribute).Assembly.Location
            }
            let tree = project.UpdateFile(path, source)
            let content = DocumentContent(
                tree,
                Enumerable.Range(0, source.Length).Where((i int32) -> source[i] == '\n').ToList(),
                project,
                WorkspaceState()
            )
            let compilation = project.GetCompilation()
            Assert.Empty(compilation.GlobalScope.Diagnostics)
            Assert.Empty(compilation.BoundProgram.Diagnostics)
            let owner = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Holder")
            let run = owner.Methods.Single((f FunctionSymbol) -> f.Name == "Run")
            if !asyncCaller {
                Assert.Equal("Inferred", run.SuspendingKind.ToString())
            }
            let expression = Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "indexed =", 0).Parent)
                .Initializer
            let plan = Assert.IsType[BoundBlockExpression](
                compilation.GetSemanticModel(tree).GetBoundNode(expression!!)
            )
            let following = Assert.IsType[BoundImportedInstanceCallExpression](
                Assert.IsType[BoundVariableDeclaration](plan.Statements[0]).Initializer
            )
            let completion = Assert.IsType[BoundAwaitExpression](following.Receiver)
            let token = TokenAt(content, source, "Read(this.Value)", 0)
            Assert.Same(token.Parent, completion.Expression.Syntax)
            var argument BoundExpression
            if mode == 2 {
                let selected = Assert.IsType[BoundBaseClassCallExpression](completion.Expression)
                let expected = compilation
                    .GlobalScope
                    .Structs
                    .Single((s StructSymbol) -> s.Name == "SourceBase")
                    .Methods
                    .Single((f FunctionSymbol) -> f.Name == "Read")
                Assert.Same(expected, selected.Method)
                Assert.Same(expected, BoundSemantics.GetSymbol(compilation, token))
                argument = selected.Arguments[0]
                let definition = Assert.IsType[Location](
                    DefinitionComputer.ComputeDefinition(
                        DocumentUri.FromFileSystemPath(path)!!,
                        content,
                        LanguageServerTestHelpers.PositionOf(source, "Read(this.Value)")
                    )
                )
                let declaration = LanguageServerTestHelpers.PositionOf(source, "Read(value int32)")
                AssertPosition(declaration, definition.Range.Start)
            } else {
                let selected = Assert.IsType[BoundImportedInstanceCallExpression](completion.Expression)
                Assert.Equal("CompletionContracts.Api", selected.Method.DeclaringType?.FullName)
                Assert.Equal("System.Int32", selected.Method.GetParameters()[0].ParameterType.FullName)
                Assert.Equal("CompletionContracts", selected.Method.Module.Assembly.GetName().Name)
                Assert.Equal(selected.Method, BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, token)))
                argument = selected.Arguments[0]
            }
            Assert.Same(
                owner.Properties.Single((p PropertySymbol) -> p.Name == "Value").BackingField,
                Assert.IsType[BoundFieldAccessExpression](argument).Field
            )
            Assert.Equal(
                "System.String",
                BoundSemantics
                    .GetExpressionType(compilation, Assert.IsType[CallExpressionSyntax](token.Parent))
                    ?.ClrType
                    ?.FullName
            )
            Assert.Equal("System.String", following.Method.DeclaringType?.FullName)
            Assert.Equal("ToString", following.Method.Name)
            Assert.Empty(following.Method.GetParameters())
            Assert.Equal(
                following.Method,
                BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, TokenAt(content, source, "ToString()[^1]", 0)))
            )
            AssertIndexedHover(
                content,
                LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]"),
                "ToString",
                "func (string) ToString() string"
            )
            Assert.DoesNotContain(
                compilation.BoundProgram.Functions[run].DescendantsAndSelf().OfType[BoundImportedCallExpression](),
                (c BoundImportedCallExpression) ->
                c
                    .Function
                    .Method
                    .DeclaringType
                    ?.FullName == "Gsharp.Concurrency.Blocking" &&
                    c
                    .Function
                    .Method
                    .Name == "Wait"
            )
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func Issue5035_LoweredSuspendingArgument_KeepsEarlyCallSiteAndAwait(asyncCaller bool, generic bool) {
        let source = `package Repro
class HolderOWNER_GENERIC {
    prop Value int32 { get; set; }
    shared {
        func Read(value string) string -> "decoy"
        suspend func ReadMETHOD_GENERIC(value int32) string -> "selected"
    }
    CALLERfunc Run() {
        let competing = System.Text.StringBuilder().ToString()
        let indexed = TARGET.ReadCALL_GENERIC(this.Value).ToString()[^1]
    }
}
`.Replace(
            "OWNER_GENERIC",
            if generic {
                "[T]"
            } else {
                ""
            }
        ).Replace(
            "METHOD_GENERIC",
            if generic {
                "[U]"
            } else {
                ""
            }
        ).Replace(
            "CALL_GENERIC",
            if generic {
                "[bool]"
            } else {
                ""
            }
        ).Replace(
            "TARGET",
            if generic {
                "Holder[int32]"
            } else {
                "Holder"
            }
        ).Replace(
            "CALLER",
            if asyncCaller {
                "async "
            } else {
                ""
            }
        )
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let owner = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Holder")
        let run = owner.Methods.Single((f FunctionSymbol) -> f.Name == "Run")
        if !asyncCaller {
            Assert.Equal("Inferred", run.SuspendingKind.ToString())
        }
        let token = TokenAt(
            content,
            source,
            if generic {
                "Read[bool](this.Value)"
            } else {
                "Read(this.Value)"
            },
            0
        )
        let expected = owner.StaticMethods.Single((f FunctionSymbol) -> f.Name == "Read" && f.IsSuspending)
        let root = Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "indexed =", 0).Parent).Initializer
        let plan = Assert.IsType[BoundBlockExpression](
            compilation.GetSemanticModel(content.SyntaxTree).GetBoundNode(root!!)
        )
        let following = Assert.IsType[BoundImportedInstanceCallExpression](
            Assert.IsType[BoundVariableDeclaration](plan.Statements[0]).Initializer
        )
        let completion = Assert.IsType[BoundAwaitExpression](following.Receiver)
        let selected = Assert.IsType[BoundCallExpression](completion.Expression)
        Assert.Same(expected, selected.Function)
        Assert.Same(token.Parent, selected.Syntax)
        Assert.Same(
            owner.Properties.Single((p PropertySymbol) -> p.Name == "Value").BackingField,
            Assert.IsType[BoundFieldAccessExpression](selected.Arguments[0]).Field
        )
        Assert.Same(expected, BoundSemantics.GetSymbol(compilation, token))
        Assert.Same(expected, SemanticLookup.ResolveSymbol(compilation, token))
        Assert.Same(
            TypeSymbol.String,
            BoundSemantics.GetExpressionType(compilation, Assert.IsType[CallExpressionSyntax](token.Parent))
        )
        Assert.Equal(
            typeof(string).GetMethod("ToString", Type.EmptyTypes),
            BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, TokenAt(content, source, "ToString()[^1]", 0)))
        )
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]"),
            "ToString",
            "func (string) ToString() string"
        )
        let uri = DocumentUri.From("file:///issue5035-callsite-before-lowering.gs")!!
        let position = LanguageServerTestHelpers.PositionOf(
            source,
            if generic {
                "Read[bool](this.Value)"
            } else {
                "Read(this.Value)"
            }
        )
        let declaration = LanguageServerTestHelpers.PositionOf(
            source,
            if generic {
                "Read[U](value int32)"
            } else {
                "Read(value int32)"
            }
        )
        let definition = Assert.IsType[Location](DefinitionComputer.ComputeDefinition(uri, content, position))
        AssertPosition(declaration, definition.Range.Start)
        AssertPosition(Position(declaration.Line, declaration.Character + "Read".Length), definition.Range.End)
        let declaredHover = Assert.IsType[Hover](HoverComputer.ComputeHover(content, declaration))
        AssertIndexedHover(content, position, "Read", declaredHover.Contents.ToString().Split('\n')[1])
    }

    @Fact
    func Issue5035_BareConstantPrefix_PreservesExactMethodAndRange() {
        const source = `package Repro
class Holder {
    shared {
        const Value int32 = 1
        func Run() {
            let competing = System.Text.StringBuilder().ToString()
            let indexed = Value.ToString()[^1]
            let control = Holder.Value.ToString()[^1]
        }
    }
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let method = typeof(int32).GetMethod("ToString", Type.EmptyTypes)
        Assert.Equal(
            method,
            BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, TokenAt(content, source, "ToString()[^1]", 1)))
        )
        Assert.Equal(
            method,
            BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, TokenAt(content, source, "ToString()[^1]", 0)))
        )
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]"),
            "ToString",
            "func (int32) ToString() string"
        )
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]", 1),
            "ToString",
            "func (int32) ToString() string"
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Issue5035_ImplicitFieldPrefix_KeepsSelectedMethodAndFlowType(narrowed bool) {
        VerifyImplicitNamedMember(
            if narrowed {
                "let Address System.Uri? = System.Uri(\"https://example.test/path\")"
            } else {
                "var Address System.Uri = System.Uri(\"https://example.test/path\")"
            },
            false,
            narrowed,
            false
        )
    }

    @Theory
    @InlineData(0)
    @InlineData(1)
    @InlineData(2)
    @InlineData(3)
    func Issue5035_ImplicitPropertyAndSharedPrefix_KeepsSelectedMethod(mode int32) {
        VerifyImplicitNamedMember(
            if mode == 1 {
                "prop Address System.Uri? { get; }"
            } else if mode == 2 {
                "var Address System.Uri = System.Uri(\"https://example.test/path\")"
            } else {
                "prop Address System.Uri -> System.Uri(\"https://example.test/path\")"
            },
            mode >= 2,
            mode == 1,
            mode != 2
        )
    }

    private func VerifyImplicitNamedMember(declarationText string, sharedMember bool, narrowed bool, property bool) {
        let source = `package Repro
class Holder {
    SHARED_OPEN
    DECLARATION
    func Run() {
        let competing = System.Text.StringBuilder().ToString()
        GUARD_OPEN
        let indexed = Address.ToString()[^1]
        GUARD_CLOSE
    }
    func Control() {
        GUARD_OPEN
        let control = EXPLICIT.Address.ToString()[^1]
        GUARD_CLOSE
    }
    SHARED_CLOSE
}
`.Replace(
            "DECLARATION",
            declarationText
        ).Replace(
            "SHARED_OPEN",
            if sharedMember {
                "shared {"
            } else {
                ""
            }
        ).Replace(
            "SHARED_CLOSE",
            if sharedMember {
                "}"
            } else {
                ""
            }
        ).Replace(
            "EXPLICIT",
            if sharedMember {
                "Holder"
            } else {
                "this"
            }
        ).Replace(
            "GUARD_OPEN",
            if narrowed {
                "if Address != nil {"
            } else {
                ""
            }
        ).Replace(
            "GUARD_CLOSE",
            if narrowed {
                "}"
            } else {
                ""
            }
        )
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let declared = BoundSemantics.GetSymbol(compilation, TokenAt(content, source, "Address System.Uri", 0))
        Assert.True(property == (declared is PropertySymbol))
        let declaredType = switch declared {
            case field is FieldSymbol: field.Type
            case selected is PropertySymbol: selected.Type
            default: throw InvalidOperationException("Expected the source member declaration.")
        }
        let token = TokenAt(content, source, "Address.ToString()", 0)
        let method = typeof(System.Uri).GetMethod("ToString", Type.EmptyTypes)
        Assert.Equal(
            method,
            BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, TokenAt(content, source, "ToString()[^1]", 1)))
        )
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]", 1),
            "ToString",
            "func (System.Uri) ToString() string"
        )
        Assert.Equal(
            method,
            BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, TokenAt(content, source, "ToString()[^1]", 0)))
        )
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]"),
            "ToString",
            "func (System.Uri) ToString() string"
        )
        Assert.Same(declared, BoundSemantics.GetSymbol(compilation, token))
        Assert.Same(declared, SemanticLookup.ResolveSymbol(compilation, token))
        let flowType = BoundSemantics.GetExpressionType(compilation, Assert.IsType[NameExpressionSyntax](token.Parent))
        Assert.Equal(typeof(System.Uri), flowType?.ClrType)
        Assert.False(flowType is NullableTypeSymbol)
        Assert.Equal(narrowed, declaredType is NullableTypeSymbol)
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Address.ToString()"),
            "Address",
            (
                if property {
                    "prop Address System.Uri"
                } else {
                    "(field) Address System.Uri"
                }
            ) +
                (
                if narrowed {
                    "?"
                } else {
                    ""
                }
            ) +
                (
                if property {
                    " { get; }"
                } else {
                    ""
                }
            )
        )
        if sharedMember && !property {
            // Plain shared-field declaration navigation remains tracked by #5043.
            return
        }
        let uri = DocumentUri.From("file:///issue5035-implicit-field.gs")!!
        let definition = Assert.IsType[Location](
            DefinitionComputer.ComputeDefinition(
                uri,
                content,
                LanguageServerTestHelpers.PositionOf(source, "Address.ToString()")
            )
        )
        let declaration = LanguageServerTestHelpers.PositionOf(source, "Address System.Uri")
        AssertPosition(declaration, definition.Range.Start)
        AssertPosition(Position(declaration.Line, declaration.Character + "Address".Length), definition.Range.End)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Issue5035_TopLevelBlockingCompletion_PreservesSelectedCallAndAuthoredWait(chained bool) {
        let source = `package Repro
class Holder {
    shared {
        func Values(value string) RESULT_TYPE -> RESULT
        suspend func Values(value int32) RESULT_TYPE -> RESULT
    }
}
let competing = System.Text.StringBuilder().ToString()
let indexed = Holder.Values(1)SUFFIX
let authored = Gsharp.Concurrency.Blocking.Wait[RESULT_TYPE](
    System.Threading.Tasks.ValueTask[RESULT_TYPE](RESULT))
async func AuthoredCaller() {
    let authoredAsync = Gsharp.Concurrency.Blocking.Wait[RESULT_TYPE](
        System.Threading.Tasks.ValueTask[RESULT_TYPE](RESULT))
}
`.Replace(
            "RESULT_TYPE",
            if chained {
                "string"
            } else {
                "[]string"
            }
        ).Replace(
            "RESULT",
            if chained {
                "\"result\""
            } else {
                "[]string{\"result\"}"
            }
        ).Replace(
            "SUFFIX",
            if chained {
                ".ToString()[^1]"
            } else {
                "[^1]"
            }
        )
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let owner = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Holder")
        let expected = owner.StaticMethods.Single((f FunctionSymbol) -> f.Name == "Values" && f.IsSuspending)
        let model = compilation.GetSemanticModel(content.SyntaxTree)
        let root = Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "indexed =", 0).Parent).Initializer
        let plan = Assert.IsType[BoundBlockExpression](model.GetBoundNode(root!!))
        let captured = Assert.IsType[BoundVariableDeclaration](plan.Statements[0]).Initializer
        let completed = if chained {
            Assert.IsType[BoundImportedInstanceCallExpression](captured).Receiver
        } else {
            captured
        }
        let bridge = Assert.IsType[BoundImportedCallExpression](completed)
        let selected = Assert.IsType[BoundCallExpression](Assert.Single(bridge.Arguments))
        Assert.Same(expected, selected.Function)
        Assert.NotSame(bridge.Type, selected.Type)
        let authoredToken = TokenAt(content, source, "Wait[", 0)
        let authored = Assert.IsType[BoundImportedCallExpression](
            model.GetBoundNode(Assert.IsType[CallExpressionSyntax](authoredToken.Parent))
        )
        Assert.Equal(bridge.Function.Method, authored.Function.Method)
        Assert.Equal(authored.Function.Method, BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, authoredToken)))
        let token = TokenAt(content, source, "Values(1)", 0)
        Assert.Same(expected, BoundSemantics.GetSymbol(compilation, token))
        Assert.Same(expected, SemanticLookup.ResolveSymbol(compilation, token))
        let authoredAsyncToken = TokenAt(content, source, "Wait[", 1)
        Assert.Equal(authored.Function.Method, BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, authoredAsyncToken)))
        Assert.IsType[BoundImportedCallExpression](
            model.GetBoundNode(Assert.IsType[CallExpressionSyntax](authoredAsyncToken.Parent))
        )
        Assert.Same(
            bridge.Type,
            BoundSemantics.GetExpressionType(compilation, Assert.IsType[CallExpressionSyntax](token.Parent))
        )
        let position = LanguageServerTestHelpers.PositionOf(source, "Values(1)")
        let declaration = LanguageServerTestHelpers.PositionOf(source, "Values(value int32)")
        let declaredHover = Assert.IsType[Hover](HoverComputer.ComputeHover(content, declaration))
        AssertIndexedHover(content, position, "Values", declaredHover.Contents.ToString().Split('\n')[1])
        let uri = DocumentUri.From("file:///issue5035-blocking-completion.gs")!!
        let definition = Assert.IsType[Location](DefinitionComputer.ComputeDefinition(uri, content, position))
        AssertPosition(declaration, definition.Range.Start)
        AssertPosition(Position(declaration.Line, declaration.Character + "Values".Length), definition.Range.End)
        if chained {
            Assert.Equal(
                typeof(string).GetMethod("ToString", Type.EmptyTypes),
                BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, TokenAt(content, source, "ToString()[^1]", 0)))
            )
            AssertIndexedHover(
                content,
                LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]"),
                "ToString",
                "func (string) ToString() string"
            )
        }
    }

    @Theory
    @InlineData(0)
    @InlineData(1)
    @InlineData(2)
    func Issue5035_InstanceAutoProperty_RetainsLogicalMemberAfterLowering(mode int32) {
        let source = `package Repro
class HolderGENERIC {
    prop Items ELEMENT_TYPE { ACCESSORS }
    var Other []string = []string{"other"}
    func Run(EXTRA_PARAMETER Items int32) {
        GUARD_OPEN
        let indexed = TARGET.Items[Items]
        let after = TARGET.Items[Items].Length
        let unrelated = this.Other[Items]
        GUARD_CLOSE
    }
}
`.Replace(
            "GENERIC",
            if mode == 1 {
                "[T]"
            } else {
                ""
            }
        ).Replace(
            "ELEMENT_TYPE",
            if mode == 1 {
                "[]T"
            } else if mode == 2 {
                "([]string)?"
            } else {
                "[]string"
            }
        ).Replace(
            "ACCESSORS",
            if mode == 2 {
                "get;"
            } else {
                "get; set;"
            }
        ).Replace(
            "EXTRA_PARAMETER",
            if mode == 1 {
                "other Holder[string], "
            } else {
                ""
            }
        ).Replace(
            "TARGET",
            if mode == 1 {
                "other"
            } else {
                "this"
            }
        ).Replace(
            "GUARD_OPEN",
            if mode == 2 {
                "if this.Items != nil {"
            } else {
                ""
            }
        ).Replace(
            "GUARD_CLOSE",
            if mode == 2 {
                "}"
            } else {
                ""
            }
        )
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let model = compilation.GetSemanticModel(content.SyntaxTree)
        let owner = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Holder")
        let initializer = Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "indexed =", 0).Parent)
            .Initializer
        let physical = Assert.IsType[BoundFieldAccessExpression](
            Assert.IsType[BoundIndexExpression](model.GetBoundNode(initializer!!)).Target
        )
        let effectiveOwner = Assert.IsType[StructSymbol](physical.StructType)
        let property = effectiveOwner.Properties.Single((p PropertySymbol) -> p.Name == "Items")
        Assert.True(property.IsAutoProperty)
        Assert.Same(property.BackingField, physical.Field)
        if mode == 1 {
            Assert.Same(TypeSymbol.String, Assert.Single(effectiveOwner.TypeArguments))
        }
        for var occurrence = 0; occurrence < 2; occurrence++ {
            let token = TokenAt(content, source, "Items[Items]", occurrence)
            let position = LanguageServerTestHelpers.PositionOf(source, "Items[Items]", occurrence)
            let resolved = Assert.IsType[PropertySymbol](BoundSemantics.GetSymbol(compilation, token))
            Assert.Same(property.Declaration, resolved.Declaration)
            Assert.Same(property.BackingField, resolved.BackingField)
            Assert.Equal(property.Type, resolved.Type)
            Assert.Same(
                property.Declaration,
                Assert.IsType[PropertySymbol](SemanticLookup.ResolveSymbol(compilation, token)).Declaration
            )
            let flow = BoundSemantics.GetExpressionType(compilation, Assert.IsType[NameExpressionSyntax](token.Parent))
            Assert.Equal(typeof([]string), flow?.ClrType)
            Assert.False(flow is NullableTypeSymbol)
            AssertIndexedHover(
                content,
                position,
                "Items",
                if mode == 2 {
                    "prop Items []?string { get; }"
                } else {
                    "prop Items []string { get; set; }"
                }
            )
            let uri = DocumentUri.From("file:///issue5035-instance-property.gs")!!
            let definition = Assert.IsType[Location](DefinitionComputer.ComputeDefinition(uri, content, position))
            let declaration = LanguageServerTestHelpers.PositionOf(
                source,
                "Items ELEMENT_TYPE".Replace(
                    "ELEMENT_TYPE",
                    if mode == 1 {
                        "[]T"
                    } else if mode == 2 {
                        "([]string)?"
                    } else {
                        "[]string"
                    }
                )
            )
            AssertPosition(declaration, definition.Range.Start)
            AssertPosition(Position(declaration.Line, declaration.Character + "Items".Length), definition.Range.End)
            let argument = TokenAt(content, source, "Items]", occurrence)
            Assert.Same(
                owner.Methods.Single((f FunctionSymbol) -> f.Name == "Run").Parameters.Last(),
                SemanticLookup.ResolveSymbol(compilation, argument)
            )
        }
        Assert.Equal(
            typeof(string).GetProperty("Length"),
            BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, TokenAt(content, source, "Length", 0)))
        )
        Assert.Same(
            owner.Fields.Single((f FieldSymbol) -> f.Name == "Other"),
            BoundSemantics.GetSymbol(compilation, TokenAt(content, source, "Other[", 0))
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Issue5035_InferredCallee_PreservesSelectedMemberAndLogicalType(chained bool) {
        VerifySuspendingCallee(chained, "inferred")
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func Issue5035_DeclaredCallee_PreservesCompletionAndLogicalType(chained bool, asyncCaller bool) {
        VerifySuspendingCallee(
            chained,
            if asyncCaller {
                "async"
            } else {
                "suspend"
            }
        )
    }

    private func VerifySuspendingCallee(chained bool, caller string) {
        let source = `package Repro
class Holder {
    shared {
        func Values(value int32) RESULT_TYPE -> DECOY
        CALLEE_MODIFIERfunc Values(ch in chan[string]) RESULT_TYPE {
            let value = <-ch
            return RESULT
        }
    }
}
CALLER_MODIFIERfunc Run(ch chan[string]) {
    let competing = System.Text.StringBuilder().ToString()
    let wrong = Holder.Values(1)
    let authored = await System.Threading.Tasks.Task.FromResult("authored")
    let indexed = Holder.Values(ch)SUFFIX
}
`.Replace(
            "CALLEE_MODIFIER",
            if caller == "inferred" {
                ""
            } else {
                "suspend "
            }
        ).Replace(
            "CALLER_MODIFIER",
            if caller == "inferred" {
                ""
            } else {
                caller + " "
            }
        ).Replace(
            "RESULT_TYPE",
            if chained {
                "string"
            } else {
                "[]string"
            }
        ).Replace(
            "DECOY",
            if chained {
                "\"wrong\""
            } else {
                "[]string{\"wrong\"}"
            }
        ).Replace(
            "RESULT",
            if chained {
                "value"
            } else {
                "[]string{value}"
            }
        ).Replace(
            "SUFFIX",
            if chained {
                ".ToString()[^1]"
            } else {
                "[^1]"
            }
        )
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let owner = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Holder")
        let expected = owner.StaticMethods.Single((f FunctionSymbol) -> f.Name == "Values" && f.IsSuspending)
        let root = Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "indexed =", 0).Parent).Initializer
        let plan = Assert.IsType[BoundBlockExpression](
            compilation.GetSemanticModel(content.SyntaxTree).GetBoundNode(root!!)
        )
        let captured = Assert.IsType[BoundVariableDeclaration](plan.Statements[0]).Initializer
        let completed = if chained {
            Assert.IsType[BoundImportedInstanceCallExpression](captured).Receiver
        } else {
            captured
        }
        let completion = Assert.IsType[BoundAwaitExpression](completed)
        let selected = Assert.IsType[BoundCallExpression](completion.Expression)
        Assert.Same(expected, selected.Function)
        Assert.True(expected.IsSuspending)
        Assert.Same(
            if chained {
                TypeSymbol.String
            } else {
                expected.Type
            },
            completion.Type
        )
        let token = TokenAt(content, source, "Values(ch)", 0)
        Assert.Same(expected, BoundSemantics.GetSymbol(compilation, token))
        Assert.Same(expected, SemanticLookup.ResolveSymbol(compilation, token))
        let expression = Assert.IsType[CallExpressionSyntax](token.Parent)
        Assert.Equal(
            if chained {
                typeof(string)
            } else {
                typeof([]string)
            },
            BoundSemantics.GetExpressionType(compilation, expression)?.ClrType
        )
        let uri = DocumentUri.From("file:///issue5035-inferred-callee.gs")!!
        let position = LanguageServerTestHelpers.PositionOf(source, "Values(ch)")
        let definition = Assert.IsType[Location](DefinitionComputer.ComputeDefinition(uri, content, position))
        let declaration = LanguageServerTestHelpers.PositionOf(source, "Values(ch in chan[string])")
        Assert.Equal(uri, definition.Uri)
        AssertPosition(declaration, definition.Range.Start)
        AssertPosition(Position(declaration.Line, declaration.Character + "Values".Length), definition.Range.End)
        let declaredHover = Assert.IsType[Hover](HoverComputer.ComputeHover(content, declaration))
        AssertIndexedHover(content, position, "Values", declaredHover.Contents.ToString().Split('\n')[1])
        if chained {
            let method = typeof(string).GetMethod("ToString", Type.EmptyTypes)
            Assert.Equal(
                method,
                BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, TokenAt(content, source, "ToString()[^1]", 0)))
            )
            AssertIndexedHover(
                content,
                LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]"),
                "ToString",
                "func (string) ToString() string"
            )
            Assert.Contains(
                CompletionComputer.ComputeCompletions(
                    content,
                    LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]")
                ),
                (item CompletionItem) -> item.Label == "Substring"
            )
        }
        let authored = Assert.IsType[AwaitExpressionSyntax](
            Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "authored =", 0).Parent).Initializer
        )
        Assert.Equal(typeof(string), BoundSemantics.GetExpressionType(compilation, authored)?.ClrType)
        Assert.Equal(
            typeof(System.Threading.Tasks.Task[string]),
            Assert
                .IsType[BoundAwaitExpression](compilation.GetSemanticModel(content.SyntaxTree).GetBoundNode(authored))
                .Expression
                .Type
                .ClrType
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Issue5035_SharedAutoProperty_RemainsCanonicalInsideDeclaringType(sharedMethod bool) {
        let source = if sharedMethod {
            `package Repro
class Holder {
    shared {
        prop Value int32 { get; set; }
        func Run() {
            let competing = System.Text.StringBuilder().ToString()
            let indexed = Holder.Value.ToString()[^1]
        }
    }
}
`
        } else {
            `package Repro
class Holder {
    shared { prop Value int32 { get; set; } }
    func Run() {
        let competing = System.Text.StringBuilder().ToString()
        let indexed = Holder.Value.ToString()[^1]
    }
}
`
        }
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let owner = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Holder")
        let property = owner.StaticProperties.Single((p PropertySymbol) -> p.Name == "Value")
        let expression = Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "indexed =", 0).Parent)
            .Initializer
        let plan = Assert.IsType[BoundBlockExpression](
            compilation.GetSemanticModel(content.SyntaxTree).GetBoundNode(expression!!)
        )
        let call = Assert.IsType[BoundImportedInstanceCallExpression](
            Assert.IsType[BoundVariableDeclaration](plan.Statements[0]).Initializer
        )
        let selected = Assert.IsType[BoundPropertyAccessExpression](call.Receiver)
        Assert.Same(property, selected.Property)
        Assert.Same(owner, selected.StructType)
        Assert.NotNull(property.BackingField)
        Assert.DoesNotContain(owner.Properties, (p PropertySymbol) -> object.ReferenceEquals(p, property))
        Assert.Null(property.GetterSymbol)
        let method = typeof(int32).GetMethod("ToString", Type.EmptyTypes)
        Assert.Equal(
            method,
            BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, TokenAt(content, source, "ToString()[^1]", 0)))
        )
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]"),
            "ToString",
            "func (int32) ToString() string"
        )
        let token = TokenAt(content, source, "Value.ToString()[^1]", 0)
        Assert.Same(property, BoundSemantics.GetSymbol(compilation, token))
        Assert.Equal(
            typeof(int32),
            BoundSemantics.GetExpressionType(compilation, Assert.IsType[NameExpressionSyntax](token.Parent))?.ClrType
        )
        let uri = DocumentUri.From("file:///issue5035-shared-auto.gs")!!
        let location = Assert.IsType[Location](
            DefinitionComputer.ComputeDefinition(
                uri,
                content,
                LanguageServerTestHelpers.PositionOf(source, "Value.ToString()[^1]")
            )
        )
        let declaration = LanguageServerTestHelpers.PositionOf(source, "Value int32")
        Assert.Equal(uri, location.Uri)
        AssertPosition(declaration, location.Range.Start)
        AssertPosition(Position(declaration.Line, declaration.Character + "Value".Length), location.Range.End)
    }

    @Fact
    func Issue5035_ConstructorPrefix_PreservesExactRuntimeBoundary() {
        const source = `package Repro
func Run() {
    let competing = System.Text.StringBuilder().ToString()
    let indexed = System.Uri("https://example.test/path").ToString()[^1]
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let method = typeof(Uri).GetMethod("ToString", Type.EmptyTypes)
        let token = TokenAt(content, source, "ToString()[^1]", 0)
        Assert.Equal(method, BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, token)))
        Assert.True(
            MemberTokenResolver.TryResolveImportedMember(content.SyntaxTree, compilation, token, out var actual)
        )
        Assert.Equal(method, actual)
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]"),
            "ToString",
            "func (System.Uri) ToString() string"
        )
    }

    @Fact
    func Issue5035_EnumPrefix_PreservesActualMemberAndSelectedMethod() {
        const source = `package Repro
enum Color { Red, Green }
enum Other { Red, Green }
func Run() {
    let competing = System.Text.StringBuilder().ToString()
    let plain = Color.Green.ToString()
    let indexed = Color.Green.ToString()[^1]
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let root = Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "plain =", 0).Parent).Initializer
        let plain = Assert.IsType[BoundImportedInstanceCallExpression](
            compilation.GetSemanticModel(content.SyntaxTree).GetBoundNode(root!!)
        )
        let expected = plain.Method
        Assert.Equal(expected, BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, TokenAt(content, source, "ToString()", 1))))
        Assert.Equal(
            expected,
            BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, TokenAt(content, source, "ToString()[^1]", 0)))
        )
        let plainHover = Assert.IsType[Hover](
            HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "ToString()", 1))
        )
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]"),
            "ToString",
            plainHover.Contents.ToString().Split('\n')[1]
        )
        let owner = compilation.GlobalScope.Enums.Single((e EnumSymbol) -> e.Name == "Color")
        Assert.True(owner.TryGetMember("Green", out var member))
        Assert.Same(member, BoundSemantics.GetSymbol(compilation, TokenAt(content, source, "Green.ToString()[^1]", 0)))
        let uri = DocumentUri.From("file:///issue5035-enum-prefix.gs")!!
        let location = Assert.IsType[Location](
            DefinitionComputer.ComputeDefinition(
                uri,
                content,
                LanguageServerTestHelpers.PositionOf(source, "Green.ToString()[^1]")
            )
        )
        let declaration = LanguageServerTestHelpers.PositionOf(source, "Green }", 0)
        Assert.Equal(uri, location.Uri)
        AssertPosition(declaration, location.Range.Start)
        AssertPosition(Position(declaration.Line, declaration.Character + "Green".Length), location.Range.End)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Issue5035_InheritedImportedConstraint_PreservesClosedSlot(generic bool) {
        let root = Path.Combine(Directory.GetCurrentDirectory(), "issue5035-inherited-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        try {
            let assemblyPath = Path.Combine(root, "StaticContracts.dll")
            EmitClrFixture(
                assemblyPath,
                if generic {
                    "#nullable enable\nnamespace StaticContracts { public interface IBase<U> { static abstract string Make(); } public interface IDerived<U> : IBase<U> { } }"
                } else {
                    "#nullable enable\nnamespace StaticContracts { public interface IBase { static abstract string Make(); } public interface IDerived : IBase { } }"
                }
            )
            let source = `package Repro
func Run[T StaticContracts.IDerivedTYPE_ARGUMENTS]() {
    let competing = System.Text.StringBuilder().ToString()
    let plain = T.Make().ToString()
    let indexed = T.Make().ToString()[^1]
}
`.Replace(
                "TYPE_ARGUMENTS",
                if generic {
                    "[int32?]"
                } else {
                    ""
                }
            )
            let path = Path.Combine(root, "Consumer.gs")
            File.WriteAllText(path, source)
            let project = ProjectState(Path.Combine(root, "Consumer.gsproj"))
            project.References = []string{assemblyPath}
            let tree = project.UpdateFile(path, source)
            let content = DocumentContent(
                tree,
                Enumerable.Range(0, source.Length).Where((i int32) -> source[i] == '\n').ToList(),
                project,
                WorkspaceState()
            )
            let compilation = project.GetCompilation()
            Assert.Empty(compilation.GlobalScope.Diagnostics)
            Assert.Empty(compilation.BoundProgram.Diagnostics)
            let expression = Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "indexed =", 0).Parent)
                .Initializer
            let block = Assert.IsType[BoundBlockExpression](
                compilation.GetSemanticModel(tree).GetBoundNode(expression!!)
            )
            let outer = Assert.IsType[BoundImportedInstanceCallExpression](
                Assert.IsType[BoundVariableDeclaration](block.Statements[0]).Initializer
            )
            let selected = Assert.IsType[BoundConstrainedStaticCallExpression](outer.Receiver)
            let original = Assert.IsType[ImportedTypeSymbol](selected.TypeParameter.ClrInterfaceConstraint)
            let declaring = Assert.IsType[ImportedTypeSymbol](selected.ConstrainedInterfaceType)
            Assert.NotSame(original, declaring)
            Assert.Equal(selected.ClrMethod?.DeclaringType, declaring.ClrType)
            if generic {
                Assert.Same(
                    TypeSymbol.Int32,
                    Assert.IsType[NullableTypeSymbol](Assert.Single(declaring.TypeArguments)).UnderlyingType
                )
                Assert.NotEqual(original.OpenDefinition, declaring.OpenDefinition)
            } else {
                Assert.NotEqual(original.ClrType, declaring.ClrType)
            }
            let plainExpression = Assert.IsType[VariableDeclarationSyntax](
                TokenAt(content, source, "plain =", 0).Parent
            )
                .Initializer
            let expected = Assert.IsType[BoundImportedInstanceCallExpression](
                compilation.GetSemanticModel(tree).GetBoundNode(plainExpression!!)
            )
                .Method
            Assert.Equal(expected, outer.Method)
            Assert.Equal(
                expected,
                BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, TokenAt(content, source, "ToString()[^1]", 0)))
            )
            Assert.Equal(
                selected.ClrMethod,
                BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, TokenAt(content, source, "Make()", 0)))
            )
            AssertIndexedHover(
                content,
                LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]"),
                "ToString",
                "func (string) ToString() string"
            )
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Issue5035_SourceConstant_PreservesFoldedFieldIdentity(generic bool) {
        let source = `package Repro
class HolderTYPE_PARAMETERS {
    shared { const Value int32 = 1 }
}
func Run() {
    let competing = System.Text.StringBuilder().ToString()
    let indexed = HolderTYPE_ARGUMENTS.Value.ToString()[^1]
}
`.Replace(
            "TYPE_PARAMETERS",
            if generic {
                "[T]"
            } else {
                ""
            }
        )
            .Replace(
            "TYPE_ARGUMENTS",
            if generic {
                "[int32?]"
            } else {
                ""
            }
        )
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let holder = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Holder")
        let field = holder.ConstFields.Single((f FieldSymbol) -> f.Name == "Value")
        Assert.True(field.IsConst)
        let root = Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "indexed =", 0).Parent).Initializer
        let block = Assert.IsType[BoundBlockExpression](
            compilation.GetSemanticModel(content.SyntaxTree).GetBoundNode(root!!)
        )
        let call = Assert.IsType[BoundImportedInstanceCallExpression](
            Assert.IsType[BoundVariableDeclaration](block.Statements[0]).Initializer
        )
        Assert.Equal(field.ConstantValue, Assert.IsType[BoundLiteralExpression](call.Receiver).Value)
        let method = typeof(int32).GetMethod("ToString", Type.EmptyTypes)
        Assert.Equal(method, call.Method)
        let token = TokenAt(content, source, "ToString()[^1]", 0)
        Assert.Equal(method, BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, token)))
        Assert.True(
            MemberTokenResolver.TryResolveImportedMember(content.SyntaxTree, compilation, token, out var actual)
        )
        Assert.Equal(method, actual)
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]"),
            "ToString",
            "func (int32) ToString() string"
        )
        Assert.Same(field, BoundSemantics.GetSymbol(compilation, TokenAt(content, source, "Value.ToString", 0)))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Issue5035_ConstrainedStatic_PreservesSelectedSlotAndCopy(loweredArgument bool) {
        let source = if loweredArgument {
            `package Repro
interface IFactory[U] { shared { func Make(value int32) string; } }
class Holder {
    prop Value int32 { get; set; }
    func Run[T IFactory[int32?]]() {
        let competing = System.Text.StringBuilder().ToString()
        let indexed = T.Make(this.Value).ToString()[^1]
    }
}
`
        } else {
            `package Repro
interface IFactory { shared { func Make() string; } }
func Run[T IFactory]() {
    let competing = System.Text.StringBuilder().ToString()
    let indexed = T.Make().ToString()[^1]
}
`
        }
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let root = Assert.IsType[VariableDeclarationSyntax](TokenAt(content, source, "indexed =", 0).Parent).Initializer
        let block = Assert.IsType[BoundBlockExpression](
            compilation.GetSemanticModel(content.SyntaxTree).GetBoundNode(root!!)
        )
        let call = Assert.IsType[BoundImportedInstanceCallExpression](
            Assert.IsType[BoundVariableDeclaration](block.Statements[0]).Initializer
        )
        let constrained = Assert.IsType[BoundConstrainedStaticCallExpression](call.Receiver)
        let owner = Assert.IsType[InterfaceSymbol](constrained.TypeParameter.InterfaceConstraint)
        let slot = owner.StaticMethods.Single((m FunctionSymbol) -> m.Name == "Make")
        Assert.Same(slot, constrained.InterfaceMethod)
        if loweredArgument {
            Assert.IsType[BoundFieldAccessExpression](Assert.Single(constrained.Arguments))
            Assert.Same(
                TypeSymbol.Int32,
                Assert.IsType[NullableTypeSymbol](Assert.Single(owner.TypeArguments)).UnderlyingType
            )
        }
        let method = typeof(string).GetMethod("ToString", Type.EmptyTypes)
        Assert.Equal(method, call.Method)
        let token = TokenAt(content, source, "ToString()[^1]", 0)
        Assert.Equal(method, BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, token)))
        Assert.True(
            MemberTokenResolver.TryResolveImportedMember(content.SyntaxTree, compilation, token, out var actual)
        )
        Assert.Equal(method, actual)
        AssertIndexedHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "ToString()[^1]"),
            "ToString",
            "func (string) ToString() string"
        )
        let member = TokenAt(
            content,
            source,
            if loweredArgument {
                "Make(this.Value)"
            } else {
                "Make().ToString"
            },
            0
        )
        Assert.Same(slot, BoundSemantics.GetSymbol(compilation, member))
        let uri = DocumentUri.From("file:///issue5035-constrained-slot.gs")!!
        let position = LanguageServerTestHelpers.PositionOf(
            source,
            if loweredArgument {
                "Make(this.Value)"
            } else {
                "Make().ToString"
            }
        )
        let location = Assert.IsType[Location](DefinitionComputer.ComputeDefinition(uri, content, position))
        let declaration = LanguageServerTestHelpers.PositionOf(
            source,
            if loweredArgument {
                "Make(value int32)"
            } else {
                "Make() string"
            }
        )
        Assert.Equal(uri, location.Uri)
        AssertPosition(declaration, location.Range.Start)
        AssertPosition(Position(declaration.Line, declaration.Character + "Make".Length), location.Range.End)
    }

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
        Assert.Equal(method, BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, token)))
        Assert.True(
            MemberTokenResolver.TryResolveImportedMember(content.SyntaxTree, compilation, token, out var actual)
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
            BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, token))
        )
        Assert.Equal(declaringType, imported.DeclaringType)
        Assert.True(
            MemberTokenResolver.TryResolveImportedMember(content.SyntaxTree, compilation, token, out var navigation)
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
                BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, token))
            )
            Assert.Equal(declaringType.GetProperty("Span"), property)
            AssertIndexedHover(
                content,
                LanguageServerTestHelpers.PositionOf(source, "Span[0]", occurrence),
                "Span",
                signature
            )
            Assert.True(
                MemberTokenResolver.TryResolveImportedMember(
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
            BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, call))
        )
        Assert.Equal(typeof(int32), method.DeclaringType)
        Assert.Equal(typeof(int32), BoundSemantics.GetExpressionType(compilation, indexSyntax)?.ClrType)
    }

    @Theory
    @InlineData(0)
    @InlineData(1)
    @InlineData(2)
    func Issue5035_PropertyAndCompletionReceivers_KeepStringCompletions(mode int32) {
        let receiver = switch mode {
            case 0: "Text"
            case 1: "(this.Text)"
            default: "Make()"
        }
        let source = `package Repro
suspend func Make() string -> "text"
func (value object) Tag() int32 -> 0
class Holder {
    prop Text string { get; set; }
    CALLERfunc Run() {
        scope {
            let first = RECEIVER.Tag()
            let authored = cast[object](RECEIVER).Tag()
        }
    }
}
`.Replace("RECEIVER", receiver).Replace(
            "CALLER",
            if mode == 2 {
                "async "
            } else {
                ""
            }
        )
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        for occurrence in[]int32{1, 2} {
            let accessor = Assert.IsType[AccessorExpressionSyntax](
                TokenAt(content, source, "Tag()", occurrence).Parent?.Parent
            )
            let expected = if occurrence == 1 {
                TypeSymbol.String
            } else {
                TypeSymbol.Object
            }
            Assert.Same(expected, BoundSemantics.GetExpressionType(compilation, accessor.LeftPart))
            let completions = CompletionComputer.ComputeCompletions(
                content,
                LanguageServerTestHelpers.PositionOf(source, "Tag()", occurrence)
            )
            if occurrence == 1 {
                Assert.Contains(completions, (item CompletionItem) -> item.Label == "Substring")
            } else {
                Assert.DoesNotContain(completions, (item CompletionItem) -> item.Label == "Substring")
            }
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Issue5035_LoweredExtensionReceiver_PreservesConversionAndCompletions(authored bool) {
        let source = `package Repro
func Make(value int32) string -> "text"
func (value object) Tag() int32 -> 0
class Holder {
    prop Value int32 { get; set; }
    func Run() {
        let plain = Make(1).Tag()
        let lowered = RECEIVER.Tag()
    }
}
`.Replace(
            "RECEIVER",
            if authored {
                "cast[object](Make(this.Value))"
            } else {
                "Make(this.Value)"
            }
        )
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let model = compilation.GetSemanticModel(content.SyntaxTree)
        let plain = Assert.IsType[AccessorExpressionSyntax](TokenAt(content, source, "Tag()", 1).Parent?.Parent)
        Assert.Same(TypeSymbol.String, BoundSemantics.GetExpressionType(compilation, plain.LeftPart))
        Assert.Contains(
            CompletionComputer.ComputeCompletions(content, LanguageServerTestHelpers.PositionOf(source, "Tag()", 1)),
            (item CompletionItem) -> item.Label == "Substring"
        )
        let accessor = Assert.IsType[AccessorExpressionSyntax](TokenAt(content, source, "Tag()", 2).Parent?.Parent)
        let call = Assert.IsType[BoundCallExpression](model.GetBoundNode(accessor))
        let converted = Assert.IsType[BoundConversionExpression](call.Arguments[0])
        let selected = Assert.IsType[BoundCallExpression](converted.Expression)
        let owner = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Holder")
        Assert.Same(
            owner.Properties.Single((p PropertySymbol) -> p.Name == "Value").BackingField,
            Assert.IsType[BoundFieldAccessExpression](selected.Arguments[0]).Field
        )
        Assert.Same(accessor.RightPart, call.Syntax)
        Assert.NotSame(call.Syntax, selected.Syntax)
        Assert.Same(TypeSymbol.String, model.GetTypeInfo(selected.Syntax!!).Type)
        Assert.Same(selected.Function, model.GetSymbolInfo(selected.Syntax!!).Symbol)
        let expected = if authored {
            TypeSymbol.Object
        } else {
            TypeSymbol.String
        }
        Assert.Same(expected, BoundSemantics.GetExpressionType(compilation, accessor.LeftPart))
        let items = CompletionComputer.ComputeCompletions(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Tag()", 2)
        )
        if authored {
            Assert.Same(TypeSymbol.Object, model.GetTypeInfo(accessor.LeftPart).Type)
            Assert.DoesNotContain(items, (item CompletionItem) -> item.Label == "Substring")
        } else {
            Assert.Same(accessor.LeftPart, selected.Syntax)
            Assert.Contains(
                items,
                (item CompletionItem) -> item.Label == "Substring" && item.Kind == CompletionItemKind.Method
            )
        }
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
        Assert.Equal(method, BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, token)))
        Assert.True(
            MemberTokenResolver.TryResolveImportedMember(content.SyntaxTree, compilation, token, out var metadata)
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
        Assert.Equal(method, BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, outerToken)))
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
        Assert.Equal(method, BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, token)))
        Assert.True(
            MemberTokenResolver.TryResolveImportedMember(content.SyntaxTree, compilation, token, out var navigation)
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
        Assert.Equal(field, BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, TokenAt(content, source, "Zero.ToString", 0))))
        let method = typeof(decimal).GetMethod("ToString", Type.EmptyTypes)
        let token = TokenAt(content, source, "ToString()[^1]", 0)
        Assert.Equal(method, BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, token)))
        Assert.True(
            MemberTokenResolver.TryResolveImportedMember(content.SyntaxTree, compilation, token, out var navigation)
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
        let actual = BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, token))
        Assert.Equal(expected, actual)
        Assert.Equal(owner, actual?.DeclaringType)
        Assert.True(
            MemberTokenResolver.TryResolveImportedMember(content.SyntaxTree, compilation, token, out var navigation)
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
        private func EmitClrFixture(assemblyPath string, source string, references([]string)? = nil) {
            let fixture = CSharpCompilation.Create(
                Path.GetFileNameWithoutExtension(assemblyPath),
                []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                (references ?? []string{})
                    .Prepend(typeof(object).Assembly.Location)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .Select((path string) -> Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(path)),
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
