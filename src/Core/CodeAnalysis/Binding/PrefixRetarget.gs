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
    /// Records [`syntax`](paramref) when a later overload, member or receiver function can be a better
    /// candidate for the call that [`bound`](paramref) resolved.
    /// @param syntax The call.
    /// @param kind The callee of the call: (cref:PrefixCallKind.Name) or (cref:PrefixCallKind.Member).
    /// @param bound The bound call.
    func NoteCall(syntax SyntaxNode?, kind PrefixCallKind, bound BoundExpression) {
        if syntax == nil || PrefixBindingContext.Current == nil {
            return
        }
        if !PrefixBindingContext.CanRetarget(syntax.Location, kind) {
            return
        }
        if CanChange(syntax, kind, bound) {
            PrefixBindingContext.AddProvisional(syntax)
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

    // A call whose result no later declaration can change: a conversion, a call of a function value,
    // an imported member, or a candidate that matches each argument exactly. Any other call can change.
    private func CanChange(syntax SyntaxNode, kind PrefixCallKind, bound BoundExpression) bool {
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
        // When the later declarations are kept, only a later local of a function literal's block can change
        // a simple-name call: it can hide the callee (CanRetarget checked the location).
        let laterLocal = kind == PrefixCallKind.Name && !PrefixBindingContext.Current!!.LaterOverloadsPossible
        // A function value has a fixed signature, and a constructor call has the type that it names,
        // whichever `init` a later part adds.
        if node is BoundIndirectCallExpression ||
            node is BoundConversionExpression ||
            node is BoundConstructorCallExpression {
            return laterLocal
        }
        if laterLocal {
            return true
        }
        if node is BoundCallExpression call {
            let function = call.Function
            if function.IsExtension {
                // A later member of an incomplete receiver type beats a receiver function, also an exact one.
                return TypeCanGetMembers(function.ExtensionReceiverType) ||
                    !IsExactMatch(function, call.Arguments, syntax)
            }
            if kind == PrefixCallKind.Name {
                return !IsExactMatch(function, call.Arguments, syntax)
            }
            return OwnerCanGetMembers(function) && !IsExactMatch(function, call.Arguments, syntax)
        }
        if node is BoundUserInstanceCallExpression instance {
            let receiverCanGrow = TypeCanGetMembers(instance.Receiver.Type)
            if !receiverCanGrow && !OwnerCanGetMembers(instance.Method) {
                return false
            }
            // A later member of the receiver type with the same parameters hides an inherited one.
            if receiverCanGrow && !object.ReferenceEquals(instance.Method.ContainingType, instance.Receiver.Type) {
                return true
            }
            return !IsExactMatch(instance.Method, instance.Arguments, syntax)
        }
        if node is BoundImportedInstanceCallExpression ||
            node is BoundClrStaticCallExpression ||
            node is BoundClrConstructorCallExpression ||
            (node is BoundImportedCallExpression && kind == PrefixCallKind.Member) {
            // A receiver function does not beat a member of an imported type, and a static member of an
            // imported type gets no later overload. A later source type that hides the imported type is not
            // a premise here (#6215). A simple name of an imported static member can be hidden by a later
            // function of this package, so it is not fixed.
            return false
        }
        // Each other call can change until it is shown to be fixed.
        return true
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
