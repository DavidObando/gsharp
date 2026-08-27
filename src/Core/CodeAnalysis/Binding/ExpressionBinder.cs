// <copyright file="ExpressionBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis.Binding.OverloadResolution;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Extracted from <see cref="Binder"/> in PR-B-9 — the final Phase-1
/// component. Owns every per-expression-kind binder: the
/// <c>BindExpression</c> dispatch entry points, literals, operators,
/// member access (the <c>BindAccessor*</c> family), assignments, calls
/// (call-site glue that is NOT in <see cref="OverloadResolver"/>),
/// indexers, ref-argument shaping, switch expressions, await /
/// event-subscription bindings, and the long tail of expression-only
/// helpers (interpolated-string lowering, conditional common-type
/// resolution, method-group resolution, narrowing-frame inspection,
/// etc.). Because the moved code is ≈5,700 LoC, the class is split
/// across nested partial files for reviewability:
/// <see cref="ExpressionBinder"/> (this file: ctor + dispatch + name binding),
/// <c>ExpressionBinder.Literals.cs</c>,
/// <c>ExpressionBinder.Operators.cs</c>,
/// <c>ExpressionBinder.Calls.cs</c>,
/// <c>ExpressionBinder.Access.cs</c>,
/// <c>ExpressionBinder.Assignments.cs</c>,
/// <c>ExpressionBinder.Async.cs</c>,
/// <c>ExpressionBinder.SwitchExpr.cs</c>.
/// </summary>
/// <remarks>
/// Composed via constructor injection and Func/Action callbacks; never
/// back-references <see cref="Binder"/> except for the small set of
/// static helpers that remain on the root (
/// <see cref="Binder.InferTypeArguments"/>,
/// <see cref="Binder.SubstituteType(TypeSymbol, Dictionary{TypeParameterSymbol, TypeSymbol})"/>,
/// <see cref="Binder.SatisfiesConstraint"/>,
/// <see cref="Binder.DescribeConstraint"/>,
/// <see cref="Binder.GetClrGenericArguments"/>,
/// <see cref="Binder.AttachDocumentation"/>,
/// <see cref="Binder.FormatOverloadSignature"/>).
/// </remarks>
internal sealed partial class ExpressionBinder
{
    private readonly BinderContext binderCtx;
    private readonly MemberLookup memberLookup;
    private readonly ConversionClassifier conversions;
    private readonly OverloadResolver overloads;
    private readonly PatternBinder patterns;
    private readonly LambdaBinder lambdas;
    private readonly Func<TypeClauseSyntax, TypeSymbol?> bindTypeClause;
    private readonly Func<string, TypeSymbol?> lookupType;
    private readonly Func<TypeSymbol, Type?> resolveClrTypeForGenericArg;
    private readonly Action<TextLocation, Symbol, string> reportObsoleteUseIfApplicable;
    private readonly Func<TypeSymbol, bool> isAsyncIteratorReturnType;
    private readonly Func<FunctionSymbol?> getCurrentFunction;
    private readonly Func<ImmutableArray<StatementSyntax>, Func<BoundStatement>?, ImmutableArray<BoundStatement>> bindStatementList;

    // ADR-0151: declares the local a value-position `if let` binding
    // introduces, routed through the same
    // `DeclarationBinder.BindVariableDeclaration` the statement forms use so
    // duplicate-name reporting and top-level/global variable shaping match.
    private readonly Func<SyntaxToken, bool, TypeSymbol, VariableSymbol> bindLocalVariable;

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
    private bool eraseDelegateInnerEnumToObject;

    public ExpressionBinder(
        BinderContext binderCtx,
        MemberLookup memberLookup,
        ConversionClassifier conversions,
        OverloadResolver overloads,
        PatternBinder patterns,
        LambdaBinder lambdas,
        Func<TypeClauseSyntax, TypeSymbol?> bindTypeClause,
        Func<string, TypeSymbol?> lookupType,
        Func<TypeSymbol, Type?> resolveClrTypeForGenericArg,
        Action<TextLocation, Symbol, string> reportObsoleteUseIfApplicable,
        Func<TypeSymbol, bool> isAsyncIteratorReturnType,
        Func<FunctionSymbol?> getCurrentFunction,
        Func<ImmutableArray<StatementSyntax>, Func<BoundStatement>?, ImmutableArray<BoundStatement>> bindStatementList,
        Func<SyntaxToken, bool, TypeSymbol, VariableSymbol> bindLocalVariable)
    {
        this.binderCtx = binderCtx ?? throw new ArgumentNullException(nameof(binderCtx));
        this.memberLookup = memberLookup ?? throw new ArgumentNullException(nameof(memberLookup));
        this.conversions = conversions ?? throw new ArgumentNullException(nameof(conversions));
        this.overloads = overloads ?? throw new ArgumentNullException(nameof(overloads));
        this.patterns = patterns ?? throw new ArgumentNullException(nameof(patterns));
        this.lambdas = lambdas ?? throw new ArgumentNullException(nameof(lambdas));
        this.bindTypeClause = bindTypeClause ?? throw new ArgumentNullException(nameof(bindTypeClause));
        this.lookupType = lookupType ?? throw new ArgumentNullException(nameof(lookupType));
        this.resolveClrTypeForGenericArg = resolveClrTypeForGenericArg ?? throw new ArgumentNullException(nameof(resolveClrTypeForGenericArg));
        this.reportObsoleteUseIfApplicable = reportObsoleteUseIfApplicable ?? throw new ArgumentNullException(nameof(reportObsoleteUseIfApplicable));
        this.isAsyncIteratorReturnType = isAsyncIteratorReturnType ?? throw new ArgumentNullException(nameof(isAsyncIteratorReturnType));
        this.getCurrentFunction = getCurrentFunction ?? throw new ArgumentNullException(nameof(getCurrentFunction));
        this.bindStatementList = bindStatementList;
        this.bindLocalVariable = bindLocalVariable;
    }

    private DiagnosticBag Diagnostics => binderCtx.Diagnostics;

#pragma warning disable SA1300 // Element should begin with an uppercase letter
    private BoundScope scope
#pragma warning restore SA1300
    {
        get => binderCtx.RootScope;
        set => binderCtx.RootScope = value;
    }

#pragma warning disable SA1300 // Element should begin with an uppercase letter
    private FunctionSymbol? function => getCurrentFunction();
#pragma warning restore SA1300

    /// <summary>
    /// Issue #1159: returns the implicit-<c>this</c> parameter that an
    /// unqualified instance-member reference should bind against. For a direct
    /// instance method body this is the enclosing function's own
    /// <see cref="FunctionSymbol.ThisParameter"/>. Inside a lambda body the
    /// enclosing function is a synthetic <see cref="FunctionSymbol"/> with no
    /// receiver, so we fall back to the <c>this</c> still visible in the
    /// current lexical scope — the enclosing instance method's <c>this</c>,
    /// which the lambda's child scope inherits and which capture analysis
    /// already captures into the display class (mirroring explicit
    /// <c>this.X</c> and bare field/property reads). In a static context no
    /// <c>this</c> is in scope, so this returns <see langword="null"/> and the
    /// bare-name method-group path stays unchanged.
    /// </summary>
    private ParameterSymbol? GetEffectiveThisParameter()
    {
        if (binderCtx.InConstructorInitializer)
        {
            return null;
        }

        var current = getCurrentFunction();
        if (current?.ThisParameter != null)
        {
            return current.ThisParameter;
        }

        return scope.TryLookupSymbol("this") as ParameterSymbol;
    }

    private StructSymbol? GetConstructorInitializerReceiverType()
    {
        return (function?.ReceiverType as StructSymbol)
            ?? ((scope.TryLookupSymbol("this") as ParameterSymbol)?.Type as StructSymbol);
    }

    private bool IsConstructorInitializerInstanceDataMember(string name)
    {
        var receiverType = GetConstructorInitializerReceiverType();
        return receiverType != null
            && (TypeMemberModel.TryGetFieldIncludingInherited(
                    receiverType,
                    name,
                    MemberQuery.Instance(MemberKinds.Field),
                    out _,
                    out _)
                || TypeMemberModel.TryGetProperty(receiverType, name, out _));
    }

    private bool IsConstructorInitializerInstanceMethod(string name)
    {
        var receiverType = GetConstructorInitializerReceiverType();
        return receiverType != null
            && !TypeMemberModel.GetMethods(
                receiverType,
                name,
                MemberQuery.Instance(MemberKinds.Method)).IsDefaultOrEmpty;
    }

    /// <summary>
    /// Issue #2218 follow-up: reports whether <paramref name="receiver"/> IS
    /// the current implicit/explicit <c>this</c> (i.e. an unqualified call,
    /// or an explicit <c>this.Method(...)</c> call) rather than some other
    /// receiver expression that merely happens to share the enclosing type.
    /// Used to gate admission of <c>protected</c>/<c>protected internal</c>
    /// inherited CLR members in <see cref="TryBindInheritedClrInstanceCall"/>:
    /// that helper is shared by the general qualified-accessor call path
    /// (any <c>receiver.Method(...)</c>), so without this check a protected
    /// inherited member would be reachable through an arbitrary receiver,
    /// leaking accessibility outside the derived class.
    /// </summary>
    private bool IsCurrentThisReceiver(BoundExpression? receiver)
    {
        var effThis = GetEffectiveThisParameter();
        return effThis != null
            && receiver is BoundVariableExpression bve
            && ReferenceEquals(bve.Variable, effThis);
    }

    private BoundExpression BindExpressionWithNarrowing(
        ExpressionSyntax syntax,
        Dictionary<AccessPath, TypeSymbol>? frame,
        TypeSymbol? targetType = null)
    {
        if (frame == null)
        {
            return targetType == null
                ? BindExpression(syntax)
                : BindExpression(syntax, targetType);
        }

        binderCtx.NarrowedVariables.Add(frame);
        try
        {
            return targetType == null
                ? BindExpression(syntax)
                : BindExpression(syntax, targetType);
        }
        finally
        {
            binderCtx.NarrowedVariables.RemoveAt(binderCtx.NarrowedVariables.Count - 1);
        }
    }

    // Issue #991: bind a switch-arm `when` guard as a boolean expression. The
    // guard sees the same pattern narrowing / smart-cast frame as the arm body
    // (so `case x is T when …` observes `x` as `T`). A non-bool guard is
    // reported through the standard conversion diagnostic (GS0017).
    private BoundExpression BindGuardExpression(ExpressionSyntax syntax, Dictionary<AccessPath, TypeSymbol>? frame)
    {
        if (frame == null)
        {
            return BindExpression(syntax, TypeSymbol.Bool);
        }

        binderCtx.NarrowedVariables.Add(frame);
        try
        {
            return BindExpression(syntax, TypeSymbol.Bool);
        }
        finally
        {
            binderCtx.NarrowedVariables.RemoveAt(binderCtx.NarrowedVariables.Count - 1);
        }
    }

    internal BoundExpression BindExpression(ExpressionSyntax syntax, TypeSymbol targetType)
    {
        // ADR-0169: guarantee the dispatch-level anchor (see the canBeVoid
        // overload for the BoundErrorExpression exemption rationale).
        var result = BindExpressionWithTargetTypeCore(syntax, targetType);
        if (result is not BoundErrorExpression)
        {
            result.AnchorSyntax(syntax);
        }

        return result;
    }

    private BoundExpression BindExpressionWithTargetTypeCore(ExpressionSyntax syntax, TypeSymbol targetType)
    {
        // Issue #3355: parentheses do not erase the expected type of a
        // general block expression or its trailing value.
        if (syntax is ParenthesizedExpressionSyntax parenthesized)
        {
            return BindExpression(parenthesized.Expression, targetType);
        }

        // ADR-0124 / issue #1024: a `stackalloc [n]T` initialising an
        // unmanaged-pointer target (`*T`, only spellable in an unsafe context)
        // yields the raw `T*` pointer rather than the default `Span<T>`. The
        // target type must reach the stackalloc binder, so intercept before
        // the generic conversion path (which would bind the safe Span<T> form
        // and then fail to convert it to a pointer).
        if (syntax is StackAllocExpressionSyntax stackAlloc && targetType is PointerTypeSymbol)
        {
            return BindStackAllocExpression(stackAlloc, targetType);
        }

        if (TryBindLambdaExpressionWithTargetType(syntax, targetType, out var targetTypedLambda))
        {
            return conversions.BindConversion(syntax.Location, targetTypedLambda, targetType);
        }

        // Issue #3355: prefix statements bind normally; the expected type
        // flows into the trailing expression.
        if (syntax is BlockExpressionSyntax blockExpression)
        {
            return BindBlockExpressionValue(
                blockExpression,
                canBeVoid: false,
                targetType,
                preserveEmptyBlock: true);
        }

        // Issue #1112: a switch-expression honors the target type (C#-style
        // target-typing) — bind it with the target so the result type can be
        // the target when every arm is implicitly convertible to it, then run
        // the standard conversion to shape/validate the overall result.
        if (syntax is SwitchExpressionSyntax switchExpr)
        {
            var boundSwitch = BindSwitchExpression(switchExpr, targetType);
            return conversions.BindConversion(syntax.Location, boundSwitch, targetType);
        }

        // Issue #1158: an if-expression and a ternary conditional likewise honor
        // the target type (C# 9+ target-typed conditional) — bind with the
        // target so sibling arms can unify to it, then run the standard
        // conversion to shape/validate the overall result.
        if (syntax is IfExpressionSyntax ifExpr)
        {
            var boundIf = BindIfExpression(ifExpr, targetType);
            return conversions.BindConversion(syntax.Location, boundIf, targetType);
        }

        // ADR-0151: the `if let` expression honors the target type on exactly
        // the same terms as the plain if-expression above — its branch tails
        // unify against the target before the standard conversion runs.
        if (syntax is IfLetExpressionSyntax ifLetExpr)
        {
            var boundIfLet = BindIfLetExpression(ifLetExpr, targetType);
            return conversions.BindConversion(syntax.Location, boundIfLet, targetType);
        }

        if (syntax is ConditionalExpressionSyntax conditionalExpr)
        {
            var boundConditional = BindConditionalExpression(conditionalExpr, targetType);
            return conversions.BindConversion(syntax.Location, boundConditional, targetType);
        }

        // Issue #1480: a null-coalescing operator (`a ?? b`) likewise honors the
        // contextual target type. When the operand underlyings share no natural
        // common type but both implicitly convert to the target (e.g. sibling
        // classes coalesced at a shared interface), bind with the target so the
        // result is target-typed rather than reported as GS0129.
        if (syntax is BinaryExpressionSyntax binaryExpr
            && binaryExpr.OperatorToken.Kind == SyntaxKind.QuestionQuestionToken)
        {
            var boundCoalesce = BindBinaryExpression(binaryExpr, targetType);
            return conversions.BindConversion(syntax.Location, boundCoalesce, targetType);
        }

        return conversions.BindConversion(syntax, targetType);
    }

    private bool TryBindLambdaExpressionWithTargetType(
        ExpressionSyntax syntax,
        TypeSymbol targetType,
        [NotNullWhen(true)] out BoundExpression? bound)
    {
        // Keep event handlers and assignment RHS binding on one target-typing path.
        // An explicitly typed lambda already has a complete natural shape.
        // Preserve the regular conversion diagnostic for nullable delegate
        // targets instead of replacing it with target-parameter diagnostics.
        bound = null;
        var lambda = syntax as LambdaExpressionSyntax;
        if (lambda is null || targetType is null)
        {
            return false;
        }

        if (targetType is NullableTypeSymbol)
        {
            var allParametersTyped = true;
            foreach (var parameter in lambda.Parameters)
            {
                allParametersTyped &= parameter.Type is not null;
            }

            if (allParametersTyped)
            {
                return false;
            }
        }

        if (!MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(targetType, out var targetFunctionType))
        {
            return false;
        }

        bound = lambdas.BindLambdaExpression(
            Invariant.Required(lambda, "lambda target typing requires lambda syntax"),
            targetFunctionType);
        return true;
    }

    internal BoundExpression BindExpression(ExpressionSyntax syntax, bool canBeVoid = false)
    {
        // Issue #2620: discard context must reach wrappers and tail-if arms,
        // not merely suppress the final void-result check.
        var result = BindExpressionpublic(syntax, canBeVoid);
        if (!canBeVoid && result.Type == TypeSymbol.Void)
        {
            Diagnostics.ReportExpressionMustHaveValue(syntax.Location);
            return new BoundErrorExpression(null);
        }

        // ADR-0169: guarantee the dispatch-level anchor so semantic-model and
        // analyzer queries can resolve this expression by its syntax. Error
        // expressions are exempt: a BoundErrorExpression's null-vs-non-null
        // Syntax is the binder's defer-and-rebind sentinel (e.g. target-typed
        // lambda/conditional retry), so stamping one would trigger spurious
        // re-binds and duplicated diagnostics.
        if (result is not BoundErrorExpression)
        {
            result.AnchorSyntax(syntax);
        }

        return result;
    }

    private BoundExpression BindExpressionpublic(ExpressionSyntax syntax, bool canBeVoid = false)
    {
        switch (syntax.Kind)
        {
            case SyntaxKind.ParenthesizedExpression:
                return BindParenthesizedExpression((ParenthesizedExpressionSyntax)syntax, canBeVoid);
            case SyntaxKind.CheckedExpression:
            case SyntaxKind.UncheckedExpression:
                return BindCheckedExpression((CheckedExpressionSyntax)syntax, canBeVoid);
            case SyntaxKind.LiteralExpression:
                return BindLiteralExpression((LiteralExpressionSyntax)syntax);
            case SyntaxKind.InterpolatedStringExpression:
                return BindInterpolatedStringExpression((InterpolatedStringExpressionSyntax)syntax);
            case SyntaxKind.NameExpression:
                return BindNameExpression((NameExpressionSyntax)syntax);
            case SyntaxKind.AssignmentExpression:
                return BindAssignmentExpression((AssignmentExpressionSyntax)syntax);
            case SyntaxKind.UnaryExpression:
                return BindUnaryExpression((UnaryExpressionSyntax)syntax);
            case SyntaxKind.BinaryExpression:
                return BindBinaryExpression((BinaryExpressionSyntax)syntax);
            case SyntaxKind.CallExpression:
                return overloads.BindCallExpression((CallExpressionSyntax)syntax);
            case SyntaxKind.GenericNameExpression:
                return BindGenericNameExpression((GenericNameExpressionSyntax)syntax);
            case SyntaxKind.ObjectCreationExpression:
                return BindObjectCreationExpression((ObjectCreationExpressionSyntax)syntax);
            case SyntaxKind.CollectionInitializerExpression:
                return BindCollectionInitializerExpression((CollectionInitializerExpressionSyntax)syntax);
            case SyntaxKind.SpreadElementExpression:
                // Spread wrappers are normally consumed by their enclosing
                // array/collection literal binder. Binding the node directly
                // (e.g. a semantic-model query) yields its source expression.
                return BindExpression(((SpreadElementExpressionSyntax)syntax).Expression, canBeVoid);
            case SyntaxKind.AccessorExpression:
                return BindAccessorExpression((AccessorExpressionSyntax)syntax);
            case SyntaxKind.ArrayCreationExpression:
                return BindArrayCreationExpression((ArrayCreationExpressionSyntax)syntax);
            case SyntaxKind.StackAllocExpression:
                return BindStackAllocExpression((StackAllocExpressionSyntax)syntax);
            case SyntaxKind.MapCreationExpression:
                return BindMapCreationExpression((MapCreationExpressionSyntax)syntax);
            case SyntaxKind.IndexExpression:
                return BindIndexExpression((IndexExpressionSyntax)syntax);
            case SyntaxKind.IndexAssignmentExpression:
                return BindIndexAssignmentExpression((IndexAssignmentExpressionSyntax)syntax);
            case SyntaxKind.MemberIndexAssignmentExpression:
                return BindMemberIndexAssignmentExpression((MemberIndexAssignmentExpressionSyntax)syntax);
            case SyntaxKind.MemberFieldAssignmentExpression:
                return BindMemberFieldAssignmentExpression((MemberFieldAssignmentExpressionSyntax)syntax);
            case SyntaxKind.CompoundIndexAssignmentExpression:
                return BindCompoundIndexAssignmentExpression((CompoundIndexAssignmentExpressionSyntax)syntax);
            case SyntaxKind.StructLiteralExpression:
                return BindStructLiteralExpression((StructLiteralExpressionSyntax)syntax);
            case SyntaxKind.AnonymousClassExpression:
                return BindAnonymousClassExpression((AnonymousClassExpressionSyntax)syntax);
            case SyntaxKind.TupleLiteralExpression:
                return BindTupleLiteralExpression((TupleLiteralExpressionSyntax)syntax);
            case SyntaxKind.FunctionLiteralExpression:
                return lambdas.BindFunctionLiteralExpression((FunctionLiteralExpressionSyntax)syntax);
            case SyntaxKind.LambdaExpression:
                // ADR-0074 / issue #714: arrow lambda expression
                // `(x int32) -> body`. Bound to a BoundFunctionLiteralExpression
                // so closure capture, emit, interpreter, and lowering all work
                // through the existing function-literal pipeline.
                return lambdas.BindLambdaExpression((LambdaExpressionSyntax)syntax);
            case SyntaxKind.AwaitExpression:
                return BindAwaitExpression((AwaitExpressionSyntax)syntax);
            case SyntaxKind.SwitchExpression:
                return BindSwitchExpression((SwitchExpressionSyntax)syntax);
            case SyntaxKind.MakeChannelExpression:
                return BindMakeChannelExpression((MakeChannelExpressionSyntax)syntax);
            case SyntaxKind.TypeOfExpression:
                return BindTypeOfExpression((TypeOfExpressionSyntax)syntax);
            case SyntaxKind.SizeOfExpression:
                return BindSizeOfExpression((SizeOfExpressionSyntax)syntax);
            case SyntaxKind.NameOfExpression:
                return BindNameOfExpression((NameOfExpressionSyntax)syntax);
            case SyntaxKind.DefaultExpression:
                return BindDefaultExpression((DefaultExpressionSyntax)syntax);
            case SyntaxKind.FieldAssignmentExpression:
                return BindFieldAssignmentExpression((FieldAssignmentExpressionSyntax)syntax);
            case SyntaxKind.EventSubscriptionExpression:
                return BindEventSubscriptionExpression((EventSubscriptionExpressionSyntax)syntax);
            case SyntaxKind.WithExpression:
                return BindWithExpression((WithExpressionSyntax)syntax);
            case SyntaxKind.NamedArgumentExpression:
                Diagnostics.ReportNamedArgumentOnlyValidForCopy(syntax.Location);
                return new BoundErrorExpression(null);
            case SyntaxKind.RefArgumentExpression:
                // ADR-0060: a ref-kind argument expression is only valid at an
                // argument position; if it surfaces in any other expression
                // context it is rejected here. The call-site binder dispatches
                // to BindRefArgumentExpression directly before reaching this.
                Diagnostics.ReportOutDeclarationOutsideOutArgument(syntax.Location);
                return new BoundErrorExpression(null);
            case SyntaxKind.ConditionalRefArgumentExpression:
                // ADR-0061: a legacy conditional ref-argument expression
                // (with inner ref-kind modifiers) is only valid as the
                // payload of a ref-kind modifier or as the operand of `&`.
                // Those sites dispatch to the dedicated binders below;
                // anywhere else is a hard error.
                Diagnostics.ReportConditionalRefArgumentOutsideRefContext(syntax.Location);
                return new BoundErrorExpression(null);
            case SyntaxKind.ConditionalExpression:
                // ADR-0062: general two-arm conditional in value context.
                // In ref-kind argument payloads and as the operand of `&`,
                // the call sites short-circuit to BindConditionalAddress
                // before reaching this dispatch.
                return BindConditionalExpression((ConditionalExpressionSyntax)syntax);
            case SyntaxKind.IfExpression:
                return BindIfExpression((IfExpressionSyntax)syntax, targetType: null, canBeVoid: canBeVoid);
            case SyntaxKind.IfLetExpression:
                // ADR-0151: value-producing `if let` — see ExpressionBinder.IfLet.cs.
                return BindIfLetExpression((IfLetExpressionSyntax)syntax, targetType: null, canBeVoid: canBeVoid);
            case SyntaxKind.BlockExpression:
                // Issue #3355: block-with-trailing-expression in any value
                // position. Lambda and if branches reuse this binder.
                return BindBlockExpressionValue(
                    (BlockExpressionSyntax)syntax,
                    canBeVoid,
                    preserveEmptyBlock: true);
            case SyntaxKind.ThrowExpression:
                return BindThrowExpression((ThrowExpressionSyntax)syntax);
            case SyntaxKind.IndirectAssignmentExpression:
                return BindIndirectAssignmentExpression((IndirectAssignmentExpressionSyntax)syntax);
            case SyntaxKind.IndirectCompoundAssignmentExpression:
                return BindIndirectCompoundAssignmentExpression((IndirectCompoundAssignmentExpressionSyntax)syntax);
            case SyntaxKind.IsExpression:
                return BindIsExpression((IsExpressionSyntax)syntax);
            case SyntaxKind.AsExpression:
                return BindAsExpression((AsExpressionSyntax)syntax);
            case SyntaxKind.BaseInterfaceCallExpression:
                // ADR-0091 / issue #757: explicit-base interface call
                // `base[IFoo].M(args)`. Binds inside any instance member of
                // a class/struct that implements `IFoo`; the resulting
                // BoundBaseInterfaceCallExpression emits a non-virtual call
                // into the interface's default body.
                return BindBaseInterfaceCallExpression((BaseInterfaceCallExpressionSyntax)syntax);
            case SyntaxKind.BaseClassCallExpression:
                return BindBaseClassCallExpression((BaseClassCallExpressionSyntax)syntax);
            case SyntaxKind.RangeExpression:
                // Issue #1038: a standalone range `lo..hi` (and the open forms)
                // binds to a constructed `System.Range` value.
                return BindStandaloneRange((RangeExpressionSyntax)syntax);
            case SyntaxKind.FromEndIndexExpression:
                // Issue #1038: a bare `^n` from-end marker is only meaningful as
                // an index/range bound (handled inside the index-argument and
                // range binders); surfacing it standalone is rejected (GS0410).
                var bareFromEnd = (FromEndIndexExpressionSyntax)syntax;
                Diagnostics.ReportFromEndMarkerNotAllowedInStandaloneRange(bareFromEnd.HatToken.Location);
                _ = BindExpression(bareFromEnd.Operand);
                return new BoundErrorExpression(null);
            default:
                throw new Exception($"Unexpected syntax {syntax.Kind}");
        }
    }

    private BoundExpression BindParenthesizedExpression(ParenthesizedExpressionSyntax syntax, bool canBeVoid)
    {
        return BindExpression(syntax.Expression, canBeVoid);
    }

    // Issue #1881: `checked(expr)` / `unchecked(expr)` binds the inner
    // expression under the named overflow context — no dedicated bound node
    // is needed (mirrors Roslyn: the context only steers which opcodes the
    // arithmetic/conversions inside pick). Innermost nesting wins via the
    // save/restore scope.
    private BoundExpression BindCheckedExpression(CheckedExpressionSyntax syntax, bool canBeVoid)
    {
        using var scope = binderCtx.PushCheckedContext(syntax.IsChecked);
        return BindExpression(syntax.Expression, canBeVoid);
    }

    private BoundExpression BindNameExpression(NameExpressionSyntax syntax)
    {
        var name = syntax.IdentifierToken.Text;
        if (syntax.IdentifierToken.IsMissing)
        {
            // This means the token was inserted by the parser. We already
            // reported error so we can just return an error expression.
            return new BoundErrorExpression(null);
        }

        if (binderCtx.InConstructorInitializer && name == "this")
        {
            Diagnostics.ReportConstructorInitializerCannotReferenceInstanceMember(
                syntax.IdentifierToken.Location,
                name);
            return new BoundErrorExpression(null);
        }

        var variable = BindVariableReference(name, syntax.IdentifierToken.Location, suppressNotAVariable: true, suppressUndefinedVariable: true);
        if (variable == null)
        {
            if (binderCtx.InConstructorInitializer
                && scope.TryLookupSymbol(name) is ImplicitFieldVariableSymbol or ImplicitPropertyVariableSymbol)
            {
                return new BoundErrorExpression(null);
            }

            if (binderCtx.InConstructorInitializer
                && IsConstructorInitializerInstanceDataMember(name))
            {
                Diagnostics.ReportConstructorInitializerCannotReferenceInstanceMember(
                    syntax.IdentifierToken.Location,
                    name);
                return new BoundErrorExpression(null);
            }

            // Issue #324: a bare identifier naming a free (package-level)
            // function is a method group. In a value context — e.g. assigning
            // to a `func(...)` or `Func[...]` slot — it converts to a delegate
            // over that function. We only synthesize the group here; the
            // conversion classifier decides whether the surrounding context
            // actually accepts it (otherwise a cannot-convert is reported).
            if (TryBindMethodGroup(syntax, out var methodGroup))
            {
                return methodGroup;
            }

            // ADR-0156 Phase 2: a bare identifier may name a top-level global
            // (static field) or function (static method group) of a prior
            // interactive submission's <Program> container, newest submission
            // first. Runs before the static-import fallbacks so prior cells'
            // declarations shadow static-import members, mirroring the
            // evaluator scope chain.
            if (TryBindSubmissionStaticMember(syntax, out var submissionMember))
            {
                return submissionMember;
            }

            // Issue #1201 (C# `using static`): an unqualified identifier may
            // name a `shared` (static) field, property, or method group of a
            // type brought into scope by a type import (`import Ns.Type`). This
            // is the value/method-group analog of the call-site resolution in
            // OverloadResolver and runs only after the name failed to resolve as
            // a variable or free-function method group.
            if (TryBindImportedStaticMember(syntax, out var importedStaticMember))
            {
                return importedStaticMember;
            }

            // Issue #1582: a bare identifier inside an instance method of a G#
            // class that derives from a metadata base may name an inherited CLR
            // instance property/field (e.g. `return Message` in a class deriving
            // from System.Exception). Unqualified inherited METHODS already
            // resolve via the method-group path above; this mirrors that for
            // properties/fields so bare and `this.`-qualified access behave
            // identically for a metadata base, matching a user-defined base.
            if (TryBindInheritedClrInstanceMemberByBareName(syntax.IdentifierToken.Text, out var inheritedClrMember))
            {
                return inheritedClrMember;
            }

            if (binderCtx.InConstructorInitializer
                && IsConstructorInitializerInstanceMethod(name))
            {
                Diagnostics.ReportConstructorInitializerCannotReferenceInstanceMember(
                    syntax.IdentifierToken.Location,
                    name);
                return new BoundErrorExpression(null);
            }

            // Not a method group: surface the suppressed diagnostics.
            if (scope.TryLookupSymbol(name) is null)
            {
                // ADR-0166: a pattern variable read outside the region its
                // match dominates is a definite-assignment error, not an
                // unknown name.
                if (binderCtx.PatternVariableNames.Contains(name))
                {
                    Diagnostics.ReportPatternVariableNotDefinitelyAssigned(syntax.IdentifierToken.Location, name);
                }
                else
                {
                    Diagnostics.ReportUndefinedVariable(syntax.IdentifierToken.Location, name);
                }
            }
            else if (scope.TryLookupSymbol(name) is not VariableSymbol)
            {
                Diagnostics.ReportNotAVariable(syntax.IdentifierToken.Location, name);
            }

            // Issue #721 / ADR-0081: when the unresolved identifier is the
            // literal text `null` and no symbol named `null` exists in scope,
            // synthesise a `nil` literal so that target-type contexts (e.g.
            // `let x string? = null`, `Foo(null)` where `Foo` takes `T?`,
            // and `x == null`) continue to typecheck without cascading
            // errors. The GS0273 "did you mean 'nil'?" diagnostic has
            // already been emitted by ReportUndefinedVariable above.
            if (name == "null" && scope.TryLookupSymbol(name) is null)
            {
                return new BoundLiteralExpression(syntax, value: null);
            }

            return new BoundErrorExpression(null);
        }

        if (variable is ImplicitPropertyVariableSymbol or ImplicitStaticPropertyVariableSymbol
            && AccessibilityChecker.TryGetInaccessibleImplicitMemberRead(
                variable,
                this.function,
                out var propertyOwner,
                out var propertyName,
                out var getterAccessibility))
        {
            var owner = Invariant.Required(
                propertyOwner,
                "an inaccessible implicit property has a declaring owner");
            Diagnostics.ReportMemberInaccessible(
                syntax.IdentifierToken.Location,
                propertyName,
                owner.Name,
                getterAccessibility);
            return new BoundErrorExpression(null);
        }

        if (variable is ImplicitFieldVariableSymbol implicitField)
        {
            // Issue #186 / #175: bare field-name read inside a method fires
            // GS0204 if the underlying field carries `@Obsolete`.
            reportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitField.Field,
                $"{implicitField.StructType.Name}.{implicitField.Field.Name}");

            // Issue #208: apply any [MemberNotNull] post-call narrowing so that
            // `field.Member` accesses after a [MemberNotNull] helper call are
            // accepted without a nil-guard.
            var narrowedFieldType = TryGetNarrowedType(implicitField);
            Func<TypeSymbol, BoundExpression> makeNarrowedField = narrowedType =>
                new BoundFieldAccessExpression(
                    null,
                    new BoundVariableExpression(null, implicitField.Receiver),
                    implicitField.StructType,
                    implicitField.Field,
                    narrowedType);
            return BuildNarrowedRead(
                new BoundFieldAccessExpression(
                    null,
                    new BoundVariableExpression(null, implicitField.Receiver),
                    implicitField.StructType,
                    implicitField.Field),
                implicitField.Field.Type,
                narrowedFieldType,
                makeNarrowedField);
        }

        // Issue #261: bare static field name inside a shared method body.
        if (variable is ImplicitStaticFieldVariableSymbol implicitStaticField)
        {
            reportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitStaticField.Field,
                $"{implicitStaticField.OwnerName}.{implicitStaticField.Field.Name}");

            return implicitStaticField.InterfaceType != null
                ? new BoundFieldAccessExpression(null, implicitStaticField.Field, implicitStaticField.InterfaceType)
                : new BoundFieldAccessExpression(
                    null,
                    receiver: null,
                    implicitStaticField.StructType,
                    implicitStaticField.Field);
        }

        // ADR-0053: bare static property name inside a method body (shared
        // or instance) of the enclosing type.
        if (variable is ImplicitStaticPropertyVariableSymbol implicitStaticProp)
        {
            reportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitStaticProp.Property,
                $"{implicitStaticProp.StructType.Name}.{implicitStaticProp.Property.Name}");

            if (!implicitStaticProp.Property.HasGetter)
            {
                Diagnostics.ReportCannotAssign(syntax.IdentifierToken.Location, implicitStaticProp.Property.Name);
                return new BoundErrorExpression(null);
            }

            return new BoundPropertyAccessExpression(
                null,
                receiver: null,
                implicitStaticProp.StructType,
                implicitStaticProp.Property);
        }

        // Bare property name inside an instance method body resolves to
        // `this.<property>` (analogous to implicit field access).
        if (variable is ImplicitPropertyVariableSymbol implicitProp)
        {
            reportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitProp.Property,
                $"{implicitProp.StructType.Name}.{implicitProp.Property.Name}");

            if (!implicitProp.Property.HasGetter)
            {
                Diagnostics.ReportCannotAssign(syntax.IdentifierToken.Location, implicitProp.Property.Name);
                return new BoundErrorExpression(null);
            }

            return new BoundPropertyAccessExpression(
                null,
                new BoundVariableExpression(null, implicitProp.Receiver),
                implicitProp.StructType,
                implicitProp.Property);
        }

        return BuildNarrowedVariableRead(variable);
    }

    private BoundExpression BuildNarrowedVariableRead(VariableSymbol variable)
    {
        Func<TypeSymbol, BoundExpression> makeNarrowedVariable =
            narrowedType => new BoundVariableExpression(null, variable, narrowedType);
        return BuildNarrowedRead(
            new BoundVariableExpression(null, variable),
            variable.Type,
            TryGetNarrowedType(variable),
            makeNarrowedVariable);
    }

    /// <summary>
    /// Issue #1547: builds a smart-cast-narrowed read from a bare (declared-type)
    /// read and its narrowed static type.
    /// <para>
    /// For a nullable <em>value</em> type (e.g. <c>int32?</c> =
    /// <c>System.Nullable&lt;int32&gt;</c>) narrowed to its underlying type, the
    /// storage slot/field holds a <c>Nullable&lt;T&gt;</c> while the narrowed
    /// static type is the bare <c>T</c>. A plain narrowed load would leave a
    /// <c>Nullable&lt;T&gt;</c> on the stack where <c>T</c> is expected, which
    /// fails ilverify. Instead we wrap the bare read in a synthesized <c>!!</c>
    /// (<see cref="BoundUnaryOperatorKind.NullAssertion"/>), reusing the proven
    /// value-type unwrap emit path (spill → <c>Nullable&lt;T&gt;::get_Value</c>).
    /// The nil-guard already proved the value non-nil, so the assertion can never
    /// throw at runtime.
    /// </para>
    /// <para>
    /// For a nullable <em>reference</em> type the narrowed type and its storage
    /// share the CLR representation, so narrowing is a metadata no-op and the
    /// bare narrowed read is produced unchanged (wrapping in <c>!!</c> would add a
    /// pointless runtime null-check).
    /// </para>
    /// </summary>
    /// <param name="bareRead">A read of the declared (un-narrowed) type.</param>
    /// <param name="declaredType">The variable/member's declared type.</param>
    /// <param name="narrowedType">The narrowed static type, or <c>null</c>.</param>
    /// <param name="makeNarrowedNode">Factory building the narrowed read node for
    /// the reference-nullable (metadata no-op) case.</param>
    /// <returns>The narrowed read (possibly a value-type unwrap).</returns>
    private static BoundExpression BuildNarrowedRead(
        BoundExpression bareRead,
        TypeSymbol declaredType,
        TypeSymbol? narrowedType,
        Func<TypeSymbol, BoundExpression> makeNarrowedNode)
    {
        if (narrowedType == null)
        {
            return bareRead;
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
        if (declaredType is NullableTypeSymbol nullable
            && (NullableLifting.IsValueTypeNullable(nullable)
                || NullableLifting.IsUserValueTypeNullable(nullable))
            && narrowedType is not NullableTypeSymbol)
        {
            // Bind's first arm unconditionally returns non-null for
            // BangBangToken (BoundUnaryOperator.cs), regardless of operandType.
            var op = BoundUnaryOperator.Bind(SyntaxKind.BangBangToken, declaredType)!;
            return new BoundUnaryExpression(null, op, bareRead);
        }

        return makeNarrowedNode(narrowedType);
    }

    private TypeSymbol? TryGetNarrowedType(VariableSymbol variable)
    {
        // Phase 3.C.4: smart-cast narrowing map. Walk the active stack from
        // innermost frame outward — the topmost narrowing wins.
        for (var i = binderCtx.NarrowedVariables.Count - 1; i >= 0; i--)
        {
            if (binderCtx.NarrowedVariables[i].TryGetValue(variable, out var narrowed))
            {
                return Invariant.Required(
                    narrowed,
                    "a variable narrowing map entry has a type");
            }
        }

        return null;
    }

    /// <summary>
    /// ADR-0069 addendum / issue #1180: smart-cast narrowing lookup keyed by an
    /// <see cref="AccessPath"/>. Walks the active frame stack innermost-first so
    /// the topmost narrowing wins, mirroring the variable overload.
    /// </summary>
    /// <param name="path">The stable access path to look up.</param>
    /// <returns>The narrowed type, or <c>null</c> when the path is not narrowed.</returns>
    private TypeSymbol? TryGetNarrowedType(AccessPath path)
    {
        for (var i = binderCtx.NarrowedVariables.Count - 1; i >= 0; i--)
        {
            if (binderCtx.NarrowedVariables[i].TryGetValue(path, out var narrowed))
            {
                return Invariant.Required(
                    narrowed,
                    "a member-path narrowing map entry has a type");
            }
        }

        return null;
    }

    /// <summary>
    /// ADR-0069 addendum / issue #1180: if <paramref name="node"/> reads a
    /// stable member-access path that an active smart-cast frame has narrowed,
    /// returns a copy of the read carrying the narrowed type so downstream
    /// member lookup, overload resolution, conversion, and emit see the tested
    /// type. Returns <paramref name="node"/> unchanged otherwise. The narrowing
    /// never overrides an already-narrowed read (e.g. a <c>[MemberNotNull]</c>
    /// view).
    /// </summary>
    /// <param name="node">A freshly bound field- or property-access read.</param>
    /// <returns>The possibly-narrowed read.</returns>
    private BoundExpression ApplyMemberNarrowing(BoundExpression node)
    {
        if (binderCtx.NarrowedVariables.Count == 0)
        {
            return node;
        }

        var fieldAccess = node as BoundFieldAccessExpression;
        if (fieldAccess != null && fieldAccess.NarrowedType == null)
        {
                if (!SmartCastStability.TryGetStableMemberPath(fieldAccess, out var path, out _))
                {
                    return node;
                }

                var stablePath = Invariant.Required(
                    path,
                    "a successful stable field-path lookup has a path");
                var narrowed = TryGetNarrowedType(stablePath);
                if (narrowed == null)
                {
                    return node;
                }

                var baseRead = new BoundFieldAccessExpression(
                    null,
                    fieldAccess.Receiver,
                    fieldAccess.StructType,
                    fieldAccess.Field,
                    fieldAccess.SubstitutedType,
                    narrowedType: null);
                Func<TypeSymbol, BoundExpression> makeNarrowedField = narrowedType =>
                    new BoundFieldAccessExpression(
                        null,
                        fieldAccess.Receiver,
                        fieldAccess.StructType,
                        fieldAccess.Field,
                        fieldAccess.SubstitutedType,
                        narrowedType);
                return BuildNarrowedRead(
                    baseRead,
                    fieldAccess.SubstitutedType ?? fieldAccess.Field.Type,
                    narrowed,
                    makeNarrowedField);
        }

        var propertyAccess = node as BoundPropertyAccessExpression;
        if (propertyAccess != null && propertyAccess.NarrowedType == null)
        {
                if (!SmartCastStability.TryGetStableMemberPath(propertyAccess, out var path, out _))
                {
                    return node;
                }

                var stablePath = Invariant.Required(
                    path,
                    "a successful stable property-path lookup has a path");
                var narrowed = TryGetNarrowedType(stablePath);
                if (narrowed == null)
                {
                    return node;
                }

                var baseRead = new BoundPropertyAccessExpression(
                    null,
                    propertyAccess.Receiver,
                    propertyAccess.StructType,
                    propertyAccess.Property,
                    propertyAccess.SubstitutedType,
                    narrowedType: null,
                    interfaceType: propertyAccess.InterfaceType);
                Func<TypeSymbol, BoundExpression> makeNarrowedProperty = narrowedType =>
                    new BoundPropertyAccessExpression(
                        null,
                        propertyAccess.Receiver,
                        propertyAccess.StructType,
                        propertyAccess.Property,
                        propertyAccess.SubstitutedType,
                        narrowedType,
                        propertyAccess.InterfaceType);
                return BuildNarrowedRead(
                    baseRead,
                    propertyAccess.SubstitutedType ?? propertyAccess.Property.Type,
                    narrowed,
                    makeNarrowedProperty);
        }

        var clrAccess = node as BoundClrPropertyAccessExpression;
        if (clrAccess == null)
        {
                return node;
        }

        if (!SmartCastStability.TryGetStableMemberPath(clrAccess, out var clrPath, out _))
        {
                return node;
        }

        var stableClrPath = Invariant.Required(
                clrPath,
                "a successful stable CLR member-path lookup has a path");
        var clrNarrowed = TryGetNarrowedType(stableClrPath);
        if (clrNarrowed == null)
        {
                return node;
        }

        var clrBaseRead = new BoundClrPropertyAccessExpression(
                null,
                clrAccess.Receiver,
                clrAccess.Member,
                clrAccess.Type,
                clrAccess.StaticContainerType,
                clrAccess.ConstrainedReceiverTypeParameter,
                clrAccess.ConstrainedInterfaceType);
        Func<TypeSymbol, BoundExpression> makeNarrowedClrProperty = narrowedType =>
            new BoundClrPropertyAccessExpression(
                null,
                clrAccess.Receiver,
                clrAccess.Member,
                narrowedType,
                clrAccess.StaticContainerType,
                clrAccess.ConstrainedReceiverTypeParameter,
                clrAccess.ConstrainedInterfaceType);
        return BuildNarrowedRead(
                clrBaseRead,
                clrAccess.Type,
                clrNarrowed,
                makeNarrowedClrProperty);
    }

    /// <summary>
    /// ADR-0069 / issue #700: when binding an <c>&amp;&amp;</c> expression,
    /// derive the narrowing frame the right operand should bind under from
    /// the (already-bound) left operand. Recognises <c>x is T</c>,
    /// <c>!(x is T)</c>, and nested <c>&amp;&amp;</c> chains; returns
    /// <c>null</c> when no narrowing can be safely inferred.
    /// </summary>
    private Dictionary<AccessPath, TypeSymbol>? TryClassifyTypeTestNarrowingForAnd(BoundExpression boundLeft)
    {
        var (thenFrame, _) = ClassifyTypeTestNarrowing(boundLeft);
        return (thenFrame != null && thenFrame.Count > 0) ? thenFrame : null;
    }

    /// <summary>
    /// ADR-0069 addendum / issue #712: when binding a <c>||</c> expression,
    /// derive the narrowing frame the right operand should bind under from
    /// the (already-bound) left operand. The right operand is only
    /// evaluated when the left was false, so the left operand's
    /// <c>else</c> frame (the negation of its narrowing) applies. This
    /// makes `!(x is T) || f(x)` bind `f(x)` with `x` narrowed to `T`.
    /// </summary>
    private Dictionary<AccessPath, TypeSymbol>? TryClassifyTypeTestNarrowingForOr(BoundExpression boundLeft)
    {
        var (_, elseFrame) = ClassifyTypeTestNarrowing(boundLeft);
        return (elseFrame != null && elseFrame.Count > 0) ? elseFrame : null;
    }

    private static (Dictionary<AccessPath, TypeSymbol>? Then, Dictionary<AccessPath, TypeSymbol>? Else) ClassifyTypeTestNarrowing(BoundExpression condition)
    {
        switch (condition)
        {
            case BoundIsExpression isExpr:
                return (StatementBinder.TryClassifyPatternNarrowing(
                    isExpr.Expression,
                    isExpr.Pattern,
                    allowReadOnlyGlobals: false), null);

            case BoundUnaryExpression unary when unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation:
                {
                    var (inThen, inElse) = ClassifyTypeTestNarrowing(unary.Operand);
                    return (inElse, inThen);
                }

            case BoundBinaryExpression binary when binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd:
                {
                    var (leftThen, _) = ClassifyTypeTestNarrowing(binary.Left);
                    var (rightThen, _) = ClassifyTypeTestNarrowing(binary.Right);
                    if ((leftThen == null || leftThen.Count == 0) && (rightThen == null || rightThen.Count == 0))
                    {
                        return (null, null);
                    }

                    var combined = leftThen == null ? new Dictionary<AccessPath, TypeSymbol>() : new Dictionary<AccessPath, TypeSymbol>(leftThen);
                    if (rightThen != null)
                    {
                        foreach (var kv in rightThen)
                        {
                            combined[kv.Key] = kv.Value;
                        }
                    }

                    return (combined, null);
                }

            case BoundBinaryExpression binary when binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr:
                {
                    // ADR-0069 addendum / issue #712: De Morgan dual of `&&`.
                    // For `A || B`: then = intersection of thenL and thenR
                    // (a narrowing only survives the OR if both operands prove it);
                    // else = elseL ∪ elseR (both operands were false → both
                    // negations apply). This is the expression-level mirror
                    // of the if-condition classifier in StatementBinder.
                    var (leftThen, leftElse) = ClassifyTypeTestNarrowing(binary.Left);
                    var (rightThen, rightElse) = ClassifyTypeTestNarrowing(binary.Right);

                    Dictionary<AccessPath, TypeSymbol>? combinedThen = null;
                    if (leftThen != null && leftThen.Count > 0 && rightThen != null && rightThen.Count > 0)
                    {
                        foreach (var kv in leftThen)
                        {
                            if (rightThen.TryGetValue(kv.Key, out var other) && other == kv.Value)
                            {
                                combinedThen ??= new Dictionary<AccessPath, TypeSymbol>();
                                combinedThen[kv.Key] = kv.Value;
                            }
                        }
                    }

                    Dictionary<AccessPath, TypeSymbol>? combinedElse = null;
                    if ((leftElse != null && leftElse.Count > 0) || (rightElse != null && rightElse.Count > 0))
                    {
                        combinedElse = leftElse == null ? new Dictionary<AccessPath, TypeSymbol>() : new Dictionary<AccessPath, TypeSymbol>(leftElse);
                        if (rightElse != null)
                        {
                            foreach (var kv in rightElse)
                            {
                                combinedElse[kv.Key] = kv.Value;
                            }
                        }
                    }

                    if ((combinedThen == null || combinedThen.Count == 0)
                        && (combinedElse == null || combinedElse.Count == 0))
                    {
                        return (null, null);
                    }

                    return (combinedThen, combinedElse);
                }
        }

        // ADR-0069 addendum / issue #1545: nil-guard leaf. Threads
        // `x == nil` / `x != nil` narrowing into the right operand of
        // `&&`/`||`, mirroring the type-test (`x is T`) cases above. Uses the
        // shared leaf classifier kept in sync with
        // StatementBinder.TryClassifyNilGuard.
        if (SmartCastStability.TryClassifyNilGuardLeaf(condition, restrictBareVariableToLocalsAndParams: true, referenceNullableOnly: true, out var nilTarget, out var nilUnderlying, out var nonNilWhenTrue))
        {
            var nonNilFrame = new Dictionary<AccessPath, TypeSymbol>
            {
                [nilTarget] = Invariant.Required(nilUnderlying, "a classified nil guard has an underlying type"),
            };
            return nonNilWhenTrue ? (nonNilFrame, null) : (null, nonNilFrame);
        }

        return (null, null);
    }

    /// <summary>
    /// Binds a name expression to produce its bound form without side effects
    /// (used by compound assignment fallback to read the current value).
    /// </summary>
    private BoundExpression BindNameExpressionCore(NameExpressionSyntax syntax)
    {
        return BindNameExpression(syntax);
    }

    private static bool IsSignatureCompatibleWithDelegate(FunctionTypeSymbol fn, Type delegateType)
    {
        if (delegateType == null || !typeof(Delegate).IsAssignableFrom(delegateType))
        {
            return false;
        }

        var invoke = delegateType.GetMethodSafe("Invoke");
        if (invoke == null)
        {
            return false;
        }

        var parms = invoke.GetParameters();
        if (parms.Length != fn.ParameterTypes.Length)
        {
            return false;
        }

        for (var i = 0; i < parms.Length; i++)
        {
            if (fn.ParameterTypes[i]?.ClrType != parms[i].ParameterType)
            {
                return false;
            }
        }

        var fnRetClr = fn.ReturnType == TypeSymbol.Void ? typeof(void) : fn.ReturnType?.ClrType;
        return fnRetClr == invoke.ReturnType;
    }

    private static bool TryGetWritableClrMember(MemberInfo? member, [NotNullWhen(true)] out Type? targetType, [NotNullWhen(true)] out TypeSymbol? targetTypeSymbol, out bool writable)
        => TryGetWritableClrMember(member, receiverType: null, out targetType, out targetTypeSymbol, out writable);

    private static bool TryGetWritableClrMember(
        MemberInfo? member,
        TypeSymbol? receiverType,
        [NotNullWhen(true)] out Type? targetType,
        [NotNullWhen(true)] out TypeSymbol? targetTypeSymbol,
        out bool writable)
    {
        switch (member)
        {
            case PropertyInfo p:
                targetType = p.PropertyType;
                targetTypeSymbol = receiverType == null
                    ? ClrNullability.GetPropertyTypeSymbol(p)
                    : MemberLookup.GetClrPropertyTypeSymbol(
                        receiverType,
                        p,
                        projectOnlyWhenSymbolicallyRequired: true);
                writable = p.CanWrite && p.GetSetMethod(nonPublic: false) != null;
                return writable;
            case FieldInfo f:
                targetType = f.FieldType;
                targetTypeSymbol = receiverType == null
                    ? ClrNullability.GetFieldTypeSymbol(f)
                    : MemberLookup.GetClrFieldTypeSymbol(receiverType, f);
                writable = !f.IsInitOnly && !f.IsLiteral;
                return writable;
            default:
                targetType = null;
                targetTypeSymbol = null;
                writable = false;
                return false;
        }
    }

    /// <summary>ADR-0039: Determines whether an expression is an lvalue (can have its address taken).</summary>
    internal static bool IsLvalue(BoundExpression expression)
    {
        if (expression is BoundBlockExpression block)
        {
            return IsLvalue(block.Expression);
        }

        if (expression is BoundConditionalExpression conditional)
        {
            return IsLvalue(conditional.WhenTrue)
                && IsLvalue(conditional.WhenFalse)
                && conditional.WhenTrue.Type == conditional.WhenFalse.Type;
        }

        return expression is BoundVariableExpression
            or BoundFieldAccessExpression
            or BoundIndexExpression
            or BoundDereferenceExpression;
    }

    internal static bool TryGetReadOnlyAddressTarget(
        BoundExpression expression,
        [NotNullWhen(true)] out VariableSymbol? variable)
    {
        switch (expression)
        {
            case BoundBlockExpression block:
                return TryGetReadOnlyAddressTarget(block.Expression, out variable);
            case BoundConditionalExpression conditional:
                return TryGetReadOnlyAddressTarget(conditional.WhenTrue, out variable)
                    || TryGetReadOnlyAddressTarget(conditional.WhenFalse, out variable);
            case BoundVariableExpression { Variable.IsReadOnly: true } readOnly:
                variable = readOnly.Variable;
                return true;
            default:
                variable = null;
                return false;
        }
    }

    /// <summary>
    /// Issue #1238: returns true when <paramref name="syntax"/> (after peeling
    /// any enclosing parentheses) is a target-typeable branchy expression — an
    /// <c>if</c>/<c>else</c> expression, a ternary conditional, or a
    /// <c>switch</c>-expression. Such an expression, when used directly as a
    /// call/constructor argument, must be (re)bound with the corresponding
    /// parameter type as its target so each branch is target-typed (mirroring
    /// the <c>return</c>/typed-<c>let</c> paths).
    /// </summary>
    internal static bool IsTargetTypedBranchyArgumentSyntax(SyntaxNode syntax)
    {
        while (syntax is ParenthesizedExpressionSyntax parenthesized)
        {
            syntax = parenthesized.Expression;
        }

        return syntax is IfExpressionSyntax
            or IfLetExpressionSyntax
            or ConditionalExpressionSyntax
            or SwitchExpressionSyntax
            or BlockExpressionSyntax
            || (syntax is BinaryExpressionSyntax binary
                && binary.OperatorToken.Kind == SyntaxKind.QuestionQuestionToken);
    }

    /// <summary>
    /// Issue #3355: returns true when a block argument's trailing value cannot
    /// be bound before overload resolution supplies a parameter target type.
    /// Prefix statements do not affect that decision.
    /// </summary>
    internal static bool IsTargetDependentBlockArgumentSyntax(ExpressionSyntax syntax)
    {
        while (syntax is ParenthesizedExpressionSyntax parenthesized)
        {
            syntax = parenthesized.Expression;
        }

        if (syntax is not BlockExpressionSyntax block || block.Expression == null)
        {
            return false;
        }

        return IsTargetDependentExpressionSyntax(block.Expression);
    }

    private static bool IsTargetDependentExpressionSyntax(ExpressionSyntax syntax)
    {
        while (syntax is ParenthesizedExpressionSyntax parenthesizedTail)
        {
            syntax = parenthesizedTail.Expression;
        }

        switch (syntax)
        {
            case BlockExpressionSyntax { Expression: { } nestedTail }:
                return IsTargetDependentExpressionSyntax(nestedTail);
            case DefaultExpressionSyntax { TypeClause: null }:
                return true;
            case LambdaExpressionSyntax lambda:
                foreach (var parameter in lambda.Parameters)
                {
                    if (parameter.Type == null)
                    {
                        return true;
                    }
                }

                return IsTargetDependentExpressionSyntax(lambda.Body);
            case ConditionalExpressionSyntax conditional:
                return IsTargetDependentExpressionSyntax(conditional.WhenTrue)
                    || IsTargetDependentExpressionSyntax(conditional.WhenFalse);
            case IfExpressionSyntax ifExpression:
                return IsTargetDependentExpressionSyntax(ifExpression.ThenBlock)
                    || (ifExpression.ElseExpression != null
                        && IsTargetDependentExpressionSyntax(ifExpression.ElseExpression));
            case IfLetExpressionSyntax ifLetExpression:
                return IsTargetDependentExpressionSyntax(ifLetExpression.ThenBlock)
                    || (ifLetExpression.ElseExpression != null
                        && IsTargetDependentExpressionSyntax(ifLetExpression.ElseExpression));
            case SwitchExpressionSyntax switchExpression:
                return switchExpression.Arms.Any(arm =>
                    IsTargetDependentExpressionSyntax(arm.Result));
            case BinaryExpressionSyntax binary
                when binary.OperatorToken.Kind == SyntaxKind.QuestionQuestionToken:
                return IsTargetDependentExpressionSyntax(binary.Left)
                    || IsTargetDependentExpressionSyntax(binary.Right);
            default:
                return false;
        }
    }

    /// <summary>
    /// Issue #3355: checks whether a target-dependent block argument can use
    /// the supplied parameter type without binding it speculatively.
    /// </summary>
    internal static bool CanTargetDependentBlockArgument(ExpressionSyntax syntax, TypeSymbol targetType)
    {
        while (syntax is ParenthesizedExpressionSyntax parenthesized)
        {
            syntax = parenthesized.Expression;
        }

        if (syntax is not BlockExpressionSyntax { Expression: { } tail })
        {
            return CanTargetDependentExpression(syntax, targetType);
        }

        return CanTargetDependentExpression(tail, targetType);
    }

    private static bool CanTargetDependentExpression(ExpressionSyntax syntax, TypeSymbol targetType)
    {
        while (syntax is ParenthesizedExpressionSyntax parenthesizedTail)
        {
            syntax = parenthesizedTail.Expression;
        }

        switch (syntax)
        {
            case BlockExpressionSyntax { Expression: { } nestedTail }:
                return CanTargetDependentExpression(nestedTail, targetType);
            case DefaultExpressionSyntax { TypeClause: null }:
                return targetType != TypeSymbol.Error && targetType != TypeSymbol.Void;
            case LambdaExpressionSyntax lambda:
                var allParametersTyped = true;
                foreach (var parameter in lambda.Parameters)
                {
                    allParametersTyped &= parameter.Type != null;
                }

                if (allParametersTyped)
                {
                    return true;
                }

                if (!MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(targetType, out var functionType)
                    || functionType == null
                    || functionType.Arity != lambda.Parameters.Count)
                {
                    return false;
                }

                for (var i = 0; i < lambda.Parameters.Count; i++)
                {
                    var targetIsVariadic =
                        !functionType.IsVariadic.IsDefaultOrEmpty && functionType.IsVariadic[i];
                    if (lambda.Parameters[i].IsVariadic != targetIsVariadic)
                    {
                        return false;
                    }
                }

                return true;
            case ConditionalExpressionSyntax conditional:
                return CanTargetDependentExpression(conditional.WhenTrue, targetType)
                    && CanTargetDependentExpression(conditional.WhenFalse, targetType);
            case IfExpressionSyntax ifExpression:
                return CanTargetDependentExpression(ifExpression.ThenBlock, targetType)
                    && (ifExpression.ElseExpression == null
                        || CanTargetDependentExpression(ifExpression.ElseExpression, targetType));
            case IfLetExpressionSyntax ifLetExpression:
                return CanTargetDependentExpression(ifLetExpression.ThenBlock, targetType)
                    && (ifLetExpression.ElseExpression == null
                        || CanTargetDependentExpression(ifLetExpression.ElseExpression, targetType));
            case SwitchExpressionSyntax switchExpression:
                return switchExpression.Arms.All(arm =>
                    CanTargetDependentExpression(arm.Result, targetType));
            case BinaryExpressionSyntax binary
                when binary.OperatorToken.Kind == SyntaxKind.QuestionQuestionToken:
                return CanTargetDependentExpression(binary.Left, targetType)
                    && CanTargetDependentExpression(binary.Right, targetType);
            default:
                return true;
        }
    }

    /// <summary>
    /// Issue #1238: detects a deferred branchy-argument placeholder produced by
    /// the if/conditional/switch binders when they could not unify their
    /// branches without a target type. The placeholder is a
    /// <see cref="BoundErrorExpression"/> that retains the original branchy
    /// syntax so the argument-conversion loops can re-bind it against the
    /// resolved parameter type.
    /// </summary>
    internal static bool IsDeferredBranchyArgumentPlaceholder(BoundExpression expression, [NotNullWhen(true)] out ExpressionSyntax? branchySyntax)
    {
        if (expression is BoundErrorExpression { Syntax: ExpressionSyntax syntax }
            && IsTargetTypedBranchyArgumentSyntax(syntax))
        {
            branchySyntax = syntax;
            return true;
        }

        branchySyntax = null;
        return false;
    }

    /// <summary>
    /// Issue #1238: binds a (named-argument-unwrapped) call argument value,
    /// deferring a no-common-type unification failure when the value is a
    /// target-typeable branchy expression (so it can be re-bound against the
    /// resolved parameter type). See <see cref="BinderContext.DeferTargetlessConditional"/>.
    /// </summary>
    internal BoundExpression BindArgumentDeferringBranchy(ExpressionSyntax inner)
    {
        if (IsTargetDependentBlockArgumentSyntax(inner))
        {
            return new BoundErrorExpression(inner);
        }

        if (!IsTargetTypedBranchyArgumentSyntax(inner))
        {
            return BindExpression(inner);
        }

        var previous = binderCtx.DeferTargetlessConditional;
        binderCtx.DeferTargetlessConditional = true;
        try
        {
            return BindExpression(inner);
        }
        finally
        {
            binderCtx.DeferTargetlessConditional = previous;
        }
    }

    private static bool TryGetTaskElementType(TypeSymbol type, [NotNullWhen(true)] out TypeSymbol? element)
    {
        element = null;

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
        if (type is ImportedTypeSymbol importedTask
            && !importedTask.TypeArguments.IsDefaultOrEmpty
            && importedTask.ClrType is System.Type importedTaskClr
            && importedTaskClr.IsGenericType
            && !importedTaskClr.IsGenericTypeDefinition)
        {
            var openDef = importedTaskClr.GetGenericTypeDefinition();
            var openShape = AwaitableShape.Resolve(openDef);
            if (openShape?.ResultType is System.Type openResult
                && openResult.IsGenericParameter
                && ClrTypeUtilities.IsSameAs(openResult.DeclaringType, openDef)
                && openResult.GenericParameterPosition >= 0
                && openResult.GenericParameterPosition < importedTask.TypeArguments.Length)
            {
                element = importedTask.TypeArguments[openResult.GenericParameterPosition];
                return true;
            }
        }

        var clr = type?.ClrType;
        if (clr == null)
        {
            return false;
        }

        // Use the general awaitable-shape resolver: any type with a conforming
        // GetAwaiter()/IsCompleted/GetResult() triple is awaitable (C# spec §12.9.8).
        var shape = AwaitableShape.Resolve(clr);
        if (shape == null)
        {
            return false;
        }

        var resultClrType = shape.ResultType;
        if (resultClrType.IsSameAs(typeof(void)))
        {
            element = TypeSymbol.Void;
        }
        else
        {
            element = TypeSymbol.FromClrType(resultClrType);
        }

        return true;
    }

    internal VariableSymbol? BindVariableReference(string name, TextLocation location)
    {
        return BindVariableReference(name, location, suppressNotAVariable: false);
    }

    internal VariableSymbol? BindVariableReference(string name, TextLocation location, bool suppressNotAVariable)
    {
        return BindVariableReference(name, location, suppressNotAVariable, suppressUndefinedVariable: false);
    }

    internal VariableSymbol? BindVariableReference(string name, TextLocation location, bool suppressNotAVariable, bool suppressUndefinedVariable)
    {
        switch (scope.TryLookupSymbol(name))
        {
            case VariableSymbol variable:
                if (binderCtx.InConstructorInitializer
                    && (name == "this"
                        || variable is ImplicitFieldVariableSymbol
                        || variable is ImplicitPropertyVariableSymbol))
                {
                    Diagnostics.ReportConstructorInitializerCannotReferenceInstanceMember(location, name);
                    return null;
                }

                // Bare implicit fields use the same accessibility as their
                // qualified equivalents. Property reads are checked by
                // BindNameExpression so setter-only access remains valid.
                if (variable is not ImplicitPropertyVariableSymbol
                    and not ImplicitStaticPropertyVariableSymbol
                    && AccessibilityChecker.TryGetInaccessibleImplicitMemberRead(
                        variable,
                        this.function,
                        out var declaringOwner,
                        out var memberName,
                        out var memberAccessibility))
                {
                    var owner = Invariant.Required(
                        declaringOwner,
                        "an inaccessible implicit member has a declaring owner");
                    Diagnostics.ReportMemberInaccessible(
                        location,
                        memberName,
                        owner.Name,
                        memberAccessibility);
                    return null;
                }

                // Issue #3215: a top-level `var p = &x` holds a managed pointer
                // (`*T`). ECMA-335 forbids a byref field signature, so such a
                // variable can never be hoisted to a static field — it lives
                // only as a local slot of the synthesized entry point (see the
                // matching PlanFieldRows carve-out). A declared function or
                // method body therefore has no storage to reach it through;
                // reject the reference with the byref-escape diagnostic instead
                // of failing deep inside emit.
                if (variable is GlobalVariableSymbol && variable.Type is ByRefTypeSymbol
                    && this.function is { IsTopLevelEntryPoint: false })
                {
                    Diagnostics.ReportByRefCannotEscape(
                        location,
                        $"the top-level pointer variable '{name}' cannot be referenced from a function body; a managed pointer (*T) cannot be stored in a global field");
                    return null;
                }

                reportObsoleteUseIfApplicable(location, variable, variable.Name);
                return variable;

            case null:
                if (!suppressUndefinedVariable)
                {
                    Diagnostics.ReportUndefinedVariable(location, name);
                }

                return null;

            default:
                if (!suppressNotAVariable)
                {
                    Diagnostics.ReportNotAVariable(location, name);
                }

                return null;
        }
    }

    private bool TryBindMethodGroup(NameExpressionSyntax syntax, [NotNullWhen(true)] out BoundExpression? methodGroup)
    {
        methodGroup = null;
        var name = syntax.IdentifierToken.Text;

        // ADR-0063 §9: a name may resolve to multiple user-function overloads.
        // Gather every candidate so BindConversion can pick the one matching the
        // target delegate signature. Fall back to TryLookupSymbol for cases
        // where the name maps to a function not surfaced via the function
        // overload tables (legacy lookup behavior).
        var overloads = scope.TryLookupFunctions(name);
        if (!overloads.IsDefaultOrEmpty)
        {
            var usable = ImmutableArray.CreateBuilder<FunctionSymbol>();
            foreach (var candidate in overloads)
            {
                if (!IsMethodGroupCandidateUsable(candidate))
                {
                    continue;
                }

                usable.Add(candidate);
            }

            if (usable.Count == 1)
            {
                return TryBindSingleMethodGroup(syntax, usable[0], out methodGroup);
            }

            if (usable.Count > 1)
            {
                methodGroup = new BoundMethodGroupExpression(syntax, usable.ToImmutable());
                return true;
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
        var enclosing = this.function;
        var effThis = GetEffectiveThisParameter();
        if (effThis != null && effThis.Type is StructSymbol thisStruct)
        {
            var instanceMethods = TypeMemberModel.GetMethods(thisStruct, name, MemberQuery.Instance(MemberKinds.Method));
            if (TryBuildUserMethodGroup(new BoundVariableExpression(null, effThis), instanceMethods, out methodGroup))
            {
                return true;
            }
        }

        if (enclosing != null)
        {
            var enclosingType = (enclosing.ReceiverType as StructSymbol)
                ?? (enclosing.StaticOwnerType as StructSymbol)
                ?? (enclosing.LexicalEnclosingType as StructSymbol);
            if (enclosingType != null)
            {
                var sharedMethods = TypeMemberModel.GetMethods(enclosingType, name, MemberQuery.Static(MemberKinds.Method));
                if (TryBuildUserMethodGroup(receiver: null, sharedMethods, out methodGroup))
                {
                    return true;
                }
            }
        }

        if (scope.TryLookupSymbol(name) is not FunctionSymbol function)
        {
            return false;
        }

        return TryBindSingleMethodGroup(syntax, function, out methodGroup);
    }

    private static bool IsMethodGroupCandidateUsable(FunctionSymbol function)
    {
        if (function.IsInstanceMethod
            || function.IsExtension
            || function.IsStatic
            || function.StaticOwnerType != null
            || function.Package == null)
        {
            return false;
        }

        foreach (var parameter in function.Parameters)
        {
            if (parameter.IsVariadic)
            {
                return false;
            }
        }

        return true;
    }

    private bool TryBindSingleMethodGroup(NameExpressionSyntax syntax, FunctionSymbol function, [NotNullWhen(true)] out BoundExpression? methodGroup)
    {
        methodGroup = null;

        if (!IsMethodGroupCandidateUsable(function))
        {
            return false;
        }

        if (function.IsGeneric)
        {
            methodGroup = new BoundMethodGroupExpression(syntax, ImmutableArray.Create(function));
            return true;
        }

        var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(function.Parameters.Length);
        foreach (var parameter in function.Parameters)
        {
            parameterTypes.Add(parameter.Type);
        }

        var fnType = FunctionTypeSymbol.Get(parameterTypes.MoveToImmutable(), this.MethodGroupObservableReturnType(function));
        methodGroup = new BoundMethodGroupExpression(syntax, function, fnType);
        return true;
    }

    /// <summary>
    /// Issue #530: returns the effective CLR <see cref="Type"/> to use when
    /// matching an argument in overload resolution. Delegates to
    /// <see cref="NullableTypeSymbol.GetEffectiveClrType"/>.
    /// </summary>
    internal Type? GetEffectiveArgumentClrType(TypeSymbol typeSymbol)
    {
        return NullableTypeSymbol.GetEffectiveClrType(typeSymbol);
    }

    /// <summary>
    /// Issue #658: returns a CLR <see cref="Type"/> suitable for overload
    /// resolution even for user-defined G# class types (whose
    /// <see cref="TypeSymbol.ClrType"/> is null at bind time). For such types
    /// the imported base type's CLR type is returned (or <c>typeof(object)</c>
    /// if none). Regular types delegate to
    /// <see cref="GetEffectiveArgumentClrType"/>.
    /// </summary>
    internal Type? GetEffectiveArgumentClrTypeForOverloadResolution(TypeSymbol typeSymbol)
    {
        var clrType = GetEffectiveArgumentClrType(typeSymbol);
        if (clrType != null)
        {
            return clrType;
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
        if (typeSymbol is TypeParameterSymbol)
        {
            return typeof(object);
        }

        if (typeSymbol is NullableTypeSymbol { UnderlyingType: TypeParameterSymbol })
        {
            return typeof(object);
        }

        // Issue #2614: a by-ref source type with no CLR identity still rides
        // through the same erased CLR type as its pointee.
        if (typeSymbol is ByRefTypeSymbol byRef)
        {
            return GetEffectiveArgumentClrTypeForOverloadResolution(byRef.PointeeType)?.MakeByRefType();
        }

        // Issue #2838: a pointer whose pointee has no CLR identity — canonically
        // `*T` under `T : unmanaged`, produced by `fixed p *T = span` — likewise
        // rides through its pointee's erasure. Without this the pointer argument
        // yielded no effective CLR type at all, so overload resolution never ran
        // and an imported generic call over it (e.g. `Vector256.Load(p)`) dead-
        // ended with GS0159. The inferred `object` erasure is re-projected back
        // to the symbolic type argument by the same recovery step that handles
        // every other erased inference.
        if (typeSymbol is PointerTypeSymbol pointer)
        {
            var pointeeClr = GetEffectiveArgumentClrTypeForOverloadResolution(pointer.PointeeType);
            if (pointeeClr != null && !pointeeClr.IsByRef)
            {
                return pointeeClr.MakePointerType();
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
        if (typeSymbol is SliceTypeSymbol slice)
        {
            var elementClr = GetEffectiveArgumentClrTypeForOverloadResolution(slice.ElementType);
            if (elementClr != null && !elementClr.IsByRef && !elementClr.IsPointer)
            {
                return elementClr.MakeArrayType();
            }
        }

        if (typeSymbol is RectangularArrayTypeSymbol rectangular)
        {
            var elementClr = GetEffectiveArgumentClrTypeForOverloadResolution(rectangular.ElementType);
            if (elementClr != null && !elementClr.IsByRef && !elementClr.IsPointer)
            {
                return elementClr.MakeArrayType(rectangular.Rank);
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
        if (typeSymbol is MapTypeSymbol openMapArg)
        {
            var keyClr = GetEffectiveArgumentClrTypeForOverloadResolution(openMapArg.KeyType);
            var valueClr = GetEffectiveArgumentClrTypeForOverloadResolution(openMapArg.ValueType);
            if (keyClr != null && valueClr != null
                && !keyClr.IsByRef && !keyClr.IsPointer
                && !valueClr.IsByRef && !valueClr.IsPointer)
            {
                return typeof(System.Collections.Generic.Dictionary<,>).MakeGenericType(keyClr, valueClr);
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
        if (typeSymbol is NullableTypeSymbol { UnderlyingType: StructSymbol { IsClass: true } nullableUserClass })
        {
            return nullableUserClass.ImportedBaseType?.ClrType ?? typeof(object);
        }

        // A nullable user value struct / interface / named delegate rides
        // through the same `object` boundary as its non-nullable form.
        if (typeSymbol is NullableTypeSymbol { UnderlyingType: StructSymbol }
            || typeSymbol is NullableTypeSymbol { UnderlyingType: InterfaceSymbol }
            || typeSymbol is NullableTypeSymbol { UnderlyingType: DelegateTypeSymbol })
        {
            return typeof(object);
        }

        // User-defined G# class: provide the imported base type's CLR type
        // so that overload resolution can proceed (base-class assignability
        // and the supplementary interface check handle the rest).
        if (typeSymbol is StructSymbol { IsClass: true } ss)
        {
            return ss.ImportedBaseType?.ClrType ?? typeof(object);
        }

        // ADR-0087 §3 R5 / issue #765: a user-defined G# data struct (value
        // type) appearing as an argument to an imported CLR generic method —
        // typically `List[Box[int32]]::Add(object)` — needs an effective CLR
        // type for overload resolution. The closed CLR shape was erased to
        // `object` upstream, so `object` is the correct ride-through. The
        // emitter materialises the right TypeSpec parent for the call.
        if (typeSymbol is StructSymbol)
        {
            return typeof(object);
        }

        // ADR-0087 §3 R5: a user-defined G# interface or named delegate
        // argument rides through the same `object` boundary as a struct.
        if (typeSymbol is InterfaceSymbol || typeSymbol is DelegateTypeSymbol)
        {
            return typeof(object);
        }

        // Issue #661: user-defined G# enum — backed by int32 at the CLR level.
        if (typeSymbol is EnumSymbol)
        {
            return typeof(int);
        }

        // Issue #661: Nullable<UserEnum> — the underlying enum has no ClrType,
        // so GetEffectiveClrType returns null. Map to Nullable<int>.
        if (typeSymbol is NullableTypeSymbol { UnderlyingType: EnumSymbol })
        {
            return typeof(int?);
        }

        if ((typeSymbol is TupleTypeSymbol
                or NullableTypeSymbol { UnderlyingType: TupleTypeSymbol })
            && MemberLookup.TryProjectErasedClrType(typeSymbol, out var erasedTuple))
        {
            // Issue #3087: imported instance-method applicability still needs
            // the full erased ValueTuple shape when an element is symbolic.
            return erasedTuple;
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
        var functionType = typeSymbol as FunctionTypeSymbol
            ?? (typeSymbol as NullableTypeSymbol)?.UnderlyingType as FunctionTypeSymbol;
        if (functionType != null
            && TryBuildErasedDelegateClrType(functionType, out var erasedDelegate))
        {
            return erasedDelegate;
        }

        return null;
    }

    internal static Func<int, IReadOnlyList<Type>, (Type[] Parameters, Type Return)?>? MakeMethodGroupInference(
        IReadOnlyList<BoundExpression> arguments,
        Func<TypeSymbol, Type?> projectType,
        int argumentOffset = 0)
    {
        if (arguments == null || !arguments.Any(ClrOverloadResolution.IsMethodGroupArgument))
        {
            return null;
        }

        return (argumentIndex, delegateParameterTypes) =>
        {
            var sourceIndex = argumentIndex - argumentOffset;
            if (sourceIndex < 0 || sourceIndex >= arguments.Count)
            {
                return null;
            }

            return ResolveMethodGroupInferenceSignature(arguments[sourceIndex], delegateParameterTypes, projectType);
        };
    }

    internal static Func<int, bool>? MakeMethodGroupArgumentCheck(
        IReadOnlyList<BoundExpression> arguments,
        int argumentOffset = 0)
    {
        if (arguments == null || !arguments.Any(ClrOverloadResolution.IsMethodGroupArgument))
        {
            return null;
        }

        return argumentIndex =>
        {
            var sourceIndex = argumentIndex - argumentOffset;
            return sourceIndex >= 0
                && sourceIndex < arguments.Count
                && ClrOverloadResolution.IsMethodGroupArgument(arguments[sourceIndex]);
        };
    }

    private static (Type[] Parameters, Type Return)? ResolveMethodGroupInferenceSignature(
        BoundExpression argument,
        IReadOnlyList<Type> delegateParameterTypes,
        Func<TypeSymbol, Type?> projectType)
    {
        if (argument is BoundClrMethodGroupExpression clrGroup)
        {
            var receiver = clrGroup.Receiver;
            var closesExtensionReceiver = receiver != null;
            foreach (var candidate in clrGroup.Candidates)
            {
                closesExtensionReceiver &= candidate.IsStatic;
            }

            var resolutionArguments = new Type[delegateParameterTypes.Count + (closesExtensionReceiver ? 1 : 0)];
            if (closesExtensionReceiver)
            {
                // closesExtensionReceiver is only true when the `receiver != null`
                // conjunct above held.
                var receiverClr = projectType(receiver!.Type);
                if (receiverClr == null)
                {
                    return null;
                }

                resolutionArguments[0] = receiverClr;
            }

            for (var i = 0; i < delegateParameterTypes.Count; i++)
            {
                resolutionArguments[i + (closesExtensionReceiver ? 1 : 0)] = delegateParameterTypes[i];
            }

            var resolution = ClrOverloadResolution.Resolve(clrGroup.Candidates, resolutionArguments);
            if (resolution.Outcome != ClrOverloadResolution.ResolutionOutcome.Resolved
                || resolution.Best is not { } method)
            {
                return null;
            }

            var parameters = method.GetParameters();
            var parameterOffset = closesExtensionReceiver ? 1 : 0;
            var signatureParameters = new Type[parameters.Length - parameterOffset];
            for (var i = parameterOffset; i < parameters.Length; i++)
            {
                signatureParameters[i - parameterOffset] = parameters[i].ParameterType;
            }

            return (signatureParameters, method.ReturnType);
        }

        if (argument is not BoundMethodGroupExpression userGroup)
        {
            return null;
        }

        var matches = new List<(FunctionSymbol Method, (Type[] Parameters, Type Return) Signature, ClrOverloadResolution.ImplicitConversionKind[] Conversions)>();
        foreach (var candidate in userGroup.Candidates)
        {
            var candidateOwner = userGroup.StaticOwnerType != null && candidate.StaticOwnerType is StructSymbol declaredOwner
                ? TypeMemberModel.ResolveStaticMemberOwner(userGroup.StaticOwnerType, declaredOwner)
                : null;
            var targetParameterTypes = delegateParameterTypes.Select(TypeSymbol.FromClrType).ToArray();
            if (!TryCloseMethodGroupCandidate(
                candidate,
                userGroup.Receiver,
                candidateOwner,
                targetParameterTypes,
                out var closedParameters,
                out var closedReturn,
                out _))
            {
                continue;
            }

            var parameterTypes = new Type[delegateParameterTypes.Count];
            var conversions = new ClrOverloadResolution.ImplicitConversionKind[delegateParameterTypes.Count];
            var compatible = true;
            for (var i = 0; i < parameterTypes.Length; i++)
            {
                var projected = projectType(closedParameters[i]);
                if (projected == null)
                {
                    compatible = false;
                    break;
                }

                // The method must ACCEPT what the delegate provides:
                // ClassifyImplicit(target, source) with the METHOD parameter
                // as the target admits contravariant groups
                // (`Stringify(object?)` satisfies a `(string) -> string`
                // slot; issue #3501 A5).
                conversions[i] = ClrOverloadResolution.ClassifyImplicit(projected, delegateParameterTypes[i]);
                if (conversions[i] == ClrOverloadResolution.ImplicitConversionKind.None)
                {
                    compatible = false;
                    break;
                }

                parameterTypes[i] = projected;
            }

            if (!compatible)
            {
                continue;
            }

            var returnType = projectType(closedReturn);
            if (returnType == null)
            {
                continue;
            }

            matches.Add((candidate, (parameterTypes, returnType), conversions));
        }

        // Exclude the same source candidate by symbol identity; projected
        // parameter arrays are implementation details, not candidate identity.
        var best = matches.Where(candidate =>
            !matches.Any(other =>
                !ReferenceEquals(candidate.Method, other.Method)
                && IsBetterMethodGroupConversion(other.Conversions, candidate.Conversions))).ToList();
        return best.Count == 1 ? best[0].Signature : null;
    }

    internal static bool TryCloseMethodGroupCandidate(
        FunctionSymbol candidate,
        BoundExpression? receiver,
        StructSymbol? candidateOwner,
        IReadOnlyList<TypeSymbol> targetParameterTypes,
        [NotNullWhen(true)] out TypeSymbol[]? closedParameters,
        [NotNullWhen(true)] out TypeSymbol? closedReturn,
        out ImmutableArray<TypeSymbol> methodTypeArguments)
    {
        closedParameters = null;
        closedReturn = null;
        methodTypeArguments = default;

        var parameterOffset = candidate.IsExtension && receiver != null ? 1 : 0;
        if (candidate.Parameters.Length - parameterOffset != targetParameterTypes.Count)
        {
            return false;
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
        if (candidateOwner == null
            && !candidate.IsExtension
            && receiver?.Type is StructSymbol receiverStruct
            && candidate.ReceiverType is StructSymbol declaredReceiver)
        {
            candidateOwner = TypeMemberModel.ResolveStaticMemberOwner(receiverStruct, declaredReceiver);
        }

        Dictionary<TypeParameterSymbol, TypeSymbol>? substitution = null;
        if (candidate.IsGeneric)
        {
            substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
            if (parameterOffset == 1)
            {
                var receiverParameter = candidateOwner?.SubstituteMemberType(candidate.Parameters[0].Type)
                    ?? candidate.Parameters[0].Type;

                // parameterOffset is 1 only when `candidate.IsExtension && receiver != null` held above.
                Binder.InferTypeArguments(receiverParameter, receiver!.Type, substitution);
            }

            for (var i = 0; i < targetParameterTypes.Count; i++)
            {
                var parameter = candidateOwner?.SubstituteMemberType(candidate.Parameters[i + parameterOffset].Type)
                    ?? candidate.Parameters[i + parameterOffset].Type;
                Binder.InferTypeArguments(parameter, targetParameterTypes[i], substitution);
            }

            var typeArguments = ImmutableArray.CreateBuilder<TypeSymbol>(candidate.TypeParameters.Length);
            foreach (var typeParameter in candidate.TypeParameters)
            {
                if (!substitution.TryGetValue(typeParameter, out var typeArgument)
                    || !Binder.SatisfiesConstraint(typeArgument, typeParameter))
                {
                    return false;
                }

                typeArguments.Add(typeArgument);
            }

            methodTypeArguments = typeArguments.MoveToImmutable();
        }

        closedParameters = new TypeSymbol[targetParameterTypes.Count];
        for (var i = 0; i < closedParameters.Length; i++)
        {
            var parameter = candidateOwner?.SubstituteMemberType(candidate.Parameters[i + parameterOffset].Type)
                ?? candidate.Parameters[i + parameterOffset].Type;
            closedParameters[i] = substitution == null ? parameter : Binder.SubstituteType(parameter, substitution);
        }

        var returnType = candidateOwner?.SubstituteMemberType(candidate.Type) ?? candidate.Type ?? TypeSymbol.Void;
        closedReturn = substitution == null ? returnType : Binder.SubstituteType(returnType, substitution);
        return true;
    }

    private static bool IsBetterMethodGroupConversion(
        IReadOnlyList<ClrOverloadResolution.ImplicitConversionKind> candidate,
        IReadOnlyList<ClrOverloadResolution.ImplicitConversionKind> other)
    {
        var strictlyBetter = false;
        for (var i = 0; i < candidate.Count; i++)
        {
            if (candidate[i] > other[i])
            {
                return false;
            }

            strictlyBetter |= candidate[i] < other[i];
        }

        return strictlyBetter;
    }

    /// <summary>
    /// Issue #1582: resolves the CLR/metadata base type that a user-defined G#
    /// class (transitively) derives from, so inherited CLR members can be
    /// surfaced on instances of the derived type. Walks the user
    /// <see cref="StructSymbol.BaseClass"/> chain and returns the first
    /// <see cref="StructSymbol.ImportedBaseType"/>'s CLR type encountered — the
    /// point where the user inheritance chain meets metadata. From there,
    /// reflection walks the remainder of the CLR base chain, so this covers a
    /// direct metadata base (<c>class A : Exception</c>) as well as a metadata
    /// base reached through one or more user classes (<c>class B : A</c> where
    /// <c>A : Exception</c>). Returns <see langword="null"/> when the class
    /// derives only from other user classes / <c>System.Object</c>.
    /// </summary>
    /// <param name="structSymbol">The user class to resolve the inherited CLR base for.</param>
    /// <returns>The inherited CLR base type, or <see langword="null"/> when there is none.</returns>
    internal static Type? GetInheritedClrBaseType(StructSymbol structSymbol)
    {
        StructSymbol? current = structSymbol;
        while (current != null)
        {
            var clr = current.ImportedBaseType?.ClrType;
            if (clr != null)
            {
                return clr;
            }

            current = current.BaseClass;
        }

        return null;
    }

    /// <summary>
    /// Issue #1582: tries to bind a bare (unqualified) identifier inside an
    /// instance method to an inherited CLR instance property/field of the
    /// enclosing G# class's metadata base. The bound node reads through the
    /// effective <c>this</c> receiver, so it behaves identically to the
    /// <c>this.</c>-qualified access resolved in
    /// <c>ExpressionBinder.Access.cs</c>. Runs only after the name failed to
    /// resolve as a local/parameter/implicit member or a method group.
    /// </summary>
    /// <param name="name">The bare identifier text.</param>
    /// <param name="bound">The bound member access on success.</param>
    /// <returns><see langword="true"/> when an inherited CLR member was bound.</returns>
    private bool TryBindInheritedClrInstanceMemberByBareName(string name, [NotNullWhen(true)] out BoundExpression? bound)
    {
        bound = null;

        if (!TryResolveInheritedClrInstanceMemberByBareName(name, out var receiver, out var member))
        {
            return false;
        }

        switch (member)
        {
            case PropertyInfo clrProp when clrProp.CanRead:
                bound = new BoundClrPropertyAccessExpression(
                    null,
                    receiver,
                    clrProp,
                    GetInheritedClrMemberType(receiver.Type, clrProp, clrProp.PropertyType));
                return true;
            case FieldInfo clrFld:
                bound = new BoundClrPropertyAccessExpression(
                    null,
                    receiver,
                    clrFld,
                    GetInheritedClrMemberType(receiver.Type, clrFld, clrFld.FieldType));
                return true;
            default:
                return false;
        }
    }

    private static TypeSymbol GetInheritedClrMemberType(
        TypeSymbol receiverType,
        MemberInfo member,
        Type reflectedMemberType)
    {
        if (receiverType is StructSymbol receiverStruct)
        {
            for (StructSymbol? current = receiverStruct; current != null; current = current.BaseClass)
            {
                if (current.ImportedBaseType is not ImportedTypeSymbol importedBase
                    || importedBase.OpenDefinition is not { } openDefinition
                    || importedBase.TypeArguments.IsDefaultOrEmpty
                    || member.DeclaringType == null
                    || !member.DeclaringType.IsConstructedGenericType
                    || member.DeclaringType.GetGenericTypeDefinition() != openDefinition)
                {
                    continue;
                }

                MemberInfo? openMember = openDefinition
                    .GetMembers(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                    .FirstOrDefault(candidate =>
                        candidate.MetadataToken == member.MetadataToken
                        && candidate.Module == member.Module);
                Type? openMemberType = openMember switch
                {
                    PropertyInfo property => property.PropertyType,
                    FieldInfo field => field.FieldType,
                    _ => null,
                };
                if (openMemberType != null)
                {
                    var symbolic = MemberLookup.MapOpenClrTypeToSymbolic(
                        openMemberType,
                        openDefinition,
                        importedBase.TypeArguments);
                    if (symbolic != TypeSymbol.Error)
                    {
                        return symbolic;
                    }
                }
            }
        }

        return TypeSymbol.FromClrType(reflectedMemberType);
    }

    /// <summary>
    /// Issue #1584: resolves a bare (unqualified) identifier inside an instance
    /// method to an inherited CLR instance property/field of the enclosing G#
    /// class's metadata base, returning the effective <c>this</c> receiver and
    /// the resolved <see cref="MemberInfo"/>. Shared by the bare-name READ
    /// fallback (<see cref="TryBindInheritedClrInstanceMemberByBareName"/>) and
    /// the bare-name WRITE / COMPOUND-WRITE fallbacks in
    /// <c>ExpressionBinder.Assignments.cs</c> so all three behave identically to
    /// the <c>this.</c>-qualified paths. A property is preferred over a field of
    /// the same name (mirroring the qualified member-lookup order).
    /// </summary>
    /// <param name="name">The bare identifier text.</param>
    /// <param name="receiver">The effective <c>this</c> receiver on success.</param>
    /// <param name="member">The resolved inherited CLR member on success.</param>
    /// <returns><see langword="true"/> when an inherited CLR member was resolved.</returns>
    private bool TryResolveInheritedClrInstanceMemberByBareName(string name, [NotNullWhen(true)] out BoundExpression? receiver, [NotNullWhen(true)] out MemberInfo? member)
    {
        receiver = null;
        member = null;

        var effThis = GetEffectiveThisParameter();
        if (effThis?.Type is not StructSymbol thisStruct)
        {
            return false;
        }

        if (GetInheritedClrBaseType(thisStruct) is not Type clrBase)
        {
            return false;
        }

        member = ClrTypeUtilities.SafeGetInheritedInstanceProperty(clrBase, name);
        member ??= ClrTypeUtilities.SafeGetInheritedInstanceField(clrBase, name);
        if (member == null)
        {
            return false;
        }

        receiver = new BoundVariableExpression(null, effThis);
        return true;
    }

    /// <summary>
    /// Issue #1584: tries to bind a bare (unqualified) simple write
    /// <c>member = value</c> inside an instance method to an inherited CLR
    /// instance property/field of the enclosing G# class's metadata base,
    /// producing a <see cref="BoundClrPropertyAssignmentExpression"/> through the
    /// effective <c>this</c> receiver — identical to the <c>this.member =
    /// value</c> qualified path in <see cref="BindMemberFieldAssignmentExpression"/>.
    /// A resolved-but-unsettable member (get-only property / readonly field)
    /// reports <c>cannot assign</c> rather than GS0125, matching the qualified
    /// path. Runs only after the bare name failed to resolve as a
    /// local/parameter/implicit member.
    /// </summary>
    /// <param name="name">The bare identifier text.</param>
    /// <param name="valueSyntax">The RHS value syntax.</param>
    /// <param name="assignLocation">The location of the assignment operator, for diagnostics.</param>
    /// <param name="bound">The bound assignment (or an error expression) on success.</param>
    /// <returns><see langword="true"/> when an inherited CLR member was resolved.</returns>
    private bool TryBindInheritedClrInstanceMemberWriteByBareName(
        string name,
        ExpressionSyntax valueSyntax,
        TextLocation assignLocation,
        [NotNullWhen(true)] out BoundExpression? bound)
    {
        bound = null;

        if (!TryResolveInheritedClrInstanceMemberByBareName(name, out var receiver, out var member))
        {
            return false;
        }

        if (!TryGetWritableClrMember(member, out _, out var targetSymbol, out _))
        {
            Diagnostics.ReportCannotAssign(assignLocation, name);
            _ = BindExpression(valueSyntax);
            bound = new BoundErrorExpression(null);
            return true;
        }

        var value = BindAssignmentRhs(valueSyntax, targetSymbol);
        var converted = conversions.BindConversion(valueSyntax.Location, value, targetSymbol);
        bound = new BoundClrPropertyAssignmentExpression(null, receiver, member, converted, targetSymbol, staticContainerType: null);
        return true;
    }

    /// <summary>
    /// Issue #903: builds a closed <c>System.Func&lt;…&gt;</c>/<c>System.Action&lt;…&gt;</c>
    /// CLR type for a <see cref="FunctionTypeSymbol"/> whose own
    /// <see cref="TypeSymbol.ClrType"/> is null because one of its parameter or
    /// return types is a same-compilation user type (still being compiled).
    /// Each inner type is erased through
    /// <see cref="GetEffectiveArgumentClrTypeForOverloadResolution"/> (so a
    /// same-compilation struct/class becomes <c>object</c>, an enum becomes
    /// <c>int</c>, etc.) and the closed delegate shape is reconstructed via
    /// <see cref="FunctionTypeSymbol.Get(System.Collections.Immutable.ImmutableArray{TypeSymbol}, TypeSymbol)"/>,
    /// reusing its existing CLR delegate construction. Returns
    /// <see langword="false"/> when any inner type cannot be erased or the
    /// arity has no shipped delegate shape (&gt;16 args).
    /// </summary>
    private bool TryBuildErasedDelegateClrType(FunctionTypeSymbol functionType, [NotNullWhen(true)] out Type? erased)
    {
        erased = null;

        // A variadic function type has no straightforward closed delegate
        // erasure; leave it to the existing fallbacks.
        if (functionType.HasVariadic)
        {
            return false;
        }

        var erasedParameters = ImmutableArray.CreateBuilder<TypeSymbol>(functionType.ParameterTypes.Length);
        foreach (var parameterType in functionType.ParameterTypes)
        {
            var parameterClr = EraseDelegateInnerClrTypeForOverloadResolution(parameterType);
            if (parameterClr == null)
            {
                return false;
            }

            erasedParameters.Add(TypeSymbol.FromClrType(parameterClr));
        }

        TypeSymbol erasedReturn;
        if (FunctionTypeSymbol.IsVoidReturn(functionType.ReturnType))
        {
            erasedReturn = TypeSymbol.Void;
        }
        else
        {
            var returnClr = EraseDelegateInnerClrTypeForOverloadResolution(functionType.ReturnType);
            if (returnClr == null)
            {
                return false;
            }

            erasedReturn = TypeSymbol.FromClrType(returnClr);
        }

        erased = FunctionTypeSymbol.Get(erasedParameters.ToImmutable(), erasedReturn).ClrType;
        return erased != null;
    }

    /// <summary>
    /// Issue #1502: erases an inner parameter/return type of a delegate shape
    /// for overload resolution. Same-compilation user value types (a G# enum or
    /// <c>UserEnum?</c>) have no <see cref="TypeSymbol.ClrType"/>. By default
    /// they ride through as their scalar CLR backing (<c>int</c>/<c>int?</c>,
    /// issue #661) so that LINQ/extension generic-method inference unifies the
    /// lambda parameter with an <c>IEnumerable&lt;int&gt;</c> source. When the
    /// delegate is instead a constructor argument of a constructed-generic type
    /// (e.g. <c>Lazy[Color]</c> closes to <c>Lazy&lt;object&gt;</c> whose ctor
    /// wants <c>Func&lt;object&gt;</c>), value types are not covariant so
    /// <c>Func&lt;int&gt;</c> would mis-resolve; in that context the caller sets
    /// <see cref="eraseDelegateInnerEnumToObject"/> so the enum erases to
    /// <c>object</c> instead. The real type is recovered downstream via the
    /// symbolic delegate-target binding and symbolic ctor emit.
    /// </summary>
    private Type? EraseDelegateInnerClrTypeForOverloadResolution(TypeSymbol typeSymbol)
    {
        if (eraseDelegateInnerEnumToObject
            && typeSymbol.ClrType == null
            && (typeSymbol is EnumSymbol
                || typeSymbol is NullableTypeSymbol { UnderlyingType: EnumSymbol }))
        {
            return typeof(object);
        }

        return GetEffectiveArgumentClrTypeForOverloadResolution(typeSymbol);
    }

    private bool TryBindClrMethodGroup(BoundExpression receiver, Type declaringType, bool wantStatic, string name, [NotNullWhen(true)] out BoundExpression? methodGroup)
    {
        methodGroup = null;

        if (declaringType == null)
        {
            return false;
        }

        var flags = BindingFlags.Public | (wantStatic ? BindingFlags.Static : BindingFlags.Instance);
        var candidates = ImmutableArray.CreateBuilder<MethodInfo>();

        // Issue #529: use interface-aware method enumeration so that
        // methods declared on a base interface are included in the
        // method group for delegate conversions / member access.
        foreach (var method in ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(declaringType, flags))
        {
            if (!ClrTypeUtilities.EmittedMemberNameMatches(method, name))
            {
                continue;
            }

            // Open generic methods and special-name accessors (property/event
            // get_/set_/add_/remove_) are not directly convertible method-group
            // members.
            if (method.IsGenericMethodDefinition || method.IsSpecialName)
            {
                continue;
            }

            candidates.Add(method);
        }

        if (candidates.Count == 0)
        {
            return false;
        }

        methodGroup = new BoundClrMethodGroupExpression(null, receiver, declaringType, name, candidates.ToImmutable());
        return true;
    }

    private BoundExpression BindIsExpression(IsExpressionSyntax syntax)
    {
        var expression = BindExpression(syntax.Expression);
        var pattern = patterns.BindPattern(
            syntax.Pattern,
            expression.Type,
            allowBindings: false,
            preferTypeNames: true);
        var result = new BoundIsExpression(syntax, expression, pattern);

        // ADR-0166: designations are declared by the consumer of the
        // condition (see PatternVariables); here only record the names so a
        // read outside their region reports GS0532, and reject a name bound
        // twice by the same pattern (`{ A: T t, B: U t }`).
        var bindings = PatternVariables.CollectBindings(pattern);
        if (!bindings.IsDefaultOrEmpty)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var variable in bindings)
            {
                binderCtx.PatternVariableNames.Add(variable.Name);
                if (!seen.Add(variable.Name) && variable.DeclaringSyntax is SyntaxNode declaring)
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(declaring.Location, variable.Name);
                }
            }
        }

        return result;
    }

    /// <summary>
    /// ADR-0166: reports every variable in <paramref name="added"/> whose name
    /// already occurs in <paramref name="existing"/> — the C# CS0128 rule for
    /// a pattern variable that would be definitely assigned twice on the same
    /// path (<c>a is T t &amp;&amp; b is U t</c>). Duplicates inside a single
    /// operand were reported when that operand was bound.
    /// </summary>
    private void ReportDuplicatePatternVariables(
        ImmutableArray<LocalVariableSymbol> added,
        ImmutableArray<LocalVariableSymbol> existing)
    {
        if (added.IsDefaultOrEmpty || existing.IsDefaultOrEmpty)
        {
            return;
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var variable in existing)
        {
            seen.Add(variable.Name);
        }

        foreach (var variable in added)
        {
            if (seen.Contains(variable.Name) && variable.DeclaringSyntax is SyntaxNode declaring)
            {
                Diagnostics.ReportSymbolAlreadyDeclared(declaring.Location, variable.Name);
            }
        }
    }

    /// <summary>
    /// ADR-0166: binds <paramref name="bind"/> with <paramref name="variables"/>
    /// declared in a fresh child scope — the region in which those pattern
    /// variables are definitely assigned.
    /// </summary>
    private BoundExpression BindWithPatternVariables(
        ImmutableArray<LocalVariableSymbol> variables,
        Func<BoundExpression> bind)
        => PatternVariables.BindInScope(binderCtx, variables, bind);

    private BoundExpression BindAsExpression(AsExpressionSyntax syntax)
    {
        var expression = BindExpression(syntax.Expression);
        var targetType = bindTypeClause(syntax.TypeClause);
        if (targetType == null || targetType == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        // Per C# §11.11.10: the `as` operator requires that the target type be
        // either a reference type or a nullable value type. A non-nullable value
        // type target is illegal because `as` must be able to yield null on failure.
        if (targetType is not NullableTypeSymbol && IsNonNullableValueType(targetType))
        {
            Diagnostics.ReportAsRequiresReferenceOrNullableType(syntax.Location, targetType.Name);
            return new BoundErrorExpression(null);
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
        TypeSymbol resultType = targetType is NullableTypeSymbol
            ? targetType
            : NullableTypeSymbol.Get(targetType);

        return new BoundAsExpression(syntax, expression, resultType);
    }

    private static bool IsNonNullableValueType(TypeSymbol type)
    {
        if (type is NullableTypeSymbol)
        {
            return false;
        }

        // G# built-in value types.
        if (type == TypeSymbol.Int32 || type == TypeSymbol.Int64 ||
            type == TypeSymbol.Float32 || type == TypeSymbol.Float64 ||
            type == TypeSymbol.Bool || type == TypeSymbol.UInt8 ||
            type == TypeSymbol.Int8 || type == TypeSymbol.Int16 ||
            type == TypeSymbol.UInt16 || type == TypeSymbol.UInt32 ||
            type == TypeSymbol.UInt64 || type == TypeSymbol.Decimal ||
            type == TypeSymbol.Char || type == TypeSymbol.NInt ||
            type == TypeSymbol.NUInt)
        {
            return true;
        }

        // CLR value types resolved via imports.
        if (type.ClrType is { IsValueType: true })
        {
            return true;
        }

        return false;
    }
}
