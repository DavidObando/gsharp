// <copyright file="RefCapabilities.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices

internal shared class RefCapabilities {
    private let UnscopedRefPropertyAccessors ConditionalWeakTable[
        Type,
        HashSet[(Module Module, MetadataToken int32)]
    ] = ConditionalWeakTable[Type, HashSet[(Module Module, MetadataToken int32)]]()

    /// Issue #4224: true when [`expression`](paramref) is a ref-returning
    /// call/property node that retains its raw managed reference. This includes
    /// native calls and constrained static-interface calls. Ordinary imported
    /// calls are excluded because (cref:ConversionClassifier.AutoDereferenceRefReturn)
    /// wraps them in a (cref:BoundDereferenceExpression) at bind time.
    /// @param expression The bound expression to classify.
    /// @returns `true` when the expression is such a call/property read.
    internal func IsNativeRefReturningCall(expression BoundExpression) bool -> switch expression {
        case boundCallExpression is BoundCallExpression when boundCallExpression.IsConditionalElided == true: false
        case call is BoundCallExpression: call.Function.ReturnRefKind != RefKind.None
        case uic is BoundUserInstanceCallExpression: uic.Method.ReturnRefKind != RefKind.None
        case baseInterface is BoundBaseInterfaceCallExpression: baseInterface.Method.ReturnRefKind != RefKind.None
        case BoundBaseClassCallExpression{Method: {} method}: method.ReturnRefKind != RefKind.None
        case constrained is BoundConstrainedStaticCallExpression: (
            constrained.InterfaceMethod?.ReturnRefKind ?? GetReturnRefKind(constrained.ClrMethod)
        ) != RefKind.None
        case boundPropertyAccessExpression is BoundPropertyAccessExpression when boundPropertyAccessExpression.NarrowedType != nil: false
        case prop is BoundPropertyAccessExpression: prop.Property.ReturnRefKind != RefKind.None
        default: false
    }

    // CLR getters can retain ref-returning storage even when their bound type is the element type.
    internal func IsRefReturningAccess(expression BoundExpression) bool -> IsNativeRefReturningCall(expression) ||
        switch expression {
        case call is BoundImportedCallExpression: GetReturnRefKind(call.Function.Method) != RefKind.None
        case call is BoundImportedInstanceCallExpression: GetReturnRefKind(call.Method) != RefKind.None
        case call is BoundClrStaticCallExpression: GetReturnRefKind(call.Method) != RefKind.None
        case BoundBaseClassCallExpression{Property: {} property}: property.ReturnRefKind != RefKind.None
        case index is BoundClrIndexExpression: GetReturnRefKind(index.Indexer) != RefKind.None
        case BoundClrPropertyAccessExpression{Member: PropertyInfo property}: GetReturnRefKind(property) != RefKind.None
        default: false
    }

    /// Issue #4224 (root cause #4) / #4265: decomposes a native ref-returning
    /// call or property read into the pieces the caller-side ref-safe-scope
    /// computation (`HasFunctionLocalRefScope`) needs — its instance
    /// receiver (whose storage the callee could be returning a reference
    /// into), the argument expressions passed to `ref`/`in`/
    /// `out` parameters (any of which the callee could likewise be
    /// returning), and — issue #4265 — the argument expressions passed to
    /// by-value BYREF-LIKE (ref struct, e.g. `Span[T]`) parameters,
    /// whose ENCAPSULATED REFERENT (not their own storage) the callee could
    /// be returning through, e.g. `func First(s Span[int32]) ref int32
    /// { return ref s[0] }`. These two argument kinds are kept in
    /// SEPARATE lists rather than merged, because the caller checks them
    /// with different scope semantics (`HasFunctionLocalRefScope` vs.
    /// `HasFunctionLocalReferentScope`) — conflating them would let a
    /// `ref` argument bound to a byref-like value smuggle a dangling
    /// reference through the wrong (too permissive) check. A `scoped`
    /// parameter of any of these three kinds is excluded: the callee's own
    /// signature promises not to return that reference, so the caller's
    /// argument does not contribute to the result's scope.
    /// @param expression The bound expression to decompose.
    /// @param receiver The instance receiver, or `null` for a static/no-receiver call.
    /// @param byRefArguments The underlying storage of each non-`scoped` ref/in/out argument.
    /// @param byValueByRefLikeArguments Each non-`scoped` by-value byref-like argument, unchanged.
    /// @returns `false` when [`expression`](paramref) is not a
    /// native ref-returning call/property (the out parameters are then empty).
    internal func TryGetRefReturnEscapeSources(
        expression BoundExpression,
        out receiver BoundExpression?,
        out byRefArguments ImmutableArray[BoundExpression],
        out byValueByRefLikeArguments ImmutableArray[BoundExpression]
    ) bool {
        switch expression {
            case BoundCallExpression{IsConditionalElided: false} call when call.Function.ReturnRefKind != RefKind.None {
                receiver = nil
                SelectEscapeArguments(
                    call.Function.Parameters,
                    call.Arguments,
                    out byRefArguments,
                    out byValueByRefLikeArguments
                )
                return true
            }
            case uic is BoundUserInstanceCallExpression when uic.Method.ReturnRefKind != RefKind.None {
                receiver = uic.Receiver
                SelectEscapeArguments(
                    uic.Method.Parameters,
                    uic.Arguments,
                    out byRefArguments,
                    out byValueByRefLikeArguments
                )
                return true
            }
            case BoundPropertyAccessExpression{NarrowedType: nil} prop when prop
                .Property
                .ReturnRefKind != RefKind
                .None {
                receiver = prop.Receiver
                byRefArguments = ImmutableArray[BoundExpression].Empty
                byValueByRefLikeArguments = ImmutableArray[BoundExpression].Empty
                return true
            }
            case baseInterface is BoundBaseInterfaceCallExpression when baseInterface
                .Method
                .ReturnRefKind != RefKind
                .None {
                receiver = baseInterface.Receiver
                SelectEscapeArguments(
                    baseInterface.Method.Parameters,
                    baseInterface.Arguments,
                    out byRefArguments,
                    out byValueByRefLikeArguments
                )
                return true
            }
            case BoundBaseClassCallExpression{Method: {} method} baseClass when method.ReturnRefKind != RefKind.None {
                receiver = baseClass.Receiver
                SelectEscapeArguments(
                    method.Parameters,
                    baseClass.Arguments,
                    out byRefArguments,
                    out byValueByRefLikeArguments
                )
                return true
            }
            case BoundConstrainedStaticCallExpression{
                InterfaceMethod: {} method
            } constrained when method.ReturnRefKind != RefKind
                .None {
                receiver = nil
                SelectEscapeArguments(
                    method.Parameters,
                    constrained.Arguments,
                    out byRefArguments,
                    out byValueByRefLikeArguments
                )
                return true
            }
            case BoundConstrainedStaticCallExpression{ClrMethod: {} method} constrained when GetReturnRefKind(
                method
            ) != RefKind
                .None {
                receiver = nil
                SelectEscapeArguments(
                    ImportParameters(method.GetParameters()),
                    constrained.Arguments,
                    out byRefArguments,
                    out byValueByRefLikeArguments
                )
                return true
            }
            case imported is BoundImportedCallExpression when GetReturnRefKind(imported.Function.Method) != RefKind
                .None {
                receiver = nil
                SelectEscapeArguments(
                    ImportParameters(imported.Function.Method.GetParameters()),
                    imported.Arguments,
                    out byRefArguments,
                    out byValueByRefLikeArguments
                )
                return true
            }
            case imported is BoundImportedInstanceCallExpression when GetReturnRefKind(imported.Method) != RefKind
                .None {
                receiver = imported.Receiver
                SelectEscapeArguments(
                    ImportParameters(imported.Method.GetParameters()),
                    imported.Arguments,
                    out byRefArguments,
                    out byValueByRefLikeArguments
                )
                return true
            }
            case imported is BoundClrStaticCallExpression when GetReturnRefKind(imported.Method) != RefKind.None {
                receiver = nil
                SelectEscapeArguments(
                    ImportParameters(imported.Method.GetParameters()),
                    imported.Arguments,
                    out byRefArguments,
                    out byValueByRefLikeArguments
                )
                return true
            }
            default {
                receiver = nil
                byRefArguments = ImmutableArray[BoundExpression].Empty
                byValueByRefLikeArguments = ImmutableArray[BoundExpression].Empty
                return false
            }
        }
    }

    /// ADR-0187 / issue #4350 (the C# scoped-`this` rule): whether the
    /// REF-safe-context of [`receiver`](paramref) contributes to the
    /// reference a ref-returning call or property read hands back.
    /// @remarks Every struct instance member's `this` is implicitly
    /// `scoped ref`, and the binder already enforces the callee side of
    /// that contract: a member that returns a reference into its own receiver
    /// must be `@UnscopedRef` (GS0589). So when the receiver's static
    /// type is a concrete struct — the call then names the implementation it
    /// dispatches to — a member WITHOUT `@UnscopedRef` cannot be the
    /// source of a reference into the receiver's storage, and C# excludes the
    /// receiver from the result's ref-safe-context entirely. Interface
    /// implementations are now held to the same one-way slot contract, so
    /// they cannot add `@UnscopedRef` behind an unannotated interface
    /// member. This helper still recognizes only direct native struct-member
    /// nodes; type-parameter dispatch, imported calls, base calls, and
    /// unrecognized nodes keep the conservative answer.
    /// @param expression The ref-returning call or property read.
    /// @param receiver Its instance receiver.
    /// @returns `true` when the receiver's storage can be the returned reference's source.
    internal func ReceiverContributesRefScope(expression BoundExpression, receiver BoundExpression) bool {
        let member FunctionSymbol? = switch expression {
            case call is BoundUserInstanceCallExpression: call.Method
            case property is BoundPropertyAccessExpression: property.Property.GetterSymbol
            default: default(FunctionSymbol?)
        }
        if member == nil || receiver.Type is not(StructSymbol and {IsClass: false}) {
            return true
        }
        return member.HasUnscopedRef
    }

    internal func DescribeReturn(kind RefKind) string -> if kind == RefKind.RefReadOnly {
        "by ref readonly"
    } else {
        (
            if kind == RefKind.Ref {
                "by ref"
            } else {
                "by value"
            }
        )
    }

    internal func IsReadOnlyReference(expression BoundExpression) bool -> switch expression {
        case boundVariableExpression is BoundVariableExpression when boundVariableExpression.Type is ByRefTypeSymbol ||
            boundVariableExpression.Type is PointerTypeSymbol: false
        case BoundVariableExpression{Variable: LocalVariableSymbol local}: local.RefKind == RefKind.RefReadOnly ||
            local.RefKind == RefKind.In
        case _ is BoundVariableExpression: false
        case block is BoundBlockExpression: IsReadOnlyReference(block.Expression)
        case tuple is BoundTupleElementAccessExpression: IsReadOnlyStorage(tuple) || IsReadOnlyReference(tuple.Receiver)
        case field is BoundFieldAccessExpression: field.Receiver != nil && !Binder.IsReferenceTypeForConstraint(
            field.Receiver.Type
        ) &&
            IsReadOnlyReference(field.Receiver)
        default: IsReadOnlyStorage(expression)
    }

    /// ADR-0184 amendment: the ONE condition under which the emitter replaces a
    /// value-type receiver with a defensive COPY in a function-local temp
    /// (`MethodBodyEmitter.EmitInstanceReceiver`,
    /// `MethodBodyEmitter.EmitConstrainedTypeParameterReceiver`,
    /// `ReflectionMetadataEmitter.NeedsRvalueReceiverSpill`). Any `ref`
    /// a member returns into its OWN receiver storage then points at that temp,
    /// which dies at function exit — so the binder's ref-safe-scope walk must
    /// treat such a forward as function-local
    /// (`StatementBinder.IsDefensivelyCopiedReceiverForwarding`). Before
    /// this helper existed the rule lived as three independently drifting
    /// copies in the emitter and nowhere at all in the binder, which is exactly
    /// how the caller-side dangling-reference hole got in.
    ///
    /// Every caller keeps its own value-type/reference-type guard; this helper
    /// is deliberately ONLY the shared core, so extracting it left the
    /// emitter's behaviour byte-for-byte unchanged.
    ///
    /// [`isReadOnlyMember`](paramref) is structurally `false`
    /// for every native G# member — G# has no `readonly func` — so it
    /// carries information only for CLR metadata members, whose
    /// `IsReadOnlyAttribute` (cref:IsReadOnlyMethod) reads.
    /// @param receiver The instance receiver expression.
    /// @param isReadOnlyMember Whether the called member is itself a `readonly` member.
    /// @returns `true` when the receiver is defensively copied before the call.
    internal func RequiresReadOnlyReceiverDefensiveCopy(
        receiver BoundExpression,
        isReadOnlyMember bool = false
    ) bool -> !isReadOnlyMember &&
        IsReadOnlyReference(receiver)

    internal func IsReadOnlyMethod(method MethodInfo) bool -> method.GetCustomAttributesData().Any(
        (attribute CustomAttributeData) -> attribute
            .AttributeType
            .FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute"
    ) ||
        method
        .DeclaringType
        ?.GetCustomAttributesData()
        .Any(
        (attribute CustomAttributeData) -> attribute
            .AttributeType
            .FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute"
    ) == true

    /// Returns whether an imported method advertises `[UnscopedRef]`.
    /// @param method The imported method.
    /// @returns `true` when the method carries the attribute.
    internal func HasUnscopedRef(method MethodInfo) bool {
        if HasUnscopedRefAttribute(method.GetCustomAttributesData()) {
            return true
        }
        if !IsPropertyAccessor(method) || method.DeclaringType == nil {
            return false
        }
        return UnscopedRefPropertyAccessors.GetValue(
            method.DeclaringType!!,
            (declaringType Type) -> {
                let accessors = HashSet[(Module Module, MetadataToken int32)]()
                for property in ClrTypeUtilities.SafeGetProperties(
                    declaringType,
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
                ) {
                    if !HasUnscopedRefAttribute(property.GetCustomAttributesData()) {
                        continue
                    }
                    if property.GetMethod != nil {
                        accessors.Add((property.GetMethod!!.Module, property.GetMethod!!.MetadataToken))
                    }
                    if property.SetMethod != nil {
                        accessors.Add((property.SetMethod!!.Module, property.SetMethod!!.MetadataToken))
                    }
                }
                return accessors
            }
        )
            .Contains((method.Module, method.MetadataToken))
    }

    internal func IsPropertyAccessor(method MethodInfo) bool {
        if !method.IsSpecialName {
            return false
        }
        let accessorName = method.Name.AsSpan(method.Name.LastIndexOf('.') + 1)
        return accessorName.StartsWith("get_", StringComparison.Ordinal) || accessorName.StartsWith(
            "set_",
            StringComparison.Ordinal
        )
    }

    /// Returns the by-reference kind encoded by an imported parameter.
    /// @param parameter The imported parameter.
    /// @returns The corresponding G# ref kind.
    internal func GetParameterRefKind(parameter ParameterInfo) RefKind -> if !parameter.ParameterType.IsByRef {
        RefKind.None
    } else {
        (
            if parameter.IsOut && !parameter.IsIn {
                RefKind.Out
            } else {
                (
                    if IsInParameter(parameter) && !parameter.IsOut {
                        RefKind.In
                    } else {
                        RefKind.Ref
                    }
                )
            }
        )
    }

    /// Returns whether an imported parameter carries `[ScopedRef]`.
    /// @param parameter The imported parameter.
    /// @returns `true` when the parameter is explicitly scoped.
    internal func IsScoped(parameter ParameterInfo) bool -> parameter.GetCustomAttributesData().Any(
        (attribute CustomAttributeData) -> KnownAttributes.IsScopedRef(attribute.AttributeType)
    )

    /// Returns whether an imported parameter carries `[UnscopedRef]`.
    /// @param parameter The imported parameter.
    /// @returns `true` when the parameter is explicitly unscoped.
    internal func HasUnscopedRef(parameter ParameterInfo) bool -> HasUnscopedRefAttribute(
        parameter.GetCustomAttributesData()
    )

    /// Creates a parameter symbol that preserves imported ref-safety metadata.
    /// @param parameter The imported parameter.
    /// @param type The already-projected parameter type.
    /// @param fallbackName The name to use when metadata has no parameter name.
    /// @returns The imported parameter symbol.
    internal func CreateParameterSymbol(parameter ParameterInfo, type TypeSymbol, fallbackName string) ParameterSymbol {
        let symbol = ParameterSymbol(
            parameter.Name ?? fallbackName,
            type,
            isScoped: IsScoped(parameter),
            refKind: GetParameterRefKind(parameter)
        )
        if !UsesUpdatedEscapeRules(parameter) {
            symbol.MarkLegacyRefSafetyRules()
        }
        if HasUnscopedRef(parameter) {
            symbol.MarkUnscopedRef()
        }
        return symbol
    }

    /// Returns whether two imported parameters expose the same effective ref/value-safety contract.
    /// @param target The target contract parameter.
    /// @param targetType The projected target parameter type.
    /// @param source The source implementation parameter.
    /// @param sourceType The projected source parameter type.
    /// @returns `true` when both effective contracts match.
    internal func ImportedParameterContractsMatch(
        target ParameterInfo,
        targetType TypeSymbol,
        source ParameterInfo,
        sourceType TypeSymbol
    ) bool -> CreateParameterSymbol(target, targetType, "target").HasSameRefContract(
        CreateParameterSymbol(source, sourceType, "source")
    )

    /// Returns whether the imported parameter's module opts into C# 11's
    /// updated ref-safety defaults.
    /// @param parameter The imported parameter.
    /// @returns `true` only for marker version 11.
    internal func UsesUpdatedEscapeRules(parameter ParameterInfo) bool {
        try {
            return parameter
                .Member
                .Module
                .GetCustomAttributesData()
                .Any(
                (attribute CustomAttributeData) -> KnownAttributes.IsRefSafetyRules(attribute.AttributeType) &&
                    attribute
                    .ConstructorArguments
                    .Count == 1 &&
                    attribute
                    .ConstructorArguments[0]
                    .Value is 11
            )
        } catch {
            return false
        }
    }

    /// Issue #4265 soundness guard: true when [`indexer`](paramref) (or
    /// its getter) carries `[UnscopedRef]` (`System.Diagnostics.CodeAnalysis.UnscopedRefAttribute`).
    /// C# accepts the attribute on EITHER the accessor or the property itself
    /// — an expression-bodied indexer (`[UnscopedRef] public ref int this[int i] => ref _value;`)
    /// emits it on the property's own metadata row, not `get_Item`, so
    /// both must be checked (confirmed via `CustomAttributeData` against
    /// a real compiled indexer of each shape — checking only the getter
    /// missed the expression-bodied spelling entirely). (cref:StatementBinder)'s
    /// `BoundClrIndexExpression` case treats a byref-like CLR indexer's
    /// target as encapsulating a caller-supplied REFERENT (like `Span[T]`'s
    /// backing pointer) — safe to forward through a by-value parameter. That
    /// premise fails for an indexer explicitly marked `[UnscopedRef]`:
    /// the CLR author has declared it returns a reference into the
    /// RECEIVER'S OWN storage instead (exactly mirroring what `@UnscopedRef`
    /// signals for a native G# member — see `Binder.cs`'s
    /// `ThisParameter.IsScoped` handling), which a by-value receiver
    /// cannot safely yield. Real C# enforces the same distinction (CS8166:
    /// an `[UnscopedRef]` member invoked through a by-value parameter
    /// is rejected).
    /// @param indexer The resolved CLR indexer property.
    /// @returns `true` when the indexer or its getter carries `[UnscopedRef]`.
    internal func IsUnscopedRefIndexerGetter(indexer PropertyInfo) bool -> HasUnscopedRefAttribute(
        indexer.GetCustomAttributesData()
    ) ||
        HasUnscopedRefAttribute(indexer.GetGetMethod(nonPublic: true)?.GetCustomAttributesData())

    /// The type a method-call argument contributes to type-argument inference
    /// for [`parameter`](paramref).
    ///
    /// ADR-0186 §3, as amended by #4443: a by-value argument whose top level
    /// is `T!` contributes `T`, and the call then coerces it
    /// `T! → T`, which §4 checks. Only the top level is stripped; a
    /// platform position nested in the argument's type is part of an
    /// invariant container's identity and still infers `T!`. A
    /// by-reference argument keeps its exact type, because a `ref` has no
    /// coercion to carry the check. This is the one place that decision is
    /// made for G# callees; every method-call argument site routes through it
    /// or through (cref:GetValueArgumentInferenceType).
    /// @param parameter The parameter the argument binds to.
    /// @param argumentType The argument's type.
    /// @returns The type to unify against the parameter's type.
    internal func GetInferenceType(parameter ParameterSymbol, argumentType TypeSymbol) TypeSymbol {
        if parameter.RefKind != RefKind.None {
            return if argumentType is ByRefTypeSymbol byRef {
                byRef.PointeeType
            } else {
                argumentType
            }
        }
        return GetValueArgumentInferenceType(argumentType)
    }

    /// (cref:GetInferenceType) for a by-value argument with no single
    /// parameter of its own (a variadic element, or a carrier passed through
    /// to a variadic slot): a top-level `T!` contributes `T`.
    /// @param argumentType The argument's type.
    /// @returns The type to unify against the parameter's type.
    internal func GetValueArgumentInferenceType(
        argumentType TypeSymbol
    ) TypeSymbol -> if argumentType is PlatformTypeSymbol platform {
        platform.UnderlyingType
    } else {
        argumentType
    }

    internal func GetReturnRefKind(method MethodInfo?) RefKind {
        if method?.ReturnType.IsByRef != true {
            return RefKind.None
        }
        let parameter = method!!.ReturnParameter
        return if parameter.GetRequiredCustomModifiers().Any(
            (type Type) -> type.FullName == "System.Runtime.InteropServices.InAttribute"
        ) ||
            parameter
            .GetCustomAttributesData().Any(
            (attribute CustomAttributeData) -> attribute
                .AttributeType
                .FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute"
        ) {
            RefKind.RefReadOnly
        } else {
            RefKind.Ref
        }
    }

    internal func GetReturnRefKind(property PropertyInfo) RefKind -> if !property.PropertyType.IsByRef {
        RefKind.None
    } else {
        (
            if GetReturnRefKind(property.GetMethod) == RefKind.RefReadOnly || property.GetRequiredCustomModifiers().Any(
                (type Type) -> type.FullName == "System.Runtime.InteropServices.InAttribute"
            ) ||
                property
                .GetCustomAttributesData().Any(
                (attribute CustomAttributeData) -> attribute
                    .AttributeType
                    .FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute"
            ) {
                RefKind.RefReadOnly
            } else {
                RefKind.Ref
            }
        )
    }

    /// Issue #4400: whether an argument written without a modifier at an
    /// `in` parameter passes its own storage's address (as C# does) —
    /// a variable (not a smart-cast narrowed read, whose storage has another
    /// type; not a compile-time constant; not a reference-type `this`),
    /// an addressable field (not an imported static initonly field), an array
    /// element, a dereference, or a native
    /// ref-returning call. Every other shape is an rvalue and is spilled to a
    /// readonly temp.
    /// @param value The converted argument.
    /// @returns `true` when its address is taken directly.
    internal func IsDirectlyAddressableForImplicitIn(value BoundExpression) bool -> switch value {
        case tuple is BoundTupleElementAccessExpression: IsDirectlyAddressableForImplicitIn(tuple.Receiver)
        case BoundVariableExpression{
            Variable: ParameterSymbol{IsReceiverParameter: true}
        } receiver: !Binder.IsReferenceTypeForConstraint(receiver.Type) && receiver.NarrowedType == nil
        case variable is BoundVariableExpression: (
            variable.NarrowedType == nil || variable.NarrowedType == variable.Variable.Type
        ) &&
            variable.Variable is not(GlobalVariableSymbol and {IsConst: true}) &&
            variable.Variable is not(LocalVariableSymbol and {IsConst: true})
        case boundFieldAccessExpression is BoundFieldAccessExpression when boundFieldAccessExpression
            .Field
            .IsConst == true: false
        case BoundClrPropertyAccessExpression{Member: FieldInfo field} when field.IsLiteral ||
            (field.IsStatic && field.IsInitOnly): false
        case BoundFieldAccessExpression{Receiver: {} receiver}: Binder.IsReferenceTypeForConstraint(receiver.Type) ||
            IsDirectlyAddressableForImplicitIn(receiver)
        case BoundClrPropertyAccessExpression{
            Member: FieldInfo,
            Receiver: {} receiver
        }: Binder.IsReferenceTypeForConstraint(receiver.Type) || IsDirectlyAddressableForImplicitIn(receiver)
        case _ is BoundBlockExpression or _ is BoundConditionalExpression: false
        default: ExpressionBinder.IsLvalue(value)
    }

    internal func IsReadOnlyStorage(expression BoundExpression) bool -> switch expression {
        case BoundVariableExpression{Variable: ParameterSymbol{IsReceiverParameter: true}} receiver: receiver
            .Variable
            .IsReadOnly &&
            Binder.IsReferenceTypeForConstraint(receiver.Type)
        case variable is BoundVariableExpression: variable.Variable.IsReadOnly
        case tuple is BoundTupleElementAccessExpression: IsReadOnlyValueReceiver(tuple.Receiver)
        case block is BoundBlockExpression: IsReadOnlyStorage(block.Expression)
        case conditional is BoundConditionalExpression: IsReadOnlyStorage(conditional.WhenTrue) ||
            IsReadOnlyStorage(conditional.WhenFalse)
        case conditional is BoundConditionalAddressExpression: IsReadOnlyStorage(conditional.WhenTrueOperand) ||
            IsReadOnlyStorage(conditional.WhenFalseOperand)
        case field is BoundFieldAccessExpression: field.Field.IsReadOnly || IsReadOnlyValueReceiver(field.Receiver)
        case address is BoundAddressOfExpression: address.IsReadOnly
        case dereference is BoundDereferenceExpression: IsReadOnlyReference(dereference.Operand)
        case property is BoundPropertyAccessExpression: property
            .Property
            .ReturnRefKind == RefKind.RefReadOnly ||
            (
            property
                .Property
                .ReturnRefKind == RefKind.Ref &&
                IsReadOnlyValueReceiver(property.Receiver) &&
                (property.Receiver == nil || ReceiverContributesRefScope(property, property.Receiver))
        )
        case call is BoundCallExpression: call.Function.ReturnRefKind == RefKind.RefReadOnly
        case call is BoundUserInstanceCallExpression: call
            .Method
            .ReturnRefKind == RefKind.RefReadOnly ||
            (
            call
                .Method
                .ReturnRefKind == RefKind.Ref &&
                IsReadOnlyValueReceiver(call.Receiver) &&
                ReceiverContributesRefScope(call, call.Receiver)
        )
        case call is BoundBaseInterfaceCallExpression: call.Method.ReturnRefKind == RefKind.RefReadOnly
        case call is BoundBaseClassCallExpression: (
            call.Method?.ReturnRefKind ?? call.Property?.ReturnRefKind
        ) == RefKind.RefReadOnly
        case call is BoundConstrainedStaticCallExpression: (
            call.InterfaceMethod?.ReturnRefKind ?? GetReturnRefKind(call.ClrMethod)
        ) == RefKind.RefReadOnly
        case call is BoundImportedCallExpression: GetReturnRefKind(call.Function.Method) == RefKind.RefReadOnly
        case call is BoundImportedInstanceCallExpression: GetReturnRefKind(call.Method) == RefKind.RefReadOnly
        case call is BoundClrStaticCallExpression: GetReturnRefKind(call.Method) == RefKind.RefReadOnly
        case index is BoundClrIndexExpression: GetReturnRefKind(index.Indexer) == RefKind.RefReadOnly
        case BoundClrPropertyAccessExpression{Member: PropertyInfo property}: GetReturnRefKind(
            property
        ) == RefKind.RefReadOnly
        case BoundClrPropertyAccessExpression{Member: FieldInfo field} access: field.IsInitOnly ||
            field.IsLiteral ||
            access.IsReadOnlySubmissionGlobal ||
            IsReadOnlyValueReceiver(access.Receiver)
        default: false
    }

    internal func IsReadOnlyValueReceiver(expression BoundExpression?) bool -> expression != nil &&
        !Binder.IsReferenceTypeForConstraint(expression.Type) && IsReadOnlyStorage(expression)

    internal func IsReadOnlyValueReference(expression BoundExpression) bool -> !Binder.IsReferenceTypeForConstraint(
        expression.Type
    ) &&
        IsReadOnlyReference(expression)

    /// Splits a call's arguments into the two escape-source kinds
    /// (cref:TryGetRefReturnEscapeSources) needs, keeping them in
    /// SEPARATE lists (issue #4265) because the caller checks them with
    /// different scope semantics: [`byRefArguments`](paramref) holds
    /// the operand each `ref`/`in`/`out` parameter whose
    /// effective ref scope can contribute to a return had its address taken
    /// of (checked against its own storage
    /// scope), and [`byValueByRefLikeArguments`](paramref) holds each
    /// non-`scoped` by-value byref-like (e.g. `Span[T]`) argument
    /// unchanged (checked against its ENCAPSULATED REFERENT's scope
    /// instead — see `StatementBinder.HasFunctionLocalReferentScope`).
    /// Conservative on any shape the caller-side scope walk cannot
    /// decompose (a conditional address, a parameter/argument count
    /// mismatch, or a ref/in/out argument that was not itself wrapped in a
    /// (cref:BoundAddressOfExpression)): the unrecognized argument
    /// expression itself is returned unchanged so the recursive
    /// `HasFunctionLocalRefScope` walk's default ("unrecognized shape
    /// is function-local, i.e. unsafe") still applies, rather than silently
    /// treating an undecomposable argument as safe to escape through.
    private func SelectEscapeArguments(
        parameters ImmutableArray[ParameterSymbol],
        arguments ImmutableArray[BoundExpression],
        out byRefArguments ImmutableArray[BoundExpression],
        out byValueByRefLikeArguments ImmutableArray[BoundExpression]
    ) {
        if parameters.IsDefaultOrEmpty || arguments.IsDefaultOrEmpty {
            byRefArguments = ImmutableArray[BoundExpression].Empty
            byValueByRefLikeArguments = ImmutableArray[BoundExpression].Empty
            return
        }
        let refBuilder = ImmutableArray.CreateBuilder[BoundExpression]()
        let byValueBuilder = ImmutableArray.CreateBuilder[BoundExpression]()
        let count = Math.Min(parameters.Length, arguments.Length)
        for var i = 0; i < count; i++ {
            let parameter = parameters[i]
            if parameter.GetEffectiveRefScope() == ParameterRefScope.FunctionLocal {
                continue
            }
            if parameter.RefKind != RefKind.None {
                refBuilder.Add(
                    if arguments[i] is BoundAddressOfExpression addr {
                        addr.Operand
                    } else {
                        arguments[i]
                    }
                )
            } else if TypeSymbol.IsByRefLike(parameter.Type) {
                byValueBuilder.Add(arguments[i])
            }
        }
        byRefArguments = refBuilder.ToImmutable()
        byValueByRefLikeArguments = byValueBuilder.ToImmutable()
    }

    private func ImportParameters(parameters[]ParameterInfo) ImmutableArray[ParameterSymbol] -> parameters.Select(
        (parameter ParameterInfo) -> CreateParameterSymbol(
            parameter,
            ClrNullability.GetParameterTypeSymbol(parameter).StripToBareShape(),
            "arg${parameter.Position}"
        )
    )
        .ToImmutableArray()

    private func HasUnscopedRefAttribute(attributes IEnumerable[CustomAttributeData]?) bool -> attributes?.Any(
        (attribute CustomAttributeData) -> KnownAttributes.IsUnscopedRef(attribute.AttributeType)
    ) == true

    private func IsInParameter(parameter ParameterInfo) bool {
        try {
            return parameter.IsIn || parameter.GetRequiredCustomModifiers().Any(
                (modifier Type) -> modifier.FullName == "System.Runtime.InteropServices.InAttribute"
            )
        } catch {
            return parameter.IsIn
        }
    }
}
