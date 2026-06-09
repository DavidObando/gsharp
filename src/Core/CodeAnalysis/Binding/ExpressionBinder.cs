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
        Func<FunctionSymbol> getCurrentFunction)
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

    private BoundExpression BindExpressionWithNarrowing(ExpressionSyntax syntax, Dictionary<VariableSymbol, TypeSymbol> frame)
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

    internal BoundExpression BindExpression(ExpressionSyntax syntax, TypeSymbol targetType)
    {
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
            case SyntaxKind.ObjectCreationExpression:
                return BindObjectCreationExpression((ObjectCreationExpressionSyntax)syntax);
            case SyntaxKind.AccessorExpression:
                return BindAccessorExpression((AccessorExpressionSyntax)syntax);
            case SyntaxKind.ArrayCreationExpression:
                return BindArrayCreationExpression((ArrayCreationExpressionSyntax)syntax);
            case SyntaxKind.MapCreationExpression:
                return BindMapCreationExpression((MapCreationExpressionSyntax)syntax);
            case SyntaxKind.IndexExpression:
                return BindIndexExpression((IndexExpressionSyntax)syntax);
            case SyntaxKind.IndexAssignmentExpression:
                return BindIndexAssignmentExpression((IndexAssignmentExpressionSyntax)syntax);
            case SyntaxKind.MemberIndexAssignmentExpression:
                return BindMemberIndexAssignmentExpression((MemberIndexAssignmentExpressionSyntax)syntax);
            case SyntaxKind.CompoundIndexAssignmentExpression:
                return BindCompoundIndexAssignmentExpression((CompoundIndexAssignmentExpressionSyntax)syntax);
            case SyntaxKind.StructLiteralExpression:
                return BindStructLiteralExpression((StructLiteralExpressionSyntax)syntax);
            case SyntaxKind.TupleLiteralExpression:
                return BindTupleLiteralExpression((TupleLiteralExpressionSyntax)syntax);
            case SyntaxKind.FunctionLiteralExpression:
                return lambdas.BindFunctionLiteralExpression((FunctionLiteralExpressionSyntax)syntax);
            case SyntaxKind.AwaitExpression:
                return BindAwaitExpression((AwaitExpressionSyntax)syntax);
            case SyntaxKind.SwitchExpression:
                return BindSwitchExpression((SwitchExpressionSyntax)syntax);
            case SyntaxKind.MakeChannelExpression:
                return BindMakeChannelExpression((MakeChannelExpressionSyntax)syntax);
            case SyntaxKind.TypeOfExpression:
                return BindTypeOfExpression((TypeOfExpressionSyntax)syntax);
            case SyntaxKind.NameOfExpression:
                return BindNameOfExpression((NameOfExpressionSyntax)syntax);
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
            case SyntaxKind.IndirectAssignmentExpression:
                return BindIndirectAssignmentExpression((IndirectAssignmentExpressionSyntax)syntax);
            case SyntaxKind.IsExpression:
                return BindIsExpression((IsExpressionSyntax)syntax);
            case SyntaxKind.AsExpression:
                return BindAsExpression((AsExpressionSyntax)syntax);
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

        var variable = BindVariableReference(name, syntax.IdentifierToken.Location, suppressNotAVariable: true);
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

            // Not a method group: surface the suppressed GS0126 (or the
            // undefined-variable diagnostic already reported).
            if (scope.TryLookupSymbol(name) is not null and not VariableSymbol)
            {
                Diagnostics.ReportNotAVariable(syntax.IdentifierToken.Location, name);
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
                $"{implicitStaticField.StructType.Name}.{implicitStaticField.Field.Name}");

            return new BoundFieldAccessExpression(
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

        var invoke = delegateType.GetMethod("Invoke");
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
        if (resultClrType == typeof(void))
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
        switch (scope.TryLookupSymbol(name))
        {
            case VariableSymbol variable:
                reportObsoleteUseIfApplicable(location, variable, variable.Name);
                return variable;

            case null:
                Diagnostics.ReportUndefinedVariable(location, name);
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

    private static bool TryBindSingleMethodGroup(FunctionSymbol function, out BoundExpression methodGroup)
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

        var fnType = FunctionTypeSymbol.Get(parameterTypes.MoveToImmutable(), function.Type ?? TypeSymbol.Void);
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
