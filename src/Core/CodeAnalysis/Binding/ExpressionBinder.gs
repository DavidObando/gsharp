// <copyright file="ExpressionBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import System.Text
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis

/// Extracted from (cref:Binder) in PR-B-9 — the final Phase-1
/// component. Owns every per-expression-kind binder: the
/// `BindExpression` dispatch entry points, literals, operators,
/// member access (the `BindAccessor*` family), assignments, calls
/// (call-site glue that is NOT in (cref:OverloadResolver)),
/// indexers, ref-argument shaping, switch expressions, await /
/// event-subscription bindings, and the long tail of expression-only
/// helpers (interpolated-string lowering, conditional common-type
/// resolution, method-group resolution, narrowing-frame inspection,
/// etc.). Because the moved code is ≈5,700 LoC, the class is split
/// across nested partial files for reviewability:
/// (cref:ExpressionBinder) (this file: ctor + dispatch + name binding),
/// `ExpressionBinder.Literals.cs`,
/// `ExpressionBinder.Operators.cs`,
/// `ExpressionBinder.Calls.cs`,
/// `ExpressionBinder.Access.cs`,
/// `ExpressionBinder.Assignments.cs`,
/// `ExpressionBinder.Async.cs`,
/// `ExpressionBinder.SwitchExpr.cs`.
/// @remarks Composed via constructor injection and Func/Action callbacks; never
/// back-references (cref:Binder) except for the small set of
/// static helpers that remain on the root (
/// (cref:Binder.InferTypeArguments),
/// (cref:Binder.SubstituteType(TypeSymbol, Dictionary{TypeParameterSymbol, TypeSymbol})),
/// (cref:Binder.SatisfiesConstraint),
/// (cref:Binder.DescribeConstraint),
/// (cref:Binder.GetClrGenericArguments),
/// (cref:Binder.AttachDocumentation),
/// (cref:Binder.FormatOverloadSignature)).
internal partial class ExpressionBinder {
    private let binderCtx BinderContext
    private let memberLookup MemberLookup
    private let conversions ConversionClassifier
    private let overloads OverloadResolver
    private let patterns PatternBinder
    private let lambdas LambdaBinder
    private let bindTypeClause(TypeClauseSyntax) -> TypeSymbol?
    private let lookupType(string) -> TypeSymbol?
    private let lookupTypeToken(SyntaxToken) -> TypeSymbol?
    private let resolveClrTypeForGenericArg(TypeSymbol) -> Type?
    private let reportObsoleteUseIfApplicable(TextLocation, Symbol, string) -> void
    private let isAsyncIteratorReturnType(TypeSymbol) -> bool
    private let getCurrentFunction() -> FunctionSymbol?
    private let bindStatementList(ImmutableArray[StatementSyntax], (() -> BoundStatement)?) -> ImmutableArray[
        BoundStatement
    ]
    private let bindRichAnonymousObject(AnonymousClassExpressionSyntax, StructSymbol) -> BoundExpression
    private let bindStructuralAdaptation(CallExpressionSyntax) -> BoundExpression
    private let bindNativeProtocolProbe(TextLocation, BoundExpression, TypeSymbol) -> BoundExpression

    // Issue #5569: the diagnostics of each discarded literal target bind in the calls that are binding now.
    private let literalTargetDiagnostics List[ImmutableArray[Diagnostic]] = List[ImmutableArray[Diagnostic]]()

    // ADR-0151: declares the local a value-position `if let` binding
    // introduces, routed through the same
    // `DeclarationBinder.BindVariableDeclaration` the statement forms use so
    // duplicate-name reporting and top-level/global variable shaping match.
    private let bindLocalVariable(SyntaxToken, bool, TypeSymbol) -> VariableSymbol

    // Issue #1502 follow-up: when true, a same-compilation enum (or `Enum?`)
    // appearing inside a delegate shape is erased to `object` (the covariant
    // reference ride-through) instead of its default scalar ride-through
    // (`int`/`int?`, issue #661). This is only enabled while computing the
    // effective CLR delegate shape of a lambda that target-types a delegate
    // parameter of a *constructed-generic constructor* (e.g. `Lazy[Color]`
    // closes to `Lazy<object>` whose ctor wants `Func<object>`). For generic
    // *method* inference (LINQ `Where`/`Select` over `[]Color`) the enum must
    // stay `int` so the lambda's `Func<int,bool>` unifies with the source's
    // `IEnumerable<int>`; that path leaves this flag false.
    private var eraseDelegateInnerEnumToObject bool

    init(
        binderCtx BinderContext,
        memberLookup MemberLookup,
        conversions ConversionClassifier,
        overloads OverloadResolver,
        patterns PatternBinder,
        lambdas LambdaBinder,
        bindTypeClause(TypeClauseSyntax) -> TypeSymbol?,
        lookupType(string) -> TypeSymbol?,
        lookupTypeToken(SyntaxToken) -> TypeSymbol?,
        resolveClrTypeForGenericArg(TypeSymbol) -> Type?,
        reportObsoleteUseIfApplicable(TextLocation, Symbol, string) -> void,
        isAsyncIteratorReturnType(TypeSymbol) -> bool,
        getCurrentFunction() -> FunctionSymbol?,
        bindStatementList(ImmutableArray[StatementSyntax], (() -> BoundStatement)?) -> ImmutableArray[BoundStatement],
        bindLocalVariable(SyntaxToken, bool, TypeSymbol) -> VariableSymbol,
        bindRichAnonymousObject(AnonymousClassExpressionSyntax, StructSymbol) -> BoundExpression,
        bindStructuralAdaptation(CallExpressionSyntax) -> BoundExpression,
        bindNativeProtocolProbe(TextLocation, BoundExpression, TypeSymbol) -> BoundExpression
    ) {
        this.binderCtx = binderCtx ?? throw ArgumentNullException("binderCtx")
        this.memberLookup = memberLookup ?? throw ArgumentNullException("memberLookup")
        this.conversions = conversions ?? throw ArgumentNullException("conversions")
        this.overloads = overloads ?? throw ArgumentNullException("overloads")
        this.patterns = patterns ?? throw ArgumentNullException("patterns")
        this.lambdas = lambdas ?? throw ArgumentNullException("lambdas")
        this.bindTypeClause = bindTypeClause ?? throw ArgumentNullException("bindTypeClause")
        this.lookupType = lookupType ?? throw ArgumentNullException("lookupType")
        this.lookupTypeToken = lookupTypeToken ?? throw ArgumentNullException("lookupTypeToken")
        this.resolveClrTypeForGenericArg = resolveClrTypeForGenericArg ??
            throw ArgumentNullException("resolveClrTypeForGenericArg")
        this.reportObsoleteUseIfApplicable = reportObsoleteUseIfApplicable ??
            throw ArgumentNullException("reportObsoleteUseIfApplicable")
        this.isAsyncIteratorReturnType = isAsyncIteratorReturnType ??
            throw ArgumentNullException("isAsyncIteratorReturnType")
        this.getCurrentFunction = getCurrentFunction ?? throw ArgumentNullException("getCurrentFunction")
        this.bindStatementList = bindStatementList
        this.bindLocalVariable = bindLocalVariable
        this.bindRichAnonymousObject = bindRichAnonymousObject
        this.bindStructuralAdaptation = bindStructuralAdaptation
        this.bindNativeProtocolProbe = bindNativeProtocolProbe
    }

    private prop Diagnostics DiagnosticBag -> binderCtx.Diagnostics

    private prop $scope BoundScope {
        get -> binderCtx.RootScope
        set -> this.binderCtx.RootScope = value
    }

    private prop function FunctionSymbol? -> getCurrentFunction()

    private func CanUseSpanAlias(identifier SyntaxToken, expression bool = false) bool ->
    binderCtx.CanUseSpanAlias($scope, identifier, getCurrentFunction(), expression) &&
        (
        !expression ||
            (
            !TryResolveInheritedClrInstanceMemberByBareName(identifier.ValueText, out _, out _) &&
                !TryResolveInterfaceInstancePropertyByBareName(identifier.ValueText, out _, out _)
        )
    )

    /// Issue #1159: returns the implicit-`this` parameter that an
    /// unqualified instance-member reference should bind against. For a direct
    /// instance method body this is the enclosing function's own
    /// (cref:FunctionSymbol.ThisParameter). Inside a lambda body the
    /// enclosing function is a synthetic (cref:FunctionSymbol) with no
    /// receiver, so we fall back to the `this` still visible in the
    /// current lexical scope — the enclosing instance method's `this`,
    /// which the lambda's child scope inherits and which capture analysis
    /// already captures into the display class (mirroring explicit
    /// `this.X` and bare field/property reads). In a static context no
    /// `this` is in scope, so this returns `null` and the
    /// bare-name method-group path stays unchanged.
    private func GetEffectiveThisParameter() ParameterSymbol? {
        if binderCtx.InConstructorInitializer {
            return nil
        }
        let current = getCurrentFunction()
        if current?.ThisParameter != nil {
            return current!!.ThisParameter!!
        }
        return $scope.TryLookupSymbol("this") as ParameterSymbol
    }

    private func GetConstructorInitializerReceiverType() StructSymbol? {
        return (function?.ReceiverType as StructSymbol) ??
            (($scope.TryLookupSymbol("this") as ParameterSymbol)?.Type as StructSymbol)
    }

    private func IsConstructorInitializerInstanceDataMember(name string) bool {
        let receiverType StructSymbol? = GetConstructorInitializerReceiverType()
        return receiverType != nil &&
            (
            TypeMemberModel.TryGetFieldIncludingInherited(
                receiverType,
                name,
                MemberQuery.Instance(MemberKinds.Field),
                out _,
                out _
            ) ||
                TypeMemberModel.TryGetProperty(receiverType, name, out _)
        )
    }

    private func IsConstructorInitializerInstanceMethod(name string) bool {
        let receiverType StructSymbol? = GetConstructorInitializerReceiverType()
        return receiverType != nil && !TypeMemberModel.GetMethods(
            receiverType,
            name,
            MemberQuery.Instance(MemberKinds.Method)
        )
            .IsDefaultOrEmpty
    }

    /// Issue #2218 follow-up: reports whether [`receiver`](paramref) IS
    /// the current implicit/explicit `this` (i.e. an unqualified call,
    /// or an explicit `this.Method(...)` call) rather than some other
    /// receiver expression that merely happens to share the enclosing type.
    /// Used to gate admission of `protected`/`protected internal`
    /// inherited CLR members in (cref:TryBindInheritedClrInstanceCall):
    /// that helper is shared by the general qualified-accessor call path
    /// (any `receiver.Method(...)`), so without this check a protected
    /// inherited member would be reachable through an arbitrary receiver,
    /// leaking accessibility outside the derived class.
    private func IsCurrentThisReceiver(receiver BoundExpression?) bool {
        let effThis ParameterSymbol? = GetEffectiveThisParameter()
        return effThis != nil && receiver is BoundVariableExpression bve && object.ReferenceEquals(
            bve.Variable,
            effThis
        )
    }

    private func BindExpressionWithNarrowing(
        syntax ExpressionSyntax,
        frame Dictionary[AccessPath, TypeSymbol]?,
        targetType TypeSymbol? = nil,
        canBeVoid bool = false
    ) BoundExpression {
        if frame == nil {
            return if targetType == nil {
                BindExpression(syntax, canBeVoid)
            } else {
                BindExpression(syntax, targetType)
            }
        }
        binderCtx.PushNarrowingFrame(frame)
        try {
            return if targetType == nil {
                BindExpression(syntax, canBeVoid)
            } else {
                BindExpression(syntax, targetType)
            }
        } finally {
            binderCtx.EndNarrowingProof()
        }
    }

    // Issue #991: bind a switch-arm `when` guard as a boolean expression. The
    // guard sees the same pattern narrowing / smart-cast frame as the arm body
    // (so `case x is T when …` observes `x` as `T`). A non-bool guard is
    // reported through the standard conversion diagnostic (GS0017).
    private func BindGuardExpression(
        syntax ExpressionSyntax,
        frame Dictionary[AccessPath, TypeSymbol]?
    ) BoundExpression {
        if frame == nil {
            return BindExpression(syntax, TypeSymbol.Bool)
        }
        binderCtx.PushNarrowingFrame(frame)
        try {
            return BindExpression(syntax, TypeSymbol.Bool)
        } finally {
            binderCtx.EndNarrowingProof()
        }
    }

    internal func BindExpression(syntax ExpressionSyntax, targetType TypeSymbol) BoundExpression {
        // ADR-0169: guarantee the dispatch-level anchor (see the canBeVoid
        // overload for the BoundErrorExpression exemption rationale).
        let result = BindExpressionWithTargetTypeCore(syntax, targetType)
        if !(result is BoundErrorExpression) {
            result.AnchorSyntax(syntax)
        }
        return result
    }

    private func BindExpressionWithTargetTypeCore(syntax ExpressionSyntax, targetType TypeSymbol) BoundExpression {
        // Issue #3355: parentheses do not erase the expected type of a
        // general block expression or its trailing value.
        if syntax is ParenthesizedExpressionSyntax parenthesized {
            return BindExpression(parenthesized.Expression, targetType)
        }
        // ADR-0124 / issue #1024: a `stackalloc [n]T` initialising an
        // unmanaged-pointer target (`*T`, only spellable in an unsafe context)
        // yields the raw `T*` pointer rather than the default `Span<T>`. The
        // target type must reach the stackalloc binder, so intercept before
        // the generic conversion path (which would bind the safe Span<T> form
        // and then fail to convert it to a pointer).
        if syntax is StackAllocExpressionSyntax stackAlloc && targetType is PointerTypeSymbol {
            return BindStackAllocExpression(stackAlloc, targetType)
        }
        if TryBindLambdaExpressionWithTargetType(syntax, targetType, out var targetTypedLambda) {
            return ConvertTargetTypedValue(syntax, targetTypedLambda!!, targetType)
        }
        // Issue #3355: prefix statements bind normally; the expected type
        // flows into the trailing expression.
        if syntax is BlockExpressionSyntax blockExpression {
            return BindBlockExpressionValue(blockExpression, canBeVoid: false, targetType, preserveEmptyBlock: true)
        }
        // Issue #1112: a switch-expression honors the target type (C#-style
        // target-typing) — bind it with the target so the result type can be
        // the target when every arm is implicitly convertible to it, then run
        // the standard conversion to shape/validate the overall result.
        if syntax is SwitchExpressionSyntax switchExpr {
            let boundSwitch = BindSwitchExpression(switchExpr, targetType)
            return ConvertTargetTypedValue(syntax, boundSwitch, targetType)
        }
        // Issue #1158: an if-expression and a ternary conditional likewise honor
        // the target type (C# 9+ target-typed conditional) — bind with the
        // target so sibling arms can unify to it, then run the standard
        // conversion to shape/validate the overall result.
        if syntax is IfExpressionSyntax ifExpr {
            let boundIf = BindIfExpression(ifExpr, targetType)
            return ConvertTargetTypedValue(syntax, boundIf, targetType)
        }
        // ADR-0151: the `if let` expression honors the target type on exactly
        // the same terms as the plain if-expression above — its branch tails
        // unify against the target before the standard conversion runs.
        if syntax is IfLetExpressionSyntax ifLetExpr {
            let boundIfLet = BindIfLetExpression(ifLetExpr, targetType)
            return ConvertTargetTypedValue(syntax, boundIfLet, targetType)
        }
        if syntax is ConditionalExpressionSyntax conditionalExpr {
            let boundConditional = BindConditionalExpression(conditionalExpr, targetType)
            return ConvertTargetTypedValue(syntax, boundConditional, targetType)
        }
        // Issue #1480: a null-coalescing operator (`a ?? b`) likewise honors the
        // contextual target type. When the operand underlyings share no natural
        // common type but both implicitly convert to the target (e.g. sibling
        // classes coalesced at a shared interface), bind with the target so the
        // result is target-typed rather than reported as GS0129.
        if syntax is BinaryExpressionSyntax binaryExpr &&
            binaryExpr
            .OperatorToken
            .Kind == SyntaxKind
            .QuestionQuestionToken {
            let boundCoalesce = BindBinaryExpression(binaryExpr, targetType)
            return ConvertTargetTypedValue(syntax, boundCoalesce, targetType)
        }
        return conversions.BindConversion(syntax, targetType)
    }

    private func ConvertTargetTypedValue(
        syntax ExpressionSyntax,
        value BoundExpression,
        targetType TypeSymbol
    ) BoundExpression {
        // Keep the original value's provenance before the dispatch anchor can
        // belong to a contextual conversion wrapper instead.
        if value is not BoundErrorExpression {
            value.AnchorSyntax(syntax)
        }
        return conversions.BindConversion(syntax.Location, value, targetType)
    }

    private func TryBindLambdaExpressionWithTargetType(
        syntax ExpressionSyntax,
        targetType TypeSymbol?,
        @NotNullWhen(true) out bound BoundExpression?
    ) bool {
        // Keep event handlers and assignment RHS binding on one target-typing path.
        // An explicitly typed lambda already has a complete natural shape.
        // Preserve the regular conversion diagnostic for nullable delegate
        // targets instead of replacing it with target-parameter diagnostics.
        bound = nil
        let lambda LambdaExpressionSyntax? = syntax as LambdaExpressionSyntax
        if lambda == nil || targetType == nil {
            return false
        }
        if targetType is NullableTypeSymbol {
            var allParametersTyped = true
            for parameter in lambda.Parameters {
                allParametersTyped &= parameter.Type != nil
            }
            if allParametersTyped {
                return false
            }
        }
        if !MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(targetType, out var targetFunctionType) {
            return false
        }
        bound = lambdas.BindLambdaExpression(
            Invariant.Required(lambda, "lambda target typing requires lambda syntax", expression: "lambda"),
            targetFunctionType
        )
        return true
    }

    internal func BindExpression(syntax ExpressionSyntax, canBeVoid bool = false) BoundExpression {
        // Issue #2620: discard context must reach wrappers and tail-if arms,
        // not merely suppress the final void-result check.
        let result = BindExpressionpublic(syntax, canBeVoid)
        if !canBeVoid && result.Type == TypeSymbol.Void {
            Diagnostics.ReportExpressionMustHaveValue(syntax.Location)
            return BoundErrorExpression(nil)
        }
        // ADR-0169: guarantee the dispatch-level anchor so semantic-model and
        // analyzer queries can resolve this expression by its syntax. Error
        // expressions are exempt: a BoundErrorExpression's null-vs-non-null
        // Syntax is the binder's defer-and-rebind sentinel (e.g. target-typed
        // lambda/conditional retry), so stamping one would trigger spurious
        // re-binds and duplicated diagnostics.
        if !(result is BoundErrorExpression) {
            result.AnchorSyntax(syntax)
        }
        return result
    }

    private func BindExpressionpublic(syntax ExpressionSyntax, canBeVoid bool = false) BoundExpression {
        switch syntax.Kind {
            case SyntaxKind.ParenthesizedExpression {
                return BindParenthesizedExpression(cast[ParenthesizedExpressionSyntax](syntax), canBeVoid)
            }
            case SyntaxKind.CheckedExpression, SyntaxKind.UncheckedExpression {
                return BindCheckedExpression(cast[CheckedExpressionSyntax](syntax), canBeVoid)
            }
            case SyntaxKind.LiteralExpression {
                return BindLiteralExpression(cast[LiteralExpressionSyntax](syntax))
            }
            case SyntaxKind.InterpolatedStringExpression {
                return BindInterpolatedStringExpression(cast[InterpolatedStringExpressionSyntax](syntax))
            }
            case SyntaxKind.NameExpression {
                return BindNameExpression(cast[NameExpressionSyntax](syntax))
            }
            case SyntaxKind.AssignmentExpression {
                return BindAssignmentExpression(cast[AssignmentExpressionSyntax](syntax))
            }
            case SyntaxKind.NullCoalescingAssignmentExpression {
                return BindNullCoalescingAssignmentExpression(cast[NullCoalescingAssignmentExpressionSyntax](syntax))
            }
            case SyntaxKind.UnaryExpression {
                return BindUnaryExpression(cast[UnaryExpressionSyntax](syntax))
            }
            case SyntaxKind.BinaryExpression {
                return BindBinaryExpression(cast[BinaryExpressionSyntax](syntax))
            }
            case SyntaxKind.CallExpression {
                return BindBufferAwareCallExpression(cast[CallExpressionSyntax](syntax))
            }
            case SyntaxKind.GenericNameExpression {
                return BindGenericNameExpression(cast[GenericNameExpressionSyntax](syntax))
            }
            case SyntaxKind.ObjectCreationExpression {
                return BindObjectCreationExpression(cast[ObjectCreationExpressionSyntax](syntax))
            }
            case SyntaxKind.CollectionInitializerExpression {
                return BindCollectionInitializerExpression(cast[CollectionInitializerExpressionSyntax](syntax))
            }
            case SyntaxKind.SpreadElementExpression {
                // Spread wrappers are normally consumed by their enclosing
                // array/collection literal binder. Binding the node directly
                // (e.g. a semantic-model query) yields its source expression.
                return BindExpression((cast[SpreadElementExpressionSyntax](syntax)).Expression, canBeVoid)
            }
            case SyntaxKind.AccessorExpression {
                return BindAccessorExpression(cast[AccessorExpressionSyntax](syntax))
            }
            case SyntaxKind.ArrayCreationExpression {
                return BindArrayCreationExpression(cast[ArrayCreationExpressionSyntax](syntax))
            }
            case SyntaxKind.StackAllocExpression {
                return BindStackAllocExpression(cast[StackAllocExpressionSyntax](syntax))
            }
            case SyntaxKind.MapCreationExpression {
                return BindMapCreationExpression(cast[MapCreationExpressionSyntax](syntax))
            }
            case SyntaxKind.IndexExpression {
                return BindIndexExpression(cast[IndexExpressionSyntax](syntax))
            }
            case SyntaxKind.IndexAssignmentExpression {
                return BindIndexAssignmentExpression(cast[IndexAssignmentExpressionSyntax](syntax))
            }
            case SyntaxKind.MemberIndexAssignmentExpression {
                return BindMemberIndexAssignmentExpression(cast[MemberIndexAssignmentExpressionSyntax](syntax))
            }
            case SyntaxKind.MemberFieldAssignmentExpression {
                return BindMemberFieldAssignmentExpression(cast[MemberFieldAssignmentExpressionSyntax](syntax))
            }
            case SyntaxKind.CompoundIndexAssignmentExpression {
                return BindCompoundIndexAssignmentExpression(cast[CompoundIndexAssignmentExpressionSyntax](syntax))
            }
            case SyntaxKind.StructLiteralExpression {
                return BindStructLiteralExpression(cast[StructLiteralExpressionSyntax](syntax))
            }
            case SyntaxKind.AnonymousClassExpression {
                return BindAnonymousClassExpression(cast[AnonymousClassExpressionSyntax](syntax))
            }
            case SyntaxKind.TupleLiteralExpression {
                return BindTupleLiteralExpression(cast[TupleLiteralExpressionSyntax](syntax))
            }
            case SyntaxKind.NamedTupleElement {
                // ADR-0172: a labeled element is only meaningful as a direct
                // tuple-literal child (unwrapped there); anywhere else the
                // label is stray — report and bind the value.
                let strayNamed = cast[NamedTupleElementSyntax](syntax)
                Diagnostics.ReportTupleElementNameOutsideTuple(strayNamed.NameToken.Location)
                return BindExpression(strayNamed.Expression)
            }
            case SyntaxKind.FunctionLiteralExpression {
                return lambdas.BindFunctionLiteralExpression(cast[FunctionLiteralExpressionSyntax](syntax))
            }
            case SyntaxKind.LambdaExpression {
                // ADR-0074 / issue #714: arrow lambda expression
                // `(x int32) -> body`. Bound to a BoundFunctionLiteralExpression
                // so closure capture, emit, interpreter, and lowering all work
                // through the existing function-literal pipeline.
                return lambdas.BindLambdaExpression(cast[LambdaExpressionSyntax](syntax))
            }
            case SyntaxKind.AwaitExpression {
                return BindAwaitExpression(cast[AwaitExpressionSyntax](syntax))
            }
            case SyntaxKind.SwitchExpression {
                return BindSwitchExpression(cast[SwitchExpressionSyntax](syntax), targetType: nil, canBeVoid: canBeVoid)
            }
            case SyntaxKind.MakeChannelExpression {
                return BindMakeChannelExpression(cast[MakeChannelExpressionSyntax](syntax))
            }
            case SyntaxKind.ChannelCreationExpression {
                return BindChannelCreationExpression(cast[ChannelCreationExpressionSyntax](syntax))
            }
            case SyntaxKind.TypeOfExpression {
                return BindTypeOfExpression(cast[TypeOfExpressionSyntax](syntax))
            }
            case SyntaxKind.SizeOfExpression {
                return BindSizeOfExpression(cast[SizeOfExpressionSyntax](syntax))
            }
            case SyntaxKind.NameOfExpression {
                return BindNameOfExpression(cast[NameOfExpressionSyntax](syntax))
            }
            case SyntaxKind.DefaultExpression {
                return BindDefaultExpression(cast[DefaultExpressionSyntax](syntax))
            }
            case SyntaxKind.FieldAssignmentExpression {
                return BindFieldAssignmentExpression(cast[FieldAssignmentExpressionSyntax](syntax))
            }
            case SyntaxKind.EventSubscriptionExpression {
                return BindEventSubscriptionExpression(cast[EventSubscriptionExpressionSyntax](syntax))
            }
            case SyntaxKind.WithExpression {
                return BindWithExpression(cast[WithExpressionSyntax](syntax))
            }
            case SyntaxKind.NamedArgumentExpression {
                Diagnostics.ReportNamedArgumentOnlyValidForCopy(syntax.Location)
                return BoundErrorExpression(nil)
            }
            case SyntaxKind.RefArgumentExpression {
                // ADR-0060: a ref-kind argument expression is only valid at an
                // argument position; if it surfaces in any other expression
                // context it is rejected here. The call-site binder dispatches
                // to BindRefArgumentExpression directly before reaching this.
                Diagnostics.ReportOutDeclarationOutsideOutArgument(syntax.Location)
                return BoundErrorExpression(nil)
            }
            case SyntaxKind.ConditionalRefArgumentExpression {
                // ADR-0061: a legacy conditional ref-argument expression
                // (with inner ref-kind modifiers) is only valid as the
                // payload of a ref-kind modifier or as the operand of `&`.
                // Those sites dispatch to the dedicated binders below;
                // anywhere else is a hard error.
                Diagnostics.ReportConditionalRefArgumentOutsideRefContext(syntax.Location)
                return BoundErrorExpression(nil)
            }
            case SyntaxKind.ConditionalExpression {
                // ADR-0062: general two-arm conditional in value context.
                // In ref-kind argument payloads and as the operand of `&`,
                // the call sites short-circuit to BindConditionalAddress
                // before reaching this dispatch.
                return BindConditionalExpression(cast[ConditionalExpressionSyntax](syntax))
            }
            case SyntaxKind.IfExpression {
                return BindIfExpression(cast[IfExpressionSyntax](syntax), targetType: nil, canBeVoid: canBeVoid)
            }
            case SyntaxKind.IfLetExpression {
                // ADR-0151: value-producing `if let` — see ExpressionBinder.IfLet.cs.
                return BindIfLetExpression(cast[IfLetExpressionSyntax](syntax), targetType: nil, canBeVoid: canBeVoid)
            }
            case SyntaxKind.BlockExpression {
                // Issue #3355: block-with-trailing-expression in any value
                // position. Lambda and if branches reuse this binder.
                return BindBlockExpressionValue(
                    cast[BlockExpressionSyntax](syntax),
                    canBeVoid,
                    preserveEmptyBlock: true
                )
            }
            case SyntaxKind.ThrowExpression {
                return BindThrowExpression(cast[ThrowExpressionSyntax](syntax))
            }
            case SyntaxKind.IndirectAssignmentExpression {
                return BindIndirectAssignmentExpression(cast[IndirectAssignmentExpressionSyntax](syntax))
            }
            case SyntaxKind.IndirectCompoundAssignmentExpression {
                return BindIndirectCompoundAssignmentExpression(
                    cast[IndirectCompoundAssignmentExpressionSyntax](syntax)
                )
            }
            case SyntaxKind.IsExpression {
                return BindIsExpression(cast[IsExpressionSyntax](syntax))
            }
            case SyntaxKind.AsExpression {
                return BindAsExpression(cast[AsExpressionSyntax](syntax))
            }
            case SyntaxKind.BaseInterfaceCallExpression {
                // ADR-0091 / issue #757: explicit-base interface call
                // `base[IFoo].M(args)`. Binds inside any instance member of
                // a class/struct that implements `IFoo`; the resulting
                // BoundBaseInterfaceCallExpression emits a non-virtual call
                // into the interface's default body.
                return BindBaseInterfaceCallExpression(cast[BaseInterfaceCallExpressionSyntax](syntax))
            }
            case SyntaxKind.BaseClassCallExpression {
                return BindBaseClassCallExpression(cast[BaseClassCallExpressionSyntax](syntax))
            }
            case SyntaxKind.RangeExpression {
                // Issue #1038: a standalone range `lo..hi` (and the open forms)
                // binds to a constructed `System.Range` value.
                return BindStandaloneRange(cast[RangeExpressionSyntax](syntax))
            }
            case SyntaxKind.FromEndIndexExpression {
                // ADR-0187: `^n` is a first-class `System.Index` value in every
                // expression context (`let last = ^1`, `consume(^2)`).
                return BindFromEndIndexValue(cast[FromEndIndexExpressionSyntax](syntax))
            }
            default {
                throw Exception("Unexpected syntax ${syntax.Kind}")
            }
        }
    }

    private func BindParenthesizedExpression(syntax ParenthesizedExpressionSyntax, canBeVoid bool) BoundExpression {
        return BindExpression(syntax.Expression, canBeVoid)
    }

    // Issue #1881: `checked(expr)` / `unchecked(expr)` binds the inner
    // expression under the named overflow context — no dedicated bound node
    // is needed (mirrors Roslyn: the context only steers which opcodes the
    // arithmetic/conversions inside pick). Innermost nesting wins via the
    // save/restore scope.
    private func BindCheckedExpression(syntax CheckedExpressionSyntax, canBeVoid bool) BoundExpression {
        using let scope_ = binderCtx.PushCheckedContext(syntax.IsChecked)
        return BindExpression(syntax.Expression, canBeVoid)
    }

    private func BindNameExpression(syntax NameExpressionSyntax) BoundExpression {
        let name = syntax.IdentifierToken.ValueText
        if syntax.IdentifierToken.IsMissing {
            // This means the token was inserted by the parser. We already
            // reported error so we can just return an error expression.
            return BoundErrorExpression(nil)
        }
        if binderCtx.InConstructorInitializer && name == "this" {
            Diagnostics.ReportConstructorInitializerCannotReferenceInstanceMember(syntax.IdentifierToken.Location, name)
            return BoundErrorExpression(nil)
        }
        let variable VariableSymbol? = BindVariableReference(
            name,
            syntax.IdentifierToken.Location,
            suppressNotAVariable: true,
            suppressUndefinedVariable: true
        )
        if variable == nil {
            if binderCtx.InConstructorInitializer &&
                ($scope.TryLookupSymbol(name) is ImplicitFieldVariableSymbol or ImplicitPropertyVariableSymbol) {
                return BoundErrorExpression(nil)
            }
            if binderCtx.InConstructorInitializer && IsConstructorInitializerInstanceDataMember(name) {
                Diagnostics.ReportConstructorInitializerCannotReferenceInstanceMember(
                    syntax.IdentifierToken.Location,
                    name
                )
                return BoundErrorExpression(nil)
            }
            // Issue #324: a bare identifier naming a free (package-level)
            // function is a method group. In a value context — e.g. assigning
            // to a `func(...)` or `Func[...]` slot — it converts to a delegate
            // over that function. We only synthesize the group here; the
            // conversion classifier decides whether the surrounding context
            // actually accepts it (otherwise a cannot-convert is reported).
            if TryBindMethodGroup(syntax, out var methodGroup) {
                return methodGroup!!
            }
            // ADR-0156 Phase 2: a bare identifier may name a top-level global
            // (static field) or function (static method group) of a prior
            // interactive submission's <Program> container, newest submission
            // first. Runs before the static-import fallbacks so prior cells'
            // declarations shadow static-import members, mirroring the
            // evaluator scope chain.
            if TryBindSubmissionStaticMember(syntax, out var submissionMember) {
                return submissionMember!!
            }
            // Issue #1201 (C# `using static`): an unqualified identifier may
            // name a `shared` (static) field, property, or method group of a
            // type brought into scope by a type import (`import Ns.Type`). This
            // is the value/method-group analog of the call-site resolution in
            // OverloadResolver and runs only after the name failed to resolve as
            // a variable or free-function method group.
            if TryBindImportedStaticMember(syntax, out var importedStaticMember) {
                return importedStaticMember!!
            }
            // Issue #1582: a bare identifier inside an instance method of a G#
            // class that derives from a metadata base may name an inherited CLR
            // instance property/field (e.g. `return Message` in a class deriving
            // from System.Exception). Unqualified inherited METHODS already
            // resolve via the method-group path above; this mirrors that for
            // properties/fields so bare and `this.`-qualified access behave
            // identically for a metadata base, matching a user-defined base.
            if TryBindInheritedClrInstanceMemberByBareName(
                syntax.IdentifierToken.ValueText,
                out var inheritedClrMember
            ) {
                return inheritedClrMember!!
            }
            // Issue #3840: a bare identifier inside a DEFAULT INTERFACE METHOD
            // body may name the enclosing interface's own instance property.
            // The implicit-member pseudo-variables are only seeded for a
            // StructSymbol receiver, so this is the interface analog — bare and
            // `this.`-qualified access behave identically in a DIM exactly as
            // they already do in a class body.
            if TryBindInterfaceInstancePropertyByBareName(syntax, out var interfaceMember) {
                return interfaceMember!!
            }
            if binderCtx.InConstructorInitializer && IsConstructorInitializerInstanceMethod(name) {
                Diagnostics.ReportConstructorInitializerCannotReferenceInstanceMember(
                    syntax.IdentifierToken.Location,
                    name
                )
                return BoundErrorExpression(nil)
            }
            // Not a method group: surface the suppressed diagnostics.
            if $scope.TryLookupSymbol(name) == nil {
                // ADR-0166: a pattern variable read outside the region its
                // match dominates is a definite-assignment error, not an
                // unknown name.
                if binderCtx.PatternVariableNames.Contains(name) {
                    Diagnostics.ReportPatternVariableNotDefinitelyAssigned(syntax.IdentifierToken.Location, name)
                } else {
                    Diagnostics.ReportUndefinedVariable(syntax.IdentifierToken.Location, name)
                }
            } else if !($scope.TryLookupSymbol(name) is VariableSymbol) {
                Diagnostics.ReportNotAVariable(syntax.IdentifierToken.Location, name)
            }
            // Issue #721 / ADR-0081: when the unresolved identifier is the
            // literal text `null` and no symbol named `null` exists in scope,
            // synthesise a `nil` literal so that target-type contexts (e.g.
            // `let x string? = null`, `Foo(null)` where `Foo` takes `T?`,
            // and `x == null`) continue to typecheck without cascading
            // errors. The GS0273 "did you mean 'nil'?" diagnostic has
            // already been emitted by ReportUndefinedVariable above.
            if name == "null" && $scope.TryLookupSymbol(name) == nil {
                return BoundLiteralExpression(syntax, value: nil)
            }
            return BoundErrorExpression(nil)
        }
        if (variable is ImplicitPropertyVariableSymbol or ImplicitStaticPropertyVariableSymbol) &&
            AccessibilityChecker
            .TryGetInaccessibleImplicitMemberRead(
            variable,
            this.function,
            out var propertyOwner,
            out var propertyName,
            out var getterAccessibility
        ) {
            let owner = Invariant.Required(
                propertyOwner,
                "an inaccessible implicit property has a declaring owner",
                expression: "propertyOwner"
            )
            Diagnostics.ReportMemberInaccessible(
                syntax.IdentifierToken.Location,
                propertyName,
                owner.Name,
                getterAccessibility
            )
            return BoundErrorExpression(nil)
        }
        if variable is ImplicitFieldVariableSymbol implicitField {
            // Issue #186 / #175: bare field-name read inside a method fires
            // GS0204 if the underlying field carries `@Obsolete`.
            reportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitField.Field,
                "${implicitField.StructType.Name}.${implicitField.Field.Name}"
            )
            // Issue #4377 (ADR-0122 §10): a bare (implicit-`this`) fixed-size
            // buffer field decays to a `*T` to its first element exactly as the
            // explicit `this.name` member access does, so `name[i]` indexes and
            // `fixed p *T = name { … }` pins it (issue #4378).
            if implicitField.Field.IsFixedBuffer {
                return MakeFixedBufferPointer(
                    BoundVariableExpression(nil, implicitField.Receiver),
                    implicitField.StructType,
                    implicitField.Field
                )
            }
            // Issue #208: apply any [MemberNotNull] post-call narrowing so that
            // `field.Member` accesses after a [MemberNotNull] helper call are
            // accepted without a nil-guard.
            let narrowedFieldType = TryGetNarrowedType(implicitField)
            let makeNarrowedField(TypeSymbol) -> BoundExpression = (
                narrowedType TypeSymbol
            ) -> BoundFieldAccessExpression(
                nil,
                BoundVariableExpression(nil, implicitField.Receiver),
                implicitField.StructType,
                implicitField.Field,
                narrowedType
            )
            return BuildNarrowedRead(
                BoundFieldAccessExpression(
                    nil,
                    BoundVariableExpression(nil, implicitField.Receiver),
                    implicitField.StructType,
                    implicitField.Field
                ),
                implicitField.Field.Type,
                narrowedFieldType,
                makeNarrowedField
            )
        }
        // Issue #261: bare static field name inside a shared method body.
        if variable is ImplicitStaticFieldVariableSymbol implicitStaticField {
            reportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitStaticField.Field,
                "${implicitStaticField.OwnerName}.${implicitStaticField.Field.Name}"
            )
            return if implicitStaticField.InterfaceType != nil {
                BoundFieldAccessExpression(nil, implicitStaticField.Field, implicitStaticField.InterfaceType)
            } else {
                BoundFieldAccessExpression(
                    nil,
                    receiver: nil,
                    implicitStaticField.StructType,
                    implicitStaticField.Field
                )
            }
        }
        // ADR-0053: bare static property name inside a method body (shared
        // or instance) of the enclosing type.
        if variable is ImplicitStaticPropertyVariableSymbol implicitStaticProp {
            reportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitStaticProp.Property,
                "${implicitStaticProp.StructType.Name}.${implicitStaticProp.Property.Name}"
            )
            if !implicitStaticProp.Property.HasGetter {
                Diagnostics.ReportCannotAssign(syntax.IdentifierToken.Location, implicitStaticProp.Property.Name)
                return BoundErrorExpression(nil)
            }
            return BoundPropertyAccessExpression(
                nil,
                receiver: nil,
                implicitStaticProp.StructType,
                implicitStaticProp.Property
            )
        }
        // Bare property name inside an instance method body resolves to
        // `this.<property>` (analogous to implicit field access).
        if variable is ImplicitPropertyVariableSymbol implicitProp {
            reportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitProp.Property,
                "${implicitProp.StructType.Name}.${implicitProp.Property.Name}"
            )
            if !implicitProp.Property.HasGetter {
                Diagnostics.ReportCannotAssign(syntax.IdentifierToken.Location, implicitProp.Property.Name)
                return BoundErrorExpression(nil)
            }
            return BoundPropertyAccessExpression(
                nil,
                BoundVariableExpression(nil, implicitProp.Receiver),
                implicitProp.StructType,
                implicitProp.Property
            )
        }
        return BuildNarrowedVariableRead(variable, syntax.IdentifierToken.Location)
    }

    private func BuildNarrowedVariableRead(variable VariableSymbol, location TextLocation? = nil) BoundExpression {
        if location is {} useLocation {
            binderCtx.TrackBackwardGotoNarrowingRead(variable, useLocation)
        }
        let makeNarrowedVariable(TypeSymbol) -> BoundExpression = (narrowedType TypeSymbol) -> BoundVariableExpression(
            nil,
            variable,
            narrowedType
        )
        return BuildNarrowedRead(
            BoundVariableExpression(nil, variable),
            variable.Type,
            TryGetNarrowedType(variable, location),
            makeNarrowedVariable
        )
    }

    private func TryGetNarrowedType(variable VariableSymbol, location TextLocation? = nil) TypeSymbol? {
        let answer = LookUpNarrowedType(variable)
        if NarrowingComparison.Enabled {
            ReportShadowRead(AccessPath.ForVariable(variable), answer, variable.Type, location)
        }
        return answer
    }

    // ADR-0208 section 19, comparison mode: reports a read whose type the shadow
    // flow would narrow and the frames do not.
    private func ReportShadowRead(
        path AccessPath,
        frameAnswer TypeSymbol?,
        declaredType TypeSymbol,
        location TextLocation?
    ) {
        let shadowType = binderCtx.ShadowEffectiveType(path, frameAnswer)
        // A read without a frame fact has the declared type today.
        if shadowType != nil && !object.Equals(shadowType, frameAnswer ?? declaredType) {
            NarrowingComparison.ReportRead(location, path, declaredType, shadowType)
        }
    }

    private func LookUpNarrowedType(variable VariableSymbol) TypeSymbol? {
        // Phase 3.C.4: smart-cast narrowing map. The topmost narrowing wins.
        return binderCtx.NarrowedVariables.Query(AccessPath.ForVariable(variable))
    }

    /// ADR-0069 addendum / issue #1180: smart-cast narrowing lookup keyed by an
    /// (cref:AccessPath). Walks the active frame stack innermost-first so
    /// the topmost narrowing wins, mirroring the variable overload.
    /// @param path The stable access path to look up.
    /// @returns The narrowed type, or `null` when the path is not narrowed.
    private func TryGetNarrowedType(path AccessPath, declaredType TypeSymbol, location TextLocation?) TypeSymbol? {
        let answer = LookUpNarrowedType(path)
        if NarrowingComparison.Enabled {
            ReportShadowRead(path, answer, declaredType, location)
        }
        return answer
    }

    private func TryGetNarrowedType(path AccessPath) TypeSymbol? -> LookUpNarrowedType(path)

    private func LookUpNarrowedType(path AccessPath) TypeSymbol? -> binderCtx.NarrowedVariables.Query(path)

    /// ADR-0069 addendum / issue #1180: if [`node`](paramref) reads a
    /// stable member-access path that an active smart-cast frame has narrowed,
    /// returns a copy of the read carrying the narrowed type so downstream
    /// member lookup, overload resolution, conversion, and emit see the tested
    /// type. Returns [`node`](paramref) unchanged otherwise. The narrowing
    /// never overrides an already-narrowed read (e.g. a `[MemberNotNull]`
    /// view).
    /// @param node A freshly bound field- or property-access read.
    /// @returns The possibly-narrowed read.
    private func ApplyMemberNarrowing(node BoundExpression) BoundExpression {
        if binderCtx.NarrowedVariables.Count == 0 {
            return node
        }
        let fieldAccess BoundFieldAccessExpression? = node as BoundFieldAccessExpression
        if fieldAccess != nil && fieldAccess.NarrowedType == nil {
            if !SmartCastStability.TryGetStableMemberPath(fieldAccess, out var path, out _) {
                return node
            }
            let stablePath = Invariant.Required(
                path,
                "a successful stable field-path lookup has a path",
                expression: "path"
            )
            let narrowed TypeSymbol? = TryGetNarrowedType(
                stablePath,
                fieldAccess.SubstitutedType ?? fieldAccess.Field.Type,
                fieldAccess.Syntax?.Location
            )
            if narrowed == nil {
                return node
            }
            let baseRead = BoundFieldAccessExpression(
                fieldAccess.Syntax,
                fieldAccess.Receiver,
                fieldAccess.StructType,
                fieldAccess.Field,
                fieldAccess.SubstitutedType,
                narrowedType: nil
            )
            let makeNarrowedField(TypeSymbol) -> BoundExpression = (
                narrowedType TypeSymbol
            ) -> BoundFieldAccessExpression(
                fieldAccess.Syntax,
                fieldAccess.Receiver,
                fieldAccess.StructType,
                fieldAccess.Field,
                fieldAccess.SubstitutedType,
                narrowedType
            )
            return BuildNarrowedRead(
                baseRead,
                fieldAccess.SubstitutedType ?? fieldAccess.Field.Type,
                narrowed,
                makeNarrowedField
            )
        }
        let propertyAccess BoundPropertyAccessExpression? = node as BoundPropertyAccessExpression
        if propertyAccess != nil && propertyAccess.NarrowedType == nil {
            if !SmartCastStability.TryGetStableMemberPath(propertyAccess, out var path, out _) {
                return node
            }
            let stablePath = Invariant.Required(
                path,
                "a successful stable property-path lookup has a path",
                expression: "path"
            )
            let narrowed TypeSymbol? = TryGetNarrowedType(
                stablePath,
                propertyAccess.SubstitutedType ?? propertyAccess.Property.Type,
                propertyAccess.Syntax?.Location
            )
            if narrowed == nil {
                return node
            }
            let baseRead = BoundPropertyAccessExpression(
                propertyAccess.Syntax,
                propertyAccess.Receiver,
                propertyAccess.StructType,
                propertyAccess.Property,
                propertyAccess.SubstitutedType,
                narrowedType: nil,
                interfaceType: propertyAccess.InterfaceType
            )
            let makeNarrowedProperty(TypeSymbol) -> BoundExpression = (
                narrowedType TypeSymbol
            ) -> BoundPropertyAccessExpression(
                nil,
                propertyAccess.Receiver,
                propertyAccess.StructType,
                propertyAccess.Property,
                propertyAccess.SubstitutedType,
                narrowedType,
                propertyAccess.InterfaceType
            )
            return BuildNarrowedRead(
                baseRead,
                propertyAccess.SubstitutedType ?? propertyAccess.Property.Type,
                narrowed,
                makeNarrowedProperty
            )
        }
        let clrAccess BoundClrPropertyAccessExpression? = node as BoundClrPropertyAccessExpression
        if clrAccess == nil {
            return node
        }
        if !SmartCastStability.TryGetStableMemberPath(clrAccess, out var clrPath, out _) {
            return node
        }
        let stableClrPath = Invariant.Required(
            clrPath,
            "a successful stable CLR member-path lookup has a path",
            expression: "clrPath"
        )
        let clrNarrowed TypeSymbol? = TryGetNarrowedType(stableClrPath, clrAccess.Type, clrAccess.Syntax?.Location)
        if clrNarrowed == nil {
            return node
        }
        let clrBaseRead = BoundClrPropertyAccessExpression(
            clrAccess.Syntax,
            clrAccess.Receiver,
            clrAccess.Member,
            clrAccess.Type,
            clrAccess.StaticContainerType,
            clrAccess.ConstrainedReceiverTypeParameter,
            clrAccess.ConstrainedInterfaceType
        )
        let makeNarrowedClrProperty(TypeSymbol) -> BoundExpression = (
            narrowedType TypeSymbol
        ) -> BoundClrPropertyAccessExpression(
            nil,
            clrAccess.Receiver,
            clrAccess.Member,
            narrowedType,
            clrAccess.StaticContainerType,
            clrAccess.ConstrainedReceiverTypeParameter,
            clrAccess.ConstrainedInterfaceType
        )
        return BuildNarrowedRead(clrBaseRead, clrAccess.Type, clrNarrowed, makeNarrowedClrProperty)
    }

    /// ADR-0069 / issue #700: when binding an `&&` expression,
    /// derive the narrowing frame the right operand should bind under from
    /// the (already-bound) left operand. Recognises `x is T`,
    /// `!(x is T)`, and nested `&&` chains; returns
    /// `null` when no narrowing can be safely inferred.
    private func TryClassifyTypeTestNarrowingForAnd(boundLeft BoundExpression) Dictionary[AccessPath, TypeSymbol]? {
        let (thenFrame, _) = ClassifyTypeTestNarrowing(boundLeft)
        return if (thenFrame != nil && thenFrame.Count > 0) {
            thenFrame
        } else {
            default(Dictionary[AccessPath, TypeSymbol]?)
        }
    }

    /// ADR-0069 addendum / issue #712: when binding a `||` expression,
    /// derive the narrowing frame the right operand should bind under from
    /// the (already-bound) left operand. The right operand is only
    /// evaluated when the left was false, so the left operand's
    /// `else` frame (the negation of its narrowing) applies. This
    /// makes `!(x is T) || f(x)` bind `f(x)` with `x` narrowed to `T`.
    private func TryClassifyTypeTestNarrowingForOr(boundLeft BoundExpression) Dictionary[AccessPath, TypeSymbol]? {
        let (_, elseFrame) = ClassifyTypeTestNarrowing(boundLeft)
        return if (elseFrame != nil && elseFrame.Count > 0) {
            elseFrame
        } else {
            default(Dictionary[AccessPath, TypeSymbol]?)
        }
    }

    /// Binds a name expression to produce its bound form without side effects
    /// (used by compound assignment fallback to read the current value).
    private func BindNameExpressionCore(syntax NameExpressionSyntax) BoundExpression {
        return BindNameExpression(syntax)
    }

    private func TryGetWritableClrMember(
        member MemberInfo?,
        @NotNullWhen(true) out targetType Type?,
        @NotNullWhen(true) out targetTypeSymbol TypeSymbol?,
        out writable bool,
        fromDerivedType bool = false
    ) bool -> TryGetWritableClrMember(
        member,
        receiverType: nil,
        out targetType,
        out targetTypeSymbol,
        out writable,
        fromDerivedType
    )

    private func TryGetWritableClrMember(
        member MemberInfo?,
        receiverType TypeSymbol?,
        @NotNullWhen(true) out targetType Type?,
        @NotNullWhen(true) out targetTypeSymbol TypeSymbol?,
        out writable bool,
        fromDerivedType bool = false
    ) bool {
        switch member {
            case p is PropertyInfo {
                targetType = p.PropertyType
                targetTypeSymbol = if receiverType == nil {
                    ClrNullability.GetPropertyTypeSymbol(p)
                } else {
                    MemberLookup.GetClrPropertyTypeSymbol(receiverType, p, projectOnlyWhenSymbolicallyRequired: true)
                }
                // Issue #3813: `fromDerivedType` marks the inherited-CLR-base
                // assignment paths (#319/#1582), where a `protected` setter on
                // the base IS reachable and must not be gated away as if this
                // were an outside caller.
                writable = p.CanWrite && GetVisibleSetter(p, fromDerivedType) != nil
                return writable
            }
            case f is FieldInfo {
                targetType = f.FieldType
                targetTypeSymbol = if receiverType == nil {
                    ClrNullability.GetFieldTypeSymbol(f)
                } else {
                    MemberLookup.GetClrFieldTypeSymbol(receiverType, f)
                }
                writable = !f.IsInitOnly && !f.IsLiteral
                return writable
            }
            default {
                targetType = nil
                targetTypeSymbol = nil
                writable = false
                return false
            }
        }
    }

    /// Issue #3705: whether this compilation may see the `internal`
    /// members declared by [`clrType`](paramref)'s assembly.
    /// @param clrType The declaring CLR type.
    /// @returns `true` when friend internals are visible.
    private func CanAccessInternalsOf(clrType Type?) bool -> clrType?.Assembly is {} assembly &&
        $scope.References!!.CanAccessInternalMembers(assembly)

    /// Issue #3705: the property's getter when this compilation may call it —
    /// public, or `internal` in a friend assembly. Member-lookup gates
    /// should use this rather than `GetGetMethod(nonPublic: false)`, which
    /// silently rejects a friend-visible accessor.
    /// @param property The imported CLR property.
    /// @returns The callable getter, or `null`.
    private func GetVisibleGetter(property PropertyInfo) MethodInfo? -> ClrMemberVisibility.GetVisibleGetter(
        property,
        CanAccessInternalsOf(property.DeclaringType)
    )

    private func GetVisibleGetter(property PropertyInfo, fromDerivedType bool) MethodInfo? -> if fromDerivedType {
        ClrMemberVisibility.GetDerivedVisibleGetter(property, CanAccessInternalsOf(property.DeclaringType))
    } else {
        ClrMemberVisibility.GetVisibleGetter(property, CanAccessInternalsOf(property.DeclaringType))
    }

    /// Issue #3705: the setter sibling of (cref:GetVisibleGetter(PropertyInfo)).
    /// @param property The imported CLR property.
    /// @returns The callable setter, or `null`.
    private func GetVisibleSetter(property PropertyInfo) MethodInfo? -> ClrMemberVisibility.GetVisibleSetter(
        property,
        CanAccessInternalsOf(property.DeclaringType)
    )

    /// Issue #3813: (cref:GetVisibleSetter(PropertyInfo)), widened to
    /// `protected` accessors when the write is being bound inside a type
    /// that derives from [`property`](paramref)'s declaring type.
    /// @param property The imported CLR property.
    /// @param fromDerivedType Whether the write site derives from the declaring type.
    /// @returns The callable setter, or `null`.
    private func GetVisibleSetter(property PropertyInfo, fromDerivedType bool) MethodInfo? -> if fromDerivedType {
        ClrMemberVisibility.GetDerivedVisibleSetter(property, CanAccessInternalsOf(property.DeclaringType))
    } else {
        ClrMemberVisibility.GetVisibleSetter(property, CanAccessInternalsOf(property.DeclaringType))
    }

    /// Issue #3705: the shared instance-property probe for CLR member lookup.
    ///
    /// #3693 widened the method probes and #3702 the writability test, but the
    /// property/field <em>lookups</em> on the assignment paths still ran
    /// `BindingFlags.Public`-only, so a friend assembly could read
    /// `internal T P { get; set; }` and never write it (GS0130). Both the
    /// read and the write path now come through here, so the two cannot drift
    /// apart again. Only metadata `assembly` accessibility is admitted —
    /// `private`, `protected`, `protected internal` and
    /// `private protected` stay invisible.
    /// @param clrReceiverType The receiver's CLR type.
    /// @param name The member name to find.
    /// @returns The visible property, or `null`.
    private func SafeGetVisibleInstanceProperty(clrReceiverType Type, name string) PropertyInfo? {
        let property = SafeGetVisibleInstancePropertyCore(clrReceiverType, name)
        return if IsHiddenByTheReceiversOwnField(clrReceiverType, property, name) {
            default(PropertyInfo?)
        } else {
            property
        }
    }

    /// Issue #3705: the interface-aware property probe itself. Callers go
    /// through (cref:SafeGetVisibleInstanceProperty), which applies the
    /// #3704 ordering rule on top.
    /// @param clrReceiverType The receiver's CLR type.
    /// @param name The member name to find.
    /// @returns The visible property, or `null`.
    private func SafeGetVisibleInstancePropertyCore(clrReceiverType Type, name string) PropertyInfo? {
        let property PropertyInfo? = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(
            clrReceiverType,
            name,
            BindingFlags.Public | BindingFlags.Instance
        )
        if property != nil || !CanAccessInternalsOf(clrReceiverType) {
            return property
        }
        let candidate = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(
            clrReceiverType,
            name,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
        )
        return if ClrMemberVisibility.IsVisible(candidate, includeInternal: true) {
            candidate
        } else {
            default(PropertyInfo?)
        }
    }

    /// The property probe runs before the field probe. Keep the nearest
    /// declaration when a field hides an inherited property. A field in the
    /// class hierarchy also takes precedence over an interface property.
    /// @param clrReceiverType The receiver's CLR type.
    /// @param property The property the probe found, if any.
    /// @param name The member name being looked up.
    /// @returns `true` when a same-named field is at least as near as the property.
    private func IsHiddenByTheReceiversOwnField(clrReceiverType Type?, property PropertyInfo?, name string) bool {
        let propertyOwner = property?.DeclaringType
        if propertyOwner == nil || clrReceiverType == nil || clrReceiverType.IsInterface {
            return false
        }
        let fieldOwner = SafeGetVisibleInstanceField(clrReceiverType, name)?.DeclaringType
        if fieldOwner == nil {
            return false
        }
        for var current Type? = clrReceiverType; current != nil; current = current?.BaseType {
            if ClrTypeUtilities.AreSame(current, fieldOwner) {
                return true
            }
            if ClrTypeUtilities.AreSame(current, propertyOwner) {
                return false
            }
        }
        return false
    }

    /// Issue #3705: the shared instance-field probe for CLR member lookup —
    /// the field sibling of (cref:SafeGetVisibleInstanceProperty).
    /// @param clrReceiverType The receiver's CLR type.
    /// @param name The member name to find.
    /// @returns The visible field, or `null`.
    private func SafeGetVisibleInstanceField(clrReceiverType Type, name string) FieldInfo? {
        let field FieldInfo? = ClrTypeUtilities.SafeGetFieldIncludingInterfaces(
            clrReceiverType,
            name,
            BindingFlags.Public | BindingFlags.Instance
        )
        if field != nil || !CanAccessInternalsOf(clrReceiverType) {
            return field
        }
        let candidate = ClrTypeUtilities.SafeGetFieldIncludingInterfaces(
            clrReceiverType,
            name,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
        )
        return if ClrMemberVisibility.IsVisible(candidate, includeInternal: true) {
            candidate
        } else {
            default(FieldInfo?)
        }
    }

    /// Issue #1238: binds a (named-argument-unwrapped) call argument value,
    /// deferring a no-common-type unification failure when the value is a
    /// target-typeable branchy expression (so it can be re-bound against the
    /// resolved parameter type). See (cref:BinderContext.DeferTargetlessConditional).
    internal func BindArgumentDeferringBranchy(inner ExpressionSyntax) BoundExpression {
        if IsTargetDependentBlockArgumentSyntax(inner) {
            return BoundErrorExpression(inner)
        }
        if !IsTargetTypedBranchyArgumentSyntax(inner) {
            return BindExpression(inner)
        }
        let previous = binderCtx.DeferTargetlessConditional
        this.binderCtx.DeferTargetlessConditional = true
        try {
            return BindExpression(inner)
        } finally {
            this.binderCtx.DeferTargetlessConditional = previous
        }
    }

    internal func BindVariableReference(name string, location TextLocation) VariableSymbol? {
        return BindVariableReference(name, location, suppressNotAVariable: false)
    }

    internal func BindVariableReference(name string, location TextLocation, suppressNotAVariable bool) VariableSymbol? {
        return BindVariableReference(name, location, suppressNotAVariable, suppressUndefinedVariable: false)
    }

    internal func BindVariableReference(
        name string,
        location TextLocation,
        suppressNotAVariable bool,
        suppressUndefinedVariable bool
    ) VariableSymbol? {
        switch $scope.TryLookupSymbol(name) {
            case asyncLet is AsyncLetVariableSymbol {
                // ADR-0174 D15 / GS0569: the value may not have arrived. Every
                // read of an `async let` binding is spelled `await name`, which
                // BindAwaitExpression intercepts before the name ever binds.
                Diagnostics.ReportAsyncLetReadWithoutAwait(location, asyncLet.Name)
                return nil
            }
            case variable is VariableSymbol {
                if binderCtx.InConstructorInitializer &&
                    (
                    name == "this" ||
                        variable is ImplicitFieldVariableSymbol ||
                        variable is ImplicitPropertyVariableSymbol
                ) {
                    Diagnostics.ReportConstructorInitializerCannotReferenceInstanceMember(location, name)
                    return nil
                }
                // Bare implicit fields use the same accessibility as their
                // qualified equivalents. Property reads are checked by
                // BindNameExpression so setter-only access remains valid.
                if !(variable is ImplicitPropertyVariableSymbol) &&
                    !(variable is ImplicitStaticPropertyVariableSymbol) &&
                    AccessibilityChecker
                    .TryGetInaccessibleImplicitMemberRead(
                    variable,
                    this.function,
                    out var declaringOwner,
                    out var memberName,
                    out var memberAccessibility
                ) {
                    let owner = Invariant.Required(
                        declaringOwner,
                        "an inaccessible implicit member has a declaring owner",
                        expression: "declaringOwner"
                    )
                    Diagnostics.ReportMemberInaccessible(location, memberName, owner.Name, memberAccessibility)
                    return nil
                }
                // Issue #3215: a top-level `var p = &x` holds a managed pointer
                // (`*T`). ECMA-335 forbids a byref field signature, so such a
                // variable can never be hoisted to a static field — it lives
                // only as a local slot of the synthesized entry point (see the
                // matching PlanFieldRows carve-out). A declared function or
                // method body therefore has no storage to reach it through;
                // reject the reference with the byref-escape diagnostic instead
                // of failing deep inside emit.
                if variable is GlobalVariableSymbol &&
                    variable.Type is ByRefTypeSymbol &&
                    this.function is {IsTopLevelEntryPoint: false} {
                    Diagnostics.ReportByRefCannotEscape(
                        location,
                        "the top-level pointer variable '$name' cannot be referenced from a function body; a managed pointer (*T) cannot be stored in a global field"
                    )
                    return nil
                }
                reportObsoleteUseIfApplicable(location, variable, variable.Name)
                return variable
            }
            case nil {
                if !suppressUndefinedVariable {
                    Diagnostics.ReportUndefinedVariable(location, name)
                }
                return nil
            }
            default {
                if !suppressNotAVariable {
                    Diagnostics.ReportNotAVariable(location, name)
                }
                return nil
            }
        }
    }

    private func TryBindMethodGroup(
        syntax NameExpressionSyntax,
        @NotNullWhen(true) out methodGroup BoundExpression?
    ) bool {
        methodGroup = nil
        let name = syntax.IdentifierToken.ValueText
        // ADR-0063 §9: a name may resolve to multiple user-function overloads.
        // Gather every candidate so BindConversion can pick the one matching the
        // target delegate signature. Fall back to TryLookupSymbol for cases
        // where the name maps to a function not surfaced via the function
        // overload tables (legacy lookup behavior).
        let overloads = $scope.TryLookupFunctions(name)
        if !overloads.IsDefaultOrEmpty {
            let usable = ImmutableArray.CreateBuilder[FunctionSymbol]()
            for candidate in overloads {
                if !IsMethodGroupCandidateUsable(candidate) {
                    continue
                }
                usable.Add(candidate)
            }
            if usable.Count == 1 {
                return TryBindSingleMethodGroup(syntax, usable[0], out methodGroup)
            }
            if usable.Count > 1 {
                methodGroup = BoundMethodGroupExpression(syntax, usable.ToImmutable())
                return true
            }
        }
        // ADR-0112: a bare name inside a user type's method body may name a
        // sibling member of the enclosing type. An instance method is captured
        // against the implicit `this`; a shared (static) method forms a
        // null-receiver group. This mirrors how the event-subscription path
        // already resolves bare `this`-instance handlers, generalized to any
        // value (delegate-conversion) context.
        // Issue #1159: `effThis` is the enclosing instance method's `this`
        // even when this bare name sits inside a lambda body, so an unqualified
        // instance method group resolves and captures `this`.
        let enclosing FunctionSymbol? = this.function
        let effThis ParameterSymbol? = GetEffectiveThisParameter()
        if effThis != nil && effThis.Type is StructSymbol thisStruct {
            let instanceMethods = TypeMemberModel.GetMethods(thisStruct, name, MemberQuery.Instance(MemberKinds.Method))
            if TryBuildUserMethodGroup(BoundVariableExpression(nil, effThis), instanceMethods, out methodGroup) {
                return true
            }
        }
        if enclosing != nil {
            let enclosingType StructSymbol? = (enclosing.ReceiverType as StructSymbol) ??
                (enclosing.StaticOwnerType as StructSymbol) ??
                (enclosing.LexicalEnclosingType as StructSymbol)
            if enclosingType != nil {
                let sharedMethods = TypeMemberModel.GetMethods(
                    enclosingType,
                    name,
                    MemberQuery.Static(MemberKinds.Method)
                )
                if TryBuildUserMethodGroup(receiver: nil, sharedMethods, out methodGroup) {
                    return true
                }
            }
        }
        if $scope.TryLookupSymbol(name) is not FunctionSymbol function {
            return false
        }
        return TryBindSingleMethodGroup(syntax, function, out methodGroup)
    }

    private func TryBindSingleMethodGroup(
        syntax NameExpressionSyntax,
        function FunctionSymbol,
        @NotNullWhen(true) out methodGroup BoundExpression?
    ) bool {
        methodGroup = nil
        if !IsMethodGroupCandidateUsable(function) {
            return false
        }
        // Issue #4219 (umbrella remainder), workstream B: a ref-returning
        // #4219 direct-call LOCAL function (LocalDeclaration != null) has no
        // tested/verified delegate-conversion support at all — unlike a
        // NAMED (package-level or member) ref-returning function, which
        // issue #4220/#4224 already exercise converting to an explicit,
        // genuinely ref-aware delegate type (e.g. an imported
        // `delegate ref readonly int Reader(ref int)` — confirmed by
        // Issue4220ReadOnlyRefInteropTests, which this guard must not
        // break). Scoped to the local-literal case only; a mismatched or
        // untyped conversion for a NAMED ref-returning function is left to
        // whatever existing diagnostic that pre-existing machinery already
        // produces.
        if function.ReturnRefKind != RefKind.None && function.LocalDeclaration != nil {
            Diagnostics.ReportRefReturningFunctionLiteralRequiresDirectLocalFunction(syntax.IdentifierToken.Location)
            return false
        }
        if function.IsGeneric {
            methodGroup = BoundMethodGroupExpression(syntax, ImmutableArray.Create(function))
            return true
        }
        let parameterTypes = ImmutableArray.CreateBuilder[TypeSymbol](function.Parameters.Length)
        for parameter in function.Parameters {
            parameterTypes.Add(parameter.Type)
        }
        let fnType = FunctionTypeSymbol.Get(
            parameterTypes.MoveToImmutable(),
            this.MethodGroupObservableReturnType(function)
        )
        methodGroup = BoundMethodGroupExpression(syntax, function, fnType)
        return true
    }

    /// Issue #530: returns the effective CLR (cref:Type) to use when
    /// matching an argument in overload resolution. Delegates to
    /// (cref:NullableTypeSymbol.GetEffectiveClrType).
    internal func GetEffectiveArgumentClrType(typeSymbol TypeSymbol) Type? {
        return NullableTypeSymbol.GetEffectiveClrType(typeSymbol)
    }

    /// Issue #658: returns a CLR (cref:Type) suitable for overload
    /// resolution even for user-defined G# class types (whose
    /// (cref:TypeSymbol.ClrType) is null at bind time). For such types
    /// the imported base type's CLR type is returned (or `typeof(object)`
    /// if none). Regular types delegate to
    /// (cref:GetEffectiveArgumentClrType).
    internal func GetEffectiveArgumentClrTypeForOverloadResolution(typeSymbol TypeSymbol) Type? {
        // Issue #4444, ADR-0186 §1 and §5a: `T!` has `T`'s signature, so a
        // platform argument rides through exactly as its underlying type does.
        // A platform type over a G#-declared class, interface or delegate
        // (value types are never wrapped) has a null ClrType, and no arm
        // below matched the wrapper, so overload resolution never ran for it.
        if typeSymbol is PlatformTypeSymbol platform {
            return GetEffectiveArgumentClrTypeForOverloadResolution(platform.UnderlyingType)
        }
        let clrType Type? = GetEffectiveArgumentClrType(typeSymbol)
        if clrType != nil {
            return clrType
        }
        // Issue #794: a generic type parameter referenced inside a generic
        // shared method (or generic top-level func / extension) has no
        // ClrType — it is type-erased to `System.Object` at the IL layer
        // (ADR-0004 / #313). Surface that erasure so overload resolution
        // against an imported instance call like `List[T]().Add(v)` picks
        // the `Add(object)` overload instead of bailing out. The bound call
        // re-projects the symbolic argument type back through the
        // receiver's `TypeArguments` for emit. `T?` (nullable wrapper of a
        // type parameter) rides through the same erasure.
        if typeSymbol is TypeParameterSymbol {
            return typeof(object)
        }
        if typeSymbol is NullableTypeSymbol && typeSymbol.UnderlyingType is TypeParameterSymbol {
            return typeof(object)
        }
        // Issue #2614: a by-ref source type with no CLR identity still rides
        // through the same erased CLR type as its pointee.
        if typeSymbol is ByRefTypeSymbol byRef {
            return GetEffectiveArgumentClrTypeForOverloadResolution(byRef.PointeeType)?.MakeByRefType()
        }
        // Issue #2838: a pointer whose pointee has no CLR identity — canonically
        // `*T` under `T : unmanaged`, produced by `fixed p *T = span` — likewise
        // rides through its pointee's erasure. Without this the pointer argument
        // yielded no effective CLR type at all, so overload resolution never ran
        // and an imported generic call over it (e.g. `Vector256.Load(p)`) dead-
        // ended with GS0159. The inferred `object` erasure is re-projected back
        // to the symbolic type argument by the same recovery step that handles
        // every other erased inference.
        if typeSymbol is PointerTypeSymbol pointer {
            let pointeeClr Type? = GetEffectiveArgumentClrTypeForOverloadResolution(pointer.PointeeType)
            if pointeeClr != nil && !pointeeClr.IsByRef {
                return pointeeClr.MakePointerType()
            }
        }
        // Issue #2182: a G# slice `[]T` whose element type has no CLR backing
        // (a generic type parameter, or another same-compilation user type)
        // has a null `ClrType`, so `GetEffectiveArgumentClrType` returned null
        // above. Its runtime backing is still a CLR array whose element rides
        // through to its erasure — a type parameter erases to `object`
        // (ADR-0004 / #313), so `[]T` rides through to `object[]`. Surface that
        // erased array type so overload / constructor resolution can rank an
        // array-base parameter (`System.Array`,
        // `System.Collections.ICollection` / `IList` / `IEnumerable`, and their
        // generic forms) as applicable — reaching parity with a concrete
        // `[]int32` argument (whose `int[]` ClrType already flows through) and
        // with the `[]T -> System.Array` conversion that `Conversion.Classify`
        // already accepts in assignment / return position. Without this the
        // argument produced no effective CLR type, so overload resolution
        // never ran and the constructor-as-call lookup dead-ended with GS0159.
        if typeSymbol is SliceTypeSymbol slice {
            let elementClr Type? = GetEffectiveArgumentClrTypeForOverloadResolution(slice.ElementType)
            if elementClr != nil && !elementClr.IsByRef && !elementClr.IsPointer {
                return elementClr.MakeArrayType()
            }
        }
        // Issue #3876: ADR-0174 D2's `chan[T]` / `in chan[T]` / `out chan[T]`
        // over an element with no CLR backing — a type parameter, or another
        // same-compilation user type — is the same hole the slice arm above
        // closes for `[]T`. `ChannelTypeSymbol.MakeClrType` returns null the
        // moment the element's `ClrType` is null, so a channel argument inside
        // a generic function produced NO effective CLR type, and every probe
        // that ranks candidates on CLR shapes abandoned resolution before
        // examining a single one: the imported-constructor probe reported
        // GS0267 with no overload having been looked at, the imported
        // instance-method probe GS0159, the `: base(...)` probe GS0214.
        // Issue #3984 / ADR-0174 errata 44: this arm does NOT in fact reach the
        // `: base(...)` probe — that probe was handed the OTHER projection
        // entirely, so it never called this method. Fixed separately.
        // The erasure itself is not restated here — `TryProjectErasedClrType` is
        // the one place that knows a channel erases to
        // `Channel<…>`/`ChannelReader<…>`/`ChannelWriter<…>`, which is exactly
        // why the ONE probe that already consulted it (the imported
        // extension/static path, since issue #833) bound `Chunks.Of[T](ch, n)`
        // while the `ChunkReader[T](ch, n)` constructor beside it did not.
        // Direction is carried through, so each spelling stays applicable to
        // its own BCL type and to nothing else: the lattice's decisions are
        // made downstream by `Conversion`, not widened here.
        if (
            typeSymbol is ChannelTypeSymbol ||
                typeSymbol is NullableTypeSymbol &&
                typeSymbol.UnderlyingType is ChannelTypeSymbol
        ) &&
            MemberLookup.TryProjectErasedClrType(typeSymbol, out var erasedChannel) {
            return erasedChannel!!
        }
        // Issue #4012: the FIXED-LENGTH array `[N]T` is the one G#-native array
        // shape this method never had an arm for. The `[]T` arm above (#2182)
        // and the `[N,M]T` arm below both ride their element through to its
        // erasure; `[N]T` did not, so a `[3]Foo` argument over a
        // same-compilation `Foo` (or an open `T`) produced NO effective CLR
        // type at all, the caller bailed with `return false` BEFORE overload
        // resolution ran, and `List[[3]Foo]().Add([3]Foo{…})` dead-ended with
        // GS0159 "Cannot find function Add" — while the very same call with a
        // `[]Foo` argument, or with a `[3]int32` whose `ClrType` is a real
        // `int32[]`, bound fine. That is the "needs BOTH a symbolic element
        // and the fixed-array shape" signature the issue reports, and this is
        // the whole of it: the length is not consulted here at all.
        //
        // `[N]T` and `[]T` share ONE runtime backing (the SZ-array `T[]`, see
        // #3962), so the erased ride-through is byte-identical to the slice
        // arm's. The declared length survives only in the symbol, and it is
        // still enforced downstream where the target slot is a G#-native
        // `[N]T` — at applicability by `Conversion`, and at a projected
        // generic member slot by
        // `ConversionClassifier.TrySubstituteParameterTypeFromReceiver`.
        if typeSymbol is ArrayTypeSymbol fixedLengthArray {
            let elementClr Type? = GetEffectiveArgumentClrTypeForOverloadResolution(fixedLengthArray.ElementType)
            if elementClr != nil && !elementClr.IsByRef && !elementClr.IsPointer {
                return elementClr.MakeArrayType()
            }
        }
        if typeSymbol is RectangularArrayTypeSymbol rectangular {
            let elementClr Type? = GetEffectiveArgumentClrTypeForOverloadResolution(rectangular.ElementType)
            if elementClr != nil && !elementClr.IsByRef && !elementClr.IsPointer {
                return elementClr.MakeArrayType(rectangular.Rank)
            }
        }
        // Issue #3303: a `map[K, V]` whose key or value has no CLR backing (a
        // generic type parameter or a same-compilation user type) has a null
        // `ClrType`, so `GetEffectiveArgumentClrType` returned null above. Its
        // runtime backing is still a `Dictionary<,>` reference whose key/value
        // ride through to their erasure (type parameter / user type →
        // `object`, enum → `int`), exactly like the slice arm above — so
        // surface the erased closed `Dictionary<…>` shape. Without this the
        // argument produced no effective CLR type at all, overload resolution
        // never ran, and `Console.WriteLine(items)` on a generic class's
        // `map[K, V]` field dead-ended with GS0159 while the monomorphic
        // equivalent bound fine. The emitter needs no adjustment: the
        // `map → object`-shaped parameter slots this unlocks are no-op
        // reference conversions (MethodBodyEmitter.IsReferenceCompatible).
        if typeSymbol is MapTypeSymbol openMapArg {
            let keyClr Type? = GetEffectiveArgumentClrTypeForOverloadResolution(openMapArg.KeyType)
            let valueClr Type? = GetEffectiveArgumentClrTypeForOverloadResolution(openMapArg.ValueType)
            if keyClr != nil &&
                valueClr != nil &&
                !keyClr.IsByRef &&
                !keyClr.IsPointer &&
                !valueClr.IsByRef &&
                !valueClr.IsPointer {
                return typeof(System.Collections.Generic.Dictionary[_, _]).MakeGenericType(keyClr, valueClr)
            }
        }
        // Issue #2142: a nullable user reference type (`UserClass?`) erases to
        // the same CLR ride-through as its non-nullable form — nullability is an
        // annotation only for reference types, so overload resolution (and the
        // erased-delegate build used for a lambda whose return is `UserClass?`,
        // e.g. `(e Book) -> e.Conversion` where `Conversion` is a
        // same-compilation class) must not bail out. Without this, a lambda
        // argument returning `UserClass?` produced no effective CLR type, so the
        // whole call failed overload resolution with GS0159 (e.g. EF Core's
        // `EntityTypeBuilder<Book>.HasOne((e) -> e.Conversion)` where the
        // navigation property is nullable).
        if typeSymbol is NullableTypeSymbol{UnderlyingType: StructSymbol{IsClass: true} nullableUserClass} {
            return TypeMemberModel.GetNearestImportedBase(nullableUserClass)?.ClrType ?? typeof(object)
        }
        // A nullable user value struct / interface / named delegate rides
        // through the same `object` boundary as its non-nullable form.
        if typeSymbol is NullableTypeSymbol &&
            typeSymbol.UnderlyingType is StructSymbol ||
            typeSymbol is NullableTypeSymbol &&
            typeSymbol.UnderlyingType is InterfaceSymbol ||
            typeSymbol is NullableTypeSymbol &&
            typeSymbol.UnderlyingType is DelegateTypeSymbol {
            return typeof(object)
        }
        // User-defined G# class: provide the imported base type's CLR type
        // so that overload resolution can proceed (base-class assignability
        // and the supplementary interface check handle the rest).
        if typeSymbol is StructSymbol{IsClass: true} ss {
            // Issue #3745: the implemented imported INTERFACES a user class
            // carries are deliberately NOT surfaced here. The `object`
            // ride-through is what makes an erased type-parameter parameter
            // (`Do(ctx T, …)` on an imported `Jobb[T]`) applicable, so
            // projecting an interface unconditionally breaks calls that bind
            // today (#2840). The projection is applied only on the FAILURE path
            // — see TryProjectUserClassArgumentInterfaces.
            return TypeMemberModel.GetNearestImportedBase(ss)?.ClrType ?? typeof(object)
        }
        // ADR-0087 §3 R5 / issue #765: a user-defined G# data struct (value
        // type) appearing as an argument to an imported CLR generic method —
        // typically `List[Box[int32]]::Add(object)` — needs an effective CLR
        // type for overload resolution. The closed CLR shape was erased to
        // `object` upstream, so `object` is the correct ride-through. The
        // emitter materialises the right TypeSpec parent for the call.
        if typeSymbol is StructSymbol {
            return typeof(object)
        }
        // ADR-0087 §3 R5: a user-defined G# interface or named delegate
        // argument rides through the same `object` boundary as a struct.
        if typeSymbol is InterfaceSymbol || typeSymbol is DelegateTypeSymbol {
            return typeof(object)
        }
        // Issue #661: user-defined G# enum — backed by int32 at the CLR level.
        if typeSymbol is EnumSymbol {
            return typeof(int32)
        }
        // Issue #661: Nullable<UserEnum> — the underlying enum has no ClrType,
        // so GetEffectiveClrType returns null. Map to Nullable<int>.
        if typeSymbol is NullableTypeSymbol && typeSymbol.UnderlyingType is EnumSymbol {
            return typeof(int32?)
        }
        if (
            typeSymbol is TupleTypeSymbol ||
                typeSymbol is NullableTypeSymbol &&
                typeSymbol.UnderlyingType is TupleTypeSymbol
        ) &&
            MemberLookup
            .TryProjectErasedClrType(typeSymbol, out var erasedTuple) {
            // Issue #3087: imported instance-method applicability still needs
            // the full erased ValueTuple shape when an element is symbolic.
            return erasedTuple!!
        }
        // Issue #903: a delegate-typed argument (an untyped/typed arrow lambda,
        // a func literal, or a named delegate value) whose parameter or return
        // type is a same-compilation user type has no CLR backing —
        // FunctionTypeSymbol.ClrType is null because the user type is still
        // being compiled, so GetEffectiveArgumentClrType returned null above.
        // Without an effective CLR type the whole call (e.g.
        // `List[Check].Single((c Check) -> c.Id == "x")`) fails overload
        // resolution and reports GS0159. Erase the inner same-compilation types
        // to their CLR ride-through (struct/class/interface/delegate → object,
        // enum → int, type parameter → object) and rebuild a closed
        // System.Func<>/System.Action<> shape so overload resolution can match
        // a generic delegate parameter such as Func<TSource,bool>. The real
        // element type is recovered downstream via the symbolic return-type and
        // deferred-lambda machinery (MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs).
        let functionType FunctionTypeSymbol? = typeSymbol as FunctionTypeSymbol ??
            (typeSymbol as NullableTypeSymbol)?.UnderlyingType as FunctionTypeSymbol
        if functionType != nil && TryBuildErasedDelegateClrType(functionType, out var erasedDelegate) {
            return erasedDelegate!!
        }
        return nil
    }

    /// Whether [`name`](paramref) is the contextual keyword `base`:
    /// spelled `base`, with nothing else of that name in scope. A local,
    /// parameter, field, function, source type or imported type named
    /// `base` keeps its ordinary meaning (`base.count` on a class
    /// named `base` is a static field read).
    /// @param name The receiver name.
    /// @returns `true` when the name means the base class.
    private func IsContextualBaseKeyword(name NameExpressionSyntax) bool {
        const BaseText = "base"
        if !string.Equals(name.IdentifierToken.ValueText, BaseText, StringComparison.Ordinal) || $scope.TryLookupSymbol(
            BaseText
        ) != nil {
            return false
        }
        return !binderCtx.TryLookupSourceType($scope, BaseText, preferredArity: 0, function, out _, out _) &&
            !$scope.TryLookupImportedClass(BaseText, declaration: nil, out _)
    }

    /// The CLR base type whose `protected` static members the current
    /// binding site may reach: the imported base of the enclosing source
    /// class, or of a class that lexically contains it. Function literals use
    /// the member they are nested in. `null` when no enclosing
    /// class derives from an imported type.
    /// @returns The imported CLR base, or `null`.
    internal func GetFamilyAccessBase() Type? {
        let current = function
        let enclosing TypeSymbol? = current?.ReceiverType ??
            current?.StaticOwnerType ??
            current?.LexicalEnclosingType ??
            GetEffectiveThisParameter()?.Type
        for var type TypeSymbol? = enclosing; type != nil; type = type!!.ContainingType {
            if type is StructSymbol{IsClass: true} classSymbol && GetInheritedClrBaseType(classSymbol) is {} clrBase {
                return clrBase
            }
        }
        return nil
    }

    /// Gives an imported class symbol used as a static-member receiver the
    /// family access of the current binding site (see
    /// (cref:GetFamilyAccessBase)), so a derived class can call an
    /// inherited `protected` static member by its type name.
    /// @param classSymbol The imported class receiver.
    /// @returns The receiver, carrying the site's family-access base.
    internal func WithFamilyAccess(
        classSymbol ImportedClassSymbol
    ) ImportedClassSymbol -> classSymbol.WithFamilyAccessBase(GetFamilyAccessBase())

    /// Requires a callable getter for a static property read through an
    /// imported class receiver: public, a friend assembly's internal, or
    /// protected when the receiver carries family access to the declaring
    /// type. Reports the member as inaccessible otherwise.
    /// @param classSymbol The imported class receiver.
    /// @param property The static property being read.
    /// @param location Where to report.
    /// @returns `true` when the getter may be called.
    private func TryRequireVisibleStaticGetter(
        classSymbol ImportedClassSymbol,
        property PropertyInfo,
        location TextLocation
    ) bool {
        if GetVisibleGetter(property, fromDerivedType: classSymbol.IsFamilyAccessible(property.DeclaringType)) != nil {
            return true
        }
        Diagnostics.ReportMemberInaccessible(
            location,
            property.Name,
            property.DeclaringType?.Name ?? classSymbol.ClassType.Name,
            AccessorAccessibility(property.GetMethod)
        )
        return false
    }

    /// Issue #1582: tries to bind a bare (unqualified) identifier inside an
    /// instance method to an inherited CLR instance property/field of the
    /// enclosing G# class's metadata base. The bound node reads through the
    /// effective `this` receiver, so it behaves identically to the
    /// `this.`-qualified access resolved in
    /// `ExpressionBinder.Access.cs`. Runs only after the name failed to
    /// resolve as a local/parameter/implicit member or a method group.
    /// @param name The bare identifier text.
    /// @param bound The bound member access on success.
    /// @returns `true` when an inherited CLR member was bound.
    private func TryBindInheritedClrInstanceMemberByBareName(
        name string,
        @NotNullWhen(true) out bound BoundExpression?
    ) bool {
        bound = nil
        if !TryResolveInheritedClrInstanceMemberByBareName(name, out var receiver, out var member) {
            return false
        }
        switch member {
            case clrProp is PropertyInfo when GetVisibleGetter(clrProp, fromDerivedType: true) != nil {
                bound = BoundClrPropertyAccessExpression(
                    nil,
                    receiver,
                    clrProp,
                    GetInheritedClrMemberType(receiver!!.Type, clrProp)
                )
                return true
            }
            case clrFld is FieldInfo {
                bound = BoundClrPropertyAccessExpression(
                    nil,
                    receiver,
                    clrFld,
                    GetInheritedClrMemberType(receiver!!.Type, clrFld)
                )
                return true
            }
            default {
                return false
            }
        }
    }

    /// Issue #3840: resolves a bare (unqualified) identifier inside a DEFAULT
    /// INTERFACE METHOD body to an instance property of the enclosing interface
    /// (or any base interface), returning the effective `this` receiver and
    /// the interface it is typed as. The implicit-member pseudo-variables seeded
    /// in (cref:Binder) only cover a (cref:StructSymbol) receiver,
    /// so inside a DIM the same spelling that works in a class body reported
    /// GS0125 — even though `this.Name` binds and dispatches correctly.
    /// Shared by the bare-name READ, WRITE and COMPOUND-WRITE fallbacks so all
    /// three behave identically to their `this.`-qualified paths, mirroring
    /// the inherited-CLR-member trio of issue #1584.
    /// @param name The bare identifier text.
    /// @param receiver The effective `this` receiver on success.
    /// @param interfaceType The enclosing interface the receiver is typed as, on success.
    /// @returns `true` when the enclosing interface declares or inherits an instance property of that name.
    private func TryResolveInterfaceInstancePropertyByBareName(
        name string,
        @NotNullWhen(true) out receiver BoundExpression?,
        @NotNullWhen(true) out interfaceType InterfaceSymbol?
    ) bool {
        receiver = nil
        interfaceType = nil
        let effThis = GetEffectiveThisParameter()
        if effThis?.Type is not InterfaceSymbol thisInterface {
            return false
        }
        // ADR-0118 / issue #944: an indexer has the CLR name `Item` but is never
        // reachable by bare name — only through `this[i]`.
        if (!TypeMemberModel.TryGetProperty(thisInterface, name, out var property, out _) || property!!.IsIndexer) &&
            MemberLookup.GetInterfaceImportedBaseInstanceProperty(thisInterface, name) == nil {
            return false
        }
        receiver = BoundVariableExpression(nil, effThis!!)
        interfaceType = thisInterface
        return true
    }

    /// Issue #3840: tries to bind a bare identifier inside a default interface
    /// method body as a read of the enclosing interface's own instance property,
    /// by routing it through the very same accessor step that binds
    /// `this.Name` — so accessibility, generic substitution and the
    /// `callvirt get_X` dispatch are resolved once, in one place.
    /// @param syntax The bare name syntax.
    /// @param bound The bound property read on success.
    /// @returns `true` when the name resolved to an interface property.
    private func TryBindInterfaceInstancePropertyByBareName(
        syntax NameExpressionSyntax,
        @NotNullWhen(true) out bound BoundExpression?
    ) bool {
        bound = nil
        if !TryResolveInterfaceInstancePropertyByBareName(syntax.IdentifierToken.ValueText, out var receiver, out _) {
            return false
        }
        bound = BindAccessorStep(receiver, classSymbol: nil, rightPart: syntax)
        if bound is {} selected && selected is not BoundErrorExpression {
            selected.AnchorSyntax(syntax)
        }
        return true
    }

    /// Issue #1584: resolves a bare (unqualified) identifier inside an instance
    /// method to an inherited CLR instance property/field of the enclosing G#
    /// class's metadata base, returning the effective `this` receiver and
    /// the resolved (cref:MemberInfo). Shared by the bare-name READ
    /// fallback ((cref:TryBindInheritedClrInstanceMemberByBareName)) and
    /// the bare-name WRITE / COMPOUND-WRITE fallbacks in
    /// `ExpressionBinder.Assignments.cs` so all three behave identically to
    /// the `this.`-qualified paths. A property is preferred over a field of
    /// the same name (mirroring the qualified member-lookup order).
    /// @param name The bare identifier text.
    /// @param receiver The effective `this` receiver on success.
    /// @param member The resolved inherited CLR member on success.
    /// @returns `true` when an inherited CLR member was resolved.
    private func TryResolveInheritedClrInstanceMemberByBareName(
        name string,
        @NotNullWhen(true) out receiver BoundExpression?,
        @NotNullWhen(true) out member MemberInfo?
    ) bool {
        receiver = nil
        member = nil
        let effThis = GetEffectiveThisParameter()
        if effThis?.Type is not StructSymbol thisStruct {
            return false
        }
        if GetInheritedClrBaseType(thisStruct) is not Type clrBase {
            return false
        }
        member = ClrTypeUtilities.SafeGetInheritedInstanceProperty(clrBase, name, CanAccessInternalsOf)
        member ??= ClrTypeUtilities.SafeGetInheritedInstanceField(clrBase, name, CanAccessInternalsOf)
        if member == nil {
            return false
        }
        receiver = BoundVariableExpression(nil, effThis!!)
        return true
    }

    /// Issue #1584: tries to bind a bare (unqualified) simple write
    /// `member = value` inside an instance method to an inherited CLR
    /// instance property/field of the enclosing G# class's metadata base,
    /// producing a (cref:BoundClrPropertyAssignmentExpression) through the
    /// effective `this` receiver — identical to the `this.member =
    /// value` qualified path in (cref:BindMemberFieldAssignmentExpression).
    /// A resolved-but-unsettable member (get-only property / readonly field)
    /// reports `cannot assign` rather than GS0125, matching the qualified
    /// path. Runs only after the bare name failed to resolve as a
    /// local/parameter/implicit member.
    /// @param name The bare identifier text.
    /// @param valueSyntax The RHS value syntax.
    /// @param assignLocation The location of the assignment operator, for diagnostics.
    /// @param bound The bound assignment (or an error expression) on success.
    /// @returns `true` when an inherited CLR member was resolved.
    private func TryBindInheritedClrInstanceMemberWriteByBareName(
        name string,
        valueSyntax ExpressionSyntax,
        assignLocation TextLocation,
        @NotNullWhen(true) out bound BoundExpression?
    ) bool {
        bound = nil
        if !TryResolveInheritedClrInstanceMemberByBareName(name, out var receiver, out var member) {
            return false
        }
        // Issue #3815: the WRITE must see the same symbolically-projected member
        // type the READ path already builds through GetInheritedClrMemberType —
        // inside `class Wrap[T] : Channel[T]`, the inherited `Reader` is
        // `ChannelReader[T]`, not the erased `ChannelReader[object]`. Passing the
        // receiver (the derived class) routes the projection through the nearest
        // imported base; see MemberLookup.GetProjectionReceiverImportedType.
        if !TryGetWritableClrMember(
            member,
            receiver!!.Type,
            out _,
            out var targetSymbol,
            out _,
            fromDerivedType: true
        ) {
            Diagnostics.ReportCannotAssign(assignLocation, name)
            let _ = BindExpression(valueSyntax)
            bound = BoundErrorExpression(nil)
            return true
        }
        let value = BindAssignmentRhs(valueSyntax, targetSymbol)
        let converted = conversions.BindConversion(valueSyntax.Location, value, targetSymbol)
        bound = BoundClrPropertyAssignmentExpression(
            nil,
            receiver,
            member!!,
            converted,
            targetSymbol!!,
            staticContainerType: nil
        )
        return true
    }

    /// Issue #903: builds a closed `System.Func<…>`/`System.Action<…>`
    /// CLR type for a (cref:FunctionTypeSymbol) whose own
    /// (cref:TypeSymbol.ClrType) is null because one of its parameter or
    /// return types is a same-compilation user type (still being compiled).
    /// Each inner type is erased through
    /// (cref:GetEffectiveArgumentClrTypeForOverloadResolution) (so a
    /// same-compilation struct/class becomes `object`, an enum becomes
    /// `int`, etc.) and the closed delegate shape is reconstructed via
    /// (cref:FunctionTypeSymbol.Get(System.Collections.Immutable.ImmutableArray{TypeSymbol}, TypeSymbol)),
    /// reusing its existing CLR delegate construction. Returns
    /// `false` when any inner type cannot be erased or the
    /// arity has no shipped delegate shape (>16 args).
    private func TryBuildErasedDelegateClrType(
        functionType FunctionTypeSymbol,
        @NotNullWhen(true) out erased Type?
    ) bool {
        erased = nil
        // A variadic function type has no straightforward closed delegate
        // erasure; leave it to the existing fallbacks.
        if functionType.HasVariadic {
            return false
        }
        let erasedParameters = ImmutableArray.CreateBuilder[TypeSymbol](functionType.ParameterTypes.Length)
        for parameterType in functionType.ParameterTypes {
            let parameterClr Type? = EraseDelegateInnerClrTypeForOverloadResolution(parameterType)
            if parameterClr == nil {
                return false
            }
            erasedParameters.Add(
                TypeSymbol.FromClrTypeWithoutNullability(parameterClr, NullabilityFreeReason.CompilerProduced)
            )
        }
        var erasedReturn TypeSymbol
        if FunctionTypeSymbol.IsVoidReturn(functionType.ReturnType) || functionType.ReturnType == TypeSymbol.Never {
            // Issue #3646: a throw-expression lambda's natural return is the
            // bottom (`never`) type, which has no CLR erasure. It satisfies
            // every result slot (issue #2716), so erase it like `void` — the
            // Action<...> shape — for applicability; the winning candidate's
            // conversion re-shapes the literal to the real delegate target
            // (ConversionClassifier's never-candidate arm). Without this the
            // lambda produced no effective CLR type at all, so an imported
            // generic call taking a delegate (e.g. Roslyn's
            // `RegisterSourceOutput(provider, (spc, x) -> throw ...)`) never
            // ran overload resolution and dead-ended with GS0159.
            erasedReturn = TypeSymbol.Void
        } else {
            let returnClr Type? = EraseDelegateInnerClrTypeForOverloadResolution(functionType.ReturnType)
            if returnClr == nil {
                return false
            }
            erasedReturn = TypeSymbol.FromClrTypeWithoutNullability(returnClr, NullabilityFreeReason.CompilerProduced)
        }
        erased = FunctionTypeSymbol.Get(erasedParameters.ToImmutable(), erasedReturn).ClrType
        return erased != nil
    }

    /// Issue #1502: erases an inner parameter/return type of a delegate shape
    /// for overload resolution. Same-compilation user value types (a G# enum or
    /// `UserEnum?`) have no (cref:TypeSymbol.ClrType). By default
    /// they ride through as their scalar CLR backing (`int`/`int?`,
    /// issue #661) so that LINQ/extension generic-method inference unifies the
    /// lambda parameter with an `IEnumerable<int>` source. When the
    /// delegate is instead a constructor argument of a constructed-generic type
    /// (e.g. `Lazy[Color]` closes to `Lazy<object>` whose ctor
    /// wants `Func<object>`), value types are not covariant so
    /// `Func<int>` would mis-resolve; in that context the caller sets
    /// (cref:eraseDelegateInnerEnumToObject) so the enum erases to
    /// `object` instead. The real type is recovered downstream via the
    /// symbolic delegate-target binding and symbolic ctor emit.
    private func EraseDelegateInnerClrTypeForOverloadResolution(typeSymbol TypeSymbol) Type? {
        if eraseDelegateInnerEnumToObject &&
            typeSymbol.ClrType == nil &&
            (typeSymbol is EnumSymbol || typeSymbol is NullableTypeSymbol && typeSymbol.UnderlyingType is EnumSymbol) {
            return typeof(object)
        }
        return GetEffectiveArgumentClrTypeForOverloadResolution(typeSymbol)
    }

    private func TryBindClrMethodGroup(
        receiver BoundExpression,
        declaringType Type?,
        wantStatic bool,
        name string,
        @NotNullWhen(true) out methodGroup BoundExpression?
    ) bool {
        methodGroup = nil
        if declaringType == nil {
            return false
        }
        let flags = BindingFlags.Public | (
            if wantStatic {
                BindingFlags.Static
            } else {
                BindingFlags.Instance
            }
        )
        let candidates = ImmutableArray.CreateBuilder[MethodInfo]()
        // Issue #529: use interface-aware method enumeration so that
        // methods declared on a base interface are included in the
        // method group for delegate conversions / member access.
        for method in ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(declaringType, flags) {
            if !ClrTypeUtilities.EmittedMemberNameMatches(method, name) {
                continue
            }
            // Open generic methods and special-name accessors (property/event
            // get_/set_/add_/remove_) are not directly convertible method-group
            // members.
            if method.IsGenericMethodDefinition || method.IsSpecialName {
                continue
            }
            candidates.Add(method)
        }
        if candidates.Count == 0 {
            return false
        }
        methodGroup = BoundClrMethodGroupExpression(nil, receiver, declaringType, name, candidates.ToImmutable())
        return true
    }

    private func BindIsExpression(syntax IsExpressionSyntax) BoundExpression {
        var expression = BindExpression(syntax.Expression)
        var pattern = patterns.BindPattern(syntax.Pattern, expression.Type, allowBindings: false, preferTypeNames: true)
        if NativeProtocolOperations.GetProtocol(expression.Type) is {} sourceProtocol {
            let inspector = NativeProtocolPatternInspector(binderCtx.RootScope, sourceProtocol, syntax.Location)
            inspector.VisitPattern(pattern)
            if inspector.HasConcreteTests && (inspector.HasProtocolTests || inspector.HasCaptures) {
                Diagnostics.ReportNativeProtocol(
                    syntax.Location,
                    "mixed capability/capture and concrete compound patterns require an explicit intermediate view"
                )
                return BoundErrorExpression(syntax)
            }
            expression = NativeProtocolOperations.PrepareInput(
                binderCtx.RootScope,
                expression,
                recoverPayload: !inspector.HasProtocolTests && !inspector.HasCaptures
            )
        } else {
            let inspector = NativeProtocolPatternInspector(binderCtx.RootScope, nil, syntax.Location)
            inspector.VisitPattern(pattern)
            if inspector.HasProtocolTests {
                if inspector.HasConcreteTests || inspector.Targets.Count != 1 {
                    Diagnostics.ReportNativeProtocol(
                        syntax.Location,
                        "compound concrete capability probes require an explicit intermediate protocol value"
                    )
                    return BoundErrorExpression(syntax)
                }
                expression = bindNativeProtocolProbe(syntax.Location, expression, inspector.Targets.Single())
                pattern = patterns.BindPattern(
                    syntax.Pattern,
                    expression.Type,
                    allowBindings: false,
                    preferTypeNames: true
                )
            }
        }
        let result = BoundIsExpression(syntax, expression, pattern)
        // ADR-0166: designations are declared by the consumer of the
        // condition (see PatternVariables); here only record the names so a
        // read outside their region reports GS0532, and reject a name bound
        // twice by the same pattern (`{ A: T t, B: U t }`).
        let bindings = PatternVariables.CollectBindings(pattern)
        if !bindings.IsDefaultOrEmpty {
            let seen = HashSet[string](StringComparer.Ordinal)
            for variable in bindings {
                binderCtx.PatternVariableNames.Add(variable.Name)
                if !seen.Add(variable.Name) && variable.DeclaringSyntax is SyntaxNode declaring {
                    Diagnostics.ReportSymbolAlreadyDeclared(declaring.Location, variable.Name)
                }
            }
        }
        return result
    }

    /// ADR-0166: reports every variable in [`added`](paramref) whose name
    /// already occurs in [`existing`](paramref) — the C# CS0128 rule for
    /// a pattern variable that would be definitely assigned twice on the same
    /// path (`a is T t && b is U t`). Duplicates inside a single
    /// operand were reported when that operand was bound.
    private func ReportDuplicatePatternVariables(
        added ImmutableArray[LocalVariableSymbol],
        existing ImmutableArray[LocalVariableSymbol]
    ) {
        if added.IsDefaultOrEmpty || existing.IsDefaultOrEmpty {
            return
        }
        let seen = HashSet[string](StringComparer.Ordinal)
        for variable in existing {
            seen.Add(variable.Name)
        }
        for variable in added {
            if seen.Contains(variable.Name) && variable.DeclaringSyntax is SyntaxNode declaring {
                Diagnostics.ReportSymbolAlreadyDeclared(declaring.Location, variable.Name)
            }
        }
    }

    /// ADR-0166: binds [`bind`](paramref) with [`variables`](paramref)
    /// declared in a fresh child scope — the region in which those pattern
    /// variables are definitely assigned.
    private func BindWithPatternVariables(
        variables ImmutableArray[LocalVariableSymbol],
        bind() -> BoundExpression
    ) BoundExpression -> PatternVariables.BindInScope(binderCtx, variables, bind)

    private func BindAsExpression(syntax AsExpressionSyntax) BoundExpression {
        var expression = BindExpression(syntax.Expression)
        let targetType TypeSymbol? = bindTypeClause(syntax.TypeClause)
        if targetType == nil || targetType == TypeSymbol.Error {
            return BoundErrorExpression(nil)
        }
        // Per C# §11.11.10: the `as` operator requires that the target type be
        // either a reference type or a nullable value type. A non-nullable value
        // type target is illegal because `as` must be able to yield null on failure.
        if !(targetType is NullableTypeSymbol) && IsNonNullableValueType(targetType) {
            Diagnostics.ReportAsRequiresReferenceOrNullableType(syntax.Location, targetType.Name)
            return BoundErrorExpression(nil)
        }
        if NativeProtocolOperations.GetProtocol(expression.Type) is {} sourceProtocol {
            if NativeProtocolOperations.GetProtocol(targetType) is {} targetProtocol {
                NativeProtocolOperations.RequireCoverage(
                    binderCtx.RootScope,
                    sourceProtocol,
                    targetProtocol,
                    syntax.Location
                )
            } else {
                NativeProtocolOperations.RequirePayloadRecovery(
                    binderCtx.RootScope,
                    sourceProtocol,
                    targetType,
                    syntax.Location
                )
            }
            expression = NativeProtocolOperations.PrepareInput(
                binderCtx.RootScope,
                expression,
                recoverPayload: NativeProtocolOperations.GetProtocol(targetType) == nil
            )
        } else if NativeProtocolOperations.GetProtocol(targetType) is {} targetProtocol {
            expression = bindNativeProtocolProbe(syntax.Location, expression, targetProtocol)
        }
        // Issue #3349: `as` is a TESTING conversion — it yields nil when the test
        // fails, which is the entire reason the check above rejects a non-nullable
        // value-type target. Its result type must therefore be nullable too:
        // `x as T` is `T?`, not `T`. Typing it `T` let `let s string = o as string`
        // bind, silently handing a possibly-nil value to a non-nullable local, and
        // it forced `if let`/`guard let` to reject the idiomatic
        // `if let s = x as T` with GS0296 (the RHS looked non-nullable, so the
        // binding had "nothing to strip"). An explicitly nullable target (`as T?`)
        // is already nullable and is left alone rather than double-wrapped.
        let resultType = if targetType is NullableTypeSymbol {
            targetType
        } else {
            cast[TypeSymbol](NullableTypeSymbol.Get(targetType))
        }
        return BoundAsExpression(syntax, expression, resultType)
    }

    shared {
        /// Issue #1547: builds a smart-cast-narrowed read from a bare (declared-type)
        /// read and its narrowed static type.
        ///
        /// For a nullable <em>value</em> type (e.g. `int32?` =
        /// `System.Nullable<int32>`) narrowed to its underlying type, the
        /// storage slot/field holds a `Nullable<T>` while the narrowed
        /// static type is the bare `T`. A plain narrowed load would leave a
        /// `Nullable<T>` on the stack where `T` is expected, which
        /// fails ilverify. Instead we wrap the bare read in a synthesized `!!`
        /// ((cref:BoundUnaryOperatorKind.NullAssertion)), reusing the proven
        /// value-type unwrap emit path (spill → `Nullable<T>::get_Value`).
        /// The nil-guard already proved the value non-nil, so the assertion can never
        /// throw at runtime.
        ///
        /// For a nullable <em>reference</em> type the narrowed type and its storage
        /// share the CLR representation, so narrowing is a metadata no-op and the
        /// bare narrowed read is produced unchanged (wrapping in `!!` would add a
        /// pointless runtime null-check).
        /// @param bareRead A read of the declared (un-narrowed) type.
        /// @param declaredType The variable/member's declared type.
        /// @param narrowedType The narrowed static type, or `null`.
        /// @param makeNarrowedNode Factory building the narrowed read node for
        /// the reference-nullable (metadata no-op) case.
        /// @returns The narrowed read (possibly a value-type unwrap).
        /// @remarks Issue #4943: this is the single place that builds a
        /// narrowed read. Call binding (`OverloadResolver.BuildCalleeLoad`)
        /// uses it too, because a narrowed `(unmanaged[CC] () -> R)?` callee
        /// is a value-type `Nullable<nint>` whose storage must be unwrapped
        /// before `calli`; the emitter rejects a narrowed node that skips it.
        internal func BuildNarrowedRead(
            bareRead BoundExpression,
            declaredType TypeSymbol,
            narrowedType TypeSymbol?,
            makeNarrowedNode(TypeSymbol) -> BoundExpression
        ) BoundExpression {
            if narrowedType == nil {
                return bareRead
            }
            // A value-type `Nullable<T>` narrowed to its (value-type) underlying `T`
            // needs the storage `Nullable<T>` unwrapped on load. Reference-type
            // nullables narrow to a reference underlying and share the CLR shape, so
            // they fall through to the bare narrowed read.
            //
            // Issue #1572: a user-declared value-type underlying (value-kind struct
            // or enum) diverges from its `Nullable<T>` storage exactly like a
            // primitive value-type nullable, but has a null ClrType so
            // `IsValueTypeNullable` misses it — include the symbol-aware predicate so
            // the narrowed read is wrapped in the `!!` unwrap.
            if declaredType is NullableTypeSymbol nullable &&
                (NullableLifting.IsValueTypeNullable(nullable) || NullableLifting.IsUserValueTypeNullable(nullable)) &&
                !(narrowedType is NullableTypeSymbol) {
                // Bind's first arm unconditionally returns non-null for
                // BangBangToken (BoundUnaryOperator.cs), regardless of operandType.
                let op = BoundUnaryOperator.Bind(SyntaxKind.BangBangToken, declaredType)!!
                let read = BoundUnaryExpression(nil, op, bareRead){IsNarrowingUnwrap = true}
                read.AnchorSyntax(bareRead.Syntax)
                return read
            }
            let read = makeNarrowedNode(narrowedType)
            read.AnchorSyntax(bareRead.Syntax)
            return read
        }

        private func ClassifyTypeTestNarrowing(condition BoundExpression)(
            Then Dictionary[AccessPath, TypeSymbol]?,
            Else Dictionary[AccessPath, TypeSymbol]?
        ) {
            switch condition {
                case isExpr is BoundIsExpression {
                    {
                        if isExpr.Pattern is BoundNotPattern notPattern {
                            return (
                                nil,
                                StatementBinder.TryClassifyPatternNarrowing(
                                    isExpr.Expression,
                                    notPattern.Pattern,
                                    allowReadOnlyGlobals: false
                                )
                            )
                        }
                        return (
                            StatementBinder.TryClassifyPatternNarrowing(
                                isExpr.Expression,
                                isExpr.Pattern,
                                allowReadOnlyGlobals: false
                            ),
                            nil
                        )
                    }
                }
                case unary is BoundUnaryExpression when unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation {
                    {
                        let (inThen, inElse) = ClassifyTypeTestNarrowing(unary.Operand)
                        return (inElse, inThen)
                    }
                }
                case binary is BoundBinaryExpression when binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd {
                    {
                        let (leftThen, _) = ClassifyTypeTestNarrowing(binary.Left)
                        let (rightThen, _) = ClassifyTypeTestNarrowing(binary.Right)
                        if (leftThen == nil || leftThen.Count == 0) && (rightThen == nil || rightThen.Count == 0) {
                            return (nil, nil)
                        }
                        let combined = if leftThen == nil {
                            Dictionary[AccessPath, TypeSymbol]()
                        } else {
                            Dictionary[AccessPath, TypeSymbol](leftThen)
                        }
                        if rightThen != nil {
                            for kv in rightThen {
                                combined[kv.Key] = kv.Value
                            }
                        }
                        return (combined, nil)
                    }
                }
                case binary is BoundBinaryExpression when binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr {
                    {
                        // ADR-0069 addendum / issue #712: De Morgan dual of `&&`.
                        // For `A || B`: then = intersection of thenL and thenR
                        // (a narrowing only survives the OR if both operands prove it);
                        // else = elseL ∪ elseR (both operands were false → both
                        // negations apply). This is the expression-level mirror
                        // of the if-condition classifier in StatementBinder.
                        let (leftThen, leftElse) = ClassifyTypeTestNarrowing(binary.Left)
                        let (rightThen, rightElse) = ClassifyTypeTestNarrowing(binary.Right)
                        var combinedThen Dictionary[AccessPath, TypeSymbol]? = nil
                        if leftThen != nil && leftThen.Count > 0 && rightThen != nil && rightThen.Count > 0 {
                            for kv in leftThen {
                                if rightThen.TryGetValue(kv.Key, out var other) && other == kv.Value {
                                    combinedThen ??= Dictionary[AccessPath, TypeSymbol]()
                                    combinedThen!![kv.Key] = kv.Value
                                }
                            }
                        }
                        var combinedElse Dictionary[AccessPath, TypeSymbol]? = nil
                        if (leftElse != nil && leftElse.Count > 0) || (rightElse != nil && rightElse.Count > 0) {
                            combinedElse = if leftElse == nil {
                                Dictionary[AccessPath, TypeSymbol]()
                            } else {
                                Dictionary[AccessPath, TypeSymbol](leftElse)
                            }
                            if rightElse != nil {
                                for kv in rightElse {
                                    combinedElse!![kv.Key] = kv.Value
                                }
                            }
                        }
                        if (combinedThen == nil || combinedThen.Count == 0) &&
                            (combinedElse == nil || combinedElse.Count == 0) {
                            return (nil, nil)
                        }
                        return (combinedThen, combinedElse)
                    }
                }
            }
            // ADR-0069 addendum / issue #1545: nil-guard leaf. Threads
            // `x == nil` / `x != nil` narrowing into the right operand of
            // `&&`/`||`, mirroring the type-test (`x is T`) cases above. Uses the
            // shared leaf classifier kept in sync with
            // StatementBinder.TryClassifyNilGuard.
            if SmartCastStability.TryClassifyNilGuardLeaf(
                condition,
                restrictBareVariableToLocalsAndParams: true,
                referenceNullableOnly: true,
                out var nilTarget,
                out var nilUnderlying,
                out var nonNilWhenTrue
            ) {
                let nonNilFrame = Dictionary[AccessPath, TypeSymbol]{
                    [nilTarget] = Invariant.Required(
                        nilUnderlying,
                        "a classified nil guard has an underlying type",
                        expression: "nilUnderlying"
                    )
                }
                return if nonNilWhenTrue {
                    (nonNilFrame, nil)
                } else {
                    (nil, nonNilFrame)
                }
            }
            return (nil, nil)
        }

        /// Issue #3705 (family 3): whether a structural function type has exactly
        /// the signature of [`delegateType`](paramref).
        ///
        /// Every operand here can come from the compilation's
        /// (cref:System.Reflection.MetadataLoadContext) — both callers pass
        /// an `EventInfo.EventHandlerType`, which is always imported metadata
        /// — so all three questions must be asked across load contexts:
        /// `typeof(Delegate).IsAssignableFrom` answers `false`
        /// for an MLC delegate ((cref:ClrTypeUtilities.IsDelegateType) is
        /// the by-name walk that does not), the constructed `Invoke` may be
        /// unreachable (#3697 — (cref:ClrLoadContext.TryGetDelegateSignature)
        /// carries the open-definition fallback), and a raw `!=` on
        /// (cref:Type) is reference identity, never true across contexts
        /// (#835 — (cref:ClrTypeUtilities.IsSameAs) compares structurally).
        /// @param fn The structural function type.
        /// @param delegateType The candidate delegate type, typically imported.
        /// @returns `true` when the signatures match exactly.
        private func IsSignatureCompatibleWithDelegate(fn FunctionTypeSymbol, delegateType Type) bool {
            if !ClrTypeUtilities.IsDelegateType(delegateType) {
                return false
            }
            if !ClrLoadContext.TryGetDelegateSignature(delegateType, out var parms, out var invokeReturn) {
                return false
            }
            if parms.Length != fn.ParameterTypes.Length {
                return false
            }
            for var i = 0; i < parms.Length; i++ {
                if !(fn.ParameterTypes[i]?.ClrType).IsSameAs(parms[i]) {
                    return false
                }
            }
            let fnRetClr = if fn.ReturnType == TypeSymbol.Void {
                typeof(Void)
            } else {
                fn.ReturnType?.ClrType
            }
            return fnRetClr.IsSameAs(invokeReturn)
        }

        /// ADR-0039: Determines whether an expression is an lvalue (can have its address taken).
        internal func IsLvalue(expression BoundExpression) bool {
            if expression is BoundBlockExpression block {
                return IsLvalue(block.Expression)
            }
            if expression is BoundConditionalExpression conditional {
                return IsLvalue(conditional.WhenTrue) &&
                    IsLvalue(conditional.WhenFalse) &&
                    conditional
                    .WhenTrue
                    .Type == conditional
                    .WhenFalse
                    .Type
            }
            return switch expression {
                case field is BoundFieldAccessExpression: IsAddressableFieldReceiver(field.Receiver)
                case BoundClrPropertyAccessExpression{Member: FieldInfo field} access: !field.IsLiteral &&
                    IsAddressableFieldReceiver(access.Receiver)
                case index is BoundIndexExpression: index.IsArrayBackedElementAccess
                case _ is BoundVariableExpression or _ is BoundDereferenceExpression: true
                case _ when RefCapabilities.IsNativeRefReturningCall(expression): true
                default: false
            }
        }

        private func IsAddressableFieldReceiver(receiver BoundExpression?) bool -> receiver == nil ||
            Binder.IsReferenceTypeForConstraint(receiver.Type) || IsLvalue(receiver)

        internal func TryGetReadOnlyAddressTarget(
            expression BoundExpression,
            @NotNullWhen(true) out variable VariableSymbol?
        ) bool {
            switch expression {
                case block is BoundBlockExpression {
                    return TryGetReadOnlyAddressTarget(block.Expression, out variable)
                }
                case conditional is BoundConditionalExpression {
                    return TryGetReadOnlyAddressTarget(conditional.WhenTrue, out variable) ||
                        TryGetReadOnlyAddressTarget(conditional.WhenFalse, out variable)
                }
                case BoundVariableExpression{Variable: {IsReadOnly: true}} readOnly {
                    variable = readOnly.Variable
                    return true
                }
                default {
                    variable = nil
                    return false
                }
            }
        }

        /// Issue #1238: returns true when [`syntax`](paramref) (after peeling
        /// any enclosing parentheses) is a target-typeable branchy expression — an
        /// `if`/`else` expression, a ternary conditional, or a
        /// `switch`-expression. Such an expression, when used directly as a
        /// call/constructor argument, must be (re)bound with the corresponding
        /// parameter type as its target so each branch is target-typed (mirroring
        /// the `return`/typed-`let` paths).
        internal func IsTargetTypedBranchyArgumentSyntax(syntax SyntaxNode) bool {
            var syntax = syntax
            while syntax is ParenthesizedExpressionSyntax parenthesized {
                syntax = parenthesized.Expression
            }
            return syntax is IfExpressionSyntax ||
                syntax is IfLetExpressionSyntax ||
                syntax is ConditionalExpressionSyntax ||
                syntax is SwitchExpressionSyntax ||
                syntax is BlockExpressionSyntax ||
                (
                syntax is BinaryExpressionSyntax binary && binary.OperatorToken.Kind == SyntaxKind.QuestionQuestionToken
            )
        }

        /// Issue #3355: returns true when a block argument's trailing value cannot
        /// be bound before overload resolution supplies a parameter target type.
        /// Prefix statements do not affect that decision.
        internal func IsTargetDependentBlockArgumentSyntax(syntax ExpressionSyntax) bool {
            var syntax = syntax
            while syntax is ParenthesizedExpressionSyntax parenthesized {
                syntax = parenthesized.Expression
            }
            if syntax is not BlockExpressionSyntax block || block.Expression == nil {
                return false
            }
            return IsTargetDependentExpressionSyntax(block.Expression)
        }

        private func IsTargetDependentExpressionSyntax(syntax ExpressionSyntax) bool {
            var syntax = syntax
            while syntax is ParenthesizedExpressionSyntax parenthesizedTail {
                syntax = parenthesizedTail.Expression
            }
            switch syntax {
                case BlockExpressionSyntax{Expression: {} nestedTail} {
                    return IsTargetDependentExpressionSyntax(nestedTail)
                }
                case defaultExpressionSyntax is DefaultExpressionSyntax when defaultExpressionSyntax.TypeClause == nil {
                    return true
                }
                case lambda is LambdaExpressionSyntax {
                    for parameter in lambda.Parameters {
                        if parameter.Type == nil {
                            return true
                        }
                    }
                    return IsTargetDependentExpressionSyntax(lambda.Body)
                }
                case conditional is ConditionalExpressionSyntax {
                    return IsTargetDependentExpressionSyntax(conditional.WhenTrue) ||
                        IsTargetDependentExpressionSyntax(conditional.WhenFalse)
                }
                case ifExpression is IfExpressionSyntax {
                    return IsTargetDependentExpressionSyntax(ifExpression.ThenBlock) ||
                        (
                        ifExpression.ElseExpression != nil &&
                            IsTargetDependentExpressionSyntax(ifExpression.ElseExpression)
                    )
                }
                case ifLetExpression is IfLetExpressionSyntax {
                    return IsTargetDependentExpressionSyntax(ifLetExpression.ThenBlock) ||
                        (
                        ifLetExpression.ElseExpression != nil &&
                            IsTargetDependentExpressionSyntax(ifLetExpression.ElseExpression)
                    )
                }
                case switchExpression is SwitchExpressionSyntax {
                    return switchExpression.Arms.Any(
                        (arm SwitchExpressionArmSyntax) -> IsTargetDependentExpressionSyntax(arm.Result)
                    )
                }
                case binary is BinaryExpressionSyntax when binary
                    .OperatorToken
                    .Kind == SyntaxKind
                    .QuestionQuestionToken {
                    return IsTargetDependentExpressionSyntax(binary.Left) ||
                        IsTargetDependentExpressionSyntax(binary.Right)
                }
                default {
                    return false
                }
            }
        }

        /// Issue #3355: checks whether a target-dependent block argument can use
        /// the supplied parameter type without binding it speculatively.
        internal func CanTargetDependentBlockArgument(syntax ExpressionSyntax, targetType TypeSymbol) bool {
            var syntax = syntax
            while syntax is ParenthesizedExpressionSyntax parenthesized {
                syntax = parenthesized.Expression
            }
            if !(syntax is BlockExpressionSyntax{Expression: {} tail}) {
                return CanTargetDependentExpression(syntax, targetType)
            }
            return CanTargetDependentExpression(tail, targetType)
        }

        private func CanTargetDependentExpression(syntax ExpressionSyntax, targetType TypeSymbol) bool {
            var syntax = syntax
            while syntax is ParenthesizedExpressionSyntax parenthesizedTail {
                syntax = parenthesizedTail.Expression
            }
            switch syntax {
                case BlockExpressionSyntax{Expression: {} nestedTail} {
                    return CanTargetDependentExpression(nestedTail, targetType)
                }
                case defaultExpressionSyntax is DefaultExpressionSyntax when defaultExpressionSyntax.TypeClause == nil {
                    return targetType != TypeSymbol.Error && targetType != TypeSymbol.Void
                }
                case lambda is LambdaExpressionSyntax {
                    var allParametersTyped = true
                    for parameter in lambda.Parameters {
                        allParametersTyped &= parameter.Type != nil
                    }
                    if allParametersTyped {
                        return true
                    }
                    if !MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(targetType, out var functionType) ||
                        functionType == nil ||
                        functionType.Arity != lambda
                        .Parameters
                        .Count {
                        return false
                    }
                    for var i = 0; i < lambda.Parameters.Count; i++ {
                        let targetIsVariadic = !functionType.IsVariadic.IsDefaultOrEmpty && functionType.IsVariadic[i]
                        if lambda.Parameters[i].IsVariadic != targetIsVariadic {
                            return false
                        }
                    }
                    return true
                }
                case conditional is ConditionalExpressionSyntax {
                    return CanTargetDependentExpression(conditional.WhenTrue, targetType) &&
                        CanTargetDependentExpression(conditional.WhenFalse, targetType)
                }
                case ifExpression is IfExpressionSyntax {
                    return CanTargetDependentExpression(ifExpression.ThenBlock, targetType) &&
                        (
                        ifExpression.ElseExpression == nil ||
                            CanTargetDependentExpression(ifExpression.ElseExpression, targetType)
                    )
                }
                case ifLetExpression is IfLetExpressionSyntax {
                    return CanTargetDependentExpression(ifLetExpression.ThenBlock, targetType) &&
                        (
                        ifLetExpression.ElseExpression == nil ||
                            CanTargetDependentExpression(ifLetExpression.ElseExpression, targetType)
                    )
                }
                case switchExpression is SwitchExpressionSyntax {
                    return switchExpression.Arms.All(
                        (arm SwitchExpressionArmSyntax) -> CanTargetDependentExpression(arm.Result, targetType)
                    )
                }
                case binary is BinaryExpressionSyntax when binary
                    .OperatorToken
                    .Kind == SyntaxKind
                    .QuestionQuestionToken {
                    return CanTargetDependentExpression(binary.Left, targetType) &&
                        CanTargetDependentExpression(binary.Right, targetType)
                }
                default {
                    return true
                }
            }
        }

        /// Issue #1238: detects a deferred branchy-argument placeholder produced by
        /// the if/conditional/switch binders when they could not unify their
        /// branches without a target type. The placeholder is a
        /// (cref:BoundErrorExpression) that retains the original branchy
        /// syntax so the argument-conversion loops can re-bind it against the
        /// resolved parameter type.
        internal func IsDeferredBranchyArgumentPlaceholder(
            expression BoundExpression,
            @NotNullWhen(true) out branchySyntax ExpressionSyntax?
        ) bool {
            if expression is BoundErrorExpression{Syntax: ExpressionSyntax syntax} &&
                IsTargetTypedBranchyArgumentSyntax(syntax) {
                branchySyntax = syntax
                return true
            }
            branchySyntax = nil
            return false
        }

        private func TryGetTaskElementType(type TypeSymbol, @NotNullWhen(true) out element TypeSymbol?) bool {
            var type = type
            element = nil
            // ADR-0186: whether an awaitable may itself be nil (`Task[string!]!`,
            // routine inside an ADR-0186 §9 oblivious scope) says nothing about
            // what it yields. Read through the wrapper so the symbolic arm below
            // sees the constructed awaitable instead of falling to the erased
            // CLR one, which would drop the awaited `string!` to `string`.
            type = PlatformTypeSymbol.StripTopLevel(type)
            // ADR-0172 / issue #4159: an imported awaitable whose signature
            // carries reference-nullability metadata arrives wrapped in a
            // NullabilityAnnotatedTypeSymbol, hiding the symbolic constructed
            // base from the fast path below. A prior version of this method
            // unwrapped straight to that symbolic base whenever a type argument
            // happened to be a named tuple (reasoning that "the base's arguments
            // already carry their element nullability") — but the symbolic
            // base's TypeArguments are built by a naive TypeSymbol.FromClrType
            // walk and carry NO nullability at all; only NullabilityAnnotatedTypeSymbol
            // itself (via GetTypeArgumentSymbol, which both applies the
            // [NullableAttribute] flags AND transfers tuple element names from
            // the symbolic base) can answer both concerns together. Unwrapping
            // and indexing the raw TypeArguments silently dropped nullability on
            // every reference-typed awaited element that needed the wrapper at
            // all (a named tuple element being only the case that surfaced it in
            // practice) — this is the actual fix for #4159, not a tuple-only fix.
            let annotatedAwaitable NullabilityAnnotatedTypeSymbol? = type as NullabilityAnnotatedTypeSymbol
            let symbolicAwaitableCandidate = annotatedAwaitable?.BaseType ?? type
            // Issue #2195: for an imported generic awaitable (e.g. `Task[T]`,
            // `ValueTask[T]`) recover the awaited ELEMENT type from the SYMBOLIC
            // type argument rather than the awaiter's CLR `GetResult()` return
            // type. A same-compilation user type or an open type parameter is
            // erased to `object` in the awaitable's CLR type, so the CLR fallback
            // below would surface `object` — collapsing e.g. `Task.Run`'s inferred
            // `TResult` to `object` when inferred from an async-lambda body. Locate
            // which of the awaitable's own type parameters its `GetResult()`
            // surfaces (a `!n` declared on the open awaitable), then project that
            // position out of the symbolic `TypeArguments`. This generalizes the
            // former `Task`1`-only fast path to every generic awaitable whose
            // `GetResult()` returns its own type parameter (covers `Task[T]` and
            // `ValueTask[T]` without special-casing either).
            //
            // Issue #4159 correction (measured, not assumed — a prior version of
            // this comment claimed this branch "never fires for Task[T]/ValueTask[T]
            // because GetResult() is declared on the awaiter type", reasoning
            // that the awaiter's substituted return type's `DeclaringType` would
            // never equal `openDef`; traced directly and that reasoning is
            // WRONG — `DeclaringType` DOES equal `openDef` for a real `Task[T]`
            // once this branch's OWN guard below is satisfied. The actual gate
            // is `TypeArguments.IsDefaultOrEmpty: false` on the line directly
            // below: `symbolicAwaitableCandidate`'s `TypeArguments` stay EMPTY
            // for a PLAIN (non-tuple-containing) awaitable — nothing eagerly
            // rebuilds them — so this whole block is skipped for e.g. plain
            // `Task[string]`/`Task[string?]`, which fall through to the
            // CLR-fallback branch below instead. A TUPLE-containing awaitable
            // (e.g. `Task[IReadOnlyList[(Key string, Value string?)]]`) DOES
            // have non-empty `TypeArguments` (eagerly rebuilt to carry tuple
            // element names — see `ImportedTypeSymbol.GetConstructed`), so THIS
            // branch fires for it instead, via `GetTypeArgumentSymbol` below —
            // not the CLR-fallback branch's `GetTypeArgumentSymbolForClrType`.
            // Both routes call into the same `NullabilityAnnotatedTypeSymbol.TransferTupleNames`
            // fix, so either path preserves nullability and tuple names
            // correctly; which one actually runs for a given awaitable depends
            // on whether ANYTHING in its type-argument tree needed eager
            // reconstruction for tuple names, not on Task-vs-custom-awaitable.
            if symbolicAwaitableCandidate is ImportedTypeSymbol{
                TypeArguments: {IsDefaultOrEmpty: false}
            } symbolicAwaitable &&
                symbolicAwaitable.ClrType is Type importedTaskClr &&
                importedTaskClr.IsGenericType &&
                !importedTaskClr
                .IsGenericTypeDefinition {
                let openDef = importedTaskClr.GetGenericTypeDefinition()
                let openShape = AwaitableShape.Resolve(openDef)
                if openShape?.ResultType is Type openResult &&
                    openResult.IsGenericParameter &&
                    openResult
                    .DeclaringType
                    .IsSameAs(openDef) &&
                    openResult.GenericParameterPosition >= 0 &&
                    openResult.GenericParameterPosition < symbolicAwaitable
                    .TypeArguments
                    .Length {
                    element = if annotatedAwaitable != nil {
                        annotatedAwaitable.GetTypeArgumentSymbol(openResult.GenericParameterPosition)
                    } else {
                        symbolicAwaitable.TypeArguments[openResult.GenericParameterPosition]
                    }
                    return true
                }
            }
            let clr Type? = type?.ClrType
            if clr == nil {
                return false
            }
            // Use the general awaitable-shape resolver: any type with a conforming
            // GetAwaiter()/IsCompleted/GetResult() triple is awaitable (C# spec §12.9.8).
            let shape AwaitableShape? = AwaitableShape.Resolve(clr)
            if shape == nil {
                return false
            }
            let resultClrType = shape.ResultType
            if resultClrType.IsSameAs(typeof(Void)) {
                element = TypeSymbol.Void
            } else if annotatedAwaitable != nil {
                // Issue #4159: this is the branch a PLAIN (non-tuple-containing)
                // BCL `Task[T]`/`ValueTask[T]` await takes — measured, not
                // assumed: the `openDef` branch above requires
                // `symbolicAwaitableCandidate`'s `TypeArguments` to be
                // non-empty, and nothing eagerly rebuilds them for a plain
                // awaitable (e.g. `Task[string]`, `Task[string?]`), so that
                // branch is skipped and execution falls through to here. A
                // TUPLE-containing awaitable (e.g. the original #4159 repro,
                // `Task[IReadOnlyList[(Key string, Value string?)]]`) instead
                // takes the `openDef` branch above via `GetTypeArgumentSymbol`
                // — its `TypeArguments` ARE eagerly rebuilt to carry tuple
                // element names, which also happens to satisfy that branch's
                // `DeclaringType == openDef` check for a real `Task[T]` (that
                // check is NOT awaiter-type-specific the way an earlier version
                // of this comment claimed). `resultClrType` here is a CLOSED
                // reflected type (e.g. `System.String`) with no nullability
                // metadata of its own — nullability lives only on
                // NullabilityAnnotatedTypeSymbol's flags array, keyed by the
                // OUTER awaitable's generic argument position.
                // GetTypeArgumentSymbolForClrType finds which of the outer
                // awaitable's own generic arguments this result type
                // structurally corresponds to and derives the correctly-nullable
                // symbol from there — falling back to the prior naive behavior
                // when no argument matches, or when more than one argument
                // could match (an ambiguous custom awaitable with a repeated
                // CLR type among its own arguments — Copilot review finding on
                // this PR — rather than ever guess which one is right).
                element = annotatedAwaitable.GetTypeArgumentSymbolForClrType(resultClrType)
            } else {
                // ADR-0193 Phase 2: the awaiter's GetResult declaration, read
                // through the funnel. This read `resultClrType` erased, so an
                // awaiter declaring `string? GetResult()` awaited as `string`.
                element = ClrNullability.GetReturnTypeSymbol(shape.GetResultMethod)
            }
            return true
        }

        private func IsMethodGroupCandidateUsable(function FunctionSymbol) bool {
            // Issue #4219 (umbrella remainder): a non-generic, non-capturing
            // direct-call local function (a member of a 2+ non-generic local-
            // function-literal group, see StatementBinder's
            // IsNonGenericLocalFunctionLiteralDeclaration) has no Package —
            // it is a local, not a package-level function — but converts to a
            // delegate exactly like one: a plain static-shaped MethodDef, no
            // capture instance to bind. A GENERIC or CAPTURING local function
            // keeps falling through to "not a variable" below, matching the
            // pre-existing behavior for a capturing generic local function
            // (no single stable closure instance to bind a bare-name delegate
            // conversion to — each direct call it makes materializes its own).
            let isConvertibleLocalFunction = function.LocalDeclaration != nil &&
                !function.IsGeneric &&
                !function.HasCaptures
            if function.IsInstanceMethod ||
                function.IsExtension ||
                function.IsStatic ||
                function.StaticOwnerType != nil ||
                (function.Package == nil && !isConvertibleLocalFunction) {
                return false
            }
            for parameter in function.Parameters {
                if parameter.IsVariadic {
                    return false
                }
            }
            return true
        }

        internal func MakeMethodGroupInference(
            arguments IReadOnlyList[BoundExpression]?,
            projectType(TypeSymbol) -> Type?,
            argumentOffset int32 = 0
        )((int32, IReadOnlyList[Type]) -> (Parameters[]Type, Return Type)?)? {
            if arguments == nil || !arguments.Any(ClrOverloadResolution.IsMethodGroupArgument) {
                return nil
            }
            return (argumentIndex int32, delegateParameterTypes IReadOnlyList[Type]) -> {
                let sourceIndex = argumentIndex - argumentOffset
                if sourceIndex < 0 || sourceIndex >= arguments.Count {
                    return nil
                }
                return ResolveMethodGroupInferenceSignature(arguments[sourceIndex], delegateParameterTypes, projectType)
            }
        }

        internal func MakeMethodGroupArgumentCheck(arguments IReadOnlyList[BoundExpression]?, argumentOffset int32 = 0)(
            (int32) -> bool
        )? {
            if arguments == nil || !arguments.Any(ClrOverloadResolution.IsMethodGroupArgument) {
                return nil
            }
            return (argumentIndex int32) -> {
                let sourceIndex = argumentIndex - argumentOffset
                return sourceIndex >= 0 && sourceIndex < arguments.Count && ClrOverloadResolution.IsMethodGroupArgument(
                    arguments[sourceIndex]
                )
            }
        }

        internal func BuildOpenLiteralInferenceFlags(
            arguments IReadOnlyList[BoundExpression],
            argumentOffset int32 = 0
        ) IReadOnlyList[bool]? {
            var flags[]?bool = nil
            for var i = 0; i < arguments.Count; i++ {
                if !TypeSymbol.ContainsNullLiteralType(arguments[i].Type) {
                    continue
                }
                flags ??= [arguments.Count + argumentOffset]bool
                flags!![i + argumentOffset] = true
            }
            return flags
        }

        internal func MakeOpenLiteralArgumentCheck(arguments IReadOnlyList[BoundExpression], argumentOffset int32 = 0)(
            (int32, Type) -> bool
        )? {
            if !arguments.Any((argument BoundExpression) -> TypeSymbol.ContainsNullLiteralType(argument.Type)) {
                return nil
            }
            return (index int32, targetClrType Type) -> {
                let argumentIndex = index - argumentOffset
                return argumentIndex >= 0 &&
                    argumentIndex < arguments.Count &&
                    OpenLiteralShapeConverts(
                    arguments[argumentIndex].Type,
                    TypeSymbol.FromClrTypeWithoutNullability(targetClrType, NullabilityFreeReason.IdentityComparison)
                )
            }
        }

        private func OpenLiteralShapeConverts(source TypeSymbol, target TypeSymbol) bool {
            if source == TypeSymbol.Null {
                return target is NullableTypeSymbol || Conversion.IsReferenceLikeTarget(target)
            }
            if source is TupleTypeSymbol sourceTuple &&
                target is TupleTypeSymbol targetTuple &&
                sourceTuple.Arity == targetTuple
                .Arity {
                for var i = 0; i < sourceTuple.Arity; i++ {
                    if !OpenLiteralShapeConverts(sourceTuple.ElementTypes[i], targetTuple.ElementTypes[i]) {
                        return false
                    }
                }
                return true
            }
            return Conversion.ClassifyNonStructural(source, target).IsImplicit
        }

        private func ResolveMethodGroupInferenceSignature(
            argument BoundExpression,
            delegateParameterTypes IReadOnlyList[Type],
            projectType(TypeSymbol) -> Type?
        )(Parameters[]Type, Return Type)? {
            if delegateParameterTypes.Any((type Type) -> type.ContainsGenericParameters) {
                return ResolveSingleMethodGroupInferenceSignature(argument, delegateParameterTypes.Count, projectType)
            }
            if argument is BoundClrMethodGroupExpression clrGroup {
                let receiver BoundExpression? = clrGroup.Receiver
                var closesExtensionReceiver = receiver != nil
                for candidate in clrGroup.Candidates {
                    closesExtensionReceiver &= candidate.IsStatic
                }
                let resolutionArguments = [
                    delegateParameterTypes.Count +
                        (
                        if closesExtensionReceiver {
                            1
                        } else {
                            0
                        }
                    )
                ]Type
                if closesExtensionReceiver {
                    // closesExtensionReceiver is only true when the `receiver != null`
                    // conjunct above held.
                    let receiverClr Type? = projectType(receiver!!.Type)
                    if receiverClr == nil {
                        return nil
                    }
                    resolutionArguments[0] = receiverClr
                }
                for var i = 0; i < delegateParameterTypes.Count; i++ {
                    resolutionArguments[
                        i +
                            (
                            if closesExtensionReceiver {
                                1
                            } else {
                                0
                            }
                        )
                    ] = delegateParameterTypes[i]
                }
                let resolution = ClrOverloadResolution.Resolve(
                    clrGroup.Candidates,
                    resolutionArguments,
                    trailingParameterCountToIgnore: (candidate MethodBase) -> if candidate is MethodInfo method &&
                        ImportedFunctionSymbol.HasHiddenContextParameter(method) {
                        1
                    } else {
                        0
                    }
                )
                if resolution.Outcome != ClrOverloadResolution
                    .ResolutionOutcome
                    .Resolved ||
                    resolution.Best is not{} method {
                    return nil
                }
                let parameters = ImportedFunctionSymbol.GetLogicalParameters(method)
                let parameterOffset = if closesExtensionReceiver {
                    1
                } else {
                    0
                }
                let signatureParameters = [parameters.Length - parameterOffset]Type
                for var i = parameterOffset; i < parameters.Length; i++ {
                    signatureParameters[i - parameterOffset] = parameters[i].ParameterType
                }
                return (signatureParameters, method.ReturnType)
            }
            if argument is not BoundMethodGroupExpression userGroup {
                return nil
            }
            let matches = List[
                (
                    Method FunctionSymbol,
                    Signature(Parameters[]Type, Return Type),
                    Conversions[]ClrOverloadResolution.ImplicitConversionKind
                )
            ]()
            for candidate in userGroup.Candidates {
                let candidateOwner = if userGroup.StaticOwnerType != nil &&
                    candidate.StaticOwnerType is StructSymbol declaredOwner {
                    TypeMemberModel.ResolveStaticMemberOwner(userGroup.StaticOwnerType, declaredOwner)
                } else {
                    default(StructSymbol?)
                }
                let targetParameterTypes = delegateParameterTypes.Select(
                    (type Type) -> TypeSymbol.FromClrTypeWithoutNullability(
                        type,
                        NullabilityFreeReason.IdentityComparison
                    )
                )
                    .ToArray()
                if !TryCloseMethodGroupCandidate(
                    candidate,
                    userGroup.Receiver,
                    candidateOwner,
                    targetParameterTypes,
                    out var closedParameters,
                    out var closedReturn,
                    out _
                ) {
                    continue
                }
                let parameterTypes = [delegateParameterTypes.Count]Type
                let conversions = [delegateParameterTypes.Count]ClrOverloadResolution.ImplicitConversionKind
                var compatible = true
                for var i = 0; i < parameterTypes.Length; i++ {
                    let projected Type? = projectType(closedParameters[i])
                    if projected == nil {
                        compatible = false
                        break
                    }
                    // The method must ACCEPT what the delegate provides:
                    // ClassifyImplicit(target, source) with the METHOD parameter
                    // as the target admits contravariant groups
                    // (`Stringify(object?)` satisfies a `(string) -> string`
                    // slot; issue #3501 A5).
                    conversions[i] = ClrOverloadResolution.ClassifyImplicit(projected, delegateParameterTypes[i])
                    if conversions[i] == ClrOverloadResolution.ImplicitConversionKind.None {
                        compatible = false
                        break
                    }
                    parameterTypes[i] = projected
                }
                if !compatible {
                    continue
                }
                let returnType Type? = projectType(closedReturn)
                if returnType == nil {
                    continue
                }
                matches.Add((candidate, (parameterTypes, returnType), conversions))
            }
            // Exclude the same source candidate by symbol identity; projected
            // parameter arrays are implementation details, not candidate identity.
            let best = matches.Where(
                (
                    candidate(
                        Method FunctionSymbol,
                        Signature(Parameters[]Type, Return Type),
                        Conversions[]ClrOverloadResolution.ImplicitConversionKind
                    )
                ) -> !matches
                    .Any(
                    (
                        other(
                            Method FunctionSymbol,
                            Signature(Parameters[]Type, Return Type),
                            Conversions[]ClrOverloadResolution.ImplicitConversionKind
                        )
                    ) -> !object.ReferenceEquals(candidate.Method, other.Method) &&
                        IsBetterMethodGroupConversion(other.Conversions, candidate.Conversions)
                )
            )
                .ToList()
            return if best.Count == 1 {
                best[0].Signature
            } else {
                nil
            }
        }

        private func ResolveSingleMethodGroupInferenceSignature(
            argument BoundExpression,
            delegateArity int32,
            projectType(TypeSymbol) -> Type?
        )(Parameters[]Type, Return Type)? {
            if argument is BoundClrMethodGroupExpression clrGroup {
                var method MethodInfo? = nil
                var parameterOffset = 0
                for possibleMethod in clrGroup.Candidates {
                    let candidateOffset = if clrGroup.Receiver != nil && possibleMethod.IsStatic {
                        1
                    } else {
                        0
                    }
                    if ImportedFunctionSymbol.GetLogicalParameters(possibleMethod)
                        .Length - candidateOffset != delegateArity {
                        continue
                    }
                    if method != nil {
                        return nil
                    }
                    method = possibleMethod
                    parameterOffset = candidateOffset
                }
                if method == nil || method.ContainsGenericParameters {
                    return nil
                }
                let parameters = ImportedFunctionSymbol.GetLogicalParameters(method)
                let signatureParameters = [delegateArity]Type
                for var i = 0; i < signatureParameters.Length; i++ {
                    signatureParameters[i] = parameters[i + parameterOffset].ParameterType
                }
                return (signatureParameters, method.ReturnType)
            }
            if argument is not BoundMethodGroupExpression userGroup {
                return nil
            }
            if userGroup
                .Candidates
                .Length == 1 &&
                userGroup.FunctionType is {} naturalType &&
                naturalType
                .ParameterTypes
                .Length == delegateArity {
                let naturalParameters = [delegateArity]Type
                for var i = 0; i < naturalParameters.Length; i++ {
                    if projectType(naturalType.ParameterTypes[i]) is not{} projected {
                        return nil
                    }
                    naturalParameters[i] = projected
                }
                return if projectType(naturalType.ReturnType) is {} naturalReturn {
                    (naturalParameters, naturalReturn)
                } else {
                    nil
                }
            }
            var candidate FunctionSymbol? = nil
            var userParameterOffset = 0
            for possibleCandidate in userGroup.Candidates {
                let candidateOffset = if possibleCandidate.IsExtension && userGroup.Receiver != nil {
                    1
                } else {
                    0
                }
                if possibleCandidate.Parameters.Length - candidateOffset != delegateArity {
                    continue
                }
                if candidate != nil {
                    return nil
                }
                candidate = possibleCandidate
                userParameterOffset = candidateOffset
            }
            if candidate == nil || candidate.IsGeneric {
                return nil
            }
            var candidateOwner StructSymbol? = if userGroup.StaticOwnerType != nil &&
                candidate.StaticOwnerType is StructSymbol declaredOwner {
                TypeMemberModel.ResolveStaticMemberOwner(userGroup.StaticOwnerType, declaredOwner)
            } else {
                default(StructSymbol?)
            }
            if candidateOwner == nil &&
                !candidate.IsExtension &&
                userGroup
                .Receiver
                ?.Type is StructSymbol receiverStruct &&
                candidate.ReceiverType is StructSymbol declaredReceiver {
                candidateOwner = TypeMemberModel.ResolveStaticMemberOwner(receiverStruct, declaredReceiver)
            }
            let projectedParameters = [delegateArity]Type
            for var i = 0; i < projectedParameters.Length; i++ {
                let parameter = candidateOwner?.SubstituteMemberType(
                    candidate.Parameters[i + userParameterOffset].Type
                ) ??
                    candidate
                    .Parameters[i + userParameterOffset]
                    .Type
                if projectType(parameter) is not{} projected {
                    return nil
                }
                projectedParameters[i] = projected
            }
            if candidate.IsAsyncOrSuspending && !candidate.IsAsyncVoid {
                return nil
            }
            let returnType = candidateOwner?.SubstituteMemberType(candidate.Type) ?? candidate.Type ?? TypeSymbol.Void
            return if projectType(returnType) is {} projectedReturn {
                (projectedParameters, projectedReturn)
            } else {
                nil
            }
        }

        internal func TryCloseMethodGroupCandidate(
            candidate FunctionSymbol,
            receiver BoundExpression?,
            candidateOwner StructSymbol?,
            targetParameterTypes IReadOnlyList[TypeSymbol],
            @NotNullWhen(true) out closedParameters[]?TypeSymbol,
            @NotNullWhen(true) out closedReturn TypeSymbol?,
            out methodTypeArguments ImmutableArray[TypeSymbol]
        ) bool {
            var candidateOwner = candidateOwner
            closedParameters = nil
            closedReturn = nil
            methodTypeArguments = default(ImmutableArray[TypeSymbol])
            let parameterOffset = if candidate.IsExtension && receiver != nil {
                1
            } else {
                0
            }
            if candidate.Parameters.Length - parameterOffset != targetParameterTypes.Count {
                return false
            }
            // Issue #3248: an instance method group's candidates come from the
            // receiver type's DEFINITION (a constructed StructSymbol forwards
            // `Methods` to it), so their parameter/return types still reference
            // the declaring class's own type parameters. Resolve the receiver's
            // construction of the declaring definition (walking the base chain)
            // and substitute the signature through it, so the closed signature —
            // and the delegate FunctionType the conversion builds from it —
            // carries the receiver's instantiation. Without this, a deferred
            // method group like `holder.Count` inside `GetCounter[T](holder
            // Holder[T])` kept `Holder`'s class type parameter in its function
            // type and the emitter encoded the delegate TypeSpec with a class
            // `Var` slot in a context that only has method generics (invalid
            // metadata; BadImageFormatException at runtime).
            if candidateOwner == nil &&
                !candidate.IsExtension &&
                receiver?.Type is StructSymbol receiverStruct &&
                candidate.ReceiverType is StructSymbol declaredReceiver {
                candidateOwner = TypeMemberModel.ResolveStaticMemberOwner(receiverStruct, declaredReceiver)
            }
            var substitution Dictionary[TypeParameterSymbol, TypeSymbol]? = nil
            if candidate.IsGeneric {
                substitution = Dictionary[TypeParameterSymbol, TypeSymbol]()
                if parameterOffset == 1 {
                    let receiverParameter = candidateOwner?.SubstituteMemberType(candidate.Parameters[0].Type) ??
                        candidate
                        .Parameters[0]
                        .Type
                    // parameterOffset is 1 only when `candidate.IsExtension && receiver != null` held above.
                    Binder.InferTypeArguments(receiverParameter, receiver!!.Type, substitution)
                }
                for var i = 0; i < targetParameterTypes.Count; i++ {
                    let parameter = candidateOwner?.SubstituteMemberType(
                        candidate.Parameters[i + parameterOffset].Type
                    ) ??
                        candidate
                        .Parameters[i + parameterOffset]
                        .Type
                    Binder.InferTypeArguments(parameter, targetParameterTypes[i], substitution)
                }
                let typeArguments = ImmutableArray.CreateBuilder[TypeSymbol](candidate.TypeParameters.Length)
                for typeParameter in candidate.TypeParameters {
                    if !substitution.TryGetValue(typeParameter, out var typeArgument) || !Binder.SatisfiesConstraint(
                        typeArgument,
                        typeParameter,
                        substitution
                    ) {
                        return false
                    }
                    typeArguments.Add(typeArgument)
                }
                methodTypeArguments = typeArguments.MoveToImmutable()
            }
            closedParameters = [targetParameterTypes.Count]TypeSymbol
            for var i = 0; i < closedParameters!!.Length; i++ {
                let parameter = candidateOwner?.SubstituteMemberType(candidate.Parameters[i + parameterOffset].Type) ??
                    candidate
                    .Parameters[i + parameterOffset]
                    .Type
                closedParameters!![i] = if substitution == nil {
                    parameter
                } else {
                    Binder.SubstituteType(parameter, substitution)
                }
            }
            let returnType = candidateOwner?.SubstituteMemberType(candidate.Type) ?? candidate.Type ?? TypeSymbol.Void
            closedReturn = if substitution == nil {
                returnType
            } else {
                Binder.SubstituteType(returnType, substitution)
            }
            return true
        }

        private func IsBetterMethodGroupConversion(
            candidate IReadOnlyList[ClrOverloadResolution.ImplicitConversionKind],
            other IReadOnlyList[ClrOverloadResolution.ImplicitConversionKind]
        ) bool {
            var strictlyBetter = false
            for var i = 0; i < candidate.Count; i++ {
                if (candidate[i] > other[i]) {
                    return false
                }
                strictlyBetter |= candidate[i] < other[i]
            }
            return strictlyBetter
        }

        /// The G# accessibility that best describes a CLR accessor, for diagnostics.
        /// @param accessor The accessor, or `null` when there is none.
        /// @returns The accessibility.
        private func AccessorAccessibility(accessor MethodBase?) Accessibility -> switch accessor {
            case nil: Accessibility.Private
            case {IsPublic: true}: Accessibility.Public
            case {IsFamily: true} or {IsFamilyOrAssembly: true}: Accessibility.Protected
            case {IsAssembly: true} or {IsFamilyAndAssembly: true}: Accessibility.Internal
            default: Accessibility.Private
        }

        /// Issue #1582: resolves the CLR/metadata base type that a user-defined G#
        /// class (transitively) derives from, so inherited CLR members can be
        /// surfaced on instances of the derived type. Walks the user
        /// (cref:StructSymbol.BaseClass) chain and returns the first
        /// (cref:StructSymbol.ImportedBaseType)'s CLR type encountered — the
        /// point where the user inheritance chain meets metadata. From there,
        /// reflection walks the remainder of the CLR base chain, so this covers a
        /// direct metadata base (`class A : Exception`) as well as a metadata
        /// base reached through one or more user classes (`class B : A` where
        /// `A : Exception`). Returns `null` when the class
        /// derives only from other user classes / `System.Object`.
        /// @param structSymbol The user class to resolve the inherited CLR base for.
        /// @returns The inherited CLR base type, or `null` when there is none.
        internal func GetInheritedClrBaseType(structSymbol StructSymbol) Type? {
            for current in structSymbol.GetHierarchy() {
                let clr Type? = current.ImportedBaseType?.ClrType
                if clr != nil {
                    return clr
                }
            }
            return nil
        }

        /// Resolves an inherited imported property or field through the same
        /// receiver-substitution and declaration-nullability readers as direct CLR
        /// member access. This is the shared read-side sibling of
        /// (cref:TryGetWritableClrMember(MemberInfo?, TypeSymbol?, out Type?, out TypeSymbol?, out bool,
        /// bool)).
        private func GetInheritedClrMemberType(receiverType TypeSymbol, member MemberInfo) TypeSymbol -> switch member {
            case property is PropertyInfo: MemberLookup.GetClrPropertyTypeSymbol(
                receiverType,
                property,
                projectOnlyWhenSymbolicallyRequired: true
            )
            case field is FieldInfo: MemberLookup.GetClrFieldTypeSymbol(receiverType, field)
            default: TypeSymbol.Error
        }

        private func IsNonNullableValueType(type TypeSymbol) bool {
            if type is NullableTypeSymbol {
                return false
            }
            // G# built-in value types.
            if type == TypeSymbol.Int32 ||
                type == TypeSymbol.Int64 ||
                type == TypeSymbol.Float32 ||
                type == TypeSymbol.Float64 ||
                type == TypeSymbol.Bool ||
                type == TypeSymbol.UInt8 ||
                type == TypeSymbol.Int8 ||
                type == TypeSymbol.Int16 ||
                type == TypeSymbol.UInt16 ||
                type == TypeSymbol.UInt32 ||
                type == TypeSymbol.UInt64 ||
                type == TypeSymbol.Decimal ||
                type == TypeSymbol.Char ||
                type == TypeSymbol.NInt ||
                type == TypeSymbol.NUInt {
                return true
            }
            // CLR value types resolved via imports.
            if type.ClrType is {IsValueType: true} {
                return true
            }
            return false
        }
    }
}
