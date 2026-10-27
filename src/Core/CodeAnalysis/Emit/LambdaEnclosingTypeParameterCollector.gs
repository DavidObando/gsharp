// <copyright file="LambdaEnclosingTypeParameterCollector.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable

/// Walks a lambda body and gathers every
/// (cref:TypeParameterSymbol) it references (through expression types,
/// declared-local types, type arguments, `is`/pattern target types,
/// `typeof`/`sizeof` operands, and an implicit static-owner-type
/// reference). Issue #2118 uses the result to promote non-capturing lambdas
/// to generic static methods; issue #2894 uses it to reify capturing display
/// classes. Nested ordinary lambda bodies are included because the outer
/// lambda materializes their constructed display classes. Mirrors the node
/// coverage of `LambdaBinder.EnclosingTypeParameterReferenceWalker` but
/// accumulates all references instead of stopping at the first.
internal class LambdaEnclosingTypeParameterCollector : BoundTreeWalker {
    private let sink List[TypeParameterSymbol]
    private let getPromotedExtras((FunctionSymbol) -> ImmutableArray[TypeParameterSymbol])?

    private init(
        sink List[TypeParameterSymbol],
        getPromotedExtras((FunctionSymbol) -> ImmutableArray[TypeParameterSymbol])?
    ) {
        this.sink = sink
        this.getPromotedExtras = getPromotedExtras
    }

    override func VisitExpression(node BoundExpression?) {
        if node == nil {
            return
        }
        // Issue #4223: a nested GENERIC local function/lambda's own `.Type`
        // (its delegate/function-literal shape) mentions its OWN declared type
        // parameters, not just any enclosing ones it references. Collecting
        // those unfiltered would falsely promote the OUTER literal as if it
        // referenced them too. Filter them out here; the nested literal's own
        // references to a TRULY enclosing parameter are still visited below —
        // only a non-generic nested literal's body is walked directly, but a
        // generic one's own type parameters can never be enclosing ones by
        // construction, so no legitimate reference is lost.
        if node is BoundFunctionLiteralExpression{Function: {IsGeneric: true}} ownTPLiteral {
            let filtered = List[TypeParameterSymbol]()
            TypeSymbol.CollectReferencedTypeParameters(node.Type, filtered)
            for tp in filtered {
                if !ownTPLiteral.Function.TypeParameters.Contains(tp) {
                    this.sink.Add(tp)
                }
            }
        } else {
            TypeSymbol.CollectReferencedTypeParameters(node.Type, this.sink)
        }
        switch node {
            case BoundLiteralExpression{Value: BoundConstructorCallExpression constructor} {
                TypeSymbol.CollectReferencedTypeParameters(constructor.StructType, this.sink)
            }
            case BoundLiteralExpression{Value: BoundClrConstructorCallExpression constructor} {
                TypeSymbol.CollectReferencedTypeParameters(constructor.Type, this.sink)
            }
            case BoundLiteralExpression{Value: BoundClrPropertyAccessExpression member} {
                this.VisitExpression(member)
            }
            case literal is BoundFunctionLiteralExpression when literal.Function?.IsGeneric != true {
                this.VisitStatement(literal.Body)
            }
            case call is BoundCallExpression {
                // Issue #4223: an implicit-receiver call to a `shared` member
                // of the ENCLOSING generic type (`Public()` inside a method of
                // `Holder[Outer]`, resolving to `Holder[Outer].Public()`)
                // references `Outer` only through the call's static owner
                // type — never through a parameter, return, or method
                // type-argument position. Missing this left `Outer` out of
                // the reified set entirely: confirmed by direct repro, the
                // resulting TypeSpec fell back to encoding `Outer` as a
                // dangling `VAR` slot on the promoted (non-generic-owner)
                // top-level host, `System.BadImageFormatException` at load.
                // Mirrors `LambdaBinder.EnclosingTypeParameterReferenceWalker`'s
                // identical `checkOwners` check.
                if !call.IsConditionalElided {
                    TypeSymbol.CollectReferencedTypeParameters(
                        cast[TypeSymbol?](call.StaticGenericOwnerType) ??
                            call.StaticGenericInterfaceOwnerType ??
                            call
                            .Function
                            .StaticOwnerType,
                        this.sink
                    )
                }
                this.CheckTypeArguments(call.MethodTypeArguments)
                // Issue #4223 (transitive case): a direct call to another
                // zero-capture local function that WAS ITSELF promoted to
                // carry extra enclosing type parameters (this walk runs to a
                // fixed point, so an earlier pass may already have promoted
                // the callee) requires THIS function to carry the same
                // parameters too, purely so its own call site has them to
                // pass — the requirement can be entirely invisible in the
                // call's own argument/return types when the callee only uses
                // the parameter in a body-only position. See
                // UserTokenResolver.GetPromotedExtras.
                if this.getPromotedExtras != nil {
                    for extra in this.getPromotedExtras(call.Function) {
                        this.sink.Add(extra)
                    }
                }
            }
            case userInstanceCall is BoundUserInstanceCallExpression {
                this.CheckTypeArguments(userInstanceCall.MethodTypeArguments)
            }
            case BoundMethodGroupExpression{Function: {} methodGroupFunction} methodGroup {
                TypeSymbol.CollectReferencedTypeParameters(
                    methodGroup.StaticOwnerType ?? methodGroupFunction.StaticOwnerType,
                    this.sink
                )
                this.CheckTypeArguments(methodGroup.MethodTypeArguments)
            }
            case functionPointer is BoundFunctionPointerFromMethodExpression {
                TypeSymbol.CollectReferencedTypeParameters(functionPointer.Method.StaticOwnerType, this.sink)
            }
            case fieldAccess is BoundFieldAccessExpression {
                TypeSymbol.CollectReferencedTypeParameters(
                    cast[TypeSymbol?](fieldAccess.StructType) ?? fieldAccess.InterfaceType,
                    this.sink
                )
            }
            case fieldAssignment is BoundFieldAssignmentExpression {
                TypeSymbol.CollectReferencedTypeParameters(
                    cast[TypeSymbol?](fieldAssignment.StructType) ?? fieldAssignment.InterfaceType,
                    this.sink
                )
            }
            case propertyAccess is BoundPropertyAccessExpression {
                TypeSymbol.CollectReferencedTypeParameters(
                    cast[TypeSymbol?](propertyAccess.StructType) ?? propertyAccess.InterfaceType,
                    this.sink
                )
            }
            case propertyAssignment is BoundPropertyAssignmentExpression {
                TypeSymbol.CollectReferencedTypeParameters(
                    cast[TypeSymbol?](propertyAssignment.StructType) ?? propertyAssignment.InterfaceType,
                    this.sink
                )
            }
            case member is BoundClrPropertyAccessExpression {
                TypeSymbol.CollectReferencedTypeParameters(member.StaticContainerType, this.sink)
                TypeSymbol.CollectReferencedTypeParameters(member.ConstrainedInterfaceType, this.sink)
                TypeSymbol.CollectReferencedTypeParameters(member.ConstrainedReceiverTypeParameter, this.sink)
            }
            case importedCall is BoundImportedCallExpression {
                this.CheckNullableTypeArguments(importedCall.TypeArgumentSymbols)
            }
            case importedInstanceCall is BoundImportedInstanceCallExpression {
                this.CheckNullableTypeArguments(importedInstanceCall.TypeArgumentSymbols)
                if importedInstanceCall.ConstrainedReceiverTypeParameter is {} receiverTypeParameter {
                    TypeSymbol.CollectReferencedTypeParameters(receiverTypeParameter, this.sink)
                }
                if importedInstanceCall.ConstrainedInterfaceType is {} interfaceType {
                    TypeSymbol.CollectReferencedTypeParameters(interfaceType, this.sink)
                }
            }
            case typeOfExpression is BoundTypeOfExpression {
                TypeSymbol.CollectReferencedTypeParameters(typeOfExpression.OperandType, this.sink)
            }
            case sizeOfExpression is BoundSizeOfExpression {
                TypeSymbol.CollectReferencedTypeParameters(sizeOfExpression.MeasuredType, this.sink)
            }
            case constrainedStaticCall is BoundConstrainedStaticCallExpression {
                TypeSymbol.CollectReferencedTypeParameters(constrainedStaticCall.TypeParameter, this.sink)
                this.CheckNullableTypeArguments(constrainedStaticCall.TypeArgumentSymbols)
            }
        }
        base.VisitExpression(node)
    }

    override func VisitPattern(node BoundPattern?) {
        if node == nil {
            return
        }
        TypeSymbol.CollectReferencedTypeParameters(node.Type, this.sink)
        if node is BoundTypePattern typePattern {
            TypeSymbol.CollectReferencedTypeParameters(typePattern.TargetType, this.sink)
        }
        base.VisitPattern(node)
    }

    protected override func VisitVariableDeclaration(node BoundVariableDeclaration) {
        TypeSymbol.CollectReferencedTypeParameters(node.Variable.Type, this.sink)
        base.VisitVariableDeclaration(node)
    }

    private func CheckNullableTypeArguments(typeArguments ImmutableArray[TypeSymbol?]) {
        if typeArguments.IsDefaultOrEmpty {
            return
        }
        for typeArgument in typeArguments {
            TypeSymbol.CollectReferencedTypeParameters(typeArgument, this.sink)
        }
    }

    private func CheckTypeArguments(typeArguments ImmutableArray[TypeSymbol]) {
        if typeArguments.IsDefaultOrEmpty {
            return
        }
        for typeArgument in typeArguments {
            TypeSymbol.CollectReferencedTypeParameters(typeArgument, this.sink)
        }
    }

    shared {
        /// Collects every type parameter referenced anywhere in [`body`](paramref)
        /// into [`sink`](paramref) (order/duplicates are the caller's concern;
        /// (cref:SynthesizedClosureReifier.CollectOrdered) deduplicates and
        /// canonicalizes).
        /// @param body The bound lambda body to walk.
        /// @param sink The accumulator list.
        /// @param getPromotedExtras Issue #4223: optional lookup of a called function's OWN promoted-extra
        /// enclosing type parameters (`UserTokenResolver.GetPromotedExtras`).
        /// A direct call to a callee that was itself promoted to carry enclosing
        /// type parameters requires the CALLER to supply them at the call site —
        /// a requirement invisible in the call's own argument/return types
        /// whenever the callee uses that parameter only in a body-only position
        /// (e.g. an implicit static-owner-type reference, `typeof`, or a
        /// constraint). Passing this lookup lets the caller discover and promote
        /// itself for the same parameters in turn; omitting it (the default)
        /// preserves the pre-#4223 behavior for a caller that does not need it
        /// (a capturing display class's reification, which runs before any
        /// zero-capture promotion in the same pass and so has nothing to look up
        /// yet).
        func Collect(
            body BoundStatement?,
            sink List[TypeParameterSymbol],
            getPromotedExtras((FunctionSymbol) -> ImmutableArray[TypeParameterSymbol])? = nil
        ) {
            if body == nil {
                return
            }
            LambdaEnclosingTypeParameterCollector(sink, getPromotedExtras).VisitStatement(body)
        }
    }
}
