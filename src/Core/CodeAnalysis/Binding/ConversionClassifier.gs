// <copyright file="ConversionClassifier.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import System.Globalization
import System.Threading
import System.Threading.Tasks

/// PR-B-3: the binder-side facade that wraps the pure
/// (cref:Conversion.Classify(TypeSymbol, TypeSymbol)) type-pair
/// classifier in the diagnostic-emitting `BindConversion` family,
/// and owns the CLR-parameter conversion, method-group → delegate
/// resolution, ref-kind validation, default-value attachment,
/// optional-argument appending, conditional-ref argument shaping,
/// and user-defined implicit-conversion lookup that previously lived
/// directly on (cref:Binder).
/// @remarks This type is the binder-side wrapper: it consumes
/// (cref:BinderContext) for the diagnostics bag and reference
/// resolver, and (cref:MemberLookup) for delegate-type / member
/// shape probes. It never back-references (cref:Binder); the
/// few callbacks it needs (re-binding a sub-expression, the
/// interpolated-string / function-literal adapters) are injected
/// through narrow (cref:Func{T, TResult}) seams in the
/// constructor.
///
/// The pure value-shaped (cref:Conversion) type in
/// `Conversion.cs` is unchanged and continues to expose the static
/// (cref:Conversion.Classify(TypeSymbol, TypeSymbol)) entry
/// point. This class merely wraps that classifier with the diagnostic
/// emission and bound-tree shaping previously embedded in
/// (cref:Binder).
///
/// The slice-conversion-set-equals-array-conversion-set rule (#570) landed
/// in `Conversion.Classify` (PR 6.5) via a dedicated arm and the
/// `ClrTypeUtilities.ImplementsInterfaceByName` cross-context helper.
/// The lifted `T → T?` conversion (#571) and the related Wave-3
/// architectural fixes from `~/gsharp-bug-overview.md` will land
/// in this class in a follow-up PR after the full Binder decomposition
/// is complete.
internal class ConversionClassifier {
    // Issue #1482: the numeric-primitive set and widening lattice live in the
    // single authoritative `NumericWideningLattice` helper; this facade queries
    // it (via `NumericWideningLattice.IsNumericPrimitive`) instead of carrying a
    // private copy that could drift.
    private let binderCtx BinderContext

    private let memberLookup MemberLookup
    private let bindExpression(ExpressionSyntax) -> BoundExpression
    private let bindExpressionWithTargetType(ExpressionSyntax, TypeSymbol) -> BoundExpression
    private let isFormattableStringTargetType(TypeSymbol) -> bool
    private let bindInterpolatedStringAsFormattable(InterpolatedStringExpressionSyntax, TypeSymbol) -> BoundExpression
    private let createErasedFunctionLiteralAdapter(
        BoundFunctionLiteralExpression,
        FunctionTypeSymbol,
        bool
    ) -> BoundFunctionLiteralExpression
    private let createClrMethodGroupAdapter(BoundClrMethodGroupExpression, FunctionTypeSymbol) -> BoundExpression
    private let createUserMethodGroupAdapter(BoundMethodGroupExpression) -> BoundExpression
    private let getMethodGroupObservableReturnType(FunctionSymbol, TypeSymbol) -> TypeSymbol
    private let isLvalue(BoundExpression) -> bool
    private let getRefKindFromModifier(SyntaxToken?) -> RefKind
    private let refKindToString(RefKind) -> string
    private let bindNativeProtocolConversion(TextLocation, BoundExpression, TypeSymbol) -> BoundExpression
    private let canConvertNativeProtocol(TypeSymbol, TypeSymbol) -> bool
    private let getCurrentFunction() -> FunctionSymbol?

    /// Initializes a new instance of the (cref:ConversionClassifier)
    /// class.
    /// @param binderCtx The shared binder context that exposes the
    /// diagnostics bag and reference resolver.
    /// @param memberLookup The binder-side member-lookup facade used
    /// for delegate-shape probes during method-group → delegate conversion
    /// (the (cref:MemberLookup.TryGetDelegateFunctionType) seam).
    /// @param bindExpression Callback to re-bind a sub-expression
    /// through the still-on-Binder expression-binding entry point.
    /// @param bindExpressionWithTargetType Callback to bind a sub-
    /// expression with a target-type hint (used by
    /// (cref:BindConditionalRefArgument) to bind the condition as
    /// (cref:TypeSymbol.Bool)).
    /// @param isFormattableStringTargetType Callback to test whether
    /// a target type is one of the ADR-0055 Tier 4 formattable-string
    /// shapes (`IFormattable` / `FormattableString`). Kept on
    /// (cref:Binder) because the interpolated-string binder uses
    /// it from multiple non-conversion call sites.
    /// @param bindInterpolatedStringAsFormattable Callback that
    /// performs the ADR-0055 Tier 4 contextual conversion of an
    /// interpolated string to `IFormattable`/`FormattableString`.
    /// @param createErasedFunctionLiteralAdapter Callback that
    /// wraps a function-literal expression in an erased-signature adapter
    /// for the target generic function type. Owned by the lambda binder
    /// (which holds the nested rewriter), surfaced here as a callback.
    /// @param createClrMethodGroupAdapter Callback that wraps a
    /// resolved CLR method group when its exact signature differs from the
    /// structural function target.
    /// @param createUserMethodGroupAdapter Callback that wraps method
    /// groups requiring an ABI adapter in a capturing lambda.
    /// @param getMethodGroupObservableReturnType Callback that widens
    /// an async method's declared result to its emitted Task/ValueTask shape.
    /// @param isLvalue Callback that classifies a bound expression
    /// as an l-value (addressable). Used by the conditional-ref-argument
    /// validator.
    /// @param getRefKindFromModifier Callback that maps a
    /// `ref`/`out`/`in` modifier token to a
    /// (cref:RefKind).
    /// @param refKindToString Callback used only for the
    /// human-readable diagnostic message when an optional parameter
    /// also carries a ref-kind modifier.
    init(
        binderCtx BinderContext,
        memberLookup MemberLookup,
        bindExpression(ExpressionSyntax) -> BoundExpression,
        bindExpressionWithTargetType(ExpressionSyntax, TypeSymbol) -> BoundExpression,
        isFormattableStringTargetType(TypeSymbol) -> bool,
        bindInterpolatedStringAsFormattable(InterpolatedStringExpressionSyntax, TypeSymbol) -> BoundExpression,
        createErasedFunctionLiteralAdapter(
            BoundFunctionLiteralExpression,
            FunctionTypeSymbol,
            bool
        ) -> BoundFunctionLiteralExpression,
        createClrMethodGroupAdapter(BoundClrMethodGroupExpression, FunctionTypeSymbol) -> BoundExpression,
        createUserMethodGroupAdapter(BoundMethodGroupExpression) -> BoundExpression,
        getMethodGroupObservableReturnType(FunctionSymbol, TypeSymbol) -> TypeSymbol,
        isLvalue(BoundExpression) -> bool,
        getRefKindFromModifier(SyntaxToken?) -> RefKind,
        refKindToString(RefKind) -> string,
        bindNativeProtocolConversion(TextLocation, BoundExpression, TypeSymbol) -> BoundExpression,
        canConvertNativeProtocol(TypeSymbol, TypeSymbol) -> bool,
        getCurrentFunction() -> FunctionSymbol?
    ) {
        this.binderCtx = binderCtx ?? throw ArgumentNullException("binderCtx")
        this.getCurrentFunction = getCurrentFunction
        this.memberLookup = memberLookup ?? throw ArgumentNullException("memberLookup")
        this.bindExpression = bindExpression ?? throw ArgumentNullException("bindExpression")
        this.bindExpressionWithTargetType = bindExpressionWithTargetType ??
            throw ArgumentNullException("bindExpressionWithTargetType")
        this.isFormattableStringTargetType = isFormattableStringTargetType ??
            throw ArgumentNullException("isFormattableStringTargetType")
        this.bindInterpolatedStringAsFormattable = bindInterpolatedStringAsFormattable ??
            throw ArgumentNullException("bindInterpolatedStringAsFormattable")
        this.createErasedFunctionLiteralAdapter = createErasedFunctionLiteralAdapter ??
            throw ArgumentNullException("createErasedFunctionLiteralAdapter")
        this.createClrMethodGroupAdapter = createClrMethodGroupAdapter ??
            throw ArgumentNullException("createClrMethodGroupAdapter")
        this.createUserMethodGroupAdapter = createUserMethodGroupAdapter ??
            throw ArgumentNullException("createUserMethodGroupAdapter")
        this.getMethodGroupObservableReturnType = getMethodGroupObservableReturnType ??
            throw ArgumentNullException("getMethodGroupObservableReturnType")
        this.isLvalue = isLvalue ?? throw ArgumentNullException("isLvalue")
        this.getRefKindFromModifier = getRefKindFromModifier ?? throw ArgumentNullException("getRefKindFromModifier")
        this.refKindToString = refKindToString ?? throw ArgumentNullException("refKindToString")
        this.bindNativeProtocolConversion = bindNativeProtocolConversion
        this.canConvertNativeProtocol = canConvertNativeProtocol
    }

    internal func ClassifyArgumentConversion(source TypeSymbol, target TypeSymbol) Conversion {
        if source != TypeSymbol.Null && NativeProtocolOperations.GetProtocol(target) != nil {
            return if canConvertNativeProtocol(source, target) {
                Conversion.Implicit
            } else {
                Conversion.None
            }
        }
        return Conversion.Classify(source, target)
    }

    private prop Diagnostics DiagnosticBag -> binderCtx.Diagnostics

    // ----- Core conversion entry points -----
    /// Binds [`syntax`](paramref) as an expression and converts it to
    /// [`type`](paramref). Mirrors the
    /// (cref:BindConversion(TextLocation, BoundExpression, TypeSymbol, bool, ParameterSymbol))
    /// core overload after delegating to the still-on-(cref:Binder)
    /// expression-binder for the initial bind.
    /// @param syntax The expression syntax to bind and convert.
    /// @param type The target conversion type.
    /// @param allowExplicit When `true`, suppresses
    /// the "implicit conversion required" diagnostic for an explicit-only
    /// classification.
    /// @returns The converted bound expression (or a
    /// (cref:BoundErrorExpression) on failure with diagnostics
    /// already reported).
    func BindConversion(syntax ExpressionSyntax, type TypeSymbol?, allowExplicit bool = false) BoundExpression {
        // Issue #3355: bind a block against its target before converting so
        // target-only trailing forms (`default`, untyped lambdas, branchy
        // expressions) receive their expected type.
        if syntax is BlockExpressionSyntax {
            return bindExpressionWithTargetType(syntax, type!!)
        }
        // ADR-0055 Tier 4: contextual conversion of an interpolated string to
        // IFormattable/FormattableString. Handled here, before eager string
        // lowering, so the format/alignment intent is preserved.
        if syntax is InterpolatedStringExpressionSyntax interpolated && isFormattableStringTargetType(type!!) {
            return bindInterpolatedStringAsFormattable(interpolated, type!!)
        }
        // ADR-0100 / issue #795: bare `default` (no type clause) takes its
        // type from the surrounding target type. The explicit `default(T)`
        // form is bound through the regular dispatcher because its type
        // comes from the type-clause argument and overload resolution
        // should see a typed expression.
        if syntax is DefaultExpressionSyntax defaultExpr && defaultExpr.TypeClause == nil {
            if type == nil || type == TypeSymbol.Error {
                Diagnostics.ReportBareDefaultNoTargetType(defaultExpr.DefaultKeyword.Location)
                return BoundErrorExpression(defaultExpr)
            }
            return BoundDefaultExpression(defaultExpr, type)
        }
        let expression = bindExpression(syntax)
        return BindConversion(syntax.Location, expression, type, allowExplicit)
    }

    /// Binds an explicit ADR-0148 spread projection.
    /// @param diagnosticLocation The source location for conversion diagnostics.
    /// @param expression The spread source.
    /// @param targetType The concrete target type.
    /// @param strict Whether every writable target slot must be covered.
    /// @param explicitValues Explicit target values keyed by exact member name.
    /// @param explicitOrder Explicit member names in lexical evaluation order.
    /// @returns The lowered projection expression.
    func BindStructuralProjection(
        diagnosticLocation TextLocation,
        expression BoundExpression,
        targetType TypeSymbol,
        strict bool,
        explicitValues IReadOnlyDictionary[string, BoundExpression]?,
        explicitOrder ImmutableArray[string]
    ) BoundExpression -> BindStructuralProjectionCore(
        diagnosticLocation,
        expression,
        targetType,
        strict,
        explicitValues,
        explicitOrder,
        constructionSyntax: nil
    )

    func BindStructuralProjection(
        diagnosticLocation TextLocation,
        expression BoundExpression,
        targetType TypeSymbol,
        strict bool,
        explicitValues IReadOnlyDictionary[string, BoundExpression]?,
        explicitOrder ImmutableArray[string],
        constructionSyntax SyntaxNode?
    ) BoundExpression -> BindStructuralProjectionCore(
        diagnosticLocation,
        expression,
        targetType,
        strict,
        explicitValues,
        explicitOrder,
        constructionSyntax
    )

    /// Checks whether an implicit user conversion should outrank structural projection.
    /// @param sourceType The source type.
    /// @param targetType The target type.
    /// @returns `true` when a symbolic or CLR conversion operator applies.
    func HasUserDefinedImplicitConversion(
        sourceType TypeSymbol,
        targetType TypeSymbol
    ) bool -> HasUserDefinedImplicitConversionForTypes(sourceType, targetType)

    /// Core `BindConversion` overload: classifies the conversion from
    /// [`expression`](paramref)'s static type to [`type`](paramref),
    /// surfaces the appropriate diagnostic when the classification is
    /// missing or implicit-only at an explicit target, and produces the
    /// shaped (cref:BoundExpression).
    /// @param diagnosticLocation The location used for reported
    /// diagnostics.
    /// @param expression The bound source expression.
    /// @param type The target conversion type.
    /// @param allowExplicit When `true`, suppresses
    /// the "implicit conversion required" diagnostic for an explicit-only
    /// classification.
    /// @param callParameter The target parameter when binding a call
    /// argument; supplies the call-specific GS0154 diagnostic contract.
    /// @returns The shaped bound expression.
    func BindConversion(
        diagnosticLocation TextLocation,
        expression BoundExpression,
        type TypeSymbol?,
        allowExplicit bool = false,
        callParameter ParameterSymbol? = nil
    ) BoundExpression {
        let result = BindConversionCore(diagnosticLocation, expression, type, allowExplicit, callParameter)
        if !allowExplicit &&
            expression.Type != TypeSymbol.Error &&
            result.Type != TypeSymbol.Error &&
            expression.Type != result.Type &&
            !object
            .ReferenceEquals(result, expression) {
            // The outer conversion owns the original operand even when its
            // implementation builds calls or chains through other conversions.
            result.ImplicitConversionOperand = expression
        }
        return result
    }

    private func BindConversionCore(
        diagnosticLocation TextLocation,
        expression BoundExpression,
        type TypeSymbol?,
        allowExplicit bool,
        callParameter ParameterSymbol?
    ) BoundExpression {
        var expression = expression
        if type != nil && NativeProtocolOperations.GetProtocol(type) != nil &&
            expression.Type != type &&
            expression.Type != TypeSymbol.Error {
            return bindNativeProtocolConversion(diagnosticLocation, expression, type)
        }
        let TryRecoverDeclaredMemberPathConversion = func (
            expression BoundExpression,
            path AccessPath,
            target TypeSymbol,
            @NotNullWhen(true) out declaredRead BoundExpression?
        ) bool {
            let declaredType = MemberLookup.GetDeclaredAccessPathType(path, expression.Type)
            if declaredType is NullableTypeSymbol ||
                declaredType is PlatformTypeSymbol ||
                !Conversion.IsRepresentationPreservingImplicit(declaredType, target) {
                declaredRead = nil
                return false
            }
            declaredRead = switch expression {
                case field is BoundFieldAccessExpression: cast[BoundExpression](
                    BoundFieldAccessExpression(
                        field.Syntax,
                        field.Receiver,
                        field.StructType,
                        field.Field,
                        field.SubstitutedType,
                        narrowedType: nil
                    )
                )
                case property is BoundPropertyAccessExpression: cast[BoundExpression](
                    BoundPropertyAccessExpression(
                        property.Syntax,
                        property.Receiver,
                        property.StructType,
                        property.Property,
                        property.SubstitutedType,
                        narrowedType: nil,
                        property.InterfaceType
                    )
                )
                case property is BoundClrPropertyAccessExpression: cast[BoundExpression](
                    BoundClrPropertyAccessExpression(
                        property.Syntax,
                        property.Receiver,
                        property.Member,
                        declaredType,
                        property.StaticContainerType,
                        property.ConstrainedReceiverTypeParameter,
                        property.ConstrainedInterfaceType,
                        property.IsAddressableStaticField,
                        property.IsReadOnlySubmissionGlobal
                    )
                )
                default: nil
            }
            return declaredRead != nil
        }
        if binderCtx.TryGetBackwardGotoNarrowingPath(expression, out var path, out var narrowedType) &&
            path!!.HasMembers &&
            TryRecoverDeclaredMemberPathConversion(expression, path!!, type!!, out var declaredRead) {
            expression = declaredRead!!
        } else if binderCtx.TryGetBackwardGotoNarrowingPath(expression, out path, out narrowedType) &&
            (
            Invariant.Required(path, "a narrowed conversion has an access path", expression: "path")
                .HasMembers ||
                !BinderContext
                .NarrowedReadChangesRuntimeType(
                path!!.Root.Type,
                Invariant.Required(
                    narrowedType,
                    "a narrowed conversion has a narrowed type",
                    expression: "narrowedType"
                )
            )
        ) &&
            !(type is NullableTypeSymbol) &&
            !(type is PlatformTypeSymbol) {
            binderCtx.TrackBackwardGotoNarrowingUse(
                path!!,
                diagnosticLocation,
                string.Empty,
                BackwardGotoNarrowingUseKind.Conversion,
                type
            )
        }
        if NativeSliceTypes.HaveIncompatibleElements(expression.Type, type) ||
            ManagedReferenceTypes
            .HaveIncompatibleElements(expression.Type, type!!) {
            Diagnostics.ReportCannotConvert(diagnosticLocation, expression.Type, type!!)
            return BoundErrorExpression(expression.Syntax)
        }
        // Issue #1238: a deferred target-typed conditional/if/switch argument
        // placeholder (a BoundErrorExpression retaining the branchy syntax,
        // produced when the branches could not unify without a target type).
        // Re-bind the retained syntax against the now-known target so each
        // branch is target-typed (e.g. a `nil` arm widens to the parameter's
        // nullable type). When the target is missing/in error, re-bind without
        // a target so the original no-common-type diagnostic — suppressed at the
        // deferral point — surfaces. This is the central finalization path that
        // covers every call/constructor argument site routed through
        // BindConversion.
        if ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(expression, out var branchySyntax) {
            if type == nil || type == TypeSymbol.Error || type == TypeSymbol.Void {
                return bindExpression(branchySyntax)
            }
            return bindExpressionWithTargetType(branchySyntax, type)
        }
        // Issue #1018: a throw-expression has the bottom (`never`) type and is
        // implicitly convertible to any target. Return it unwrapped — there is
        // no value to convert, and wrapping it in a BoundConversionExpression
        // would emit a bogus cast after the CIL `throw`.
        if expression.Type == TypeSymbol.Never {
            return expression
        }
        // ADR-0100 / issue #795: a typeless bare-`default` placeholder
        // (produced by ExpressionBinder.BindDefaultExpression when the
        // syntax has no type-clause) takes its concrete type from the
        // target. When the target is missing or itself in error, surface
        // GS0362 instead of the generic "cannot convert ? → ?"
        // diagnostic. The explicit `default(T)` form is already typed and
        // flows through the regular conversion machinery below.
        if expression is BoundDefaultExpression placeholderDefault {
            let barePlaceholder DefaultExpressionSyntax? = placeholderDefault.Syntax as DefaultExpressionSyntax
            if placeholderDefault.Type == TypeSymbol.Error &&
                barePlaceholder != nil &&
                barePlaceholder.TypeClause == nil {
                if type == nil || type == TypeSymbol.Error {
                    Diagnostics.ReportBareDefaultNoTargetType(barePlaceholder.DefaultKeyword.Location)
                    return BoundErrorExpression(barePlaceholder)
                }
                return BoundDefaultExpression(barePlaceholder, type)
            }
        }
        // An error target already has its own declaration/type diagnostic.
        // Leave targetless inference to the declaration binder's dedicated
        // GS0582 path instead of cascading here.
        if type == TypeSymbol.Error &&
            (expression is BoundMethodGroupExpression || expression is BoundClrMethodGroupExpression) {
            return BoundErrorExpression(expression.Syntax)
        }
        if expression is BoundMethodGroupExpression userGroupWithoutDelegateTarget &&
            !(type is FunctionTypeSymbol) &&
            !(type is DelegateTypeSymbol) &&
            !MemberLookup
            .TryGetLambdaTargetFunctionTypeFromSymbol(type!!, out _) {
            return MethodGroupDiagnostics.ReportRequiresTarget(
                Diagnostics,
                userGroupWithoutDelegateTarget,
                diagnosticLocation
            )
        }
        let methodGroupReceiver = switch expression {
            case userGroup is BoundMethodGroupExpression: userGroup.Receiver
            case clrGroup is BoundClrMethodGroupExpression: clrGroup.Receiver
            default: default(BoundExpression?)
        }
        let methodGroupReceiverType TypeSymbol? = if methodGroupReceiver?.Type is ByRefTypeSymbol byRefReceiver {
            byRefReceiver.PointeeType
        } else {
            methodGroupReceiver?.Type
        }
        if methodGroupReceiverType != nil && NativeProtocolSafety.ContainsSavedProtocol(methodGroupReceiverType) {
            Diagnostics.ReportNativeProtocol(
                diagnosticLocation,
                "native-bearing method-group export requires a separately admitted delegate contract"
            )
            return BoundErrorExpression(expression.Syntax)
        }
        if methodGroupReceiverType != nil && TypeSymbol.IsByRefLike(methodGroupReceiverType) {
            Diagnostics.ReportByRefLikeEscape(
                diagnosticLocation,
                methodGroupReceiverType,
                "be captured as a delegate target because that requires boxing the receiver"
            )
            return BoundErrorExpression(nil)
        }
        // Issue #337: a CLR member method group has no fixed type until the
        // target delegate signature drives overload selection. Resolve it here,
        // where the expected type is known, before classifying conversions.
        if expression is BoundClrMethodGroupExpression{ResolvedMethod: nil} clrMethodGroup {
            return BindClrMethodGroupConversion(diagnosticLocation, clrMethodGroup, type!!)
        }
        // ADR-0063 §9: a user-function method group with multiple candidates
        // resolves here against the target delegate/function-type signature.
        // Issue #3505: an ALREADY-resolved group whose function type differs
        // from a native function-type target re-resolves here too, so a
        // reference-variant slot binds the delegate AT the target type — the
        // fall-through path would wrap it in a delegate-to-delegate variance
        // conversion the emitter cannot express.
        if expression is BoundMethodGroupExpression userMethodGroup &&
            (
            userMethodGroup.FunctionType == nil ||
                userMethodGroup
                .Function
                ?.ReturnRefKind != RefKind.None ||
                HasByRefDelegateReturn(type!!) ||
                (
                type is FunctionTypeSymbol targetFn &&
                    HasReferenceVariantSlotMismatch(userMethodGroup.FunctionType, targetFn)
            )
        ) {
            return BindUserMethodGroupConversion(diagnosticLocation, userMethodGroup, type!!)
        }
        if expression is BoundFunctionLiteralExpression expressionTreeLiteral &&
            MemberLookup
            .TryGetExpressionTreeDelegateTypeFromSymbol(type, out var expressionTreeDelegateType) {
            if !MemberLookup.TryGetDelegateFunctionTypeFromSymbol(
                expressionTreeDelegateType!!,
                out var expressionTreeTargetFunction
            ) {
                Diagnostics.ReportExpressionTreeTargetMustBeDelegate(diagnosticLocation, type!!)
                return BoundErrorExpression(nil)
            }
            // Issue #3518: expression-tree returns initially retain a lambda's
            // natural body shape. Rebind only when its return needs a
            // user-defined implicit conversion so LambdaBinder can choose the
            // target return and EmitTrailingExpression can materialize it.
            if expressionTreeLiteral.Syntax is LambdaExpressionSyntax lambdaSyntax &&
                expressionTreeLiteral.FunctionType is FunctionTypeSymbol sourceFunction &&
                sourceFunction.ReturnType != expressionTreeTargetFunction.ReturnType &&
                HasUserDefinedImplicitConversionForTypes(
                sourceFunction.ReturnType,
                expressionTreeTargetFunction.ReturnType
            ) {
                return bindExpressionWithTargetType(lambdaSyntax, type!!)
            }
            ExpressionTreeRestrictionValidator.Validate(expressionTreeLiteral, type!!, Diagnostics)
            return BoundConversionExpression(nil, type!!, expressionTreeLiteral)
        }
        if expression is BoundFunctionLiteralExpression refContractLiteral {
            GetMethodGroupTargetRefKinds(
                type!!,
                refContractLiteral.Function.Parameters.Length,
                out var targetReturnKind
            )
            if refContractLiteral.Function.ReturnRefKind != targetReturnKind {
                Diagnostics.ReportCannotConvert(diagnosticLocation, expression.Type, type!!)
                return BoundErrorExpression(expression.Syntax)
            }
        }
        if HasDelegateParameterRefKindMismatch(type!!, expression) {
            if callParameter == nil {
                Diagnostics.ReportCannotConvert(diagnosticLocation, expression.Type, type!!)
            } else {
                ReportCallArgumentConversionFailure(diagnosticLocation, callParameter, type!!, expression.Type)
            }
            return BoundErrorExpression(expression.Syntax)
        }
        var resolvedUserMethodGroup BoundMethodGroupExpression? = expression as BoundMethodGroupExpression
        if resolvedUserMethodGroup != nil && !MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(type, out _) {
            resolvedUserMethodGroup = BoundMethodGroupExpression(
                resolvedUserMethodGroup.Syntax,
                resolvedUserMethodGroup.Receiver,
                Invariant.Required(
                    resolvedUserMethodGroup.Function,
                    "a resolved method group has a function",
                    expression: "resolvedUserMethodGroup.Function"
                ),
                Invariant.Required(
                    resolvedUserMethodGroup.FunctionType,
                    "a resolved method group has a function type",
                    expression: "resolvedUserMethodGroup.FunctionType"
                ),
                resolvedUserMethodGroup.StaticOwnerType,
                resolvedUserMethodGroup.MethodTypeArguments
            ){ForceNonVirtualDispatch = resolvedUserMethodGroup.ForceNonVirtualDispatch, HasTargetDelegateType = true}
            expression = this.createUserMethodGroupAdapter(resolvedUserMethodGroup)
        }
        if expression is BoundFunctionLiteralExpression literal &&
            type is FunctionTypeSymbol targetFunctionType &&
            TypeSymbol
            .ContainsTypeParameter(targetFunctionType) {
            return createErasedFunctionLiteralAdapter(literal, targetFunctionType, false)
        }
        // Issue #2716: a throw-expression lambda naturally has a `never`
        // result. Shape its synthesized method to the target result type; the
        // body still throws and therefore needs no value conversion.
        if expression is BoundFunctionLiteralExpression neverCandidateLiteral {
            let neverCandidateFnType FunctionTypeSymbol? = neverCandidateLiteral.FunctionType as FunctionTypeSymbol
            if neverCandidateFnType != nil &&
                neverCandidateFnType.ReturnType == TypeSymbol.Never &&
                MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(type!!, out var neverTargetFnType) &&
                !object.ReferenceEquals(neverTargetFnType!!.ReturnType, TypeSymbol.Never) && Conversion.Classify(
                neverCandidateFnType,
                neverTargetFnType!!
            )
                .IsImplicit {
                let shaped = createErasedFunctionLiteralAdapter(neverCandidateLiteral, neverTargetFnType!!, false)
                if !object.ReferenceEquals(shaped, neverCandidateLiteral) {
                    return BindConversion(diagnosticLocation, shaped, type, allowExplicit, callParameter)
                }
            }
        }
        // Issue #889: a `func`/arrow literal whose natural return type carries a
        // value (e.g. `() -> called = called + 1`, inferred as `() -> int32`)
        // converts to a void-returning delegate target (System.Action, a named
        // void delegate, or a `(...) -> void` function type) by discarding the
        // trailing value — mirroring the `func() { ... }` statement-body form
        // that already yields void. Void-ize the literal through the erased
        // adapter (which now drops the return value), then continue the
        // conversion against the real delegate target.
        if expression is BoundFunctionLiteralExpression voidCandidateLiteral {
            let voidCandidateFnType FunctionTypeSymbol? = voidCandidateLiteral.FunctionType as FunctionTypeSymbol
            if voidCandidateFnType != nil &&
                voidCandidateFnType.ReturnType != TypeSymbol.Void &&
                voidCandidateFnType.ReturnType != TypeSymbol.Error &&
                MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(type!!, out var voidTargetFnType) &&
                voidTargetFnType!!.ReturnType == TypeSymbol.Void &&
                voidTargetFnType!!.Arity == voidCandidateFnType.Arity &&
                !object
                .ReferenceEquals(type, voidCandidateFnType) {
                let voidized = createErasedFunctionLiteralAdapter(voidCandidateLiteral, voidTargetFnType!!, false)
                if !object.ReferenceEquals(voidized, voidCandidateLiteral) {
                    return BindConversion(diagnosticLocation, voidized, type, allowExplicit, callParameter)
                }
            }
        }
        // Issue #1150: a `func`/arrow literal whose natural numeric return type
        // implicitly, losslessly widens to the target delegate's return type
        // (e.g. `(x int32) -> uint16(x)` flowing into a `Func<int32,int64>`
        // slot) is reshaped through the erased adapter so the produced delegate
        // is created over a method whose return type already matches the target
        // — inserting the widening conversion in the adapter body. This mirrors
        // C#'s implicit numeric conversion of a lambda body to an expected
        // delegate return type. Without it the literal would materialize as a
        // narrower-returning delegate flowing into a wider delegate slot.
        if expression is BoundFunctionLiteralExpression widenCandidateLiteral {
            let widenCandidateFnType FunctionTypeSymbol? = widenCandidateLiteral.FunctionType as FunctionTypeSymbol
            if widenCandidateFnType != nil &&
                widenCandidateFnType.ReturnType != TypeSymbol.Void &&
                widenCandidateFnType.ReturnType != TypeSymbol.Error &&
                MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(type!!, out var widenTargetFnType) &&
                widenTargetFnType!!.ReturnType != TypeSymbol.Void &&
                widenTargetFnType!!.ReturnType != TypeSymbol.Error &&
                widenTargetFnType!!.Arity == widenCandidateFnType.Arity &&
                !object.ReferenceEquals(widenCandidateFnType.ReturnType, widenTargetFnType!!.ReturnType) &&
                IsNumericReturnWideningCore(widenCandidateFnType.ReturnType, widenTargetFnType!!.ReturnType) {
                let widened = createErasedFunctionLiteralAdapter(widenCandidateLiteral, widenTargetFnType!!, false)
                if !object.ReferenceEquals(widened, widenCandidateLiteral) {
                    return BindConversion(diagnosticLocation, widened, type, allowExplicit, callParameter)
                }
            }
        }
        if expression is BoundFunctionLiteralExpression adaptedCandidateLiteral {
            let adaptedCandidateFnType FunctionTypeSymbol? = adaptedCandidateLiteral.FunctionType as FunctionTypeSymbol
            if adaptedCandidateFnType != nil &&
                adaptedCandidateFnType.ReturnType != TypeSymbol.Void &&
                adaptedCandidateFnType.ReturnType != TypeSymbol.Error &&
                MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(type!!, out var adaptedTargetFnType) &&
                adaptedTargetFnType!!.ReturnType != TypeSymbol.Void &&
                adaptedTargetFnType!!.ReturnType != TypeSymbol.Error &&
                adaptedTargetFnType!!.Arity == adaptedCandidateFnType.Arity &&
                !object.ReferenceEquals(adaptedCandidateFnType.ReturnType, adaptedTargetFnType!!.ReturnType) &&
                !IsNumericReturnWideningCore(adaptedCandidateFnType.ReturnType, adaptedTargetFnType!!.ReturnType) &&
                Conversion
                .Classify(adaptedCandidateFnType.ReturnType, adaptedTargetFnType!!.ReturnType).IsImplicit {
                let adapted = createErasedFunctionLiteralAdapter(adaptedCandidateLiteral, adaptedTargetFnType!!, true)
                if !object.ReferenceEquals(adapted, adaptedCandidateLiteral) {
                    return BindConversion(diagnosticLocation, adapted, type, allowExplicit, callParameter)
                }
            }
        }
        // Issues #3518/#4741: lift a same-compilation value conversion S -> T
        // to S? -> T?, including reference results. The conversion node owns
        // the effective result type and the shared null-bypass decision.
        if expression.Type is NullableTypeSymbol liftedSource &&
            TryResolveLiftedUserDefinedSymbolConversion(
            liftedSource,
            type!!,
            allowExplicit,
            out var liftedMethod,
            out var liftedOwner
        ) {
            return BoundClrConversionCallExpression(nil, expression, liftedMethod!!, liftedOwner, type!!)
        }
        var conversion = Conversion.Classify(expression.Type, type!!)
        if !conversion.Exists && allowExplicit && Conversion.HasCheckedReferenceConversion(expression.Type, type) {
            conversion = Conversion.Explicit
        }
        // Issue #1183: C# §10.2.11 implicit constant expression conversion.
        // A *constant* integer expression (an integer literal, or unary +/-
        // applied to one) whose value lies within the target integer type's
        // range converts implicitly — no cast required — even when the
        // type-pair classification above is only an explicit (narrowing)
        // conversion (e.g. `uint8 x = 42`, `int16 s = 100`, `int8 a = -5`).
        // The value is re-materialised as a literal of EXACTLY the target type
        // (so emit produces a correctly-typed constant). Out-of-range constants
        // are NOT adapted (TryAdaptIntegerLiteral fails), so they keep flowing
        // through the explicit-only path below and remain an error unless an
        // explicit cast is requested. Identity/already-implicit (widening)
        // conversions are left untouched so existing behaviour is preserved.
        if !conversion.IsImplicit && ExpressionBinder.TryAdaptConstantInteger(
            expression,
            type,
            out var adaptedConstant,
            out var integerType
        ) {
            // Adapt the constant before the ordinary value-nullable lift (#5414).
            return BindConversion(
                diagnosticLocation,
                BoundLiteralExpression(expression.Syntax, adaptedConstant, integerType),
                type,
                allowExplicit,
                callParameter
            )
        }
        // Issue #4350: a tuple literal can be contextually convertible even
        // when its natural tuple TYPE is not. Preserve the literal elements so
        // per-element binding can apply implicit constant narrowing before a
        // general tuple conversion would spill them into non-constant ItemN
        // reads. Identity tuple conversions (including label warnings) have
        // already returned above.
        if !conversion.Exists &&
            expression is BoundTupleLiteralExpression sourceTupleLiteral &&
            type is TupleTypeSymbol targetTupleLiteral &&
            sourceTupleLiteral
            .Elements
            .Length == targetTupleLiteral
            .Arity {
            return BindTupleConversion(
                diagnosticLocation,
                expression,
                sourceTupleLiteral.TupleType,
                targetTupleLiteral,
                allowExplicit
            )
        }
        if !conversion.Exists {
            // Issue #3907: the target parameter is annotated `@AllowNull`, so
            // a `T?` argument is exactly what it declares itself willing to
            // receive. See AcceptsNilAnnotatedArgument for why this is
            // annotation-only and why it cannot reshape the emitted call.
            if AcceptsNilAnnotatedArgument(callParameter, expression.Type, type) {
                return expression
            }
            // Issue #1017: a user-defined conversion operator declared on a
            // same-package struct/class is modelled as a static op_Implicit /
            // op_Explicit FunctionSymbol — those types have no reflectible
            // ClrType during binding, so resolve them symbolically first.
            if TryResolveUserDefinedSymbolConversion(
                expression.Type,
                type,
                allowExplicit,
                out var userConvOp,
                out var userConvOwner
            ) {
                return BindUserDefinedSymbolConversion(
                    diagnosticLocation,
                    expression,
                    type!!,
                    userConvOp,
                    userConvOwner,
                    allowExplicit
                )
            }
            // Stream E: fall back to a user-defined op_Implicit (and
            // op_Explicit when allowed) on either source or target CLR type.
            // Issue #4350: a conversion between symbolic generics (`Span[T]` ->
            // `ReadOnlySpan[T]`) resolves on the open definition first; the
            // CLR branch below would pick the erased `<object>` operator.
            if TryResolveSymbolicImportedConversion(expression.Type, type, out var symbolicConvMethod) &&
                (
                allowExplicit || BoundClrConversionCallExpression.CanApplyImplicitClrConversion(
                    expression.Type,
                    type!!,
                    symbolicConvMethod!!
                )
            ) {
                return BoundClrConversionCallExpression(nil, expression, symbolicConvMethod!!, type!!)
            }
            if expression
                .Type
                ?.ClrType != nil &&
                type?.ClrType != nil &&
                ClrOperatorResolution.TryResolveConversionForTypes(
                expression.Type,
                type,
                allowExplicit,
                out var convMethod,
                out var isExplicit
            ) &&
                (
                allowExplicit || BoundClrConversionCallExpression.CanApplyImplicitClrConversion(
                    expression.Type,
                    type!!,
                    convMethod!!
                )
            ) {
                return BoundClrConversionCallExpression(nil, expression, convMethod!!, type!!)
            }
            if expression.Type is {} sourceType &&
                type is {} targetType &&
                sourceType != TypeSymbol.Error &&
                targetType != TypeSymbol
                .Error {
                if !conversion.IsInvariantArgumentMismatch && !StructuralProjectionPlanner.TryCreate(
                    sourceType,
                    targetType,
                    strict: true,
                    explicitMemberNames: nil,
                    out _,
                    out var projectionFailure
                ) &&
                    !string
                    .IsNullOrEmpty(projectionFailure) {
                    Diagnostics.ReportStructuralProjectionFailure(
                        diagnosticLocation,
                        sourceType,
                        targetType,
                        projectionFailure!!
                    )
                } else {
                    if callParameter == nil {
                        Diagnostics.ReportCannotConvert(diagnosticLocation, sourceType, targetType)
                    } else {
                        ReportCallArgumentConversionFailure(diagnosticLocation, callParameter, targetType, sourceType)
                    }
                }
            }
            return BoundErrorExpression(nil)
        }
        if !allowExplicit && conversion.IsExplicit {
            if callParameter == nil {
                Diagnostics.ReportCannotConvertImplicitly(diagnosticLocation, expression.Type, type!!)
            } else {
                ReportCallArgumentConversionFailure(diagnosticLocation, callParameter, type!!, expression.Type)
            }
        }
        if conversion.IsIdentity {
            // ADR-0172 (as amended by issue #3643): same-shape tuples
            // differing only in element names are identity-convertible.
            // Warn (GS0541) only when the source is a tuple LITERAL whose
            // explicit `name:` label disagrees with the name the target
            // declares at that position — mirroring C#'s CS8123. Converting
            // a named-tuple-typed VALUE to a differently-named target is
            // silent: names are metadata over the positional shape.
            if expression is BoundTupleLiteralExpression &&
                expression.Type is TupleTypeSymbol identitySourceTuple &&
                type is TupleTypeSymbol identityTargetTuple &&
                !object.ReferenceEquals(identitySourceTuple, identityTargetTuple) &&
                identitySourceTuple.HasNames &&
                identityTargetTuple
                .HasNames {
                for var i = 0; i < identitySourceTuple.Arity; i++ {
                    let sourceName string? = identitySourceTuple.ElementNames[i]
                    let targetName string? = identityTargetTuple.ElementNames[i]
                    if sourceName != nil && targetName != nil && !string.Equals(
                        sourceName,
                        targetName,
                        StringComparison.Ordinal
                    ) {
                        Diagnostics.ReportTupleElementNameMismatch(diagnosticLocation, sourceName, targetName)
                    }
                }
            }
            return expression
        }
        // ADR-0186 §4: the coercion check. `Conversion.Classify` already
        // decided whether this pairing is "a platform value into a
        // destination whose declared type is a non-null reference type", so
        // this site does not re-derive it — the one place the rule is stated
        // is the classifier, and every call site that funnels through
        // `BindConversion` (a declared-type `let`/`var`, a field or property
        // store, an array/slice element store, an `out`/`ref` target, a call
        // argument — INCLUDING an extension method's receiver, which is
        // argument 0 — a `return`, a `throw` operand, a `lock` subject and a
        // `foreach` source) inherits it for free.
        if conversion.RequiresPlatformNilCheck {
            return BindPlatformCoercionCheck(diagnosticLocation, expression, type!!)
        }
        // Issues #2732/#5400: extract the nullable value before conversion and async hoisting.
        // The shared unwrap throws InvalidOperationException for a missing value.
        if expression.Type is NullableTypeSymbol sourceNullable && NullableLifting.IsAnyValueTypeNullable(
            sourceNullable
        ) &&
            type is not NullableTypeSymbol &&
            !Conversion.IsReferenceLikeTarget(type!!) && Conversion.ClassifyNonStructural(
            sourceNullable.UnderlyingType,
            type!!
        )
            .Exists {
            let unwrap = Invariant.Required(
                BoundUnaryOperator.Bind(SyntaxKind.BangBangToken, expression.Type),
                "nullable-to-underlying conversion has a bound bang-bang operator",
                expression: "BoundUnaryOperator.Bind(SyntaxKind.BangBangToken, expression.Type)"
            )
            return BindConversion(
                diagnosticLocation,
                BoundUnaryExpression(nil, unwrap, expression){IsConversionUnwrap = true},
                type,
                allowExplicit: true,
                callParameter
            )
        }
        if conversion.IsStructuralProjection {
            if TryResolveUserDefinedSymbolConversion(
                expression.Type,
                type,
                allowExplicit,
                out var projectionUserConvOp,
                out var projectionUserConvOwner
            ) {
                return BindUserDefinedSymbolConversion(
                    diagnosticLocation,
                    expression,
                    type!!,
                    projectionUserConvOp,
                    projectionUserConvOwner,
                    allowExplicit
                )
            }
            if TryResolveSymbolicImportedConversion(expression.Type, type, out var projectionSymbolicConvMethod) &&
                (
                allowExplicit || BoundClrConversionCallExpression.CanApplyImplicitClrConversion(
                    expression.Type,
                    type!!,
                    projectionSymbolicConvMethod!!
                )
            ) {
                return BoundClrConversionCallExpression(nil, expression, projectionSymbolicConvMethod!!, type!!)
            }
            if expression
                .Type
                ?.ClrType != nil &&
                type?.ClrType != nil &&
                ClrOperatorResolution.TryResolveConversionForTypes(
                expression.Type,
                type,
                allowExplicit,
                out var projectionConvMethod,
                out _
            ) &&
                (
                allowExplicit || BoundClrConversionCallExpression.CanApplyImplicitClrConversion(
                    expression.Type,
                    type!!,
                    projectionConvMethod!!
                )
            ) {
                return BoundClrConversionCallExpression(nil, expression, projectionConvMethod!!, type!!)
            }
            // Issue #3218: a nullable annotation over a reference-like target
            // (e.g. an imported method's `System.Uri?` parameter) is
            // metadata-only — the projection constructs the bare underlying
            // type, and the `T → T?` widening is a representation-preserving
            // no-op both engines already lower. The planner itself only
            // understands concrete targets, so unwrap before planning and
            // re-wrap the projected value to keep the bound tree's type honest.
            // ADR-0186: a platform target (`Person!`, routine for a slot
            // declared in an ADR-0186 §9 oblivious scope) is unwrapped the
            // same way — the projected value is never nil.
            let projectionTargetType = if type is NullableTypeSymbol projectionNullableTarget &&
                Conversion.IsReferenceLikeTarget(projectionNullableTarget.UnderlyingType) {
                projectionNullableTarget.UnderlyingType
            } else {
                (
                    if type is PlatformTypeSymbol projectionPlatformTarget {
                        projectionPlatformTarget.UnderlyingType
                    } else {
                        Invariant.Required(
                            type,
                            "conversion targets are established before structural projection",
                            expression: "type"
                        )
                    }
                )
            }
            let projected = BindStructuralProjectionCore(
                diagnosticLocation,
                expression,
                projectionTargetType,
                strict: true,
                explicitValues: nil,
                explicitOrder: default(ImmutableArray[string]),
                constructionSyntax: nil
            )
            return if object.ReferenceEquals(projectionTargetType, type) || projected is BoundErrorExpression {
                projected
            } else {
                cast[BoundExpression](
                    BoundConversionExpression(
                        nil,
                        Invariant.Required(
                            type,
                            "conversion targets are established before structural projection",
                            expression: "type"
                        ),
                        projected
                    )
                )
            }
        }
        // Issue #367: a by-ref-like (`ref struct`) value boxes when converted to
        // a reference type (`object`, an interface, a delegate base, etc.), which
        // the CLR forbids. The `(string)span` form is excluded: it lowers to a
        // `ToString()` call rather than a box. Identity conversions (ref struct to
        // the same ref struct) already returned above.
        if TypeSymbol.IsByRefLike(expression.Type) && type != TypeSymbol.String && Conversion.IsReferenceLikeTarget(
            type!!
        ) &&
            expression.Type != TypeSymbol
            .Error {
            Diagnostics.ReportByRefLikeEscape(
                diagnosticLocation,
                expression.Type,
                "be boxed or converted to the reference type '$type'"
            )
            return BoundErrorExpression(nil)
        }
        // Issue #504: lower `nil → Nullable<value-type>` to a
        // BoundDefaultExpression of the target Nullable<T>. Value-type
        // Nullable<T> is a CLR struct distinct from T; emitting `ldnull`
        // against a `valuetype System.Nullable<T>` slot produces invalid IL
        // ("Common Language Runtime detected an invalid program"). The
        // default-expression emit path materialises `default(Nullable<T>)`
        // via a pre-allocated `ldloca/initobj/ldloc` slot, which is the
        // verifiable representation of a missing-value Nullable<T>. The
        // reference-type Nullable<T> case (e.g. `nil → string?`) still
        // shares the CLR representation of `T` and is fine emitting `ldnull`,
        // so it continues through the normal BoundConversionExpression path
        // below.
        //
        // Issue #814 / ADR-0084 §L5: the same lowering also applies when the
        // underlying type is an open type parameter — for `[T struct]` the
        // representation is `Nullable<!!T>` (which requires `initobj`), and
        // for `[T class]` an open `T` slot is verifier-strict (the C#
        // compiler also emits `ldloca; initobj !!T` instead of `ldnull`
        // even with a `class` constraint, since `ldnull → !!T` is rejected
        // by ECMA-335 stack typing). Routing both constraint kinds through
        // BoundDefaultExpression produces uniformly verifiable IL.
        //
        // Issue #4027: the BARE (unwrapped) open type parameter needs exactly
        // the same lowering, and #814 reached only the `T?` spelling. A
        // reference-constrained `[T class]` slot accepts `nil` — that is
        // deliberate (#2354), and `Conversion.IsNilAssignableWithoutNullableWrapper`
        // is the predicate that admits it — but the ARGUMENT was still emitted
        // as a bare `ldnull`, whose stack type is `Nullobjref` where the slot's
        // signature type is `!!T`. ECMA-335 III.1.8.1.3 has no rule that lets a
        // null reference match a generic-parameter slot, constraint or no
        // constraint, so ILVerify reported
        // `[StackUnexpected] [found Nullobjref] [expected value 'T']` for every
        // sink (argument, local initialiser, assignment, return, and the `!T`
        // form on a generic class's own member). Measured: `csc` emits
        // `ldloca.s N; initobj !!T; ldloc.N` for C#'s `Takes<T>(null)` under
        // `where T : class`, and that output verifies — so this mirrors the
        // reference implementation rather than inventing a shape. `default(T)`
        // is also the right MEANING: for a `[T class]` slot it is the null
        // reference in every instantiation, so the `nil` still arrives.
        if expression.Type == TypeSymbol.Null &&
            (
            type is TypeParameterSymbol ||
                (
                type is NullableTypeSymbol nilTargetNullable &&
                    (
                    NullableLifting.IsAnyValueTypeNullable(nilTargetNullable) ||
                        nilTargetNullable.UnderlyingType is TypeParameterSymbol
                )
            )
        ) {
            return BoundDefaultExpression(nil, type!!)
        }
        // Issue #1256: element-wise tuple conversion lowering. When the source
        // and target are tuple types of the same arity and the classifier above
        // accepted a non-identity (implicit) tuple conversion, the underlying
        // `ValueTuple<…>` instantiations differ at the CLR level, so a direct
        // reinterpret is not verifiable IL. Lower the conversion into a tuple
        // literal whose elements are the per-element converted accesses of the
        // source. The source is evaluated exactly once (spilled into a temp
        // local when it is not already a tuple literal), and each element flows
        // through `BindConversion` recursively so it picks up the correct
        // element conversion (reference upcast no-op, boxing, numeric widening,
        // nullable-reference upcast, …). The emitter then materialises this as a
        // normal `newobj ValueTuple<…>` over the converted element values.
        if expression.Type is TupleTypeSymbol sourceTuple &&
            type is TupleTypeSymbol targetTuple &&
            sourceTuple.Arity == targetTuple.Arity {
            return BindTupleConversion(diagnosticLocation, expression, sourceTuple, targetTuple, allowExplicit)
        }
        // Issue #1881: a conversion bound inside a `checked(...)`/`checked { }`
        // context traps on narrowing overflow via the emitter's `conv.ovf.*`
        // opcodes (and the interpreter's checked numeric convert) instead of
        // truncating. Harmless for non-numeric / widening conversions, which
        // never consult the flag.
        return BoundConversionExpression(nil, type!!, expression, binderCtx.IsCheckedContext)
    }

    // ----- CLR parameter / argument conversions -----
    /// Issue #506 / ADR-0056: rebinds positional arguments whose declared
    /// CLR parameter type needs an actual IL-visible conversion (boxing,
    /// numeric coercion, func→delegate materialisation, ...). Returns the
    /// input array unchanged when no rebinding is required.
    /// @param arguments The source-order bound arguments.
    /// @param parameters The resolved CLR method's parameter list.
    /// @param call The originating call expression (used for argument-
    /// site diagnostic locations).
    /// @param parameterMapping Optional per-source-argument → parameter
    /// index map for named-argument call shapes.
    /// @param receiverArgCount Number of leading argument slots
    /// reserved for a synthesised receiver (0 for plain calls, 1 for
    /// imported extension calls).
    /// @param method Optional resolved CLR method whose declaring type
    /// may be a constructed generic with symbolic user-defined type
    /// arguments (ADR-0087 §3 R5 / issue #765). When supplied alongside
    /// [`receiverType`](paramref), parameter targets whose open-def
    /// position is a generic type parameter substitute to the receiver's
    /// symbolic argument so an identity argument (a user-defined struct
    /// passed to `List[Box[int32]]::Add`) is not boxed at the bind
    /// boundary.
    /// @param receiverType Optional receiver type carrying the
    /// symbolic type arguments referenced by [`method`](paramref)'s
    /// declaring generic.
    /// @param symbolicMethodTypeArgs Optional symbolic method
    /// type-argument vector (issue #1471). Recovers the real parameter type for
    /// a bare `default` argument when a method type-argument erased to the
    /// reference-context `object` placeholder (e.g.
    /// `Task.FromResult[T?](default)`).
    /// @param parameterTypeOverrides Optional symbolic parameter types
    /// keyed by resolved parameter index. Constructed generic constructors use
    /// this to retain delegate targets such as `Func<Foo>` when
    /// reflection exposes only the erased `Func<object>` shape.
    /// @param expandedParamsIndex The parameter index whose already
    /// converted expanded elements were packed into a synthesized array, or
    /// `-1` when the call was not expanded.
    /// @param parameterArgumentLocations Original source locations keyed
    /// by parameter index after expanded named arguments were reordered.
    /// @returns The (possibly rebound) argument array.
    func BindClrParameterConversions(
        arguments ImmutableArray[BoundExpression],
        parameters[]ParameterInfo,
        call CallExpressionSyntax?,
        parameterMapping ImmutableArray[int32] = default(ImmutableArray[int32]),
        receiverArgCount int32 = 0,
        method MethodInfo? = nil,
        receiverType TypeSymbol? = nil,
        symbolicMethodTypeArgs ImmutableArray[TypeSymbol?] = default(ImmutableArray[TypeSymbol?]),
        parameterTypeOverrides IReadOnlyDictionary[int32, TypeSymbol]? = nil,
        expandedParamsIndex int32 = -1,
        parameterArgumentLocations ImmutableArray[TextLocation?] = default(ImmutableArray[TextLocation?])
    ) ImmutableArray[BoundExpression] {
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < arguments.Length; i++ {
            let paramIndex = if parameterMapping.IsDefault {
                i
            } else {
                parameterMapping[i]
            }
            let argument = arguments[i]
            var rebound = argument
            if paramIndex < parameters.Length {
                let parameterType = parameters[paramIndex].ParameterType
                // Issue #1391: an untyped `default` literal (bound as a
                // BoundDefaultExpression with the Error sentinel type) survives
                // overload resolution against an imported method via the
                // DefaultLiteralArgumentType wildcard. Materialize it here at the
                // resolved (substituted) parameter type so the emitter lowers it
                // to the correct typed default — `default(int32)` = 0 for
                // `Task.FromResult[int32](default)` — instead of leaking an
                // Error-typed default that produces invalid IL.
                if !parameterType.IsByRef &&
                    argument is BoundDefaultExpression{Type: var defType} &&
                    defType == TypeSymbol
                    .Error {
                    // Issue #1471: a generic-method call closed over an open
                    // type parameter (e.g. `Task.FromResult[T?](default)` for an
                    // unconstrained `T`) erases its method type-argument to the
                    // reference-context `object` placeholder, so the closed CLR
                    // parameter type is `object` and `default` would lower to a
                    // `BoundDefaultExpression(object)` → `ldnull`. For an open
                    // `T` (or `T?` over an open `T`) that is unverifiable and
                    // throws `InvalidProgramException` at runtime. Recover the
                    // symbolic parameter type from the method's type-argument
                    // vector so the default lowers against the real type
                    // parameter and emits the verifiable `ldloca; initobj; ldloc`
                    // slot shape uniformly for ref and value instantiations.
                    let defSubstituted TypeSymbol? = TrySubstituteParameterTypeFromReceiver(
                        method,
                        paramIndex,
                        receiverType,
                        symbolicMethodTypeArgs
                    ) ??
                        TrySubstituteParameterTypeFromMethodTypeArgs(method, paramIndex, symbolicMethodTypeArgs)
                    let defTargetType TypeSymbol? = defSubstituted ??
                        GetClrParameterTargetType(argument.Type, parameters[paramIndex])
                    if defTargetType != nil && defTargetType != TypeSymbol.Error {
                        rebound = BoundDefaultExpression(argument.Syntax, defTargetType)
                    }
                } else if IsImplicitInClrArgument(argument, parameters[paramIndex]) {
                    // Issue #4400: a plain argument at an imported `in`
                    // parameter is converted to the pointee type and passed
                    // by readonly reference, as in C#.
                    let sourceIndex = i - receiverArgCount
                    let location = if !parameterArgumentLocations.IsDefault &&
                        paramIndex < parameterArgumentLocations.Length &&
                        parameterArgumentLocations[paramIndex] is {} mappedLocation {
                        mappedLocation
                    } else {
                        (
                            if call != nil && sourceIndex >= 0 && sourceIndex < call.Arguments.Count {
                                call.Arguments[sourceIndex].Location
                            } else {
                                call?.Location ?? default(TextLocation)
                            }
                        )
                    }
                    var inPointeeOverride TypeSymbol? = nil
                    parameterTypeOverrides?.TryGetValue(paramIndex, out inPointeeOverride)
                    let inPointee = inPointeeOverride ??
                        GetImplicitInClrPointeeType(
                        parameters[paramIndex],
                        paramIndex,
                        method,
                        receiverType,
                        symbolicMethodTypeArgs,
                        argument
                    )
                    rebound = if TryRejectClrPlatformContainerArgument(
                        argument,
                        parameters[paramIndex],
                        inPointee,
                        location,
                        out var rejectedArgument
                    ) {
                        rejectedArgument
                    } else {
                        BindImplicitInArgument(location, argument, inPointee, parameter: nil)
                    }
                } else if !parameterType.IsByRef &&
                    (
                    argument.Type != TypeSymbol.Error || ClrOverloadResolution.IsUnresolvedMethodGroupArgument(argument)
                ) {
                    // ADR-0087 §3 R5 / issue #765: when the call dispatches
                    // through a constructed CLR generic whose type arguments
                    // include user-defined symbolic types (e.g. xs.Add(...)
                    // where xs: List[Box[int32]] and Box is user-defined),
                    // the parameter's open-def type may be a generic type
                    // parameter slot. The closed CLR shape erases that slot
                    // to System.Object, but at emit the receiver materialises
                    // a TypeSpec for `List<Box`1<int32>>` whose Add(!0) really
                    // accepts a Box[int32]. Substitute receiver type-args
                    // into the open parameter so an identity argument is not
                    // boxed at the bind boundary (which would leave a
                    // verifier-rejecting `box T → !0 expected value` IL
                    // sequence at the call site).
                    var substituted TypeSymbol? = nil
                    if parameterTypeOverrides != nil {
                        parameterTypeOverrides.TryGetValue(paramIndex, out substituted)
                    }
                    if substituted == nil {
                        substituted = TrySubstituteParameterTypeFromReceiver(
                            method,
                            paramIndex,
                            receiverType,
                            symbolicMethodTypeArgs
                        )
                    }
                    // Issue #1512/#2643: a function-typed argument bound to a
                    // generic method's delegate parameter (e.g.
                    // `Func<Task,TResult>`) must convert
                    // to the SYMBOLIC delegate target recovered from the method's
                    // inferred type arguments (`Func<Task,T>`), not the closed CLR
                    // erasure (`Func<Task,object>`). Converting to the erased shape
                    // rebinds the literal's return to `object`, so the emitted
                    // delegate is `Func<Task,object>` and fails ilverify at the
                    // call's `newobj`. Only applied to function-literal arguments
                    // so non-lambda argument coercion is unaffected.
                    // Issue #2347: an unresolved method group (deferred through
                    // overload resolution the same way a lambda is deferred, see
                    // ClrOverloadResolution.IsUnresolvedMethodGroupArgument) needs
                    // the identical symbolic-target recovery — its resolved
                    // MethodInfo is picked below against whichever delegate
                    // target is recovered here, so a generic method whose
                    // delegate parameter closes over the method's own (still
                    // open) type argument must see the symbolic shape too.
                    if substituted == nil &&
                        (
                        argument.Type is FunctionTypeSymbol || ClrOverloadResolution.IsUnresolvedMethodGroupArgument(
                            argument
                        )
                    ) {
                        substituted = TrySubstituteParameterTypeFromMethodTypeArgs(
                            method,
                            paramIndex,
                            symbolicMethodTypeArgs
                        )
                    }
                    // Issue #1540: recover an ERASED open type-parameter slot
                    // whose receiver type argument is itself a bare type
                    // parameter (e.g. `List[T].Add(!0)` compiled INSIDE the
                    // generic method that declares `T`). `TrySubstituteParameter
                    // TypeFromReceiver` above deliberately bails for a bare
                    // type-parameter receiver arg (its #765 filter only rewrites
                    // user symbolic types), so the closed CLR parameter stays
                    // erased to `object`. Left alone, the new #1540 `T -> object`
                    // implicit rule would classify the argument as a boxing
                    // conversion and inject a spurious `box T` before the call,
                    // reproducing the #1196 invalid-IL regression. Recovering the
                    // real `T` slot here makes the argument `T -> T` identity
                    // (no conversion node, no box), byte-identical to today.
                    // A GENUINE `object` slot (real `System.Object` parameter, or
                    // a `List[object]` whose `!0` maps to `object`) is NOT a type
                    // parameter, so this recovery returns null and the argument
                    // still boxes correctly.
                    //
                    // Issue #2117: the same erased-`object` slot recovery is
                    // required when the argument is `T?` — a `NullableTypeSymbol`
                    // over an unconstrained/reference type parameter — not just a
                    // bare `T`. For an unconstrained `T`, the `?` annotation is a
                    // static-only nullability marker: `T?` shares `T`'s CLR
                    // representation (there is no `Nullable<T>` box because `T`
                    // may close to a reference type), so `default(T?)` must flow
                    // into the reified generic slot IDENTICALLY to `default(T)`.
                    // Without recovering the real `T?` slot here, the closed CLR
                    // parameter stays erased to `object`, the `T? -> object`
                    // implicit rule classifies the argument as a boxing
                    // conversion, and a spurious `box !T` is emitted ahead of a
                    // call whose symbolically re-closed signature (`FromResult<!T>
                    // (!!0)`) expects the raw value — the ilverify StackUnexpected
                    // ("found ref 'T' expected value 'T'") reported in #2117. The
                    // recovered `T?` slot makes the argument `T? -> T?` identity
                    // (no conversion node, no box), byte-identical to the working
                    // `default(T)` control. A value-type-constrained `[T struct]`
                    // (where `T?` genuinely IS `Nullable<T>`) is likewise reified
                    // over the real slot, so its proper nullable default is
                    // preserved; a GENUINE `object` slot still recovers null and
                    // boxes correctly.
                    if substituted == nil &&
                        (
                        argument.Type is TypeParameterSymbol ||
                            (argument.Type is NullableTypeSymbol and {UnderlyingType: TypeParameterSymbol})
                    ) {
                        // The erased `object` slot may originate either from the
                        // receiver's generic type arguments (`List[T].Add(!0)`)
                        // or from the method's OWN type arguments — e.g. a static
                        // generic call `Enumerable.Repeat[T](v, n)` whose element
                        // parameter `TSource` closes over the enclosing open `T`.
                        // Both present as `System.Object` at the raw CLR signature
                        // level, so recover the real `T` slot from whichever
                        // applies, keeping the argument `T -> T` identity (no box).
                        substituted = TrySubstituteParameterTypeFromMethodTypeArgs(
                            method,
                            paramIndex,
                            symbolicMethodTypeArgs
                        ) ??
                            TryRecoverReceiverTypeParameterSlot(method, paramIndex, receiverType)
                    }
                    // Issue #1819: the argument may already be bound to a
                    // CONCRETE same-compilation user type (struct/enum,
                    // possibly `Nullable<T>`-wrapped) rather than a bare
                    // `TypeParameterSymbol` — e.g. `Task.FromResult(Pt(42))`
                    // where `Pt` is a same-compilation struct. The closed CLR
                    // method still erases the generic slot to `object`
                    // (same-compilation user types have no CLR backing yet),
                    // but the call is re-instantiated at emit over the REAL
                    // symbolic type argument recovered from
                    // `symbolicMethodTypeArgs` (see
                    // `BoundImportedCallExpression.TypeArgumentSymbols` and its
                    // consumer `GetMethodEntityHandle`), which produces a
                    // MethodSpec closed over the real value/enum type — e.g.
                    // `Task<Pt>::FromResult<Pt>(!!0)`. Left unrecovered, the
                    // erased `object` target below classifies the argument as
                    // a boxing conversion and inserts a `box Pt` ahead of a
                    // call whose actual (symbolically re-closed) signature
                    // expects the raw value on the stack — an ilverify
                    // StackUnexpected ("found ref 'Pt' expected value 'Pt'")
                    // at the call site, and the identical class of bug for
                    // any consumer of the awaited/returned result (a local,
                    // a field, a member-access receiver, or a `??` operand)
                    // since the erroneous `box` already corrupted the value
                    // flowing out of the call/await before it ever reaches
                    // those consumers.
                    if substituted == nil && TypeSymbol.IsSameCompilationUserTypeTopLevel(argument.Type) {
                        substituted = TrySubstituteParameterTypeFromMethodTypeArgs(
                            method,
                            paramIndex,
                            symbolicMethodTypeArgs
                        )
                    }
                    // Issue #3982 / ADR-0174 D2: the #1819 arm above recovers
                    // the erased slot when the ARGUMENT ITSELF is the
                    // same-compilation type that erased it. A channel is the
                    // same erasure one level in: `chan[Pair]` presents as
                    // `Chan<object>`, so the generic slot of a
                    // `CountSoFar[T](this ChannelReader[T])` closed to
                    // `ChannelReader<object>` — and unlike #1819's case the
                    // argument's own top-level type is an imported
                    // `Chan[Pair]`, so none of the arms above fire. Left
                    // unrecovered the target stays `ChannelReader[object]`,
                    // the D2 lattice correctly refuses it on the element, no
                    // conversion node is produced, and the raw `Chan<Pair>` is
                    // pushed at a call whose MethodSpec — closed over the REAL
                    // `Pair` recovered by `InferSymbolicMethodTypeArguments` —
                    // wants a `ChannelReader<Pair>`: ilverify StackUnexpected
                    // at the call site, with no `get_Reader` in sight. Recover
                    // the real slot so the argument converts against
                    // `ChannelReader[Pair]` and the view is emitted, exactly as
                    // it already is for a `chan[int32]` where nothing erased.
                    if substituted == nil && ChannelTypeSymbol.TryGetChannelShape(
                        argument.Type,
                        out var channelArgumentElement,
                        out _,
                        out _
                    ) &&
                        (
                        TypeSymbol.ContainsTypeParameter(channelArgumentElement!!) ||
                            TypeSymbol.ContainsSameCompilationUserType(channelArgumentElement!!)
                    ) {
                        substituted = TrySubstituteParameterTypeFromMethodTypeArgs(
                            method,
                            paramIndex,
                            symbolicMethodTypeArgs
                        )
                    }
                    // Issue #4000: a TUPLE is the same erasure as the channel
                    // arm above, one level in. A G# `(int32, T)` IS a
                    // `System.ValueTuple<int32, T>` (ADR-0158 identity), but an
                    // open element leaves the candidate's CLOSED parameter type
                    // erased to `ValueTuple<int32, object>` — and the argument's
                    // own top-level type is a `TupleTypeSymbol`, so none of the
                    // arms above fire. Unlike the map sibling of the same call
                    // — `Dictionary<K, V>` has no element-wise rebuild path, so
                    // `Conversion` says None, the argument is left alone, and
                    // the raw value it pushes happens to be right — a tuple DOES
                    // have one: the conversion machinery faithfully rebuilt the
                    // tuple at the erased target (`box !!T; newobj
                    // ValueTuple<int32, object>`) and handed it to a MethodSpec
                    // closed over the REAL `T`, which wants
                    // `ValueTuple<int32, !!0>`. That is correct machinery aimed
                    // at the wrong shape: ILVerify StackUnexpected, and the
                    // program still prints the right answer, which is what made
                    // it invisible. Recovering the real slot makes the argument
                    // `(int32, T) -> (int32, T)` identity — no rebuild, no box —
                    // exactly as it already is where nothing erased.
                    //
                    // The recovery is asked for EVERY tuple-shaped argument,
                    // not only one whose own elements are symbolic. Review
                    // feedback on #4019 found the mirror of the reported case,
                    // measured and confirmed: inside
                    // `func bad[T](pair (int32, object))`,
                    // `Probes.FirstOf[T](pair)` kept the erased
                    // `(int32, object)` target — which here is also the
                    // argument's own type, so the conversion is identity and
                    // NOTHING is rebuilt — and pushed it straight at a
                    // MethodSpec wanting `ValueTuple<int32, !!0>`. Same
                    // `StackUnexpected`, reached from the concrete side. The
                    // question that decides both is what the SLOT is, not what
                    // the argument is, so the argument-shape test was the wrong
                    // guard.
                    //
                    // Widening it costs nothing where the slot is concrete:
                    // `TrySubstituteParameterTypeFromMethodTypeArgs` returns
                    // null unless the mapped parameter still
                    // `ContainsTypeParameter` or
                    // `ContainsSameCompilationUserType`, so a fully closed
                    // `FirstOf[string]((9, "z"))` recovers `(int32, string)`,
                    // fails that test, and falls through to
                    // `GetClrParameterTargetType` exactly as before. What it
                    // adds is the refusal #3984 and #3987 already reach in the
                    // constructor and `: base(...)` positions — a tuple whose
                    // element does not match the target's type argument has no
                    // runtime conversion to emit, so `(int32, object)` at a
                    // `(int32, T)` slot now reports `GS0155` instead of
                    // emitting IL that does not verify.
                    if substituted == nil && argument.Type is TupleTypeSymbol {
                        substituted = TrySubstituteParameterTypeFromMethodTypeArgs(
                            method,
                            paramIndex,
                            symbolicMethodTypeArgs,
                            allowConcreteSymbolic: TypeSymbol.ContainsNullLiteralType(argument.Type)
                        )
                    }
                    // #4451 (ADR-0193 amendment): a slot that IS a method type
                    // parameter bound to a platform type (an explicit argument
                    // at an oblivious declaration) is `T!`, and takes a nil
                    // unchecked. The closed CLR parameter says only `string`.
                    if substituted == nil &&
                        method != nil &&
                        method.IsGenericMethod == true &&
                        symbolicMethodTypeArgs is {IsDefaultOrEmpty: false} methodTypeArguments &&
                        (
                        if method.IsGenericMethodDefinition {
                            method
                        } else {
                            method.GetGenericMethodDefinition()
                        }
                    )
                        .GetParameters()[paramIndex]
                        .ParameterType is {IsGenericParameter: true, DeclaringMethod: not nil} openSlot &&
                        openSlot.GenericParameterPosition < methodTypeArguments.Length &&
                        methodTypeArguments[openSlot.GenericParameterPosition] is PlatformTypeSymbol platformSlot {
                        substituted = platformSlot
                    }
                    // Issue #4440: even a fully CLR-backed receiver needs the
                    // shared receiver/method projection here. Reflection
                    // exposes List<string>.Add as an oblivious string
                    // parameter, while the open slot substituted with the
                    // receiver's T is the declared non-null string argument.
                    if i >= receiverArgCount && method != nil && TypeSymbol.ContainsNullLiteralType(argument.Type) &&
                        MemberLookup.GetClrMethodParameterConversionTargetTypeSymbol(
                        receiverType,
                        method,
                        paramIndex,
                        symbolicMethodTypeArgs
                    ) is {} nilTarget {
                        substituted = nilTarget
                    }
                    let methodSlot TypeSymbol? = substituted ??
                        TrySubstituteParameterTypeFromMethodTypeArgs(method, paramIndex, symbolicMethodTypeArgs)
                    let requiresRuntimeContract = substituted == nil &&
                        methodSlot != nil &&
                        !Conversion.HasClrArgumentRuntimeRelation(argument.Type, methodSlot)
                    if requiresRuntimeContract {
                        substituted = methodSlot
                    }
                    // CLR applicability has already decided reference annotations;
                    // reification must still reject a genuinely different runtime shape.
                    let targetType = substituted ??
                        methodSlot ??
                        GetClrParameterTargetType(argument.Type, parameters[paramIndex])
                    let rejectionTargetType = substituted ??
                        TrySubstituteParameterTypeFromMethodTypeArgs(
                        method,
                        paramIndex,
                        symbolicMethodTypeArgs,
                        allowConcreteSymbolic: true
                    ) ??
                        targetType
                    // Issue #2142 (follow-up to #2130/#2139): a lambda/arrow
                    // literal flowing into an imported method's
                    // `Expression<Func<…>>` parameter must be routed through
                    // `BindConversion`, which lowers it to an expression tree
                    // (#2139). The general `Conversion.Classify` gate below does
                    // NOT recognise a function-literal → `Expression<TDelegate>`
                    // conversion (that classification lives only inside
                    // `BindConversion` itself), so without this the argument was
                    // left as a bare `Func<…>` delegate and either mismatched the
                    // parameter (verifier failure) or, for imported generic-class
                    // instance methods whose delegate depends on the receiver's
                    // class type argument, caused the candidate to be dropped
                    // entirely (GS0159). Scoping the routing to this imported-call
                    // site keeps the same-compilation user-method path (which has
                    // its own expression-tree handling) unchanged.
                    let isExpressionTreeLiteralTarget = argument is BoundFunctionLiteralExpression &&
                        MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(targetType, out _)
                    // Issue #2347: an unresolved method group's natural type is
                    // the Error sentinel (see
                    // ClrOverloadResolution.IsUnresolvedMethodGroupArgument), so
                    // Conversion.Classify below — which deliberately treats
                    // Error as convertible to nothing, to avoid cascading
                    // diagnostics — never reports it as convertible to the
                    // resolved delegate parameter. Route it through
                    // BindConversion directly instead: that is exactly the
                    // mechanism (ConversionClassifier.BindClrMethodGroupConversion
                    // / BindUserMethodGroupConversion) that picks the single
                    // MethodInfo/function overload matching targetType's
                    // Invoke signature, the same way it already does for a
                    // user-defined generic function's method-group argument.
                    let isMethodGroupTarget = (argument is BoundMethodGroupExpression or BoundClrMethodGroupExpression)
                    let parameterConversion = Conversion.Classify(argument.Type, targetType)
                    let rejectionSourceIndex = i - receiverArgCount
                    let rejectionLocation = if !parameterArgumentLocations.IsDefault &&
                        paramIndex < parameterArgumentLocations.Length &&
                        parameterArgumentLocations[paramIndex] is {} mappedLocation {
                        mappedLocation
                    } else {
                        (
                            if call != nil && rejectionSourceIndex >= 0 && rejectionSourceIndex < call.Arguments.Count {
                                call.Arguments[rejectionSourceIndex].Location
                            } else {
                                call?.Location ?? default(TextLocation)
                            }
                        )
                    }
                    if substituted != nil && TypeSymbol.ContainsNullLiteralType(argument.Type) &&
                        argument is BoundTupleLiteralExpression &&
                        targetType is TupleTypeSymbol {
                        let sourceIndex = i - receiverArgCount
                        let location = if call != nil && sourceIndex >= 0 && sourceIndex < call.Arguments.Count {
                            call.Arguments[sourceIndex].Location
                        } else {
                            call?.Location ?? default(TextLocation)
                        }
                        rebound = BindContextualOpenLiteral(location, argument, targetType)
                    } else if argument.Type != targetType &&
                        parameterConversion.IsExplicit &&
                        TryApplyUserDefinedImplicitArgumentConversion(argument, targetType, out var implicitArg) {
                        rebound = implicitArg
                    } else if argument.Type != targetType &&
                        (parameterConversion.Exists || isExpressionTreeLiteralTarget || isMethodGroupTarget) &&
                        !IsNaturalStructuralDelegateTarget(argument.Type, targetType) &&
                        (
                        NeedsBindClrParameterConversion(argument.Type, parameterType, substituted) ||
                            parameterConversion.RequiresPlatformNilCheck
                    ) {
                        // Issue #506: the source-argument list may not align with
                        // the bound-argument list when a synthesised receiver
                        // occupies leading slots (imported extension calls) or
                        // when params expansion has replaced N positional source
                        // args with one synthesised array. Fall back to the
                        // overall call location when the source slot is absent.
                        let sourceIndex = i - receiverArgCount
                        let location = if call != nil && sourceIndex >= 0 && sourceIndex < call.Arguments.Count {
                            call.Arguments[sourceIndex].Location
                        } else {
                            call?.Location ?? default(TextLocation)
                        }
                        // Issue #4012: `allowExplicit: true` is this path's
                        // standing leniency — a CLR argument slot accepts a
                        // conversion the author did not write, because
                        // applicability already ranked the candidate on shapes
                        // and refusing here would only produce a worse
                        // diagnostic. A G#-native `[N]T` target is the one slot
                        // where that leniency erases the very fact #3998 made
                        // part of the type: `[4]Foo -> [3]Foo` is EXPLICIT by
                        // design (the `cast[[3]Foo](…)` reinterprets and does
                        // not resize), so applying it silently accepts an
                        // argument of the wrong length at
                        // `List[[3]Foo]().Add(…)` and hands the receiver a
                        // four-element array. The pair with a CLR-backed
                        // element (`[4]int32` at `[3]int32`) never reached this
                        // arm at all — `NeedsBindClrParameterConversion` sees
                        // one `int32[]` on both sides and says "nothing to do",
                        // so it fell to the #2391 arm below and reported
                        // GS0156. Withdrawing the leniency for a fixed-array
                        // target makes the two spellings agree on GS0156, and
                        // the cast the diagnostic names is still available.
                        // Only a `[N]T` target is affected; a target recovered
                        // from reflection is never an `ArrayTypeSymbol`
                        // (metadata records no length — #3962's
                        // `ContainsMetadataRecoveredArray` line), so this
                        // cannot fire on an interop slot.
                        let allowExplicitArgument = !parameterConversion.IsStructuralProjection &&
                            !(targetType is ArrayTypeSymbol) &&
                            !requiresRuntimeContract
                        rebound = BindConversion(location, argument, targetType, allowExplicit: allowExplicitArgument)
                    } else if argument.Type != targetType &&
                        TryApplyUserDefinedImplicitArgumentConversion(argument, targetType, out var udcArg) {
                        // Issue #1459: the resolved parameter type is reachable
                        // only through a user-defined / BCL `op_Implicit` (e.g.
                        // `[]uint8 -> System.ReadOnlySpan[uint8]`,
                        // `Span[uint8] -> ReadOnlySpan[uint8]`,
                        // `Memory[T] -> ReadOnlyMemory[T]`). Built-in
                        // conversions classify above and never reach this
                        // fallback, so existing imported-call overloads keep
                        // selecting unchanged; this only inserts the missing
                        // `op_Implicit` call (as a BoundClrConversionCallExpression)
                        // that the emitter already knows how to lower, mirroring
                        // the user-function argument-coercion path. Without it
                        // the emitter pushed the source type directly and
                        // produced unverifiable IL at imported call sites.
                        rebound = udcArg
                    } else if paramIndex != expandedParamsIndex &&
                        TryRejectClrPlatformContainerArgument(
                        argument,
                        parameters[paramIndex],
                        rejectionTargetType,
                        rejectionLocation,
                        out var rejectedArgument
                    ) {
                        rebound = rejectedArgument
                    } else if substituted != nil &&
                        argument.Type != targetType &&
                        !IsNaturalStructuralDelegateTarget(argument.Type, targetType) &&
                        (
                        !(
                            argument is BoundFunctionLiteralExpression ||
                                ClrOverloadResolution.IsUnresolvedMethodGroupArgument(argument)
                        ) ||
                            !MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(targetType, out _)
                    ) {
                        // Issue #2391: overload resolution necessarily sees the
                        // receiver's erased CLR signature, but conversion must
                        // still honor the symbolic closed parameter recovered
                        // above. Do not silently pass an unrelated source type
                        // merely because both types share the same erasure
                        // (for example Other? and Color? both riding through
                        // Nullable<Int32>).
                        let sourceIndex = i - receiverArgCount
                        let location = if call != nil && sourceIndex >= 0 && sourceIndex < call.Arguments.Count {
                            call.Arguments[sourceIndex].Location
                        } else {
                            call?.Location ?? default(TextLocation)
                        }
                        rebound = BindConversion(location, argument, targetType)
                    } else if argument.Type != targetType &&
                        NeedsBindClrParameterConversion(argument.Type, parameterType, substituted) &&
                        ChannelTypeSymbol.TryGetChannelShape(argument.Type, out _, out _, out _) &&
                        ChannelTypeSymbol
                        .TryGetChannelShape(targetType, out _, out _, out _) {
                        // Issue #3982: the arms above all end in "leave the
                        // argument alone", which is how G# stays lenient about a
                        // CLR parameter's declared nullability (a `string?`
                        // reaches a `string` parameter because nothing here
                        // classifies and nothing here complains). For a channel
                        // pair that silence is not leniency, it is invalid IL:
                        // the ADR-0174 D2 lattice is the ONLY thing that turns a
                        // `Chan<T>` into the `ChannelReader<T>`/`ChannelWriter<T>`
                        // the parameter wants, so if it declined there is no
                        // `get_Reader` to emit and the raw channel is pushed at a
                        // slot that cannot accept it (ilverify StackUnexpected,
                        // and a hard crash at run time). Applicability now ranks
                        // a channel candidate on ERASED shapes, where an element
                        // with no CLR identity is indistinguishable from a
                        // genuine `object` — so a `chan[Pair]` can reach a
                        // genuinely non-generic `ChannelReader[object]`
                        // parameter. Diagnose that pair by name here instead of
                        // emitting it. `NeedsBindClrParameterConversion` keeps a
                        // pair that is already CLR-identical (a `chan[int32]`
                        // argument at a `Chan[int32]` parameter) on the silent
                        // path it has always taken.
                        let channelSourceIndex = i - receiverArgCount
                        let channelLocation = if call != nil &&
                            channelSourceIndex >= 0 &&
                            channelSourceIndex < call
                            .Arguments
                            .Count {
                            call.Arguments[channelSourceIndex].Location
                        } else {
                            call?.Location ?? default(TextLocation)
                        }
                        rebound = BindConversion(channelLocation, argument, targetType)
                    }
                }
            }
            if rebound != argument && builder == nil {
                builder = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length)
                for var j = 0; j < i; j++ {
                    builder.Add(arguments[j])
                }
            }
            builder?.Add(rebound)
        }
        if builder == nil {
            return arguments
        }
        for var i = builder.Count; i < arguments.Length; i++ {
            builder.Add(arguments[i])
        }
        return builder.ToImmutable()
    }

    /// ADR-0056 (#344), low-hanging-fruit item #3: a call argument whose
    /// declared parameter type is reachable only through a user-defined CLR
    /// `op_Implicit` (e.g. `[]T -> System.ReadOnlySpan[T]` /
    /// `Span[T]`) is converted here, the same way local-init / explicit-
    /// target conversions go through (cref:BindConversion(TextLocation, BoundExpression, TypeSymbol, bool,
    /// ParameterSymbol)).
    /// Built-in conversions (identity, numeric widening, ...) classify
    /// earlier and never reach this fallback, so existing overloads keep
    /// selecting unchanged. Returns true and emits a
    /// (cref:BoundClrConversionCallExpression) when a user-defined
    /// implicit conversion applies; false leaves the argument as-is.
    /// @param argument The bound source argument.
    /// @param expectedType The expected parameter type.
    /// @param converted On `true`, the rebound
    /// argument carrying the user-defined conversion call.
    /// @returns Whether a user-defined implicit conversion was applied.
    func TryApplyUserDefinedImplicitArgumentConversion(
        argument BoundExpression,
        expectedType TypeSymbol?,
        out converted BoundExpression
    ) bool {
        if argument.Type is NullableTypeSymbol sourceNullable &&
            TryResolveLiftedUserDefinedSymbolConversion(
            sourceNullable,
            expectedType!!,
            allowExplicit: false,
            out var liftedMethod,
            out var liftedOwner
        ) {
            converted = BoundClrConversionCallExpression(nil, argument, liftedMethod!!, liftedOwner, expectedType!!)
            return true
        }
        // Issue #4350: resolve symbolic generic pairs before the erased CLR
        // branch can bind the `<object>` operator.
        if argument.Type != TypeSymbol.Error &&
            TryResolveSymbolicImportedConversion(argument.Type, expectedType, out var symbolicConvMethod) &&
            BoundClrConversionCallExpression
            .CanApplyImplicitClrConversion(argument.Type, expectedType!!, symbolicConvMethod!!) {
            converted = BoundClrConversionCallExpression(nil, argument, symbolicConvMethod!!, expectedType!!)
            return true
        }
        if argument
            .Type
            ?.ClrType != nil &&
            expectedType!!.ClrType != nil &&
            argument.Type != TypeSymbol.Error &&
            ClrOperatorResolution.TryResolveConversionForTypes(
            argument.Type,
            expectedType,
            allowExplicit: false,
            out var convMethod,
            out _
        ) &&
            BoundClrConversionCallExpression
            .CanApplyImplicitClrConversion(argument.Type, expectedType!!, convMethod!!) {
            converted = BoundClrConversionCallExpression(nil, argument, convMethod!!, expectedType!!)
            return true
        }
        // Issue #3932: an IMPORTED conversion operator whose declaring generic
        // is closed over an OPEN type parameter — `[]T -> Memory[T]` — reaches
        // neither branch here. The CLR branch above needs both sides to have a
        // reflectible `ClrType` and an open `[]T` has none; the symbolic branch
        // below only knows same-package operators. So the conversion was simply
        // dropped and the emitter wrote the raw array into a `Memory[T]` slot.
        // Resolve it off the target's OPEN definition instead, which is where
        // `Memory`1::op_Implicit(!0[])` actually lives.
        if argument.Type != nil &&
            expectedType != nil &&
            argument.Type != TypeSymbol.Error &&
            TryResolveSymbolicImportedConversion(argument.Type, expectedType, out var openConvMethod) &&
            BoundClrConversionCallExpression
            .CanApplyImplicitClrConversion(argument.Type, expectedType, openConvMethod!!) {
            converted = BoundClrConversionCallExpression(nil, argument, openConvMethod!!, expectedType)
            return true
        }
        // Issue #1017: same-package user-defined implicit conversion operators
        // are modelled as static op_Implicit FunctionSymbols and have no
        // reflectible ClrType during binding, so resolve them symbolically.
        if argument.Type != nil &&
            expectedType != nil &&
            argument.Type != TypeSymbol.Error &&
            TryResolveUserDefinedSymbolConversion(
            argument.Type,
            expectedType,
            allowExplicit: false,
            out var userConvOp,
            out var userConvOwner
        ) {
            converted = BindUserDefinedSymbolConversion(
                argument.Syntax?.Location ?? default(TextLocation),
                argument,
                expectedType,
                userConvOp!!,
                userConvOwner!!,
                allowExplicit: false
            )
            return true
        }
        converted = argument
        return false
    }

    // ----- Method-group → delegate conversions -----
    /// Issue #337: resolves a CLR member method group whose target delegate
    /// signature drives overload selection. Produces a
    /// (cref:BoundClrMethodGroupExpression) carrying the resolved
    /// (cref:MethodInfo) (or a (cref:BoundErrorExpression)
    /// with a diagnostic when no compatible candidate exists).
    /// @param diagnosticLocation The location for reported diagnostics.
    /// @param group The unresolved CLR method group.
    /// @param targetType The target delegate type.
    /// @returns The shaped bound expression.
    func BindClrMethodGroupConversion(
        diagnosticLocation TextLocation,
        group BoundClrMethodGroupExpression,
        targetType TypeSymbol
    ) BoundExpression {
        let delegateClr Type? = targetType?.ClrType
        if delegateClr == nil || !ClrTypeUtilities.IsDelegateType(delegateClr) {
            return MethodGroupDiagnostics.ReportRequiresTarget(Diagnostics, group, diagnosticLocation)
        }
        // Issue #3752 (#3705, family 3): the direct `Invoke` probe is the fast
        // path, but it is unreachable whenever the target's CLR type closed a
        // live `System.Func`n`/`Action`n` over a type projected from the
        // compilation's MetadataLoadContext — `(Type) -> Type` under any
        // `/reference:` compile. `MakeGenericType` then yields a
        // `TypeBuilderInstantiation`, whose `GetMethod("Invoke")` throws
        // `NotSupportedException` and whose `GetMethodSafe` wrapper answers
        // null, so EVERY method-group conversion at a function type over an
        // imported type failed with GS0218 while the same conversion over
        // `string`/`int32` (host runtime types) succeeded. `ClrLoadContext`
        // already carries the cross-context decomposition the sibling delegate
        // probes (#932, #3681, #3697) go through; this one was the outlier.
        let invoke MethodInfo? = delegateClr.GetMethodSafe("Invoke")
        var invokeParameterTypes[]Type
        var invokeReturnType Type
        var targetParameterRefKinds ImmutableArray[RefKind]
        if invoke != nil {
            let invokeParams = invoke.GetParameters()
            invokeParameterTypes = [invokeParams.Length]Type
            for var i = 0; i < invokeParams.Length; i++ {
                invokeParameterTypes[i] = invokeParams[i].ParameterType
            }
            invokeReturnType = invoke.ReturnType
            targetParameterRefKinds = DelegateRefKindUtilities.GetParameterRefKinds(invoke)
        } else if ClrLoadContext.TryGetDelegateSignature(
            delegateClr,
            out var crossContextParams,
            out var crossContextReturn
        ) {
            targetParameterRefKinds = DelegateRefKindUtilities.GetDelegateParameterRefKinds(
                delegateClr,
                crossContextParams.Length,
                out _
            )
            if targetParameterRefKinds.Length != crossContextParams.Length {
                targetParameterRefKinds = ImmutableArray.CreateRange(
                    Enumerable.Repeat(RefKind.None, crossContextParams.Length)
                )
            }
            // TryGetDelegateSignature reduces by-ref slots to their pointee
            // (#2802); candidate `MethodInfo`s still spell them `T&`, so
            // re-form the managed-pointer shape for the ref-kind-bearing slots
            // before overload resolution compares them.
            invokeParameterTypes = [crossContextParams.Length]Type
            for var i = 0; i < crossContextParams.Length; i++ {
                invokeParameterTypes[i] = if targetParameterRefKinds[i] == RefKind.None {
                    crossContextParams[i]
                } else {
                    crossContextParams[i].MakeByRefType()
                }
            }
            invokeReturnType = crossContextReturn
        } else {
            Diagnostics.ReportCannotConvertMethodGroup(
                diagnosticLocation,
                group.MethodName,
                Invariant.Required(targetType, "method-group conversion has a target type", expression: "targetType")
            )
            return BoundErrorExpression(nil)
        }
        var closesExtensionReceiver = group.Receiver != nil
        for candidate in group.Candidates {
            closesExtensionReceiver &= candidate.IsStatic
        }
        let argTypes = [
            invokeParameterTypes.Length +
                (
                if closesExtensionReceiver {
                    1
                } else {
                    0
                }
            )
        ]Type
        if closesExtensionReceiver {
            let receiver = Invariant.Required(
                group.Receiver,
                "a static method-group extension receiver was established",
                expression: "group.Receiver"
            )
            var receiverClr Type? = NullableTypeSymbol.GetEffectiveClrType(receiver.Type)
            if receiverClr == nil && !MemberLookup.TryProjectErasedClrType(receiver.Type, out receiverClr) {
                Diagnostics.ReportCannotConvertMethodGroup(
                    diagnosticLocation,
                    group.MethodName,
                    Invariant.Required(
                        targetType,
                        "method-group conversion has a target type",
                        expression: "targetType"
                    )
                )
                return BoundErrorExpression(nil)
            }
            argTypes[0] = receiverClr!!
        }
        for var i = 0; i < invokeParameterTypes.Length; i++ {
            argTypes[
                i +
                    (
                    if closesExtensionReceiver {
                        1
                    } else {
                        0
                    }
                )
            ] = invokeParameterTypes[i]
        }
        let hasByRefTarget = targetParameterRefKinds.Any((kind RefKind) -> kind != RefKind.None)
        let applicable = List[MethodInfo]()
        for candidate in group.Candidates {
            let candidateParameters = ImportedFunctionSymbol.GetLogicalParameters(candidate, out var hasHiddenContext)
            if candidateParameters.Length != argTypes.Length {
                continue
            }
            if closesExtensionReceiver && DelegateRefKindUtilities.GetParameterRefKinds(candidate)[0] != RefKind.None {
                continue
            }
            DelegateRefKindUtilities.GetDelegateParameterRefKinds(
                delegateClr,
                invokeParameterTypes.Length,
                out var targetReturnRefKind
            )
            if RefCapabilities.GetReturnRefKind(candidate) != targetReturnRefKind ||
                !IsMethodGroupReturnCompatible(candidate.ReturnType, invokeReturnType) {
                continue
            }
            var candidateRefKinds = DelegateRefKindUtilities.GetParameterRefKinds(
                candidate,
                skipFirstParameter: closesExtensionReceiver
            )
            if hasHiddenContext {
                candidateRefKinds = candidateRefKinds.RemoveAt(candidateRefKinds.Length - 1)
            }
            if !candidateRefKinds.SequenceEqual(targetParameterRefKinds) {
                continue
            }
            var parameterTypesMatch = true
            // Ordinary open generic methods defer slot compatibility until
            // inference closes them. Hidden-context by-ref adapters do not yet
            // support generic closure, so keep rejecting those safely.
            let deferGenericParameterChecks = candidate.IsGenericMethodDefinition &&
                (!hasHiddenContext || !hasByRefTarget)
            for var i = 0; i < targetParameterRefKinds.Length; i++ {
                let candidateParameterType = candidateParameters[
                    i +
                        (
                        if closesExtensionReceiver {
                            1
                        } else {
                            0
                        }
                    )
                ].ParameterType
                if if targetParameterRefKinds[i] != RefKind.None {
                    !deferGenericParameterChecks && !candidateParameterType.IsSameAs(invokeParameterTypes[i])
                } else {
                    !deferGenericParameterChecks && ClrOverloadResolution.ClassifyImplicit(
                        candidateParameterType,
                        invokeParameterTypes[i]
                    ) == ClrOverloadResolution
                        .ImplicitConversionKind
                        .None
                } {
                    parameterTypesMatch = false
                    break
                }
            }
            if !parameterTypesMatch {
                continue
            }
            applicable.Add(candidate)
        }
        if applicable.Count > 0 {
            // Issue #1812: no interpolatedStringArgs flag applies here — this
            // resolves a method-GROUP-to-delegate conversion (e.g. `var x
            // Action = SomeClass.SomeMethod;`), matching candidate overloads
            // against the target delegate's Invoke parameter shape. There is
            // no user-supplied call-argument syntax at all (argTypes are the
            // delegate's own parameter types), so no argument could ever be an
            // interpolated-string literal in the first place.
            // The same applies to constant-narrowing: there are no bound call
            // arguments here, only the target delegate signature.
            // The CLR resolver models by-ref arguments as addresses, while a
            // delegate signature supplies pointee types. The filter above has
            // already checked every closed slot, so a sole closed by-ref
            // candidate is final. Open generic candidates still need inference.
            var resolvedMethod MethodInfo? = if hasByRefTarget &&
                applicable.Count == 1 &&
                !applicable[0].IsGenericMethodDefinition {
                applicable[0]
            } else {
                ClrOverloadResolution.Resolve(
                    applicable,
                    argTypes,
                    trailingParameterCountToIgnore: (candidate MethodBase) -> if candidate is MethodInfo method &&
                        ImportedFunctionSymbol.HasHiddenContextParameter(method) {
                        1
                    } else {
                        0
                    }
                )
                    .Best
            }
            if resolvedMethod != nil && hasByRefTarget {
                let resolvedParameters = ImportedFunctionSymbol.GetLogicalParameters(resolvedMethod, out _)
                for var i = 0; i < targetParameterRefKinds.Length; i++ {
                    if targetParameterRefKinds[i] != RefKind.None &&
                        !resolvedParameters[
                        i +
                            (
                            if closesExtensionReceiver {
                                1
                            } else {
                                0
                            }
                        )
                    ]
                        .ParameterType
                        .IsSameAs(invokeParameterTypes[i]) {
                        resolvedMethod = nil
                        break
                    }
                }
            }
            if resolvedMethod != nil {
                let resolved = BoundClrMethodGroupExpression(
                    group.Syntax,
                    group.Receiver,
                    resolvedMethod,
                    Invariant.Required(
                        targetType,
                        "method-group conversion has a target type",
                        expression: "targetType"
                    )
                )
                let requiredTargetType = Invariant.Required(
                    targetType,
                    "method-group conversion has a target type",
                    expression: "targetType"
                )
                if MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(requiredTargetType, out var functionTarget) {
                    let adapted = this.createClrMethodGroupAdapter(resolved, functionTarget)
                    if !object.ReferenceEquals(adapted, resolved) {
                        return if targetType is FunctionTypeSymbol {
                            adapted
                        } else {
                            cast[BoundExpression](BoundConversionExpression(group.Syntax, requiredTargetType, adapted))
                        }
                    }
                }
                return resolved
            }
        }
        Diagnostics.ReportCannotConvertMethodGroup(
            diagnosticLocation,
            group.MethodName,
            Invariant.Required(targetType, "method-group conversion has a target type", expression: "targetType")
        )
        return BoundErrorExpression(nil)
    }

    /// ADR-0063 §9: resolves a multi-overload user-function method group
    /// against a target delegate or native function type. The pick is the
    /// unique candidate whose parameter types and return type exactly match
    /// the target's invoke signature. When zero or multiple candidates
    /// match, a `GS0218` ("cannot convert method group") diagnostic
    /// is reported.
    /// @param diagnosticLocation The location for reported diagnostics.
    /// @param group The unresolved user-function method group.
    /// @param targetType The target delegate / function type.
    /// @returns The shaped bound expression.
    func BindUserMethodGroupConversion(
        diagnosticLocation TextLocation,
        group BoundMethodGroupExpression,
        targetType TypeSymbol
    ) BoundExpression {
        let groupName = group.Function?.Name ?? "<method group>"
        var targetParameterTypes ImmutableArray[TypeSymbol]
        var targetReturnType TypeSymbol
        if targetType is FunctionTypeSymbol nativeFn {
            targetParameterTypes = nativeFn.ParameterTypes
            targetReturnType = nativeFn.ReturnType
        } else if targetType is DelegateTypeSymbol userDelegate {
            let pb = ImmutableArray.CreateBuilder[TypeSymbol](userDelegate.Parameters.Length)
            for p in userDelegate.Parameters {
                pb.Add(p.Type)
            }
            targetParameterTypes = pb.MoveToImmutable()
            targetReturnType = userDelegate.ReturnType
        } else if MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(targetType, out var importedDelegate) {
            targetParameterTypes = importedDelegate.ParameterTypes
            targetReturnType = importedDelegate.ReturnType
        } else {
            return MethodGroupDiagnostics.ReportRequiresTarget(Diagnostics, group, diagnosticLocation)
        }
        let targetParameterRefKinds = GetMethodGroupTargetRefKinds(
            targetType,
            targetParameterTypes.Length,
            out var targetReturnRefKind
        )
        targetParameterTypes = targetParameterTypes.Select(
            (type TypeSymbol, index int32) -> if targetParameterRefKinds[index] != RefKind.None &&
                type is ByRefTypeSymbol byRef {
                byRef.PointeeType
            } else {
                type
            }
        )
            .ToImmutableArray()
        if targetReturnRefKind != RefKind.None && targetReturnType is ByRefTypeSymbol byRefReturn {
            targetReturnType = byRefReturn.PointeeType
        }
        var pick FunctionSymbol? = nil
        var pickOwner StructSymbol? = nil
        var pickMethodTypeArguments = default(ImmutableArray[TypeSymbol])
        var pickParameterTypes[]?TypeSymbol = nil
        var pickReturnType TypeSymbol? = nil
        // Issue #3505: exact-signature candidates are preferred; the
        // reference-variance relaxation only runs as a second pass when no
        // candidate matched exactly, mirroring C#'s better-function-member
        // preference for identity conversions.
        for var selectionPass = 0; selectionPass < 2 && pick == nil; selectionPass++ {
            let allowVariance = selectionPass == 1
            for candidate in group.Candidates {
                let candidateOwner = if group.StaticOwnerType != nil &&
                    candidate.StaticOwnerType is StructSymbol declaredOwner {
                    TypeMemberModel.ResolveStaticMemberOwner(group.StaticOwnerType, declaredOwner)
                } else {
                    default(StructSymbol?)
                }
                if !ExpressionBinder.TryCloseMethodGroupCandidate(
                    candidate,
                    group.Receiver,
                    candidateOwner,
                    targetParameterTypes,
                    out var candidateParameterTypes,
                    out var candidateReturn,
                    out var candidateMethodTypeArguments
                ) {
                    continue
                }
                candidateReturn = getMethodGroupObservableReturnType(candidate, candidateReturn)
                var canonicalCandidateReturn = Invariant.Required(
                    candidateReturn,
                    "a successfully closed method-group candidate has a return type",
                    expression: "candidateReturn"
                )
                let parameterOffset = if candidate.IsExtension && group.Receiver != nil {
                    1
                } else {
                    0
                }
                if candidate.ReturnRefKind != targetReturnRefKind {
                    continue
                }
                var paramsMatch = true
                for var i = 0; i < targetParameterTypes.Length; i++ {
                    if candidate
                        .Parameters[i + parameterOffset]
                        .RefKind != targetParameterRefKinds[i] ||
                        !TryCanonicalizeMethodGroupType(
                        candidateParameterTypes[i],
                        targetParameterTypes[i],
                        &candidateParameterTypes[i],
                        parameterPosition: true,
                        allowVariance: allowVariance && targetParameterRefKinds[i] == RefKind.None
                    ) {
                        paramsMatch = false
                        break
                    }
                }
                if !paramsMatch {
                    continue
                }
                if !TryCanonicalizeMethodGroupType(
                    canonicalCandidateReturn,
                    targetReturnType,
                    out canonicalCandidateReturn,
                    parameterPosition: false,
                    allowVariance: allowVariance && targetReturnRefKind == RefKind.None
                ) {
                    continue
                }
                if pick != nil {
                    let pickDefinition StructSymbol? = if pick.StaticOwnerType is StructSymbol pickDeclared {
                        pickDeclared.Definition ?? pickDeclared
                    } else {
                        default(StructSymbol?)
                    }
                    let candidateDefinition StructSymbol? = if candidate.StaticOwnerType is StructSymbol candidateDeclared {
                        candidateDeclared.Definition ?? candidateDeclared
                    } else {
                        default(StructSymbol?)
                    }
                    if pickDefinition != nil && candidateDefinition != nil && !object.ReferenceEquals(
                        pickDefinition,
                        candidateDefinition
                    ) {
                        continue
                    }
                    Diagnostics.ReportCannotConvertMethodGroup(
                        diagnosticLocation,
                        groupName,
                        Invariant.Required(
                            targetType,
                            "method-group conversion has a target type",
                            expression: "targetType"
                        )
                    )
                    return BoundErrorExpression(nil)
                }
                pick = candidate
                pickOwner = candidateOwner
                pickMethodTypeArguments = candidateMethodTypeArguments
                pickParameterTypes = candidateParameterTypes
                pickReturnType = canonicalCandidateReturn
            }
        }
        if pick == nil {
            Diagnostics.ReportCannotConvertMethodGroup(
                diagnosticLocation,
                groupName,
                Invariant.Required(targetType, "method-group conversion has a target type", expression: "targetType")
            )
            return BoundErrorExpression(nil)
        }
        let pickFnType = FunctionTypeSymbol.Get(
            ImmutableArray.CreateRange(
                Invariant.Required(
                    pickParameterTypes,
                    "a selected method group has parameter types",
                    expression: "pickParameterTypes"
                )
            ),
            Invariant.Required(
                pickReturnType,
                "a selected method group has a return type",
                expression: "pickReturnType"
            )
        )
        let resolvedGroup = BoundMethodGroupExpression(
            group.Syntax,
            group.Receiver,
            pick,
            pickFnType,
            pickOwner,
            pickMethodTypeArguments
        ){ForceNonVirtualDispatch = group.ForceNonVirtualDispatch, HasTargetDelegateType = true}
        let resolvedValue = if MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(targetType, out _) {
            cast[BoundExpression](resolvedGroup)
        } else {
            this.createUserMethodGroupAdapter(resolvedGroup)
        }
        // If the target is the native function type matching the pick exactly,
        // identity-convert; otherwise let the regular conversion machinery turn
        // the function-typed value into the user delegate.
        if object.ReferenceEquals(targetType, pickFnType) {
            return resolvedValue
        }
        if targetReturnRefKind != RefKind.None || targetParameterRefKinds.Any((kind RefKind) -> kind != RefKind.None) {
            return BoundConversionExpression(nil, targetType, resolvedValue)
        }
        let conversion = Conversion.Classify(pickFnType, targetType)
        if !conversion.Exists {
            Diagnostics.ReportCannotConvertMethodGroup(
                diagnosticLocation,
                groupName,
                Invariant.Required(targetType, "method-group conversion has a target type", expression: "targetType")
            )
            return BoundErrorExpression(nil)
        }
        if conversion.IsIdentity {
            return resolvedValue
        }
        return BoundConversionExpression(nil, targetType, resolvedValue)
    }

    // ----- Ref-kind argument validation -----
    /// ADR-0062: binds a conditional ref-argument
    /// (`cond ? &a : &b`) and validates the inner / outer
    /// ref-kind compatibility, l-value-ness, and branch type agreement.
    /// @param syntax The conditional ref-argument syntax.
    /// @param outerModifier The outer ref-kind modifier token, or
    /// `null` for the bare `&` operand form.
    /// @returns The shaped bound expression.
    func BindConditionalRefArgument(
        syntax ConditionalRefArgumentExpressionSyntax,
        outerModifier SyntaxToken?
    ) BoundExpression {
        // Condition must be bool.
        let condition = bindExpressionWithTargetType(syntax.Condition, TypeSymbol.Bool)
        // Inner-modifier matching (GS0251). The outer modifier text is `ref`,
        // `out`, `in`, or `&`. The bare `&` form (outerModifier == null) maps
        // to `ref`/`&` semantics; an inner `in`/`out` on a `&` operand is a
        // mismatch since `&` already denotes mutable byref.
        let outerText = outerModifier?.Text ?? "&"
        if syntax.WhenTrueRefKindModifier != nil &&
            !InnerModifierMatchesOuter(syntax.WhenTrueRefKindModifier.Text, outerText) {
            Diagnostics.ReportConditionalRefArgumentInnerModifierMismatch(
                syntax.WhenTrueRefKindModifier.Location,
                outerText,
                syntax.WhenTrueRefKindModifier.Text
            )
            return BoundErrorExpression(nil)
        }
        if syntax.WhenFalseRefKindModifier != nil &&
            !InnerModifierMatchesOuter(syntax.WhenFalseRefKindModifier.Text, outerText) {
            Diagnostics.ReportConditionalRefArgumentInnerModifierMismatch(
                syntax.WhenFalseRefKindModifier.Location,
                outerText,
                syntax.WhenFalseRefKindModifier.Text
            )
            return BoundErrorExpression(nil)
        }
        // Each branch must itself be a plain lvalue expression — not a nested
        // conditional, not a ref-argument, not an inline-declaration. We
        // explicitly reject the inline-declaration form here (GS0250) before
        // attempting to bind.
        if syntax.WhenTrue is RefArgumentExpressionSyntax wtRefArg && wtRefArg.IsInlineDeclaration {
            Diagnostics.ReportInlineDeclarationInConditionalRefBranch(wtRefArg.Location)
            return BoundErrorExpression(nil)
        }
        if syntax.WhenFalse is RefArgumentExpressionSyntax wfRefArg && wfRefArg.IsInlineDeclaration {
            Diagnostics.ReportInlineDeclarationInConditionalRefBranch(wfRefArg.Location)
            return BoundErrorExpression(nil)
        }
        let whenTrue = bindExpression(syntax.WhenTrue)
        let whenFalse = bindExpression(syntax.WhenFalse)
        if whenTrue is BoundErrorExpression || whenFalse is BoundErrorExpression || condition is BoundErrorExpression {
            return BoundErrorExpression(nil)
        }
        if !isLvalue(whenTrue) {
            Diagnostics.ReportCannotTakeAddressOfNonLvalue(syntax.WhenTrue.Location, syntax.WhenTrue.ToString())
            return BoundErrorExpression(nil)
        }
        if !isLvalue(whenFalse) {
            Diagnostics.ReportCannotTakeAddressOfNonLvalue(syntax.WhenFalse.Location, syntax.WhenFalse.ToString())
            return BoundErrorExpression(nil)
        }
        // Branch types must match exactly — no implicit widening or nullable
        // adjustment, since the resulting byref selects between slots whose
        // physical type must agree.
        if !object.ReferenceEquals(whenTrue.Type, whenFalse.Type) && !string.Equals(
            whenTrue.Type?.Name,
            whenFalse.Type?.Name,
            StringComparison.Ordinal
        ) {
            Diagnostics.ReportConditionalRefArgumentBranchTypeMismatch(
                syntax.Location,
                whenTrue.Type?.Name ?? "?",
                whenFalse.Type?.Name ?? "?"
            )
            return BoundErrorExpression(nil)
        }
        // Readonly check: for `ref` (and bare `&`), neither branch may be a
        // read-only local. For `in` either branch may be read-only. For `out`
        // both must be writable. (Definite-assignment is enforced elsewhere
        // by DefiniteAssignmentAnalyzer.)
        let requiresWritable = outerText == "ref" || outerText == "out" || outerText == "&"
        if requiresWritable {
            if RefCapabilities.IsReadOnlyStorage(whenTrue) {
                Diagnostics.ReportCannotTakeAddressOfConstant(syntax.WhenTrue.Location, syntax.WhenTrue.ToString())
                return BoundErrorExpression(nil)
            }
            if RefCapabilities.IsReadOnlyStorage(whenFalse) {
                Diagnostics.ReportCannotTakeAddressOfConstant(syntax.WhenFalse.Location, syntax.WhenFalse.ToString())
                return BoundErrorExpression(nil)
            }
        }
        return BoundConditionalAddressExpression(
            nil,
            condition,
            whenTrue,
            whenFalse,
            Invariant.Required(
                whenTrue.Type,
                "conditional ref branches have matching types",
                expression: "whenTrue.Type"
            )
        )
    }

    /// ADR-0060: validates a parameter's (cref:RefKind) against the
    /// surrounding declaration shape (pointer-typed parameters, variadic
    /// parameters, async/iterator functions). Surfaces the corresponding
    /// diagnostic for each violation and returns the (possibly downgraded)
    /// (cref:RefKind).
    /// @param parameterSyntax The parameter syntax.
    /// @param parameterName The parameter's declared name.
    /// @param parameterType The bound parameter type.
    /// @param isVariadic Whether the parameter is variadic.
    /// @param asyncOrIteratorKind A non-`null` kind
    /// label (`"async"` / `"iterator"`) when the surrounding
    /// function is a state-machine kickoff that cannot host a managed
    /// pointer.
    /// @returns The validated ref-kind.
    func BindAndValidateParameterRefKind(
        parameterSyntax ParameterSyntax,
        parameterName string,
        parameterType TypeSymbol,
        isVariadic bool,
        asyncOrIteratorKind string?
    ) RefKind {
        var parameterRefKind = getRefKindFromModifier(parameterSyntax.RefKindModifier)
        // ADR-0060 §2: a `*T` type cannot appear as a parameter type. The CLR's
        // managed-pointer-typed parameter slot would normally surface as `T&`
        // via the keyword form; suggest the rewrite.
        if parameterType is ByRefTypeSymbol pointerParamType {
            Diagnostics.ReportPointerTypeCannotBeParameterType(
                Invariant.Required(
                    parameterSyntax.Type,
                    "bound parameters have a type clause",
                    expression: "parameterSyntax.Type"
                )
                    .Location,
                parameterName,
                pointerParamType.PointeeType.Name
            )
        }
        // ADR-0060 §8: a variadic parameter (`...T`) cannot also carry a ref-kind
        // modifier — the CLR cannot represent an array of managed pointers.
        if parameterRefKind != RefKind.None && isVariadic {
            Diagnostics.ReportRefKindOnVariadicParameter(parameterSyntax.Location, parameterName)
            parameterRefKind = RefKind.None
        }
        // ADR-0060 §10: ban ref-kind parameters on async / iterator (sequence) functions.
        // The state-machine rewriter cannot hoist a managed pointer into a field.
        if parameterRefKind != RefKind.None && asyncOrIteratorKind != nil {
            Diagnostics.ReportRefKindOnAsyncOrIterator(parameterSyntax.Location, parameterName, asyncOrIteratorKind)
            parameterRefKind = RefKind.None
        }
        return parameterRefKind
    }

    /// ADR-0060: at call sites that target a G#-authored
    /// function/method/constructor with a `ref`/`out`/`in`
    /// parameter, the bound argument should already be a
    /// (cref:BoundAddressOfExpression) whose operand type matches
    /// the parameter's pointee type. In that case we pass the argument
    /// through unchanged — the conversion machinery would otherwise try
    /// to coerce `*T` into `T` and fail.
    /// @param location The diagnostic location for any conversion
    /// error.
    /// @param argument The bound argument.
    /// @param expectedType The (substituted) parameter type.
    /// @param parameter The target parameter (carrying
    /// (cref:RefKind)).
    /// @param argumentIndex The 1-based argument position, for diagnostics.
    /// @returns The argument, possibly with a normal conversion applied.
    func BindCallArgumentWithRefKind(
        location TextLocation,
        argument BoundExpression,
        expectedType TypeSymbol,
        parameter ParameterSymbol?,
        argumentIndex int32
    ) BoundExpression {
        if parameter != nil && parameter.RefKind != RefKind.None {
            if argument is BoundAddressOfExpression addr {
                let operandType TypeSymbol? = addr.Operand?.Type
                if operandType == TypeSymbol.Error ||
                    expectedType == TypeSymbol.Error ||
                    (operandType != nil && CheckByRefArgumentStorage(location, parameter, operandType, expectedType)) {
                    return argument
                }
                // Issue #4422: report the mismatch against the storage type
                // rather than letting BindConversion report the `*T` address.
                if operandType != nil {
                    ReportByRefStorageMismatch(location, parameter.Name, expectedType, operandType)
                    return BoundErrorExpression(argument.Syntax)
                }
            } else if argument is BoundConditionalAddressExpression condAddr {
                // ADR-0061: conditional address-of also accepted at ref-kind
                // parameter positions. The shared pointee type was validated
                // by BindConditionalRefArgument.
                let pointeeType = condAddr.PointeeType
                if pointeeType == TypeSymbol.Error ||
                    expectedType == TypeSymbol.Error ||
                    CheckByRefArgumentStorage(location, parameter, pointeeType, expectedType) {
                    return argument
                }
                ReportByRefStorageMismatch(location, parameter.Name, expectedType, pointeeType)
                return BoundErrorExpression(argument.Syntax)
            } else if argument is BoundInterpolatedStringExpression && argument.Handler != nil {
                // Issue #377: a by-ref interpolated-string handler argument is
                // lowered to the handler local's address later.
                return BindConversion(location, argument, expectedType, callParameter: parameter)
            } else if parameter.RefKind == RefKind.In {
                // Issue #4400: an `in` parameter given a plain argument (no
                // call-site modifier) is passed by readonly reference.
                return BindImplicitInArgument(location, argument, expectedType, parameter)
            } else if IsPlainValueArgument(argument) {
                // Issue #4400: a `ref`/`out` parameter given a plain value
                // (no modifier) has no address to pass. Report the same
                // GS0235 the free-function path reports instead of letting the
                // value reach the emitter as unverifiable IL.
                Diagnostics.ReportRefKindMismatch(
                    location,
                    argumentIndex,
                    parameter.Name,
                    if parameter.RefKind == RefKind.Out {
                        "out"
                    } else {
                        "ref"
                    },
                    "none"
                )
                return BoundErrorExpression(argument.Syntax)
            }
        }
        return BindConversion(location, argument, expectedType, callParameter: parameter)
    }

    /// Issue #4422: the by-reference argument gate for a G# callee. The
    /// storage behind `&x` must have the parameter's type; it may
    /// differ only in reference nullability, as in C#, and then GS0612 warns in
    /// the direction a nil can flow through the shared storage:
    /// - `ref`: any difference.
    /// - `in`: nullable storage at a non-null parameter (the callee reads a nil as non-null), or a nested
    /// difference.
    /// - `out`: a nullable parameter over non-null storage (the callee may write nil), or a nested
    /// difference.
    /// A platform (`T!`) position states nothing and never warns
    /// (ADR-0186). The caller reports GS0154 when this returns
    /// `false`.
    /// @param location The argument's location.
    /// @param parameter The target parameter (carrying its ref kind).
    /// @param storageType The type of the storage the argument addresses.
    /// @param parameterType The (substituted) parameter type.
    /// @returns `true` when the storage is accepted.
    func CheckByRefArgumentStorage(
        location TextLocation,
        parameter ParameterSymbol,
        storageType TypeSymbol,
        parameterType TypeSymbol
    ) bool {
        if !ByRefStorageMatching.AreSameStorageType(
            storageType,
            parameterType,
            out var storageNullable,
            out var parameterNullable,
            out var nestedMismatch
        ) {
            return false
        }
        var reason string? = nil
        let refKind = parameter.RefKind
        if nestedMismatch {
            reason = "a nested type argument or element differs in nullability, and both views share one object"
        } else if storageNullable && refKind != RefKind.Out {
            reason = "a nil in the storage reaches the callee as a non-null value"
        } else if parameterNullable && refKind != RefKind.In {
            reason = "the callee may store nil into storage declared non-null"
        }
        if reason != nil {
            let refKindText = if refKind == RefKind.Out {
                "out"
            } else {
                (
                    if refKind == RefKind.In {
                        "in"
                    } else {
                        "ref"
                    }
                )
            }
            Diagnostics.ReportByRefArgumentNullabilityMismatch(
                location,
                refKindText,
                parameter.Name,
                parameterType,
                storageType,
                reason
            )
        }
        return true
    }

    /// Issue #4422: reports GS0154 for by-reference storage the gate rejected,
    /// naming the storage type (not the `*T` address type). When the
    /// only difference is value-type nullability (`int32?` storage at
    /// `ref int32`, or the reverse) the text says the two are different
    /// runtime types.
    /// @param location The argument's location.
    /// @param parameterName The parameter name.
    /// @param parameterType The (substituted) parameter type.
    /// @param storageType The storage type.
    func ReportByRefStorageMismatch(
        location TextLocation,
        parameterName string,
        parameterType TypeSymbol,
        storageType TypeSymbol
    ) {
        let IsValueNullableOf = func (nullable TypeSymbol, other TypeSymbol) bool {
            return nullable is NullableTypeSymbol valueNullable && NullableLifting.IsAnyValueTypeNullable(
                valueNullable
            ) &&
                !(other is NullableTypeSymbol) &&
                TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(valueNullable.UnderlyingType, other)
        }
        if IsValueNullableOf(storageType, parameterType) || IsValueNullableOf(parameterType, storageType) {
            Diagnostics.ReportWrongValueNullableByRefArgument(location, parameterName, parameterType, storageType)
            return
        }
        Diagnostics.ReportWrongArgumentType(location, parameterName, parameterType, storageType)
    }

    /// Issue #4400 (ADR-0060 amendment): binds an argument written WITHOUT a
    /// call-site modifier against an `in` parameter, matching C#. The
    /// argument is first converted to the parameter type exactly as a by-value
    /// argument would be (so an argument with no implicit conversion reports
    /// the usual GS0154/GS0155), then passed by readonly reference: the
    /// address of the converted value when it is still an addressable lvalue
    /// of the parameter type, otherwise the address of a synthesized readonly
    /// temp holding the value.
    /// @param location The diagnostic location for a conversion error.
    /// @param argument The bound argument (not an address-of).
    /// @param expectedType The (substituted) parameter pointee type.
    /// @param parameter The target parameter, when it is a G# symbol.
    /// @returns A (cref:BoundAddressOfExpression) of type `T&`,
    /// or the conversion's error expression.
    func BindImplicitInArgument(
        location TextLocation,
        argument BoundExpression,
        expectedType TypeSymbol,
        parameter ParameterSymbol?
    ) BoundExpression {
        var argument = argument
        if argument is BoundErrorExpression || expectedType == TypeSymbol.Error {
            return argument
        }
        // An untyped `default` (ADR-0100 placeholder) takes the pointee type,
        // exactly as it takes a by-value parameter's type.
        if argument is BoundDefaultExpression{Type: var defaultType} && defaultType == TypeSymbol.Error {
            argument = BoundDefaultExpression(argument.Syntax, expectedType)
        }
        let converted = BindConversion(location, argument, expectedType, callParameter: parameter)
        if converted is BoundErrorExpression || converted.Type == TypeSymbol.Error {
            return converted
        }
        return CreateImplicitInReference(converted, expectedType)
    }

    /// Issue #4400: wraps an already-converted [`value`](paramref) as a
    /// readonly reference for an `in` parameter — its own address when it
    /// is addressable storage of exactly [`parameterType`](paramref)
    /// (C# passes the variable itself, so the callee aliases it), else the
    /// address of a fresh readonly temp initialized with the value (an rvalue,
    /// or an lvalue that needed a conversion).
    /// @param value The converted argument value.
    /// @param parameterType The parameter pointee type.
    /// @returns The readonly address-of expression.
    func CreateImplicitInReference(value BoundExpression, parameterType TypeSymbol) BoundExpression {
        if RefCapabilities.IsDirectlyAddressableForImplicitIn(value) && DeclarationBinder.TypeSignaturesEquivalent(
            value.Type,
            parameterType
        ) {
            return BoundAddressOfExpression(value.Syntax, value, unmanaged: false, isReadOnly: true)
        }
        // The temp is typed as the SLOT, not the value: an implicit reference
        // conversion (`FormattableString` at `in IFormattable`) leaves the
        // value's own type on the node, but the callee takes `IFormattable&`.
        let tempType = if parameterType != TypeSymbol.Error {
            parameterType
        } else {
            value.Type
        }
        let temp = LocalVariableSymbol(
            "$ImplicitInTempPrefix${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
            isReadOnly: true,
            type: tempType
        )
        let spill = BoundBlockExpression(
            value.Syntax,
            ImmutableArray.Create[BoundStatement](BoundVariableDeclaration(value.Syntax, temp, value)),
            BoundVariableExpression(value.Syntax, temp)
        )
        return BoundAddressOfExpression(value.Syntax, spill, unmanaged: false, isReadOnly: true)
    }

    /// Issue #4400: the final by-ref check for an argument that a call path's
    /// early branch (an open type-parameter pass-through, a function-literal
    /// adapter, a target-typed lambda) produced without going through
    /// (cref:BindCallArgumentWithRefKind). A plain value at an
    /// `in` slot is passed by readonly reference; one at a `ref` or
    /// `out` slot reports GS0235 and becomes an error expression, since it
    /// has no storage to pass. Anything else is returned unchanged.
    /// @param argument The bound argument as the early branch left it.
    /// @param parameter The target parameter.
    /// @param expectedType The (substituted) parameter type.
    /// @param location The argument's location, for GS0235.
    /// @param argumentIndex The 1-based argument position, for GS0235.
    /// @returns The argument ready for a by-ref slot, or an error expression.
    func FinishByRefArgument(
        argument BoundExpression,
        parameter ParameterSymbol,
        expectedType TypeSymbol,
        location TextLocation,
        argumentIndex int32
    ) BoundExpression {
        if parameter.RefKind == RefKind.None || !IsPlainValueArgument(argument) {
            return argument
        }
        if parameter.RefKind == RefKind.In {
            let value = if argument is BoundDefaultExpression{Type: var defaultType} &&
                defaultType == TypeSymbol.Error {
                cast[BoundExpression](BoundDefaultExpression(argument.Syntax, expectedType))
            } else {
                argument
            }
            return CreateImplicitInReference(value, expectedType)
        }
        Diagnostics.ReportRefKindMismatch(
            location,
            argumentIndex,
            parameter.Name,
            if parameter.RefKind == RefKind.Out {
                "out"
            } else {
                "ref"
            },
            "none"
        )
        return BoundErrorExpression(argument.Syntax)
    }

    /// Issue #4400: applies only the implicit-`in` rewrite to a CLR call's
    /// arguments, for call paths that otherwise pass their arguments through
    /// unconverted (a non-generic interface-constrained instance call).
    /// @param arguments The source-order bound arguments.
    /// @param parameters The resolved CLR method's parameters.
    /// @param call The originating call, for argument locations.
    /// @param parameterMapping Optional source-argument to parameter map.
    /// @param method The resolved CLR method, for symbolic slot recovery.
    /// @param receiverType The receiver/constraint type carrying symbolic type arguments.
    /// @param parameterArgumentLocations Original source locations keyed
    /// by parameter index after expanded named arguments were reordered.
    /// @returns The arguments, with each plain `in` argument passed by readonly reference.
    func BindImplicitInClrArguments(
        arguments ImmutableArray[BoundExpression],
        parameters[]ParameterInfo,
        call CallExpressionSyntax,
        parameterMapping ImmutableArray[int32],
        method MethodInfo?,
        receiverType TypeSymbol?,
        parameterArgumentLocations ImmutableArray[TextLocation?] = default(ImmutableArray[TextLocation?])
    ) ImmutableArray[BoundExpression] {
        var builder ImmutableArray[BoundExpression].Builder? = nil
        for var i = 0; i < arguments.Length; i++ {
            let paramIndex = if parameterMapping.IsDefault {
                i
            } else {
                parameterMapping[i]
            }
            let location = if !parameterArgumentLocations.IsDefault &&
                paramIndex < parameterArgumentLocations.Length &&
                parameterArgumentLocations[paramIndex] is {} mappedLocation {
                mappedLocation
            } else {
                (
                    if i < call.Arguments.Count {
                        call.Arguments[i].Location
                    } else {
                        call.Location
                    }
                )
            }
            let parameterType TypeSymbol? = if paramIndex < parameters.Length &&
                parameters[paramIndex].ParameterType is {IsByRef: false} &&
                method != nil &&
                receiverType != nil {
                MemberLookup.GetClrMethodParameterTypeSymbol(receiverType, method, paramIndex)
            } else {
                default(TypeSymbol?)
            }
            if parameterType != nil && binderCtx.TryGetBackwardGotoNarrowingPath(
                arguments[i],
                out var path,
                out var narrowedType
            ) &&
                (
                Invariant.Required(path, "a narrowed constrained-call argument has an access path", expression: "path")
                    .HasMembers ||
                    !BinderContext
                    .NarrowedReadChangesRuntimeType(
                    path!!.Root.Type,
                    Invariant.Required(
                        narrowedType,
                        "a narrowed constrained-call argument has a narrowed type",
                        expression: "narrowedType"
                    )
                )
            ) &&
                !(parameterType is NullableTypeSymbol) &&
                !(parameterType is PlatformTypeSymbol) {
                binderCtx.TrackBackwardGotoNarrowingUse(
                    path!!,
                    location,
                    string.Empty,
                    BackwardGotoNarrowingUseKind.Conversion,
                    parameterType
                )
            }
            if paramIndex < parameters.Length && IsImplicitInClrArgument(arguments[i], parameters[paramIndex]) {
                let pointeeType = GetImplicitInClrPointeeType(
                    parameters[paramIndex],
                    paramIndex,
                    method,
                    receiverType,
                    symbolicMethodTypeArgs: default(ImmutableArray[TypeSymbol?]),
                    arguments[i]
                )
                builder ??= arguments.ToBuilder()
                builder!![i] = if TryRejectClrPlatformContainerArgument(
                    arguments[i],
                    parameters[paramIndex],
                    pointeeType,
                    location,
                    out var rejectedArgument
                ) {
                    rejectedArgument
                } else {
                    BindImplicitInArgument(location, arguments[i], pointeeType, parameter: nil)
                }
            } else if paramIndex < parameters.Length &&
                (
                Conversion.ContainsPlatformTypeInStructure(arguments[i].Type) || TypeSymbol.ContainsNullLiteralType(
                    arguments[i].Type
                )
            ) &&
                parameterType != nil {
                if Conversion.ContainsPlatformTypeInStructure(arguments[i].Type) &&
                    TryRejectClrPlatformContainerArgument(
                    arguments[i],
                    parameters[paramIndex],
                    parameterType,
                    location,
                    out var rejectedArgument
                ) {
                    builder ??= arguments.ToBuilder()
                    builder!![i] = rejectedArgument
                } else if TypeSymbol.ContainsNullLiteralType(arguments[i].Type) && !Conversion.Classify(
                    arguments[i].Type,
                    parameterType
                )
                    .IsImplicit {
                    builder ??= arguments.ToBuilder()
                    builder!![i] = BindConversion(location, arguments[i], parameterType)
                } else if !parameters[paramIndex]
                    .ParameterType
                    .IsGenericParameter &&
                    arguments[i].Type is PlatformTypeSymbol &&
                    Conversion
                    .Classify(arguments[i].Type, parameterType).RequiresPlatformNilCheck {
                    // ADR-0186 §4, #4451: a platform argument at a non-null
                    // parameter of a constrained call is a coercion point like
                    // any other. This path otherwise passes arguments
                    // unconverted (the `!0` slots are reified), so it inserts
                    // only the check and leaves the value's CLR shape alone.
                    builder ??= arguments.ToBuilder()
                    builder!![i] = PlatformCoercion.InsertCheck(
                        arguments[i],
                        location,
                        "a conversion to the non-null type '${parameterType.Name}'"
                    )
                }
            }
        }
        return builder?.ToImmutable() ?? arguments
    }

    /// Reports a rejected call argument through the shared GS0154 contract.
    /// @param location The offending argument's location.
    /// @param parameter The target parameter.
    /// @param expectedType The substituted parameter type.
    /// @param actualType The argument type.
    func ReportCallArgumentConversionFailure(
        location TextLocation,
        parameter ParameterSymbol,
        expectedType TypeSymbol,
        actualType TypeSymbol
    ) -> Diagnostics.ReportWrongArgumentType(location, parameter.Name, expectedType, actualType)

    // ----- Optional / default-value argument shaping -----
    /// ADR-0063: binds, validates, and (when valid) records a user-declared
    /// optional default value on [`parameter`](paramref). Enforces the
    /// v1 restrictions: the default must be a compile-time constant
    /// representable in CLR parameter metadata, the parameter must not be
    /// `ref`/`out`/`in`, must not be variadic, and must not
    /// be the receiver parameter. Reports
    /// (cref:DiagnosticBag.ReportInvalidOptionalParameter) on misuse.
    /// @param parameterSyntax The parameter syntax carrying the
    /// default clause.
    /// @param parameter The bound parameter symbol to attach the
    /// default to.
    /// @param isReceiver True when the parameter is a method's source
    /// receiver.
    func BindAndAttachParameterDefaultValue(
        parameterSyntax ParameterSyntax?,
        parameter ParameterSymbol?,
        isReceiver bool = false
    ) {
        if parameterSyntax == nil || !parameterSyntax.HasDefaultValue || parameter == nil {
            return
        }
        let location = parameterSyntax.DefaultValue?.Location ?? parameterSyntax.Location
        if isReceiver {
            Diagnostics.ReportInvalidOptionalParameter(
                location,
                parameter.Name,
                "the receiver parameter cannot declare a default value."
            )
            return
        }
        if parameter.IsVariadic {
            Diagnostics.ReportInvalidOptionalParameter(
                location,
                parameter.Name,
                "a variadic parameter cannot declare a default value."
            )
            return
        }
        if parameter.RefKind != RefKind.None {
            Diagnostics.ReportInvalidOptionalParameter(
                location,
                parameter.Name,
                "a '${refKindToString(parameter.RefKind)}' parameter cannot declare a default value."
            )
            return
        }
        // Bind the default-value expression in the surrounding scope. Diagnostics
        // (undefined symbol, etc.) bubble through normally.
        let defaultValue ExpressionSyntax? = parameterSyntax.DefaultValue
        if defaultValue == nil {
            return
        }
        // Issue #3336: this expression can belong to a non-primary partial part.
        let bindingScope = binderCtx.RootScope
        let previousTree = bindingScope.SetCurrentReferencingSyntaxTree(defaultValue.SyntaxTree)
        var bound BoundExpression?
        try {
            bound = bindExpression(defaultValue)
        } finally {
            bindingScope.SetCurrentReferencingSyntaxTree(previousTree)
        }
        if bound == nil || bound is BoundErrorExpression || parameter.Type == TypeSymbol.Error {
            return
        }
        // The default must be a compile-time constant of one of the kinds the CLR
        // parameter Constant table can represent.
        if !TryExtractConstantDefault(bound, parameter.Type, out var constant, out var reason) {
            Diagnostics.ReportInvalidOptionalParameter(location, parameter.Name, reason)
            return
        }
        parameter.SetExplicitDefaultValue(constant)
    }

    // ----- using-statement helper -----
    /// ADR-0048 / using-statement support: builds a `variable.Dispose()`
    /// call against the CLR `Dispose` method on the variable's type.
    /// Reports (cref:DiagnosticBag.ReportTypeNotDisposable) when the
    /// type does not expose a public parameterless `Dispose`.
    /// @param variable The variable to dispose.
    /// @param location The diagnostic location.
    /// @returns The bound call expression, or `null` on
    /// failure.
    func TryBuildDisposeCall(variable VariableSymbol, location TextLocation) BoundExpression? {
        let variableType = Invariant.Required(
            variable.Type,
            "disposable variables have a bound type",
            expression: "variable.Type"
        )
        // #568 primary path: if the variable's type is a user-defined class
        // that declares a public parameterless Dispose() (including via
        // IDisposable implementation), route through user-instance-call.
        if variable.Type is StructSymbol userType && TypeMemberModel.TryGetMethodIncludingInherited(
            userType,
            "Dispose",
            out var userDispose
        ) &&
            userDispose!!
            .Parameters
            .Length == 0 &&
            (userDispose!!.Type == TypeSymbol.Void || userDispose!!.Type == nil) &&
            userDispose!!.Accessibility == Accessibility
            .Public {
            let receiver = BoundVariableExpression(nil, variable)
            return BoundUserInstanceCallExpression(nil, receiver, userDispose!!, ImmutableArray[BoundExpression].Empty)
        }
        // Extended CLR-type path: walk self + transitive interfaces so a
        // CLR class inheriting Dispose solely through IDisposable is found.
        // Issue #2148: a same-compilation user class deriving from an imported
        // IDisposable base has no ClrType of its own, so fall back to the
        // nearest imported base's ClrType to find the inherited Dispose.
        let clrType Type? = variableType.ClrType ?? GetNearestImportedBaseClrType(variableType)
        if clrType == nil {
            Diagnostics.ReportTypeNotDisposable(location, variableType)
            return nil
        }
        let disposeMethod MethodInfo? = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(
            clrType,
            "Dispose",
            Type.EmptyTypes
        )
        if disposeMethod == nil {
            Diagnostics.ReportTypeNotDisposable(location, variableType)
            return nil
        }
        let receiver2 = BoundVariableExpression(nil, variable)
        return BoundImportedInstanceCallExpression(
            nil,
            receiver2,
            disposeMethod,
            TypeSymbol.Void,
            ImmutableArray[BoundExpression].Empty
        )
    }

    /// Issue #605: builds a bound `await receiver.DisposeAsync()` expression.
    /// Probes for a public parameterless `DisposeAsync()` returning
    /// (cref:System.Threading.Tasks.ValueTask) on user-defined G# classes
    /// and CLR types (via `IAsyncDisposable`).
    /// Reports (cref:DiagnosticBag.ReportTypeNotAsyncDisposable) on failure.
    /// @param variable The variable to async-dispose.
    /// @param location The diagnostic location.
    /// @returns A (cref:BoundAwaitExpression) wrapping the DisposeAsync call, or `null` on failure.
    func TryBuildDisposeAsyncCall(variable VariableSymbol, location TextLocation) BoundExpression? {
        let variableType = Invariant.Required(
            variable.Type,
            "async-disposable variables have a bound type",
            expression: "variable.Type"
        )
        let valueTaskType = TypeSymbol.FromClrTypeWithoutNullability(
            typeof(ValueTask),
            NullabilityFreeReason.TypeLiteral
        )
        // User-defined G# class path: probe for DisposeAsync() returning ValueTask.
        if variable.Type is StructSymbol userType && TypeMemberModel.TryGetMethodIncludingInherited(
            userType,
            "DisposeAsync",
            out var userDisposeAsync
        ) &&
            userDisposeAsync!!
            .Parameters
            .Length == 0 &&
            userDisposeAsync!!.Accessibility == Accessibility
            .Public {
            let receiver = BoundVariableExpression(nil, variable)
            let call = BoundUserInstanceCallExpression(
                nil,
                receiver,
                userDisposeAsync!!,
                ImmutableArray[BoundExpression].Empty,
                getMethodGroupObservableReturnType(userDisposeAsync!!, userDisposeAsync!!.Type)
            )
            return BoundAwaitExpression(nil, call, TypeSymbol.Void)
        }
        // CLR-type path: walk self + transitive interfaces for DisposeAsync.
        // Issue #2148: fall back to the nearest imported base's ClrType for a
        // same-compilation user class deriving from an imported IAsyncDisposable.
        let clrType Type? = variableType.ClrType ?? GetNearestImportedBaseClrType(variableType)
        if clrType == nil {
            Diagnostics.ReportTypeNotAsyncDisposable(location, variableType)
            return nil
        }
        let disposeAsyncMethod MethodInfo? = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(
            clrType,
            "DisposeAsync",
            Type.EmptyTypes
        )
        if disposeAsyncMethod == nil || disposeAsyncMethod.ReturnType.FullName != "System.Threading.Tasks.ValueTask" {
            Diagnostics.ReportTypeNotAsyncDisposable(location, variableType)
            return nil
        }
        let receiver2 = BoundVariableExpression(nil, variable)
        let clrCall = BoundImportedInstanceCallExpression(
            nil,
            receiver2,
            disposeAsyncMethod,
            valueTaskType,
            ImmutableArray[BoundExpression].Empty
        )
        return BoundAwaitExpression(nil, clrCall, TypeSymbol.Void)
    }

    /// Issue #4480: reports the imported-call form of ADR-0186 §3 rule 3 at an
    /// explicitly supplied argument location.
    /// @param argument The bound argument.
    /// @param parameter The resolved imported parameter.
    /// @param targetType The nullability-aware parameter type.
    /// @param location The offending argument's location.
    /// @param rebound The error expression when the argument is rejected.
    /// @param classifiedConversion An already-classified conversion, when the caller has one.
    /// @returns `true` when rule 3 rejected the argument.
    internal func TryRejectClrPlatformContainerArgument(
        argument BoundExpression,
        parameter ParameterInfo,
        targetType TypeSymbol,
        location TextLocation,
        out rebound BoundExpression,
        classifiedConversion Conversion? = nil
    ) bool {
        rebound = argument
        let sourceType TypeSymbol? = argument.Type
        if sourceType == nil ||
            (classifiedConversion ?? Conversion.Classify(sourceType, targetType)).Exists ||
            !Conversion.TryRelatePlatformContainer(
            sourceType,
            targetType,
            out var isImplicit,
            out var rejectsImportedParameter
        ) ||
            isImplicit ||
            !rejectsImportedParameter {
            return false
        }
        Diagnostics.ReportWrongArgumentType(
            location,
            parameter.Name ?? "arg${parameter.Position}",
            targetType,
            argument.Type
        )
        rebound = BoundErrorExpression(argument.Syntax)
        return true
    }

    // ----- Private helpers (kept here because they are only used by methods in this class) -----
    /// ADR-0186 §4: materialises the coercion check for a
    /// (cref:Conversion.RequiresPlatformNilCheck) classification, then
    /// finishes the conversion from the now-checked, non-platform value.
    /// @param diagnosticLocation The coercion site.
    /// @param expression The platform-typed source expression.
    /// @param type The non-null reference destination.
    /// @returns The checked (and, for an upcast, converted) expression.
    private func BindPlatformCoercionCheck(
        diagnosticLocation TextLocation,
        expression BoundExpression,
        type TypeSymbol
    ) BoundExpression {
        let checkedExpression = PlatformCoercion.InsertCheck(
            expression,
            diagnosticLocation,
            "a conversion to the non-null type '${type.Name}'"
        )
        if object.ReferenceEquals(checkedExpression, expression) {
            // Defensive: `InsertCheck` declines only when it cannot bind the
            // operator at all. Under `--platform-nil-checks=off` it still
            // unwraps (to a conversion node), so that switch does not reach
            // here.
            return expression
        }
        // The destination may be a SUPERTYPE (`object`, a base class, an
        // interface) rather than `T` itself — §3's upcast rows, which check
        // precisely because a non-null destination is a non-null destination.
        // The remaining `T -> object` step is an ordinary reference upcast
        // and cannot re-enter this arm, because the checked expression's type
        // is the bare underlying and carries no platform wrapper.
        return if checkedExpression.Type == type {
            checkedExpression
        } else {
            BindConversion(diagnosticLocation, checkedExpression, type, allowExplicit: true)
        }
    }

    private func BindUserDefinedSymbolConversion(
        diagnosticLocation TextLocation,
        expression BoundExpression,
        targetType TypeSymbol,
        method FunctionSymbol,
        methodOwner StructSymbol,
        allowExplicit bool
    ) BoundExpression {
        let parameterType = methodOwner.SubstituteMemberType(method.Parameters[0].Type)
        let resultType = methodOwner.SubstituteMemberType(method.Type)
        let operand = BindConversion(diagnosticLocation, expression, parameterType, allowExplicit: false)
        let call = BoundCallExpression(nil, method, ImmutableArray.Create(operand), resultType){
            StaticGenericOwnerType = if !methodOwner
                .TypeArguments
                .IsDefaultOrEmpty ||
                !(methodOwner.Definition ?? methodOwner)
                .TypeParameters
                .IsDefaultOrEmpty {
                methodOwner
            } else {
                default(StructSymbol?)
            }
        }
        return BindConversion(diagnosticLocation, call, targetType, allowExplicit)
    }

    /// Issue #1256: lowers a non-identity implicit tuple-to-tuple conversion
    /// into a tuple literal of per-element converted accesses, rebuilding the
    /// target (cref:System.ValueTuple) so the emitted IL is verifiable.
    /// @param diagnosticLocation The diagnostic location.
    /// @param expression The source tuple expression.
    /// @param sourceTuple The source tuple type.
    /// @param targetTuple The target tuple type.
    /// @param allowExplicit Whether explicit element conversions are allowed.
    /// @returns The lowered expression building the target tuple.
    private func BindTupleConversion(
        diagnosticLocation TextLocation,
        expression BoundExpression,
        sourceTuple TupleTypeSymbol,
        targetTuple TupleTypeSymbol,
        allowExplicit bool
    ) BoundExpression {
        let arity = sourceTuple.Arity
        // Fast path: the source is already a tuple literal, so its element
        // expressions are directly available — re-convert each to the target
        // element type without introducing a temp or element accesses.
        if expression is BoundTupleLiteralExpression literalSource && literalSource.Elements.Length == arity {
            let convertedLiteralElements = ImmutableArray.CreateBuilder[BoundExpression](arity)
            for var i = 0; i < arity; i++ {
                convertedLiteralElements.Add(
                    BindConversion(
                        diagnosticLocation,
                        literalSource.Elements[i],
                        targetTuple.ElementTypes[i],
                        allowExplicit
                    )
                )
            }
            return BoundTupleLiteralExpression(expression.Syntax, targetTuple, convertedLiteralElements.ToImmutable())
        }
        // General path: evaluate the source once into a temp local, then build
        // a tuple literal of converted `ItemN` accesses off that local.
        let temp = LocalVariableSymbol("<>tupleConv", isReadOnly: true, type: sourceTuple)
        let declaration = BoundVariableDeclaration(expression.Syntax, temp, expression)
        let convertedElements = ImmutableArray.CreateBuilder[BoundExpression](arity)
        for var i = 0; i < arity; i++ {
            let elementAccess = BoundTupleElementAccessExpression(
                expression.Syntax,
                BoundVariableExpression(expression.Syntax, temp),
                sourceTuple,
                i
            )
            convertedElements.Add(
                BindConversion(diagnosticLocation, elementAccess, targetTuple.ElementTypes[i], allowExplicit)
            )
        }
        let rebuilt = BoundTupleLiteralExpression(expression.Syntax, targetTuple, convertedElements.ToImmutable())
        return BoundBlockExpression(expression.Syntax, ImmutableArray.Create[BoundStatement](declaration), rebuilt)
    }

    private func BindContextualOpenLiteral(
        diagnosticLocation TextLocation,
        expression BoundExpression,
        targetType TypeSymbol
    ) BoundExpression {
        if StatementBinder.IsNilLiteral(expression) {
            return if targetType is NullableTypeSymbol || Conversion.IsReferenceLikeTarget(targetType) {
                cast[BoundExpression](BoundDefaultExpression(expression.Syntax, targetType))
            } else {
                BindConversion(diagnosticLocation, expression, targetType)
            }
        }
        if expression is BoundTupleLiteralExpression sourceTuple &&
            targetType is TupleTypeSymbol targetTuple &&
            sourceTuple
            .Elements
            .Length == targetTuple
            .Arity {
            let elements = ImmutableArray.CreateBuilder[BoundExpression](targetTuple.Arity)
            for var i = 0; i < targetTuple.Arity; i++ {
                elements.Add(
                    BindContextualOpenLiteral(diagnosticLocation, sourceTuple.Elements[i], targetTuple.ElementTypes[i])
                )
            }
            return BoundTupleLiteralExpression(expression.Syntax, targetTuple, elements.MoveToImmutable())
        }
        return BindConversion(diagnosticLocation, expression, targetType, allowExplicit: true)
    }

    private func BindStructuralProjectionCore(
        diagnosticLocation TextLocation,
        expression BoundExpression,
        targetType TypeSymbol,
        strict bool,
        explicitValues IReadOnlyDictionary[string, BoundExpression]?,
        explicitOrder ImmutableArray[string],
        constructionSyntax SyntaxNode?
    ) BoundExpression {
        let explicitNames = if explicitValues == nil {
            default(HashSet[string]?)
        } else {
            HashSet[string](explicitValues.Keys, StringComparer.Ordinal)
        }
        if !StructuralProjectionPlanner.TryCreate(
            expression.Type,
            targetType,
            strict,
            explicitNames,
            out var plan,
            out var failure
        ) ||
            plan is not{} resolvedPlan {
            if expression.Type != TypeSymbol.Error && targetType != TypeSymbol.Error {
                if !string.IsNullOrEmpty(failure) {
                    Diagnostics.ReportStructuralProjectionFailure(
                        diagnosticLocation,
                        expression.Type,
                        targetType,
                        failure
                    )
                } else {
                    Diagnostics.ReportCannotConvert(diagnosticLocation, expression.Type, targetType)
                }
            }
            return BoundErrorExpression(expression.Syntax)
        }
        plan = resolvedPlan
        let ownsDataInitialization = resolvedPlan.Construction.UserType?.UsesConstructorOwnedDataConstruction == true
        let usesPrimaryConstruction = ownsDataInitialization || resolvedPlan.Construction.UserType is {IsClass: true}
        // Check collection omissions before applying optional-call defaults.
        let usesPrimaryZero = ownsDataInitialization ||
            usesPrimaryConstruction &&
            constructionSyntax is StructLiteralExpressionSyntax
        if ownsDataInitialization && !BoundStructLiteralExpression.ValidateDataConstructor(
            resolvedPlan.Construction.UserType!!,
            Diagnostics,
            constructionSyntax ?? expression.Syntax,
            getCurrentFunction(),
            resolvedPlan
                .Construction
                .UserType!!.ClrType is {} constructorType &&
                binderCtx
                .References
                .CanAccessInternalMembers(constructorType.Assembly),
            suppliedPrimaryInputs: resolvedPlan
                .ConstructorSlots
                .Where(
                (slot StructuralProjectionSlot) -> slot.Source != nil || explicitNames?.Contains(slot.Name) == true
            )
                .Select((slot StructuralProjectionSlot) -> slot.Name)
        ) {
            return BoundErrorExpression(expression.Syntax)
        }
        let sourceTemp = LocalVariableSymbol(
            "<projectionSource${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
            isReadOnly: true,
            expression.Type
        )
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(BoundVariableDeclaration(expression.Syntax, sourceTemp, expression))
        var explicitReads Dictionary[string, BoundExpression]? = nil
        if explicitValues != nil {
            explicitReads = Dictionary[string, BoundExpression](StringComparer.Ordinal)
            for name in explicitOrder {
                if !explicitValues.TryGetValue(name, out var value) || explicitReads!!.ContainsKey(name) {
                    continue
                }
                if usesPrimaryConstruction && !plan!!.ConstructorSlots.Any(
                    (slot StructuralProjectionSlot) -> slot.Name == name
                ) {
                    explicitReads!!.Add(name, value)
                    continue
                }
                let explicitTemp = LocalVariableSymbol(
                    "<projectionOverride${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
                    isReadOnly: true,
                    value.Type
                )
                statements.Add(BoundVariableDeclaration(value.Syntax, explicitTemp, value))
                explicitReads!!.Add(name, BoundVariableExpression(value.Syntax, explicitTemp))
            }
        }
        let constructorArguments = ImmutableArray.CreateBuilder[BoundExpression](plan!!.ConstructorSlots.Length)
        for slot in plan!!.ConstructorSlots {
            if usesPrimaryZero && slot.Source == nil && explicitNames?.Contains(slot.Name) != true &&
                resolvedPlan
                .Construction
                .UserType!!
                .PrimaryConstructorParameters
                .FirstOrDefault((parameter ParameterSymbol) -> parameter.Name == slot.Name) is {} parameter {
                let owner = resolvedPlan.Construction.UserType!!
                let zero = MagicCollectionZeroValue.TrySynthesizePrimaryArgument(
                    constructionSyntax ?? expression.Syntax,
                    owner,
                    parameter,
                    out var missingDeclarationShape,
                    slot.TargetType,
                    if owner.IsClass {
                        resolvedPlan.Construction.ClrConstructor
                    } else {
                        default(ConstructorInfo?)
                    }
                )
                if missingDeclarationShape {
                    Diagnostics.ReportNoApplicableOverload(
                        if constructionSyntax is StructLiteralExpressionSyntax literal {
                            literal.TypeIdentifier.Location
                        } else {
                            diagnosticLocation
                        },
                        owner.Name
                    )
                    return BoundErrorExpression(expression.Syntax)
                }
                if zero != nil || ownsDataInitialization {
                    constructorArguments.Add(zero ?? BoundDefaultExpression(expression.Syntax, slot.TargetType))
                    continue
                }
            }
            constructorArguments.Add(
                BindStructuralProjectionSlot(diagnosticLocation, expression.Syntax, sourceTemp, slot, explicitReads)
            )
        }
        var initializerSlots = plan!!.InitializerSlots
        if usesPrimaryConstruction && !explicitOrder.IsDefaultOrEmpty {
            let ordered = ImmutableArray.CreateBuilder[StructuralProjectionSlot](initializerSlots.Length)
            ordered.AddRange(
                initializerSlots.Where((slot StructuralProjectionSlot) -> explicitNames?.Contains(slot.Name) != true)
            )
            for name in explicitOrder {
                ordered.AddRange(initializerSlots.Where((slot StructuralProjectionSlot) -> slot.Name == name))
            }
            initializerSlots = ordered.ToImmutable()
        }
        if targetType is StructSymbol &&
            (ownsDataInitialization || plan!!.Construction.Kind == StructuralProjectionConstructionKind.UserDefault) &&
            plan!!
            .Construction
            .UserType is {IsClass: false} userType {
            let initializers = ImmutableArray.CreateBuilder[BoundFieldInitializer](plan!!.InitializerSlots.Length)
            let initializedFields = HashSet[FieldSymbol]()
            for var i = 0; i < plan!!.ConstructorSlots.Length; i++ {
                let member = BoundStructLiteralExpression.GetPrimaryMember(userType, plan!!.ConstructorSlots[i].Name)
                initializers.Add(
                    if member is FieldSymbol field {
                        BoundFieldInitializer(field, constructorArguments[i])
                    } else {
                        BoundFieldInitializer(
                            Invariant.Required(
                                member as PropertySymbol,
                                "a primary projection input has a mapped storage member",
                                expression: "member as PropertySymbol"
                            ),
                            constructorArguments[i]
                        )
                    }
                )
            }
            for slot in initializerSlots {
                let value = BindStructuralProjectionSlot(
                    diagnosticLocation,
                    expression.Syntax,
                    sourceTemp,
                    slot,
                    explicitReads
                )
                initializers.Add(
                    if slot.TargetField != nil {
                        BoundFieldInitializer(slot.TargetField, value)
                    } else {
                        BoundFieldInitializer(
                            Invariant.Required(
                                slot.TargetProperty,
                                "a non-field projection slot has a target property",
                                expression: "slot.TargetProperty"
                            ),
                            value
                        )
                    }
                )
                if slot.TargetField != nil {
                    initializedFields.Add(slot.TargetField)
                } else if slot.TargetProperty?.BackingField != nil {
                    initializedFields.Add(slot.TargetProperty!!.BackingField!!)
                }
            }
            for field in userType.Fields {
                if ownsDataInitialization || initializedFields.Contains(field) {
                    continue
                }
                if TryGetStructuralProjectionFieldInitializer(
                    plan!!.Construction.UserType!!,
                    field,
                    out var initializer
                ) {
                    initializers.Add(BoundFieldInitializer(field, initializer){IsDeclarationInitializer = true})
                } else if field.Type == TypeSymbol.String {
                    initializers.Add(
                        BoundFieldInitializer(
                            field,
                            BoundLiteralExpression(expression.Syntax, string.Empty, TypeSymbol.String)
                        )
                    )
                }
            }
            let literal = BoundStructLiteralExpression(expression.Syntax, userType, initializers.ToImmutable())
            return BoundBlockExpression(expression.Syntax, statements.ToImmutable(), literal)
        }
        let construction BoundExpression = switch plan!!.Construction.Kind {
            case StructuralProjectionConstructionKind.UserDefault: cast[BoundExpression](
                BoundConstructorCallExpression(
                    expression.Syntax,
                    Invariant.Required(
                        plan!!.Construction.UserType,
                        "a user default projection has a target type",
                        expression: "plan.Construction.UserType"
                    ),
                    ImmutableArray[BoundExpression].Empty
                )
            )
            case StructuralProjectionConstructionKind.UserPrimary: cast[BoundExpression](
                BoundConstructorCallExpression(
                    expression.Syntax,
                    Invariant.Required(
                        plan!!.Construction.UserType,
                        "a user primary projection has a target type",
                        expression: "plan.Construction.UserType"
                    ),
                    constructorArguments.ToImmutable()
                )
            )
            case StructuralProjectionConstructionKind.UserExplicit: cast[BoundExpression](
                BoundConstructorCallExpression(
                    expression.Syntax,
                    Invariant.Required(
                        plan!!.Construction.UserType,
                        "a user explicit projection has a target type",
                        expression: "plan.Construction.UserType"
                    ),
                    constructorArguments.ToImmutable(),
                    plan!!.Construction.UserConstructor
                )
            )
            case StructuralProjectionConstructionKind.ClrConstructor: cast[BoundExpression](
                BoundClrConstructorCallExpression(
                    expression.Syntax,
                    Invariant.Required(
                        targetType.ClrType,
                        "a CLR projection has a CLR target type",
                        expression: "targetType.ClrType"
                    ),
                    Invariant.Required(
                        plan!!.Construction.ClrConstructor,
                        "a CLR constructor projection has a constructor",
                        expression: "plan.Construction.ClrConstructor"
                    ),
                    constructorArguments.ToImmutable(),
                    targetType
                )
            )
            case StructuralProjectionConstructionKind.ClrDefaultValue: cast[BoundExpression](
                BoundDefaultExpression(expression.Syntax, targetType)
            )
            default: throw InvalidOperationException("Unsupported structural projection construction.")
        }
        if plan!!.InitializerSlots.IsDefaultOrEmpty {
            return BoundBlockExpression(expression.Syntax, statements.ToImmutable(), construction)
        }
        let targetTemp = LocalVariableSymbol(
            "<projectionTarget${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
            isReadOnly: false,
            targetType
        )
        statements.Add(BoundVariableDeclaration(expression.Syntax, targetTemp, construction))
        for slot in initializerSlots {
            let receiver = BoundVariableExpression(expression.Syntax, targetTemp)
            let value = BindStructuralProjectionSlot(
                diagnosticLocation,
                expression.Syntax,
                sourceTemp,
                slot,
                explicitReads
            )
            var assignment BoundExpression
            if slot.TargetField != nil {
                assignment = BoundFieldAssignmentExpression(
                    expression.Syntax,
                    targetTemp,
                    Invariant.Required(
                        slot.TargetDeclaringType,
                        "a user field projection has a declaring type",
                        expression: "slot.TargetDeclaringType"
                    ),
                    slot.TargetField,
                    value
                )
            } else if slot.TargetProperty != nil {
                assignment = BoundPropertyAssignmentExpression(
                    expression.Syntax,
                    receiver,
                    Invariant.Required(
                        slot.TargetDeclaringType,
                        "a user property projection has a declaring type",
                        expression: "slot.TargetDeclaringType"
                    ),
                    slot.TargetProperty,
                    value
                )
            } else {
                assignment = BoundClrPropertyAssignmentExpression(
                    expression.Syntax,
                    receiver,
                    Invariant.Required(
                        slot.TargetClrMember,
                        "a CLR projection has a target member",
                        expression: "slot.TargetClrMember"
                    ),
                    value,
                    slot.TargetType,
                    staticContainerType: nil
                )
            }
            statements.Add(BoundExpressionStatement(expression.Syntax, assignment))
        }
        return BoundBlockExpression(
            expression.Syntax,
            statements.ToImmutable(),
            BoundVariableExpression(expression.Syntax, targetTemp)
        )
    }

    private func BindStructuralProjectionSlot(
        diagnosticLocation TextLocation,
        syntax SyntaxNode?,
        sourceTemp VariableSymbol,
        slot StructuralProjectionSlot,
        explicitReads IReadOnlyDictionary[string, BoundExpression]?
    ) BoundExpression {
        if slot.Source == nil {
            if explicitReads != nil && explicitReads.TryGetValue(slot.Name, out var explicitRead) {
                return explicitRead
            }
            if slot.UserDefaultParameter != nil {
                return OverloadResolver.CreateOptionalUserDefaultArgument(slot.UserDefaultParameter)
            }
            if slot.ClrDefaultParameter != nil {
                return CreateOptionalDefaultArgument(slot.ClrDefaultParameter)
            }
            throw InvalidOperationException("Structural projection slot '${slot.Name}' has no value.")
        }
        let source = slot.Source
        let receiver = BoundVariableExpression(syntax, sourceTemp)
        var read BoundExpression
        if source!!.Field != nil {
            read = BoundFieldAccessExpression(
                syntax,
                receiver,
                Invariant.Required(
                    source!!.DeclaringType,
                    "a user projection field has a declaring type",
                    expression: "source.DeclaringType"
                ),
                source!!.Field!!
            )
        } else if source!!.Property != nil {
            read = BoundPropertyAccessExpression(
                syntax,
                receiver,
                Invariant.Required(
                    source!!.DeclaringType,
                    "a user projection property has a declaring type",
                    expression: "source.DeclaringType"
                ),
                source!!.Property!!
            )
        } else {
            read = BoundClrPropertyAccessExpression(
                syntax,
                receiver,
                Invariant.Required(
                    source!!.ClrMember,
                    "a CLR projection source has a member",
                    expression: "source.ClrMember"
                ),
                source!!.Type
            )
        }
        return BindConversion(diagnosticLocation, read, slot.TargetType)
    }

    shared {
        // Issue #4400: name prefix of the readonly temp an implicit-`in` rvalue is
        // spilled into (see CreateImplicitInReference / IsImplicitInTemp).
        private const ImplicitInTempPrefix string = "<inArgument"

        // ----- Pure static helpers (no instance state) -----
        /// Issue #327/#321: appends synthesized default-value arguments for any
        /// trailing optional parameters the call site omitted.
        /// [`parameters`](paramref) is the full parameter list of the
        /// resolved CLR method/constructor; [`suppliedArguments`](paramref)
        /// are the arguments already bound for the leading parameters (for
        /// instance/extension calls this includes the receiver mapped onto the
        /// first parameter). When no parameters are omitted, the supplied array
        /// is returned unchanged.
        /// @param suppliedArguments Bound arguments mapped to the leading
        /// parameters.
        /// @param parameters The resolved method's full parameter list.
        /// @returns The argument array padded to the parameter count with
        /// defaults.
        func AppendOmittedOptionalArguments(
            suppliedArguments ImmutableArray[BoundExpression],
            parameters[]ParameterInfo
        ) ImmutableArray[BoundExpression] {
            if suppliedArguments.Length >= parameters.Length {
                return suppliedArguments
            }
            let builder = ImmutableArray.CreateBuilder[BoundExpression](parameters.Length)
            builder.AddRange(suppliedArguments)
            for var i = suppliedArguments.Length; i < parameters.Length; i++ {
                builder.Add(CreateOptionalDefaultArgument(parameters[i]))
            }
            return builder.MoveToImmutable()
        }

        /// Issue #327/#321: builds the bound expression for an omitted optional
        /// parameter. An explicit constant default (e.g. `int x = 5`)
        /// becomes the corresponding literal; `= default`/`= null` and
        /// constant-less `[Optional]` parameters (e.g.
        /// `CancellationToken cancellationToken = default`) become the zero
        /// value of the parameter type.
        /// @param parameter The omitted optional parameter.
        /// @returns The bound default-value argument.
        func CreateOptionalDefaultArgument(parameter ParameterInfo) BoundExpression {
            let typeSymbol = ClrNullability.GetParameterTypeSymbol(parameter)
            if TryGetDateTimeParameterDefault(parameter, out var dateTime) {
                let constructor ConstructorInfo? = parameter
                    .ParameterType
                    .GetConstructors()
                    .FirstOrDefault(
                    (candidate ConstructorInfo) -> candidate.GetParameters() is [
                        {ParameterType: {FullName: "System.Int64"}}
                    ]
                )
                if constructor != nil {
                    return BoundClrConstructorCallExpression(
                        nil,
                        parameter.ParameterType,
                        constructor,
                        ImmutableArray.Create[BoundExpression](BoundLiteralExpression(nil, dateTime.Ticks)),
                        typeSymbol
                    )
                }
            }
            if IsMissingParameterDefault(parameter) {
                let missingType = parameter.ParameterType.Assembly.GetType("System.Reflection.Missing")
                let valueField FieldInfo? = missingType?.GetField("Value", BindingFlags.Public | BindingFlags.Static)
                if valueField != nil {
                    return BoundClrPropertyAccessExpression(nil, nil, valueField, typeSymbol)
                }
            }
            if TryGetConstantParameterDefault(parameter, out var constant) {
                let literal = BoundLiteralExpression(nil, constant)
                return if parameter.ParameterType.IsEnum {
                    cast[BoundExpression](BoundConversionExpression(nil, typeSymbol, literal))
                } else {
                    cast[BoundExpression](literal)
                }
            }
            return BoundDefaultExpression(nil, typeSymbol)
        }

        /// ADR-0056 §1: when a CLR member returns a (cref:ByRefTypeSymbol)
        /// (e.g. `ref T` from a span indexer or a ref-returning property /
        /// method), automatically dereference at the use site so that downstream
        /// code observes the pointee type. Returns the expression unchanged
        /// otherwise.
        /// @param expression The bound member-access / call / index
        /// expression.
        /// @returns The (possibly dereferenced) bound expression.
        func AutoDereferenceRefReturn(expression BoundExpression) BoundExpression {
            return if expression.Type is ByRefTypeSymbol {
                cast[BoundExpression](BoundDereferenceExpression(nil, expression))
            } else {
                expression
            }
        }

        /// Checks the symbolic and CLR implicit conversion operators for a type pair.
        /// @param sourceType The source type.
        /// @param targetType The target type.
        /// @returns `true` when an implicit conversion operator applies.
        func HasUserDefinedImplicitConversionForTypes(sourceType TypeSymbol, targetType TypeSymbol) bool {
            if sourceType is NullableTypeSymbol liftedSource &&
                TryResolveLiftedUserDefinedSymbolConversion(
                liftedSource,
                targetType,
                allowExplicit: false,
                out _,
                out _
            ) {
                return true
            }
            if TryResolveUserDefinedSymbolConversion(sourceType, targetType, allowExplicit: false, out _) {
                return true
            }
            return sourceType?.ClrType != nil &&
                targetType?.ClrType != nil &&
                ClrOperatorResolution.TryResolveConversionForTypes(
                sourceType,
                targetType,
                allowExplicit: false,
                out var method,
                out _
            ) &&
                BoundClrConversionCallExpression.CanApplyImplicitClrConversion(sourceType, targetType, method!!)
        }

        /// ADR-0087 §3 R5 / issue #765: when a method is invoked on a constructed
        /// generic whose type arguments require symbolic projection,
        /// return the substituted symbolic parameter type for the call site so
        /// the binder does not insert a box conversion to the type-erased
        /// (cref:object) shape. Returns `null` when no
        /// substitution applies.
        /// @param method The resolved CLR method (may be null).
        /// @param paramIndex Zero-based index into the method's parameter list.
        /// @param receiverType The receiver's bound type symbol.
        /// @param symbolicMethodTypeArgs Issue #2375: the symbolic method
        /// type-argument vector (e.g. `[Conversion]` for
        /// `Builder[Book].HasOneRequired[Conversion](...)`), threaded through
        /// alongside the receiver's own `TypeArguments` so a parameter type
        /// that mentions BOTH the declaring generic type's parameter (`TEntity`)
        /// AND the method's own type parameter (`TRelated`) — e.g.
        /// `Expression<Func<TEntity,TRelated>>` — is substituted in
        /// a single pass. Without this, a method-level generic parameter whose
        /// (cref:Type.GenericParameterPosition) coincides with the
        /// receiver's own type-parameter position (both commonly `0` for a
        /// single-type-parameter type and a single-method-type-parameter method)
        /// was previously left as an unresolved open `!!0` reference (or,
        /// before the companion fix, silently and incorrectly matched against the
        /// receiver's own argument). May be default/empty when the method is
        /// non-generic or its type arguments could not be recovered.
        /// @returns The substituted target symbol or `null`.
        func TrySubstituteParameterTypeFromReceiver(
            method MethodInfo?,
            paramIndex int32,
            receiverType TypeSymbol?,
            symbolicMethodTypeArgs ImmutableArray[TypeSymbol?] = default(ImmutableArray[TypeSymbol?])
        ) TypeSymbol? {
            // Issues #2385/#2664: the receiver type-argument gate previously only
            // matched a same-compilation user type when it was DIRECTLY a
            // StructSymbol/InterfaceSymbol/EnumSymbol/DelegateTypeSymbol (or
            // nested inside another ImportedTypeSymbol). A same-compilation
            // struct/enum WRAPPED in Nullable<T> (e.g. `List[Point?]` — the
            // receiver type argument is a NullableTypeSymbol over the struct, not
            // the struct itself) matched none of those cases, so the gate bailed
            // out (`return null`) before ever attempting the substitution. The
            // call then fell back to the erased CLR parameter type (`object`),
            // misclassifying the argument as a boxing conversion and emitting an
            // invalid `box`/`ldnull` sequence against a value-type
            // `Nullable<T>` generic parameter slot (InvalidProgramException at
            // runtime — see #2385). `TypeSymbol.RequiresSymbolicProjection`
            // is the general, already-established predicate for exactly this
            // shape (it recurses through NullableTypeSymbol/SliceTypeSymbol/
            // ArrayTypeSymbol/TupleTypeSymbol/nested ImportedTypeSymbol
            // uniformly — the same predicate reused to fix the analogous #2381
            // async-return-erasure bug), and is a structural superset of the old
            // ad hoc list, so replacing it here also generalizes to
            // same-compilation enums and array/tuple-wrapped shapes used as a
            // generic type argument, and also retains nullable-reference
            // annotations whose CLR type is otherwise identical to its underlying
            // non-null reference. Issue #3560 also retains fully CLR-backed tuple
            // arguments because their element-wise conversion semantics cannot be
            // recovered from the nominal ValueTuple reflection type alone.
            // Issue #4012: a FIXED-LENGTH array type argument is retained on the
            // receiver (#3962 keeps `[3]int32` in `List[[3]int32]`'s symbolic
            // `TypeArguments`) but satisfied NEITHER of the two tests above:
            // `[3]int32` has a real `int32[]` `ClrType`, so
            // `RequiresSymbolicProjection` says no, and it is not a tuple. So this
            // helper bailed before ever mapping the slot, `Add`'s parameter stayed
            // the `int32[]` reflection reports off the erased `List<System.Int32[]>`,
            // and `xs.Add([4]int32{…})` was accepted at a `List[[3]int32]` — the
            // declared length #3998 made part of the type was simply not in the
            // picture. `ContainsFixedLengthArray` is the #3962 predicate for
            // exactly this shape and recurses the same way, so a nested
            // `List[[][3]int32]` is covered too.
            //
            // This is NOT `ImportedTypeSymbol.HasSubstitutableTypeArgument`
            // (ImportedTypeSymbol.cs:91). #4002's hand-off predicted that widening
            // THAT property would close this row; #3998 applied the widening,
            // measured it, and it changed nothing — the ordinary imported
            // instance-call path never consults it for parameter types. The gate
            // that actually decides is this inline one.
            // Issue #4738: source classes inherit the same symbolic imported slots.
            // Project through the actual declaring owner, not the receiver's
            // argument order (an imported base may reorder or nest those arguments).
            if method == nil || receiverType == nil || MemberLookup.GetProjectionReceiverImportedType(
                receiverType
            ) is not ImportedTypeSymbol imported ||
                imported
                .TypeArguments
                .IsDefaultOrEmpty ||
                !imported
                .TypeArguments
                .Any(
                (argument TypeSymbol) -> TypeSymbol.RequiresSymbolicProjection(argument) ||
                    TypeSymbol.ContainsFixedLengthArray(argument) || argument is TupleTypeSymbol
            ) {
                return nil
            }
            let declaring Type? = method.DeclaringType
            if declaring == nil || !declaring.IsConstructedGenericType {
                return nil
            }
            if !MemberLookup.TryGetSymbolicDeclaringContext(
                imported,
                declaring,
                out var openDef,
                out var declaringTypeArguments
            ) ||
                openDef == nil {
                return nil
            }
            var openMethod MethodInfo? = nil
            for candidate in openDef.GetMethods(
                BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            ) {
                if candidate.MetadataToken == method.MetadataToken && candidate.Module == method.Module {
                    openMethod = candidate
                    break
                }
            }
            if openMethod == nil {
                return nil
            }
            let openParams = openMethod.GetParameters()
            if paramIndex < 0 || paramIndex >= openParams.Length {
                return nil
            }
            var openParamType Type? = openParams[paramIndex].ParameterType
            if openParamType!!.IsByRef {
                openParamType = openParamType!!.GetElementType()
            }
            if openParamType == nil {
                return nil
            }
            // Issue #2365: the bare-slot check above only covers a parameter whose
            // OWN type IS the declaring type's generic parameter directly (`!0` of
            // `List[T].Add(!0)`). A parameter that merely MENTIONS that type
            // parameter nested inside a constructed generic — e.g.
            // `Expression<Func<TColumns,object>>` on
            // `CreateTableBuilder[TColumns].PrimaryKey` — falls through unhandled,
            // so the closed CLR shape (`Expression<Func<object,object>>`) is used
            // as the conversion target, erasing the lambda's expression-tree
            // delegate to `object` even though the earlier delegate-rebind step
            // (see `TryBuildSymbolicDelegateTargetForMethodParam`) already
            // recovered the correct symbolic literal shape. Recover the full
            // substituted shape via the same general recursive projection used by
            // the method-type-argument sibling below
            // (<see cref="TrySubstituteParameterTypeFromMethodTypeArgs"/>), which
            // already understands arrays, tuples, nullable, and arbitrarily nested
            // constructed generics (delegates, `Expression&lt;&gt;`, ...).
            //
            // Issue #2375: pass `openMethod`/`symbolicMethodTypeArgs` alongside the
            // receiver's own `openDef`/`imported.TypeArguments` so a parameter type
            // that mentions the method's OWN generic parameter (e.g. `TRelated` in
            // `Expression<Func<TEntity,TRelated>>`) is substituted in the SAME pass
            // as the receiver's `TEntity` — rather than only ever substituting one
            // or the other depending on which happens to be tried first.
            var effectiveMethodTypeArgs = symbolicMethodTypeArgs
            if effectiveMethodTypeArgs.IsDefaultOrEmpty && method.IsGenericMethod && !method.ContainsGenericParameters {
                let closedArguments = method.GetGenericArguments()
                let mappedArguments = ImmutableArray.CreateBuilder[TypeSymbol?](closedArguments.Length)
                for argument in closedArguments {
                    mappedArguments.Add(
                        TypeSymbol.FromClrTypeWithoutNullability(argument, NullabilityFreeReason.TypeStructure)
                    )
                }
                effectiveMethodTypeArgs = mappedArguments.MoveToImmutable()
            }
            let mapped TypeSymbol? = MemberLookup.GetClrOpenParameterConversionTargetTypeSymbol(
                openParams[paramIndex],
                openDef,
                declaringTypeArguments,
                openMethod,
                effectiveMethodTypeArgs
            )
            // Issue #4012: the exit filter is the entry gate's twin and needed the
            // same widening. Without it the mapped `[3]int32` — recovered
            // correctly, right here — was discarded as "nothing symbolic to keep"
            // and the caller fell back to the erased `int32[]` anyway.
            return if mapped != nil &&
                mapped != TypeSymbol.Error &&
                (
                TypeSymbol.RequiresSymbolicProjection(mapped) ||
                    mapped is TupleTypeSymbol ||
                    TypeSymbol.ContainsFixedLengthArray(mapped) || TypeSymbol.ContainsNamedTupleElements(mapped)
            ) {
                mapped
            } else {
                default(TypeSymbol?)
            }
        }

        /// Issue #3932: resolves an IMPORTED user-defined implicit conversion
        /// operator whose declaring generic type is closed over a symbolic or open
        /// type argument — the `[]T -> System.Memory[T]` shape that
        /// (cref:ClrOperatorResolution) cannot see because an open
        /// `[]T` has no reflectible (cref:Type).
        ///
        /// The operator is looked up on the target's OPEN definition
        /// (`Memory`1::op_Implicit(!0[])`) and accepted only when BOTH its
        /// parameter and its return type, mapped through the target's symbolic type
        /// arguments, match the source and the target exactly. That two-sided match
        /// is what keeps this from firing on an unrelated operator that merely
        /// happens to be named `op_Implicit`.
        ///
        /// The returned (cref:MethodInfo) is the OPEN one, which the
        /// emitter recognises (see `MethodBodyEmitter.EmitCallResolvedConversion`)
        /// as its signal to parent the MemberRef at the symbolic TypeSpec rather
        /// than at the erased `Memory<object>`.
        /// @param source The source type symbol.
        /// @param target The conversion target type symbol.
        /// @param conversion The resolved OPEN conversion operator.
        /// @returns Whether a symbolic imported implicit conversion applies.
        func TryResolveSymbolicImportedConversion(
            source TypeSymbol?,
            target TypeSymbol?,
            @NotNullWhen(true) out conversion MethodInfo?
        ) bool {
            conversion = nil
            if source == nil || target == nil {
                return false
            }
            // Only the symbolic/open case is in scope: a fully CLR-backed pair
            // already resolves through ClrOperatorResolution, and re-resolving it
            // here would change which operator a concrete call site picks.
            if !NeedsSymbolicConversion(target) && !NeedsSymbolicConversion(source) {
                return false
            }
            // Issue #3932: the operator declared on the TARGET's open definition
            // (`Memory`1::op_Implicit(!0[])`).
            if target is ImportedTypeSymbol{OpenDefinition: {} targetOpen} importedTarget &&
                !importedTarget
                .TypeArguments
                .IsDefaultOrEmpty &&
                TryFindSymbolicImplicitOperator(
                targetOpen,
                importedTarget.TypeArguments,
                source,
                target,
                out conversion
            ) {
                return true
            }
            // Issue #4350: the operator declared on the SOURCE's open definition
            // (`Span`1::op_Implicit(Span<!0>) : ReadOnlySpan<!0>`). The erased CLR
            // branch would otherwise bind `Span<object>`'s operator inside a
            // generic body and emit unverifiable IL.
            return source is ImportedTypeSymbol{OpenDefinition: {} sourceOpen} importedSource &&
                !importedSource
                .TypeArguments
                .IsDefaultOrEmpty &&
                TryFindSymbolicImplicitOperator(
                sourceOpen,
                importedSource.TypeArguments,
                source,
                target,
                out conversion
            )
        }

        /// Issue #3932: the `newobj` analogue of
        /// (cref:TrySubstituteParameterTypeFromReceiver) and
        /// (cref:TryRecoverReceiverTypeParameterSlot). A constructor has no
        /// receiver, so neither of those helpers can fire and a CLR ctor parameter
        /// declared as the declaring generic's own slot (`ValueTask<T>(!0)`)
        /// stayed at the type-erased closed shape — `object` — for the whole
        /// argument-conversion pass. The argument was then classified as a boxing
        /// conversion, so gsc emitted `box !!T` in front of a `newobj`
        /// whose parent TypeSpec is the correctly symbolic `ValueTask`1<!!T>`
        /// — invalid IL that ILVerify reports as
        /// `[found ref 'T'][expected value 'T']`. The equivalent method call
        /// (`List[T].Add(v)`) has always emitted the raw `T`, so this is a
        /// ctor-only hole in machinery gsc already had.
        ///
        /// Mapping the OPEN constructor's parameter type through the
        /// construction's symbolic type arguments recovers the real slot. Bare type
        /// parameters are accepted here (unlike the #765 receiver gate, which
        /// deliberately skips them and leaves that case to #1540's helper) because
        /// for a ctor there is no second pass to fall back to.
        /// @param openGenericDefinition The open generic definition being constructed, if any.
        /// @param symbolicTypeArgs The construction's symbolic type arguments.
        /// @param closedConstructor The resolved (closed, erased) CLR constructor.
        /// @param paramIndex Zero-based index into the constructor's parameter list.
        /// @param peelByRef Issue #4400: map a by-ref slot's POINTEE instead
        /// of skipping it, for an implicit `in` argument that must be spilled
        /// or addressed at the symbolic type (`Holder<T>(in !0)`).
        /// @returns The recovered symbolic parameter type, or `null`.
        func TrySubstituteCtorParameterTypeFromConstructedType(
            openGenericDefinition Type?,
            symbolicTypeArgs ImmutableArray[TypeSymbol],
            closedConstructor ConstructorInfo?,
            paramIndex int32,
            peelByRef bool = false
        ) TypeSymbol? {
            // Whether an open CLR type mentions a TYPE-level generic parameter
            // anywhere in its shape (directly, or nested through arrays, by-ref,
            // pointers and constructed generics).
            let MentionsTypeGenericParameter = func (type Type?) bool {
                if type == nil {
                    return false
                }
                if type.IsGenericParameter {
                    return type.DeclaringMethod == nil
                }
                if type.HasElementType {
                    return MentionsTypeGenericParameter(type.GetElementType())
                }
                if type.IsGenericType {
                    for argument in type.GetGenericArguments() {
                        if MentionsTypeGenericParameter(argument) {
                            return true
                        }
                    }
                }
                return false
            }
            if openGenericDefinition == nil ||
                closedConstructor == nil ||
                symbolicTypeArgs.IsDefaultOrEmpty ||
                paramIndex < 0 {
                return nil
            }
            var openCtor ConstructorInfo? = nil
            try {
                for candidate in openGenericDefinition.GetConstructors(
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
                ) {
                    if candidate.MetadataToken == closedConstructor.MetadataToken &&
                        candidate.Module == closedConstructor.Module {
                        openCtor = candidate
                        break
                    }
                }
            } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                return nil
            }
            if openCtor == nil {
                return nil
            }
            let openParams = openCtor.GetParameters()
            if paramIndex >= openParams.Length {
                return nil
            }
            var openParamType = openParams[paramIndex].ParameterType
            if openParamType.IsByRef != peelByRef {
                // A by-ref ctor slot is emitted as an address, never boxed, so it
                // is already correct and rewriting it here would change RefKind
                // handling downstream. Only the implicit-`in` caller asks for it.
                return nil
            }
            if peelByRef {
                openParamType = Invariant.Required(
                    openParamType.GetElementType(),
                    "a by-ref parameter has an element type",
                    expression: "openParamType.GetElementType()"
                )
            }
            // Only a parameter that actually MENTIONS the declaring generic's own
            // parameters can have been erased. A genuine `object` slot (e.g.
            // `List[T](object)`) has no generic parameter in it and must keep
            // boxing, so leaving it alone here is what preserves #1196.
            if !MentionsTypeGenericParameter(openParamType) {
                return nil
            }
            let mapped TypeSymbol? = MemberLookup.GetClrOpenParameterConversionTargetTypeSymbol(
                openParams[paramIndex],
                openGenericDefinition,
                symbolicTypeArgs
            )
            return if mapped != nil && mapped != TypeSymbol.Error {
                mapped
            } else {
                default(TypeSymbol?)
            }
        }

        /// Issue #1540: recovers the receiver's type argument for an erased open
        /// type-parameter slot (e.g. the `!0` element type of
        /// `List[T].Add(!0)`) when that argument is itself a type parameter —
        /// the case (cref:TrySubstituteParameterTypeFromReceiver) deliberately
        /// skips (its #765 filter rewrites only user symbolic type arguments). This
        /// lets the caller re-target a `T` argument onto the real `T` slot
        /// so it is classified as an identity conversion (no spurious box), matching
        /// the pre-#1540 behaviour and keeping the #1196 invariant. Returns
        /// `null` for a genuine `object` slot (or any non
        /// type-parameter type argument), so those arguments still box correctly.
        /// @param method The resolved (closed) CLR method (may be null).
        /// @param paramIndex Zero-based index into the method's parameter list.
        /// @param receiverType The receiver's (symbolic) type.
        /// @returns The recovered type-parameter slot, or `null`.
        func TryRecoverReceiverTypeParameterSlot(
            method MethodInfo?,
            paramIndex int32,
            receiverType TypeSymbol?
        ) TypeSymbol? {
            if method == nil ||
                receiverType is not ImportedTypeSymbol imported ||
                imported
                .TypeArguments
                .IsDefaultOrEmpty {
                return nil
            }
            let declaring Type? = method.DeclaringType
            if declaring == nil || !declaring.IsConstructedGenericType {
                return nil
            }
            let openDef = declaring.GetGenericTypeDefinition()
            var openMethod MethodInfo? = nil
            for candidate in openDef.GetMethods(
                BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            ) {
                if candidate.MetadataToken == method.MetadataToken && candidate.Module == method.Module {
                    openMethod = candidate
                    break
                }
            }
            if openMethod == nil {
                return nil
            }
            let openParams = openMethod.GetParameters()
            if paramIndex < 0 || paramIndex >= openParams.Length {
                return nil
            }
            var openParamType = openParams[paramIndex].ParameterType
            // Issue #4400: an `in` slot (`T&`) recovers its pointee's slot. The
            // by-value callers never pass a by-ref parameter here.
            if openParamType.IsByRef {
                openParamType = Invariant.Required(
                    openParamType.GetElementType(),
                    "a by-ref parameter has an element type",
                    expression: "openParamType.GetElementType()"
                )
            }
            if openParamType.IsGenericParameter &&
                openParamType.DeclaringMethod == nil &&
                openParamType.GenericParameterPosition < imported
                .TypeArguments
                .Length &&
                imported.TypeArguments[openParamType.GenericParameterPosition] is TypeParameterSymbol recovered {
                return recovered
            }
            return nil
        }

        /// Issue #1471: recovers the symbolic parameter type for a generic CLR
        /// method invoked with a method-level type-argument vector that includes an
        /// open type parameter (or a same-compilation user type). The closed CLR
        /// method erases such arguments to the reference-context (cref:object)
        /// placeholder, so the closed parameter type is `object`; mapping the
        /// open method parameter through [`methodTypeArgs`](paramref) recovers
        /// the real symbol (e.g. `T?` for `Task.FromResult[T?]`). Returns
        /// `null` when no symbolic recovery applies, so concrete
        /// instantiations keep flowing through the erased CLR shape unchanged.
        /// @param method The resolved (closed) CLR method (may be null).
        /// @param paramIndex Zero-based index into the method's parameter list.
        /// @param methodTypeArgs The symbolic method type-argument vector.
        /// @param allowConcreteSymbolic Whether a fully concrete symbolic target is still required for
        /// contextual literal conversion.
        /// @returns The recovered symbolic parameter type, or `null`.
        func TrySubstituteParameterTypeFromMethodTypeArgs(
            method MethodInfo?,
            paramIndex int32,
            methodTypeArgs ImmutableArray[TypeSymbol?],
            allowConcreteSymbolic bool = false
        ) TypeSymbol? {
            if method == nil || !method.IsGenericMethod || methodTypeArgs.IsDefaultOrEmpty || paramIndex < 0 {
                return nil
            }
            let openMethod = if method.IsGenericMethodDefinition {
                method
            } else {
                method.GetGenericMethodDefinition()
            }
            let openParams = openMethod.GetParameters()
            if paramIndex >= openParams.Length {
                return nil
            }
            var openParamType Type? = openParams[paramIndex].ParameterType
            if openParamType!!.IsByRef {
                openParamType = openParamType!!.GetElementType()
            }
            if openParamType == nil {
                return nil
            }
            // Symbolic inference can leave an Error/null slot when a deferred
            // method group supplies that type only to CLR inference. Preserve the
            // symbolic slots and fill unresolved ones from the selected closure.
            var effectiveMethodTypeArgs = methodTypeArgs
            if !method.IsGenericMethodDefinition && methodTypeArgs.Any(
                (type TypeSymbol?) -> type == nil || type == TypeSymbol.Error
            ) {
                let closedTypeArgs = method.GetGenericArguments()
                let merged = ImmutableArray.CreateBuilder[TypeSymbol?](methodTypeArgs.Length)
                for var i = 0; i < methodTypeArgs.Length; i++ {
                    let symbolicType TypeSymbol? = methodTypeArgs[i]
                    merged.Add(
                        if symbolicType != nil && symbolicType != TypeSymbol.Error {
                            symbolicType
                        } else {
                            (
                                if uint32(i) < uint32(closedTypeArgs.Length) {
                                    TypeSymbol.FromClrTypeWithoutNullability(
                                        closedTypeArgs[i],
                                        NullabilityFreeReason.TypeStructure
                                    )
                                } else {
                                    default(TypeSymbol?)
                                }
                            )
                        }
                    )
                }
                effectiveMethodTypeArgs = merged.MoveToImmutable()
            }
            let mapped TypeSymbol? = MemberLookup.GetClrOpenParameterConversionTargetTypeSymbol(
                openParams[paramIndex],
                openDefinition: nil,
                typeArguments: default(ImmutableArray[TypeSymbol]),
                openMethod,
                effectiveMethodTypeArgs
            )
            return if mapped != nil &&
                mapped != TypeSymbol.Error &&
                (
                allowConcreteSymbolic || TypeSymbol.ContainsTypeParameter(mapped) ||
                    TypeSymbol.ContainsSameCompilationUserType(mapped)
            ) {
                mapped
            } else {
                default(TypeSymbol?)
            }
        }

        /// Issue #4400: whether [`variable`](paramref) is the readonly temp
        /// (cref:CreateImplicitInReference) spills an rvalue into.
        /// @param variable The variable to test.
        /// @returns `true` for an implicit-`in` spill temp.
        func IsImplicitInTemp(variable VariableSymbol) bool -> variable is LocalVariableSymbol &&
            variable
            .Name
            .StartsWith(ImplicitInTempPrefix, StringComparison.Ordinal)

        /// Issue #4400: whether [`argument`](paramref) is a plain value at an
        /// imported `in` (or `ref readonly`) parameter — one that still
        /// needs the readonly reference a call-site `in` would have produced.
        /// @param argument The bound argument.
        /// @param parameter The imported CLR parameter.
        /// @returns `true` when the argument must be passed by implicit readonly reference.
        func IsImplicitInClrArgument(argument BoundExpression, parameter ParameterInfo) bool -> parameter
            .ParameterType
            .IsByRef &&
            parameter.IsIn &&
            !parameter.IsOut &&
            (IsPlainValueArgument(argument) || ClrOverloadResolution.IsUnresolvedMethodGroupArgument(argument))

        /// Issue #4400: whether a bound argument is a plain VALUE — not already an
        /// address (`in x`, `&x`, a conditional address, a `*T`),
        /// not a by-ref interpolated-string handler (lowered to an address later),
        /// and not an error. An untyped `default` placeholder counts: it is
        /// materialized at the pointee type.
        /// @param argument The bound argument.
        /// @returns `true` when an `in` slot needs it passed by implicit reference.
        func IsPlainValueArgument(argument BoundExpression) bool -> !(
            (
                argument is BoundAddressOfExpression ||
                    argument is BoundConditionalAddressExpression ||
                    argument is BoundErrorExpression
            )
        ) &&
            !(argument is BoundInterpolatedStringExpression && argument.Handler != nil) &&
            argument.Type is not(ByRefTypeSymbol or PointerTypeSymbol) &&
            (argument.Type != TypeSymbol.Error || argument is BoundDefaultExpression)

        /// Issue #4400: the pointee type an implicit `in` argument converts to
        /// at an imported by-reference parameter, recovering a symbolic
        /// (same-compilation) type argument the closed CLR signature erased.
        /// @param parameter The imported CLR parameter.
        /// @param paramIndex The parameter's index.
        /// @param method The resolved CLR method, when known.
        /// @param receiverType The receiver type carrying symbolic type arguments.
        /// @param symbolicMethodTypeArgs The symbolic method type arguments.
        /// @param argument The argument whose nil-containing target may need full projection.
        /// @returns The pointee type.
        func GetImplicitInClrPointeeType(
            parameter ParameterInfo,
            paramIndex int32,
            method MethodInfo?,
            receiverType TypeSymbol?,
            symbolicMethodTypeArgs ImmutableArray[TypeSymbol?],
            argument BoundExpression? = nil
        ) TypeSymbol {
            // Each of these readers already peels the by-ref slot and returns the
            // (nullability-annotated) pointee — `in string?` stays `string?`, and
            // an `in int*` pointee stays a pointer — so none is re-peeled here.
            if method != nil && argument != nil && TypeSymbol.ContainsNullLiteralType(argument.Type) &&
                MemberLookup.GetClrMethodParameterConversionTargetTypeSymbol(
                receiverType,
                method,
                paramIndex,
                symbolicMethodTypeArgs
            ) is {} nilTarget {
                return nilTarget
            }
            return TrySubstituteParameterTypeFromReceiver(method, paramIndex, receiverType, symbolicMethodTypeArgs) ??
                TrySubstituteParameterTypeFromMethodTypeArgs(method, paramIndex, symbolicMethodTypeArgs) ??
                TryRecoverReceiverTypeParameterSlot(method, paramIndex, receiverType) ??
                ClrNullability.GetParameterTypeSymbol(parameter)
        }

        // Issue #1334: shared accessor so the generic-LINQ delegate-argument rebind
        // path (ExpressionBinder.Calls) can apply the same NUMERIC-only return
        // widening gate used by BindConversion, rather than an over-broad implicit
        // conversion check that erased same-compilation user-type projections.
        internal func IsNumericReturnWidening(source TypeSymbol, target TypeSymbol) bool {
            return IsNumericReturnWideningCore(source, target)
        }

        /// Issue #3907: true when [`parameter`](paramref) is annotated
        /// `@AllowNull` and [`sourceType`](paramref) is the nullable
        /// spelling of the parameter's own [`targetType`](paramref) — i.e.
        /// the argument is precisely the `nil`-carrying input the annotation
        /// declares the parameter accepts.
        /// @remarks Two properties make this safe, and both are load-bearing.
        ///
        /// <b>It is annotation-only.</b> The parameter's own
        /// declared type is never widened. Widening it would make a
        /// value-type `T` emit a `Nullable<T>` signature slot where
        /// `T` is expected — wrong IL that ILVerify does not catch, because
        /// the metadata is internally consistent and simply describes a different
        /// method. Keeping the slot at `T` also preserves the asymmetry the
        /// attribute exists for: reads of the parameter inside the body still see
        /// a non-nullable `T` and still need the author's `!!`.
        ///
        /// <b>It never reshapes the emitted call.</b> The relaxation is
        /// gated on (cref:NullableLifting.IsAnyValueTypeNullable) being
        /// false, so the source nullable is one whose runtime representation is
        /// identical to its underlying (ADR-0001 §Phase 3.C.1: for a reference
        /// type or an unconstrained type parameter, `T?` relays `T`'s
        /// `ClrType` and the IL value is the same reference either way). A
        /// value-type nullable — `int32?` into an `@AllowNull`
        /// `int32` slot — really is `Nullable<int32>` on the
        /// stack, is rejected by C# too, and stays rejected here. The underlying
        /// must also be IDENTICAL to the target rather than merely convertible to
        /// it, so this admits exactly `T?` at a `T` slot and no other
        /// shape; the argument is returned unchanged, with no synthesized
        /// conversion node.
        /// @param parameter The target parameter, or `null` when not binding a call argument.
        /// @param sourceType The argument's static type.
        /// @param targetType The parameter's (substituted) declared type.
        /// @returns `true` when the argument is accepted as-is.
        internal func AcceptsNilAnnotatedArgument(
            parameter ParameterSymbol?,
            sourceType TypeSymbol?,
            targetType TypeSymbol?
        ) bool {
            if !(parameter != nil && parameter.AllowsNullArgument == true) ||
                targetType == nil ||
                targetType == TypeSymbol.Error ||
                sourceType is not NullableTypeSymbol nullableSource ||
                NullableLifting.IsAnyValueTypeNullable(nullableSource) {
                return false
            }
            let underlying TypeSymbol? = nullableSource.UnderlyingType
            return underlying != nil && underlying != TypeSymbol.Error && Conversion.Classify(underlying, targetType)
                .IsIdentity
        }

        private func IsNaturalStructuralDelegateTarget(
            source TypeSymbol,
            target TypeSymbol
        ) bool -> MemberLookup.IsNaturalStructuralDelegateTarget(source, target)

        /// Issue #2148: returns the (cref:TypeSymbol.ClrType) of the nearest
        /// imported base class in [`type`](paramref)'s inheritance chain, or
        /// `null` if none exists. A same-compilation user class has
        /// no `ClrType` of its own; when it derives (transitively) from an
        /// imported CLR base, that base's reflectible type carries the inherited
        /// members (e.g. `Dispose`/`DisposeAsync`) that duck-typed
        /// protocol probes need to see.
        private func GetNearestImportedBaseClrType(type TypeSymbol?) Type? {
            if type is StructSymbol structSymbol {
                for current in structSymbol.GetHierarchy() {
                    if current.ClrType != nil {
                        return current.ClrType
                    }
                    if current.ImportedBaseType?.ClrType != nil {
                        return current.ImportedBaseType!!.ClrType!!
                    }
                }
            }
            return nil
        }

        /// Issue #1017: resolves a user-defined conversion declared on a
        /// same-package struct/class as a static `op_Implicit` /
        /// `op_Explicit` method. Searches both the source and target type's
        /// static methods, preferring implicit conversions over explicit ones, just
        /// like C#. A candidate is applicable when standard implicit conversions
        /// reach its operand and leave its result; this admits numeric/reference
        /// adaptation and nullable result lifting without chaining user operators.
        /// Ambiguous candidate sets are rejected rather than depending on member
        /// declaration order. These symbols have no reflectible CLR type during
        /// binding, so the lookup is symbolic.
        /// @param sourceType The type of the value being converted.
        /// @param targetType The type being converted to.
        /// @param allowExplicit Whether `op_Explicit` is acceptable.
        /// @param method The resolved conversion method on success.
        /// @returns `true` if a conversion was found.
        private func TryResolveUserDefinedSymbolConversion(
            sourceType TypeSymbol?,
            targetType TypeSymbol?,
            allowExplicit bool,
            @NotNullWhen(true) out method FunctionSymbol?
        ) bool -> TryResolveUserDefinedSymbolConversion(sourceType, targetType, allowExplicit, out method, out _)

        private func TryResolveLiftedUserDefinedSymbolConversion(
            source NullableTypeSymbol,
            target TypeSymbol,
            allowExplicit bool,
            @NotNullWhen(true) out method FunctionSymbol?,
            @NotNullWhen(true) out methodOwner StructSymbol?
        ) bool {
            method = nil
            methodOwner = nil
            if TryResolveUserDefinedSymbolConversion(
                source,
                target,
                allowExplicit,
                out var ordinary,
                out var ordinaryOwner
            ) &&
                Conversion
                .ClassifyNonStructural(source, ordinaryOwner!!.SubstituteMemberType(ordinary!!.Parameters[0].Type)!!)
                .IsIdentity {
                return false
            }
            let targetUnderlying = if target is NullableTypeSymbol nullable {
                nullable.UnderlyingType
            } else {
                target
            }
            return NullableLifting.IsAnyValueTypeNullable(source) && BoundClrConversionCallExpression.CanLiftTo(
                target
            ) &&
                (allowExplicit || BoundClrConversionCallExpression.CanLiftImplicitlyTo(target)) &&
                !TypeSymbol.IsByRefLike(source) && !TypeSymbol.IsByRefLike(target) &&
                TryResolveUserDefinedSymbolConversion(
                source.UnderlyingType,
                targetUnderlying,
                allowExplicit,
                out method,
                out methodOwner
            ) &&
                methodOwner != nil &&
                methodOwner.ClrType == nil &&
                method!!
                .Parameters
                .Length == 1 &&
                method!!
                .Parameters[0]
                .RefKind == RefKind.None &&
                method!!.ReturnRefKind == RefKind.None &&
                Conversion
                .ClassifyNonStructural(
                source.UnderlyingType,
                methodOwner.SubstituteMemberType(method!!.Parameters[0].Type)!!
            )
                .IsIdentity &&
                TypeSymbol
                .AreRuntimeEquivalentIgnoringReferenceNullability(
                methodOwner.SubstituteMemberType(method!!.Type),
                targetUnderlying
            )
        }

        private func TryResolveUserDefinedSymbolConversion(
            sourceType TypeSymbol?,
            targetType TypeSymbol?,
            allowExplicit bool,
            @NotNullWhen(true) out method FunctionSymbol?,
            @NotNullWhen(true) out methodOwner StructSymbol?
        ) bool {
            method = nil
            methodOwner = nil
            if sourceType == nil ||
                targetType == nil ||
                sourceType == TypeSymbol.Error ||
                targetType == TypeSymbol.Error {
                return false
            }
            let foundImplicit = TryFindUserConversion(
                sourceType,
                targetType,
                "op_Implicit",
                out method,
                out methodOwner,
                out var ambiguousImplicit
            )
            if foundImplicit || ambiguousImplicit {
                return foundImplicit
            }
            if !allowExplicit {
                return false
            }
            return TryFindUserConversion(sourceType, targetType, "op_Explicit", out method, out methodOwner, out _)
        }

        private func TryFindUserConversion(
            source TypeSymbol,
            target TypeSymbol,
            opName string,
            @NotNullWhen(true) out method FunctionSymbol?,
            @NotNullWhen(true) out methodOwner StructSymbol?,
            out ambiguous bool
        ) bool {
            method = nil
            methodOwner = nil
            ambiguous = false
            let candidates = List[(Method FunctionSymbol, Owner StructSymbol, SourceRank int32, TargetRank int32)]()
            CollectUserConversions(GetUserConversionOwner(source), opName, source, target, candidates)
            CollectUserConversions(GetUserConversionOwner(target), opName, source, target, candidates)
            if candidates.Count == 0 {
                return false
            }
            let best = List[(Method FunctionSymbol, Owner StructSymbol)]()
            for var i = 0; i < candidates.Count; i++ {
                var dominated = false
                for var j = 0; j < candidates.Count; j++ {
                    if i == j {
                        continue
                    }
                    let other = candidates[j]
                    let candidate = candidates[i]
                    if other.SourceRank <= candidate.SourceRank &&
                        other.TargetRank <= candidate.TargetRank &&
                        (other.SourceRank < candidate.SourceRank || other.TargetRank < candidate.TargetRank) {
                        dominated = true
                        break
                    }
                }
                if !dominated {
                    best.Add((candidates[i].Method, candidates[i].Owner))
                }
            }
            if best.Count != 1 {
                ambiguous = best.Count > 1
                return false
            }
            method, methodOwner = best[0]
            return true
        }

        private func GetUserConversionOwner(type TypeSymbol) StructSymbol? {
            var type = type
            while type is NullableTypeSymbol nullable {
                type = nullable.UnderlyingType
            }
            return type as StructSymbol
        }

        private func CollectUserConversions(
            owner StructSymbol?,
            opName string,
            source TypeSymbol,
            target TypeSymbol,
            candidates List[(Method FunctionSymbol, Owner StructSymbol, SourceRank int32, TargetRank int32)]
        ) {
            if owner == nil || owner.StaticMethods.IsDefaultOrEmpty {
                return
            }
            for candidate in owner.StaticMethods {
                if !string.Equals(candidate.Name, opName, StringComparison.Ordinal) ||
                    candidate
                    .Parameters
                    .Length != 1 ||
                    candidates
                    .Any(
                    (
                        c(Method FunctionSymbol, Owner StructSymbol, SourceRank int32, TargetRank int32)
                    ) -> object.ReferenceEquals(c.Method, candidate) &&
                        TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(c.Owner, owner)
                ) {
                    continue
                }
                let parameterType = owner.SubstituteMemberType(candidate.Parameters[0].Type)
                let resultType = owner.SubstituteMemberType(candidate.Type)
                let sourceConversion = Conversion.ClassifyNonStructural(source, parameterType!!)
                let targetConversion = Conversion.ClassifyNonStructural(resultType!!, target)
                if !sourceConversion.Exists ||
                    !sourceConversion.IsImplicit ||
                    !targetConversion.Exists ||
                    !targetConversion.IsImplicit {
                    continue
                }
                candidates.Add(
                    (
                        candidate,
                        owner,
                        if sourceConversion.IsIdentity {
                            0
                        } else {
                            1
                        },
                        if targetConversion.IsIdentity {
                            0
                        } else {
                            1
                        }
                    )
                )
            }
        }

        private func HasDelegateParameterRefKindMismatch(targetType TypeSymbol, expression BoundExpression) bool {
            if !(targetType is DelegateTypeSymbol) &&
                (targetType?.ClrType is not Type targetClrType || !ClrTypeUtilities.IsDelegateType(targetClrType)) {
                return false
            }
            if !DelegateRefKindUtilities.TryGetSourceParameterRefKinds(expression, out var sourceRefKinds) {
                return false
            }
            let targetRefKinds = GetMethodGroupTargetRefKinds(targetType, sourceRefKinds.Length, out _)
            if targetRefKinds.Length != sourceRefKinds.Length {
                return false
            }
            for var i = 0; i < sourceRefKinds.Length; i++ {
                if (sourceRefKinds[i] != targetRefKinds[i]) {
                    return true
                }
            }
            return false
        }

        /// Issue #506 follow-up: returns `true` when the bound
        /// argument's static type needs an actual IL-visible conversion to land in
        /// the CLR parameter's slot (boxing, numeric coercion, func→delegate
        /// materialisation, etc.). Skips no-op rewraps where the source and
        /// destination share the same CLR type — for example
        /// `string?` → `string`, where the difference is purely the
        /// nullability wrapper and emit is identical. Those no-op rewraps would
        /// otherwise wrap a (cref:BoundVariableExpression) argument in a
        /// (cref:BoundConversionExpression), defeating nullable-flow
        /// narrowing patterns (e.g. `!String.IsNullOrEmpty(s)` can no longer
        /// strip `s`'s nullability).
        /// @param from The bound argument's static type.
        /// @param targetParameterType The CLR parameter type.
        /// @param substitutedTarget Optional substituted target type
        /// recovered from the receiver's symbolic type arguments
        /// (ADR-0087 §3 R5 / issue #765). When non-null and equal to
        /// [`from`](paramref), the conversion is treated as identity.
        /// @returns Whether a rebinding conversion is required.
        private func NeedsBindClrParameterConversion(
            from TypeSymbol?,
            targetParameterType Type?,
            substitutedTarget TypeSymbol? = nil
        ) bool {
            if from == nil || targetParameterType == nil {
                return false
            }
            if substitutedTarget != nil && from == substitutedTarget {
                return false
            }
            // FunctionTypeSymbol carries no ClrType but always needs delegate
            // materialisation when handed to a CLR delegate parameter.
            if from.ClrType == nil {
                return true
            }
            // Issue #2348 (see also #835): a raw reference-equality check here
            // spuriously requires a conversion whenever `from.ClrType` is a
            // well-known primitive singleton (`TypeSymbol.String`,
            // `TypeSymbol.Object`, … — always the host process's real
            // `typeof(T)`, see e.g. `TypeSymbol.String = new
            // TypeSymbol("string", typeof(string))`) while `targetParameterType`
            // was reflected through a `MetadataLoadContext`-backed
            // ReferenceResolver (the resolver gsc's real compile paths use, via
            // `ReferenceResolver.WithReferences`): the two `Type` instances
            // denote the identical logical type but are distinct objects, so
            // `!=` wrongly returns true. That spurious conversion wraps the
            // argument in a `BoundConversionExpression`, which in turn defeats
            // the `[NotNullWhen]`/`[MaybeNullWhen]` narrowing classifiers'
            // bare-`BoundVariableExpression` check — silently dropping flow
            // narrowing for every imported-CLR-method guard compiled outside a
            // real-reflection host (i.e. every real `gsc` build). Use the
            // existing cross-ReferenceResolver identity helper (already relied
            // on by `ClrOverloadResolution.ClassifyImplicit`) instead of a raw
            // reference comparison.
            return !ClrTypeUtilities.AreSame(from.ClrType, targetParameterType)
        }

        private func GetClrParameterTargetType(argumentType TypeSymbol, parameter ParameterInfo) TypeSymbol {
            if !parameter
                .ParameterType
                .IsValueType &&
                argumentType is NullableTypeSymbol nullable &&
                (
                NullableLifting.IsValueTypeNullable(nullable) || NullableLifting.IsUserValueTypeNullable(nullable) ||
                    nullable.UnderlyingType is TypeParameterSymbol
            ) {
                // The argument is value-optional (or a nullable type parameter)
                // and the parameter is a reference position: the target is the
                // bare reference type, so the value is boxed rather than lifted.
                // Read the position through the funnel and drop its top-level
                // reference nullability, rather than reading it erased.
                return ClrNullability.GetParameterTypeSymbol(parameter).StripToBareShape()
            }
            return ClrNullability.GetParameterTypeSymbol(parameter)
        }

        // Issue #1150: a func/arrow literal's natural numeric return type
        // implicitly, losslessly widens to a target delegate's numeric return type
        // per the standard widening lattice. Both types must be numeric CLR
        // primitives and the conversion classified implicit (i.e. directional
        // widening — narrowing and signed/unsigned same-width pairs are excluded).
        private func IsNumericReturnWideningCore(source TypeSymbol, target TypeSymbol) bool {
            let sourceClr string? = source?.ClrType?.FullName
            let targetClr string? = target?.ClrType?.FullName
            if sourceClr == nil || targetClr == nil || !NumericWideningLattice.IsNumericPrimitive(sourceClr) ||
                !NumericWideningLattice.IsNumericPrimitive(targetClr) {
                return false
            }
            let conversion = Conversion.Classify(
                Invariant.Required(source, "numeric return widening has a source type", expression: "source"),
                Invariant.Required(target, "numeric return widening has a target type", expression: "target")
            )
            return conversion.Exists && conversion.IsImplicit
        }

        // Issue #337: a method-group overload's return type is compatible with a
        // delegate's Invoke return type when both are void, or when the method's
        // (non-void) return is identity / implicitly reference- or value-convertible
        // (by name, MetadataLoadContext-safe) to the delegate's (non-void) return.
        private func IsMethodGroupReturnCompatible(methodReturn Type?, invokeReturn Type?) bool {
            let invokeVoid = invokeReturn == nil || string.Equals(
                invokeReturn.FullName,
                "System.Void",
                StringComparison.Ordinal
            )
            let methodVoid = methodReturn == nil || string.Equals(
                methodReturn.FullName,
                "System.Void",
                StringComparison.Ordinal
            )
            if invokeVoid || methodVoid {
                return invokeVoid && methodVoid
            }
            return ClrTypeUtilities.IsAssignableByName(invokeReturn, methodReturn)
        }

        /// Issue #3505: true when [`from`](paramref) and [`to`](paramref)
        /// share an arity and differ in at least one slot by a strict implicit
        /// REFERENCE conversion (contravariant parameters, covariant return) with
        /// every remaining slot runtime-equivalent. Such a group must re-resolve
        /// AT the target type — the generic conversion path would wrap it in a
        /// delegate-to-delegate variance conversion the emitter cannot express.
        /// Shapes that differ any other way stay on the generic path so its
        /// richer equivalence rules (and diagnostics) apply.
        private func HasReferenceVariantSlotMismatch(from FunctionTypeSymbol?, to FunctionTypeSymbol?) bool {
            if from == nil || to == nil || from.Arity != to.Arity {
                return false
            }
            var anyVariant = false
            for var i = 0; i < from.Arity; i++ {
                if TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                    from.ParameterTypes[i],
                    to.ParameterTypes[i]
                ) {
                    continue
                }
                if Conversion.IsImplicitReferenceVariantSlot(to.ParameterTypes[i], from.ParameterTypes[i]) {
                    anyVariant = true
                    continue
                }
                return false
            }
            if !TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(from.ReturnType, to.ReturnType) {
                if !Conversion.IsImplicitReferenceVariantSlot(from.ReturnType, to.ReturnType) {
                    return false
                }
                anyVariant = true
            }
            return anyVariant
        }

        private func TryCanonicalizeMethodGroupType(
            actual TypeSymbol,
            expected TypeSymbol,
            out canonical TypeSymbol,
            parameterPosition bool = false,
            allowVariance bool = true
        ) bool {
            canonical = actual
            if TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(actual, expected) {
                return true
            }
            if MemberLookup.TryCanonicalizeStructuralFunctionType(actual, expected, out canonical) &&
                actual.ClrType != nil &&
                expected.ClrType != nil &&
                ClrTypeUtilities.AreSame(actual.ClrType, expected.ClrType) {
                return true
            }
            // Issue #3505: a reference-variant slot canonicalizes to the TARGET's
            // slot type, so the resolved group is built AT the target function
            // type and the emitter creates the target-typed delegate directly
            // over the method (plain ldftn+newobj — valid IL for reference
            // variance; a delegate-to-delegate variance conversion is not).
            // Parameters are contravariant (target flows into the candidate),
            // returns covariant (candidate flows into the target); value-typed
            // slots stay exact — CLR delegate variance is reference-only.
            let (variantFrom, variantTo) = if parameterPosition {
                (expected, actual)
            } else {
                (actual, expected)
            }
            if allowVariance && Conversion.IsImplicitReferenceVariantSlot(variantFrom, variantTo) {
                canonical = expected
                return true
            }
            canonical = actual
            return false
        }

        private func HasByRefDelegateReturn(targetType TypeSymbol) bool {
            GetMethodGroupTargetRefKinds(targetType, 0, out var returnRefKind)
            return returnRefKind != RefKind.None
        }

        private func GetMethodGroupTargetRefKinds(
            targetType TypeSymbol,
            parameterCount int32,
            out returnRefKind RefKind
        ) ImmutableArray[RefKind] {
            returnRefKind = RefKind.None
            if targetType is DelegateTypeSymbol userDelegate {
                return userDelegate
                    .Parameters
                    .Select((parameter ParameterSymbol) -> parameter.RefKind)
                    .ToImmutableArray()
            }
            // Issue #3752: the sibling of the probe in
            // `BindClrMethodGroupConversion`, sharing its omission — a direct
            // `Invoke` reflection that answers null for every cross-reflection-
            // context closure, here silently degrading a by-ref target signature
            // to all-by-value rather than failing loudly. Both now read the ref
            // kinds through the same load-context-tolerant helper.
            if targetType?.ClrType == nil || !ClrTypeUtilities.IsDelegateType(targetType.ClrType) {
                return ImmutableArray.CreateRange(Enumerable.Repeat(RefKind.None, parameterCount))
            }
            return DelegateRefKindUtilities.GetDelegateParameterRefKinds(
                targetType.ClrType,
                parameterCount,
                out returnRefKind
            )
        }

        // ADR-0062: an inner ref-kind modifier on a conditional ref-argument branch
        // must agree with the outer modifier text (`ref`, `out`, `in`, or `&`).
        // The bare `&` form is compatible only with `ref` / `&` semantics.
        private func InnerModifierMatchesOuter(inner string, outer string) bool {
            if string.Equals(inner, outer, StringComparison.Ordinal) {
                return true
            }
            if string.Equals(outer, "&", StringComparison.Ordinal) {
                return string.Equals(inner, "ref", StringComparison.Ordinal)
            }
            if string.Equals(inner, "&", StringComparison.Ordinal) {
                return string.Equals(outer, "ref", StringComparison.Ordinal)
            }
            return false
        }

        // Issue #327/#321/#2451: extracts the CLR `RawDefaultValue` for an optional
        // parameter when it is a literal kind that BoundLiteralExpression carries.
        private func TryGetConstantParameterDefault(
            parameter ParameterInfo,
            @NotNullWhen(true) out value object?
        ) bool {
            value = nil
            var raw object?
            try {
                raw = parameter.RawDefaultValue
            } catch {
                return false
            }
            if raw == nil || raw is DBNull {
                return false
            }
            // Only primitive/string constants flow through BoundLiteralExpression's
            // known value kinds; the constant's CLR type is also the IL form for an
            // enum parameter (whose default is encoded as its underlying integral).
            switch raw {
                case _ is bool {
                    value = raw
                    return true
                }
                case _ is int8 {
                    value = raw
                    return true
                }
                case _ is uint8 {
                    value = raw
                    return true
                }
                case _ is int16 {
                    value = raw
                    return true
                }
                case _ is uint16 {
                    value = raw
                    return true
                }
                case _ is int32 {
                    value = raw
                    return true
                }
                case _ is uint32 {
                    value = raw
                    return true
                }
                case _ is int64 {
                    value = raw
                    return true
                }
                case _ is uint64 {
                    value = raw
                    return true
                }
                case _ is float32 {
                    value = raw
                    return true
                }
                case _ is float64 {
                    value = raw
                    return true
                }
                case _ is decimal {
                    value = raw
                    return true
                }
                case _ is char {
                    value = raw
                    return true
                }
                case _ is string {
                    value = raw
                    return true
                }
                default {
                    return false
                }
            }
        }

        private func TryGetDateTimeParameterDefault(parameter ParameterInfo, out value DateTime) bool {
            try {
                if parameter.ParameterType.FullName == "System.DateTime" {
                    if parameter.RawDefaultValue is int64 ticks {
                        value = DateTime(ticks)
                        return true
                    }
                }
                var attribute CustomAttributeData? = nil
                for candidate in parameter.GetCustomAttributesData() {
                    if candidate.AttributeType.FullName == "System.Runtime.CompilerServices.DateTimeConstantAttribute" {
                        attribute = candidate
                        break
                    }
                }
                if attribute != nil && attribute.ConstructorArguments.Count == 1 {
                    let attributeTicks = Convert.ToInt64(
                        attribute.ConstructorArguments[0].Value,
                        CultureInfo.InvariantCulture
                    )
                    value = DateTime(attributeTicks)
                    return true
                }
            } catch { }
            value = default(DateTime)
            return false
        }

        private func IsMissingParameterDefault(parameter ParameterInfo) bool {
            try {
                let raw = parameter.RawDefaultValue
                return raw is Missing || raw?.GetType()
                    .FullName == "System.Reflection.Missing" ||
                    (
                    parameter
                        .ParameterType
                        .FullName == "System.Object" &&
                        parameter.IsOptional &&
                        (raw is DBNull || !parameter.HasDefaultValue)
                )
            } catch {
                return false
            }
        }

        // ADR-0063: extracts a CLR-Constant-table representable default value from a
        // bound expression, applying limited implicit conversion to the parameter type
        // (numeric widening / nil → reference|nullable). Returns false with a
        // human-visible reason otherwise.
        private func TryExtractConstantDefault(
            bound BoundExpression,
            parameterType TypeSymbol,
            out value object?,
            @NotNullWhen(false) out reason string?
        ) bool {
            value = nil
            reason = nil
            // Unwrap a conversion that the binder may have inserted around a literal.
            var inner = bound
            while inner is BoundConversionExpression bce {
                inner = bce.Expression
            }
            if ExpressionBinder.IsIntegerType(inner.Type) && ExpressionBinder.TryGetConstantIntegerValue(
                inner,
                out var integerValue
            ) &&
                TryGetIntegralMetadataTarget(parameterType, out var integralTarget) {
                if integralTarget == TypeSymbol.Char &&
                    integerValue >= int64(char.MinValue) &&
                    integerValue <= int64(char.MaxValue) {
                    value = char(uint16(integerValue))
                    return true
                }
                if ExpressionBinder.TryAdaptIntegerLiteral(integerValue, integralTarget, out value) {
                    return true
                }
                reason = "integer constant '$integerValue' is outside the range of parameter type '${parameterType.Name}'."
                value = nil
                return false
            } else if inner is BoundLiteralExpression lit {
                value = lit.Value
            } else if inner is BoundDefaultExpression def {
                // Issue #1182: a value-type `default(T)` (and the zero-value `T()`
                // form, which the binder also lowers to a BoundDefaultExpression for
                // value types with no surfaced parameterless constructor) is a valid
                // compile-time constant — the type's all-zero value. Accept it and
                // record a constant the call site can materialize, mirroring C#.
                return TryExtractValueTypeDefaultConstant(def, parameterType, out value, out reason)
            } else {
                reason = "the default value must be a compile-time constant (numeric, bool, char, string, enum, nil, or a value-type default(T))."
                return false
            }
            // `nil` is only valid for a reference-compatible or nullable parameter type.
            if value == nil {
                if parameterType is NullableTypeSymbol || (parameterType.ClrType is Type ct && !ct.IsValueType) {
                    return true
                }
                reason = "'nil' is not a valid default for value-type parameter of type '${parameterType.Name}'."
                value = nil
                return false
            }
            if !Conversion.Classify(inner.Type, parameterType).IsImplicit {
                reason = "the default value of type '${inner.Type.Name}' is not implicitly convertible to parameter type '${parameterType.Name}'."
                value = nil
                return false
            }
            return TryNormalizeMetadataConstant(value!!, parameterType, out value, out reason)
        }

        private func TryGetIntegralMetadataTarget(parameterType TypeSymbol, out target TypeSymbol) bool {
            target = if parameterType is NullableTypeSymbol nullable {
                nullable.UnderlyingType
            } else {
                parameterType
            }
            if target is EnumSymbol enumType {
                target = enumType.UnderlyingType
            } else if target.ClrType is Type{IsEnum: true} clrEnum {
                target = TypeSymbol.FromClrTypeWithoutNullability(
                    Enum.GetUnderlyingType(clrEnum),
                    NullabilityFreeReason.TypeStructure
                )
            }
            return target == TypeSymbol.Char || ExpressionBinder.IsIntegerType(target)
        }

        // Constant rows carry the parameter's converted primitive value, not the
        // source literal's type (for example, `int64 x = 1` requires an I8 row).
        private func TryNormalizeMetadataConstant(
            value object,
            parameterType TypeSymbol,
            @NotNullWhen(true) out normalized object?,
            @NotNullWhen(false) out reason string?
        ) bool {
            normalized = nil
            reason = nil
            let target = if parameterType is NullableTypeSymbol nullable {
                nullable.UnderlyingType
            } else {
                parameterType
            }
            try {
                if target.ClrType is Type clrType && TryNormalizeClrConstant(value, clrType, out normalized) {
                    return true
                } else if target is EnumSymbol {
                    normalized = Convert.ToInt32(value, CultureInfo.InvariantCulture)
                } else if (target == TypeSymbol.NInt || target == TypeSymbol.NUInt) &&
                    (
                    value is int8 ||
                        value is uint8 ||
                        value is int16 ||
                        value is uint16 ||
                        value is int32 ||
                        value is uint32 ||
                        value is int64 ||
                        value is uint64
                ) {
                    normalized = value
                }
            } catch (Exception) {
                normalized = nil
            }
            if normalized != nil {
                return true
            }
            reason = "the default value type '${value.GetType().Name}' is not representable for parameter type '${parameterType.Name}' in CLR metadata."
            return false
        }

        private func TryNormalizeClrConstant(
            value object,
            targetType Type,
            @NotNullWhen(true) out normalized object?
        ) bool {
            var targetType = targetType
            normalized = nil
            if targetType.IsEnum {
                targetType = Enum.GetUnderlyingType(targetType)
            }
            normalized = switch Type.GetTypeCode(targetType) {
                case TypeCode.Boolean when value is bool: value
                case TypeCode.Char when value is char: value
                case TypeCode.SByte: Convert.ToSByte(value, CultureInfo.InvariantCulture)
                case TypeCode.Byte: Convert.ToByte(value, CultureInfo.InvariantCulture)
                case TypeCode.Int16: Convert.ToInt16(value, CultureInfo.InvariantCulture)
                case TypeCode.UInt16: Convert.ToUInt16(value, CultureInfo.InvariantCulture)
                case TypeCode.Int32: Convert.ToInt32(value, CultureInfo.InvariantCulture)
                case TypeCode.UInt32: Convert.ToUInt32(value, CultureInfo.InvariantCulture)
                case TypeCode.Int64: Convert.ToInt64(value, CultureInfo.InvariantCulture)
                case TypeCode.UInt64: Convert.ToUInt64(value, CultureInfo.InvariantCulture)
                case TypeCode.Single: Convert.ToSingle(value, CultureInfo.InvariantCulture)
                case TypeCode.Double: Convert.ToDouble(value, CultureInfo.InvariantCulture)
                case TypeCode.String when value is string: value
                default: default(object?)
            }
            return normalized != nil
        }

        // Issue #1182: extracts the constant default for a value-type `default(T)` /
        // zero-value `T()` optional default. The written `default(T)` must denote the
        // parameter's own type. Primitive value types (numeric / bool / char) are
        // recorded as their typed zero — identical to `= 0` — so a CLR Constant row is
        // emitted; arbitrary value types (e.g. TimeSpan, user structs) and Nullable<T>
        // record <see langword="null"/>, which the call site materializes as the
        // all-zero value via a BoundDefaultExpression and the metadata encodes as a
        // nullref Constant (matching C# `T x = default`).
        private func TryExtractValueTypeDefaultConstant(
            def BoundDefaultExpression,
            parameterType TypeSymbol,
            out value object?,
            @NotNullWhen(false) out reason string?
        ) bool {
            value = nil
            reason = nil
            let paramUnderlying = if parameterType is NullableTypeSymbol pn {
                pn.UnderlyingType
            } else {
                parameterType
            }
            let defUnderlying = if def.Type is NullableTypeSymbol dn {
                dn.UnderlyingType
            } else {
                def.Type
            }
            // The written `default(T)` / `T()` must denote the parameter's own type;
            // no implicit conversion of a value-type default is supported.
            if !DefaultTypeMatchesParameter(defUnderlying, paramUnderlying) {
                reason = "the default value 'default(${def.Type?.Name})' does not match the parameter type '${parameterType.Name}'."
                return false
            }
            // Nullable<T> or reference-type parameter: the default is the missing value
            // (nil), already representable as a nullref Constant and materialized as nil.
            if parameterType is NullableTypeSymbol || !IsValueTypeForDefault(paramUnderlying) {
                value = nil
                return true
            }
            // Primitive value types are CLR Constant-table representable as their typed
            // zero — emit the same constant as the `= 0` form.
            if TryGetPrimitiveZero(paramUnderlying, out var primitiveZero) {
                value = primitiveZero
                return true
            }
            // Arbitrary value type (TimeSpan, user struct, enum, tuple): materialized at
            // the call site via BoundDefaultExpression; metadata Constant is nullref.
            value = nil
            return true
        }

        // Issue #1182: the written `default(T)` / `T()` must denote the same type as the
        // parameter. Symbol identity covers the common case (including user value types
        // whose <see cref="TypeSymbol.ClrType"/> is null pre-emit); the CLR full-name and
        // name fallbacks cover imported types and re-resolved symbol instances.
        private func DefaultTypeMatchesParameter(defType TypeSymbol?, paramType TypeSymbol?) bool {
            if defType == nil || paramType == nil {
                return false
            }
            if object.ReferenceEquals(defType, paramType) || object.Equals(defType, paramType) {
                return true
            }
            let defClr Type? = defType.ClrType
            let paramClr Type? = paramType.ClrType
            if defClr != nil && paramClr != nil {
                return string.Equals(defClr.FullName, paramClr.FullName, StringComparison.Ordinal)
            }
            return string.Equals(defType.Name, paramType.Name, StringComparison.Ordinal)
        }

        // Issue #1182: recognises value-type parameter symbols whose all-zero default is a
        // valid optional default — including user `data struct` / enum / tuple symbols that
        // carry no CLR backing type before emit.
        private func IsValueTypeForDefault(type TypeSymbol) bool {
            if type is StructSymbol s && !s.IsClass {
                return true
            }
            if type is EnumSymbol || type is TupleTypeSymbol {
                return true
            }
            return type?.ClrType is {IsValueType: true}
        }

        // Issue #1182: returns the typed CLR zero for a primitive value-type symbol so a
        // `default(T)` optional default emits the same CLR Constant row as `= 0`.
        private func TryGetPrimitiveZero(type TypeSymbol, @NotNullWhen(true) out zero object?) bool {
            zero = nil
            if type == TypeSymbol.Bool {
                zero = false
            } else if type == TypeSymbol.Int8 {
                zero = int8(0)
            } else if type == TypeSymbol.UInt8 {
                zero = uint8(0)
            } else if type == TypeSymbol.Int16 {
                zero = int16(0)
            } else if type == TypeSymbol.UInt16 {
                zero = uint16(0)
            } else if type == TypeSymbol.Int32 {
                zero = 0
            } else if type == TypeSymbol.UInt32 {
                zero = 0u
            } else if type == TypeSymbol.Int64 {
                zero = 0L
            } else if type == TypeSymbol.UInt64 {
                zero = 0UL
            } else if type == TypeSymbol.Float32 {
                zero = 0f
            } else if type == TypeSymbol.Float64 {
                zero = 0d
            } else if type == TypeSymbol.Char {
                zero = '\u0000'
            }
            return zero != nil
        }

        private func TryGetStructuralProjectionFieldInitializer(
            type StructSymbol,
            field FieldSymbol,
            @NotNullWhen(true) out initializer BoundExpression?
        ) bool {
            if type.InstanceFieldInitializers.TryGetValue(field, out initializer) {
                return true
            }
            if type.Definition != nil {
                for candidate in type.Definition!!.InstanceFieldInitializers {
                    if string.Equals(candidate.Key.Name, field.Name, StringComparison.Ordinal) {
                        initializer = candidate.Value
                        return true
                    }
                }
            }
            initializer = nil
            return false
        }

        private func NeedsSymbolicConversion(type TypeSymbol) bool {
            if type is not ImportedTypeSymbol{OpenDefinition: not nil} imported ||
                imported
                .TypeArguments
                .IsDefaultOrEmpty {
                return false
            }
            for typeArgument in imported.TypeArguments {
                if TypeSymbol.ContainsTypeParameter(typeArgument) || TypeSymbol.RequiresSymbolicProjection(
                    typeArgument
                ) {
                    return true
                }
            }
            return false
        }

        private func TryFindSymbolicImplicitOperator(
            openDefinition Type,
            ownerTypeArguments ImmutableArray[TypeSymbol],
            source TypeSymbol,
            target TypeSymbol,
            @NotNullWhen(true) out conversion MethodInfo?
        ) bool {
            conversion = nil
            var candidates[]MethodInfo
            try {
                candidates = openDefinition.GetMethods(BindingFlags.Public | BindingFlags.Static)
            } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                return false
            }
            for candidate in candidates {
                if !string.Equals(candidate.Name, "op_Implicit", StringComparison.Ordinal) {
                    continue
                }
                let parameters = candidate.GetParameters()
                if parameters.Length != 1 {
                    continue
                }
                // Matched by shape: the BCL declares `op_Implicit(T[]? array)`,
                // and the operator applies to a non-null source just the same,
                // so each side's own top-level `?`/`!` is dropped before the
                // exact comparison below.
                let mappedParameter = MemberLookup.GetClrOpenParameterPointeeTypeSymbol(
                    parameters[0],
                    openDefinition,
                    ownerTypeArguments
                )
                    .StripToBareShape()
                let mappedReturn = MemberLookup.GetClrOpenMethodReturnTypeSymbol(
                    candidate,
                    openDefinition,
                    ownerTypeArguments
                )
                    .StripToBareShape()
                // Both sides must match exactly. A mapped projection is a fresh
                // ImportedTypeSymbol that never reference-equals the declared
                // `Memory[T]`/`ReadOnlySpan[T]` even when it is structurally the
                // same type, so constructed generics compare by open definition
                // and type arguments.
                if !IsSameSymbolicType(mappedParameter, source) || !IsSameSymbolicType(mappedReturn, target) {
                    continue
                }
                conversion = candidate
                return true
            }
            return false
        }

        private func IsSameSymbolicType(mapped TypeSymbol?, expected TypeSymbol) bool {
            if mapped == nil || mapped == TypeSymbol.Error {
                return false
            }
            if mapped.Equals(expected) {
                return true
            }
            if !(mapped is ImportedTypeSymbol{OpenDefinition: {} mappedOpen} mappedImported) ||
                !(expected is ImportedTypeSymbol{OpenDefinition: {} expectedOpen} expectedImported) ||
                mappedOpen != expectedOpen ||
                mappedImported
                .TypeArguments
                .Length != expectedImported
                .TypeArguments
                .Length {
                return false
            }
            for var i = 0; i < mappedImported.TypeArguments.Length; i++ {
                if !IsSameSymbolicType(mappedImported.TypeArguments[i], expectedImported.TypeArguments[i]) {
                    return false
                }
            }
            return true
        }
    }
}
