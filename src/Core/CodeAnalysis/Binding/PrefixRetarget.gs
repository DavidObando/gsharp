// <copyright file="PrefixRetarget.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable

/// Records the calls and the names of a prefix bind whose type a later declaration can change (#6179,
/// ADR-0225). A diagnostic whose location contains such an expression is future-dependent.
internal shared class PrefixRetarget {
    /// Records [`syntax`](paramref) when a later overload, member, receiver function or local can be a
    /// better candidate for the call that [`bound`](paramref) resolved.
    /// @param syntax The call.
    /// @param kind The callee of the call: (cref:PrefixCallKind.Name) or (cref:PrefixCallKind.Member).
    /// @param bound The bound call.
    /// @param qualifierType The type that qualifies a member call (the receiver's type or the named type),
    /// or `null`.
    func NoteCall(syntax SyntaxNode?, kind PrefixCallKind, bound BoundExpression, qualifierType TypeSymbol? = nil) {
        if syntax == nil || PrefixBindingContext.Current is not{} cut {
            return
        }
        if CanChange(cut, syntax, kind, bound, qualifierType) {
            PrefixBindingContext.AddProvisional(syntax)
        } else {
            PrefixBindingContext.AddFixed(syntax)
        }
    }

    /// Records the target of an index expression when a later part of an incomplete type in its hierarchy
    /// can add a better indexer, a user indexer or a CLR one that the type inherits.
    /// @param target The indexed expression.
    /// @param targetType The type of the target.
    func NoteIndexTarget(target SyntaxNode, targetType TypeSymbol?) {
        if PrefixBindingContext.Current is not{} cut {
            return
        }
        if cut.LaterOverloadsPossible && HierarchyCanGrow(targetType, nil) {
            PrefixBindingContext.AddProvisional(target)
        } else {
            PrefixBindingContext.AddFixed(target.Parent)
        }
    }

    /// Records the source of an implicit lookup (the `GetEnumerator` of a loop, the `Deconstruct` of a
    /// deconstruction) when a later declaration can change what it finds: a type of the source's hierarchy
    /// can get members, or, for a deconstruction of a value that is not a tuple, a later receiver
    /// `Deconstruct` can be better.
    /// @param source The collection or the deconstructed value.
    /// @param type The type of the source.
    /// @param deconstruction Whether the lookup is a deconstruction.
    func NoteImplicitLookup(source SyntaxNode, type TypeSymbol?, deconstruction bool) {
        if PrefixBindingContext.Current is not{} cut || !cut.LaterOverloadsPossible {
            return
        }
        if HierarchyCanGrow(type, nil) || (deconstruction && !(type is TupleTypeSymbol) && type != nil) {
            PrefixBindingContext.AddProvisional(source)
        }
    }

    /// Records a member access when a later member of a type between a receiver and the member's owner can
    /// hide a field or a property that the chain reads (a later part of a partial type, also over a member
    /// of an imported base). Calls of the chain record themselves (#6179).
    /// @param syntax The member access.
    /// @param bound The bound access.
    func NoteAccess(syntax SyntaxNode, bound BoundExpression) {
        if PrefixBindingContext.Current is not{} cut || !cut.LaterOverloadsPossible {
            return
        }
        var node BoundExpression? = bound
        for var depth = 0; depth < 32 && node != nil; depth++ {
            if node.LogicalCompletionOperand is {} logical {
                node = logical
                continue
            }
            if node is BoundConversionExpression conversion {
                node = conversion.Expression
                continue
            }
            var receiver BoundExpression? = nil
            var owner TypeSymbol? = nil
            if node is BoundPropertyReferenceOperationExpression property {
                receiver = property.Instance
                owner = property.ReferencedProperty?.ContainingType
            } else if node is BoundFieldAccessExpression field {
                receiver = field.Receiver
                owner = field.Field.ContainingType
            } else if node is BoundImportedInstanceCallExpression call {
                receiver = call.Receiver
            } else if node is BoundUserInstanceCallExpression userCall {
                receiver = userCall.Receiver
                owner = userCall.Method.ContainingType
            } else {
                break
            }
            // A static read has no receiver: its qualifier is the type that the lookup started from.
            let qualifier = receiver?.Type ?? node.StaticQualifierType
            if qualifier == nil && receiver == nil {
                // No qualifier is known: the read cannot be shown to be fixed.
                PrefixBindingContext.AddProvisional(syntax)
                return
            }
            if HierarchyCanGrow(qualifier, owner) {
                PrefixBindingContext.AddProvisional(syntax)
                return
            }
            node = receiver
        }
        PrefixBindingContext.AddFixed(syntax)
    }

    /// Records [`syntax`](paramref) when it names a variable whose inferred type a later declaration can
    /// change, or when a later local or top-level global can hide it (#6179, #6229).
    /// @param syntax The name.
    /// @param bound The bound name.
    /// @param isResolvedVariable Whether the name resolved through a variable symbol.
    func NoteName(syntax SyntaxNode, bound BoundExpression, isResolvedVariable bool = false) {
        if PrefixBindingContext.Current == nil {
            return
        }
        // A report in this tree can read a global of another tree by name.
        PrefixBindingContext.AddTree(syntax.SyntaxTree)
        if bound is BoundVariableExpression variable && PrefixBindingContext.IsProvisionalVariable(variable.Variable) {
            PrefixBindingContext.AddProvisional(syntax)
            return
        }
        if isResolvedVariable ||
            bound is BoundErrorExpression ||
            (syntax is NameExpressionSyntax name && name.IdentifierToken.ValueText == "null") {
            return
        }
        if PrefixBindingContext.LaterLocalCanHide(syntax.Location) &&
            (bound is BoundMethodGroupExpression || bound is BoundClrMethodGroupExpression) {
            PrefixBindingContext.AddProvisional(syntax)
            return
        }
        if bound is BoundMethodGroupExpression group {
            if PrefixBindingContext.Current is {} cut && cut.LaterOverloadsPossible {
                // In Nothing mode, a later overload can join any source method group.
                PrefixBindingContext.AddProvisional(syntax)
                return
            }
            if PrefixBindingContext.LaterGlobalCanHide(syntax) {
                for candidate in group.Candidates {
                    if candidate.ContainingType == nil && candidate.Package != nil {
                        return
                    }
                }
                PrefixBindingContext.AddProvisional(syntax)
            }
            return
        }
        if bound is BoundClrMethodGroupExpression &&
            PrefixBindingContext.Current is {} clrCut &&
            clrCut.LaterOverloadsPossible {
            PrefixBindingContext.AddProvisional(syntax)
            return
        }
        if PrefixBindingContext.LaterGlobalCanHide(syntax) {
            PrefixBindingContext.AddProvisional(syntax)
        }
    }

    // A call whose result no later declaration can change: a conversion, a call of a function value with a
    // declared type, a constructor, a member that no later member can hide, or a candidate that matches
    // each argument exactly. Any other call can change.
    private func CanChange(
        cut PrefixCut,
        syntax SyntaxNode,
        kind PrefixCallKind,
        bound BoundExpression,
        qualifierType TypeSymbol?
    ) bool {
        var node BoundExpression = bound
        for var depth = 0; depth < 8; depth++ {
            if node.LogicalCompletionOperand is {} logical {
                node = logical
            } else {
                break
            }
        }
        if node is BoundErrorExpression {
            // A failed call reports its own diagnostics, with the premise of the call.
            return false
        }
        // A function value whose type a call infers (`let f = G(1)`, then `f()`) changes with that call,
        // also a CLR delegate that the call invokes through `Invoke`.
        let calledValue BoundExpression? = if node is BoundIndirectCallExpression indirect {
            indirect.Target
        } else if node is BoundImportedInstanceCallExpression invoke {
            invoke.Receiver
        } else {
            default(BoundExpression?)
        }
        if calledValue is BoundVariableExpression read && PrefixBindingContext.IsProvisionalVariable(read.Variable) {
            return true
        }
        // A later local of a function literal's block can hide a simple-name callee, also an exact one.
        if kind == PrefixCallKind.Name && PrefixBindingContext.LaterLocalCanHide(syntax.Location) {
            return true
        }
        // With the cut in the top-level statements of KeepDeclarations, a later top-level global can hide a
        // simple-name call in a member or function body unless it resolved to a variable or package function
        // (#6229).
        if !cut.LaterOverloadsPossible && kind == PrefixCallKind.Name && PrefixBindingContext.LaterGlobalCanHide(
            syntax
        ) &&
            CanBeShadowedByLaterGlobal(syntax, node) {
            return true
        }
        if !cut.LaterOverloadsPossible {
            return false
        }
        // In Nothing mode, a later declaration can hide a type-imported static call or a simple-name
        // conversion call inside a member or function body (#6229).
        if kind == PrefixCallKind.Name &&
            (
            node is BoundImportedCallExpression ||
                node is BoundClrStaticCallExpression ||
                (
                cut.LaterDeclarationsPossible && PrefixBindingContext.IsInMemberOrFunctionBody(syntax) &&
                    IsSimpleNameConversionCall(syntax, node)
            )
        ) {
            return true
        }
        // A function value has a declared signature, and a constructor call has the type that it names,
        // whichever `init` a later part adds.
        if node is BoundIndirectCallExpression ||
            node is BoundConversionExpression ||
            node is BoundConstructorCallExpression {
            return false
        }
        if node is BoundCallExpression call {
            let function = call.Function
            if function.IsExtension {
                // A later member of an incomplete receiver type beats a receiver function, also an exact one.
                return HierarchyCanGrow(function.ExtensionReceiverType, nil) ||
                    HierarchyCanGrow(qualifierType, nil) ||
                    !IsExactMatch(function, call.Arguments, syntax)
            }
            if kind == PrefixCallKind.Name {
                // A later member of an enclosing type that can get members hides a function of the package
                // or of a base type, also an exact one.
                return EnclosingTypeCanHide(syntax, function) || !IsExactMatch(function, call.Arguments, syntax)
            }
            return MemberCanChange(qualifierType, function, call.Arguments, syntax)
        }
        if node is BoundUserInstanceCallExpression instance {
            return MemberCanChange(qualifierType ?? instance.Receiver.Type, instance.Method, instance.Arguments, syntax)
        }
        if node is BoundBaseClassCallExpression baseCall {
            // A later member of the base class, or of a type between it and the chosen member's owner, can be
            // better; one of the derived class cannot.
            return if baseCall.Method is {} method {
                MemberCanChange(baseCall.BaseClass, method, baseCall.Arguments, syntax)
            } else {
                HierarchyCanGrow(baseCall.BaseClass, nil)
            }
        }
        if node is BoundImportedInstanceCallExpression importedInstance {
            // A later member of a source receiver type beats the member it inherits from an imported base. A
            // later receiver function can beat a CLR member when it takes a function literal argument without
            // a lossy delegate conversion (ExpressionBinder.TryPreferBetterExtensionOverClrInstanceMethod).
            return HierarchyCanGrow(qualifierType ?? importedInstance.Receiver.Type, nil) ||
                HasArgumentTypedByCandidate(syntax)
        }
        if node is BoundImportedCallExpression importedCall && IsImportedExtension(importedCall) {
            // A later receiver function of this package takes precedence over an imported extension method.
            return true
        }
        if node is BoundClrStaticCallExpression ||
            node is BoundClrConstructorCallExpression ||
            (node is BoundImportedCallExpression && kind == PrefixCallKind.Member) {
            // A receiver function does not beat a member of an imported type, and a static member of an
            // imported type gets no later overload. A later source type that hides the imported type is not
            // a premise here (#6215). A simple name of an imported static member can be hidden by a later
            // function of this package, so it is not fixed.
            return HierarchyCanGrow(qualifierType, nil)
        }
        // Each other call can change until it is shown to be fixed.
        return true
    }

    // A member call through a receiver or qualifier type: a later member of that type can overload the chosen
    // member or hide an inherited one, and a later member of the chosen member's owner can overload it.
    private func MemberCanChange(
        qualifierType TypeSymbol?,
        function FunctionSymbol,
        arguments ImmutableArray[BoundExpression],
        syntax SyntaxNode
    ) bool {
        let owner = function.ContainingType ?? function.StaticOwnerType ?? function.ReceiverType
        // A type between the qualifier and the owner can hide the member with a later one, also an exact one.
        if HierarchyCanGrow(qualifierType, owner) {
            return true
        }
        return OwnerCanGetMembers(function) && !IsExactMatch(function, arguments, syntax)
    }

    private func CanBeShadowedByLaterGlobal(syntax SyntaxNode, node BoundExpression) bool {
        if syntax is CallExpressionSyntax callSyntax &&
            (
            callSyntax.ConversionTypeClause != nil ||
                callSyntax.Callee != nil ||
                callSyntax.Identifier.ValueText == "cast"
        ) {
            return false
        }
        if node is BoundIndirectCallExpression ||
            node is BoundFunctionPointerInvocationExpression ||
            node is BoundTypeParameterConstructionExpression {
            return false
        }
        if node is BoundImportedInstanceCallExpression invoke && string.Equals(
            invoke.Method.Name,
            "Invoke",
            StringComparison.Ordinal
        ) &&
            invoke.Receiver.Type.ClrType is {} receiverClr &&
            ClrTypeUtilities.IsDelegateType(receiverClr) && IsNonShadowableDelegateReceiver(invoke.Receiver) {
            return false
        }
        if node is BoundCallExpression call {
            return call.Function.ContainingType != nil
        }
        return true
    }

    private func IsNonShadowableDelegateReceiver(receiver BoundExpression) bool {
        var current = receiver
        while current is BoundConversionExpression conv {
            current = conv.Expression
        }
        if current is BoundVariableExpression recvVar {
            return recvVar.Variable is not GlobalVariableSymbol
        }
        if current is BoundFieldAccessExpression field {
            let owner = field.Field.ContainingType
            return owner is StructSymbol || owner is InterfaceSymbol
        }
        if current is BoundPropertyReferenceOperationExpression prop {
            let owner = prop.ReferencedProperty?.ContainingType
            return owner is StructSymbol || owner is InterfaceSymbol
        }
        return false
    }

    private func IsSimpleNameConversionCall(syntax SyntaxNode, node BoundExpression) bool {
        if syntax is not CallExpressionSyntax callSyntax ||
            callSyntax.ConversionTypeClause != nil ||
            callSyntax.Callee != nil ||
            callSyntax.Identifier.ValueText == "cast" {
            return false
        }
        if node is BoundConversionExpression {
            return true
        }
        return !(
            node is BoundCallExpression ||
                node is BoundIndirectCallExpression ||
                node is BoundFunctionPointerInvocationExpression ||
                node is BoundTypeParameterConstructionExpression ||
                node is BoundConstructorCallExpression ||
                node is BoundClrConstructorCallExpression ||
                node is BoundUserInstanceCallExpression ||
                node is BoundImportedInstanceCallExpression ||
                node is BoundImportedCallExpression ||
                node is BoundClrStaticCallExpression
        )
    }

    // Whether a type of [`type`](paramref)'s hierarchy, before [`stop`](paramref), can get members: a later
    // member of it overloads or hides what the lookup found further up. Without a stop, the whole hierarchy
    // counts.
    private func HierarchyCanGrow(type TypeSymbol?, stop TypeSymbol?) bool -> PrefixBindingContext.CanHierarchyGrow(
        type,
        stop
    )

    // Whether a type that encloses [`syntax`](paramref) can get a later member that hides
    // [`function`](paramref), which a simple name resolved to: the function is not a member of that type.
    private func EnclosingTypeCanHide(syntax SyntaxNode, function FunctionSymbol) bool {
        let tree = syntax.SyntaxTree
        var current SyntaxNode? = tree.GetParent(syntax)
        while current != nil {
            if current is StructDeclarationSyntax declaration && PrefixBindingContext.IsIncompleteType(declaration) {
                let declaredHere = function.ContainingType is StructSymbol owner &&
                    owner.Declaration is {} ownerDeclaration &&
                    (
                    object.ReferenceEquals(ownerDeclaration, declaration) ||
                        (
                        declaration.IsPartial &&
                            ownerDeclaration.Identifier.ValueText == declaration.Identifier.ValueText
                    )
                )
                if !declaredHere {
                    return true
                }
            }
            current = tree.GetParent(current)
        }
        return false
    }

    private func HasArgumentTypedByCandidate(syntax SyntaxNode) bool {
        if syntax is not CallExpressionSyntax call {
            return false
        }
        for argument in call.Arguments {
            let value = if argument is NamedArgumentExpressionSyntax named {
                named.Expression
            } else {
                argument
            }
            if PrefixBindingContext.IsTypedByCandidate(value) {
                return true
            }
        }
        return false
    }

    private func IsImportedExtension(call BoundImportedCallExpression) bool {
        // The metadata can come from a load context of its own, so the attribute is matched by name.
        let method = call.Function.Method
        if !method.IsStatic {
            return false
        }
        try {
            for attribute in method.GetCustomAttributesData() {
                if attribute.AttributeType.FullName == "System.Runtime.CompilerServices.ExtensionAttribute" {
                    return true
                }
            }
        } catch (Exception) {
            // Metadata that cannot be read counts as an extension, so the call stays provisional.
            return true
        }
        return false
    }

    private func OwnerCanGetMembers(function FunctionSymbol) bool -> TypeCanGetMembers(
        function.ContainingType ?? function.StaticOwnerType ?? function.ReceiverType
    )

    // A source type that is open at the cut, or partial with nothing after the cut, can get a better member.
    // A type that this compilation does not declare cannot, and neither can a closed type.
    private func TypeCanGetMembers(type TypeSymbol?) bool {
        if type is StructSymbol aggregate {
            return if aggregate.Declaration is {} declaration {
                PrefixBindingContext.IsIncompleteType(declaration)
            } else {
                false
            }
        }
        // A source interface can be open at the cut. A built-in or imported type gets no members, and a
        // receiver function does not beat a member.
        return type is InterfaceSymbol
    }

    // A non-generic candidate whose parameters take each argument without a conversion, with no default
    // or variadic parameter in play: a later overload with the same parameter types is a duplicate, and any
    // other later overload converts at least one argument worse.
    private func IsExactMatch(
        function FunctionSymbol,
        arguments ImmutableArray[BoundExpression],
        syntax SyntaxNode
    ) bool {
        if function.IsGeneric || function.IsReturnTypeInferred || syntax is not CallExpressionSyntax call {
            return false
        }
        let parameters = function.Parameters
        if parameters.Length != arguments.Length || parameters.Length != call.Arguments.Count {
            return false
        }
        for var i = 0; i < parameters.Length; i++ {
            let argumentSyntax = call.Arguments[i]
            if argumentSyntax is NamedArgumentExpressionSyntax || PrefixBindingContext.IsTypedByCandidate(
                argumentSyntax
            ) ||
                parameters[i].IsVariadic {
                return false
            }
            let argument = arguments[i]
            if argument is BoundConversionExpression || argument.Type is not{} argumentType {
                return false
            }
            if !Conversion.Classify(argumentType, parameters[i].Type).IsIdentity {
                return false
            }
        }
        return true
    }
}
