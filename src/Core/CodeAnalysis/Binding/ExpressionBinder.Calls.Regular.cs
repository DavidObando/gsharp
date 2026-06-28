// <copyright file="ExpressionBinder.Calls.Regular.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
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
    /// Issue #1320: a <c>sequence[T]</c> / <c>asyncsequence[T]</c> (iterator
    /// return types, aliases for <c>IEnumerable&lt;T&gt;</c> /
    /// <c>IAsyncEnumerable&lt;T&gt;</c>) or a user-element array receiver over a
    /// same-compilation user element type has a <see langword="null"/>
    /// <see cref="TypeSymbol.ClrType"/> during binding (the element type is not
    /// yet emitted). That null ClrType caused instance-method lookup
    /// (e.g. <c>GetEnumerator</c>) to dead-end with GS0159, even though the same
    /// call resolves on an explicitly-typed <c>IEnumerable[T]</c> parameter
    /// (whose ClrType type-erases to <c>IEnumerable&lt;object&gt;</c>) and on a
    /// primitive-element <c>sequence[int32]</c> / array. Normalize such a
    /// receiver to the equivalent type-erased shape so the shared CLR
    /// member-lookup + symbolic return-type recovery path resolves it uniformly:
    /// <list type="bullet">
    /// <item><c>sequence[T]</c> → a constructed <see cref="ImportedTypeSymbol"/>
    /// over <c>IEnumerable&lt;&gt;</c> with the symbolic <c>[T]</c> argument
    /// (so the generic <c>GetEnumerator() → IEnumerator[T]</c> overload and its
    /// element-typed return are recovered, exactly as for an
    /// <c>IEnumerable[T]</c> parameter).</item>
    /// <item><c>asyncsequence[T]</c> → the <c>IAsyncEnumerable&lt;&gt;</c>
    /// counterpart.</item>
    /// <item>user-element array / slice → a plain
    /// <see cref="ImportedTypeSymbol"/> over the erased array CLR type
    /// (e.g. <c>object[]</c>), reaching parity with a primitive-element array
    /// (which finds the non-generic <c>GetEnumerator()</c>).</item>
    /// </list>
    /// The bound call keeps the original receiver expression; the emitter
    /// already normalizes sequence/array receivers
    /// (<c>TryNormalizeToSymbolicContainer</c>), so emission is unaffected.
    /// Returns <see langword="false"/> when no normalization applies.
    /// </summary>
    /// <param name="receiverType">The receiver's static type symbol.</param>
    /// <param name="normalized">The normalized receiver type, on success.</param>
    /// <returns><see langword="true"/> when a normalized receiver type was produced.</returns>
    private static bool TryNormalizeSymbolicEnumerableReceiver(TypeSymbol receiverType, out TypeSymbol normalized)
    {
        normalized = null;
        if (receiverType == null || receiverType.ClrType != null)
        {
            return false;
        }

        switch (receiverType)
        {
            case SequenceTypeSymbol seq:
                normalized = ImportedTypeSymbol.GetConstructed(
                    typeof(System.Collections.Generic.IEnumerable<object>),
                    typeof(System.Collections.Generic.IEnumerable<>),
                    ImmutableArray.Create(seq.ElementType));
                return true;
            case AsyncSequenceTypeSymbol aseq:
                normalized = ImportedTypeSymbol.GetConstructed(
                    typeof(System.Collections.Generic.IAsyncEnumerable<object>),
                    typeof(System.Collections.Generic.IAsyncEnumerable<>),
                    ImmutableArray.Create(aseq.ElementType));
                return true;
            case ArrayTypeSymbol or SliceTypeSymbol:
                if (MemberLookup.TryProjectErasedClrType(receiverType, out var erasedArray))
                {
                    normalized = ImportedTypeSymbol.Get(erasedArray);
                    return true;
                }

                return false;
            default:
                return false;
        }
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
    /// Issue #1107: the by-ref-parameter counterpart of
    /// <see cref="ResolveInstanceReturnTypeFromReceiver"/>. When a call is
    /// dispatched against a receiver whose <see cref="ImportedTypeSymbol"/>
    /// carries symbolic type arguments (e.g. <c>Dictionary[K, V]</c>),
    /// substitute the open declaring type's parameter pointee type using the
    /// receiver's symbolic arguments. Without this an inline <c>out var</c>
    /// argument against a generic by-ref parameter (e.g. the <c>out TValue</c>
    /// of <c>Dictionary&lt;K, V&gt;.TryGetValue</c>) would bind from the
    /// type-erased closed shape (<c>out object</c>), losing the symbolic
    /// projection (the same-compilation user element type) and reporting
    /// <c>GS0158</c> on a subsequent member access of the out-var local.
    /// Returns <see langword="null"/> when no override is needed so callers keep
    /// their existing pointee derivation.
    /// </summary>
    /// <param name="receiverType">The receiver's static type symbol.</param>
    /// <param name="closedMethod">The closed method selected by overload resolution.</param>
    /// <param name="paramIndex">The zero-based parameter position to recover.</param>
    /// <returns>The override pointee type symbol, or <see langword="null"/>.</returns>
    private static TypeSymbol ResolveInstanceParameterPointeeTypeFromReceiver(
        TypeSymbol receiverType,
        System.Reflection.MethodInfo closedMethod,
        int paramIndex)
    {
        if (receiverType is not ImportedTypeSymbol imp
            || imp.OpenDefinition == null
            || imp.TypeArguments.IsDefaultOrEmpty
            || closedMethod == null
            || paramIndex < 0)
        {
            return null;
        }

        var openMethod = TryGetOpenInstanceMethod(imp.OpenDefinition, closedMethod);
        if (openMethod == null)
        {
            return null;
        }

        var openParameters = openMethod.GetParameters();
        if (paramIndex >= openParameters.Length)
        {
            return null;
        }

        var openParamType = openParameters[paramIndex].ParameterType;
        var openPointee = openParamType.IsByRef ? openParamType.GetElementType() : openParamType;
        if (openPointee == null)
        {
            return null;
        }

        var mapped = MemberLookup.MapOpenClrTypeToSymbolic(openPointee, imp.OpenDefinition, imp.TypeArguments);
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
}
