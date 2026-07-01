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
using System.Linq;
using System.Reflection;
using System.Text;
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
/// <see cref="Binder.SubstituteType"/>,
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
    private readonly Func<TypeClauseSyntax, TypeSymbol> bindTypeClause;
    private readonly Func<string, TypeSymbol> lookupType;
    private readonly Func<TypeSymbol, Type> resolveClrTypeForGenericArg;
    private readonly Action<TextLocation, Symbol, string> reportObsoleteUseIfApplicable;
    private readonly Func<TypeSymbol, bool> isAsyncIteratorReturnType;
    private readonly Func<FunctionSymbol> getCurrentFunction;
    private readonly Func<StatementSyntax, BoundStatement> bindStatement;

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
        Func<TypeClauseSyntax, TypeSymbol> bindTypeClause,
        Func<string, TypeSymbol> lookupType,
        Func<TypeSymbol, Type> resolveClrTypeForGenericArg,
        Action<TextLocation, Symbol, string> reportObsoleteUseIfApplicable,
        Func<TypeSymbol, bool> isAsyncIteratorReturnType,
        Func<FunctionSymbol> getCurrentFunction,
        Func<StatementSyntax, BoundStatement> bindStatement = null)
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
        this.bindStatement = bindStatement;
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
    private FunctionSymbol function => getCurrentFunction();
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
    private ParameterSymbol GetEffectiveThisParameter()
    {
        var current = getCurrentFunction();
        if (current?.ThisParameter != null)
        {
            return current.ThisParameter;
        }

        return scope.TryLookupSymbol("this") as ParameterSymbol;
    }

    private BoundExpression BindExpressionWithNarrowing(ExpressionSyntax syntax, Dictionary<AccessPath, TypeSymbol> frame)
    {
        if (frame == null)
        {
            return BindExpression(syntax);
        }

        binderCtx.NarrowedVariables.Add(frame);
        try
        {
            return BindExpression(syntax);
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
    private BoundExpression BindGuardExpression(ExpressionSyntax syntax, Dictionary<AccessPath, TypeSymbol> frame)
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

    internal BoundExpression BindExpression(ExpressionSyntax syntax, bool canBeVoid = false)
    {
        var result = BindExpressionpublic(syntax);
        if (!canBeVoid && result.Type == TypeSymbol.Void)
        {
            Diagnostics.ReportExpressionMustHaveValue(syntax.Location);
            return new BoundErrorExpression(null);
        }

        return result;
    }

    private BoundExpression BindExpressionpublic(ExpressionSyntax syntax)
    {
        switch (syntax.Kind)
        {
            case SyntaxKind.ParenthesizedExpression:
                return BindParenthesizedExpression((ParenthesizedExpressionSyntax)syntax);
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
                return BindIfExpression((IfExpressionSyntax)syntax);
            case SyntaxKind.ThrowExpression:
                return BindThrowExpression((ThrowExpressionSyntax)syntax);
            case SyntaxKind.IndirectAssignmentExpression:
                return BindIndirectAssignmentExpression((IndirectAssignmentExpressionSyntax)syntax);
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

    private BoundExpression BindParenthesizedExpression(ParenthesizedExpressionSyntax syntax)
    {
        return BindExpression(syntax.Expression);
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

        var variable = BindVariableReference(name, syntax.IdentifierToken.Location, suppressNotAVariable: true, suppressUndefinedVariable: true);
        if (variable == null)
        {
            // Issue #324: a bare identifier naming a free (package-level)
            // function is a method group. In a value context — e.g. assigning
            // to a `func(...)` or `Func[...]` slot — it converts to a delegate
            // over that function. We only synthesize the group here; the
            // conversion classifier decides whether the surrounding context
            // actually accepts it (otherwise a cannot-convert is reported).
            if (TryBindMethodGroup(name, out var methodGroup))
            {
                return methodGroup;
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

            // Not a method group: surface the suppressed diagnostics.
            if (scope.TryLookupSymbol(name) is null)
            {
                Diagnostics.ReportUndefinedVariable(syntax.IdentifierToken.Location, name);
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
            return new BoundFieldAccessExpression(
                null,
                new BoundVariableExpression(null, implicitField.Receiver),
                implicitField.StructType,
                implicitField.Field,
                narrowedFieldType);
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

        return new BoundVariableExpression(null, variable, TryGetNarrowedType(variable));
    }

    private TypeSymbol TryGetNarrowedType(VariableSymbol variable)
    {
        // Phase 3.C.4: smart-cast narrowing map. Walk the active stack from
        // innermost frame outward — the topmost narrowing wins.
        for (var i = binderCtx.NarrowedVariables.Count - 1; i >= 0; i--)
        {
            if (binderCtx.NarrowedVariables[i].TryGetValue(variable, out var narrowed))
            {
                return narrowed;
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
    private TypeSymbol TryGetNarrowedType(AccessPath path)
    {
        if (path == null)
        {
            return null;
        }

        for (var i = binderCtx.NarrowedVariables.Count - 1; i >= 0; i--)
        {
            if (binderCtx.NarrowedVariables[i].TryGetValue(path, out var narrowed))
            {
                return narrowed;
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

        switch (node)
        {
            case BoundFieldAccessExpression fa when fa.NarrowedType == null:
                {
                    if (!SmartCastStability.TryGetStableMemberPath(fa, out var path, out _))
                    {
                        return node;
                    }

                    var narrowed = TryGetNarrowedType(path);
                    return narrowed == null
                        ? node
                        : new BoundFieldAccessExpression(null, fa.Receiver, fa.StructType, fa.Field, narrowed);
                }

            case BoundPropertyAccessExpression pa when pa.NarrowedType == null:
                {
                    if (!SmartCastStability.TryGetStableMemberPath(pa, out var path, out _))
                    {
                        return node;
                    }

                    var narrowed = TryGetNarrowedType(path);
                    return narrowed == null
                        ? node
                        : new BoundPropertyAccessExpression(null, pa.Receiver, pa.StructType, pa.Property, narrowed);
                }

            default:
                return node;
        }
    }

    /// <summary>
    /// ADR-0069 / issue #700: when binding an <c>&amp;&amp;</c> expression,
    /// derive the narrowing frame the right operand should bind under from
    /// the (already-bound) left operand. Recognises <c>x is T</c>,
    /// <c>!(x is T)</c>, and nested <c>&amp;&amp;</c> chains; returns
    /// <c>null</c> when no narrowing can be safely inferred.
    /// </summary>
    private Dictionary<AccessPath, TypeSymbol> TryClassifyTypeTestNarrowingForAnd(BoundExpression boundLeft)
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
    private Dictionary<AccessPath, TypeSymbol> TryClassifyTypeTestNarrowingForOr(BoundExpression boundLeft)
    {
        var (_, elseFrame) = ClassifyTypeTestNarrowing(boundLeft);
        return (elseFrame != null && elseFrame.Count > 0) ? elseFrame : null;
    }

    private static (Dictionary<AccessPath, TypeSymbol> Then, Dictionary<AccessPath, TypeSymbol> Else) ClassifyTypeTestNarrowing(BoundExpression condition)
    {
        switch (condition)
        {
            case BoundIsExpression isExpr:
                {
                    AccessPath targetPath;
                    TypeSymbol declaredType;
                    if (isExpr.Expression is BoundVariableExpression bve
                        && bve.Variable is LocalVariableSymbol or ParameterSymbol)
                    {
                        targetPath = bve.Variable;
                        declaredType = bve.Variable.Type;
                    }
                    else if (SmartCastStability.TryGetStableMemberPath(isExpr.Expression, out targetPath, out declaredType))
                    {
                        // ADR-0069 addendum / issue #1180: stable member path.
                    }
                    else
                    {
                        return (null, null);
                    }

                    var targetType = isExpr.TargetType;
                    if (targetType == null || targetType == TypeSymbol.Error)
                    {
                        return (null, null);
                    }

                    if (targetType is NullableTypeSymbol nts)
                    {
                        targetType = nts.UnderlyingType;
                    }

                    if (targetType == null || targetType == declaredType)
                    {
                        return (null, null);
                    }

                    return (new Dictionary<AccessPath, TypeSymbol> { [targetPath] = targetType }, null);
                }

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

                    Dictionary<AccessPath, TypeSymbol> combinedThen = null;
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

                    Dictionary<AccessPath, TypeSymbol> combinedElse = null;
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
        if (SmartCastStability.TryClassifyNilGuardLeaf(condition, restrictBareVariableToLocalsAndParams: true, out var nilTarget, out var nilUnderlying, out var nonNilWhenTrue))
        {
            var nonNilFrame = new Dictionary<AccessPath, TypeSymbol> { [nilTarget] = nilUnderlying };
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

    private static bool TryGetWritableClrMember(MemberInfo member, out Type targetType, out TypeSymbol targetTypeSymbol, out bool writable)
    {
        switch (member)
        {
            case PropertyInfo p:
                targetType = p.PropertyType;
                targetTypeSymbol = ClrNullability.GetPropertyTypeSymbol(p);
                writable = p.CanWrite && p.GetSetMethod(nonPublic: false) != null;
                return writable;
            case FieldInfo f:
                targetType = f.FieldType;
                targetTypeSymbol = ClrNullability.GetFieldTypeSymbol(f);
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
        return expression is BoundVariableExpression
            or BoundFieldAccessExpression
            or BoundIndexExpression
            or BoundDereferenceExpression;
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
            or ConditionalExpressionSyntax
            or SwitchExpressionSyntax
            || (syntax is BinaryExpressionSyntax binary
                && binary.OperatorToken.Kind == SyntaxKind.QuestionQuestionToken);
    }

    /// <summary>
    /// Issue #1238: detects a deferred branchy-argument placeholder produced by
    /// the if/conditional/switch binders when they could not unify their
    /// branches without a target type. The placeholder is a
    /// <see cref="BoundErrorExpression"/> that retains the original branchy
    /// syntax so the argument-conversion loops can re-bind it against the
    /// resolved parameter type.
    /// </summary>
    internal static bool IsDeferredBranchyArgumentPlaceholder(BoundExpression expression, out ExpressionSyntax branchySyntax)
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

    private static bool TryGetTaskElementType(TypeSymbol type, out TypeSymbol element)
    {
        element = null;
        if (type is ImportedTypeSymbol importedTask
            && !importedTask.TypeArguments.IsDefaultOrEmpty
            && importedTask.TypeArguments.Length == 1
            && importedTask.OpenDefinition?.FullName == "System.Threading.Tasks.Task`1")
        {
            element = importedTask.TypeArguments[0];
            return true;
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

    internal VariableSymbol BindVariableReference(string name, TextLocation location)
    {
        return BindVariableReference(name, location, suppressNotAVariable: false);
    }

    internal VariableSymbol BindVariableReference(string name, TextLocation location, bool suppressNotAVariable)
    {
        return BindVariableReference(name, location, suppressNotAVariable, suppressUndefinedVariable: false);
    }

    internal VariableSymbol BindVariableReference(string name, TextLocation location, bool suppressNotAVariable, bool suppressUndefinedVariable)
    {
        switch (scope.TryLookupSymbol(name))
        {
            case VariableSymbol variable:
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

    private bool TryBindMethodGroup(string name, out BoundExpression methodGroup)
    {
        methodGroup = null;

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
                return TryBindSingleMethodGroup(usable[0], out methodGroup);
            }

            if (usable.Count > 1)
            {
                methodGroup = new BoundMethodGroupExpression(null, usable.ToImmutable());
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
            var enclosingType = (enclosing.ReceiverType as StructSymbol) ?? (enclosing.StaticOwnerType as StructSymbol);
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

        return TryBindSingleMethodGroup(function, out methodGroup);
    }

    private static bool IsMethodGroupCandidateUsable(FunctionSymbol function)
    {
        if (function.IsInstanceMethod
            || function.IsGeneric
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

    private bool TryBindSingleMethodGroup(FunctionSymbol function, out BoundExpression methodGroup)
    {
        methodGroup = null;

        if (!IsMethodGroupCandidateUsable(function))
        {
            return false;
        }

        var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(function.Parameters.Length);
        foreach (var parameter in function.Parameters)
        {
            parameterTypes.Add(parameter.Type);
        }

        var fnType = FunctionTypeSymbol.Get(parameterTypes.MoveToImmutable(), this.MethodGroupObservableReturnType(function));
        methodGroup = new BoundMethodGroupExpression(null, function, fnType);
        return true;
    }

    /// <summary>
    /// Issue #530: returns the effective CLR <see cref="Type"/> to use when
    /// matching an argument in overload resolution. Delegates to
    /// <see cref="NullableTypeSymbol.GetEffectiveClrType"/>.
    /// </summary>
    internal Type GetEffectiveArgumentClrType(TypeSymbol typeSymbol)
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
    internal Type GetEffectiveArgumentClrTypeForOverloadResolution(TypeSymbol typeSymbol)
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
        if (typeSymbol is FunctionTypeSymbol functionType
            && TryBuildErasedDelegateClrType(functionType, out var erasedDelegate))
        {
            return erasedDelegate;
        }

        return null;
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
    private bool TryBuildErasedDelegateClrType(FunctionTypeSymbol functionType, out Type erased)
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
    private Type EraseDelegateInnerClrTypeForOverloadResolution(TypeSymbol typeSymbol)
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

    private bool TryBindClrMethodGroup(BoundExpression receiver, Type declaringType, bool wantStatic, string name, out BoundExpression methodGroup)
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
            if (!string.Equals(method.Name, name, StringComparison.Ordinal))
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
        var targetType = bindTypeClause(syntax.TypeClause);
        if (targetType == null || targetType == TypeSymbol.Error)
        {
            return new BoundErrorExpression(syntax);
        }

        // Unwrap nullable for the purpose of isinst — `is T?` checks against T.
        var checkType = targetType is NullableTypeSymbol nts ? nts.UnderlyingType : targetType;
        _ = checkType; // future: could validate compatibility

        return new BoundIsExpression(syntax, expression, targetType);
    }

    private BoundExpression BindAsExpression(AsExpressionSyntax syntax)
    {
        var expression = BindExpression(syntax.Expression);
        var targetType = bindTypeClause(syntax.TypeClause);
        if (targetType == null || targetType == TypeSymbol.Error)
        {
            return new BoundErrorExpression(syntax);
        }

        // Per C# §11.11.10: the `as` operator requires that the target type be
        // either a reference type or a nullable value type. A non-nullable value
        // type target is illegal because `as` must be able to yield null on failure.
        if (targetType is not NullableTypeSymbol && IsNonNullableValueType(targetType))
        {
            Diagnostics.ReportAsRequiresReferenceOrNullableType(syntax.Location, targetType.Name);
            return new BoundErrorExpression(syntax);
        }

        return new BoundAsExpression(syntax, expression, targetType);
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
