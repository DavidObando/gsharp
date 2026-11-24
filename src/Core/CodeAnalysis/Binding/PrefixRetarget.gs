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
        }
    }

    /// Records the indexed expression at [`location`](paramref) when a later part of an incomplete type can
    /// add a better indexer than [`indexer`](paramref). The location is the receiver's, which the index
    /// expression contains.
    /// @param location The location of the indexed receiver.
    /// @param receiverType The type of the receiver.
    /// @param indexer The indexer that the read selected.
    func NoteIndexer(location TextLocation, receiverType TypeSymbol?, indexer PropertySymbol) {
        if PrefixBindingContext.Current is not{} cut || !cut.LaterOverloadsPossible {
            return
        }
        if TypeCanGetMembers(receiverType) || TypeCanGetMembers(indexer.ContainingType) {
            PrefixBindingContext.AddProvisional(location)
        }
    }

    /// Records [`syntax`](paramref) when it names a variable whose inferred type a later declaration can
    /// change.
    /// @param syntax The name.
    /// @param bound The bound name.
    func NoteName(syntax SyntaxNode, bound BoundExpression) {
        if PrefixBindingContext.Current != nil &&
            bound is BoundVariableExpression variable &&
            PrefixBindingContext.IsProvisionalVariable(variable.Variable) {
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
        // A function value whose type a call infers (`let f = G(1)`, then `f()`) changes with that call.
        if node is BoundIndirectCallExpression indirect &&
            indirect.Target is BoundVariableExpression read &&
            PrefixBindingContext.IsProvisionalVariable(read.Variable) {
            return true
        }
        // A later local of a function literal's block can hide a simple-name callee, also an exact one.
        if kind == PrefixCallKind.Name && PrefixBindingContext.LaterLocalCanHide(syntax.Location) {
            return true
        }
        if !cut.LaterOverloadsPossible {
            return false
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
                return TypeCanGetMembers(function.ExtensionReceiverType) ||
                    TypeCanGetMembers(qualifierType) ||
                    !IsExactMatch(function, call.Arguments, syntax)
            }
            if kind == PrefixCallKind.Name {
                return !IsExactMatch(function, call.Arguments, syntax)
            }
            return MemberCanChange(qualifierType, function, call.Arguments, syntax)
        }
        if node is BoundUserInstanceCallExpression instance {
            return MemberCanChange(qualifierType ?? instance.Receiver.Type, instance.Method, instance.Arguments, syntax)
        }
        if node is BoundBaseClassCallExpression baseCall {
            // A later member of the base class can be better; one of the derived class cannot.
            return if baseCall.Method is {} method {
                OwnerCanGetMembers(method) && !IsExactMatch(method, baseCall.Arguments, syntax)
            } else {
                TypeCanGetMembers(baseCall.BaseClass)
            }
        }
        if node is BoundImportedInstanceCallExpression importedInstance {
            // A later member of a source receiver type beats the member it inherits from an imported base.
            return TypeCanGetMembers(qualifierType) || TypeCanGetMembers(importedInstance.Receiver.Type)
        }
        if node is BoundClrStaticCallExpression ||
            node is BoundClrConstructorCallExpression ||
            (node is BoundImportedCallExpression && kind == PrefixCallKind.Member) {
            // A receiver function does not beat a member of an imported type, and a static member of an
            // imported type gets no later overload. A later source type that hides the imported type is not
            // a premise here (#6215). A simple name of an imported static member can be hidden by a later
            // function of this package, so it is not fixed.
            return TypeCanGetMembers(qualifierType)
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
        let qualifierCanGrow = TypeCanGetMembers(qualifierType)
        if !qualifierCanGrow && !OwnerCanGetMembers(function) {
            return false
        }
        if qualifierCanGrow && !object.ReferenceEquals(function.ContainingType, qualifierType) {
            return true
        }
        return !IsExactMatch(function, arguments, syntax)
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
