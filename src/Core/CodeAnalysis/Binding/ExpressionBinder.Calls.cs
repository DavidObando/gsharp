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

        // Issue #2228: G# unifies `class` and `struct` into one StructSymbol
        // (IsClass distinguishes reference vs. value semantics), so this check
        // already accepts a `data class` receiver (IsClass && IsData) exactly
        // like a `data struct` receiver — no separate ClassSymbol branch is
        // needed. The clone below (BoundStructLiteralExpression) already
        // special-cases IsClass at emit time (MethodBodyEmitter.EmitStructLiteral):
        // `newobj` + per-field/property set for a class, vs. an inline value copy
        // for a struct — so reference semantics (new heap instance, original left
        // unchanged, aliasing/identity preserved for untouched members) fall out
        // for free once cs2gs actually emits a `data class` instead of downgrading
        // to a plain `class` (the cs2gs-side half of #2228).
        var normalizedReceiverType = ImportedTypeSymbol.NormalizeSemanticAggregate(
            receiver.Type,
            receiver.Type.ClrType,
            scope.References);
        var structType = normalizedReceiverType switch
        {
            StructSymbol aggregate => aggregate,
            NullabilityAnnotatedTypeSymbol { BaseType: StructSymbol aggregate } => aggregate,
            _ => null,
        };
        if (structType == null || !structType.IsData)
        {
            Diagnostics.ReportCopyOrWithNotDataStruct(diagnosticLocation, receiver.Type);
            return new BoundErrorExpression(null);
        }

        if (!ReferenceEquals(receiver.Type, structType))
        {
            receiver = new BoundConversionExpression(null, structType, receiver);
        }

        var tempName = "$copy" + System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, structType);
        scope.TryDeclareVariable(tempVar);

        var seen = new HashSet<string>();
        var explicitValues = new Dictionary<string, (FieldSymbol Field, PropertySymbol Property, BoundExpression Value)>();
        foreach (var initSyntax in overrides)
        {
            var memberName = initSyntax.FieldIdentifier.Text;
            if (!seen.Add(memberName))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(initSyntax.FieldIdentifier.Location, memberName);
                continue;
            }

            if (TypeMemberModel.TryGetFieldIncludingInherited(structType, memberName, MemberQuery.Instance(MemberKinds.Field), out var field, out var fieldDeclaringType))
            {
                // Issue #2059: a `with` update is a write to the named field —
                // enforce the same `protected`/`private` accessibility rule as a
                // plain assignment / composite literal member init (issue #950 /
                // #2044 / #2059).
                if (!AccessibilityChecker.IsAccessible(field.Accessibility, fieldDeclaringType, this.function))
                {
                    Diagnostics.ReportMemberInaccessible(initSyntax.FieldIdentifier.Location, field.Name, fieldDeclaringType.Name, field.Accessibility);
                }

                var fieldValueExpr = BindExpression(initSyntax.Value);
                fieldValueExpr = conversions.BindConversion(initSyntax.Value.Location, fieldValueExpr, field.Type);
                explicitValues[memberName] = (field, null, fieldValueExpr);
                continue;
            }

            // Issue #2291: an imported C# record surfaces its positional
            // members as auto-properties (compiler-mangled backing fields),
            // not plain public fields like a gsc-native data class — fall
            // back to a settable property with the same name so `with`
            // updates a record's positional member through its setter/init
            // accessor instead of failing to find a field at all.
            if (TypeMemberModel.TryGetProperty(structType, memberName, out var property, out var propertyDeclaringType) && property.HasSetter)
            {
                if (!AccessibilityChecker.IsAccessible(property.Accessibility, propertyDeclaringType, this.function))
                {
                    Diagnostics.ReportMemberInaccessible(initSyntax.FieldIdentifier.Location, property.Name, propertyDeclaringType.Name, property.Accessibility);
                }

                var propertyValueExpr = BindExpression(initSyntax.Value);
                propertyValueExpr = conversions.BindConversion(initSyntax.Value.Location, propertyValueExpr, property.Type);
                explicitValues[memberName] = (null, property, propertyValueExpr);
                continue;
            }

            Diagnostics.ReportUnableToFindMember(initSyntax.FieldIdentifier.Location, memberName);
        }

        var initializers = ImmutableArray.CreateBuilder<BoundFieldInitializer>();
        var handledMembers = new HashSet<string>();
        foreach (var field in structType.Fields)
        {
            handledMembers.Add(field.Name);
            if (explicitValues.TryGetValue(field.Name, out var explicitValue))
            {
                initializers.Add(new BoundFieldInitializer(field, explicitValue.Value));
            }
            else
            {
                var access = new BoundFieldAccessExpression(null, new BoundVariableExpression(null, tempVar), structType, field);
                initializers.Add(new BoundFieldInitializer(field, access));
            }
        }

        // Imported records may be positional or property-only. Copy every
        // writable property that is not already represented by a visible field.
        foreach (var property in structType.Properties)
        {
            if (!property.HasSetter || !handledMembers.Add(property.Name))
            {
                continue;
            }

            if (explicitValues.TryGetValue(property.Name, out var explicitValue))
            {
                initializers.Add(new BoundFieldInitializer(property, explicitValue.Value));
            }
            else
            {
                var access = new BoundPropertyAccessExpression(null, new BoundVariableExpression(null, tempVar), structType, property);
                initializers.Add(new BoundFieldInitializer(property, access));
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

            // Issue #1858: a braced member value `Prop = { a, b }` populates a
            // (typically get-only) collection member via `.Add(...)` calls —
            // the same target-less collection-initializer form already
            // supported by the struct/imported-class composite literals
            // (issue #1567). Handling it here lets a collection member
            // combine with constructor arguments in the initializer-suffix
            // form (gsc issue #522), which neither of those literals covers.
            if (initSyntax.Value is CollectionInitializerExpressionSyntax { Target: null } bracedInit)
            {
                var bracedReceiver = new BoundVariableExpression(initSyntax, tempVar);
                if (TryEmitMemberCollectionInitializer(bracedReceiver, propertyName, initSyntax.PropertyIdentifier, bracedInit, statements))
                {
                    continue;
                }

                // Not a collection member (or not found) — fall through to the
                // normal assignment path below, whose own lookup reports the
                // appropriate diagnostic (unfound member, unassignable, or the
                // defensive not-collection-initializable report when
                // BindExpression is reached on the braced value).
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
        // Issue #1567: a target-less collection initializer only appears as a
        // composite/object-initializer member value (`T{ Prop: { a, b } }`) and
        // is consumed directly by the composite-literal binder — it never
        // reaches general expression binding. Guard defensively.
        if (syntax.Target == null)
        {
            Diagnostics.ReportTypeNotCollectionInitializable(syntax.OpenBraceToken.Location, TypeSymbol.Error);
            BindCollectionElementsForDiagnostics(syntax);
            return new BoundErrorExpression(null);
        }

        var target = BindExpression(syntax.Target);
        if (target.Type == TypeSymbol.Error || target.Type == null)
        {
            BindCollectionElementsForDiagnostics(syntax);
            return new BoundErrorExpression(null);
        }

        var resultType = target.Type;
        var clrType = resultType.ClrType;
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
        EmitCollectionElementAddStatements(tempVar, syntax.Elements, statements);

        var resultExpr = new BoundVariableExpression(syntax, tempVar);
        return new BoundBlockExpression(syntax, statements.ToImmutable(), resultExpr);
    }

    /// <summary>
    /// Issue #479 / ADR-0117 (and #1567): lowers each collection element into an
    /// <c>Add(...)</c> call (bare / <c>key: value</c> entries) or an indexer set
    /// (<c>[key] = value</c> entries) against the collection held by
    /// <paramref name="collectionLocal"/>, appending one statement per element.
    /// Shared by the standalone collection initializer and the member
    /// collection initializer that populates a get-only collection property.
    /// </summary>
    private void EmitCollectionElementAddStatements(
        LocalVariableSymbol collectionLocal,
        SeparatedSyntaxList<CollectionElementSyntax> elements,
        ImmutableArray<BoundStatement>.Builder statements)
    {
        foreach (var element in elements)
        {
            BoundExpression bound;
            switch (element)
            {
                case ExpressionCollectionElementSyntax bare:
                    bound = BindCollectionAddCall(collectionLocal, element, ImmutableArray.Create(bare.Expression));
                    break;
                case KeyedCollectionElementSyntax keyed:
                    bound = BindCollectionAddCall(collectionLocal, element, ImmutableArray.Create(keyed.Key, keyed.Value));
                    break;
                case IndexedCollectionElementSyntax indexed:
                    bound = BindIndexedAssignmentToVariable(collectionLocal, indexed.Key, indexed.Value, indexed.EqualsToken.Location);
                    break;
                default:
                    bound = new BoundErrorExpression(null);
                    break;
            }

            statements.Add(new BoundExpressionStatement(element, bound));
        }
    }

    /// <summary>
    /// Issue #1567: lowers a <em>member</em> collection initializer
    /// (<c>Member: { a, b }</c> / <c>Member = { a, b }</c>) that populates a
    /// get-only (or settable) collection property of a just-constructed
    /// <paramref name="receiver"/>. Reads <c>receiver.Member</c> — a get-only
    /// property is readable even though it cannot be assigned — into a synthetic
    /// local and reuses the standalone collection-initializer element lowering to
    /// emit an <c>Add(...)</c> call / indexer set per element. Because the
    /// collection is a reference type the local aliases the property's collection
    /// in place, mirroring the C# <c>receiver.Member.Add(x)</c> lowering.
    /// Returns <see langword="false"/> when the member is not a collection (its
    /// type exposes no accessible <c>Add</c> for non-indexed elements), so the
    /// caller falls back to its normal assignment / GS0127 handling.
    /// </summary>
    private bool TryEmitMemberCollectionInitializer(
        BoundExpression receiver,
        string memberName,
        SyntaxNode anchor,
        CollectionInitializerExpressionSyntax braced,
        ImmutableArray<BoundStatement>.Builder statements)
    {
        var tree = anchor.SyntaxTree;
        var position = anchor.Span.Start;
        var nameToken = new SyntaxToken(tree, SyntaxKind.IdentifierToken, position, memberName, null);
        var nameSyntax = new NameExpressionSyntax(tree, nameToken);
        var propRead = BindAccessorStep(receiver, classSymbol: null, nameSyntax);
        if (propRead is BoundErrorExpression || propRead.Type == null || propRead.Type == TypeSymbol.Error)
        {
            return false;
        }

        var clrType = propRead.Type.ClrType;
        var hasNonIndexedElement = braced.Elements.Any(e => e is not IndexedCollectionElementSyntax);
        var hasAdd = clrType != null && MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(clrType, "Add").Count > 0;
        if (clrType == null || (hasNonIndexedElement && !hasAdd))
        {
            return false;
        }

        var tempName = "$collinit" + System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var memberLocal = new LocalVariableSymbol(tempName, isReadOnly: true, propRead.Type);
        scope.TryDeclareVariable(memberLocal);
        statements.Add(new BoundVariableDeclaration(braced, memberLocal, propRead));
        EmitCollectionElementAddStatements(memberLocal, braced.Elements, statements);
        return true;
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
            if (scope.TryLookupTypeAlias(name, preferredArity: 0, out var typeAlias)
                && typeAlias is ImportedTypeSymbol { ClrType: not null } importedAlias)
            {
                clrType = importedAlias.ClrType;
            }
            else if (scope.TryLookupImport(name, out var aliasImport)
                && aliasImport.IsAlias
                && scope.References.TryResolveType(aliasImport.Target, out var aliasedType))
            {
                clrType = aliasedType;
            }
            else if (scope.TryLookupImportedClass(name, declaration: null, out var importedClass))
            {
                clrType = importedClass.ClassType;
            }
            else
            {
                return false;
            }

            if (clrType.IsGenericTypeDefinition)
            {
                // User wrote `List(...)` without `[T]`; can't construct an open generic.
                return false;
            }
        }

        // Issue #2263: for an imported `data class` the CLR type carries a real
        // primary `.ctor`, so TryBindClrConstructorFromType below would succeed
        // and yield a plain ImportedTypeSymbol result — a DUAL identity, since
        // the type-clause / member-access / return paths already resolve the
        // same type to its semantic-aggregate StructSymbol. That inconsistency
        // is exactly what makes `with`/copy on a locally-constructed data class
        // fail non-deterministically. Bind construction through the semantic
        // aggregate FIRST (it lowers to the same struct-literal node as `with`)
        // so a data class resolves to the SAME StructSymbol everywhere.
        // Issue #2291: a `data struct` (including an imported C# `record
        // struct`) has the identical dual-identity problem — its CLR type
        // also carries a real primary `.ctor`, so without this same
        // aggregate-first check for value types, TryBindClrConstructorFromType
        // below binds `Point(1, 2)` to a plain (non-aggregate) ImportedTypeSymbol,
        // and the resulting receiver never satisfies `structType.IsData` for
        // `with`/copy. Generalize the check to both kinds (drop the
        // `IsClass`-only restriction) so a data class AND a data struct both
        // resolve construction through the one semantic aggregate.
        if (openGenericDefinition == null
            && ImportedTypeSymbol.TryCreateSemanticAggregate(clrType, scope.References, out var dataClassAggregate)
            && dataClassAggregate.IsData
            && dataClassAggregate.HasPrimaryConstructor)
        {
            // Issue #2550: gsc data classes also expose a parameterless CLR
            // constructor as an implementation detail. Bind their source-level
            // construction through the imported primary-constructor metadata
            // so `Settings()` supplies declared defaults instead of selecting
            // that zero-initializing constructor. C# records have no gsc marker
            // and keep using CLR overload resolution (#2291/#2458).
            if (ImportedAssemblySemantics.TryGetTypeSemantics(clrType, out _))
            {
                result = overloads.BindConstructorCallExpression(syntax, dataClassAggregate);
                return true;
            }

            var bound = TryBindClrConstructorFromType(
                clrType,
                syntax,
                out result,
                out var noApplicableOverload,
                resultTypeOverride: dataClassAggregate);
            return bound || FinishClrConstructorBindingFailure(
                syntax, name, noApplicableOverload, ref result);
        }

        if (TryBindClrConstructorFromType(
                clrType,
                syntax,
                out result,
                out var clrNoApplicableOverload,
                openGenericDefinition,
                symbolicTypeArgs))
        {
            return true;
        }

        if (openGenericDefinition == null
            && ImportedTypeSymbol.TryCreateSemanticAggregate(clrType, scope.References, out var aggregate)
            && aggregate.HasPrimaryConstructor)
        {
            result = overloads.BindConstructorCallExpression(syntax, aggregate);
            return true;
        }

        return FinishClrConstructorBindingFailure(
            syntax, name, clrNoApplicableOverload, ref result);
    }

    private bool FinishClrConstructorBindingFailure(
        CallExpressionSyntax syntax,
        string typeName,
        bool noApplicableOverload,
        ref BoundExpression result)
    {
        if (syntax.TypeArgumentList == null)
        {
            result = null;
            return false;
        }

        if (result != null)
        {
            return true;
        }

        if (!noApplicableOverload)
        {
            return false;
        }

        Diagnostics.ReportNoApplicableOverload(syntax.Identifier.Location, typeName);
        result = new BoundErrorExpression(syntax);
        return true;
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
    /// <param name="hasSymbolicArg">On success, whether any argument carries information its CLR type cannot represent.</param>
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

            // Issue #2664: preserve every symbolic argument shape that its CLR
            // type cannot represent, including nullable references. Indexer and
            // Add binding can then recover `T?` instead of target-typing `nil`
            // against the erased non-null `T`.
            if (TypeSymbol.RequiresSymbolicProjection(ta))
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
    /// <param name="noApplicableOverload">
    /// Whether the type and its constructors resolved but none accepted the
    /// supplied arguments. The caller reports this only after semantic-
    /// aggregate constructor fallback has also failed.
    /// </param>
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
    /// <param name="resultTypeOverride">
    /// Semantic result type to expose instead of a plain imported CLR type.
    /// Used for imported data aggregates so constructor binding still flows
    /// through shared CLR overload resolution without reintroducing dual type
    /// identity.
    /// </param>
    /// <returns>Whether a constructor was resolved and bound.</returns>
    private bool TryBindClrConstructorFromType(
        System.Type clrType,
        CallExpressionSyntax syntax,
        out BoundExpression result,
        out bool noApplicableOverload,
        System.Type openGenericDefinition = null,
        ImmutableArray<TypeSymbol> symbolicTypeArgs = default,
        TypeSymbol resultTypeOverride = null)
    {
        result = null;
        noApplicableOverload = false;

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
        var symbolicCtorDelegateArgs = new HashSet<int>();
        for (var i = 0; i < syntax.Arguments.Count; i++)
        {
            var argName = argumentNames.IsDefault ? null : argumentNames[i];

            // Issue #1502: when the constructed type carries a same-compilation
            // user-defined type argument (e.g. `Lazy[Foo]`), the closed CLR ctor
            // parameter shape is type-erased (`Func<object>`), so target-typing a
            // lambda against it would infer `() -> object` and emit a synthesized
            // method returning `object` boxed — yielding an unverifiable
            // `Func<object>` where the reified `Lazy<Foo>::.ctor` expects
            // `Func<Foo>`. Recover the symbolic delegate shape (`() -> Foo`) from
            // the OPEN ctor's parameter type substituted with the real symbolic
            // type arguments so the lambda method returns `Foo` and the delegate
            // materialises as `Func<Foo>`.
            var inner = OverloadResolver.UnwrapNamedArgumentValue(syntax.Arguments[i]);
            if (inner is LambdaExpressionSyntax ctorLambdaSyntax
                && TryResolveSymbolicDelegateTargetForCtor(
                    openGenericDefinition, symbolicTypeArgs, sourceArgIndex: i, argName: argName, out var symbolicTarget))
            {
                boundArguments.Add(lambdas.BindLambdaExpression(ctorLambdaSyntax, symbolicTarget));
                symbolicCtorDelegateArgs.Add(i);
                continue;
            }

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
            // Issue #1502 follow-up: only for a lambda that target-typed a
            // constructed-generic ctor's delegate parameter, erase an inner
            // same-compilation enum to `object` (covariant ride-through) so the
            // lambda's `Func<…>` matches the erased `Lazy<object>` ctor's
            // `Func<object>` parameter. Other delegate args (and generic-method
            // inference elsewhere) keep the default enum→int ride-through.
            System.Type t;
            var priorErase = eraseDelegateInnerEnumToObject;
            eraseDelegateInnerEnumToObject = symbolicCtorDelegateArgs.Contains(i);
            try
            {
                t = GetEffectiveArgumentClrTypeForOverloadResolution(boundArguments[i].Type);
            }
            finally
            {
                eraseDelegateInnerEnumToObject = priorErase;
            }

            if (t == null && boundArguments[i].Type != TypeSymbol.Null)
            {
                // Issue #2347: an unresolved method group (e.g. a bare BCL
                // static method passed where a delegate-typed constructor
                // parameter is expected) carries no CLR type yet — its shape
                // depends on the constructor overload eventually chosen.
                // Defer it exactly like an untyped lambda (leave the argTypes
                // slot null so generic inference/applicability fall back to
                // the other arguments) instead of aborting resolution
                // outright; it is resolved against the winning constructor's
                // parameter type afterwards by BindClrParameterConversions.
                if (!OverloadResolution.IsUnresolvedMethodGroupArgument(boundArguments[i]))
                {
                    argsAllTyped = false;
                    break;
                }
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
            // Issue #658 / #1634: when any argument is a user-defined G# class,
            // pass a supplementary interface check into Resolve so
            // ClassifyImplicit recognises the user-class → CLR-interface
            // implicit reference conversion. Threaded as a call-local
            // parameter (not a shared static) so concurrent/nested binds never
            // observe another call's closure.
            Func<Type, Type, bool> supplementaryInterfaceCheck = hasUserClassArg
                ? (source, target) => IsUserClassAssignableToInterface(boundArguments, argTypes, source, target)
                : null;

            var resolution = OverloadResolution.Resolve(
                ctors,
                argTypes,
                interpolatedStringArgs: ComputeInterpolatedStringArgFlags(syntax.Arguments, boundArguments.Count),
                argumentNames: argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames,
                supplementaryInterfaceCheck: supplementaryInterfaceCheck,
                constantNarrowingArgumentCheck: MakeConstantNarrowingArgumentCheck(boundArguments),
                structuralProjectionArgumentCheck: MakeStructuralProjectionArgumentCheck(boundArguments));
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

        if (bestCtor == null)
        {
            if (boundArguments.Any(static argument => argument.Type == TypeSymbol.Error))
            {
                result = new BoundErrorExpression(syntax);
                return false;
            }

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

            noApplicableOverload = true;
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

        // Issue #1638: route through the shared CLR call-argument-construction
        // pipeline (interpolation rebind → handler args → delegate rebind →
        // parameter conversions) so a Func/Action-literal argument to a CLR
        // ctor is void-ized/adapted the same way an instance/static call's
        // argument is, instead of skipping straight to boxing conversions.
        var ctorConvertedArgs = BuildResolvedClrCallArguments(
            ctorExpandedArgs,
            syntax.Arguments,
            ctorParameters,
            ctorDownstreamMapping,
            receiver: null,
            syntax.Location,
            syntax,
            ClrCallDelegateRebindMode.Full,
            out var ctorHandlerPrelude,
            out _);
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
        if (resultTypeOverride != null)
        {
            resultType = resultTypeOverride;
        }
        else if (openGenericDefinition != null && !symbolicTypeArgs.IsDefaultOrEmpty)
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
        => TryResolveDelegateTargetFromCandidates(candidateParameterLists, paramOffset, sourceArgIndex, argName, out target, out _);

    /// <summary>
    /// Issue #2345: overload of <see cref="TryResolveDelegateTargetFromCandidates(IReadOnlyList{ParameterInfo[]}, int, int, string, out FunctionTypeSymbol)"/>
    /// that also reports whether resolution failed specifically because every
    /// matching candidate parameter at this slot is an <em>open</em> generic
    /// delegate (<c>ParameterType.ContainsGenericParameters</c>) — e.g. an
    /// imported generic method's <c>Action&lt;Builder&lt;TColumns&gt;&gt;</c>
    /// parameter whose <c>TColumns</c> is only closed once the method's type
    /// arguments are inferred from the call's other arguments. Callers use
    /// this signal to defer such a lambda (mirroring the existing untyped-
    /// arrow-lambda deferral) instead of binding it immediately with no
    /// target, which is what previously produced a wrong (non-void) inferred
    /// delegate shape for a block-bodied lambda whose trailing statement calls
    /// a fluent/self-returning method.
    /// </summary>
    private static bool TryResolveDelegateTargetFromCandidates(
        IReadOnlyList<ParameterInfo[]> candidateParameterLists,
        int paramOffset,
        int sourceArgIndex,
        string argName,
        out FunctionTypeSymbol target,
        out bool blockedByOpenGenericParameter)
    {
        target = null;
        blockedByOpenGenericParameter = false;
        var sawAnyMatchingSlot = false;
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
            if (parameterType == null)
            {
                continue;
            }

            sawAnyMatchingSlot = true;
            if (parameterType.ContainsGenericParameters)
            {
                // Open generic delegate parameters are resolved later, once the
                // generic method's type arguments have been inferred.
                blockedByOpenGenericParameter = true;
                continue;
            }

            if (!MemberLookup.TryGetLambdaTargetFunctionType(parameterType, out var candidate) || candidate == null)
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
                blockedByOpenGenericParameter = false;
                return false;
            }
        }

        // Only report the "blocked" signal when every matching slot was open —
        // if some candidate produced a usable closed target, that target wins
        // and there is nothing left to defer.
        blockedByOpenGenericParameter = blockedByOpenGenericParameter && target == null && sawAnyMatchingSlot;

        return target != null;
    }

    /// <summary>
    /// Issue #1502: resolves the symbolic delegate target shape for a lambda
    /// argument at <paramref name="sourceArgIndex"/> (or named
    /// <paramref name="argName"/>) of a constructed-generic CLR constructor whose
    /// type arguments include a same-compilation user-defined type. The closed
    /// CLR ctor parameter is type-erased (e.g. <c>Func&lt;object&gt;</c>); this
    /// recovers the real shape (e.g. <c>() -&gt; Foo</c>) by substituting the
    /// receiver's symbolic type arguments through the OPEN constructor's
    /// parameter type. Returns <see langword="false"/> (deferring to the ordinary
    /// erased path) when there is no symbolic substitution in effect, when the
    /// candidate ctors disagree on the delegate shape, or when no open ctor
    /// exposes a delegate parameter at that position.
    /// </summary>
    private static bool TryResolveSymbolicDelegateTargetForCtor(
        Type openGenericDefinition,
        ImmutableArray<TypeSymbol> symbolicTypeArgs,
        int sourceArgIndex,
        string argName,
        out FunctionTypeSymbol target)
    {
        target = null;
        if (openGenericDefinition == null || symbolicTypeArgs.IsDefaultOrEmpty)
        {
            return false;
        }

        ConstructorInfo[] openCtors;
        try
        {
            openCtors = openGenericDefinition.GetConstructors(BindingFlags.Public | BindingFlags.Instance);
        }
        catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
        {
            return false;
        }

        foreach (var ctor in openCtors)
        {
            var parameters = ctor.GetParameters();
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
                paramIndex = sourceArgIndex;
                if (paramIndex < 0 || paramIndex >= parameters.Length)
                {
                    continue;
                }
            }

            if (!TryBuildSymbolicDelegateTarget(parameters[paramIndex].ParameterType, openGenericDefinition, symbolicTypeArgs, out var candidate)
                || candidate == null)
            {
                continue;
            }

            if (target == null)
            {
                target = candidate;
            }
            else if (!ReferenceEquals(target, candidate) && !target.Equals(candidate))
            {
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

        var bound = TryBindClrConstructorFromType(
            nestedType,
            syntax,
            out result,
            out var noApplicableOverload);
        return bound || FinishClrConstructorBindingFailure(
            syntax, nestedType.Name, noApplicableOverload, ref result);
    }
}
