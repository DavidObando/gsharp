// <copyright file="OverloadResolver.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding.OverloadResolution

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Documentation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import System.Diagnostics.CodeAnalysis

/// PR-B-4: the binder-side facade for call-site overload resolution. Owns
/// the (cref:BindCallExpression), (cref:BindConstructorCallExpression),
/// (cref:BindExtensionFunctionCall), and (cref:BindUserInstanceCall)
/// entry points, plus the supporting machinery — named-argument
/// reordering, default-value fill, `params T[]` lowering, generic
/// type-argument inference, candidate selection (delegating to the pure
/// reflection-level resolver in (cref:ClrOverloadResolution)), and
/// the diagnostic emission used at all four call-site shapes.
/// @remarks This type is the binder-side wrapper: it consumes
/// (cref:BinderContext) for the diagnostics bag and Scope chain,
/// (cref:MemberLookup) for candidate enumeration, and
/// (cref:ConversionClassifier) for per-argument conversion. It
/// never back-references (cref:Binder); the callbacks it needs
/// (re-binding a sub-expression, the type-clause and ref-argument
/// binders, the CLR-call probing helpers, the type-argument inference
/// and constraint checking helpers, the function-literal adapter
/// creation, etc.) are injected through narrow delegate seams in the
/// constructor — the same pattern (cref:ConversionClassifier)
/// established in PR-B-3.
///
/// The pure value-shaped (cref:ClrOverloadResolution) static class
/// in `ClrOverloadResolution.cs` is unchanged and continues to expose
/// the reflection-level `Resolve<T>` /
/// `TryInferTypeArguments` entry points. This class merely wraps
/// that pure resolver with the diagnostic emission, syntax-aware
/// reordering, and bound-tree construction previously embedded in
/// (cref:Binder).
///
/// The lifted-overload-resolution work for the nullable cluster
/// (issues #571 / #574) and other Wave-3 architectural fixes from
/// `~/gsharp-bug-overview.md` §6.1 will land in this class in a
/// follow-up PR after the full Binder decomposition is complete. This
/// PR only sets up the structural home for those fixes; it makes no
/// behaviour change.
internal partial class OverloadResolver {
    private func TryReportByRefLikeTypeArgument(
        typeParameters ImmutableArray[TypeParameterSymbol],
        substitution Dictionary[TypeParameterSymbol, TypeSymbol],
        location TextLocation
    ) bool {
        for typeParameter in typeParameters {
            let typeArgument = substitution[typeParameter]
            if !TypeSymbol.IsByRefLike(typeArgument) {
                continue
            }
            Diagnostics.ReportByRefLikeEscape(location, typeArgument, "be used as a generic type argument")
            return true
        }
        return false
    }

    private let binderCtx BinderContext
    private let memberLookup MemberLookup
    private let conversions ConversionClassifier
    private let bindExpression(ExpressionSyntax) -> BoundExpression
    private let bindExpressionWithTargetType(ExpressionSyntax, TypeSymbol) -> BoundExpression
    private let bindRefArgumentExpression(RefArgumentExpressionSyntax, ParameterSymbol?) -> BoundExpression
    private let tryRebindInlineOutVarPlaceholder(
        BoundExpression,
        ExpressionSyntax,
        ParameterSymbol,
        TypeSymbol
    ) -> BoundExpression?
    private let bindTypeClause(TypeClauseSyntax) -> TypeSymbol?
    private let lookupType(string) -> TypeSymbol?

    // Issue #1263: arity-aware type lookup. When a construction carries an
    // explicit type-argument list (`Op[int32](5)`), the constructed type name
    // must be resolved by (name, arity) so a non-generic `Op` and a generic
    // `Op[T]` can coexist — mirroring the #1051 disambiguation already used by
    // the type-reference and struct-literal paths. A negative arity means "no
    // preference" and falls back to the arity-0 type.
    private let lookupTypeWithArity(string, int32) -> TypeSymbol?

    private let reportObsoleteUseIfApplicable(TextLocation, Symbol, string) -> void
    private let tryBindClrConstructorCall OverloadResolver_TryBindClrConstructorCallDelegate
    private let tryBindIntrinsicCall OverloadResolver_TryBindIntrinsicCallDelegate
    private let tryBindInheritedClrInstanceCall OverloadResolver_TryBindInheritedClrInstanceCallDelegate
    private let isFormattableStringTargetType(TypeSymbol) -> bool
    private let bindInterpolatedStringAsFormattable(InterpolatedStringExpressionSyntax, TypeSymbol) -> BoundExpression
    private let getRefKindFromModifier(SyntaxToken) -> RefKind
    private let refKindToString(RefKind) -> string
    private let createErasedFunctionLiteralAdapter(
        BoundFunctionLiteralExpression,
        FunctionTypeSymbol
    ) -> BoundFunctionLiteralExpression
    private let wrapAsTask(TypeSymbol, bool) -> TypeSymbol
    private let isAsyncIteratorReturnType(TypeSymbol) -> bool
    private let completeSuspendingCall(BoundExpression, TypeSymbol, TextLocation, string) -> BoundExpression
    private let tryGetFunctionLiteral OverloadResolver_TryGetFunctionLiteralDelegate
    private let inferTypeArguments(TypeSymbol, TypeSymbol, Dictionary[TypeParameterSymbol, TypeSymbol]) -> void
    private let substituteType(TypeSymbol, Dictionary[TypeParameterSymbol, TypeSymbol]) -> TypeSymbol
    private let satisfiesConstraint(
        TypeSymbol,
        TypeParameterSymbol,
        IReadOnlyDictionary[TypeParameterSymbol, TypeSymbol]?
    ) -> bool
    private let describeConstraint(TypeParameterSymbol) -> string
    private let getCurrentFunction() -> FunctionSymbol?
    private let bindLambdaWithTarget((LambdaExpressionSyntax, FunctionTypeSymbol) -> BoundExpression)?
    private let bindUserTypeStaticCall((StructSymbol, CallExpressionSyntax) -> BoundExpression)?
    private let bindImportedClrStaticCall((Type, CallExpressionSyntax) -> BoundExpression)?

    /// Initializes a new instance of the (cref:OverloadResolver)
    /// class.
    /// @param binderCtx The shared binder context that exposes the
    /// diagnostics bag, the (mutable) root/current Scope, and the
    /// reference resolver.
    /// @param memberLookup The binder-side member-lookup facade
    /// used for delegate-shape probes and CLR-parameter-name collection.
    /// @param conversions The binder-side conversion classifier
    /// used to convert each argument once a candidate has been
    /// chosen.
    /// @param bindExpression Callback to re-bind a sub-expression
    /// through the still-on-Binder expression-binding entry point.
    /// @param bindExpressionWithTargetType Issue #1238: callback that
    /// (re)binds an expression with an explicit target type, used to finalize a
    /// deferred target-typed conditional/if/switch argument against its resolved
    /// parameter type.
    /// @param bindRefArgumentExpression Callback to bind a
    /// (cref:RefArgumentExpressionSyntax) against a known parameter
    /// symbol (or `null` in the first, parameter-unknown, pass).
    /// @param tryRebindInlineOutVarPlaceholder Callback that re-binds a
    /// first-pass inline out-var placeholder once the callee/parameter is
    /// resolved, returning the rebound expression (or `null` when the
    /// argument is not an inline out-var placeholder).
    /// @param bindTypeClause Callback to bind a
    /// (cref:TypeClauseSyntax) to a (cref:TypeSymbol).
    /// @param lookupType Callback to resolve a bare type name to a
    /// (cref:TypeSymbol) in the current binding context.
    /// @param lookupTypeWithArity Callback to resolve a type name by
    /// (name, generic arity), used at construction sites so a non-generic and a
    /// same-named generic type can be disambiguated by the supplied
    /// type-argument count (issue #1263).
    /// @param reportObsoleteUseIfApplicable Callback that emits
    /// `GS0276` when a symbol is `[Obsolete]`.
    /// @param tryBindClrConstructorCall Callback that attempts to
    /// bind a `TypeName(args)` / `TypeName[T1,T2](args)`
    /// invocation against an imported CLR class.
    /// @param tryBindIntrinsicCall Callback that attempts to bind a
    /// well-known intrinsic-named call (`len`, `cap`,
    /// `append`, `print`, …).
    /// @param tryBindInheritedClrInstanceCall Callback that
    /// attempts to bind an instance call against an imported CLR base
    /// class — used to lower `delegateVar(args)` through
    /// `Invoke`.
    /// @param isFormattableStringTargetType Callback to test
    /// whether a target type is one of the ADR-0055 Tier 4
    /// formattable-string shapes.
    /// @param bindInterpolatedStringAsFormattable Callback that
    /// performs the ADR-0055 Tier 4 contextual conversion of an
    /// interpolated string to `IFormattable`/`FormattableString`.
    /// @param getRefKindFromModifier Callback that maps a
    /// `ref`/`out`/`in` modifier token to a
    /// (cref:RefKind).
    /// @param refKindToString Callback used only for the
    /// human-readable diagnostic message when a ref-kind mismatch is
    /// reported.
    /// @param createErasedFunctionLiteralAdapter Callback that
    /// wraps a function-literal expression in an erased-signature adapter
    /// for the target generic function type.
    /// @param wrapAsTask Callback that wraps a return type in
    /// `System.Threading.Tasks.Task` / `Task<T>` for
    /// async kickoff-method call sites.
    /// @param isAsyncIteratorReturnType Callback that tests
    /// <param name="completeSuspendingCall">ADR-0174 D4: finishes a call to a suspending function —
    /// implicit await in a suspending/async caller, a blocking root bridge (GS0558) elsewhere.</param>
    /// whether a return type is an async-iterator shape so async-wrap is
    /// suppressed.
    /// @param tryGetFunctionLiteral Callback that unwraps a bound
    /// argument to a (cref:BoundFunctionLiteralExpression) if it
    /// is one (possibly through a (cref:BoundConversionExpression)).
    /// @param inferTypeArguments Callback that performs a single
    /// step of left-to-right type-argument inference, mutating the
    /// supplied substitution map.
    /// @param substituteType Callback that substitutes a single
    /// type expression under the supplied substitution map.
    /// @param satisfiesConstraint Callback that checks whether a
    /// resolved type argument satisfies the declared constraint of a
    /// type parameter. Issue #4043: the third argument is the WHOLE
    /// type-argument vector, which a DEPENDENT bound
    /// (`[TBase, TDerived TBase]`) needs and a per-position check cannot
    /// supply; every other constraint kind ignores it, and `null`
    /// (no vector available) keeps the pre-#4043 answer.
    /// @param describeConstraint Callback that produces a
    /// human-readable description of a type-parameter constraint for
    /// diagnostics.
    /// @param getCurrentFunction Callback that returns the
    /// enclosing (cref:FunctionSymbol) being bound (or
    /// `null` at top-level), used by the implicit-`this`
    /// dispatch path in (cref:BindCallExpression).
    /// @param bindLambdaWithTarget Issue #951: callback that binds an
    /// arrow-lambda syntax against a target (cref:FunctionTypeSymbol),
    /// used to target-type a deferred un-typed arrow-lambda argument from the
    /// resolved parameter's delegate shape. May be `null`.
    /// @param bindUserTypeStaticCall Issue #1147: callback that finalizes
    /// a `Type.Method(args)` static (`shared`) user call against a
    /// resolved struct/class, used by the unqualified implicit-`this` path
    /// when unified instance+static overload resolution selects a static sibling.
    /// May be `null`.
    /// @param bindImportedClrStaticCall ADR-0134 (extended): callback that
    /// finalizes an unqualified call as a qualified static call against a
    /// referenced-assembly CLR type brought into scope by a type import
    /// (C# `using static System.Math`). May be `null`.
    init(
        binderCtx BinderContext,
        memberLookup MemberLookup,
        conversions ConversionClassifier,
        bindExpression(ExpressionSyntax) -> BoundExpression,
        bindExpressionWithTargetType(ExpressionSyntax, TypeSymbol) -> BoundExpression,
        bindRefArgumentExpression(RefArgumentExpressionSyntax, ParameterSymbol?) -> BoundExpression,
        tryRebindInlineOutVarPlaceholder(
            BoundExpression,
            ExpressionSyntax,
            ParameterSymbol,
            TypeSymbol
        ) -> BoundExpression?,
        bindTypeClause(TypeClauseSyntax) -> TypeSymbol?,
        lookupType(string) -> TypeSymbol?,
        lookupTypeWithArity(string, int32) -> TypeSymbol?,
        reportObsoleteUseIfApplicable(TextLocation, Symbol, string) -> void,
        tryBindClrConstructorCall OverloadResolver_TryBindClrConstructorCallDelegate,
        tryBindIntrinsicCall OverloadResolver_TryBindIntrinsicCallDelegate,
        tryBindInheritedClrInstanceCall OverloadResolver_TryBindInheritedClrInstanceCallDelegate,
        isFormattableStringTargetType(TypeSymbol) -> bool,
        bindInterpolatedStringAsFormattable(InterpolatedStringExpressionSyntax, TypeSymbol) -> BoundExpression,
        getRefKindFromModifier(SyntaxToken) -> RefKind,
        refKindToString(RefKind) -> string,
        createErasedFunctionLiteralAdapter(
            BoundFunctionLiteralExpression,
            FunctionTypeSymbol
        ) -> BoundFunctionLiteralExpression,
        wrapAsTask(TypeSymbol, bool) -> TypeSymbol,
        isAsyncIteratorReturnType(TypeSymbol) -> bool,
        completeSuspendingCall(BoundExpression, TypeSymbol, TextLocation, string) -> BoundExpression,
        tryGetFunctionLiteral OverloadResolver_TryGetFunctionLiteralDelegate,
        inferTypeArguments(TypeSymbol, TypeSymbol, Dictionary[TypeParameterSymbol, TypeSymbol]) -> void,
        substituteType(TypeSymbol, Dictionary[TypeParameterSymbol, TypeSymbol]) -> TypeSymbol,
        satisfiesConstraint(
            TypeSymbol,
            TypeParameterSymbol,
            IReadOnlyDictionary[TypeParameterSymbol, TypeSymbol]?
        ) -> bool,
        describeConstraint(TypeParameterSymbol) -> string,
        getCurrentFunction() -> FunctionSymbol?,
        bindLambdaWithTarget((LambdaExpressionSyntax, FunctionTypeSymbol) -> BoundExpression)? = nil,
        bindUserTypeStaticCall((StructSymbol, CallExpressionSyntax) -> BoundExpression)? = nil,
        bindImportedClrStaticCall((Type, CallExpressionSyntax) -> BoundExpression)? = nil
    ) {
        this.binderCtx = binderCtx ?? throw ArgumentNullException("binderCtx")
        this.memberLookup = memberLookup ?? throw ArgumentNullException("memberLookup")
        this.conversions = conversions ?? throw ArgumentNullException("conversions")
        this.bindExpression = bindExpression ?? throw ArgumentNullException("bindExpression")
        this.bindExpressionWithTargetType = bindExpressionWithTargetType ??
            throw ArgumentNullException("bindExpressionWithTargetType")
        this.bindRefArgumentExpression = bindRefArgumentExpression ??
            throw ArgumentNullException("bindRefArgumentExpression")
        this.tryRebindInlineOutVarPlaceholder = tryRebindInlineOutVarPlaceholder ??
            throw ArgumentNullException("tryRebindInlineOutVarPlaceholder")
        this.bindTypeClause = bindTypeClause ?? throw ArgumentNullException("bindTypeClause")
        this.lookupType = lookupType ?? throw ArgumentNullException("lookupType")
        this.lookupTypeWithArity = lookupTypeWithArity ?? throw ArgumentNullException("lookupTypeWithArity")
        this.reportObsoleteUseIfApplicable = reportObsoleteUseIfApplicable ??
            throw ArgumentNullException("reportObsoleteUseIfApplicable")
        this.tryBindClrConstructorCall = tryBindClrConstructorCall ??
            throw ArgumentNullException("tryBindClrConstructorCall")
        this.tryBindIntrinsicCall = tryBindIntrinsicCall ?? throw ArgumentNullException("tryBindIntrinsicCall")
        this.tryBindInheritedClrInstanceCall = tryBindInheritedClrInstanceCall ??
            throw ArgumentNullException("tryBindInheritedClrInstanceCall")
        this.isFormattableStringTargetType = isFormattableStringTargetType ??
            throw ArgumentNullException("isFormattableStringTargetType")
        this.bindInterpolatedStringAsFormattable = bindInterpolatedStringAsFormattable ??
            throw ArgumentNullException("bindInterpolatedStringAsFormattable")
        this.getRefKindFromModifier = getRefKindFromModifier ?? throw ArgumentNullException("getRefKindFromModifier")
        this.refKindToString = refKindToString ?? throw ArgumentNullException("refKindToString")
        this.createErasedFunctionLiteralAdapter = createErasedFunctionLiteralAdapter ??
            throw ArgumentNullException("createErasedFunctionLiteralAdapter")
        this.wrapAsTask = wrapAsTask ?? throw ArgumentNullException("wrapAsTask")
        this.isAsyncIteratorReturnType = isAsyncIteratorReturnType ??
            throw ArgumentNullException("isAsyncIteratorReturnType")
        this.completeSuspendingCall = completeSuspendingCall ?? throw ArgumentNullException("completeSuspendingCall")
        this.tryGetFunctionLiteral = tryGetFunctionLiteral ?? throw ArgumentNullException("tryGetFunctionLiteral")
        this.inferTypeArguments = inferTypeArguments ?? throw ArgumentNullException("inferTypeArguments")
        this.substituteType = substituteType ?? throw ArgumentNullException("substituteType")
        this.satisfiesConstraint = satisfiesConstraint ?? throw ArgumentNullException("satisfiesConstraint")
        this.describeConstraint = describeConstraint ?? throw ArgumentNullException("describeConstraint")
        this.getCurrentFunction = getCurrentFunction ?? throw ArgumentNullException("getCurrentFunction")
        this.bindLambdaWithTarget = bindLambdaWithTarget
        this.bindUserTypeStaticCall = bindUserTypeStaticCall
        this.bindImportedClrStaticCall = bindImportedClrStaticCall
    }

    private prop Diagnostics DiagnosticBag -> binderCtx.Diagnostics

    internal func TryReportNullableDelegateReceiver(
        receiverType TypeSymbol?,
        location TextLocation,
        receiverName string,
        nullSafeInvocation string?
    ) bool {
        if receiverType is not NullableTypeSymbol nullableReceiver ||
            !MemberLookup.TryGetDelegateFunctionTypeFromSymbol(nullableReceiver.UnderlyingType, out _) {
            return false
        }
        Diagnostics.ReportNullableDelegateReceiverInvocation(location, receiverName, nullSafeInvocation)
        return true
    }

    private prop Scope BoundScope -> binderCtx.RootScope

    /// Gets the same CLR-arg cross-reflection-context (MLC) projector
    /// threaded through the emit-time `Construct` call sites
    /// ((cref:Symbols.StructSymbol.Construct(Symbols.StructSymbol, ImmutableArray{Symbols.TypeSymbol},
    /// Func{Type, Type}))).
    /// Both `Construct` call sites in this file build a same-compilation
    /// user type (`classType` is always a source-declared
    /// (cref:Symbols.StructSymbol) resolved by name in this scope, never
    /// an imported CLR generic), so under normal binding the raw
    /// `ClrType` args are already in this compilation's reflection
    /// context and no projection is needed. Threaded anyway for
    /// defense-in-depth / consistency with the other `Construct` sites
    /// touched by #2037, and to cover a future imported-generic-arg path
    /// without another audit.
    private prop MapClrType((Type) -> Type)? {
        get -> if binderCtx.References == nil {
            default(((Type) -> Type)?)
        } else {
            binderCtx.References.MapClrTypeToReferences
        }
    }

    shared {
        internal func GetNullableDelegateNullSafeInvocation() string -> "?(...)"
    }
}

/// Custom delegate type for the `TryBindClrConstructorCall`
/// callback, required because (cref:Func{T1, T2, TResult})
/// cannot express an `out` parameter.
internal delegate OverloadResolver_TryBindClrConstructorCallDelegate(
    syntax CallExpressionSyntax,
    @System.Diagnostics.CodeAnalysis.NotNullWhen(true) out result BoundExpression?
) bool;

/// Custom delegate type for the `TryBindIntrinsicCall`
/// callback (same rationale as
/// (cref:TryBindClrConstructorCallDelegate)).
internal delegate OverloadResolver_TryBindIntrinsicCallDelegate(
    syntax CallExpressionSyntax,
    @System.Diagnostics.CodeAnalysis.NotNullWhen(true) out result BoundExpression?
) bool;

/// Custom delegate type for the `TryBindInheritedClrInstanceCall`
/// callback (same rationale as
/// (cref:TryBindClrConstructorCallDelegate)).
internal delegate OverloadResolver_TryBindInheritedClrInstanceCallDelegate(
    receiver BoundExpression,
    importedBaseClr Type?,
    methodName string,
    arguments ImmutableArray[BoundExpression],
    ce CallExpressionSyntax,
    @System.Diagnostics.CodeAnalysis.NotNullWhen(true) out result BoundExpression?,
    explicitTypeArgs[]?Type,
    typeArgSymbols ImmutableArray[TypeSymbol],
    argumentNames ImmutableArray[string],
    allowProtectedInherited bool = false
) bool;

/// Custom delegate type for the `TryGetFunctionLiteral`
/// callback (same rationale as
/// (cref:TryBindClrConstructorCallDelegate)).
internal delegate OverloadResolver_TryGetFunctionLiteralDelegate(
    expression BoundExpression,
    @System.Diagnostics.CodeAnalysis.NotNullWhen(true) out literal BoundFunctionLiteralExpression?
) bool;
