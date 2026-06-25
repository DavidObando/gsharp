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

            if (!TypeMemberModel.TryGetFieldIncludingInherited(structType, fieldName, MemberQuery.Instance(MemberKinds.Field), out var field, out var declaringType))
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

    /// <summary>
    /// Issue #479 / ADR-0117: binds a collection initializer
    /// (<c>List[int32]{1, 2, 3}</c>, <c>Dictionary[K, V]{"a": 1}</c>,
    /// <c>Dictionary[K, V](cmp){ ["k"] = v }</c>). The target constructor call
    /// is bound into a synthetic local; each element lowers to an
    /// <c>Add(...)</c> call (bare / <c>key: value</c> entries) or an indexer set
    /// (<c>[key] = value</c> entries); the block yields the local. The lowering
    /// uses only existing bound nodes, so emit and the interpreter both work
    /// without a new bound-node kind.
    /// </summary>
    private BoundExpression BindCollectionInitializerExpression(CollectionInitializerExpressionSyntax syntax)
    {
        var target = BindExpression(syntax.Target);
        if (target.Type == TypeSymbol.Error || target.Type == null)
        {
            BindCollectionElementsForDiagnostics(syntax);
            return new BoundErrorExpression(null);
        }

        var resultType = target.Type;
        var clrType = resultType.ClrType;
        var hasIndexedElement = syntax.Elements.Any(e => e is IndexedCollectionElementSyntax);
        var hasNonIndexedElement = syntax.Elements.Any(e => e is not IndexedCollectionElementSyntax);

        // A collection initializer requires an accessible instance `Add` for the
        // bare / key:value element forms. Indexed `[k] = v` entries go through
        // the indexer-set path, which reports its own GS0226/indexability errors.
        var hasAdd = clrType != null && MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(clrType, "Add").Count > 0;
        if (clrType == null || (hasNonIndexedElement && !hasAdd))
        {
            Diagnostics.ReportTypeNotCollectionInitializable(syntax.OpenBraceToken.Location, resultType);
            BindCollectionElementsForDiagnostics(syntax);
            return new BoundErrorExpression(null);
        }

        var tempName = "$collinit" + System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, resultType);
        scope.TryDeclareVariable(tempVar);

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(new BoundVariableDeclaration(syntax, tempVar, target));

        foreach (var element in syntax.Elements)
        {
            BoundExpression bound;
            switch (element)
            {
                case ExpressionCollectionElementSyntax bare:
                    bound = BindCollectionAddCall(tempVar, element, ImmutableArray.Create(bare.Expression));
                    break;
                case KeyedCollectionElementSyntax keyed:
                    bound = BindCollectionAddCall(tempVar, element, ImmutableArray.Create(keyed.Key, keyed.Value));
                    break;
                case IndexedCollectionElementSyntax indexed:
                    bound = BindIndexedAssignmentToVariable(tempVar, indexed.Key, indexed.Value, indexed.EqualsToken.Location);
                    break;
                default:
                    bound = new BoundErrorExpression(null);
                    break;
            }

            statements.Add(new BoundExpressionStatement(element, bound));
        }

        _ = hasIndexedElement;
        var resultExpr = new BoundVariableExpression(syntax, tempVar);
        return new BoundBlockExpression(syntax, statements.ToImmutable(), resultExpr);
    }

    /// <summary>
    /// Issue #479 / ADR-0117: lowers one bare / key:value collection element to
    /// an <c>Add(...)</c> call on the synthetic collection local. A synthetic
    /// <see cref="CallExpressionSyntax"/> named <c>Add</c> is bound through the
    /// shared accessor-call path so overload resolution, generic-argument
    /// inference, and parameter conversions all match a hand-written
    /// <c>coll.Add(...)</c>.
    /// </summary>
    private BoundExpression BindCollectionAddCall(LocalVariableSymbol receiverLocal, SyntaxNode anchor, ImmutableArray<ExpressionSyntax> arguments)
    {
        var receiver = new BoundVariableExpression(anchor, receiverLocal);
        var addCall = SynthesizeInstanceCall(anchor, "Add", arguments);
        return BindAccessorCall(receiver, classSymbol: null, addCall);
    }

    /// <summary>
    /// Issue #479 / ADR-0117: builds a synthetic instance-call syntax node
    /// (<c>Add(arg0, arg1, …)</c>) anchored at <paramref name="anchor"/> so the
    /// shared call binder can resolve the method and bind the argument syntaxes.
    /// </summary>
    private CallExpressionSyntax SynthesizeInstanceCall(SyntaxNode anchor, string methodName, ImmutableArray<ExpressionSyntax> arguments)
    {
        var tree = anchor.SyntaxTree;
        var position = anchor.Span.Start;
        var identifier = new SyntaxToken(tree, SyntaxKind.IdentifierToken, position, methodName, null);
        var openParen = new SyntaxToken(tree, SyntaxKind.OpenParenthesisToken, position, "(", null);
        var closeParen = new SyntaxToken(tree, SyntaxKind.CloseParenthesisToken, position, ")", null);

        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        for (var i = 0; i < arguments.Length; i++)
        {
            nodesAndSeparators.Add(arguments[i]);
            if (i < arguments.Length - 1)
            {
                nodesAndSeparators.Add(new SyntaxToken(tree, SyntaxKind.CommaToken, position, ",", null));
            }
        }

        var argumentList = new SeparatedSyntaxList<ExpressionSyntax>(nodesAndSeparators.ToImmutable());
        return new CallExpressionSyntax(tree, identifier, openParen, argumentList, closeParen);
    }

    private void BindCollectionElementsForDiagnostics(CollectionInitializerExpressionSyntax syntax)
    {
        foreach (var element in syntax.Elements)
        {
            switch (element)
            {
                case ExpressionCollectionElementSyntax bare:
                    _ = BindExpression(bare.Expression);
                    break;
                case KeyedCollectionElementSyntax keyed:
                    _ = BindExpression(keyed.Key);
                    _ = BindExpression(keyed.Value);
                    break;
                case IndexedCollectionElementSyntax indexed:
                    _ = BindExpression(indexed.Key);
                    _ = BindExpression(indexed.Value);
                    break;
            }
        }
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

                // ADR-0083 / issue #723: gate `len` / `cap` behind
                // `import Gsharp.Extensions.Go`. Fired after operand
                // binding so the receiver type drives the .NET-idiomatic
                // suggestion (`.Length` vs `.Count`). Recovery binds the
                // form as if the import were present, so the shape
                // validation below still surfaces any genuine type
                // mismatch in the same pass.
                binderCtx.ReportIfGoBuiltinImportMissing(syntax, syntax.Identifier.Location, name, operand.Type);

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

                // ADR-0083 / issue #723: gate `append` behind
                // `import Gsharp.Extensions.Go`. No clean .NET-idiomatic
                // replacement exists for grow-and-copy on a slice; the
                // GS0317 suggestion recommends the import (or `List[T].Add`
                // when the user wants mutable semantics).
                binderCtx.ReportIfGoBuiltinImportMissing(syntax, syntax.Identifier.Location, name, slice.Type);

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

                // ADR-0083 / issue #723: gate `delete` behind
                // `import Gsharp.Extensions.Go`. The GS0317 suggestion
                // points at the BCL equivalent `.Remove(k)`.
                binderCtx.ReportIfGoBuiltinImportMissing(syntax, syntax.Identifier.Location, name, mapExpr.Type);

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
                // ADR-0082 / issue #722: gate on `import Gsharp.Extensions.Go`.
                // Per ADR-0083 §"Deconfliction with close", `close(ch)` keeps the
                // GS0316 (channel-surface) message rather than the per-builtin
                // GS0317; the import lookup is identical so callers see one
                // diagnostic regardless of which built-in tripped first.
                binderCtx.ReportIfGoExtensionsImportMissing(syntax, syntax.Identifier.Location, "close");

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

        // Issue #891: a constructor's delegate-typed parameter (e.g.
        // `Func<HttpClient> httpClientFactory`) target-types an arrow/func
        // literal argument before it is bound. Without this, an arrow lambda
        // whose body only throws (`() -> { throw ... }`) infers `() -> void`
        // and fails to match the `Func<...>` parameter; the call then misroutes
        // to the single-arg conversion path and reports the misleading GS0162
        // "named arguments are only supported for data-struct .copy(...)".
        var ctors = ClrTypeUtilities.SafeGetConstructors(clrType, BindingFlags.Public | BindingFlags.Instance);
        var ctorParameterLists = ctors.Select(c => c.GetParameters()).ToList();

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
        for (var i = 0; i < syntax.Arguments.Count; i++)
        {
            var argName = argumentNames.IsDefault ? null : argumentNames[i];
            boundArguments.Add(BindCallArgumentWithDelegateTargetTyping(
                syntax.Arguments[i], ctorParameterLists, sourceArgIndex: i, argName: argName, paramOffset: 0));
        }

        // Phase A (overload resolution): pick a constructor via the shared
        // "better function member" resolver. Ambiguity surfaces a hard
        // binder diagnostic and the call falls back to the surrounding
        // pipeline (which will diagnose a missing match).
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
        var ctorHandlerArgs = ApplyInterpolatedStringHandlers(ctorParameters, ctorRebound, receiver: null, syntax.Location, ctorDownstreamMapping, out var ctorHandlerPrelude, out _);

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

        BoundExpression ctorCall = new BoundClrConstructorCallExpression(
            syntax,
            clrType,
            bestCtor,
            ctorArgs,
            resultType,
            ctorRefKinds);
        result = WrapWithHandlerPrelude(ctorCall, ctorHandlerPrelude, syntax);
        return true;
    }

    /// <summary>
    /// Issue #891: binds a single call argument, target-typing arrow/func
    /// literals against the matching delegate-typed parameter discovered from
    /// the candidate (constructor or method) parameter lists. This lets an
    /// arrow lambda — including a statement body that only throws — be bound
    /// directly as the corresponding delegate (Func/Action) instead of
    /// inferring a standalone (often void) function type that fails overload
    /// resolution and misroutes the call.
    /// </summary>
    private BoundExpression BindCallArgumentWithDelegateTargetTyping(
        ExpressionSyntax argumentSyntax,
        IReadOnlyList<ParameterInfo[]> candidateParameterLists,
        int sourceArgIndex,
        string argName,
        int paramOffset)
    {
        var inner = OverloadResolver.UnwrapNamedArgumentValue(argumentSyntax);
        if (inner is LambdaExpressionSyntax lambdaSyntax
            && TryResolveDelegateTargetFromCandidates(candidateParameterLists, paramOffset, sourceArgIndex, argName, out var target))
        {
            return lambdas.BindLambdaExpression(lambdaSyntax, target);
        }

        return BindExpression(inner);
    }

    /// <summary>
    /// Issue #891: discovers the (non-generic) delegate function type that a
    /// given argument position maps to across all candidate parameter lists.
    /// Named arguments are matched by parameter name; positional arguments by
    /// index (after <paramref name="paramOffset"/>, e.g. an extension method's
    /// receiver). Returns false when no candidate exposes a closed delegate
    /// parameter there, or when candidates disagree on the delegate shape.
    /// </summary>
    private static bool TryResolveDelegateTargetFromCandidates(
        IReadOnlyList<ParameterInfo[]> candidateParameterLists,
        int paramOffset,
        int sourceArgIndex,
        string argName,
        out FunctionTypeSymbol target)
    {
        target = null;
        foreach (var parameters in candidateParameterLists)
        {
            int paramIndex;
            if (!string.IsNullOrEmpty(argName))
            {
                paramIndex = -1;
                for (var p = 0; p < parameters.Length; p++)
                {
                    if (string.Equals(parameters[p].Name, argName, StringComparison.Ordinal))
                    {
                        paramIndex = p;
                        break;
                    }
                }

                if (paramIndex < 0)
                {
                    continue;
                }
            }
            else
            {
                paramIndex = sourceArgIndex + paramOffset;
                if (paramIndex < 0 || paramIndex >= parameters.Length)
                {
                    continue;
                }
            }

            var parameterType = parameters[paramIndex].ParameterType;
            if (parameterType == null || parameterType.ContainsGenericParameters)
            {
                // Open generic delegate parameters are resolved later, once the
                // generic method's type arguments have been inferred.
                continue;
            }

            if (!MemberLookup.TryGetDelegateFunctionType(parameterType, out var candidate) || candidate == null)
            {
                continue;
            }

            if (target == null)
            {
                target = candidate;
            }
            else if (!ReferenceEquals(target, candidate) && !target.Equals(candidate))
            {
                // Candidates disagree on the delegate shape — leave the lambda
                // to be bound without a target (overload resolution decides).
                target = null;
                return false;
            }
        }

        return target != null;
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

    /// <summary>
    /// Issue #794: when an instance call is dispatched against a receiver whose
    /// <see cref="ImportedTypeSymbol"/> carries symbolic type arguments
    /// (e.g. <c>List[T]</c>, <c>Dictionary[K, V]</c>) — including the
    /// open in-scope type-parameter case from #313/#671 — substitute the
    /// open declaring type's return type using the receiver's symbolic
    /// arguments. Without this override the call's return type comes from the
    /// type-erased closed shape (<c>List&lt;object&gt;.ToArray()</c> →
    /// <c>object[]</c>), losing the symbolic projection (<c>T[]</c>).
    /// Returns <see langword="null"/> when no override is needed so callers
    /// keep their existing return-type derivation.
    /// </summary>
    /// <param name="receiverType">The receiver's static type symbol.</param>
    /// <param name="closedMethod">The closed method selected by overload resolution.</param>
    /// <returns>The override return type symbol, or <see langword="null"/>.</returns>
    private static TypeSymbol ResolveInstanceReturnTypeFromReceiver(TypeSymbol receiverType, System.Reflection.MethodInfo closedMethod)
    {
        if (receiverType is not ImportedTypeSymbol imp
            || imp.OpenDefinition == null
            || imp.TypeArguments.IsDefaultOrEmpty
            || closedMethod == null)
        {
            return null;
        }

        var openMethod = TryGetOpenInstanceMethod(imp.OpenDefinition, closedMethod);
        if (openMethod == null)
        {
            return null;
        }

        var openReturn = openMethod.ReturnType;
        if (openReturn == null || openReturn.IsSameAs(typeof(void)))
        {
            return null;
        }

        var mapped = MemberLookup.MapOpenClrTypeToSymbolic(openReturn, imp.OpenDefinition, imp.TypeArguments);

        // Issue #1100: keep the symbolic projection when the recovered return
        // type references a same-compilation user type as well (not only an
        // in-scope type parameter). A constructed BCL generic over a
        // same-compilation class — e.g. `Queue[Entry].Dequeue()` — projects the
        // open `T` return to the user `Entry` symbol (whose `ClrType` is null
        // while being emitted). Without this the result type-erases to `object`
        // and an `Entry`-typed target fails to bind (GS0155).
        return TypeSymbol.ContainsTypeParameter(mapped) || TypeSymbol.ContainsSameCompilationUserType(mapped)
            ? mapped
            : null;
    }

    /// <summary>
    /// Locates the open-generic-definition counterpart of <paramref name="closedMethod"/>
    /// on <paramref name="openDefinition"/>. Match is by metadata token + module,
    /// which is stable for methods on a constructed generic type (the
    /// reflection layer reports the open token regardless of the closing).
    /// </summary>
    /// <param name="openDefinition">The open generic type definition.</param>
    /// <param name="closedMethod">The closed method to project.</param>
    /// <returns>The open method, or <see langword="null"/> when no match.</returns>
    private static System.Reflection.MethodInfo TryGetOpenInstanceMethod(System.Type openDefinition, System.Reflection.MethodInfo closedMethod)
    {
        if (openDefinition == null || closedMethod == null)
        {
            return null;
        }

        if (closedMethod.DeclaringType == openDefinition)
        {
            return closedMethod;
        }

        var token = closedMethod.MetadataToken;
        var module = closedMethod.Module;
        var bindingFlags = System.Reflection.BindingFlags.Public
            | System.Reflection.BindingFlags.NonPublic
            | System.Reflection.BindingFlags.Instance
            | System.Reflection.BindingFlags.Static;
        foreach (var candidate in openDefinition.GetMethods(bindingFlags))
        {
            if (candidate.MetadataToken == token && ReferenceEquals(candidate.Module, module))
            {
                return candidate;
            }
        }

        return null;
    }

    /// <summary>
    /// Issue #891: determines whether the supplied expression is an arrow
    /// lambda with at least one parameter whose type is omitted, so its
    /// parameter type(s) must be inferred from a target delegate.
    /// </summary>
    private static bool IsUntypedArrowLambda(ExpressionSyntax inner)
    {
        if (inner is not LambdaExpressionSyntax lambda)
        {
            return false;
        }

        for (var i = 0; i < lambda.Parameters.Count; i++)
        {
            if (lambda.Parameters[i].Type == null)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #908: collects the parameter lists of the CLR methods a member-style
    /// call could resolve to — static methods of the accessed class, or instance
    /// methods on the receiver plus imported extension methods — so an arrow
    /// lambda argument can be target-typed from its matching delegate parameter
    /// before binding. Extension-method parameter lists have their leading
    /// <c>this</c> receiver parameter stripped so every returned list aligns at a
    /// zero parameter offset, matching the positional argument indices.
    /// </summary>
    private List<ParameterInfo[]> CollectDelegateTargetCandidateParameterLists(
        BoundExpression receiver,
        ImportedClassSymbol classSymbol,
        string methodName)
    {
        var result = new List<ParameterInfo[]>();
        if (classSymbol != null)
        {
            foreach (var m in ClrTypeUtilities.SafeGetMethods(classSymbol.ClassType, BindingFlags.Static | BindingFlags.Public)
                .Where(m => m.Name == methodName))
            {
                result.Add(m.GetParameters());
            }

            return result;
        }

        if (receiver?.Type?.ClrType is System.Type receiverClrType)
        {
            foreach (var m in ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(receiverClrType, BindingFlags.Instance | BindingFlags.Public)
                .Where(m => m.Name == methodName))
            {
                result.Add(m.GetParameters());
            }
        }

        foreach (var ext in this.memberLookup.CollectImportedExtensionMethods(methodName))
        {
            var extParams = ext.GetParameters();
            if (extParams.Length == 0)
            {
                continue;
            }

            // Strip the leading `this` receiver parameter so positional indices
            // line up with the call's explicit arguments (offset 0).
            var stripped = new ParameterInfo[extParams.Length - 1];
            System.Array.Copy(extParams, 1, stripped, 0, stripped.Length);
            result.Add(stripped);
        }

        return result;
    }

    /// <summary>
    /// Issue #891: infers the target delegate type for each deferred un-typed
    /// arrow lambda argument of a member-style call by probing the applicable
    /// candidate methods — instance methods on the receiver, imported
    /// extension methods (LINQ et al.), or static methods of the accessed
    /// class — with the lambda slots treated as unconstrained. Once the
    /// (possibly generic) overload is resolved and its type arguments inferred,
    /// the corresponding closed delegate parameter type target-types the lambda,
    /// which is then bound in place inside <paramref name="boundArgs"/>.
    /// </summary>
    /// <summary>
    /// Issue #951: resolves deferred un-typed arrow-lambda arguments of a
    /// member-style call whose receiver is a <em>user-declared</em>
    /// class/struct/interface (no CLR type to reflect over). For each still-
    /// deferred lambda index, the matching parameter symbol of the candidate
    /// user method(s) supplies the target delegate shape, which target-types
    /// the lambda exactly like the CLR reflection path. When no candidate
    /// exposes a delegate-typed parameter at that position — or candidates
    /// disagree on the shape — the lambda is left deferred so the caller's
    /// fallback binds it without a target (surfacing GS0304).
    /// </summary>
    /// <param name="receiver">The bound receiver of the member call.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="ce">The call syntax (used for the argument syntax nodes).</param>
    /// <param name="deferredIndices">The argument indices still awaiting a target.</param>
    /// <param name="boundArgs">The in-progress bound-argument array, mutated in place.</param>
    private void ResolveDeferredArrowLambdaArgumentsFromUserMethods(
        BoundExpression receiver,
        string methodName,
        CallExpressionSyntax ce,
        List<int> deferredIndices,
        BoundExpression[] boundArgs)
    {
        if (deferredIndices.Count == 0 || receiver?.Type == null)
        {
            return;
        }

        ImmutableArray<FunctionSymbol> candidates;
        switch (receiver.Type)
        {
            case StructSymbol structRecv:
                candidates = TypeMemberModel.GetMethods(structRecv, methodName, MemberQuery.Instance(MemberKinds.Method));
                break;
            case InterfaceSymbol ifaceRecv:
                candidates = TypeMemberModel.GetMethods(ifaceRecv, methodName, MemberQuery.Instance(MemberKinds.Method));
                break;
            case TypeParameterSymbol { InterfaceConstraint: { } constraint }:
                candidates = TypeMemberModel.GetMethods(constraint, methodName, MemberQuery.Instance(MemberKinds.Method));
                break;
            default:
                return;
        }

        if (candidates.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var idx in deferredIndices.ToArray())
        {
            if (boundArgs[idx] is not BoundErrorExpression { Syntax: LambdaExpressionSyntax lambdaSyntax })
            {
                continue;
            }

            FunctionTypeSymbol target = null;
            var disagree = false;
            foreach (var candidate in candidates)
            {
                var offset = candidate.ExplicitReceiverParameter == null ? 0 : 1;
                var paramPos = idx + offset;
                if (paramPos < 0 || paramPos >= candidate.Parameters.Length)
                {
                    continue;
                }

                if (!MemberLookup.TryGetDelegateFunctionTypeFromSymbol(candidate.Parameters[paramPos].Type, out var fn) || fn == null)
                {
                    continue;
                }

                if (target == null)
                {
                    target = fn;
                }
                else if (!ReferenceEquals(target, fn) && !target.Equals(fn))
                {
                    disagree = true;
                    break;
                }
            }

            if (target != null && !disagree)
            {
                boundArgs[idx] = lambdas.BindLambdaExpression(lambdaSyntax, target);
                deferredIndices.Remove(idx);
            }
        }
    }

    private void ResolveDeferredArrowLambdaArguments(
        BoundExpression receiver,
        ImportedClassSymbol classSymbol,
        string methodName,
        CallExpressionSyntax ce,
        System.Type[] explicitTypeArgs,
        List<int> deferredIndices,
        BoundExpression[] boundArgs)
    {
        var probes = new List<(IReadOnlyList<MethodInfo> Methods, int Offset)>();
        if (classSymbol != null)
        {
            var statics = ClrTypeUtilities.SafeGetMethods(classSymbol.ClassType, BindingFlags.Static | BindingFlags.Public)
                .Where(m => m.Name == methodName)
                .ToList();
            if (statics.Count > 0)
            {
                probes.Add((statics, 0));
            }
        }
        else if (receiver?.Type?.ClrType is System.Type receiverClrType)
        {
            var instance = ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(receiverClrType, BindingFlags.Instance | BindingFlags.Public)
                .Where(m => m.Name == methodName)
                .ToList();
            if (instance.Count > 0)
            {
                probes.Add((instance, 0));
            }

            var extensions = this.memberLookup.CollectImportedExtensionMethods(methodName);
            if (extensions.Count > 0)
            {
                probes.Add((extensions, 1));
            }
        }

        if (probes.Count == 0)
        {
            return;
        }

        var deferred = new HashSet<int>(deferredIndices);

        // Issue #903: when the receiver carries a same-compilation user element
        // type (e.g. `List[Check]` where `Check` is a struct/class still being
        // compiled), that element type is erased to `object` at the CLR layer.
        // The reflection-driven inference paths below would therefore bind the
        // lambda parameter as `object` and fail member access in the body
        // (`c.Id` → GS0158). Try a symbol-based inference first that recovers
        // the real element type from the receiver's symbolic `TypeArguments`,
        // builds a `FunctionTypeSymbol` target carrying that type, and binds the
        // lambda against it. This path only succeeds (and pre-empts the CLR
        // paths) when it actually recovers a same-compilation user type, so the
        // referenced-element-type and primitive cases are untouched.
        foreach (var (methods, offset) in probes)
        {
            if (TryMapDeferredLambdaTargetsSymbolic(methods, offset, receiver, ce, deferredIndices, boundArgs, deferred, out var symbolicTargets))
            {
                foreach (var idx in deferredIndices)
                {
                    var inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[idx]);
                    if (inner is LambdaExpressionSyntax lambdaSyntax && symbolicTargets.TryGetValue(idx, out var target))
                    {
                        boundArgs[idx] = lambdas.BindLambdaExpression(lambdaSyntax, target, inferReturnTypeFromBody: true);
                    }
                }

                return;
            }
        }

        foreach (var (methods, offset) in probes)
        {
            var argTypes = new System.Type[boundArgs.Length + offset];
            if (offset == 1)
            {
                argTypes[0] = receiver.Type.ClrType;
            }

            var usable = true;
            for (var i = 0; i < boundArgs.Length; i++)
            {
                if (deferred.Contains(i))
                {
                    // An unconstrained lambda slot: null is skipped by generic
                    // inference and treated as reference-convertible to the
                    // delegate parameter, so the candidate still applies.
                    argTypes[i + offset] = null;
                    continue;
                }

                var t = GetEffectiveArgumentClrTypeForOverloadResolution(boundArgs[i].Type);
                if (t == null && boundArgs[i].Type != TypeSymbol.Null)
                {
                    usable = false;
                    break;
                }

                argTypes[i + offset] = t;
            }

            if (!usable)
            {
                continue;
            }

            var resolution = OverloadResolution.Resolve(methods, argTypes, explicitTypeArgs, scope.References.MapClrTypeToReferences);
            if (resolution.Outcome != OverloadResolution.ResolutionOutcome.Resolved)
            {
                continue;
            }

            var parameters = resolution.Best.GetParameters();
            var targets = new Dictionary<int, FunctionTypeSymbol>();
            var allMapped = true;
            foreach (var idx in deferredIndices)
            {
                var paramIndex = idx + offset;
                if (paramIndex >= parameters.Length)
                {
                    allMapped = false;
                    break;
                }

                var parameterType = parameters[paramIndex].ParameterType;
                if (parameterType == null
                    || parameterType.ContainsGenericParameters
                    || !MemberLookup.TryGetDelegateFunctionType(parameterType, out var fn)
                    || fn == null)
                {
                    allMapped = false;
                    break;
                }

                targets[idx] = fn;
            }

            if (!allMapped)
            {
                continue;
            }

            foreach (var idx in deferredIndices)
            {
                var inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[idx]);
                if (inner is LambdaExpressionSyntax lambdaSyntax)
                {
                    boundArgs[idx] = lambdas.BindLambdaExpression(lambdaSyntax, targets[idx]);
                }
            }

            return;
        }

        // Follow-up to issue #891: the full-inference path above could not
        // map every deferred lambda — typically because the matching generic
        // method's lambda RETURN type is a method type parameter that is only
        // inferable from the lambda body (e.g.
        // Select<TSource,TResult>(IEnumerable<TSource>, Func<TSource,TResult>)).
        // Fall back to partial inference: infer the type parameters reachable
        // from the non-lambda arguments (so the lambda's *parameter* types close)
        // and bind each lambda against a target carrying only those parameter
        // types, leaving its return type to be inferred from the body.
        foreach (var (methods, offset) in probes)
        {
            if (TryMapDeferredLambdaParameterTargets(methods, offset, receiver, ce, deferredIndices, boundArgs, out var partialTargets))
            {
                foreach (var idx in deferredIndices)
                {
                    var inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[idx]);
                    if (inner is LambdaExpressionSyntax lambdaSyntax && partialTargets.TryGetValue(idx, out var target))
                    {
                        boundArgs[idx] = lambdas.BindLambdaExpression(lambdaSyntax, target, inferReturnTypeFromBody: true);
                    }
                }

                return;
            }
        }
    }

    /// <summary>
    /// Follow-up to issue #891: partial-inference fallback for <see cref="ResolveDeferredArrowLambdaArguments"/>.
    /// For each candidate generic method, infers the type parameters reachable
    /// from the non-lambda argument CLR types and resolves the closed parameter
    /// types of every deferred lambda's delegate (arity-matched to the lambda),
    /// even when the delegate's return type remains an un-inferred method type
    /// parameter. Builds a per-slot <see cref="FunctionTypeSymbol"/> target that
    /// carries only the closed parameter types. Candidates must agree on the
    /// resulting parameter types; otherwise the fallback declines (preserving the
    /// existing GS0304 behaviour) to avoid binding against an ambiguous shape.
    /// </summary>
    private bool TryMapDeferredLambdaParameterTargets(
        IReadOnlyList<MethodInfo> methods,
        int offset,
        BoundExpression receiver,
        CallExpressionSyntax ce,
        List<int> deferredIndices,
        BoundExpression[] boundArgs,
        out Dictionary<int, FunctionTypeSymbol> targets)
    {
        targets = null;

        var deferred = new HashSet<int>(deferredIndices);
        var argTypes = new System.Type[boundArgs.Length + offset];
        if (offset == 1)
        {
            if (receiver?.Type?.ClrType is not System.Type receiverClrType)
            {
                return false;
            }

            argTypes[0] = receiverClrType;
        }

        for (var i = 0; i < boundArgs.Length; i++)
        {
            if (deferred.Contains(i))
            {
                argTypes[i + offset] = null;
                continue;
            }

            var t = GetEffectiveArgumentClrTypeForOverloadResolution(boundArgs[i].Type);
            if (t == null && boundArgs[i].Type != TypeSymbol.Null)
            {
                return false;
            }

            argTypes[i + offset] = t;
        }

        var lambdaParamIndices = new List<int>();
        var arities = new List<int>();
        var argIndexByParamIndex = new Dictionary<int, int>();
        foreach (var idx in deferredIndices)
        {
            var inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[idx]);
            if (inner is not LambdaExpressionSyntax lambda)
            {
                return false;
            }

            var paramIndex = idx + offset;
            lambdaParamIndices.Add(paramIndex);
            arities.Add(lambda.Parameters.Count);
            argIndexByParamIndex[paramIndex] = idx;
        }

        Dictionary<int, System.Type[]> agreed = null;
        foreach (var method in methods)
        {
            if (method == null || (!method.IsGenericMethodDefinition && !method.IsGenericMethod))
            {
                continue;
            }

            if (!OverloadResolution.TryInferDeferredLambdaParameterTypes(method, argTypes, lambdaParamIndices, arities, out var closed))
            {
                continue;
            }

            if (agreed == null)
            {
                agreed = closed;
            }
            else if (!DeferredLambdaParameterTypesAgree(agreed, closed))
            {
                return false;
            }
        }

        if (agreed == null)
        {
            return false;
        }

        var built = new Dictionary<int, FunctionTypeSymbol>();
        foreach (var kv in agreed)
        {
            var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(kv.Value.Length);
            foreach (var clr in kv.Value)
            {
                var symbol = TypeSymbol.FromClrType(clr);
                if (symbol == null || symbol == TypeSymbol.Error)
                {
                    return false;
                }

                parameterTypes.Add(symbol);
            }

            // The return slot is a placeholder; binding passes
            // inferReturnTypeFromBody so the lambda infers its own return type.
            built[argIndexByParamIndex[kv.Key]] = FunctionTypeSymbol.Get(parameterTypes.ToImmutable(), default, TypeSymbol.Object);
        }

        targets = built;
        return true;
    }

    private static bool DeferredLambdaParameterTypesAgree(Dictionary<int, System.Type[]> a, Dictionary<int, System.Type[]> b)
    {
        if (a.Count != b.Count)
        {
            return false;
        }

        foreach (var kv in a)
        {
            if (!b.TryGetValue(kv.Key, out var other) || other.Length != kv.Value.Length)
            {
                return false;
            }

            for (var i = 0; i < kv.Value.Length; i++)
            {
                if (!ClrTypeUtilities.AreSame(kv.Value[i], other[i]))
                {
                    return false;
                }
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #903: symbol-based deferred arrow-lambda target inference. The
    /// CLR-driven <see cref="ResolveDeferredArrowLambdaArguments"/> paths infer
    /// the lambda's parameter type from the receiver's <em>CLR</em> type, which
    /// for a same-compilation generic element type (e.g. <c>List[Check]</c>
    /// where <c>Check</c> is being compiled) is erased to <c>List&lt;object&gt;</c>
    /// — so the lambda parameter would bind as <c>object</c> and member access
    /// in the body fails. This routine instead recovers the element type
    /// symbolically: it unifies the receiver/argument <see cref="TypeSymbol"/>s
    /// against each candidate generic method's open parameters (reusing
    /// <see cref="MemberLookup.InferSymbolicMethodTypeArguments"/>), then maps
    /// each deferred lambda's delegate <em>parameter</em> types through those
    /// inferred symbolic arguments (reusing
    /// <see cref="MemberLookup.MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray{TypeSymbol}, MethodInfo, ImmutableArray{TypeSymbol})"/>).
    /// A per-slot <see cref="FunctionTypeSymbol"/> carrying those parameter
    /// types is produced (its return type is a placeholder — callers bind with
    /// <c>inferReturnTypeFromBody</c>). Candidates must agree on the recovered
    /// parameter types. The method succeeds <em>only</em> when at least one
    /// recovered parameter type is a same-compilation user type, so the
    /// referenced-element and primitive cases continue through the existing
    /// CLR paths unchanged.
    /// </summary>
    private bool TryMapDeferredLambdaTargetsSymbolic(
        IReadOnlyList<MethodInfo> methods,
        int offset,
        BoundExpression receiver,
        CallExpressionSyntax ce,
        List<int> deferredIndices,
        BoundExpression[] boundArgs,
        HashSet<int> deferred,
        out Dictionary<int, FunctionTypeSymbol> targets)
    {
        targets = null;

        // Symbolic recovery is anchored on the candidate's symbolic argument
        // vector: the receiver's symbolic TypeArguments for instance/extension
        // calls, or — for a static call (issue #932:
        // `Assert.DoesNotContain(items, i -> ...)`) — the same-compilation user
        // type carried by a non-deferred argument such as `items : List[Item]`.
        // An extension probe (offset == 1) places the receiver in slot 0, so it
        // genuinely needs a receiver; a static/instance probe (offset == 0) does
        // not. The success gate below (`anySameCompilationType`) still ensures
        // this path only fires — and pre-empts the CLR erasure paths — when a
        // real same-compilation user type is recovered.
        if (offset == 1 && receiver?.Type == null)
        {
            return false;
        }

        // Build the symbolic argument vector as the candidate method sees it:
        // for an extension probe (offset == 1) the receiver is slot 0 ("this"),
        // followed by the user arguments. Deferred lambda slots are left null so
        // unification skips them.
        var symbolicArgs = new TypeSymbol[boundArgs.Length + offset];
        if (offset == 1)
        {
            symbolicArgs[0] = receiver.Type;
        }

        for (var i = 0; i < boundArgs.Length; i++)
        {
            symbolicArgs[i + offset] = deferred.Contains(i) ? null : boundArgs[i]?.Type;
        }

        var symbolicArgVector = ImmutableArray.Create(symbolicArgs);

        // Record the expected delegate arity for each deferred lambda slot.
        var arityByIndex = new Dictionary<int, int>();
        foreach (var idx in deferredIndices)
        {
            var inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[idx]);
            if (inner is not LambdaExpressionSyntax lambda)
            {
                return false;
            }

            arityByIndex[idx] = lambda.Parameters.Count;
        }

        Dictionary<int, ImmutableArray<TypeSymbol>> agreed = null;
        var anySameCompilationType = false;

        foreach (var method in methods)
        {
            if (method == null || (!method.IsGenericMethodDefinition && !method.IsGenericMethod))
            {
                continue;
            }

            MethodInfo openMethod;
            ParameterInfo[] openParameters;
            try
            {
                openMethod = method.IsGenericMethodDefinition ? method : method.GetGenericMethodDefinition();
                if (!openMethod.IsGenericMethodDefinition)
                {
                    continue;
                }

                openParameters = openMethod.GetParameters();
            }
            catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
            {
                continue;
            }

            if (openParameters.Length < symbolicArgs.Length)
            {
                continue;
            }

            var inferred = MemberLookup.InferSymbolicMethodTypeArguments(openMethod, symbolicArgVector);
            var methodTypeArgs = ImmutableArray.Create(inferred);

            var slotTargets = new Dictionary<int, ImmutableArray<TypeSymbol>>();
            var candidateUsable = true;
            var candidateHasSameCompilationType = false;

            foreach (var idx in deferredIndices)
            {
                var paramIndex = idx + offset;
                if (paramIndex >= openParameters.Length)
                {
                    candidateUsable = false;
                    break;
                }

                MethodInfo invoke;
                ParameterInfo[] invokeParameters;
                try
                {
                    var delegateType = openParameters[paramIndex].ParameterType;
                    invoke = delegateType?.GetMethod("Invoke");
                    invokeParameters = invoke?.GetParameters();
                }
                catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
                {
                    candidateUsable = false;
                    break;
                }

                if (invoke == null || invokeParameters == null || invokeParameters.Length != arityByIndex[idx])
                {
                    candidateUsable = false;
                    break;
                }

                // Issue #903: only trust this candidate's delegate parameter
                // shape when every method type parameter reachable from it was
                // actually resolved by unifying the receiver/arguments. When a
                // candidate's "this" parameter does not match the receiver
                // shape (e.g. a `Single` overload over `IQueryable<T>` against a
                // `List` receiver), the relevant slot stays unresolved and
                // MapOpenClrTypeToSymbolic would otherwise surface a bogus open
                // parameter (an ImportedTypeSymbol named "T") that neither
                // ContainsTypeParameter nor ContainsSameCompilationUserType
                // flags — which would then disagree with the correct candidate
                // and abort the whole inference. Skip such candidates instead.
                var unresolvedSlot = false;
                foreach (var invokeParameter in invokeParameters)
                {
                    if (!AllMethodTypeParametersResolved(invokeParameter.ParameterType, openMethod, inferred))
                    {
                        unresolvedSlot = true;
                        break;
                    }
                }

                if (unresolvedSlot)
                {
                    candidateUsable = false;
                    break;
                }

                var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(invokeParameters.Length);
                var slotUsable = true;
                foreach (var invokeParameter in invokeParameters)
                {
                    var mapped = MemberLookup.MapOpenClrTypeToSymbolic(invokeParameter.ParameterType, openDefinition: null, typeArguments: default, openMethodDefinition: openMethod, methodTypeArguments: methodTypeArgs);
                    if (mapped == null || mapped == TypeSymbol.Error || TypeSymbol.ContainsTypeParameter(mapped))
                    {
                        slotUsable = false;
                        break;
                    }

                    parameterTypes.Add(mapped);
                    if (TypeSymbol.ContainsSameCompilationUserType(mapped))
                    {
                        candidateHasSameCompilationType = true;
                    }
                }

                if (!slotUsable)
                {
                    candidateUsable = false;
                    break;
                }

                slotTargets[idx] = parameterTypes.ToImmutable();
            }

            if (!candidateUsable || slotTargets.Count != deferredIndices.Count)
            {
                continue;
            }

            if (agreed == null)
            {
                agreed = slotTargets;
            }
            else if (!SymbolicLambdaParameterTypesAgree(agreed, slotTargets))
            {
                return false;
            }

            anySameCompilationType |= candidateHasSameCompilationType;
        }

        if (agreed == null || !anySameCompilationType)
        {
            return false;
        }

        var built = new Dictionary<int, FunctionTypeSymbol>();
        foreach (var kv in agreed)
        {
            // The return slot is a placeholder; callers bind with
            // inferReturnTypeFromBody so the lambda infers its own return type.
            built[kv.Key] = FunctionTypeSymbol.Get(kv.Value, TypeSymbol.Object);
        }

        targets = built;
        return true;
    }

    private static bool SymbolicLambdaParameterTypesAgree(Dictionary<int, ImmutableArray<TypeSymbol>> a, Dictionary<int, ImmutableArray<TypeSymbol>> b)
    {
        if (a.Count != b.Count)
        {
            return false;
        }

        foreach (var kv in a)
        {
            if (!b.TryGetValue(kv.Key, out var other) || other.Length != kv.Value.Length)
            {
                return false;
            }

            for (var i = 0; i < kv.Value.Length; i++)
            {
                if (!Equals(kv.Value[i], other[i]))
                {
                    return false;
                }
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #903: returns <see langword="true"/> when every <em>method</em>
    /// generic parameter (declared on <paramref name="openMethod"/>) reachable
    /// from <paramref name="openType"/> has a non-<see langword="null"/> entry in
    /// <paramref name="inferred"/> — i.e. it was actually resolved by unifying
    /// the receiver/arguments. Used to discard candidate methods whose delegate
    /// parameter shape contains a method type parameter that the call did not
    /// determine (e.g. a <c>Single</c> overload whose <c>this</c> parameter does
    /// not match the receiver), which would otherwise surface a bogus open
    /// parameter symbol via
    /// <see cref="MemberLookup.MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray{TypeSymbol}, MethodInfo, ImmutableArray{TypeSymbol})"/>.
    /// </summary>
    private static bool AllMethodTypeParametersResolved(Type openType, MethodInfo openMethod, TypeSymbol[] inferred)
    {
        if (openType == null)
        {
            return false;
        }

        try
        {
            if (openType.IsGenericParameter)
            {
                // A type-level parameter (declared on the receiver type) is
                // resolved through the receiver's TypeArguments, not the method
                // type-arg vector, so it does not gate this candidate.
                if (openType.DeclaringMethod == null)
                {
                    return true;
                }

                if (!ReferenceEquals(openType.DeclaringMethod, openMethod)
                    && openType.DeclaringMethod.MetadataToken != openMethod.MetadataToken)
                {
                    return true;
                }

                var pos = openType.GenericParameterPosition;
                return (uint)pos < (uint)inferred.Length && inferred[pos] != null;
            }

            if (openType.IsByRef || openType.IsArray)
            {
                return AllMethodTypeParametersResolved(openType.GetElementType(), openMethod, inferred);
            }

            if (openType.IsGenericType)
            {
                foreach (var arg in openType.GetGenericArguments())
                {
                    if (!AllMethodTypeParametersResolved(arg, openMethod, inferred))
                    {
                        return false;
                    }
                }
            }

            return true;
        }
        catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
        {
            return false;
        }
    }

    /// <summary>
    /// Issue #977: detects whether the argument at <paramref name="index"/> of an
    /// imported-method call is an inline <c>out var</c>/<c>out let</c>/<c>out _</c>
    /// declaration whose type is omitted (and therefore must be inferred from the
    /// resolved overload). An explicitly typed inline declaration is excluded
    /// because its local is already declared with a known type in the eager pass.
    /// </summary>
    /// <param name="ce">The call expression syntax.</param>
    /// <param name="index">The source argument index.</param>
    /// <param name="refArg">The matched ref-argument syntax, when applicable.</param>
    /// <returns><see langword="true"/> when the argument is a type-omitted inline out declaration.</returns>
    private static bool TryGetInlineOutVarArgument(CallExpressionSyntax ce, int index, out RefArgumentExpressionSyntax refArg)
    {
        refArg = null;
        if (index < 0 || index >= ce.Arguments.Count)
        {
            return false;
        }

        if (OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[index]) is RefArgumentExpressionSyntax candidate
            && candidate.IsInlineDeclaration
            && candidate.DeclaredType == null)
        {
            refArg = candidate;
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #977: re-binds inline <c>out var</c>/<c>out let</c>/<c>out _</c>
    /// placeholder arguments against the by-ref parameters of the resolved
    /// imported method, declaring each new local with the parameter's pointee
    /// type. Returns the (possibly rebuilt) argument vector.
    /// </summary>
    /// <param name="ce">The call expression syntax.</param>
    /// <param name="arguments">The bound arguments (with placeholder out-var entries).</param>
    /// <param name="resolvedMethod">The chosen imported method (constructed if generic).</param>
    /// <param name="parameterMapping">The source-argument → parameter-position mapping; default for positional calls.</param>
    /// <returns>The argument vector with inline out-var placeholders rebound.</returns>
    private ImmutableArray<BoundExpression> RebindInlineOutVarArguments(
        CallExpressionSyntax ce,
        ImmutableArray<BoundExpression> arguments,
        System.Reflection.MethodInfo resolvedMethod,
        ImmutableArray<int> parameterMapping)
    {
        ImmutableArray<BoundExpression>.Builder rebuilt = null;
        System.Reflection.ParameterInfo[] parameters = null;
        for (var i = 0; i < arguments.Length; i++)
        {
            if (!TryGetInlineOutVarArgument(ce, i, out var refArg))
            {
                continue;
            }

            parameters ??= resolvedMethod.GetParameters();
            var paramIndex = !parameterMapping.IsDefault && i < parameterMapping.Length ? parameterMapping[i] : i;
            if (paramIndex < 0 || paramIndex >= parameters.Length)
            {
                continue;
            }

            var clrParameterType = parameters[paramIndex].ParameterType;
            var pointeeClr = clrParameterType.IsByRef ? clrParameterType.GetElementType() : clrParameterType;
            var pointeeType = TypeSymbol.FromClrType(pointeeClr);
            var syntheticParameter = new ParameterSymbol(
                parameters[paramIndex].Name ?? "value",
                pointeeType,
                refKind: RefKind.Out);

            var rebound = BindRefArgumentExpression(refArg, syntheticParameter);
            rebuilt ??= arguments.ToBuilder();
            rebuilt[i] = rebound;
        }

        return rebuilt != null ? rebuilt.ToImmutable() : arguments;
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

        // Issue #311: resolve an explicit `[T1, T2]` type-argument list (e.g.
        // `Array.Empty[string]()`) into mapped CLR types up front so every
        // generic-method dispatch path below can close the candidate.
        if (!TryResolveExplicitMethodTypeArgs(ce.TypeArgumentList, out var explicitTypeArgs, out var typeArgSymbols))
        {
            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
            return new BoundErrorExpression(null);
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>();
        var deferredArrowLambdaIndices = new List<int>();
        List<ParameterInfo[]> delegateTargetCandidateParams = null;
        var delegateTargetCandidatesComputed = false;
        var argSlot = 0;
        foreach (var argument in ce.Arguments)
        {
            var inner = OverloadResolver.UnwrapNamedArgumentValue(argument);
            if (inner is RefArgumentExpressionSyntax refArg)
            {
                boundArguments.Add(BindRefArgumentExpression(refArg, parameter: null));
            }
            else if (argumentNames.IsDefault && IsUntypedArrowLambda(inner))
            {
                // Issue #891: defer binding of an un-typed arrow lambda until
                // the target delegate type is known. Binding it now would emit
                // GS0304 (cannot infer parameter type) and produce an error-typed
                // argument that aborts overload resolution — which is exactly why
                // `list.Single((c) -> c.Id == "x")` reported "Cannot find function
                // Single" while the explicit `func(c DoctorCheck) bool { ... }`
                // form worked. The placeholder keeps argument positions aligned;
                // the real binding happens once the (possibly generic) overload —
                // including LINQ extension methods — has been resolved below.
                deferredArrowLambdaIndices.Add(argSlot);
                boundArguments.Add(new BoundErrorExpression(inner));
            }
            else if (inner is LambdaExpressionSyntax)
            {
                // Issue #908: target-type an arrow lambda argument from the
                // matching delegate-typed parameter of the applicable CLR
                // static/instance/extension methods before binding it, mirroring
                // the constructor path (BindCallArgumentWithDelegateTargetTyping).
                // Without this, `Factory.CreateStatic(() -> MemoryStream())`
                // binds the lambda with its body-derived return type
                // (`() -> MemoryStream`) before overload resolution and fails to
                // match a `Func<Stream>` parameter (GS0159). Pinning the return
                // type from the delegate target yields `() -> Stream` directly so
                // the call resolves and the produced delegate is created over a
                // method whose return already matches the parameter.
                if (!delegateTargetCandidatesComputed)
                {
                    delegateTargetCandidatesComputed = true;
                    delegateTargetCandidateParams = CollectDelegateTargetCandidateParameterLists(receiver, classSymbol, methodName);
                }

                var argName = argumentNames.IsDefault ? null : argumentNames[argSlot];
                boundArguments.Add(BindCallArgumentWithDelegateTargetTyping(
                    argument, delegateTargetCandidateParams, sourceArgIndex: argSlot, argName: argName, paramOffset: 0));
            }
            else
            {
                boundArguments.Add(BindExpression(inner));
            }

            argSlot++;
        }

        if (deferredArrowLambdaIndices.Count > 0)
        {
            var mutableArgs = boundArguments.ToArray();
            ResolveDeferredArrowLambdaArguments(receiver, classSymbol, methodName, ce, explicitTypeArgs, deferredArrowLambdaIndices, mutableArgs);

            // Issue #951: the reflection-driven resolution above only covers CLR
            // (imported) methods. When the receiver is a user-declared
            // class/struct/interface, recover the target delegate shape from the
            // user method's own parameter symbols so an arrow lambda passed to a
            // user method with a delegate-typed parameter (e.g.
            // `calc.Apply((x) -> x * 2)`) infers its parameter type too.
            ResolveDeferredArrowLambdaArgumentsFromUserMethods(receiver, methodName, ce, deferredArrowLambdaIndices, mutableArgs);

            // Any lambda whose target could not be inferred is now bound without
            // a target so the established GS0304 diagnostic still surfaces.
            foreach (var idx in deferredArrowLambdaIndices)
            {
                if (mutableArgs[idx] is BoundErrorExpression placeholder && placeholder.Syntax is LambdaExpressionSyntax pendingLambda)
                {
                    mutableArgs[idx] = lambdas.BindLambdaExpression(pendingLambda);
                }
            }

            boundArguments.Clear();
            boundArguments.AddRange(mutableArgs);
        }

        var arguments = boundArguments.ToImmutable();

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
                var staticHandlerArgs = ApplyInterpolatedStringHandlers(staticParameters, staticRebound, receiver: null, ce.Location, staticDownstreamMapping, out var staticHandlerPrelude, out _);

                // Issue #889: void-ize value-returning func/arrow literals passed
                // to void-returning delegate parameters (System.Action / Action<...>)
                // before CLR parameter conversion, mirroring the instance path.
                var staticDelegateArgs = RebindFunctionLiteralDelegateArguments(staticHandlerArgs, staticParameters, staticDownstreamMapping);

                // Issue #506 follow-up: ensure value-type → object boxing fires
                // for fixed-arity CLR static calls (e.g. `String.Format("{0}", 42)`
                // selecting the fixed `(string, object)` overload).
                var staticConvertedArgs = conversions.BindClrParameterConversions(staticDelegateArgs, staticParameters, ce, staticDownstreamMapping);
                var staticArguments = OverloadResolver.BuildOrderedCallArguments(staticConvertedArgs, staticDownstreamMapping, staticParameters);
                var refKinds = ComputeArgumentRefKinds(staticParameters);
                overloads.ValidateRefArguments(staticArguments, refKinds, methodName, ce.Location);
                BoundExpression staticCall = new BoundImportedCallExpression(null, staticFn, staticArguments, refKinds, typeArgSymbols);
                return WrapWithHandlerPrelude(staticCall, staticHandlerPrelude, ce);
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
                var ifaceOverloads = TypeMemberModel.GetMethods(ifaceRecv, methodName, MemberQuery.Instance(MemberKinds.Method));

                // ADR-0090 / issue #756: private interface helpers are visible
                // ONLY when the call is made from inside another member of the
                // same interface declaration. Both instance and static
                // members of the same interface qualify (a private static
                // helper can be called from a static-virtual default body on
                // the same interface, etc.). When the current function's
                // ReceiverType / StaticOwnerType points at the same
                // InterfaceSymbol — including the generic-definition or any
                // constructed instance — widen the candidate set with the
                // private overloads.
                var owningIfaceDef = ifaceRecv.Definition ?? ifaceRecv;
                if (IsInsideSameInterface(owningIfaceDef))
                {
                    var privateOverloads = ifaceRecv.GetPrivateMethods(methodName);
                    if (privateOverloads.Length > 0)
                    {
                        ifaceOverloads = ifaceOverloads.AddRange(privateOverloads);
                    }
                }
                else if (ifaceOverloads.Length == 0)
                {
                    // Probe the private bucket so we can give a precise
                    // visibility diagnostic instead of the generic "method
                    // not found" channel.
                    var probePriv = ifaceRecv.GetPrivateMethods(methodName);
                    if (probePriv.Length > 0)
                    {
                        Diagnostics.ReportPrivateInterfaceMemberNotAccessible(ce.Location, owningIfaceDef.Name, methodName);
                        return new BoundErrorExpression(null);
                    }
                }

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

            // Issue #1052 (was Phase 4.2b / ADR-0020 sealed-only): dispatch
            // through a type parameter's user-declared interface constraint,
            // just as if the receiver were typed as the interface itself. The
            // constrained type parameter is threaded into the bound call so the
            // emitter produces a verifiable `constrained. !!T  callvirt` sequence
            // rather than a bare `callvirt` on the unboxed value.
            if (receiver != null && receiver.Type is TypeParameterSymbol tpRecv && tpRecv.InterfaceConstraint != null)
            {
                var tpOverloads = TypeMemberModel.GetMethods(tpRecv.InterfaceConstraint, methodName, MemberQuery.Instance(MemberKinds.Method));
                if (tpOverloads.Length > 0)
                {
                    var tpIfaceMethod = overloads.SelectInstanceOverloadOrReport(tpOverloads, arguments, ce, methodName, argumentNames);
                    if (tpIfaceMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    return overloads.BindUserInstanceCall(receiver, tpIfaceMethod, arguments, ce, argumentNames, constrainedReceiverTypeParameter: tpRecv);
                }
            }

            // Issue #1056: dispatch through a type parameter's base-class
            // constraint, just as if the receiver were typed as the base class
            // itself (e.g. `x.Speak()` where `x : T` and `T : Animal`). The
            // constrained type parameter is threaded into the bound call so the
            // emitter produces a verifiable `constrained. !!T  callvirt
            // Animal::Speak()` sequence. The `constrained.` prefix is required
            // even though `T` is a reference type: a bare `callvirt` on the
            // unboxed `!!T` value is rejected by the verifier (StackUnexpected),
            // because the static stack type is `!!T`, not the base class. Unlike
            // the interface paths the method token is the class's own MethodDef
            // (resolved by EmitUserInstanceCall when the constraint type is not
            // an interface), so no interface MemberRef is produced.
            if (receiver != null && receiver.Type is TypeParameterSymbol tpClassRecv
                && tpClassRecv.ClassConstraint is StructSymbol tpClassConstraint)
            {
                var tpClassOverloads = TypeMemberModel.GetMethods(tpClassConstraint, methodName, MemberQuery.Instance(MemberKinds.Method));
                if (tpClassOverloads.Length > 0)
                {
                    var tpClassMethod = overloads.SelectInstanceOverloadOrReport(tpClassOverloads, arguments, ce, methodName, argumentNames);
                    if (tpClassMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    return overloads.BindUserInstanceCall(receiver, tpClassMethod, arguments, ce, argumentNames, constrainedReceiverTypeParameter: tpClassRecv);
                }
            }

            // Issue #943: dispatch through a type parameter's *imported CLR*
            // interface constraint (generic or not), e.g. `a.CompareTo(b)` where
            // `a : T` and `T : IComparable[T]`. Emitted as a verifiable
            // `constrained. !!T  callvirt IComparable`1<!!T>::CompareTo(!0)`.
            if (receiver != null && receiver.Type is TypeParameterSymbol tpClrRecv
                && tpClrRecv.ClrInterfaceConstraint != null
                && TryBindConstrainedClrInterfaceCall(receiver, tpClrRecv, methodName, arguments, ce, argumentNames, out var constrainedCall))
            {
                return constrainedCall;
            }

            // Phase 3.B.3 sub-step 2b: dispatch to a user-defined class method
            // if receiver is a user struct symbol.
            if (receiver != null && receiver.Type is StructSymbol userClass)
            {
                var userOverloads = TypeMemberModel.GetMethods(userClass, methodName, MemberQuery.Instance(MemberKinds.Method));
                if (userOverloads.Length > 0)
                {
                    var userMethod = overloads.SelectInstanceOverloadOrReport(userOverloads, arguments, ce, methodName, argumentNames);
                    if (userMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    return overloads.BindUserInstanceCall(receiver, userMethod, arguments, ce, argumentNames);
                }

                // ADR-0085 / issue #726: a class that does not override an
                // inherited default interface method can still be called by
                // the unqualified method name on a class-typed receiver. The
                // binder routes the call to the interface's default method;
                // the evaluator and emitter both rely on virtual dispatch
                // through the interface slot to land on any subsequent
                // override.
                var defaultIfaceMethod = TryFindDefaultInterfaceMethod(userClass, methodName, arguments, ce, argumentNames);
                if (defaultIfaceMethod != null)
                {
                    return overloads.BindUserInstanceCall(receiver, defaultIfaceMethod, arguments, ce, argumentNames);
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
            var priorityOverloads = TypeMemberModel.GetMethods(userClassPriority, methodName, MemberQuery.Instance(MemberKinds.Method));
            if (priorityOverloads.Length > 0)
            {
                var userMethodPriority = overloads.SelectInstanceOverloadOrReport(priorityOverloads, arguments, ce, methodName, argumentNames);
                if (userMethodPriority == null)
                {
                    return new BoundErrorExpression(null);
                }

                return overloads.BindUserInstanceCall(receiver, userMethodPriority, arguments, ce, argumentNames);
            }

            // ADR-0085 / issue #726: default-interface-method fallback —
            // same as the primary branch above.
            var defaultIfaceMethodPriority = TryFindDefaultInterfaceMethod(userClassPriority, methodName, arguments, ce, argumentNames);
            if (defaultIfaceMethodPriority != null)
            {
                return overloads.BindUserInstanceCall(receiver, defaultIfaceMethodPriority, arguments, ce, argumentNames);
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
                // Issue #977: an inline `out var`/`out let`/`out _` argument was
                // bound to a placeholder address-of (Error pointee) in the eager
                // pass because the parameter type was unknown. Feed a sentinel so
                // overload resolution treats it as matching any by-ref parameter;
                // the local's type is inferred from the chosen overload below.
                if (TryGetInlineOutVarArgument(ce, i, out _))
                {
                    argTypes[i] = OverloadResolution.InlineOutVarArgumentType;
                    continue;
                }

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
                            // Issue #977: now that the overload is chosen, re-bind
                            // any inline `out var`/`out let`/`out _` placeholders
                            // against the resolved by-ref parameter so the new
                            // local is declared with the inferred pointee type.
                            arguments = RebindInlineOutVarArguments(ce, arguments, resolution.Best, resolution.ParameterMapping);
                            var instSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(receiver?.Type, ImmutableArray.CreateRange(arguments.Select(a => a?.Type)));
                            var instSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(resolution.Best, typeArgSymbols, instSymbolicArgs);
                            var instTypeArgSymbolsForCall = !instSymbolicTypeArgs.IsDefault ? instSymbolicTypeArgs : typeArgSymbols;
                            var returnType = ResolveImportedGenericReturnType(resolution.Best, typeArgSymbols)
                                ?? MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(resolution.Best, instSymbolicTypeArgs, receiver?.Type)
                                ?? ResolveInstanceReturnTypeFromReceiver(receiver?.Type, resolution.Best)
                                ?? MapClrMemberType(resolution.Best.ReturnType);
                            var instParameters = resolution.Best.GetParameters();
                            var instMapping = resolution.ParameterMapping;
                            var instExpandedArgs = resolution.IsExpanded
                                ? overloads.ExpandParamsArguments(arguments, instParameters, ce, parameterMapping: instMapping)
                                : arguments;
                            var instDownstreamMapping = resolution.IsExpanded ? default : instMapping;
                            var instRebound = RebindFormattableInterpolationArguments(instExpandedArgs, ce.Arguments, instParameters, instDownstreamMapping);
                            var instHandlerArgs = ApplyInterpolatedStringHandlers(instParameters, instRebound, receiver, ce.Location, instDownstreamMapping, out var instHandlerPrelude, out var instUpdatedReceiver);
                            var instDelegateArgs = RebindFunctionLiteralDelegateArguments(instHandlerArgs, instParameters, instDownstreamMapping);
                            var instConvertedArgs = conversions.BindClrParameterConversions(instDelegateArgs, instParameters, ce, instDownstreamMapping, method: resolution.Best, receiverType: receiver?.Type);
                            var instArguments = OverloadResolver.BuildOrderedCallArguments(instConvertedArgs, instDownstreamMapping, instParameters);
                            var instRefKinds = ComputeArgumentRefKinds(instParameters);
                            overloads.ValidateRefArguments(instArguments, instRefKinds, methodName, ce.Location);
                            BoundExpression instCall = ConversionClassifier.AutoDereferenceRefReturn(new BoundImportedInstanceCallExpression(null, instUpdatedReceiver ?? receiver, resolution.Best, returnType, instArguments, instRefKinds, instTypeArgSymbolsForCall));
                            return WrapWithHandlerPrelude(instCall, instHandlerPrelude, ce);
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
    /// <summary>
    /// ADR-0085 / issue #726: when a class-typed receiver does not have a
    /// matching instance method, look at the class's implemented interfaces
    /// (including bases) for a default-method (DIM) whose signature accepts
    /// the supplied arguments. Returns the selected interface method or
    /// <c>null</c> if there is no suitable candidate. Diamond conflicts are
    /// reported by <c>VerifyInterfaceImplementations</c>; this helper picks
    /// the first matching candidate so that diagnostics are not duplicated
    /// at every call site.
    /// </summary>
    /// <summary>
    /// ADR-0090 / issue #756: returns <c>true</c> when the current function
    /// being bound (the enclosing default-method body) belongs to the same
    /// interface declaration as <paramref name="ifaceDef"/>. Used at call
    /// sites that resolve through an interface receiver to decide whether
    /// the private-helper bucket is in scope.
    /// </summary>
    /// <param name="ifaceDef">The interface generic definition (callers
    /// pass <c>InterfaceSymbol.Definition</c>) being targeted.</param>
    /// <returns>True when the enclosing function's owning interface is the
    /// same definition.</returns>
    private bool IsInsideSameInterface(InterfaceSymbol ifaceDef)
    {
        var current = function;
        if (current == null || ifaceDef == null)
        {
            return false;
        }

        InterfaceSymbol ownerIface = null;
        if (current.ReceiverType is InterfaceSymbol ri)
        {
            ownerIface = ri;
        }
        else if (current.StaticOwnerType is InterfaceSymbol si)
        {
            ownerIface = si;
        }

        if (ownerIface == null)
        {
            return false;
        }

        var ownerDef = ownerIface.Definition ?? ownerIface;
        return ReferenceEquals(ownerDef, ifaceDef);
    }

    private FunctionSymbol TryFindDefaultInterfaceMethod(
        StructSymbol receiverClass,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames)
    {
        for (var c = receiverClass; c != null; c = c.BaseClass)
        {
            foreach (var iface in c.Interfaces)
            {
                if (iface == null)
                {
                    continue;
                }

                var candidates = TypeMemberModel.GetMethods(iface, methodName, MemberQuery.Instance(MemberKinds.Method));
                var defaultsOnly = ImmutableArray.CreateBuilder<FunctionSymbol>();
                for (var i = 0; i < candidates.Length; i++)
                {
                    if (InterfaceSymbol.HasDefaultBody(candidates[i]))
                    {
                        defaultsOnly.Add(candidates[i]);
                    }
                }

                if (defaultsOnly.Count == 0)
                {
                    continue;
                }

                var selected = this.overloads.SelectInstanceOverloadOrReport(defaultsOnly.ToImmutable(), arguments, ce, methodName, argumentNames);
                if (selected != null)
                {
                    return selected;
                }
            }
        }

        return null;
    }

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

        // ADR-0102 follow-up / issue #818: when the field's declared
        // function type spells a trailing variadic parameter, pack /
        // pass-through trailing args at the call site.
        var fldIsVariadic = functionType.HasVariadic;
        var fldFixedCount = fldIsVariadic ? functionType.ParameterTypes.Length - 1 : functionType.ParameterTypes.Length;
        if (fldIsVariadic)
        {
            if (arguments.Length < fldFixedCount)
            {
                Diagnostics.ReportTooFewArgumentsForVariadic(ce.Location, methodName, fldFixedCount, arguments.Length);
                result = new BoundErrorExpression(null);
                return true;
            }
        }
        else if (arguments.Length != functionType.ParameterTypes.Length)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, methodName, functionType.ParameterTypes.Length, arguments.Length);
            result = new BoundErrorExpression(null);
            return true;
        }

        ImmutableArray<BoundExpression> permutedArgs = arguments;
        if (fldIsVariadic)
        {
            var sliceType = (SliceTypeSymbol)functionType.ParameterTypes[functionType.ParameterTypes.Length - 1];
            var trailing = arguments.Length - fldFixedCount;
            var passThrough = trailing == 1 && arguments[fldFixedCount].Type == sliceType;
            if (!passThrough)
            {
                var packed = ImmutableArray.CreateBuilder<BoundExpression>(trailing);
                for (var i = fldFixedCount; i < arguments.Length; i++)
                {
                    packed.Add(arguments[i]);
                }

                var rebuilt = ImmutableArray.CreateBuilder<BoundExpression>(fldFixedCount + 1);
                for (var i = 0; i < fldFixedCount; i++)
                {
                    rebuilt.Add(arguments[i]);
                }

                rebuilt.Add(new BoundArrayCreationExpression(ce, sliceType, packed.MoveToImmutable()));
                permutedArgs = rebuilt.ToImmutable();
            }
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(permutedArgs.Length);
        for (var i = 0; i < permutedArgs.Length; i++)
        {
            var argLoc = i < ce.Arguments.Count ? ce.Arguments[i].Location : ce.Location;
            convertedArgs.Add(conversions.BindConversion(argLoc, permutedArgs[i], functionType.ParameterTypes[i]));
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
                var inheritedSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(receiver?.Type, ImmutableArray.CreateRange(arguments.Select(a => a?.Type)));
                var inheritedSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(resolution.Best, typeArgSymbols, inheritedSymbolicArgs);
                var inheritedTypeArgSymbolsForCall = !inheritedSymbolicTypeArgs.IsDefault ? inheritedSymbolicTypeArgs : typeArgSymbols;
                var returnType = ResolveImportedGenericReturnType(resolution.Best, typeArgSymbols)
                    ?? MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(resolution.Best, inheritedSymbolicTypeArgs, receiver?.Type)
                    ?? ResolveInstanceReturnTypeFromReceiver(receiver?.Type, resolution.Best)
                    ?? TypeSymbol.FromClrType(resolution.Best.ReturnType);
                var inheritedParameters = resolution.Best.GetParameters();
                var inheritedMapping = resolution.ParameterMapping;
                var inheritedExpandedArgs = resolution.IsExpanded
                    ? overloads.ExpandParamsArguments(arguments, inheritedParameters, ce, parameterMapping: inheritedMapping)
                    : arguments;
                var inheritedDownstreamMapping = resolution.IsExpanded ? default : inheritedMapping;
                var inheritedHandlerArgs = ApplyInterpolatedStringHandlers(inheritedParameters, inheritedExpandedArgs, receiver, ce.Location, inheritedDownstreamMapping, out var inheritedHandlerPrelude, out var inheritedUpdatedReceiver);
                var inheritedDelegateArgs = RebindFunctionLiteralDelegateArguments(inheritedHandlerArgs, inheritedParameters, inheritedDownstreamMapping);
                var inheritedConvertedArgs = conversions.BindClrParameterConversions(inheritedDelegateArgs, inheritedParameters, ce, inheritedDownstreamMapping);
                var inheritedArguments = OverloadResolver.BuildOrderedCallArguments(inheritedConvertedArgs, inheritedDownstreamMapping, inheritedParameters);
                var refKinds = ComputeArgumentRefKinds(inheritedParameters);
                overloads.ValidateRefArguments(inheritedArguments, refKinds, methodName, ce.Location);
                BoundExpression inheritedCall = new BoundImportedInstanceCallExpression(null, inheritedUpdatedReceiver ?? receiver, resolution.Best, returnType, inheritedArguments, refKinds, inheritedTypeArgSymbolsForCall);
                result = WrapWithHandlerPrelude(inheritedCall, inheritedHandlerPrelude, ce);
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
        // ADR-0101 follow-up / issue #812: a named delegate may declare a
        // trailing variadic parameter. Apply the same arity + pack /
        // pass-through rule that we use for the direct-call (`del(args)`)
        // path so the explicit `.Invoke(args)` spelling behaves identically.
        var isVariadic = delegateSym.Parameters.Length > 0
            && delegateSym.Parameters[delegateSym.Parameters.Length - 1].IsVariadic;
        var fixedParamCount = isVariadic ? delegateSym.Parameters.Length - 1 : delegateSym.Parameters.Length;

        if (isVariadic)
        {
            if (arguments.Length < fixedParamCount)
            {
                Diagnostics.ReportTooFewArgumentsForVariadic(ce.Location, delegateSym.Name, fixedParamCount, arguments.Length);
                return new BoundErrorExpression(null);
            }
        }
        else if (arguments.Length != delegateSym.Parameters.Length)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, delegateSym.Name, delegateSym.Parameters.Length, arguments.Length);
            return new BoundErrorExpression(null);
        }

        var permutedArgs = arguments;
        if (isVariadic)
        {
            var variadicParam = delegateSym.Parameters[delegateSym.Parameters.Length - 1];
            var sliceType = (SliceTypeSymbol)variadicParam.Type;
            var trailingCount = arguments.Length - fixedParamCount;
            var passThrough = trailingCount == 1 && arguments[fixedParamCount].Type == sliceType;
            if (!passThrough)
            {
                var packed = ImmutableArray.CreateBuilder<BoundExpression>(trailingCount);
                for (var i = fixedParamCount; i < arguments.Length; i++)
                {
                    packed.Add(arguments[i]);
                }

                var rebuilt = ImmutableArray.CreateBuilder<BoundExpression>(fixedParamCount + 1);
                for (var i = 0; i < fixedParamCount; i++)
                {
                    rebuilt.Add(arguments[i]);
                }

                rebuilt.Add(new BoundArrayCreationExpression(ce, sliceType, packed.MoveToImmutable()));
                permutedArgs = rebuilt.ToImmutable();
            }
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(permutedArgs.Length);
        for (var i = 0; i < permutedArgs.Length; i++)
        {
            var argLoc = i < ce.Arguments.Count ? ce.Arguments[i].Location : ce.Location;
            convertedArgs.Add(conversions.BindConversion(argLoc, permutedArgs[i], delegateSym.Parameters[i].Type));
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
            // Issue #833: a slice/sequence of an open method type parameter
            // (e.g. `[]T{}.ToArray()` inside `func F[T]()`) has no CLR
            // backing on the receiver. Project it to an erased shape so
            // overload resolution can run; symbolic recovery happens via
            // BuildSymbolicMethodTypeArgs + ResolveCallReturnTypeFromSymbolicTypeArgs.
            if (receiver?.Type == null || !MemberLookup.TryProjectErasedClrType(receiver.Type, out receiverClrType))
            {
                return false;
            }
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
                // Issue #833: argument may carry an open TP (e.g. `T`,
                // `[]T`). Project to an erased shape so resolution can run.
                if (!MemberLookup.TryProjectErasedClrType(arguments[i].Type, out t))
                {
                    return false;
                }
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

        // Issue #833: for an extension call the symbolic-argument vector
        // includes the receiver as slot 0 to mirror the static-dispatch
        // shape (`Class.Method(this receiver, args…)`). The inferred
        // method-type-args may then surface a symbolic return like
        // `[]T` from `[]T{}.ToArray()` instead of the erased
        // `object[]`.
        var extensionSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(receiver?.Type, ImmutableArray.CreateRange(arguments.Select(a => a?.Type)));
        var extensionSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(best, typeArgSymbols, extensionSymbolicArgs);
        var extensionTypeArgSymbolsForCall = !extensionSymbolicTypeArgs.IsDefault ? extensionSymbolicTypeArgs : typeArgSymbols;
        var returnOverride = ResolveImportedGenericReturnType(best, typeArgSymbols)
            ?? MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(best, extensionSymbolicTypeArgs, receiver?.Type);
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
        result = new BoundImportedCallExpression(null, function, bound, refKinds, extensionTypeArgSymbolsForCall);
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

    /// <summary>
    /// ADR-0091 / issue #757: bind an explicit-base interface call
    /// <c>base[IFoo].M(args)</c>. Validates that:
    /// <list type="number">
    ///   <item>the enclosing function is an instance member of a class or struct,</item>
    ///   <item>the interface resolves and is in the enclosing type's interface set (GS0338),</item>
    ///   <item>the named member exists on the interface (GS0339),</item>
    ///   <item>the member has a default body (GS0340), and</item>
    ///   <item>the member is not a <c>private</c> helper (GS0341 — preserves ADR-0090).</item>
    /// </list>
    /// On success, returns a <see cref="BoundBaseInterfaceCallExpression"/>
    /// whose receiver is the enclosing method's <c>this</c> parameter.
    /// </summary>
    private BoundExpression BindBaseInterfaceCallExpression(BaseInterfaceCallExpressionSyntax syntax)
    {
        // Resolve the selector inside the brackets first. Issue #986: when it
        // names a base CLASS instead of an interface, route to the base-class
        // call form so `base[BaseClass].M(args)` works as an alternative
        // spelling of `base.M(args)` — binding arguments there (not here) so
        // they are not bound twice. Type-clause binding already reports the
        // relevant "type not found" diagnostic (GS0046) when resolution fails.
        var ifaceType = bindTypeClause(syntax.InterfaceTypeClause);
        if (ifaceType is null || ifaceType == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        if (ifaceType is StructSymbol classSelector && classSelector.IsClass)
        {
            var synthesizedCall = new CallExpressionSyntax(
                syntax.SyntaxTree,
                syntax.MethodIdentifier,
                syntax.MethodTypeArgumentList,
                syntax.OpenParenthesisToken,
                syntax.Arguments,
                syntax.CloseParenthesisToken);
            return BindBaseClassCall(
                synthesizedCall,
                syntax.BaseKeyword.Location,
                classSelector,
                syntax.InterfaceTypeClause.Location);
        }

        // Bind the user arguments unconditionally — even on the failure paths
        // below we want any nested binder diagnostics (unknown name in arg
        // position, etc.) to surface in the same pass.
        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
        for (var i = 0; i < syntax.Arguments.Count; i++)
        {
            boundArguments.Add(BindExpression(syntax.Arguments[i]));
        }

        // The selector must denote an interface.
        if (ifaceType is not InterfaceSymbol ifaceSym)
        {
            Diagnostics.ReportBaseInterfaceCallTypeDoesNotImplementInterface(
                syntax.InterfaceTypeClause.Location,
                EnclosingTypeDisplayName(),
                ifaceType.Name);
            return new BoundErrorExpression(null);
        }

        // The call site must live in an instance member of a class/struct
        // that implements `ifaceSym`. A top-level function, a `shared` static,
        // or a generic-typeparameter-receiver call all fail this test.
        var enclosingType = function?.ReceiverType as StructSymbol;
        if (enclosingType == null || function?.ThisParameter == null)
        {
            Diagnostics.ReportBaseInterfaceCallTypeDoesNotImplementInterface(
                syntax.BaseKeyword.Location,
                "<top-level>",
                ifaceSym.Name);
            return new BoundErrorExpression(null);
        }

        if (!EnclosingTypeImplements(enclosingType, ifaceSym))
        {
            Diagnostics.ReportBaseInterfaceCallTypeDoesNotImplementInterface(
                syntax.InterfaceTypeClause.Location,
                enclosingType.Name,
                ifaceSym.Name);
            return new BoundErrorExpression(null);
        }

        // Generic-method type arguments on the selector are reserved for a
        // future ADR-0091 follow-up — reject for now with the "member is
        // abstract"-shaped diagnostic name so users get a clear pointer.
        if (syntax.MethodTypeArgumentList != null)
        {
            Diagnostics.ReportBaseInterfaceCallMemberNotFound(
                syntax.MethodIdentifier.Location,
                ifaceSym.Name,
                syntax.MethodIdentifier.Text + "[…]");
            return new BoundErrorExpression(null);
        }

        var methodName = syntax.MethodIdentifier.Text;

        // Private helpers (ADR-0090) are intentionally invisible to
        // implementers; calling one through base[IFoo] would defeat that
        // encapsulation. Check first so the diagnostic distinguishes the
        // private case from a generic "no such member".
        var privateMatches = ifaceSym.GetPrivateMethods(methodName);
        if (privateMatches.Length > 0)
        {
            Diagnostics.ReportBaseInterfaceCallTargetsPrivateHelper(
                syntax.MethodIdentifier.Location,
                ifaceSym.Name,
                methodName);
            return new BoundErrorExpression(null);
        }

        // Look up the named method on the interface's public contract. Pick
        // the overload whose callable arity matches the call site; if no
        // overload matches at all, fall back to "member not found" — when
        // overload-by-arity finds a match but its body is abstract, fall to
        // GS0340 below. For a constructed generic interface, the method we
        // find is the substituted one; we map it back to its open definition
        // (preserved on InterfaceSymbol.Definition.Methods at the same
        // index) so the emitter and interpreter can resolve through the
        // single MethodHandles / program.Functions slot.
        FunctionSymbol arityMatch = null;
        FunctionSymbol anyMatch = null;
        int matchIndex = -1;
        var overloads = ifaceSym.Methods;
        for (var i = 0; i < overloads.Length; i++)
        {
            var candidate = overloads[i];
            if (candidate.Name != methodName)
            {
                continue;
            }

            anyMatch = candidate;
            var calleeOffset = candidate.ExplicitReceiverParameter == null ? 0 : 1;
            var callableParameterCount = candidate.Parameters.Length - calleeOffset;
            if (callableParameterCount == boundArguments.Count)
            {
                arityMatch = candidate;
                matchIndex = i;
                break;
            }
        }

        if (anyMatch == null)
        {
            Diagnostics.ReportBaseInterfaceCallMemberNotFound(
                syntax.MethodIdentifier.Location,
                ifaceSym.Name,
                methodName);
            return new BoundErrorExpression(null);
        }

        if (arityMatch == null)
        {
            // Member exists but no overload accepts this many arguments;
            // report a wrong-arg-count diagnostic against the first overload
            // for ergonomic recovery (the user will fix the arg count and
            // re-bind).
            var calleeOffset = anyMatch.ExplicitReceiverParameter == null ? 0 : 1;
            var callableParameterCount = anyMatch.Parameters.Length - calleeOffset;
            Diagnostics.ReportWrongArgumentCount(syntax.MethodIdentifier.Location, methodName, callableParameterCount, boundArguments.Count);
            return new BoundErrorExpression(null);
        }

        // Map the substituted method on a constructed generic interface back
        // to its open MethodDef slot (cache.MethodHandles is keyed on the
        // open definition). CreateConstructed preserves declaration order
        // 1:1, so the same index identifies the open slot.
        var openMethod = arityMatch;
        if (ifaceSym.Definition != null && !ReferenceEquals(ifaceSym.Definition, ifaceSym) && matchIndex >= 0 && matchIndex < ifaceSym.Definition.Methods.Length)
        {
            openMethod = ifaceSym.Definition.Methods[matchIndex];
        }

        if (!InterfaceSymbol.HasDefaultBody(openMethod))
        {
            Diagnostics.ReportBaseInterfaceCallMemberIsAbstract(
                syntax.MethodIdentifier.Location,
                ifaceSym.Name,
                methodName);
            return new BoundErrorExpression(null);
        }

        var receiver = new BoundVariableExpression(null, function.ThisParameter);
        return new BoundBaseInterfaceCallExpression(
            syntax,
            receiver,
            ifaceSym,
            openMethod,
            boundArguments.ToImmutable());
    }

    /// <summary>
    /// ADR-0091 / issue #757: returns true when <paramref name="enclosingType"/>
    /// (or any of its base classes) appears in <paramref name="ifaceSym"/>'s
    /// implementer set. Constructed generic interfaces compare by
    /// <see cref="InterfaceSymbol.Definition"/> identity to allow
    /// <c>base[IFoo[int]]</c> from a class declared as <c>: IFoo[int]</c>.
    /// </summary>
    private static bool EnclosingTypeImplements(StructSymbol enclosingType, InterfaceSymbol ifaceSym)
    {
        var ifaceDef = ifaceSym.Definition ?? ifaceSym;
        for (var t = enclosingType; t != null; t = t.BaseClass)
        {
            foreach (var iface in t.Interfaces)
            {
                var candidateDef = iface.Definition ?? iface;
                if (ReferenceEquals(candidateDef, ifaceDef))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// ADR-0091: produces a human-readable display name for the enclosing
    /// receiver type used in GS0338 messages. Falls back to a placeholder
    /// when the call site is not inside an instance member.
    /// </summary>
    private string EnclosingTypeDisplayName()
    {
        if (function?.ReceiverType is { } recv)
        {
            return recv.Name;
        }

        return "<top-level>";
    }

    /// <summary>
    /// Issue #986: binds a base-class call of the form <c>base.M(args)</c>
    /// (when <paramref name="explicitBaseType"/> is <see langword="null"/>) or
    /// the bracketed <c>base[BaseClass].M(args)</c> form (when it names the
    /// base class). Resolves <c>M</c> on the nearest base class's member set
    /// (walking grandparents), reuses the standard overload resolution and
    /// argument-conversion pipeline via
    /// <see cref="OverloadResolver.BindUserInstanceCall"/>, then wraps the
    /// result in a <see cref="BoundBaseClassCallExpression"/> so the emitter
    /// produces a non-virtual <c>call</c> (not <c>callvirt</c>) — exactly like
    /// C# <c>base.M(...)</c>.
    /// </summary>
    /// <param name="ce">The method-call syntax (<c>M(args)</c>).</param>
    /// <param name="baseLocation">The location of the <c>base</c> token for context diagnostics.</param>
    /// <param name="explicitBaseType">The class named in <c>base[BaseClass]</c>, or <see langword="null"/> for the plain <c>base.M</c> form.</param>
    /// <param name="selectorLocation">The location of the bracketed selector (for GS0385); ignored when <paramref name="explicitBaseType"/> is null.</param>
    /// <returns>The bound base-class call, or a bound error on failure.</returns>
    private BoundExpression BindBaseClassCall(
        CallExpressionSyntax ce,
        TextLocation baseLocation,
        StructSymbol explicitBaseType,
        TextLocation selectorLocation)
    {
        // The call site must live in an instance member of a class. Top-level
        // functions, `shared` statics, and structs (no base class) all fail.
        var enclosingType = function?.ReceiverType as StructSymbol;
        if (enclosingType == null || function?.ThisParameter == null || !enclosingType.IsClass)
        {
            Diagnostics.ReportBaseClassCallHasNoBaseClass(baseLocation, EnclosingTypeDisplayName());
            return new BoundErrorExpression(null);
        }

        // Determine the base class to start the method search from. For the
        // bracketed form, the named selector must be an actual base class of
        // the enclosing type; for the plain form, use the immediate base.
        StructSymbol searchBase;
        if (explicitBaseType != null)
        {
            if (!IsBaseClassOf(enclosingType, explicitBaseType))
            {
                Diagnostics.ReportBaseClassCallSelectorNotBaseClass(selectorLocation, enclosingType.Name, explicitBaseType.Name);
                return new BoundErrorExpression(null);
            }

            searchBase = explicitBaseType;
        }
        else
        {
            searchBase = enclosingType.BaseClass;
        }

        if (searchBase == null)
        {
            Diagnostics.ReportBaseClassCallHasNoBaseClass(baseLocation, enclosingType.Name);
            return new BoundErrorExpression(null);
        }

        var methodName = ce.Identifier.Text;

        // Resolve the overload set on the base chain (this-first from the
        // search base), which walks grandparents — so the nearest base
        // implementation of an inherited member is chosen.
        var baseOverloads = TypeMemberModel.GetMethods(searchBase, methodName, MemberQuery.Instance(MemberKinds.Method));
        if (baseOverloads.IsEmpty)
        {
            Diagnostics.ReportBaseClassCallMemberNotFound(ce.Identifier.Location, searchBase.Name, methodName);
            return new BoundErrorExpression(null);
        }

        if (!overloads.TryAnalyzeCallArgumentLayout(ce.Arguments, out _, out var argumentNames))
        {
            return new BoundErrorExpression(null);
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(ce.Arguments.Count);
        foreach (var argument in ce.Arguments)
        {
            boundArguments.Add(BindExpression(OverloadResolver.UnwrapNamedArgumentValue(argument)));
        }

        var arguments = boundArguments.ToImmutable();
        var method = overloads.SelectInstanceOverloadOrReport(baseOverloads, arguments, ce, methodName, argumentNames);
        if (method == null)
        {
            return new BoundErrorExpression(null);
        }

        // Reuse the full instance-call binding pipeline (named-argument
        // reordering, generic substitution, variadic packing, per-argument
        // conversions). The receiver is the enclosing method's `this`.
        var receiver = new BoundVariableExpression(null, function.ThisParameter);
        var bound = overloads.BindUserInstanceCall(receiver, method, arguments, ce, argumentNames);
        if (bound is not BoundUserInstanceCallExpression uic)
        {
            return bound;
        }

        var declaringType = uic.Method.ReceiverType as StructSymbol ?? searchBase;
        return new BoundBaseClassCallExpression(
            ce,
            uic.Receiver,
            declaringType,
            uic.Method,
            uic.Arguments,
            uic.Type);
    }

    /// <summary>
    /// Issue #986: returns true when <paramref name="candidate"/> is a base
    /// class of <paramref name="derived"/> (compared by definition identity to
    /// allow constructed generics).
    /// </summary>
    private static bool IsBaseClassOf(StructSymbol derived, StructSymbol candidate)
    {
        var candidateDef = candidate.Definition ?? candidate;
        for (var t = derived.BaseClass; t != null; t = t.BaseClass)
        {
            var tDef = t.Definition ?? t;
            if (ReferenceEquals(tDef, candidateDef) || ReferenceEquals(t, candidate))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #943: binds an instance call dispatched through a type parameter's
    /// imported CLR interface constraint (e.g. <c>a.CompareTo(b)</c> where
    /// <c>a : T</c> and <c>T : IComparable[T]</c>). The method is resolved
    /// against the constraint interface's (type-erased) CLR type; the resulting
    /// <see cref="BoundImportedInstanceCallExpression"/> carries the constrained
    /// type parameter and the symbolic interface type so the emitter produces a
    /// verifiable <c>constrained. !!T  callvirt</c> sequence with the
    /// <c>MemberRef</c> parented at the constructed interface
    /// (<c>IComparable`1&lt;!!T&gt;::CompareTo(!0)</c>).
    /// </summary>
    /// <param name="receiver">The bound receiver (its type is the constrained type parameter).</param>
    /// <param name="tp">The receiver's type parameter, carrying the CLR interface constraint.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The bound argument expressions.</param>
    /// <param name="ce">The originating call-expression syntax.</param>
    /// <param name="argumentNames">Optional named-argument labels in source order.</param>
    /// <param name="result">The bound constrained call on success.</param>
    /// <returns><see langword="true"/> when a matching interface method was found and bound.</returns>
    private bool TryBindConstrainedClrInterfaceCall(
        BoundExpression receiver,
        TypeParameterSymbol tp,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        out BoundExpression result)
    {
        result = null;
        var constraintInterface = tp.ClrInterfaceConstraint;
        var clrType = constraintInterface?.ClrType;
        if (clrType is not { IsInterface: true })
        {
            return false;
        }

        var candidates = ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(clrType, BindingFlags.Instance | BindingFlags.Public)
            .Where(m => m.Name == methodName)
            .ToList();
        if (candidates.Count == 0)
        {
            return false;
        }

        var argTypes = new Type[arguments.Length];
        for (var i = 0; i < arguments.Length; i++)
        {
            var t = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type);
            if (t == null && arguments[i].Type != TypeSymbol.Null)
            {
                return false;
            }

            argTypes[i] = t;
        }

        var resolution = OverloadResolution.Resolve(
            candidates,
            argTypes,
            null,
            scope.References.MapClrTypeToReferences,
            null,
            argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames);
        if (resolution.Outcome != OverloadResolution.ResolutionOutcome.Resolved)
        {
            return false;
        }

        var method = resolution.Best;
        var parameters = method.GetParameters();

        // Return type: a return that names the interface type-variable is
        // recovered by projecting through the constructed constraint interface;
        // a concrete return (e.g. IComparable.CompareTo -> int32) falls back to
        // the direct CLR mapping.
        var returnType = ResolveInstanceReturnTypeFromReceiver(constraintInterface, method)
            ?? MapClrMemberType(method.ReturnType);

        // Order positionally for named arguments; deliberately skip the CLR
        // boxing/conversion pass — the emitted MemberRef parameter is the
        // interface type-variable `!0` (== the reified `!!T`), so a `T`-typed
        // argument must be passed unboxed.
        var orderedArgs = OverloadResolver.BuildOrderedCallArguments(arguments, resolution.ParameterMapping, parameters);
        var refKinds = ComputeArgumentRefKinds(parameters);

        result = new BoundImportedInstanceCallExpression(
            ce,
            receiver,
            method,
            returnType,
            orderedArgs,
            refKinds,
            default,
            constrainedReceiverTypeParameter: tp,
            constrainedInterfaceType: constraintInterface);
        return true;
    }
}
