// <copyright file="SemanticModel.Receivers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Threading

/// Receiver-chain queries of (cref:SemanticModel) (ADR-0212 section 7b).
/// @remarks A member-access chain such as `a.B.C()` parses right-nested and the
/// binder anchors only the outermost accessor, to the bound node of the final
/// member. The other segments are reached through that node's receiver chain.
/// Each index adds a target step, not a member step. Index arguments are
/// independent expressions and never form part of that chain. A receiver read
/// carries the variable's flow type, so after `guard let s = store` the
/// receiver `s` is the declared `IStore`, never the type of a value assigned
/// on one branch.
partial class SemanticModel {
    /// Returns the type of [`expression`](paramref) as a receiver in a
    /// member-access chain, after the implicit conversions the binder adds
    /// around the read are removed. Flow narrowing in effect where the
    /// expression is read applies.
    /// @param expression An expression, typically the receiver of a member access.
    /// @param cancellationToken Cancels index construction on first use.
    /// @returns The type; (cref:TypeInfo.Type) is null when the binder has no answer for the expression.
    func GetReceiverTypeInfo(
        expression ExpressionSyntax,
        cancellationToken CancellationToken = default(CancellationToken)
    ) TypeInfo {
        cancellationToken.ThrowIfCancellationRequested()
        index.Get(cancellationToken)
        if !object.ReferenceEquals(expression.SyntaxTree, syntaxTree) {
            return TypeInfo.None
        }
        let anchor SyntaxToken? = switch expression {
            case name is NameExpressionSyntax: name.IdentifierToken
            case call is CallExpressionSyntax: call.Identifier
            default: default(SyntaxToken?)
        }
        let node = FindBoundExpression(expression)
        if node == nil {
            return TypeInfo.None
        }
        // A name or call segment must be the one the binder bound: a mismatch
        // means the chain walk landed on another segment.
        if anchor != nil &&
            Unwrap(node) is {} read &&
            ReferencedSymbol(read) is {} referenced &&
            referenced.Name != anchor.Text {
            return TypeInfo.None
        }
        return TypeInfo(node.Type)
    }

    /// Returns the read or call that [`token`](paramref) names, with the
    /// conversions and nil-unwraps the binder adds around it removed. Callers
    /// use it for the imported CLR member a token bound to, until imported
    /// members have symbols (ADR-0212 slice S4).
    /// @param token An identifier token naming a member or a call.
    /// @param cancellationToken Cancels index construction on first use.
    /// @returns The bound read or call, or null when the binder has no answer for the token.
    func GetReferencedExpression(
        token SyntaxToken,
        cancellationToken CancellationToken = default(CancellationToken)
    ) BoundExpression? {
        cancellationToken.ThrowIfCancellationRequested()
        index.Get(cancellationToken)
        if token.Kind != SyntaxKind.IdentifierToken || token.IsMissing || !object.ReferenceEquals(
            token.SyntaxTree,
            syntaxTree
        ) {
            return nil
        }
        return Unwrap(FindReferencedNode(token))
    }

    shared {
        /// Pairs each identifier token of [`typeClause`](paramref) with the type it names, given the
        /// type the clause denotes. Wrapper types (`T?`, `[]T`, `map[K]V`, ...) pair their inner
        /// clauses with their inner types.
        /// @param typeClause The type clause syntax.
        /// @param type The type the clause denotes.
        /// @returns The token and type pairs, outer clause first.
        internal func GetTypeClauseSymbols(typeClause TypeClauseSyntax?, type TypeSymbol?) ImmutableArray[
            (Token SyntaxToken, Symbol TypeSymbol)
        ] {
            let builder = ImmutableArray.CreateBuilder[(Token SyntaxToken, Symbol TypeSymbol)]()
            CollectTypeClauseSymbols(typeClause, type, builder)
            return builder.ToImmutable()
        }

        private func CollectTypeClauseSymbols(
            typeClause TypeClauseSyntax?,
            type TypeSymbol?,
            builder ImmutableArray[(Token SyntaxToken, Symbol TypeSymbol)].Builder
        ) {
            if typeClause == nil || type == nil {
                return
            }
            let wrappedTypes = if type is ImportedTypeSymbol {
                Array.Empty[TypeSymbol]()
            } else {
                TypeSymbol.GetWrappedTypes(type).ToArray()
            }
            if wrappedTypes.Length > 0 {
                let wrappedClauses = typeClause.GetChildren().OfType[TypeClauseSyntax]().ToArray()
                if typeClause.Identifier != nil || (wrappedTypes.Length == 1 && wrappedClauses.Length != 1) {
                    CollectTypeClauseSymbols(typeClause, wrappedTypes[0], builder)
                    return
                }
                for var i = 0; i < Math.Min(wrappedTypes.Length, wrappedClauses.Length); i++ {
                    CollectTypeClauseSymbols(wrappedClauses[i], wrappedTypes[i], builder)
                }
                return
            }
            let identifier SyntaxToken? = if !typeClause.QualifierIdentifierTokens.IsDefaultOrEmpty {
                typeClause.QualifierIdentifierTokens[^1]
            } else {
                typeClause.Identifier
            }
            if identifier != nil {
                builder.Add((identifier, type))
            }
        }
    }

    /// Gets the expression whose identifier is [`token`](paramref): a name,
    /// or a call's callee name.
    private func ExpressionNamedBy(token SyntaxToken) ExpressionSyntax? {
        return switch token.Parent {
            case name is NameExpressionSyntax when object.ReferenceEquals(name.IdentifierToken, token): name
            case call is CallExpressionSyntax when object.ReferenceEquals(call.Identifier, token): call
            default: default(ExpressionSyntax?)
        }
    }

    private func FindReferencedNode(token SyntaxToken) BoundExpression? {
        // A delegate callee's token names its variable, while its call names Invoke.
        if this.GetBoundNode(token) is BoundExpression named {
            return named
        }
        let expression = ExpressionNamedBy(token)
        return if expression == nil {
            default(BoundExpression?)
        } else {
            FindBoundExpression(expression)
        }
    }

    /// Keeps the original query as provenance while normalizing receiver steps.
    /// Prefers reachable outer flow context and retains inner anchors when an
    /// outer write target or idx cannot supply the queried expression.
    private func FindBoundExpression(expression ExpressionSyntax) BoundExpression? {
        var root ExpressionSyntax = expression
        let anchors = Stack[(Syntax ExpressionSyntax, Node BoundExpression)]()
        while true {
            if GetBoundAnchor(root) is {} anchored {
                anchors.Push((root, anchored))
            }
            let parent = ReceiverParent(root)
            if parent == nil {
                break
            }
            root = parent
        }
        while anchors.Count > 0 {
            let (syntax, node) = anchors.Pop()
            if FindFromAnchor(syntax, node, expression) is {} found {
                return PeelConversions(found, expression)
            }
        }
        return nil
    }

    private func ReceiverParent(expression ExpressionSyntax) ExpressionSyntax? -> switch expression.Parent {
        case accessor is AccessorExpressionSyntax when object.ReferenceEquals(accessor.LeftPart, expression) ||
            object.ReferenceEquals(accessor.RightPart, expression): accessor
        case idx is IndexExpressionSyntax when object.ReferenceEquals(idx.Target, expression): idx
        default: default(ExpressionSyntax?)
    }

    private func FindFromAnchor(
        root ExpressionSyntax,
        anchored BoundExpression,
        expression ExpressionSyntax
    ) BoundExpression? {
        if object.ReferenceEquals(root, expression) {
            return anchored
        }
        let segments = List[ExpressionSyntax]()
        AddReceiverSegments(root, segments)
        let terminal = TerminalSegment(expression)
        var idx = -1
        for var i = 0; i < segments.Count; i++ {
            if object.ReferenceEquals(segments[i], terminal) {
                idx = i
                break
            }
        }
        if idx < 0 {
            return nil
        }
        return ReadReceiverSegments(segments, anchored, idx, expression)
    }

    private func ReadReceiverSegments(
        segments List[ExpressionSyntax],
        anchored BoundExpression,
        idx int32,
        expression ExpressionSyntax,
        captureEnvironment Dictionary[VariableSymbol, BoundExpression]? = nil
    ) BoundExpression? {
        let lastSyntax = if idx == segments.Count - 1 {
            expression
        } else {
            segments[segments.Count - 1]
        }
        var node BoundExpression? = PeelConversions(anchored, lastSyntax)
        // A `?.` hop binds its access over a synthetic capture of the receiver;
        // the walk maps each capture back to the receiver it stands for.
        let captures = captureEnvironment ?? Dictionary[VariableSymbol, BoundExpression]()
        for var depth = segments.Count - 1; depth > idx && node != nil; depth-- {
            var member = PeelConversions(node, segments[depth])
            while member is BoundNullConditionalAccessExpression hop {
                captures[hop.Capture] = hop.Receiver
                member = PeelConversions(hop.WhenNotNull, segments[depth])
            }
            member = Unwrap(member, captures)
            let receiverSyntax = if depth - 1 == idx {
                expression
            } else {
                segments[depth - 1]
            }
            node = if member == nil {
                default(BoundExpression?)
            } else if segments[depth] is IndexExpressionSyntax {
                PeelConversions(IndexTargetOf(member), receiverSyntax)
            } else {
                PeelConversions(ReceiverOf(member), receiverSyntax)
            }
            if node is BoundVariableExpression read && captures.TryGetValue(read.Variable, out var captured) {
                node = PeelConversions(captured, receiverSyntax)
            }
        }
        return node
    }

    private func GetBoundAnchor(expression ExpressionSyntax) BoundExpression? {
        if this.GetBoundNode(expression) is BoundExpression anchored &&
            OwnedIndexAnchor(expression, anchored) is {} owned {
            return owned
        }
        // Generated idx plans can retain the written argument as their anchor.
        // An ordinary argument requires capture provenance, unlike a range that
        // can directly anchor a CLR idx read.
        if TerminalSegment(expression) is IndexExpressionSyntax idx && idx.Indices.Count == 1 {
            let argumentAnchor = this.GetBoundNode(idx.Index) as BoundExpression
            if argumentAnchor != nil &&
                Unwrap(argumentAnchor) is {} read &&
                IndexTargetOf(read, capturedOnly: idx.Index is not RangeExpressionSyntax) != nil &&
                OwnedIndexAnchor(expression, argumentAnchor) is {} recovered {
                return recovered
            }
        }
        return nil
    }

    private func OwnedIndexAnchor(expression ExpressionSyntax, anchored BoundExpression) BoundExpression? {
        let captures = Dictionary[VariableSymbol, BoundExpression]()
        var current = anchored
        while Unwrap(current, captures) is {} read && IndexTargetOf(read, capturedOnly: true) is {} source {
            if CapturedSourceOwnsIndex(expression, source, captures) {
                return current
            }
            let argument = CapturedIndexArgument(current)
            if argument == nil || object.ReferenceEquals(argument, current) ||
                argument.Syntax is not ExpressionSyntax syntax ||
                !object.ReferenceEquals(TerminalSegment(syntax), TerminalSegment(expression)) {
                return nil
            }
            current = argument
        }
        return current
    }

    private func CapturedSourceOwnsIndex(
        expression ExpressionSyntax,
        source BoundExpression,
        captures Dictionary[VariableSymbol, BoundExpression]? = nil
    ) bool {
        let idx = TerminalSegment(expression)
        if idx is not IndexExpressionSyntax {
            return false
        }
        var context = expression
        while ReceiverParent(context) is {} parent {
            context = parent
        }
        let segments = List[ExpressionSyntax]()
        AddReceiverSegments(context, segments)
        let end = segments.FindIndex((segment ExpressionSyntax) -> object.ReferenceEquals(segment, idx))
        if end <= 0 {
            return false
        }
        segments.RemoveRange(end, segments.Count - end)
        // Both the plan and source can inherit the argument's anchor. Prove
        // ownership at an independently anchored runtime or canonical static boundary.
        for var depth = 0; depth < segments.Count; depth++ {
            let syntax = AssignmentTargetSyntaxFacts.UnwrapParentheses(segments[depth])
            let member = Unwrap(ReadReceiverSegments(segments, source, depth, syntax, captures), captures)
            if member != nil && object.ReferenceEquals(member.Syntax, syntax) && object.ReferenceEquals(
                member,
                Unwrap(this.GetBoundNode(syntax) as BoundExpression)
            ) {
                return true
            }
            if member != nil &&
                depth > 0 &&
                context is AccessorExpressionSyntax accessor &&
                StaticMemberOwnsPrefix(accessor, segments[depth], member) {
                return true
            }
        }
        return false
    }

    private func StaticMemberOwnsPrefix(
        root AccessorExpressionSyntax,
        member ExpressionSyntax,
        read BoundExpression
    ) bool {
        let name string? = switch member {
            case syntax is NameExpressionSyntax: syntax.IdentifierToken.Text
            case syntax is CallExpressionSyntax: syntax.Identifier.Text
            default: default(string?)
        }
        if name == nil || !this.TryGetStaticTypeQualifier(
            root,
            member,
            out var sourceType,
            out var qualifier,
            out var selected
        ) ||
            qualifier == nil ||
            !object.ReferenceEquals(selected, read) {
            return false
        }
        if sourceType is StructSymbol owner {
            if read is BoundPropertyAccessExpression{Receiver: nil, Property: {IsStatic: true}} property &&
                TypeMemberModel
                .TryGetStaticPropertyIncludingInherited(owner, name, out var expectedProperty, out var propertyOwner) {
                return object.ReferenceEquals(property.Property, expectedProperty) && object.ReferenceEquals(
                    property.StructType,
                    propertyOwner
                )
            }
        }
        if read is BoundFieldAccessExpression{Receiver: nil, Field: {IsStatic: true}} field {
            return SourceStaticFieldOwnsPrefix(sourceType, name, field)
        }
        if read is BoundLiteralExpression folded && folded.StaticConstantFieldRead is {} foldedField {
            return foldedField.Field.IsConst && object.Equals(folded.Value, foldedField.Field.ConstantValue) &&
                object.ReferenceEquals(foldedField.StaticQualifierType, sourceType) && object.ReferenceEquals(
                foldedField.StaticQualifierSyntax,
                qualifier
            ) &&
                object.ReferenceEquals(foldedField.StaticMemberSyntax, member) &&
                SourceStaticFieldOwnsPrefix(sourceType, name, foldedField)
        }
        if read is BoundLiteralExpression literal &&
            literal.StaticEnumMember is {} enumMember &&
            sourceType is EnumSymbol enumOwner {
            return object.ReferenceEquals(enumMember.EnumType, enumOwner) && object.ReferenceEquals(
                literal.Type,
                enumOwner
            ) &&
                enumOwner.TryGetMember(name, out var selectedMember) && object.ReferenceEquals(
                selectedMember,
                enumMember
            )
        }
        if read is BoundConstrainedStaticCallExpression constrained && sourceType is TypeParameterSymbol parameter {
            return ConstrainedStaticOwnsPrefix(parameter, member, name, constrained)
        }
        if read is BoundCallExpression call && call.Function.IsStatic && sourceType != nil {
            if sourceType is InterfaceSymbol propertyContract &&
                member is NameExpressionSyntax &&
                TryGetStaticGetterProperty(propertyContract, name, out var interfaceProperty, out var interfaceOwner) {
                return object.ReferenceEquals(interfaceProperty!!.GetterSymbol, call.Function) &&
                    object.ReferenceEquals(interfaceOwner, propertyContract) && object.ReferenceEquals(
                    call.StaticGenericInterfaceOwnerType,
                    interfaceOwner
                )
            }
            if !TypeMemberModel.GetMethods(sourceType, name, MemberQuery.InheritedStatic(MemberKinds.Method)).Any(
                (candidate FunctionSymbol) -> object.ReferenceEquals(candidate, call.Function)
            ) {
                return false
            }
            let declaredOwner = call.Function.StaticOwnerType ?? call.Function.ContainingType
            if sourceType is StructSymbol owner && declaredOwner is StructSymbol declaredStruct {
                let effectiveOwner = TypeMemberModel.ResolveStaticMemberOwner(owner, declaredStruct)
                return if call.StaticGenericOwnerType != nil {
                    object.ReferenceEquals(call.StaticGenericOwnerType, effectiveOwner)
                } else {
                    effectiveOwner.Definition == nil
                }
            }
            if sourceType is InterfaceSymbol contract {
                let selectedOwner = call.StaticGenericInterfaceOwnerType ?? declaredOwner
                return contract.SelfAndAllBaseInterfaces().Any(
                    (candidate InterfaceSymbol) -> object.ReferenceEquals(candidate, selectedOwner) &&
                        TypeMemberModel
                        .GetMethods(candidate, name, MemberQuery.Static(MemberKinds.Method)).Any(
                        (method FunctionSymbol) -> object.ReferenceEquals(method, call.Function)
                    )
                )
            }
        }
        let clrType = if sourceType is StructSymbol inherited &&
            read is (BoundImportedCallExpression or BoundClrPropertyAccessExpression) {
            TypeMemberModel.GetNearestImportedBase(inherited)?.ClrType
        } else {
            sourceType?.ClrType
        }
        if read is BoundLiteralExpression literal && clrType != nil {
            // Folded CLR fields retain the selected read/qualifier record, not FieldInfo.
            return object.ReferenceEquals(literal.StaticQualifierType, sourceType) && object.ReferenceEquals(
                literal.StaticQualifierSyntax,
                qualifier
            ) &&
                object.ReferenceEquals(literal.StaticMemberSyntax, member)
        }
        if read is BoundClrPropertyAccessExpression{Receiver: nil} imported && clrType != nil {
            const flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.FlattenHierarchy
            let expected MemberInfo? = switch imported.Member {
                case FieldInfo{IsStatic: true}: ClrTypeUtilities.SafeGetField(clrType, name, flags)
                case property is PropertyInfo when(property.GetMethod ?? property.SetMethod)?.IsStatic == true:
                ClrTypeUtilities.SafeGetProperty(clrType, name, flags)
                default: default(MemberInfo?)
            }
            return expected != nil && imported.Member.Equals(expected)
        }
        if read is BoundImportedCallExpression{Function: {} function} && function.Method.IsStatic && clrType != nil {
            let method = function.Method
            let definition = if method.IsGenericMethod && !method.IsGenericMethodDefinition {
                method.GetGenericMethodDefinition()
            } else {
                method
            }
            return ClrTypeUtilities.SafeGetMethods(
                clrType,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.FlattenHierarchy
            )
                .Any((candidate MethodInfo) -> SameClrMethod(candidate, definition))
        }
        return false
    }

    private func TryGetStaticGetterProperty(
        contract InterfaceSymbol,
        name string,
        out property PropertySymbol?,
        out owner TypeSymbol?
    ) bool {
        if TypeMemberModel.TryGetPropertyWithOwner(contract, name, out var found, out var foundOwner) &&
            found!!.IsStatic &&
            found!!.HasGetter {
            property = found
            owner = foundOwner
            return true
        }
        property = nil
        owner = nil
        return false
    }

    private func SourceStaticFieldOwnsPrefix(
        sourceType TypeSymbol?,
        name string,
        field BoundFieldAccessExpression
    ) bool {
        if field.Receiver != nil || !field.Field.IsStatic {
            return false
        }
        if sourceType is StructSymbol owner && TypeMemberModel.TryGetStaticFieldIncludingInherited(
            owner,
            name,
            out var expected,
            out var declaring
        ) {
            return object.ReferenceEquals(field.Field, expected) && object.ReferenceEquals(field.StructType, declaring)
        }
        return sourceType is InterfaceSymbol contract && object.ReferenceEquals(field.InterfaceType, contract) &&
            object.ReferenceEquals(field.Field, (contract.Definition ?? contract).GetStaticField(name))
    }

    private func ConstrainedStaticOwnsPrefix(
        parameter TypeParameterSymbol,
        member ExpressionSyntax,
        name string,
        call BoundConstrainedStaticCallExpression
    ) bool {
        let owner = call.StaticConstraintOwner
        let constraint = parameter.ConstraintInterfaceType
        if !object.ReferenceEquals(call.TypeParameter, parameter) || owner == nil || constraint == nil {
            return false
        }
        if call.InterfaceMethod is {} selected && owner is InterfaceSymbol contract {
            if !object.ReferenceEquals(owner, constraint) {
                return false
            }
            if member is NameExpressionSyntax &&
                TryGetStaticGetterProperty(contract, name, out var selectedProperty, out _) {
                return object.ReferenceEquals(selectedProperty!!.GetterSymbol, selected)
            }
            return member is CallExpressionSyntax && TypeMemberModel.GetMethods(
                contract,
                name,
                MemberQuery.Static(MemberKinds.Method)
            )
                .Any((candidate FunctionSymbol) -> object.ReferenceEquals(candidate, selected))
        }
        if call.ClrMethod is {} imported && object.ReferenceEquals(call.ConstrainedInterfaceType, owner) &&
            owner.ClrType is {} declaringType &&
            constraint.ClrType is {} constraintType &&
            imported
            .IsStatic {
            let definition = if imported.IsGenericMethod && !imported.IsGenericMethodDefinition {
                imported.GetGenericMethodDefinition()
            } else {
                imported
            }
            return ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(
                constraintType,
                BindingFlags.Public | BindingFlags.Static
            )
                .Any(
                (candidate MethodInfo) -> declaringType.Equals(candidate.DeclaringType) &&
                    SameClrMethod(candidate, definition)
            )
        }
        return false
    }

    private func SameClrMethod(candidate MethodInfo, selected MethodInfo) bool {
        if candidate.Equals(selected) {
            return true
        }
        try {
            // Inherited methods differ in ReflectedType, not their closed declaration.
            let declaringType = candidate.DeclaringType
            return declaringType != nil && declaringType.Equals(selected.DeclaringType) && candidate.Module.Equals(
                selected.Module
            ) &&
                candidate.MetadataToken == selected.MetadataToken
        } catch (Exception) {
            return false
        }
    }

    private func CapturedIndexArgument(anchored BoundExpression) BoundExpression? {
        var read = Unwrap(anchored)
        if read is BoundDereferenceExpression dereference &&
            dereference
            .Operand
            .Type is ByRefTypeSymbol &&
            IsSynthesizedWrapper(dereference, dereference.Operand) {
            read = Unwrap(dereference.Operand)
        }
        // The native idx plan stores its written argument in one known
        // operation over the first source capture. Do not scan block children.
        if read is not BoundBlockExpression block ||
            block
            .Statements
            .Length != 1 ||
            CapturedIndexTarget(block) == nil ||
            block.Statements[0] is not BoundVariableDeclaration capture {
            return nil
        }
        let argument BoundExpression? = switch block.Expression {
            case BoundClrIndexExpression{Target: BoundVariableExpression receiver} idx when object.ReferenceEquals(
                receiver.Variable,
                capture.Variable
            ) &&
                idx
                .Arguments
                .Length == 1: idx.Arguments[0]
            case BoundImportedInstanceCallExpression{
                Receiver: BoundVariableExpression receiver
            } call when object.ReferenceEquals(receiver.Variable, capture.Variable) &&
                call
                .Arguments
                .Length == 1: call.Arguments[0]
            default: default(BoundExpression?)
        }
        return if argument != nil && object.ReferenceEquals(argument.Syntax, block.Syntax) {
            argument
        } else {
            default(BoundExpression?)
        }
    }

    private func TerminalSegment(expression ExpressionSyntax) ExpressionSyntax {
        var current = expression
        while current is AccessorExpressionSyntax accessor {
            current = accessor.RightPart
        }
        return current
    }

    // An implicit ref read adds no syntax step. Its operand must itself be a
    // recognized idx or guarded capture plan, never an arbitrary block.
    private func IndexTargetOf(node BoundExpression, capturedOnly bool = false) BoundExpression? -> switch node {
        case idx is BoundIndexExpression when !capturedOnly: idx.Target
        case idx is BoundClrIndexExpression when !capturedOnly: idx.Target
        case dereference is BoundDereferenceExpression when dereference
            .Operand
            .Type is ByRefTypeSymbol &&
            IsSynthesizedWrapper(dereference, dereference.Operand): IndexTargetOf(dereference.Operand, capturedOnly)
        case block is BoundBlockExpression: CapturedIndexTarget(block)
        default: if capturedOnly {
            default(BoundExpression?)
        } else {
            ReceiverOf(node)
        }
    }

    private func CapturedIndexTarget(block BoundBlockExpression) BoundExpression? {
        // DeclareRangeTemp emits the source capture first for idx/slice
        // blocks. Its reserved role and absent declaration exclude authored
        // blocks and other generated capture plans.
        const sourceCapturePrefix = "$$slice_src"
        if !block
            .Statements
            .IsDefaultOrEmpty &&
            block.Statements[0] is BoundVariableDeclaration{
            Variable: LocalVariableSymbol{DeclaringSyntax: nil, IsReadOnly: true} capture,
            Initializer: {} target
        } &&
            capture
            .Name
            .StartsWith(sourceCapturePrefix, StringComparison.Ordinal) && int32.TryParse(
            capture.Name.Substring(sourceCapturePrefix.Length),
            out _
        ) {
            return target
        }
        return nil
    }

    private func AddReceiverSegments(expression ExpressionSyntax, segments List[ExpressionSyntax]) {
        switch expression {
            case accessor is AccessorExpressionSyntax {
                AddReceiverSegments(accessor.LeftPart, segments)
                AddReceiverSegments(accessor.RightPart, segments)
            }
            case idx is IndexExpressionSyntax {
                AddReceiverSegments(idx.Target, segments)
                segments.Add(idx)
            }
            default {
                segments.Add(expression)
            }
        }
    }

    /// Gets a bound member's receiver, or null when it has none.
    private func ReceiverOf(node BoundExpression) BoundExpression? -> switch node {
        case userCall is BoundUserInstanceCallExpression: userCall.Receiver
        case importedCall is BoundImportedInstanceCallExpression: importedCall.Receiver
        case property is BoundPropertyReferenceOperationExpression: property.Instance
        case field is BoundFieldAccessExpression: field.Receiver
        case tuple is BoundTupleElementAccessExpression: tuple.Receiver
        case call is BoundCallExpression when call.Function.IsExtension && call.Arguments.Length > 0: call.Arguments[0]
        case call is BoundImportedCallExpression when call
            .Arguments
            .Length > 0 &&
            IsExtensionMethod(call.Function?.Method): call.Arguments[0]
        default: default(BoundExpression?)
    }

    private func IsExtensionMethod(method MethodInfo?) bool {
        if method == nil || !method.IsStatic {
            return false
        }
        try {
            return method.GetCustomAttributesData().Any(
                (attribute CustomAttributeData) -> attribute.AttributeType.FullName ==
                "System.Runtime.CompilerServices.ExtensionAttribute"
            )
        } catch (Exception) {
            // Metadata that cannot be read is treated as a plain static call.
            return false
        }
    }

    /// Removes the implicit conversions the binder adds around a read without
    /// user syntax of their own. A narrowed value-type read keeps its
    /// synthesized `!!`: that node's type is the read's flow type (`S`,
    /// where the read below it is still `S?`).
    private func PeelConversions(node BoundExpression?, expression ExpressionSyntax) BoundExpression? {
        let receiverSyntax = AssignmentTargetSyntaxFacts.UnwrapParentheses(expression)
        var current = node
        while current is BoundConversionExpression conversion &&
            IsSynthesizedWrapper(conversion, conversion.Expression, receiverSyntax) {
            current = conversion.Expression
        }
        return current
    }

    /// Removes the conversions and nil-unwraps the binder adds around a read
    /// without user syntax of their own, so the node reached is the read itself.
    private func Unwrap(
        node BoundExpression?,
        captures Dictionary[VariableSymbol, BoundExpression]? = nil
    ) BoundExpression? {
        var current = node
        while current != nil {
            if current.LogicalCompletionOperand is {} operand {
                current = operand
            } else if current is BoundConversionExpression conversion &&
                IsSynthesizedWrapper(conversion, conversion.Expression) {
                current = conversion.Expression
            } else if current is BoundNullConditionalAccessExpression hop {
                // The member a `?.` hop reads is its non-nil access.
                if captures != nil {
                    captures[hop.Capture] = hop.Receiver
                }
                current = hop.WhenNotNull
            } else if current is BoundVariableExpression read && captures != nil && captures.TryGetValue(
                read.Variable,
                out var captured
            ) {
                current = captured
            } else if current is BoundUnaryExpression unary &&
                unary
                .Op
                .Kind == BoundUnaryOperatorKind.NullAssertion &&
                IsSynthesizedWrapper(unary, unary.Operand) {
                current = unary.Operand
            } else {
                break
            }
        }
        return current
    }

    // For type queries, a conversion anchored on the whole accessor is implicit
    // only when its operand is the queried receiver, not a conversion argument.
    private func IsSynthesizedWrapper(
        wrapper BoundExpression,
        inner BoundExpression,
        expression ExpressionSyntax? = nil
    ) bool -> (
        wrapper is BoundConversionExpression && object.ReferenceEquals(wrapper.ImplicitConversionOperand, inner) &&
            (
            expression == nil ||
                (
                inner.Syntax is ExpressionSyntax syntax && object.ReferenceEquals(
                    AssignmentTargetSyntaxFacts.UnwrapParentheses(syntax),
                    expression
                )
            )
        )
    ) ||
        wrapper.Syntax == nil ||
        (
        wrapper.Syntax is AccessorExpressionSyntax &&
            (expression == nil || object.ReferenceEquals(inner.Syntax, expression))
    ) ||
        object.ReferenceEquals(wrapper.Syntax, inner.Syntax)

    /// Gets the symbol a bound read or call refers to, whatever its origin.
    private func ReferencedSymbol(node BoundExpression) Symbol? -> switch node {
        case variable is BoundVariableExpression: variable.Variable
        case call is BoundCallOperationExpression: call.CalledFunction
        case baseCall is BoundBaseClassCallExpression: baseCall.Method ?? cast[Symbol?](baseCall.Property)
        case property is BoundPropertyReferenceOperationExpression: property.ReferencedProperty
        case field is BoundFieldAccessExpression: ReferencedFieldSymbol(field)
        case literal is BoundLiteralExpression when literal.StaticEnumMember != nil: literal.StaticEnumMember
        case literal is BoundLiteralExpression: literal.StaticConstantFieldRead?.Field
        default: default(Symbol?)
    }

    /// Gets the same-compilation symbol a bound read or call refers to.
    /// Imported members have no symbol here; see (cref:GetReferencedExpression).
    private func ReferencedSourceSymbol(node BoundExpression) Symbol? {
        return switch node {
            // A bare member name inside a method reads through an implicit
            // `this`/type receiver; the reference is to the member itself.
            case BoundVariableExpression{Variable: ImplicitFieldVariableSymbol implicitField}: implicitField.Field
            case BoundVariableExpression{
                Variable: ImplicitPropertyVariableSymbol implicitProperty
            }: implicitProperty.Property
            case BoundVariableExpression{Variable: ImplicitStaticFieldVariableSymbol staticField}: staticField.Field
            case BoundVariableExpression{
                Variable: ImplicitStaticPropertyVariableSymbol staticProperty
            }: staticProperty.Property
            case variable is BoundVariableExpression: variable.Variable
            case call is BoundCallExpression: call.Function
            case constrained is BoundConstrainedStaticCallExpression: constrained.InterfaceMethod
            case userCall is BoundUserInstanceCallExpression: userCall.Method
            case baseCall is BoundBaseClassCallExpression: baseCall.Method ?? cast[Symbol?](baseCall.Property)
            case baseCall is BoundBaseInterfaceCallExpression: baseCall.Method
            // A read through a constructed generic interface keeps the
            // declaration's property and records the substituted type beside
            // it; show the property at that type. References still match it
            // by its declaration.
            case BoundPropertyAccessExpression{
                SubstitutedType: {} substitutedType
            } property when !object.ReferenceEquals(substitutedType, property.Property.Type): property
                .Property
                .WithSignature(substitutedType, property.Property.Parameters)
            case property is BoundPropertyAccessExpression: property.Property
            case field is BoundFieldAccessExpression: ReferencedFieldSymbol(field)
            case literal is BoundLiteralExpression when literal.StaticEnumMember != nil: literal.StaticEnumMember
            case literal is BoundLiteralExpression: literal.StaticConstantFieldRead?.Field
            default: default(Symbol?)
        }
    }

    /// Gets the symbol that [`token`](paramref) declares or names. A name that
    /// differs from the token text, and a field-like event's backing field,
    /// answer null so callers use their syntactic lookup.
    private func GetTokenSymbol(token SyntaxToken) Symbol? {
        if token.Kind != SyntaxKind.IdentifierToken || token.IsMissing || !object.ReferenceEquals(
            token.SyntaxTree,
            syntaxTree
        ) {
            return nil
        }
        if GetDeclaredSymbol(token) is {} declared && declared.Name == token.ValueText {
            return declared
        }
        // A local function is declared by its `let` declaration, not by the identifier.
        if token.Parent is VariableDeclarationSyntax localDeclaration && object.ReferenceEquals(
            localDeclaration.Identifier,
            token
        ) &&
            GetDeclaredSymbol(localDeclaration) is FunctionSymbol localFunction &&
            localFunction.Name == token.ValueText {
            return localFunction
        }
        // A type-clause identifier answers the type the clause denotes, whatever the
        // identifier's text (an alias answers its target).
        if index.Value.TypeClauseTokens.TryGetValue(token, out var clauseType) {
            return clauseType
        }
        let node = Unwrap(FindReferencedNode(token))
        let symbol = if node == nil {
            default(Symbol?)
        } else {
            ReferencedSourceSymbol(node)
        }
        // A field-like event's read binds its synthesized backing field; the
        // reference is to the event, which the callers' event lookup finds.
        if symbol is FieldSymbol{IsEventBackingField: true} {
            return nil
        }
        return if symbol != nil && symbol.Name == token.ValueText {
            symbol
        } else {
            default(Symbol?)
        }
    }

    private func ReferencedFieldSymbol(field BoundFieldAccessExpression) Symbol {
        let property = TypeMemberModel.PropertyForBackingField(field.StructType, field.Field)
        if property == nil {
            return field.Field
        }
        return if field.SubstitutedType is {} substituted && !object.ReferenceEquals(substituted, property.Type) {
            property.WithSignature(substituted, property.Parameters)
        } else {
            property
        }
    }
}
