// <copyright file="Adr0169SemanticModelTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Linq
import System.Threading.Tasks
import Xunit

/// Covers the ADR-0169 (cref:SemanticModel) (syntax→symbol,
/// syntax→bound-node, syntax→type queries), (cref:Symbol.DeclaringSyntaxNodes),
/// and (cref:GSharpSyntaxWalker).
open class Adr0169SemanticModelTests {
    @Fact
    func AuthoredBlockingWait_InAsyncCaller_RemainsTheSelectedRuntimeCall() {
        const source = `package Query
class Holder {
    shared {
        func Value(value string) string -> "decoy"
        suspend func Value(value int32) string -> "fixture"
    }
}
let completed = Holder.Value(1)[^1]
async func Run() {
    let authored = Gsharp.Concurrency.Blocking.Wait[string](
        System.Threading.Tasks.ValueTask[string]("authored"))
}
`
        let (_, model, tree) = CreateQualifierModel(source)
        let root = QualifierInitializer(tree, "completed")
        let member = Assert.IsType[CallExpressionSyntax](Assert.IsType[IndexExpressionSyntax](root.RightPart).Target)
        Assert.True(model.TryGetStaticTypeQualifier(root, member, out var owner, out var qualifier, out var selected))
        let original = Assert.IsType[BoundCallExpression](selected)
        Assert.Same(root.LeftPart, qualifier)
        Assert.Same(
            Assert
                .IsType[StructSymbol](owner)
                .StaticMethods
                .Single((f FunctionSymbol) -> f.Name == "Value" && f.IsSuspending),
            original.Function
        )
        Assert.Same(owner, original.StaticQualifierType)
        let plan = Assert.IsType[BoundBlockExpression](model.GetBoundNode(root))
        let bridge = Assert.IsType[BoundImportedCallExpression](
            Assert.IsType[BoundVariableDeclaration](plan.Statements[0]).Initializer
        )
        Assert.Same(original, Assert.Single(bridge.Arguments))
        let syntax = tree
            .Root
            .DescendantNodes()
            .OfType[CallExpressionSyntax]()
            .Single((c CallExpressionSyntax) -> c.Identifier.Text == "Wait")
        let call = Assert.IsType[BoundImportedCallExpression](model.GetBoundNode(syntax))
        Assert.Same(call.Function, model.GetSymbolInfo(syntax).Symbol)
        Assert.Equal("Gsharp.Concurrency.Blocking", call.Function.Method.DeclaringType?.FullName)
        Assert.Same(TypeSymbol.String, call.Type)
    }

    @Theory
    @InlineData(0)
    @InlineData(1)
    @InlineData(2)
    func ImplicitNamedMember_PreservesAnchorAcrossSelectionAndNarrowing(mode int32) {
        let source = `package Query
class Box {
    SHARED_OPEN
    DECLARATION
    func Run() {
        GUARD_OPEN
        let first = Address.ToString()
        GUARD_CLOSE
    }
    SHARED_CLOSE
}
`.Replace(
            "DECLARATION",
            if mode == 0 {
                "prop Address System.Uri? { get; }"
            } else if mode == 1 {
                "var Address System.Uri = System.Uri(\"https://example.test/path\")"
            } else {
                "prop Address System.Uri -> System.Uri(\"https://example.test/path\")"
            }
        ).Replace(
            "SHARED_OPEN",
            if mode > 0 {
                "shared {"
            } else {
                ""
            }
        ).Replace(
            "SHARED_CLOSE",
            if mode > 0 {
                "}"
            } else {
                ""
            }
        ).Replace(
            "GUARD_OPEN",
            if mode == 0 {
                "if Address != nil {"
            } else {
                ""
            }
        ).Replace(
            "GUARD_CLOSE",
            if mode == 0 {
                "}"
            } else {
                ""
            }
        )
        let (_, model, tree) = CreateQualifierModel(source)
        let root = QualifierInitializer(tree, "first")
        let call = Assert.IsType[BoundImportedInstanceCallExpression](model.GetBoundNode(root))
        Assert.Same(root.LeftPart, call.Receiver.Syntax)
        Assert.Same(call.Receiver, model.GetBoundNode(root.LeftPart))
        Assert.False(call.Receiver.Type is NullableTypeSymbol)
        Assert.Equal(typeof(System.Uri), call.Receiver.Type.ClrType)
    }

    @Fact
    func InstancePropertyLowering_KeepsClosedLogicalTypeAndFollowingReadAnchor() {
        const source = `package Query
class Box[T] {
    prop Items []T { get; set; }
    func Run(other Box[string]) {
        let first = other.Items[0].Length
    }
}
`
        let (_, model, tree) = CreateQualifierModel(source)
        let root = QualifierInitializer(tree, "first")
        let following = Assert.IsType[BoundClrPropertyAccessExpression](model.GetBoundNode(root))
        Assert.Same(root, following.Syntax)
        Assert.Equal(typeof(string).GetProperty("Length"), following.Member)
        let index = Assert.IsType[BoundIndexExpression](following.Receiver)
        let physical = Assert.IsType[BoundFieldAccessExpression](index.Target)
        let owner = Assert.IsType[StructSymbol](physical.StructType)
        let property = owner.Properties.Single((p PropertySymbol) -> p.Name == "Items")
        Assert.Same(TypeSymbol.String, Assert.Single(owner.TypeArguments))
        Assert.Same(property.BackingField, physical.Field)
        Assert.Same(property.Type, physical.Type)
        Assert.NotSame(physical.Field.Type, physical.Type)
        Assert.Same(following, model.GetBoundNode(root))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImplicitFieldRead_RetainsOriginalNameAnchorThroughNarrowing(narrowed bool) {
        let source = `package Query
class Box {
    FIELD_KIND Address System.UriNULLABLE = System.Uri("https://example.test/path")
    func Run() {
        GUARD_OPEN
        let first = Address.ToString()
        GUARD_CLOSE
    }
}
`.Replace(
            "NULLABLE",
            if narrowed {
                "?"
            } else {
                ""
            }
        ).Replace(
            "FIELD_KIND",
            if narrowed {
                "let"
            } else {
                "var"
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
        let (_, model, tree) = CreateQualifierModel(source)
        let root = QualifierInitializer(tree, "first")
        let call = Assert.IsType[BoundImportedInstanceCallExpression](model.GetBoundNode(root))
        let field = Assert.IsType[BoundFieldAccessExpression](call.Receiver)
        Assert.Same(root.LeftPart, field.Syntax)
        Assert.Same(field, model.GetBoundNode(root.LeftPart))
        Assert.Equal(narrowed, field.Field.Type is NullableTypeSymbol)
        Assert.False(field.Type is NullableTypeSymbol)
        let copy = Assert.IsType[BoundFieldAccessExpression](FieldReceiverCopyRewriter().Apply(field))
        Assert.NotSame(field, copy)
        Assert.Same(field.Syntax, copy.Syntax)
        Assert.Same(field.Field, copy.Field)
        Assert.Same(field.NarrowedType, copy.NarrowedType)
        Assert.Same(field, model.GetBoundNode(root.LeftPart))
    }

    private class FieldReceiverCopyRewriter : BoundTreeRewriter {
        func Apply(node BoundExpression) BoundExpression -> RewriteExpression(node)

        protected override func RewriteVariableExpression(node BoundVariableExpression) BoundExpression ->
        BoundVariableExpression(node.Syntax, node.Variable, node.NarrowedType)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func StaticQualifierQuery_DeclaredSuspension_MarksOnlyImplicitCompletion(asyncCaller bool) {
        let source = `package Query
class Box {
    shared {
        suspend func Values(ch in chan[string]) string { return <-ch }
    }
}
CALLER func Run(ch chan[string]) {
    let first = Box.Values(ch)
    let authored = await System.Threading.Tasks.Task.FromResult("authored")
}
`.Replace(
            "CALLER",
            if asyncCaller {
                "async"
            } else {
                "suspend"
            }
        )
        let (_, model, tree) = CreateQualifierModel(source)
        let root = QualifierInitializer(tree, "first")
        let (_, _, selected) = QueryQualifier(model, root)
        let call = Assert.IsType[BoundCallExpression](selected)
        Assert.True(call.Function.IsSuspending)
        let completion = Assert.IsType[BoundAwaitExpression](model.GetBoundNode(root))
        Assert.Same(call, completion.Expression)
        Assert.Same(call, completion.ImplicitCompletionOperand)
        Assert.Same(TypeSymbol.String, completion.Type)
        Assert.NotSame(completion.Type, call.Type)
        let authoredSyntax = tree
            .Root
            .DescendantNodes()
            .OfType[VariableDeclarationSyntax]()
            .Single((v VariableDeclarationSyntax) -> v.Identifier.Text == "authored")
            .Initializer
        let authored = Assert.IsType[BoundAwaitExpression](model.GetBoundNode(authoredSyntax!!))
        Assert.Null(authored.ImplicitCompletionOperand)
        let copied = Assert.IsType[BoundAwaitExpression](QualifierChildRewriter().Apply(completion))
        Assert.Same(copied.Expression, copied.ImplicitCompletionOperand)
        Assert.Same(call, completion.ImplicitCompletionOperand)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func StaticQualifierQuery_ImplicitCompletionAndSharedProperty_KeepSemanticSelection(property bool) {
        let source = if property {
            `package Query
class Box {
    shared {
        prop Value int32 { get; set; }
        prop Other int32 { get; set; }
    }
    func Run() { let first = Box.Value }
}
`
        } else {
            `package Query
class Box {
    shared {
        func Values(ch in chan[string]) []string {
            let value = <-ch
            return []string{value}
        }
    }
}
func Run(ch chan[string]) { let first = Box.Values(ch) }
`
        }
        let (_, model, tree) = CreateQualifierModel(source)
        let root = QualifierInitializer(tree, "first")
        let (owner, qualifier, read) = QueryQualifier(model, root)
        let box = Assert.IsType[StructSymbol](owner)
        if property {
            let expected = box.StaticProperties.Single((p PropertySymbol) -> p.Name == "Value")
            let selected = Assert.IsType[BoundPropertyAccessExpression](read)
            Assert.Same(expected, selected.Property)
            Assert.Same(box, selected.StructType)
            Assert.NotNull(expected.BackingField)
            Assert.DoesNotContain(box.Properties, (p PropertySymbol) -> object.ReferenceEquals(p, expected))
        } else {
            let physical = Assert.IsType[BoundCallExpression](read)
            Assert.True(physical.Function.IsSuspending)
            Assert.Same(box.StaticMethods.Single((f FunctionSymbol) -> f.Name == "Values"), physical.Function)
            let logical = Assert.IsType[BoundAwaitExpression](model.GetBoundNode(root))
            Assert.Same(physical, logical.Expression)
            Assert.NotSame(physical.Type, logical.Type)
            Assert.Equal(typeof([]string), logical.Type.ClrType)
            let authored = BoundAwaitExpression(logical.Syntax, physical, logical.Type)
            physical.CopyStaticQualifierTo(authored)
            Assert.Null(authored.StaticQualifierType)
        }
        Assert.Same(root.LeftPart, qualifier)
        let (_, _, unchanged) = QueryQualifier(model, root)
        Assert.Same(read, unchanged)
    }

    @Fact
    func StaticQualifierQuery_EnumMembers_KeepDistinctEqualValuedDecisions() {
        const source = `package Query
enum First { Item }
enum Second { Item }
func Run() {
    let first = First.Item
    let second = Second.Item
}
`
        let (_, model, tree) = CreateQualifierModel(source)
        let root = QualifierInitializer(tree, "first")
        let (owner, qualifier, read) = QueryQualifier(model, root)
        let (otherOwner, _, otherRead) = QueryQualifier(model, QualifierInitializer(tree, "second"))
        let literal = Assert.IsType[BoundLiteralExpression](read)
        let other = Assert.IsType[BoundLiteralExpression](otherRead)
        Assert.Equal(literal.Value, other.Value)
        Assert.NotSame(owner, otherOwner)
        Assert.Same(owner, literal.Type)
        Assert.Same(otherOwner, other.Type)
        Assert.NotSame(read.StaticMemberSyntax, other.StaticMemberSyntax)
        let authored = BoundLiteralExpression(literal.Syntax, literal.Value, literal.Type)
        literal.CopyStaticQualifierTo(authored)
        Assert.Null(authored.StaticQualifierType)
        Assert.Same(root.LeftPart, qualifier)
        let (_, _, unchanged) = QueryQualifier(model, root)
        Assert.Same(read, unchanged)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func StaticQualifierQuery_FoldedFieldsAndConstrainedCopies_RetainActualDecision(constrained bool) {
        let source = if constrained {
            `package Query
interface IFactory[U] { shared { func Make(value int32) string; } }
func Run[T IFactory[int32?]]() { let first = T.Make(1) }
func Other[T IFactory[int32?]]() { let second = T.Make(2) }
`
        } else {
            `package Query
class Box[T] {
    shared {
        const Value int32 = 1
        const Other int32 = 1
    }
}
func Run() {
    let first = Box[int32?].Value
    let second = Box[int32?].Other
}
`
        }
        let (_, model, tree) = CreateQualifierModel(source)
        let first = QualifierInitializer(tree, "first")
        let (owner, qualifier, read) = QueryQualifier(model, first)
        let (_, _, other) = QueryQualifier(model, QualifierInitializer(tree, "second"))
        Assert.Same(first.LeftPart, qualifier)
        if constrained {
            let call = Assert.IsType[BoundConstrainedStaticCallExpression](read)
            Assert.Same(owner, call.TypeParameter)
            let contract = Assert.IsType[InterfaceSymbol](call.TypeParameter.InterfaceConstraint)
            Assert.Same(contract.StaticMethods.Single((m FunctionSymbol) -> m.Name == "Make"), call.InterfaceMethod)
            Assert.Same(
                TypeSymbol.Int32,
                Assert.IsType[NullableTypeSymbol](Assert.Single(contract.TypeArguments)).UnderlyingType
            )
            let copied = Assert.IsType[BoundConstrainedStaticCallExpression](QualifierChildRewriter().Apply(read))
            Assert.NotSame(read, copied)
            Assert.Same(owner, copied.StaticQualifierType)
            Assert.Same(qualifier, copied.StaticQualifierSyntax)
            Assert.Same(read.StaticMemberSyntax, copied.StaticMemberSyntax)
            Assert.Same(call.InterfaceMethod, copied.InterfaceMethod)
            Assert.Same(call.TypeParameter, copied.TypeParameter)
            let unrelated = BoundConstrainedStaticCallExpression(
                read.Syntax,
                Assert.IsType[BoundConstrainedStaticCallExpression](other).TypeParameter,
                call.InterfaceMethod!!,
                call.Arguments,
                call.ReturnType
            )
            read.CopyStaticQualifierTo(unrelated)
            Assert.Null(unrelated.StaticQualifierType)
        } else {
            let literal = Assert.IsType[BoundLiteralExpression](read)
            Assert.Equal(literal.Value, Assert.IsType[BoundLiteralExpression](other).Value)
            Assert.NotSame(read, other)
            Assert.NotSame(read.StaticMemberSyntax, other.StaticMemberSyntax)
            let closed = Assert.IsType[StructSymbol](owner)
            Assert.Same(
                TypeSymbol.Int32,
                Assert.IsType[NullableTypeSymbol](Assert.Single(closed.TypeArguments)).UnderlyingType
            )
            let unrelated = BoundLiteralExpression(other.Syntax, literal.Value, literal.Type)
            read.CopyStaticQualifierTo(unrelated)
            Assert.Null(unrelated.StaticQualifierType)
        }
        let (_, _, unchanged) = QueryQualifier(model, first)
        Assert.Same(read, unchanged)
    }

    @Theory
    @InlineData(false, true, true)
    @InlineData(true, true, true)
    @InlineData(false, false, true)
    @InlineData(false, true, false)
    func StaticQualifierRewrite_PreservesOnlyTheSameSelectedRead(imported bool, sameMember bool, sameSyntax bool) {
        let source = `package Query
import M = System.Math
class Box[T] {
    shared {
        func Pick[U](value U) string -> "first"
        func Other(value int32) string -> "second"
    }
}
func Run() {
    let first = FIRST
    let second = SECOND
}
`.Replace(
            "FIRST",
            if imported {
                "M.Abs(1)"
            } else {
                "Box[int32?].Pick[int32](1)"
            }
        )
            .Replace(
            "SECOND",
            if imported {
                "M.Sign(1)"
            } else {
                "Box[int32?].Other(1)"
            }
        )
        let (_, model, tree) = CreateQualifierModel(source)
        let (_, qualifier, read) = QueryQualifier(model, QualifierInitializer(tree, "first"))
        let (_, _, other) = QueryQualifier(model, QualifierInitializer(tree, "second"))
        let syntax = if sameSyntax {
            read.Syntax
        } else {
            other.Syntax
        }
        var replacement BoundExpression
        if read is BoundCallExpression call {
            Assert.Same(TypeSymbol.Int32, Assert.Single(call.MethodTypeArguments))
            Assert.Same(
                TypeSymbol.Int32,
                Assert.IsType[NullableTypeSymbol](Assert.Single(call.StaticGenericOwnerType!!.TypeArguments))
                    .UnderlyingType
            )
            replacement = BoundCallExpression(
                syntax,
                if sameMember {
                    call.Function
                } else {
                    Assert.IsType[BoundCallExpression](other).Function
                },
                call.Arguments,
                call.ReturnType,
                call.IsConditionalElided
            ){
                StaticGenericOwnerType = call.StaticGenericOwnerType,
                StaticGenericInterfaceOwnerType = call.StaticGenericInterfaceOwnerType,
                MethodTypeArguments = call.MethodTypeArguments
            }
        } else {
            let call = Assert.IsType[BoundImportedCallExpression](read)
            replacement = BoundImportedCallExpression(
                syntax,
                if sameMember {
                    call.Function
                } else {
                    Assert.IsType[BoundImportedCallExpression](other).Function
                },
                call.Arguments,
                call.ArgumentRefKinds,
                call.TypeArgumentSymbols,
                call.StaticContainerType
            )
        }
        let result = if sameMember && sameSyntax {
            QualifierChildRewriter().Apply(read)
        } else {
            QualifierReplacementRewriter(replacement).Apply(read)
        }
        if sameMember && sameSyntax {
            Assert.NotSame(read, result)
            Assert.Same(read.StaticQualifierType, result.StaticQualifierType)
            Assert.Same(qualifier, result.StaticQualifierSyntax)
            Assert.Same(read.StaticMemberSyntax, result.StaticMemberSyntax)
        } else {
            Assert.Same(replacement, result)
            Assert.Null(result.StaticQualifierType)
            Assert.Null(result.StaticMemberSyntax)
        }
        Assert.Same(qualifier, read.StaticQualifierSyntax)
        let (_, _, unchanged) = QueryQualifier(model, QualifierInitializer(tree, "first"))
        Assert.Same(read, unchanged)
    }

    private class QualifierChildRewriter : BoundTreeRewriter {
        func Apply(node BoundExpression) BoundExpression -> RewriteExpression(node)

        protected override func RewriteLiteralExpression(node BoundLiteralExpression) BoundExpression ->
        BoundLiteralExpression(node.Syntax, node.Value, node.Type)
    }

    private class QualifierReplacementRewriter : BoundTreeRewriter {
        private let replacement BoundExpression

        init(replacement BoundExpression) {
            this.replacement = replacement
        }

        func Apply(node BoundExpression) BoundExpression -> RewriteExpression(node)

        protected override func RewriteCallExpression(node BoundCallExpression) BoundExpression -> replacement

        protected override func RewriteImportedCallExpression(
            node BoundImportedCallExpression
        ) BoundExpression -> replacement
    }

    @Fact
    func StaticQualifierQuery_UsesCanonicalPrimitiveAliasAndClosedOwner() {
        const source = `package Query
import D = System.Decimal
class Box[T] {
    shared {
        prop Items []string -> []string{"one"}
        func Select[U](value U) []string -> []string{"selected"}
    }
}
func Run() {
    let primitive = decimal.Zero
    let alias = D.Zero
    let alternate = byte.MaxValue
    let generic = Box[int32?].Items
    let genericCall = Box[int32?].Select[string]("value")
}
`
        let (compilation, model, tree) = CreateQualifierModel(source)
        for name in[]string{"primitive", "alias", "alternate"} {
            let root = QualifierInitializer(tree, name)
            let (type, qualifier, read) = QueryQualifier(model, root)
            Assert.Same(root.LeftPart, qualifier)
            if read is BoundClrPropertyAccessExpression imported {
                Assert.Equal(imported.Member.DeclaringType, type.ClrType)
            } else {
                Assert.Same(TypeSymbol.UInt8, Assert.IsType[BoundLiteralExpression](read).Type)
            }
            Assert.Equal(
                if name == "alternate" {
                    typeof(byte)
                } else {
                    typeof(decimal)
                },
                type.ClrType
            )
        }
        let genericRoot = QualifierInitializer(tree, "generic")
        let (closedType, syntax, selected) = QueryQualifier(model, genericRoot)
        let property = Assert.IsType[BoundPropertyAccessExpression](selected)
        Assert.Same(property.StructType, closedType)
        Assert.Same(genericRoot.LeftPart, syntax)
        let closed = Assert.IsType[StructSymbol](closedType)
        Assert.Same(
            compilation.GlobalScope.Structs.Single((type StructSymbol) -> type.Name == "Box"),
            closed.Definition
        )
        Assert.Same(
            TypeSymbol.Int32,
            Assert.IsType[NullableTypeSymbol](Assert.Single(closed.TypeArguments)).UnderlyingType
        )
        let (callType, _, callRead) = QueryQualifier(model, QualifierInitializer(tree, "genericCall"))
        let call = Assert.IsType[BoundCallExpression](callRead)
        Assert.Same(callType, call.StaticGenericOwnerType)
        Assert.Same(TypeSymbol.String, Assert.Single(call.MethodTypeArguments))
    }

    @Fact
    func StaticQualifierQuery_PreservesTypeParametersShadowingAndColorColor() {
        const source = `package Query
class Box[T] {
    shared { prop Items []string -> []string{"one"} }
}
class Instance { prop Items []string -> []string{"instance"} }
class Palette {
    func Tag(value string) string -> value
    shared { func Tag(value int32) string -> "static" }
}
func Generic[T]() { let generic = Box[T].Items }
func Shadow(Box []Instance) { let value = Box[0].Items }
func Color(Palette Palette) {
    let staticCall = Palette.Tag(1)
    let instanceCall = Palette.Tag("instance")
}
`
        let (compilation, model, tree) = CreateQualifierModel(source)
        let (type, _, _) = QueryQualifier(model, QualifierInitializer(tree, "generic"))
        let genericFunction = compilation
            .GlobalScope
            .Functions
            .Single((function FunctionSymbol) -> function.Name == "Generic")
        Assert.Same(
            Assert.Single(genericFunction.TypeParameters),
            Assert.Single(Assert.IsType[StructSymbol](type).TypeArguments)
        )
        let shadow = QualifierInitializer(tree, "value")
        Assert.False(model.TryGetStaticTypeQualifier(shadow, shadow.RightPart, out _, out _, out _))
        let staticRoot = QualifierInitializer(tree, "staticCall")
        let (owner, _, selected) = QueryQualifier(model, staticRoot)
        let call = Assert.IsType[BoundCallExpression](selected)
        Assert.True(call.Function.IsStatic)
        Assert.Same(TypeSymbol.Int32, Assert.Single(call.Function.Parameters).Type)
        Assert.Same(call.Function.StaticOwnerType, owner)
        let instanceRoot = QualifierInitializer(tree, "instanceCall")
        Assert.False(model.TryGetStaticTypeQualifier(instanceRoot, instanceRoot.RightPart, out _, out _, out _))
    }

    @Fact
    func StaticQualifierQuery_IsConcurrentReadOnlyAndSnapshotScoped() {
        const source = `package Query
class Box[T] {
    shared { prop Items []string -> []string{"one"} }
}
func Run() { let result = Box[ARGUMENT].Items }
`
        let (oldCompilation, oldModel, oldTree) = CreateQualifierModel(source.Replace("ARGUMENT", "int32"))
        let (_, newModel, newTree) = CreateQualifierModel(source.Replace("ARGUMENT", "int32?"))
        let oldRoot = QualifierInitializer(oldTree, "result")
        let newRoot = QualifierInitializer(newTree, "result")
        let nodes = oldTree.Root.DescendantNodesAndSelf().ToArray()
        let parents = nodes.Select((node SyntaxNode) -> node.Parent).ToArray()
        let program = oldCompilation.BoundProgram
        let (oldType, oldQualifier, oldRead) = QueryQualifier(oldModel, oldRoot)
        let (newType, _, _) = QueryQualifier(newModel, newRoot)
        Parallel.For(
            0,
            16,
            (i int32) -> {
                let (found, qualifier, read) = QueryQualifier(oldModel, oldRoot)
                Assert.Same(oldType, found)
                Assert.Same(oldQualifier, qualifier)
                Assert.Same(oldRead, read)
                Assert.Same(TypeSymbol.Int32, Assert.Single(Assert.IsType[StructSymbol](found).TypeArguments))
                let (current, _, _) = QueryQualifier(newModel, newRoot)
                Assert.Same(newType, current)
                Assert.IsType[NullableTypeSymbol](Assert.Single(Assert.IsType[StructSymbol](current).TypeArguments))
            }
        )
        Assert.Same(program, oldCompilation.BoundProgram)
        Assert.False(newModel.TryGetStaticTypeQualifier(oldRoot, oldRoot.RightPart, out _, out _, out _))
        for var i = 0; i < nodes.Length; i++ {
            Assert.Same(oldTree, nodes[i].SyntaxTree)
            Assert.Same(parents[i], nodes[i].Parent)
        }
    }

    private func CreateQualifierModel(source string)(Compilation, SemanticModel, SyntaxTree) {
        let tree = SyntaxTree.Parse(SourceText.From(source, "qualifier-query.gs"))
        let compilation = Compilation(tree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        return (compilation, compilation.GetSemanticModel(tree), tree)
    }

    private func QualifierInitializer(tree SyntaxTree, name string) AccessorExpressionSyntax ->
    Assert.IsType[AccessorExpressionSyntax](
        tree
            .Root
            .DescendantNodes()
            .OfType[VariableDeclarationSyntax]()
            .Single((declaration VariableDeclarationSyntax) -> declaration.Identifier.Text == name)
            .Initializer
    )

    private func QueryQualifier(model SemanticModel, root AccessorExpressionSyntax)(
        TypeSymbol,
        ExpressionSyntax,
        BoundExpression
    ) {
        Assert.True(
            model.TryGetStaticTypeQualifier(root, root.RightPart, out var type, out var qualifier, out var read)
        )
        return (type, qualifier, read)
    }

    @Fact
    func GetDeclaredSymbol_OnFunctionDeclaration_ReturnsFunctionSymbol() {
        let (model, tree) = CreateModel(Source)
        let declaration = NodesOfType[FunctionDeclarationSyntax](tree).First(
            (f FunctionDeclarationSyntax) -> f.Identifier.Text == "Add"
        )
        let symbol Symbol? = model.GetDeclaredSymbol(declaration)
        let function = Assert.IsType[FunctionSymbol](symbol)
        Assert.Equal("Add", function.Name)
        Assert.Contains(declaration, function.DeclaringSyntaxNodes)
    }

    @Fact
    func GetSymbolInfo_OnCallExpression_ResolvesInvokedFunction() {
        let (model, tree) = CreateModel(Source)
        let call = NodesOfType[CallExpressionSyntax](tree).First((c CallExpressionSyntax) -> c.Identifier.Text == "Add")
        let info = model.GetSymbolInfo(call)
        let function = Assert.IsType[FunctionSymbol](info.Symbol)
        Assert.Equal("Add", function.Name)
    }

    @Fact
    func GetTypeInfo_OnCallExpression_ReturnsInt32() {
        let (model, tree) = CreateModel(Source)
        let call = NodesOfType[CallExpressionSyntax](tree).First((c CallExpressionSyntax) -> c.Identifier.Text == "Add")
        let info = model.GetTypeInfo(call)
        Assert.NotNull(info.Type)
        Assert.Equal("int32", info.Type!!.Name)
    }

    @Fact
    func GetBoundNode_OnStatement_ReturnsBoundCounterpart() {
        let (model, tree) = CreateModel(Source)
        let declaration = NodesOfType[FunctionDeclarationSyntax](tree).First(
            (f FunctionDeclarationSyntax) -> f.Identifier.Text == "Add"
        )
        let call = NodesOfType[CallExpressionSyntax](tree).First((c CallExpressionSyntax) -> c.Identifier.Text == "Add")
        // The binder anchors call expressions; nodes it does not anchor (or
        // tokens) legitimately have no bound counterpart.
        Assert.NotNull(model.GetBoundNode(call))
        Assert.Null(model.GetBoundNode(declaration.Identifier))
    }

    @Fact
    func GetSymbolInfo_OnTheCallNodeOfAQualifiedCall_ResolvesTheInvokedFunction() {
        let (model, tree) = CreateModel(QualifiedCallSource)
        for name in[]string{"Wrap", "Twice", "Bare"} {
            let call = NodesOfType[CallExpressionSyntax](tree).Single(
                (c CallExpressionSyntax) -> c.Identifier.Text == name
            )
            let symbol Symbol? = model.GetSymbolInfo(call).Symbol
            // Each call node resolves to its OWN function: the qualified ones
            // must not collapse onto an enclosing call's symbol.
            let function = Assert.IsType[FunctionSymbol](symbol)
            Assert.Equal(name, function.Name)
            Assert.NotEmpty(function.DeclaringSyntaxNodes)
        }
    }

    @Fact
    func GetTypeInfo_AndGetBoundNode_AgreeOnBothCallShapes() {
        let (model, tree) = CreateModel(QualifiedCallSource)
        let qualified = NodesOfType[CallExpressionSyntax](tree).Single(
            (c CallExpressionSyntax) -> c.Identifier.Text == "Wrap"
        )
        let unqualified = NodesOfType[CallExpressionSyntax](tree).Single(
            (c CallExpressionSyntax) -> c.Identifier.Text == "Bare"
        )
        Assert.NotNull(model.GetBoundNode(qualified))
        Assert.NotNull(model.GetBoundNode(unqualified))
        Assert.Equal("int32", model.GetTypeInfo(qualified).Type?.Name)
        Assert.Equal("int32", model.GetTypeInfo(unqualified).Type?.Name)
        // The qualified call node borrows the answer of the accessor that
        // encloses it, and only of that accessor: the accessor's LEFT part is
        // a different node and keeps its own (absent) answer.
        let accessor = NodesOfType[AccessorExpressionSyntax](tree).Single(
            (a AccessorExpressionSyntax) -> object.ReferenceEquals(a.RightPart, qualified)
        )
        Assert.Same(model.GetBoundNode(accessor), model.GetBoundNode(qualified))
        Assert.Null(model.GetBoundNode(accessor.LeftPart))
    }

    @Fact
    func GetBoundNode_DoesNotInventAnAnswerForUnanchoredNodes() {
        // The guard rail for the qualified-call fallback: it is miss-only and
        // shape-specific, so nodes the binder does not anchor stay unanchored.
        let (model, tree) = CreateModel(QualifiedCallSource)
        for node in AllNodes(tree).OfType[TypeClauseSyntax]() {
            Assert.Null(model.GetBoundNode(node))
        }
        let declaration = NodesOfType[FunctionDeclarationSyntax](tree).First(
            (f FunctionDeclarationSyntax) -> f.Identifier.Text == "Use"
        )
        Assert.Null(model.GetBoundNode(declaration.Identifier))
    }

    @Fact
    func GetSemanticModel_CachesPerTree_AndRejectsForeignTrees() {
        let tree = SyntaxTree.Parse(SourceText.From(Source, "app.gs"))
        let compilation = Compilation(tree)
        let foreign = SyntaxTree.Parse(SourceText.From(Source, "foreign.gs"))
        Assert.Same(compilation.GetSemanticModel(tree), compilation.GetSemanticModel(tree))
        Assert.Throws[ArgumentException](
            func () object? {
                return compilation.GetSemanticModel(foreign)
            }
        )
    }

    @Fact
    func GetDeclaredSymbol_OnLocalDeclaration_ReturnsVariableSymbol() {
        let (model, tree) = CreateModel(Source)
        let declaredSymbols = AllNodes(tree)
            .Select((node SyntaxNode) -> model.GetDeclaredSymbol(node))
            .Where((symbol Symbol) -> symbol is VariableSymbol)
            .Cast[VariableSymbol]()
            .ToList()
        Assert.Contains(declaredSymbols, (v VariableSymbol) -> v.Name == "total")
        Assert.Contains(declaredSymbols, (v VariableSymbol) -> v.Name == "left")
    }

    @Fact
    func SyntaxWalker_VisitsEveryNodeDepthFirst() {
        let tree = SyntaxTree.Parse(SourceText.From(Source, "app.gs"))
        let collector = CollectingWalker()
        collector.Visit(tree.Root)
        Assert.Contains(collector.Nodes, (n SyntaxNode) -> n is CallExpressionSyntax)
        Assert.Contains(collector.Nodes, (n SyntaxNode) -> n is FunctionDeclarationSyntax)
        Assert.True(collector.TokenCount > 0)
        // Depth-first: a function declaration is visited before the call inside it.
        let declarationIndex = collector.Nodes.FindIndex((n SyntaxNode) -> n is FunctionDeclarationSyntax)
        let callIndex = collector.Nodes.FindIndex((n SyntaxNode) -> n is CallExpressionSyntax)
        Assert.True(declarationIndex < callIndex)
    }

    private class CollectingWalker : GSharpSyntaxWalker {
        init() {
            Nodes = List[SyntaxNode]()
        }

        prop Nodes List[SyntaxNode] {
            get;
        }

        prop TokenCount int32 {
            get;
            private set;
        }

        override func Visit(node SyntaxNode) {
            if node != nil && !(node is SyntaxToken) {
                Nodes.Add(node)
            }
            base.Visit(node)
        }

        override func VisitToken(token SyntaxToken) {
            TokenCount++
        }
    }

    shared {
        private const Source string = `package App
import System

func Add(left int32, right int32) int32 {
    return left + right
}

func Main() {
    var total = Add(1, 2)
    Console.WriteLine(total)
}
`

        /// A qualified call and an unqualified call to the same functions, so one
        /// model answers both shapes. G# splits `Form.Wrap(x)` across an
        /// (cref:AccessorExpressionSyntax) (which the binder anchors) and a
        /// nested (cref:CallExpressionSyntax) (which it does not); Roslyn
        /// has a single `InvocationExpressionSyntax` for both shapes, so an
        /// analyzer that walks for call nodes must get the same answer either way
        /// (issue #3822).
        private const QualifiedCallSource string = `package App

class Form {
    shared {
        func Wrap(value int32) int32 {
            return value + 1
        }

        func Twice(value int32) int32 {
            return value * 2
        }
    }
}

func Bare(value int32) int32 {
    return value
}

func Use(value int32) int32 {
    return Form.Twice(Form.Wrap(Bare(value)))
}
`

        private func CreateModel(source string)(Model SemanticModel, Tree SyntaxTree) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "app.gs"))
            let compilation = Compilation(tree)
            Assert.Empty(compilation.GlobalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
            Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
            return (compilation.GetSemanticModel(tree), tree)
        }

        private func NodesOfType[T SyntaxNode](tree SyntaxTree) IEnumerable[T] {
            let collector = CollectingWalker()
            collector.Visit(tree.Root)
            return collector.Nodes.OfType[T]()
        }

        private func AllNodes(tree SyntaxTree) sequence[SyntaxNode] {
            let pending = Stack[SyntaxNode]()
            pending.Push(tree.Root)
            while pending.Count > 0 {
                let node = pending.Pop()
                yield node
                for child in node.GetChildren() {
                    pending.Push(child)
                }
            }
        }
    }
}
