// <copyright file="ExpressionBinder.Calls.cs" company="GSharp">
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

internal sealed partial class ExpressionBinder
{
    private BoundExpression BindWithExpression(WithExpressionSyntax syntax)
    {
        var receiver = BindExpression(syntax.Receiver);
        return LowerCopyOrWith(receiver, syntax.Initializers, syntax.WithToken.Location);
    }

    private BoundExpression LowerCopyOrWith(BoundExpression receiver, SeparatedSyntaxList<FieldInitializerSyntax> overrides, TextLocation diagnosticLocation)
    {
        if (receiver.Type == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        if (!(receiver.Type is StructSymbol structType) || !structType.IsData)
        {
            Diagnostics.ReportCopyOrWithNotDataStruct(diagnosticLocation, receiver.Type);
            return new BoundErrorExpression(null);
        }

        var tempName = "$copy" + System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, structType);
        scope.TryDeclareVariable(tempVar);

        var seen = new HashSet<string>();
        var explicitValues = new Dictionary<string, (FieldSymbol Field, StructSymbol DeclaringType, BoundExpression Value)>();
        foreach (var initSyntax in overrides)
        {
            var fieldName = initSyntax.FieldIdentifier.Text;
            if (!seen.Add(fieldName))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(initSyntax.FieldIdentifier.Location, fieldName);
                continue;
            }

            if (!structType.TryGetFieldIncludingInherited(fieldName, out var field, out var declaringType))
            {
                Diagnostics.ReportUnableToFindMember(initSyntax.FieldIdentifier.Location, fieldName);
                continue;
            }

            var valueExpr = BindExpression(initSyntax.Value);
            valueExpr = conversions.BindConversion(initSyntax.Value.Location, valueExpr, field.Type);
            explicitValues[fieldName] = (field, declaringType, valueExpr);
        }

        var initializers = ImmutableArray.CreateBuilder<BoundFieldInitializer>();
        foreach (var field in structType.Fields)
        {
            if (explicitValues.TryGetValue(field.Name, out var explicitValue))
            {
                initializers.Add(new BoundFieldInitializer(explicitValue.Field, explicitValue.Value));
            }
            else
            {
                var access = new BoundFieldAccessExpression(null, new BoundVariableExpression(null, tempVar), structType, field);
                initializers.Add(new BoundFieldInitializer(field, access));
            }
        }

        var declaration = new BoundVariableDeclaration(null, tempVar, receiver);
        var literal = new BoundStructLiteralExpression(null, structType, initializers.ToImmutable());
        return new BoundBlockExpression(null, ImmutableArray.Create<BoundStatement>(declaration), literal);
    }

    private BoundExpression BindObjectCreationExpression(ObjectCreationExpressionSyntax syntax)
    {
        var target = BindExpression(syntax.Target);
        return BindObjectInitializerSuffix(syntax, target);
    }

    /// <summary>
    /// Issue #569: applies the object-initializer suffix to an already-bound
    /// constructor call. Shared by <see cref="BindObjectCreationExpression"/>
    /// (general path) and the accessor-step path for nested-type constructors
    /// with initializer suffixes (<c>Outer.Inner() { Prop = val }</c>).
    /// </summary>
    private BoundExpression BindObjectInitializerSuffix(ObjectCreationExpressionSyntax syntax, BoundExpression target)
    {
        if (target.Type == TypeSymbol.Error || target.Type == null)
        {
            foreach (var init in syntax.Initializers)
            {
                _ = BindExpression(init.Value);
            }

            return new BoundErrorExpression(null);
        }

        var resultType = target.Type;

        var tempName = "$objinit" + System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, resultType);
        scope.TryDeclareVariable(tempVar);

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(new BoundVariableDeclaration(syntax, tempVar, target));

        var seen = new HashSet<string>();
        foreach (var initSyntax in syntax.Initializers)
        {
            var propertyName = initSyntax.PropertyIdentifier.Text;
            if (!seen.Add(propertyName))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(initSyntax.PropertyIdentifier.Location, propertyName);
                continue;
            }

            var assignment = BindObjectInitializerAssignment(tempVar, resultType, initSyntax);
            if (assignment == null)
            {
                continue;
            }

            statements.Add(new BoundExpressionStatement(initSyntax, assignment));
        }

        var resultExpr = new BoundVariableExpression(syntax, tempVar);
        return new BoundBlockExpression(syntax, statements.ToImmutable(), resultExpr);
    }

    private static bool TryGetCopyOverrides(CallExpressionSyntax call, out SeparatedSyntaxList<FieldInitializerSyntax> overrides)
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        foreach (var node in call.Arguments.GetWithSeparators())
        {
            if (node is SyntaxToken token)
            {
                nodesAndSeparators.Add(token);
                continue;
            }

            if (node is NamedArgumentExpressionSyntax named)
            {
                nodesAndSeparators.Add(new FieldInitializerSyntax(named.SyntaxTree, named.NameToken, named.EqualsToken, named.Expression));
                continue;
            }

            overrides = default;
            return false;
        }

        overrides = new SeparatedSyntaxList<FieldInitializerSyntax>(nodesAndSeparators.ToImmutable());
        return true;
    }

    private static ImmutableArray<RefKind> ComputeArgumentRefKinds(System.Reflection.ParameterInfo[] parameters)
    {
        var hasAnyRef = false;
        for (int i = 0; i < parameters.Length; i++)
        {
            if (parameters[i].ParameterType.IsByRef)
            {
                hasAnyRef = true;
                break;
            }
        }

        if (!hasAnyRef)
        {
            return default;
        }

        var builder = ImmutableArray.CreateBuilder<RefKind>(parameters.Length);
        for (int i = 0; i < parameters.Length; i++)
        {
            var p = parameters[i];
            if (!p.ParameterType.IsByRef)
            {
                builder.Add(RefKind.None);
            }
            else if (p.IsOut && !p.IsIn)
            {
                builder.Add(RefKind.Out);
            }
            else if (p.IsIn && !p.IsOut)
            {
                builder.Add(RefKind.In);
            }
            else
            {
                builder.Add(RefKind.Ref);
            }
        }

        return builder.MoveToImmutable();
    }

    internal bool TryBindIntrinsicCall(CallExpressionSyntax syntax, out BoundExpression result)
    {
        result = null;
        var name = syntax.Identifier.Text;
        switch (name)
        {
            case "len":
            case "cap":
            {
                if (syntax.Arguments.Count != 1)
                {
                    Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, name, 1, syntax.Arguments.Count);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                var operand = BindExpression(syntax.Arguments[0]);
                if (operand.Type == TypeSymbol.Error)
                {
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                var ok = operand.Type is ArrayTypeSymbol || operand.Type is SliceTypeSymbol
                    || (name == "len" && (operand.Type == TypeSymbol.String || operand.Type is MapTypeSymbol));
                if (!ok)
                {
                    Diagnostics.ReportIntrinsicArgumentType(syntax.Arguments[0].Location, name, operand.Type);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                result = name == "len"
                    ? new BoundLenExpression(syntax, operand)
                    : new BoundCapExpression(syntax, operand);
                return true;
            }

            case "append":
            {
                if (syntax.Arguments.Count != 2)
                {
                    Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, name, 2, syntax.Arguments.Count);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                var slice = BindExpression(syntax.Arguments[0]);
                if (slice.Type == TypeSymbol.Error)
                {
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                if (slice.Type is not SliceTypeSymbol sliceType)
                {
                    Diagnostics.ReportIntrinsicArgumentType(syntax.Arguments[0].Location, name, slice.Type);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                var element = conversions.BindConversion(syntax.Arguments[1], sliceType.ElementType);
                result = new BoundAppendExpression(syntax, slice, element, sliceType);
                return true;
            }

            case "delete":
            {
                // Phase 3.A.4: `delete(m, k)` removes key `k` from map `m`.
                if (syntax.Arguments.Count != 2)
                {
                    Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, name, 2, syntax.Arguments.Count);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                var mapExpr = BindExpression(syntax.Arguments[0]);
                if (mapExpr.Type == TypeSymbol.Error)
                {
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                if (mapExpr.Type is not MapTypeSymbol mapType)
                {
                    Diagnostics.ReportIntrinsicArgumentType(syntax.Arguments[0].Location, name, mapExpr.Type);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                var keyExpr = conversions.BindConversion(syntax.Arguments[1], mapType.KeyType);
                result = new BoundMapDeleteExpression(syntax, mapExpr, keyExpr);
                return true;
            }

            case "close":
            {
                // Phase 5.4 / ADR-0022: `close(ch)` marks the channel writer complete.
                if (syntax.Arguments.Count != 1)
                {
                    Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, name, 1, syntax.Arguments.Count);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                var chanExpr = BindExpression(syntax.Arguments[0]);
                if (chanExpr.Type == TypeSymbol.Error)
                {
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                if (chanExpr.Type is not ChannelTypeSymbol)
                {
                    Diagnostics.ReportCloseOperandIsNotChannel(syntax.Arguments[0].Location, chanExpr.Type);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                result = new BoundChannelCloseExpression(syntax, chanExpr);
                return true;
            }

            default:
                return false;
        }
    }

    internal bool TryBindClrConstructorCall(CallExpressionSyntax syntax, out BoundExpression result)
    {
        result = null;
        var name = syntax.Identifier.Text;

        System.Type clrType = null;
        System.Type openGenericDefinition = null;
        ImmutableArray<TypeSymbol> symbolicTypeArgs = default;
        if (syntax.TypeArgumentList != null)
        {
            // `List[int]()`, `Dictionary[string, int]()`, etc. Resolve the open
            // generic via imports (mangled `Name`N`) and construct the closed
            // type via Type.MakeGenericType.
            if (!scope.TryLookupImportedGenericClass(name, syntax.TypeArgumentList.Arguments.Count, out var openType))
            {
                return false;
            }

            if (!TryResolveClrConstructionTypeArgs(syntax.TypeArgumentList, out var clrArgs, out symbolicTypeArgs, out var hasSymbolicArg))
            {
                return false;
            }

            try
            {
                clrType = openType.MakeGenericType(clrArgs);
            }
            catch (System.ArgumentException)
            {
                return false;
            }

            // Issue #671: when one or more type arguments is a G# user-defined
            // type (its ClrType is null because the TypeDef is only produced
            // during emit), the closed CLR shape was type-erased to
            // `Open<object,...>`. Keep the openGenericDefinition + the real
            // symbolic args so the emitter can later re-emit the parent
            // TypeSpec using the user-defined TypeDef tokens.
            if (!hasSymbolicArg)
            {
                symbolicTypeArgs = default;
            }
            else
            {
                openGenericDefinition = openType;
            }
        }
        else
        {
            if (!scope.TryLookupImportedClass(name, declaration: null, out var importedClass))
            {
                return false;
            }

            if (importedClass.ClassType.IsGenericTypeDefinition)
            {
                // User wrote `List(...)` without `[T]`; can't construct an open generic.
                return false;
            }

            clrType = importedClass.ClassType;
        }

        return TryBindClrConstructorFromType(clrType, syntax, out result, openGenericDefinition, symbolicTypeArgs);
    }

    /// <summary>
    /// Issue #671: resolves the type arguments on a CLR generic construction
    /// call (<c>List[MyGs]()</c>, <c>Dictionary[string, MyGs]()</c>) into
    /// MakeGenericType-ready CLR types alongside their original symbolic
    /// TypeSymbol forms. A G# user-defined type argument has no
    /// reference-context CLR type (its TypeDef is produced at emit), so it is
    /// closed with a <see cref="object"/> placeholder; the symbolic argument
    /// is preserved so the emitter can re-emit it as its own TypeDef token in
    /// the parent TypeSpec of the resulting MemberRef. Mirrors the
    /// construction-side handling in <see cref="Binder.ConstructIfGeneric"/>
    /// and the generic-method side in
    /// <see cref="TryResolveExplicitMethodTypeArgs"/>.
    /// </summary>
    /// <param name="typeArgumentList">The call's <c>[T1, T2]</c> list.</param>
    /// <param name="clrArgs">On success, the resolved (mapped) CLR type arguments ready for MakeGenericType.</param>
    /// <param name="symbolicArgs">On success, the symbolic type arguments in source order.</param>
    /// <param name="hasSymbolicArg">On success, whether any argument is a G# user-defined type or in-scope type parameter.</param>
    /// <returns>Whether all type arguments resolved.</returns>
    private bool TryResolveClrConstructionTypeArgs(
        TypeArgumentListSyntax typeArgumentList,
        out System.Type[] clrArgs,
        out ImmutableArray<TypeSymbol> symbolicArgs,
        out bool hasSymbolicArg)
    {
        clrArgs = new System.Type[typeArgumentList.Arguments.Count];
        var symbolic = ImmutableArray.CreateBuilder<TypeSymbol>(typeArgumentList.Arguments.Count);
        hasSymbolicArg = false;
        for (var i = 0; i < typeArgumentList.Arguments.Count; i++)
        {
            var ta = bindTypeClause(typeArgumentList.Arguments[i]);
            if (ta == null)
            {
                symbolicArgs = default;
                return false;
            }

            symbolic.Add(ta);

            if (ta.ClrType == null)
            {
                // Issue #313: in-scope type parameter, or issue #671: G#
                // user-defined type whose ClrType is null at bind time.
                // Both project onto System.Object under the type-erased
                // model; the real symbolic argument is preserved separately.
                hasSymbolicArg = true;
                clrArgs[i] = scope.References.GetCoreType("System.Object");
                continue;
            }

            // Issue #671: a nested constructed generic that itself carries
            // symbolic user-defined arguments (e.g. `List[MyGs]` used as an
            // argument to `List[...]`) has a (type-erased) ClrType, but the
            // outer construction must still preserve the symbolic shape so
            // the emitter can recover the user-defined TypeDef tokens at the
            // inner position. Flag the outer as symbolic so the symbolic args
            // are retained, but keep the placeholder CLR type for
            // MakeGenericType (the closed CLR shape erases to
            // `Open<...,object,...>` at the outer level, and the emitter
            // descends through the symbolic args to encode the real shape).
            if (ta is ImportedTypeSymbol nested
                && nested.OpenDefinition != null
                && !nested.TypeArguments.IsDefaultOrEmpty
                && nested.TypeArguments.Any(static a => a.ClrType == null
                    || (a is ImportedTypeSymbol n && n.OpenDefinition != null && !n.TypeArguments.IsDefaultOrEmpty)))
            {
                hasSymbolicArg = true;
            }

            // Project host CLR type arguments onto the resolver's reference
            // set so they share openType's load context (its
            // MetadataLoadContext when references are supplied via /r:),
            // which MakeGenericType requires.
            // Issue #530: use ResolveClrTypeForGenericArg so that `int32?`
            // resolves to `Nullable<int>` (not bare `int`).
            clrArgs[i] = resolveClrTypeForGenericArg(ta) ?? scope.References.MapClrTypeToReferences(ta.ClrType);
        }

        symbolicArgs = symbolic.MoveToImmutable();
        return true;
    }

    /// <summary>
    /// Binds a constructor invocation against an already-resolved CLR
    /// <paramref name="clrType"/>. Shared by the simple-name constructor path
    /// (<see cref="TryBindClrConstructorCall"/>) and the fully-qualified path
    /// (<see cref="TryBindQualifiedClrConstructorCall"/>) so that imported-type
    /// construction resolves identically regardless of how the type name was
    /// written (issue #293).
    /// </summary>
    /// <param name="clrType">The closed CLR type to construct.</param>
    /// <param name="syntax">The call syntax carrying the arguments and location.</param>
    /// <param name="result">The bound constructor call on success.</param>
    /// <param name="openGenericDefinition">
    /// Issue #671: when <paramref name="clrType"/> was closed with a
    /// <see cref="object"/> placeholder for one or more G# user-defined type
    /// arguments, the open generic definition (e.g. <c>List&lt;&gt;</c>) used to
    /// build the closed shape. Combined with <paramref name="symbolicTypeArgs"/>
    /// it lets the emitter re-emit the parent TypeSpec using the user-defined
    /// TypeDef tokens. <see langword="null"/> when no symbolic substitution is
    /// in effect.
    /// </param>
    /// <param name="symbolicTypeArgs">
    /// Issue #671: the original symbolic type arguments in source order, used
    /// alongside <paramref name="openGenericDefinition"/>. Default when no
    /// symbolic substitution is in effect.
    /// </param>
    /// <returns>Whether a constructor was resolved and bound.</returns>
    private bool TryBindClrConstructorFromType(
        System.Type clrType,
        CallExpressionSyntax syntax,
        out BoundExpression result,
        System.Type openGenericDefinition = null,
        ImmutableArray<TypeSymbol> symbolicTypeArgs = default)
    {
        result = null;

        if (clrType.IsAbstract || clrType.IsInterface)
        {
            return false;
        }

        // Issue #343: pre-validate named-argument layout for CLR constructor calls.
        if (!overloads.TryAnalyzeCallArgumentLayout(syntax.Arguments, out _, out var argumentNames))
        {
            result = new BoundErrorExpression(syntax);
            return true;
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
        for (var i = 0; i < syntax.Arguments.Count; i++)
        {
            boundArguments.Add(BindExpression(OverloadResolver.UnwrapNamedArgumentValue(syntax.Arguments[i])));
        }

        // Phase A (overload resolution): pick a constructor via the shared
        // "better function member" resolver. Ambiguity surfaces a hard
        // binder diagnostic and the call falls back to the surrounding
        // pipeline (which will diagnose a missing match).
        var ctors = ClrTypeUtilities.SafeGetConstructors(clrType, BindingFlags.Public | BindingFlags.Instance);
        var argTypes = new System.Type[boundArguments.Count];
        var argsAllTyped = true;
        var hasUserClassArg = false;
        for (var i = 0; i < boundArguments.Count; i++)
        {
            // Issue #530: use GetEffectiveArgumentClrType (see instance method path).
            // Issue #533: allow null (nil literal) to flow through; overload
            // resolution now handles null source as compatible with reference
            // types and Nullable<T>.
            // Issue #658: use the overload-resolution variant that provides a
            // surrogate CLR type for user-defined G# classes (whose ClrType is
            // null at bind time) so overload resolution can proceed.
            var t = GetEffectiveArgumentClrTypeForOverloadResolution(boundArguments[i].Type);
            if (t == null && boundArguments[i].Type != TypeSymbol.Null)
            {
                argsAllTyped = false;
                break;
            }

            if (boundArguments[i].Type is StructSymbol { IsClass: true })
            {
                hasUserClassArg = true;
            }

            argTypes[i] = t;
        }

        ConstructorInfo bestCtor = null;
        ImmutableArray<int> ctorMapping = default;
        bool ctorIsExpanded = false;
        if (argsAllTyped)
        {
            // Issue #658: when any argument is a user-defined G# class, set up
            // the supplementary interface check so ClassifyImplicit recognises
            // the user-class → CLR-interface implicit reference conversion.
            if (hasUserClassArg)
            {
                OverloadResolution.SupplementaryInterfaceCheck = (source, target) =>
                    IsUserClassAssignableToInterface(boundArguments, argTypes, source, target);
            }

            try
            {
                var resolution = OverloadResolution.Resolve(ctors, argTypes, interpolatedStringArgs: ComputeInterpolatedStringArgFlags(syntax.Arguments, boundArguments.Count), argumentNames: argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames);
                switch (resolution.Outcome)
                {
                    case OverloadResolution.ResolutionOutcome.Resolved:
                        bestCtor = resolution.Best;
                        ctorMapping = resolution.ParameterMapping;
                        ctorIsExpanded = resolution.IsExpanded;
                        break;
                    case OverloadResolution.ResolutionOutcome.Ambiguous:
                        Diagnostics.ReportAmbiguousOverload(syntax.Location, clrType.Name, resolution.Ambiguous.Length, resolution.Ambiguous.Select(OverloadResolution.FormatMethodSignature));
                        return false;
                    default:
                        break;
                }
            }
            finally
            {
                if (hasUserClassArg)
                {
                    OverloadResolution.SupplementaryInterfaceCheck = null;
                }
            }
        }

        if (bestCtor == null)
        {
            // Issue #524: CLR value types always have an implicit zero-init
            // default "constructor" — at the IL level that's `initobj T`, not
            // a `newobj` against any `.ctor`. Reflection's
            // `Type.GetConstructors` does NOT surface this synthetic ctor, so
            // overload resolution fails for `T()` on a struct that declares
            // no explicit ctors. Lower the zero-argument case to
            // `BoundDefaultExpression(T)` so the emitter materializes
            // `ldloca/initobj/ldloc`. Reference types (and anything with no
            // declared parameterless ctor) still fall through to the generic
            // "no overload" diagnostic.
            if (syntax.Arguments.Count == 0
                && argumentNames.IsDefault
                && clrType.IsValueType
                && !clrType.IsEnum
                && !clrType.IsPrimitive
                && !clrType.ContainsGenericParameters)
            {
                result = new BoundDefaultExpression(syntax, TypeSymbol.FromClrType(clrType));
                return true;
            }

            // Issue #343: a CLR constructor call that mismatched on a name we
            // can show as "no such parameter" is more actionable than the
            // generic fallback diagnostic.
            if (!argumentNames.IsDefault
                && overloads.TryReportUnknownNamedArgumentForClrConstructor(clrType, syntax, argumentNames))
            {
                result = new BoundErrorExpression(syntax);
                return true;
            }

            return false;
        }

        var ctorParameters = bestCtor.GetParameters();
        var ctorRefKinds = ComputeArgumentRefKinds(ctorParameters);
        var ctorRawArgs = boundArguments.MoveToImmutable();
        var ctorExpandedArgs = ctorIsExpanded
            ? overloads.ExpandParamsArguments(ctorRawArgs, ctorParameters, syntax, parameterMapping: ctorMapping)
            : ctorRawArgs;

        // Issue #506 follow-up: when expanded form fires (with or without
        // named arguments), the expander emits the arguments already in
        // parameter order with optional slots filled — downstream reorderers
        // therefore consume an identity mapping.
        var ctorDownstreamMapping = ctorIsExpanded ? default : ctorMapping;
        var ctorRebound = RebindFormattableInterpolationArguments(ctorExpandedArgs, syntax.Arguments, ctorParameters, ctorDownstreamMapping);
        var ctorHandlerArgs = ApplyInterpolatedStringHandlers(ctorParameters, ctorRebound, receiver: null, syntax.Location, ctorDownstreamMapping);

        // Issue #506 follow-up: fixed-arity CLR ctor overloads expecting an
        // `object` parameter from a value-type argument require a boxing
        // conversion in IL; route through BindClrParameterConversions so the
        // emitter sees a BoundConversionExpression and emits `box <T>`.
        var ctorConvertedArgs = conversions.BindClrParameterConversions(ctorHandlerArgs, ctorParameters, syntax, ctorDownstreamMapping);
        var ctorArgs = OverloadResolver.BuildOrderedCallArguments(ctorConvertedArgs, ctorDownstreamMapping, ctorParameters);
        if (!ctorRefKinds.IsDefault)
        {
            overloads.ValidateRefArguments(ctorArgs, ctorRefKinds, clrType.Name, syntax.Location);
        }

        // Issue #671: when the closed CLR shape was type-erased to fit a G#
        // user-defined type argument, surface the result type as a constructed
        // ImportedTypeSymbol carrying the real symbolic arguments. The emitter
        // uses this to re-emit the parent TypeSpec of the ctor MemberRef with
        // the user-defined TypeDef tokens (so the NEWOBJ targets, e.g.,
        // `List<MyGs>` rather than the erased `List<object>`).
        TypeSymbol resultType;
        if (openGenericDefinition != null && !symbolicTypeArgs.IsDefaultOrEmpty)
        {
            resultType = ImportedTypeSymbol.GetConstructed(clrType, openGenericDefinition, symbolicTypeArgs);
        }
        else
        {
            resultType = TypeSymbol.FromClrType(clrType);
        }

        result = new BoundClrConstructorCallExpression(
            syntax,
            clrType,
            bestCtor,
            ctorArgs,
            resultType,
            ctorRefKinds);
        return true;
    }

    /// <summary>
    /// Issue #569: resolves a nested type constructor call when the call
    /// identifier names a nested type within a containing CLR type.
    /// For example, <c>Outer.Inner()</c> where <c>Inner</c> is a nested class
    /// inside <c>Outer</c>. Supports generic nested types via
    /// <c>Outer.Inner[T]()</c> and deeply-nested types via recursive accessor
    /// chains (<c>Outer.Middle.Inner()</c> is handled by the accessor step
    /// resolving <c>Outer.Middle</c> as a nested type that becomes the new
    /// classSymbol for the terminal call). This unifies the call-expression
    /// path with the type-clause resolution that #526 added.
    /// </summary>
    /// <param name="containingType">The CLR type of the outer class (e.g. <c>Outer</c>).</param>
    /// <param name="syntax">The call expression (identifier = nested type name, args = ctor args).</param>
    /// <param name="result">The bound constructor call on success.</param>
    /// <returns>Whether a nested type was found and a constructor was bound.</returns>
    private bool TryBindNestedTypeConstructorCall(System.Type containingType, CallExpressionSyntax syntax, out BoundExpression result)
    {
        result = null;
        var nestedName = syntax.Identifier.Text;
        var arity = syntax.TypeArgumentList?.Arguments.Count ?? 0;

        System.Type nestedType = null;

        // Try arity-mangled name first for generic nested types (e.g. Inner`1).
        if (arity > 0)
        {
            scope.References.TryResolveNestedType(containingType, nestedName + "`" + arity, out nestedType);
        }

        if (nestedType == null)
        {
            scope.References.TryResolveNestedType(containingType, nestedName, out nestedType);
        }

        if (nestedType == null)
        {
            return false;
        }

        // Close generic nested type if type arguments were provided.
        if (arity > 0 && nestedType.IsGenericTypeDefinition)
        {
            var clrArgs = new System.Type[arity];
            for (var i = 0; i < arity; i++)
            {
                var ta = bindTypeClause(syntax.TypeArgumentList.Arguments[i]);
                if (ta?.ClrType == null)
                {
                    return false;
                }

                clrArgs[i] = scope.References.MapClrTypeToReferences(ta.ClrType);
            }

            try
            {
                nestedType = nestedType.MakeGenericType(clrArgs);
            }
            catch (System.ArgumentException)
            {
                return false;
            }
        }
        else if (nestedType.IsGenericTypeDefinition)
        {
            // Nested type is generic but no type arguments supplied — cannot construct.
            return false;
        }

        return TryBindClrConstructorFromType(nestedType, syntax, out result);
    }

    /// <summary>
    /// Issue #311: resolves the explicit <c>[T1, T2]</c> type-argument list on a
    /// generic-method call site into CLR types projected onto the reference load
    /// context, ready for <see cref="System.Reflection.MethodInfo.MakeGenericMethod"/>.
    /// Mirrors the generic-construction path so primitives and constructed
    /// generics resolve against the target framework's reference assemblies.
    /// </summary>
    /// <param name="typeArgumentList">The call site's explicit type-argument list, or <c>null</c>.</param>
    /// <param name="explicitTypeArgs">On success, the resolved (mapped) CLR type arguments; <c>null</c> when the list is absent.</param>
    /// <param name="typeArgSymbols">
    /// Issue #320: on success, the resolved type-argument <see cref="TypeSymbol"/>s
    /// in source order; default when the list is absent. These carry user-defined
    /// types (which have no reference-context CLR type and are closed with an
    /// <see cref="object"/> placeholder in <paramref name="explicitTypeArgs"/>) so
    /// later stages can recover and emit the real type argument.
    /// </param>
    /// <returns>
    /// <see langword="true"/> when there is no list (no explicit type args) or
    /// every argument resolved; <see langword="false"/> when a type argument
    /// could not be resolved.
    /// </returns>
    private bool TryResolveExplicitMethodTypeArgs(TypeArgumentListSyntax typeArgumentList, out System.Type[] explicitTypeArgs, out ImmutableArray<TypeSymbol> typeArgSymbols)
    {
        explicitTypeArgs = null;
        typeArgSymbols = default;
        if (typeArgumentList == null)
        {
            return true;
        }

        var resolved = new System.Type[typeArgumentList.Arguments.Count];
        var symbols = ImmutableArray.CreateBuilder<TypeSymbol>(typeArgumentList.Arguments.Count);
        for (var i = 0; i < typeArgumentList.Arguments.Count; i++)
        {
            var ta = bindTypeClause(typeArgumentList.Arguments[i]);
            if (ta == null)
            {
                return false;
            }

            symbols.Add(ta);

            if (ta.ClrType != null)
            {
                // BCL / imported type argument. Project onto the resolver's
                // reference set so it shares the open generic method's load
                // context, exactly as the generic-construction path does before
                // MakeGenericType / MakeGenericMethod.
                // Issue #530: use ResolveClrTypeForGenericArg so that
                // `int32?` resolves to `Nullable<int>` (not bare `int`).
                resolved[i] = resolveClrTypeForGenericArg(ta) ?? scope.References.MapClrTypeToReferences(ta.ClrType);
            }
            else
            {
                // Issue #320: a user-defined type (or an in-scope type parameter)
                // has no reference-context CLR type, so it cannot be handed to
                // MakeGenericMethod directly. Close the open method with a
                // reference-context System.Object placeholder so resolution and
                // applicability still run; the real type-argument symbol is
                // preserved in typeArgSymbols and re-emitted as its own TypeDef
                // token in the generic method specification.
                resolved[i] = scope.References.GetCoreType("System.Object");
            }
        }

        explicitTypeArgs = resolved;
        typeArgSymbols = symbols.MoveToImmutable();
        return true;
    }

    /// <summary>
    /// Issue #320: computes a return-type override for an imported generic method
    /// closed over explicit type arguments. When the method's open return type is
    /// exactly one of its method type parameters, the real return type is the
    /// corresponding explicit type-argument symbol (recovering a user-defined type
    /// that was closed with an <see cref="object"/> placeholder). Returns
    /// <see langword="null"/> when no override is needed, so callers keep their
    /// existing return-type derivation.
    /// </summary>
    /// <param name="closed">The closed generic method selected by overload resolution.</param>
    /// <param name="typeArgSymbols">The explicit type-argument symbols, or default.</param>
    /// <returns>The override return type symbol, or <see langword="null"/>.</returns>
    private static TypeSymbol ResolveImportedGenericReturnType(System.Reflection.MethodInfo closed, ImmutableArray<TypeSymbol> typeArgSymbols)
    {
        if (!typeArgSymbols.IsDefaultOrEmpty
            && OverloadResolution.TryGetGenericMethodParameterReturnPosition(closed, out var position)
            && position >= 0
            && position < typeArgSymbols.Length)
        {
            return typeArgSymbols[position];
        }

        return null;
    }

    private BoundExpression BindAccessorCall(BoundExpression receiver, ImportedClassSymbol classSymbol, CallExpressionSyntax ce)
    {
        var methodName = ce.Identifier.Text;
        var hasNamedArguments = ce.Arguments.Any(argument => argument is NamedArgumentExpressionSyntax);
        if (classSymbol == null && methodName == "copy" && (hasNamedArguments || (receiver?.Type is StructSymbol copyStruct && copyStruct.IsData)))
        {
            if (TryGetCopyOverrides(ce, out var overrides))
            {
                return LowerCopyOrWith(receiver, overrides, ce.Identifier.Location);
            }

            Diagnostics.ReportNamedArgumentOnlyValidForCopy(ce.Location);
            return new BoundErrorExpression(null);
        }

        // Issue #343: validate named-argument layout (positional precedes named,
        // no duplicate names). Errors are reported by the helper so the call
        // short-circuits to a bound error here.
        if (!overloads.TryAnalyzeCallArgumentLayout(ce.Arguments, out _, out var argumentNames))
        {
            return new BoundErrorExpression(null);
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>();
        foreach (var argument in ce.Arguments)
        {
            var inner = OverloadResolver.UnwrapNamedArgumentValue(argument);
            if (inner is RefArgumentExpressionSyntax refArg)
            {
                boundArguments.Add(BindRefArgumentExpression(refArg, parameter: null));
            }
            else
            {
                boundArguments.Add(BindExpression(inner));
            }
        }

        var arguments = boundArguments.ToImmutable();

        // Issue #311: resolve an explicit `[T1, T2]` type-argument list (e.g.
        // `Array.Empty[string]()`) into mapped CLR types up front so every
        // generic-method dispatch path below can close the candidate.
        if (!TryResolveExplicitMethodTypeArgs(ce.TypeArgumentList, out var explicitTypeArgs, out var typeArgSymbols))
        {
            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
            return new BoundErrorExpression(null);
        }

        if (classSymbol != null)
        {
            if (classSymbol.TryLookupFunction(methodName, ce, arguments, out var staticFn, out var staticMapping, out var staticAmbiguous, out var staticAmbiguousMethods, out var staticIsExpanded, explicitTypeArgs, typeArgSymbols, scope.References.MapClrTypeToReferences, argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames))
            {
                var staticParameters = staticFn.Method.GetParameters();
                var staticExpandedArgs = staticIsExpanded
                    ? overloads.ExpandParamsArguments(arguments, staticParameters, ce, parameterMapping: staticMapping)
                    : arguments;
                var staticDownstreamMapping = staticIsExpanded ? default : staticMapping;
                var staticRebound = RebindFormattableInterpolationArguments(staticExpandedArgs, ce.Arguments, staticParameters, staticDownstreamMapping);
                var staticHandlerArgs = ApplyInterpolatedStringHandlers(staticParameters, staticRebound, receiver: null, ce.Location, staticDownstreamMapping);

                // Issue #506 follow-up: ensure value-type → object boxing fires
                // for fixed-arity CLR static calls (e.g. `String.Format("{0}", 42)`
                // selecting the fixed `(string, object)` overload).
                var staticConvertedArgs = conversions.BindClrParameterConversions(staticHandlerArgs, staticParameters, ce, staticDownstreamMapping);
                var staticArguments = OverloadResolver.BuildOrderedCallArguments(staticConvertedArgs, staticDownstreamMapping, staticParameters);
                var refKinds = ComputeArgumentRefKinds(staticParameters);
                overloads.ValidateRefArguments(staticArguments, refKinds, methodName, ce.Location);
                return new BoundImportedCallExpression(null, staticFn, staticArguments, refKinds, typeArgSymbols);
            }

            if (staticAmbiguous)
            {
                // Issue #505: surface the competing candidate signatures so the
                // caller can pick a disambiguation (typically an explicit
                // type-argument list).
                Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, staticAmbiguousMethods.Length, staticAmbiguousMethods.Select(OverloadResolution.FormatMethodSignature));
                return new BoundErrorExpression(null);
            }

            // Issue #343: a named-argument call that resolves to no candidate
            // is most actionably explained by the first unknown name (if any),
            // since the missing parameter is the prevailing cause.
            if (!argumentNames.IsDefault && overloads.TryReportUnknownNamedArgumentForClr(classSymbol.ClassType, methodName, BindingFlags.Static | BindingFlags.Instance | BindingFlags.Public, ce, argumentNames))
            {
                return new BoundErrorExpression(null);
            }

            // Issue #569: when no static/instance method matches, check whether
            // the call identifier names a nested type of the outer class. If so,
            // bind as a constructor invocation — this unifies the call-expression
            // path with the type-clause path that #526 already fixed.
            if (TryBindNestedTypeConstructorCall(classSymbol.ClassType, ce, out var nestedCtorResult))
            {
                return nestedCtorResult;
            }

            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
            return new BoundErrorExpression(null);
        }

        if (receiver == null || receiver.Type?.ClrType == null)
        {
            // ADR-0059 / issue #255: a value of a user-declared named delegate
            // type supports member-style invocation `del.Invoke(args)` (same as
            // any CLR delegate). Lower to a BoundIndirectCallExpression whose
            // function shape mirrors the delegate's declared signature; the
            // emitter recognises a DelegateTypeSymbol target and dispatches
            // through the delegate's runtime-implemented Invoke MethodDef.
            if (receiver != null && receiver.Type is DelegateTypeSymbol delRecv && string.Equals(methodName, "Invoke", System.StringComparison.Ordinal))
            {
                return BindNamedDelegateInvokeCall(receiver, delRecv, arguments, ce);
            }

            // Phase 3.B.4: dispatch to a user-defined interface method when
            // the static receiver type is an interface.
            if (receiver != null && receiver.Type is InterfaceSymbol ifaceRecv)
            {
                var ifaceOverloads = ifaceRecv.GetMethods(methodName);
                if (ifaceOverloads.Length > 0)
                {
                    var ifaceMethod = overloads.SelectInstanceOverloadOrReport(ifaceOverloads, arguments, ce, methodName, argumentNames);
                    if (ifaceMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    return overloads.BindUserInstanceCall(receiver, ifaceMethod, arguments, ce, argumentNames);
                }
            }

            // Phase 4.2b / ADR-0020: dispatch through a type parameter's
            // sealed-interface constraint, just as if the receiver were
            // typed as the interface itself.
            if (receiver != null && receiver.Type is TypeParameterSymbol tpRecv && tpRecv.InterfaceConstraint != null)
            {
                var tpOverloads = tpRecv.InterfaceConstraint.GetMethods(methodName);
                if (tpOverloads.Length > 0)
                {
                    var tpIfaceMethod = overloads.SelectInstanceOverloadOrReport(tpOverloads, arguments, ce, methodName, argumentNames);
                    if (tpIfaceMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    return overloads.BindUserInstanceCall(receiver, tpIfaceMethod, arguments, ce, argumentNames);
                }
            }

            // Phase 3.B.3 sub-step 2b: dispatch to a user-defined class method
            // if receiver is a user struct symbol.
            if (receiver != null && receiver.Type is StructSymbol userClass)
            {
                var userOverloads = userClass.GetMethodsIncludingInherited(methodName);
                if (userOverloads.Length > 0)
                {
                    var userMethod = overloads.SelectInstanceOverloadOrReport(userOverloads, arguments, ce, methodName, argumentNames);
                    if (userMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    return overloads.BindUserInstanceCall(receiver, userMethod, arguments, ce, argumentNames);
                }

                // Issue #527: fall back to a delegate/function-typed field on
                // the user struct/class. This is the same delegate-as-callable
                // dispatch used for the imported-CLR path below; here the
                // receiver's ClrType is null (the user type has not yet been
                // emitted) so we have to handle the symbol-only shape too.
                if (TryBindUserStructDelegateFieldInvocation(receiver, userClass, methodName, arguments, ce, out var userDelegateFieldCall))
                {
                    return userDelegateFieldCall;
                }
            }

            // Phase 3.B.6 / ADR-0019: extension function fallback for
            // user-type receivers (struct/class/interface).
            if (receiver != null && scope.TryLookupExtensionFunction(receiver.Type, methodName, out var userExtFn))
            {
                return overloads.BindExtensionFunctionCall(receiver, userExtFn, arguments, ce, argumentNames);
            }

            // Issue #296: a GSharp class inheriting an imported CLR base class
            // exposes the base's instance members. After user-defined and
            // extension lookups fail, resolve the call against the imported
            // base CLR type so inherited members are callable on the derived
            // GSharp instance. Inherited instance members take precedence over
            // imported extension methods.
            if (receiver != null && receiver.Type is StructSymbol inheritedDerived
                && inheritedDerived.ImportedBaseType?.ClrType is System.Type inheritedBaseClr
                && TryBindInheritedClrInstanceCall(receiver, inheritedBaseClr, methodName, arguments, ce, out var inheritedCall, explicitTypeArgs, typeArgSymbols, argumentNames))
            {
                return inheritedCall;
            }

            // Issue #294: imported [Extension] method dispatched with instance
            // (receiver) syntax, when the receiver carries a CLR type even
            // though its symbol is a user/interface shape.
            if (receiver != null && TryBindImportedExtensionCall(receiver, methodName, arguments, ce, out var userPathExt, explicitTypeArgs, typeArgSymbols, argumentNames))
            {
                return userPathExt;
            }

            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
            return new BoundErrorExpression(null);
        }

        // Prefer a user-defined class method when the receiver is a user
        // class symbol that has one with this name. (BCL lookup is the
        // fallback for imported CLR types.)
        if (receiver.Type is StructSymbol userClassPriority)
        {
            var priorityOverloads = userClassPriority.GetMethodsIncludingInherited(methodName);
            if (priorityOverloads.Length > 0)
            {
                var userMethodPriority = overloads.SelectInstanceOverloadOrReport(priorityOverloads, arguments, ce, methodName, argumentNames);
                if (userMethodPriority == null)
                {
                    return new BoundErrorExpression(null);
                }

                return overloads.BindUserInstanceCall(receiver, userMethodPriority, arguments, ce, argumentNames);
            }

            // Issue #527: a G#-defined struct/class field whose type is a
            // function (or named delegate) is invokable through the same
            // call syntax as a bare function-typed variable. Lower to a load
            // of the field value followed by an indirect call. Field lookup
            // walks the inheritance chain (a class can inherit a delegate
            // field from a base class).
            if (TryBindUserStructDelegateFieldInvocation(receiver, userClassPriority, methodName, arguments, ce, out var userDelegateCall))
            {
                return userDelegateCall;
            }
        }

        // Issue #517: a value-type `T?` lowers to `System.Nullable<T>` at the
        // CLR layer; `receiver.Type.ClrType` returns the underlying T's CLR
        // type (so the binder can share lifting/conversion logic), but
        // instance-method lookup (e.g. `GetValueOrDefault`, `Equals`,
        // `ToString`) must go through the constructed `Nullable<T>` type that
        // actually carries those members.
        var clrType = receiver.Type is NullableTypeSymbol nullableRecv
            && nullableRecv.UnderlyingType?.ClrType is { IsValueType: true } nullableInnerVt
            && this.memberLookup.TryGetNullableConstructedType(nullableInnerVt, out var nullableConstructed)
            ? nullableConstructed
            : receiver.Type.ClrType;

        // Issue #529: use interface-aware method enumeration so that
        // methods declared on a base interface (e.g.
        // IEnumerable<T>.GetEnumerator() surfaced through
        // IReadOnlyList<T>) are found.
        var candidates = ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(clrType, System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public)
            .Where(m => m.Name == methodName)
            .ToList();
        if (candidates.Count > 0)
        {
            var argTypes = new System.Type[arguments.Length];
            var argsAllTyped = true;
            var hasUserClassArg = false;
            for (var i = 0; i < arguments.Length; i++)
            {
                // Issue #530: use GetEffectiveArgumentClrType so that a
                // nullable value type argument (e.g. `int32?`) is matched
                // as `Nullable<T>` in overload resolution.
                // Issue #533: allow null (nil literal) through.
                // Issue #658: use overload-resolution variant for user classes.
                var t = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type);
                if (t == null && arguments[i].Type != TypeSymbol.Null)
                {
                    argsAllTyped = false;
                    break;
                }

                if (arguments[i].Type is StructSymbol { IsClass: true })
                {
                    hasUserClassArg = true;
                }

                argTypes[i] = t;
            }

            if (argsAllTyped)
            {
                // Issue #658: set up supplementary interface check for user-class args.
                if (hasUserClassArg)
                {
                    OverloadResolution.SupplementaryInterfaceCheck = (source, target) =>
                        IsUserClassAssignableToInterfaceFromArgs(arguments, argTypes, source, target);
                }

                try
                {
                    var resolution = OverloadResolution.Resolve(candidates, argTypes, explicitTypeArgs, scope.References.MapClrTypeToReferences, ComputeInterpolatedStringArgFlags(ce.Arguments, arguments.Length), argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames);
                    switch (resolution.Outcome)
                    {
                        case OverloadResolution.ResolutionOutcome.Resolved:
                            var returnType = ResolveImportedGenericReturnType(resolution.Best, typeArgSymbols) ?? MapClrMemberType(resolution.Best.ReturnType);
                            var instParameters = resolution.Best.GetParameters();
                            var instMapping = resolution.ParameterMapping;
                            var instExpandedArgs = resolution.IsExpanded
                                ? overloads.ExpandParamsArguments(arguments, instParameters, ce, parameterMapping: instMapping)
                                : arguments;
                            var instDownstreamMapping = resolution.IsExpanded ? default : instMapping;
                            var instRebound = RebindFormattableInterpolationArguments(instExpandedArgs, ce.Arguments, instParameters, instDownstreamMapping);
                            var instHandlerArgs = ApplyInterpolatedStringHandlers(instParameters, instRebound, receiver, ce.Location, instDownstreamMapping);
                            var instDelegateArgs = RebindFunctionLiteralDelegateArguments(instHandlerArgs, instParameters, instDownstreamMapping);
                            var instConvertedArgs = conversions.BindClrParameterConversions(instDelegateArgs, instParameters, ce, instDownstreamMapping);
                            var instArguments = OverloadResolver.BuildOrderedCallArguments(instConvertedArgs, instDownstreamMapping, instParameters);
                            var instRefKinds = ComputeArgumentRefKinds(instParameters);
                            overloads.ValidateRefArguments(instArguments, instRefKinds, methodName, ce.Location);
                            return ConversionClassifier.AutoDereferenceRefReturn(new BoundImportedInstanceCallExpression(null, receiver, resolution.Best, returnType, instArguments, instRefKinds, typeArgSymbols));
                        case OverloadResolution.ResolutionOutcome.Ambiguous:
                            Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, resolution.Ambiguous.Length, resolution.Ambiguous.Select(OverloadResolution.FormatMethodSignature));
                            return new BoundErrorExpression(null);
                        default:
                            break;
                    }
                }
                finally
                {
                    if (hasUserClassArg)
                    {
                        OverloadResolution.SupplementaryInterfaceCheck = null;
                    }
                }
            }
        }

        // Issue #527: a public field or property whose type is a CLR delegate
        // (e.g. `public Func<string> OnAsk;`) is invokable through the same
        // call syntax used on the variable itself — `bag.OnAsk()`. Method
        // lookup above only consulted methods named `OnAsk`, so the delegate
        // member would otherwise miss. Lower to a load of the delegate value
        // followed by an `Invoke(args)` dispatch (mirrors the bare-delegate
        // call path in BindCallExpression at #325). This must come before the
        // extension-function fallbacks so an in-scope extension method does
        // not shadow a real delegate-typed member on the type.
        if (receiver != null
            && TryBindClrDelegateMemberInvocation(receiver, clrType, methodName, arguments, ce, argumentNames, out var delegateMemberCall))
        {
            return delegateMemberCall;
        }

        // Phase 3.B.6 / ADR-0019: extension function fallback. After all
        // instance/static lookups fail, try matching by (receiverType, name).
        if (receiver != null && scope.TryLookupExtensionFunction(receiver.Type, methodName, out var extFn))
        {
            return overloads.BindExtensionFunctionCall(receiver, extFn, arguments, ce, argumentNames);
        }

        // Issue #294: BCL/library [Extension] method dispatched with instance
        // (receiver) syntax. After instance members and user extension
        // functions fail, fall back to imported static [Extension] methods
        // whose first parameter is compatible with the receiver type.
        if (receiver != null && TryBindImportedExtensionCall(receiver, methodName, arguments, ce, out var importedExt, explicitTypeArgs, typeArgSymbols, argumentNames))
        {
            return importedExt;
        }

        // Issue #343: if all CLR-instance lookups missed and the call uses
        // named arguments, point at the first unknown parameter name (if any)
        // for a more actionable diagnostic than "unable to find function".
        if (!argumentNames.IsDefault && receiver?.Type?.ClrType is System.Type recvClr
            && overloads.TryReportUnknownNamedArgumentForClr(recvClr, methodName, BindingFlags.Instance | BindingFlags.Public, ce, argumentNames))
        {
            return new BoundErrorExpression(null);
        }

        Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
        return new BoundErrorExpression(null);
    }

    /// <summary>
    /// Issue #527 (G#-defined struct/class arm): when a member-style call
    /// <c>receiver.Member(args)</c> does not match a method on the user
    /// struct/class, fall back to a field whose type is a function value or
    /// named delegate. Lowers to a load of the field followed by a
    /// <see cref="BoundIndirectCallExpression"/> through the function shape.
    /// Returns <see langword="true"/> when a callable field matched (the
    /// resulting expression may be a <see cref="BoundErrorExpression"/> if
    /// arity is wrong).
    /// </summary>
    private bool TryBindUserStructDelegateFieldInvocation(
        BoundExpression receiver,
        StructSymbol receiverStruct,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        out BoundExpression result)
    {
        result = null;

        // Walk the base chain so an inherited delegate field on a base class
        // is invokable on a derived instance.
        FieldSymbol matchedField = null;
        StructSymbol declaringType = null;
        for (var c = receiverStruct; c != null; c = c.BaseClass)
        {
            if (c.TryGetField(methodName, out var f))
            {
                matchedField = f;
                declaringType = c;
                break;
            }
        }

        if (matchedField == null)
        {
            return false;
        }

        FunctionTypeSymbol functionType;
        if (matchedField.Type is FunctionTypeSymbol fts)
        {
            functionType = fts;
        }
        else if (matchedField.Type is DelegateTypeSymbol nds)
        {
            functionType = nds.EquivalentFunctionType;
        }
        else if (matchedField.Type?.ClrType is System.Type fieldClrType
            && ClrTypeUtilities.IsDelegateType(fieldClrType)
            && MemberLookup.TryGetDelegateFunctionType(fieldClrType, out var clrFn))
        {
            functionType = clrFn;
        }
        else
        {
            return false;
        }

        if (arguments.Length != functionType.ParameterTypes.Length)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, methodName, functionType.ParameterTypes.Length, arguments.Length);
            result = new BoundErrorExpression(null);
            return true;
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
        for (var i = 0; i < arguments.Length; i++)
        {
            convertedArgs.Add(conversions.BindConversion(ce.Arguments[i].Location, arguments[i], functionType.ParameterTypes[i]));
        }

        var fieldLoad = new BoundFieldAccessExpression(null, receiver, declaringType, matchedField);
        result = new BoundIndirectCallExpression(null, fieldLoad, functionType, convertedArgs.MoveToImmutable());
        return true;
    }

    /// <summary>
    /// Issue #527: when an accessor-style call <c>receiver.Member(args)</c>
    /// matches no method on the CLR receiver type, fall back to a public
    /// field or property of the same name whose type is a CLR delegate.
    /// Lowers to a load of the delegate value (<c>ldfld</c> / property getter)
    /// followed by an <c>Invoke(args)</c> call. Returns <see langword="true"/>
    /// when a delegate-typed member matched and the call was bound (the
    /// resulting expression may be a <see cref="BoundErrorExpression"/> if
    /// argument resolution failed).
    /// </summary>
    private bool TryBindClrDelegateMemberInvocation(
        BoundExpression receiver,
        System.Type clrType,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        out BoundExpression result)
    {
        result = null;
        if (clrType == null)
        {
            return false;
        }

        // Prefer a property of the right name over a field — the same
        // precedence used by the read path in BindAccessorStep (properties
        // first, fields fallback). Indexer properties (those with parameters)
        // are not member-style invocable, so skip them.
        System.Reflection.MemberInfo member = ClrTypeUtilities.SafeGetProperty(clrType, methodName, BindingFlags.Public | BindingFlags.Instance);
        if (member is System.Reflection.PropertyInfo prop && (prop.GetIndexParameters().Length != 0 || !prop.CanRead))
        {
            member = null;
        }

        member ??= ClrTypeUtilities.SafeGetField(clrType, methodName, BindingFlags.Public | BindingFlags.Instance);
        if (member == null)
        {
            return false;
        }

        System.Type memberClrType = member switch
        {
            System.Reflection.PropertyInfo p => p.PropertyType,
            System.Reflection.FieldInfo f => f.FieldType,
            _ => null,
        };
        if (memberClrType == null || !ClrTypeUtilities.IsDelegateType(memberClrType))
        {
            return false;
        }

        TypeSymbol memberTypeSymbol = member switch
        {
            System.Reflection.PropertyInfo p2 => ClrNullability.GetPropertyTypeSymbol(p2),
            System.Reflection.FieldInfo f2 => ClrNullability.GetFieldTypeSymbol(f2),
            _ => TypeSymbol.FromClrType(memberClrType),
        };

        // The delegate value load — `ldfld` for a field, `call get_X` for a
        // property. The shared BoundClrPropertyAccessExpression node carries
        // either MemberInfo shape, and EmitClrPropertyAccess already handles
        // both (including the value-type-receiver `ldloca` step we need for
        // a CLR struct field).
        var delegateLoad = new BoundClrPropertyAccessExpression(null, receiver, member, memberTypeSymbol);

        // Strip nullable annotation when dispatching through Invoke — the
        // delegate value is loaded as-is from the field; the call would
        // dereference null at runtime if the member is unassigned. This
        // matches CLR semantics for `del()` on a null `Func<T>`.
        var underlyingDelegateClr = memberClrType;

        // Reuse the same Invoke-overload-resolution path that the bare
        // delegate-variable call uses at #325 (BindCallExpression), so
        // generic delegate arguments, named arguments, and ref/in/out are
        // all handled uniformly.
        if (TryBindInheritedClrInstanceCall(delegateLoad, underlyingDelegateClr, "Invoke", arguments, ce, out var invokeCall, argumentNames: argumentNames))
        {
            result = invokeCall;
            return true;
        }

        // No applicable Invoke overload — most likely an argument-count or
        // type mismatch. Report against the member name (not "Invoke") so the
        // diagnostic points to what the user wrote.
        var invoke = memberClrType.GetMethod("Invoke");
        var expectedArity = invoke?.GetParameters().Length ?? 0;
        if (arguments.Length != expectedArity)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, methodName, expectedArity, arguments.Length);
        }
        else
        {
            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
        }

        result = new BoundErrorExpression(null);
        return true;
    }

    /// <summary>
    /// Issue #296: resolves an instance method call against an imported CLR
    /// base class for a GSharp class receiver that inherits it. Uses the same
    /// overload resolution as direct imported-instance calls; <c>GetMethods</c>
    /// on the base type already includes members inherited up the CLR chain.
    /// Returns <c>true</c> with a bound call when a unique match is found.
    /// </summary>
    internal bool TryBindInheritedClrInstanceCall(
        BoundExpression receiver,
        System.Type importedBaseClr,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        out BoundExpression result,
        System.Type[] explicitTypeArgs = null,
        ImmutableArray<TypeSymbol> typeArgSymbols = default,
        ImmutableArray<string> argumentNames = default)
    {
        result = null;

        var candidates = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(importedBaseClr, methodName);
        if (candidates.Count == 0)
        {
            return false;
        }

        var argTypes = new System.Type[arguments.Length];
        var hasUserClassArg = false;
        for (var i = 0; i < arguments.Length; i++)
        {
            // Issue #530: use GetEffectiveArgumentClrType (see instance method path).
            // Issue #533: allow null (nil literal) through.
            // Issue #658: use overload-resolution variant for user classes.
            var t = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type);
            if (t == null && arguments[i].Type != TypeSymbol.Null)
            {
                return false;
            }

            if (arguments[i].Type is StructSymbol { IsClass: true })
            {
                hasUserClassArg = true;
            }

            argTypes[i] = t;
        }

        // Issue #658: set up supplementary interface check for user-class args.
        if (hasUserClassArg)
        {
            OverloadResolution.SupplementaryInterfaceCheck = (source, target) =>
                IsUserClassAssignableToInterfaceFromArgs(arguments, argTypes, source, target);
        }

        OverloadResolution.Result<MethodInfo> resolution;
        try
        {
            resolution = OverloadResolution.Resolve(candidates, argTypes, explicitTypeArgs, scope.References.MapClrTypeToReferences, argumentNames: argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames);
        }
        finally
        {
            if (hasUserClassArg)
            {
                OverloadResolution.SupplementaryInterfaceCheck = null;
            }
        }

        switch (resolution.Outcome)
        {
            case OverloadResolution.ResolutionOutcome.Resolved:
                var returnType = ResolveImportedGenericReturnType(resolution.Best, typeArgSymbols) ?? TypeSymbol.FromClrType(resolution.Best.ReturnType);
                var inheritedParameters = resolution.Best.GetParameters();
                var inheritedMapping = resolution.ParameterMapping;
                var inheritedExpandedArgs = resolution.IsExpanded
                    ? overloads.ExpandParamsArguments(arguments, inheritedParameters, ce, parameterMapping: inheritedMapping)
                    : arguments;
                var inheritedDownstreamMapping = resolution.IsExpanded ? default : inheritedMapping;
                var inheritedHandlerArgs = ApplyInterpolatedStringHandlers(inheritedParameters, inheritedExpandedArgs, receiver, ce.Location, inheritedDownstreamMapping);
                var inheritedDelegateArgs = RebindFunctionLiteralDelegateArguments(inheritedHandlerArgs, inheritedParameters, inheritedDownstreamMapping);
                var inheritedConvertedArgs = conversions.BindClrParameterConversions(inheritedDelegateArgs, inheritedParameters, ce, inheritedDownstreamMapping);
                var inheritedArguments = OverloadResolver.BuildOrderedCallArguments(inheritedConvertedArgs, inheritedDownstreamMapping, inheritedParameters);
                var refKinds = ComputeArgumentRefKinds(inheritedParameters);
                overloads.ValidateRefArguments(inheritedArguments, refKinds, methodName, ce.Location);
                result = new BoundImportedInstanceCallExpression(null, receiver, resolution.Best, returnType, inheritedArguments, refKinds, typeArgSymbols);
                return true;
            case OverloadResolution.ResolutionOutcome.Ambiguous:
                Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, resolution.Ambiguous.Length, resolution.Ambiguous.Select(OverloadResolution.FormatMethodSignature));
                result = new BoundErrorExpression(null);
                return true;
            default:
                // Issue #343: if the failure is plausibly due to an unknown
                // named-argument target, surface that as the diagnostic.
                if (!argumentNames.IsDefault
                    && overloads.TryReportUnknownNamedArgumentForClr(importedBaseClr, methodName, BindingFlags.Instance | BindingFlags.Public, ce, argumentNames))
                {
                    result = new BoundErrorExpression(null);
                    return true;
                }

                return false;
        }
    }

    /// <summary>
    /// ADR-0059 / issue #255: lowers a <c>delegateValue.Invoke(args)</c>
    /// call against a value of <see cref="DelegateTypeSymbol"/> into a
    /// <see cref="BoundIndirectCallExpression"/> whose function shape is the
    /// delegate's equivalent <see cref="FunctionTypeSymbol"/>. The emitter
    /// recognises a DelegateTypeSymbol target and routes the call through
    /// the delegate's runtime-implemented Invoke MethodDef.
    /// </summary>
    private BoundExpression BindNamedDelegateInvokeCall(BoundExpression receiver, DelegateTypeSymbol delegateSym, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce)
    {
        if (arguments.Length != delegateSym.Parameters.Length)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, delegateSym.Name, delegateSym.Parameters.Length, arguments.Length);
            return new BoundErrorExpression(null);
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
        for (var i = 0; i < arguments.Length; i++)
        {
            convertedArgs.Add(conversions.BindConversion(ce.Arguments[i].Location, arguments[i], delegateSym.Parameters[i].Type));
        }

        return new BoundIndirectCallExpression(null, receiver, delegateSym.EquivalentFunctionType, convertedArgs.MoveToImmutable());
    }

    /// <summary>
    /// Issue #294: resolves a call written with instance ("receiver") syntax
    /// against an imported CLR static method marked with
    /// <c>[System.Runtime.CompilerServices.ExtensionAttribute]</c> whose first
    /// parameter is compatible with the receiver's type. This makes BCL/library
    /// extension methods (LINQ <c>Where</c>/<c>Select</c>/<c>ToList</c>, the
    /// ASP.NET Core minimal-API/middleware surface, etc.) callable as
    /// <c>receiver.Method(args)</c> rather than only statically as
    /// <c>DeclaringClass.Method(receiver, args)</c>.
    /// </summary>
    /// <param name="receiver">The bound receiver expression.</param>
    /// <param name="methodName">The method name at the call site.</param>
    /// <param name="arguments">The bound user arguments (excluding the receiver).</param>
    /// <param name="ce">The originating call expression.</param>
    /// <param name="result">The bound call when resolution succeeds (or a bound error on ambiguity).</param>
    /// <param name="explicitTypeArgs">Issue #311: resolved explicit type arguments from a <c>[T1, T2]</c> list, or <c>null</c> for inference.</param>
    /// <param name="typeArgSymbols">Issue #320: explicit type-argument symbols in source order (carrying user-defined types), or default.</param>
    /// <param name="argumentNames">Issue #343: per-source-argument names parallel to <paramref name="arguments"/> (entries are <see langword="null"/> for positional); default when the call is purely positional.</param>
    /// <returns>True when an imported extension method was matched (success or ambiguity); false to let the caller report GS0159.</returns>
    private bool TryBindImportedExtensionCall(BoundExpression receiver, string methodName, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce, out BoundExpression result, System.Type[] explicitTypeArgs = null, ImmutableArray<TypeSymbol> typeArgSymbols = default, ImmutableArray<string> argumentNames = default)
    {
        result = null;

        var receiverClrType = receiver?.Type?.ClrType;
        if (receiverClrType == null)
        {
            return false;
        }

        // Build the argument-type vector as the extension method sees it: the
        // receiver becomes the first ("this") parameter, followed by the user
        // arguments. Every argument must carry a concrete CLR type so overload
        // resolution (including generic inference) can run.
        var argTypes = new Type[arguments.Length + 1];
        argTypes[0] = receiverClrType;
        var hasUserClassArg = false;
        for (var i = 0; i < arguments.Length; i++)
        {
            // Issue #530: use GetEffectiveArgumentClrType (see instance method path).
            // Issue #533: allow null (nil literal) through.
            // Issue #658: use overload-resolution variant for user classes.
            var t = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type);
            if (t == null && arguments[i].Type != TypeSymbol.Null)
            {
                return false;
            }

            if (arguments[i].Type is StructSymbol { IsClass: true })
            {
                hasUserClassArg = true;
            }

            argTypes[i + 1] = t;
        }

        // Issue #343: extension methods are dispatched as `Class.Method(receiver, userArgs...)`,
        // so prepend a null slot to user-supplied argument names so positions
        // align with the method's parameter list (where index 0 is `this`).
        IReadOnlyList<string> extensionArgumentNames = null;
        if (!argumentNames.IsDefault)
        {
            var withReceiver = new string[arguments.Length + 1];
            for (var i = 0; i < arguments.Length; i++)
            {
                withReceiver[i + 1] = argumentNames[i];
            }

            extensionArgumentNames = withReceiver;
        }

        var candidates = this.memberLookup.CollectImportedExtensionMethods(methodName);
        if (candidates.Count == 0)
        {
            return false;
        }

        // OverloadResolution.Resolve infers type arguments for open generic
        // method definitions (e.g. Where<TSource>(IEnumerable<TSource>,
        // Func<TSource,bool>)) from the receiver and argument types. Issue #311:
        // when the call site supplied explicit type arguments (e.g.
        // services.AddSingleton[IService, Service]()), those are used to close
        // the generic method instead of inference.
        // Issue #658: set up supplementary interface check for user-class args.
        if (hasUserClassArg)
        {
            OverloadResolution.SupplementaryInterfaceCheck = (source, target) =>
                IsUserClassAssignableToInterfaceFromArgs(arguments, argTypes, source, target);
        }

        OverloadResolution.Result<MethodInfo> resolution;
        try
        {
            resolution = OverloadResolution.Resolve(candidates, argTypes, explicitTypeArgs, scope.References.MapClrTypeToReferences, argumentNames: extensionArgumentNames);
        }
        finally
        {
            if (hasUserClassArg)
            {
                OverloadResolution.SupplementaryInterfaceCheck = null;
            }
        }

        switch (resolution.Outcome)
        {
            case OverloadResolution.ResolutionOutcome.Resolved:
                break;
            case OverloadResolution.ResolutionOutcome.Ambiguous:
                Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, resolution.Ambiguous.Length, resolution.Ambiguous.Select(OverloadResolution.FormatMethodSignature));
                result = new BoundErrorExpression(null);
                return true;
            default:
                return false;
        }

        var best = resolution.Best;
        var declaringType = best.DeclaringType;
        if (declaringType == null)
        {
            return false;
        }

        var importedClass = new ImportedClassSymbol(declaringType, ce);
        var returnOverride = ResolveImportedGenericReturnType(best, typeArgSymbols);
        var function = new ImportedFunctionSymbol(methodName, importedClass, best, ce, returnOverride);

        var allArguments = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length + 1);
        allArguments.Add(receiver);
        allArguments.AddRange(arguments);
        var bound = allArguments.MoveToImmutable();

        // Issue #506: when overload resolution selected the expanded form of a
        // `params T[]` extension method (e.g. `MyEnumerable.Concat(this src,
        // params string[] tail)` called with positional tail args), pack the
        // trailing positional arguments into a synthesised slice/array first.
        // The receiver occupies parameter slot 0; the params slot is always
        // the last parameter, so it never collides with the receiver. Named
        // arguments against an expanded-form extension are funnelled through
        // an offset mapping so the receiver position lines up with bound[0].
        var parameters = best.GetParameters();
        if (resolution.IsExpanded)
        {
            ImmutableArray<int> expandedMapping = default;
            if (!resolution.ParameterMapping.IsDefault)
            {
                var offset = ImmutableArray.CreateBuilder<int>(bound.Length);
                offset.Add(0);
                for (var i = 0; i < resolution.ParameterMapping.Length; i++)
                {
                    offset.Add(resolution.ParameterMapping[i]);
                }

                expandedMapping = offset.MoveToImmutable();
            }

            bound = overloads.ExpandParamsArguments(bound, parameters, ce, receiverArgCount: 1, parameterMapping: expandedMapping);
        }

        var downstreamMapping = resolution.IsExpanded ? default : resolution.ParameterMapping;

        // Issue #506 follow-up: route through BindClrParameterConversions so
        // value-type → object boxing fires for fixed-arity imported extension
        // calls too. The receiver occupies arg slot 0 (and is already typed
        // correctly via the extension dispatch).
        bound = conversions.BindClrParameterConversions(bound, parameters, ce, downstreamMapping, receiverArgCount: 1);

        // Issue #327 / #343: re-order arguments into parameter positions when
        // named arguments were used; otherwise fall through to the existing
        // trailing-optional fill.
        bound = OverloadResolver.BuildOrderedCallArguments(bound, downstreamMapping, parameters);

        var refKinds = ComputeArgumentRefKinds(parameters);
        overloads.ValidateRefArguments(bound, refKinds, methodName, ce.Location);
        result = new BoundImportedCallExpression(null, function, bound, refKinds, typeArgSymbols);
        return true;
    }

    private ImmutableArray<BoundExpression> RebindFunctionLiteralDelegateArguments(
        ImmutableArray<BoundExpression> arguments,
        ParameterInfo[] parameters,
        ImmutableArray<int> parameterMapping = default)
    {
        ImmutableArray<BoundExpression>.Builder builder = null;
        for (var i = 0; i < arguments.Length; i++)
        {
            var paramIndex = parameterMapping.IsDefault ? i : parameterMapping[i];
            var argument = arguments[i];
            var rebound = argument;
            if (paramIndex < parameters.Length
                && LambdaBinder.TryGetFunctionLiteral(argument, out var literal)
                && MemberLookup.TryGetDelegateFunctionType(parameters[paramIndex].ParameterType, out var targetFunctionType)
                && literal.FunctionType != targetFunctionType)
            {
                rebound = lambdas.CreateErasedFunctionLiteralAdapter(literal, targetFunctionType);
            }

            if (rebound != argument && builder == null)
            {
                builder = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
                for (var j = 0; j < i; j++)
                {
                    builder.Add(arguments[j]);
                }
            }

            builder?.Add(rebound);
        }

        if (builder == null)
        {
            return arguments;
        }

        for (var i = builder.Count; i < arguments.Length; i++)
        {
            builder.Add(arguments[i]);
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// Issue #658: determines whether a user-defined G# class argument (identified
    /// by its surrogate CLR type in <paramref name="argTypes"/>) implements the
    /// specified CLR <paramref name="target"/> interface. Used as the
    /// <see cref="OverloadResolution.SupplementaryInterfaceCheck"/> callback during
    /// overload resolution for calls that include user-class arguments.
    /// </summary>
    private static bool IsUserClassAssignableToInterface(
        ImmutableArray<BoundExpression>.Builder boundArguments,
        System.Type[] argTypes,
        System.Type source,
        System.Type target)
    {
        for (var i = 0; i < boundArguments.Count; i++)
        {
            if (!ReferenceEquals(argTypes[i], source))
            {
                continue;
            }

            if (boundArguments[i].Type is StructSymbol { IsClass: true } ss)
            {
                if (UserClassImplementsInterface(ss, target))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #658: checks whether a user-defined G# class (or any of its base
    /// classes) declares implementation of the specified CLR interface.
    /// </summary>
    private static bool UserClassImplementsInterface(StructSymbol ss, System.Type target)
    {
        for (var current = ss; current != null; current = current.BaseClass)
        {
            foreach (var iface in current.ImplementedClrInterfaces)
            {
                if (iface.ClrType == null)
                {
                    continue;
                }

                // Direct match: the implemented interface IS the target.
                if (ClrTypeUtilities.AreSame(iface.ClrType, target))
                {
                    return true;
                }

                // The implemented interface itself inherits from the target.
                if (ClrTypeUtilities.ImplementsInterfaceByName(iface.ClrType, target))
                {
                    return true;
                }
            }
        }

        // Also check the imported CLR base type (if any) — it may implement
        // the target interface.
        if (ss.ImportedBaseType?.ClrType != null
            && ClrTypeUtilities.ImplementsInterfaceByName(ss.ImportedBaseType.ClrType, target))
        {
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #658: variant of <see cref="IsUserClassAssignableToInterface"/> that
    /// works with <see cref="ImmutableArray{T}"/> arguments (used by instance
    /// method call paths).
    /// </summary>
    private static bool IsUserClassAssignableToInterfaceFromArgs(
        ImmutableArray<BoundExpression> boundArguments,
        System.Type[] argTypes,
        System.Type source,
        System.Type target)
    {
        for (var i = 0; i < boundArguments.Length; i++)
        {
            if (!ReferenceEquals(argTypes[i], source))
            {
                continue;
            }

            if (boundArguments[i].Type is StructSymbol { IsClass: true } ss)
            {
                if (UserClassImplementsInterface(ss, target))
                {
                    return true;
                }
            }
        }

        return false;
    }
}
