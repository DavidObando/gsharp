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
        if (!(receiver.Type is StructSymbol structType) || !structType.IsData)
        {
            Diagnostics.ReportCopyOrWithNotDataStruct(diagnosticLocation, receiver.Type);
            return new BoundErrorExpression(null);
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

        // Issue #2291: an imported C# record's positional members that are
        // NOT backed by a visible field (property-only, e.g. auto-properties
        // whose mangled backing field is intentionally hidden from the
        // aggregate's field list) still need to participate in `with`/`copy`.
        // `PrimaryConstructorParameters` names the record's full positional
        // shape regardless of whether each member resolved to a field or a
        // property (see ImportedTypeSymbol.BuildPrimaryConstructorParameters),
        // so walking it here — skipping names already handled as a real
        // field above — surfaces exactly the property-only positional
        // members, for every kind of data class (gsc-native or imported).
        if (!structType.PrimaryConstructorParameters.IsDefaultOrEmpty)
        {
            foreach (var parameter in structType.PrimaryConstructorParameters)
            {
                if (!handledMembers.Add(parameter.Name))
                {
                    continue;
                }

                if (!TypeMemberModel.TryGetProperty(structType, parameter.Name, out var property, out _) || !property.HasSetter)
                {
                    continue;
                }

                if (explicitValues.TryGetValue(parameter.Name, out var explicitValue))
                {
                    initializers.Add(new BoundFieldInitializer(property, explicitValue.Value));
                }
                else
                {
                    var access = new BoundPropertyAccessExpression(null, new BoundVariableExpression(null, tempVar), structType, property);
                    initializers.Add(new BoundFieldInitializer(property, access));
                }
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
            result = overloads.BindConstructorCallExpression(syntax, dataClassAggregate);
            return true;
        }

        if (TryBindClrConstructorFromType(clrType, syntax, out result, openGenericDefinition, symbolicTypeArgs))
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

        return false;
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
                constantNarrowingArgumentCheck: MakeConstantNarrowingArgumentCheck(boundArguments));
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
    /// Issue #1833: scans every public static/instance generic method named
    /// <paramref name="methodName"/> on <paramref name="classType"/> whose
    /// arity matches the explicit type-argument list, looking for one whose
    /// only structural mismatch is a value-type-erased type argument (a
    /// concrete non-enum struct, or a bare <c>[T struct]</c> type parameter)
    /// failing an explicit base-class constraint — e.g. <c>Enum.TryParse</c>'s
    /// <c>where TEnum : Enum</c> bound. Reports the constraint-violation
    /// diagnostic (<c>GS0152</c>, the same one user-declared generic
    /// functions/types already use) and returns <see langword="true"/> on the
    /// first hit; other reasons a candidate is inapplicable (arity, argument
    /// types, an unconstrained type parameter, ...) are left to the caller's
    /// existing "cannot find function" fallback.
    /// </summary>
    /// <param name="classType">The imported class's CLR <see cref="Type"/>.</param>
    /// <param name="methodName">The called method's name.</param>
    /// <param name="explicitTypeArgs">The resolved explicit CLR type arguments.</param>
    /// <param name="typeArgSymbols">The resolved symbolic type-argument vector.</param>
    /// <param name="location">The text location to attach the diagnostic to.</param>
    /// <returns><see langword="true"/> when a violation was found and reported.</returns>
    private bool TryReportGenericValueTypeBaseConstraintViolation(Type classType, string methodName, System.Type[] explicitTypeArgs, ImmutableArray<TypeSymbol> typeArgSymbols, TextLocation location)
    {
        if (classType is null || explicitTypeArgs is null || explicitTypeArgs.Length == 0 || typeArgSymbols.IsDefaultOrEmpty)
        {
            return false;
        }

        MethodInfo[] candidates;
        try
        {
            candidates = classType
                .GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance)
                .Where(m => m.Name == methodName
                    && m.IsGenericMethodDefinition
                    && m.GetGenericArguments().Length == explicitTypeArgs.Length)
                .ToArray();
        }
        catch (Exception)
        {
            return false;
        }

        foreach (var candidate in candidates)
        {
            if (OverloadResolution.TryDescribeValueTypeBaseConstraintViolation(candidate, explicitTypeArgs, typeArgSymbols, out var typeParameterName, out var typeArgument, out var constraintDescription))
            {
                Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(location, typeParameterName, typeArgument, constraintDescription);
                return true;
            }
        }

        return false;
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
    /// Issue #1507: builds the receiver type used to drive DEFERRED untyped
    /// arrow-lambda inference over a slice (<c>[]T</c>) or array (<c>[N]T</c>)
    /// receiver. Such a receiver's <see cref="TypeSymbol.ClrType"/> is
    /// <see langword="null"/> for a same-compilation user element (and an array
    /// CLR type otherwise), so the extension-method probe in
    /// <see cref="ResolveDeferredArrowLambdaArguments"/> — which is gated on a
    /// non-null receiver <c>ClrType</c> — is never reached and the element type
    /// is never recovered to target-type the untyped lambda parameter. Normalize
    /// to a symbolic constructed <c>IEnumerable[elementType]</c> carrying the
    /// element type as a symbolic argument (mirroring the <c>List[T]</c> /
    /// <c>sequence[T]</c> shapes), so the LINQ extension
    /// <c>Where&lt;TSource&gt;(IEnumerable&lt;TSource&gt;, Func&lt;TSource,bool&gt;)</c>
    /// (and every other delegate-taking extension) matches and <c>TSource</c> is
    /// recovered as the element type. The constructed <c>ClrType</c> uses the
    /// element's erased CLR projection, so a same-compilation user element
    /// (<c>[]Item</c>) closes to <c>IEnumerable&lt;object&gt;</c> with the
    /// symbolic <c>[Item]</c> argument (the symbolic recovery path re-derives
    /// <c>Item</c>), while a primitive/BCL element (<c>[]int32</c>,
    /// <c>[]string</c>) closes to the concrete <c>IEnumerable&lt;int&gt;</c> /
    /// <c>IEnumerable&lt;string&gt;</c> so the CLR inference path recovers the
    /// real element type instead of erasing it to <c>object</c>. This mirrors the
    /// <c>List[T]</c> behaviour exactly. The <c>IEnumerable&lt;&gt;</c> open
    /// definition and closed shape are resolved through the compilation's
    /// reference set (<see cref="ReferenceResolver.MapClrTypeToReferences"/>) so
    /// the constructed <c>OpenDefinition</c> is reference-identical to the
    /// extension methods' <c>this IEnumerable&lt;TSource&gt;</c> parameter — the
    /// symbolic unifier (<c>UnifyForMethodTypeArgs</c>) matches the open
    /// definition by reference, which would otherwise fail whenever the reference
    /// set is projected through a <see cref="System.Reflection.MetadataLoadContext"/>
    /// (its <c>IEnumerable&lt;&gt;</c> is not the runtime <c>typeof</c>). The bound
    /// call keeps the original slice/array receiver expression; the emitter
    /// already normalizes slice/array receivers to their enumerable surface, so
    /// emission is unaffected. Returns <see langword="false"/> when no
    /// normalization applies.
    /// </summary>
    /// <param name="receiverType">The receiver's static type symbol.</param>
    /// <param name="normalized">The normalized symbolic <c>IEnumerable[T]</c> receiver type, on success.</param>
    /// <returns><see langword="true"/> when a normalized receiver type was produced.</returns>
    private bool TryNormalizeSliceArrayReceiverForLambdaInference(TypeSymbol receiverType, out TypeSymbol normalized)
    {
        normalized = null;

        TypeSymbol elementType;
        switch (receiverType)
        {
            case SliceTypeSymbol slice:
                elementType = slice.ElementType;
                break;
            case ArrayTypeSymbol array:
                elementType = array.ElementType;
                break;
            default:
                return false;
        }

        if (elementType == null || !MemberLookup.TryProjectErasedClrType(elementType, out var erasedElement))
        {
            return false;
        }

        Type openDefinition;
        Type closedEnumerable;
        try
        {
            openDefinition = scope.References.MapClrTypeToReferences(typeof(System.Collections.Generic.IEnumerable<>));
            var mappedElement = scope.References.MapClrTypeToReferences(erasedElement);
            closedEnumerable = openDefinition.MakeGenericType(mappedElement);
        }
        catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex) || ex is ArgumentException || ex is InvalidOperationException)
        {
            return false;
        }

        normalized = ImportedTypeSymbol.GetConstructed(
            closedEnumerable,
            openDefinition,
            ImmutableArray.Create(elementType));
        return true;
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

        if (ClrTypeUtilities.AreSame(closedMethod.DeclaringType, openDefinition))
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
        var staticClassType = classSymbol?.ClassType;
        var receiverClrType = classSymbol == null ? receiver?.Type?.ClrType : null;
        foreach (var probe in this.memberLookup.CollectImportedMethodProbes(staticClassType, receiverClrType, methodName, includeExtensions: classSymbol == null))
        {
            foreach (var method in probe.Methods)
            {
                var parameters = method.GetParameters();
                if (probe.ReceiverParameterOffset == 0)
                {
                    result.Add(parameters);
                    continue;
                }

                var stripped = new ParameterInfo[parameters.Length - probe.ReceiverParameterOffset];
                System.Array.Copy(parameters, probe.ReceiverParameterOffset, stripped, 0, stripped.Length);
                result.Add(stripped);
            }
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

        var candidates = MemberLookup.CollectSourceInstanceMethods(receiver.Type, methodName);

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

                if (!MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(candidate.Parameters[paramPos].Type, out var fn) || fn == null)
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

    /// <summary>
    /// Issue #1330: binds a static method call on a generic type constructed
    /// over an in-scope generic type parameter (e.g.
    /// <c>Comparer[TResult].Create(...)</c>) by substituting the receiver's
    /// symbolic type arguments through the resolved method's open parameter and
    /// return types. A delegate parameter surfaces as its symbolic shape
    /// (<c>Comparison[TResult]</c>) so a function-literal argument flows through
    /// as an identity adapter hosted in the enclosing generic context rather than
    /// a type-erased <c>&lt;object&gt;</c> adapter referencing an out-of-scope
    /// type parameter; the result is the symbolic <c>Comparer[TResult]</c>; and
    /// the produced <see cref="BoundImportedCallExpression"/> carries the
    /// symbolic container so the emitter parents the call at the constructed
    /// <c>Comparer&lt;!TResult&gt;</c> TypeSpec. Returns <see langword="false"/>
    /// (deferring to the ordinary erased path) when the symbolic open method or a
    /// parameter projection cannot be recovered.
    /// </summary>
    private bool TryBindSymbolicImportedStaticCall(
        CallExpressionSyntax ce,
        ImportedClassSymbol classSymbol,
        ImportedFunctionSymbol staticFn,
        ImmutableArray<BoundExpression> arguments,
        out BoundExpression result)
    {
        result = null;
        var symbolicReceiver = classSymbol.SymbolicReceiver;
        if (symbolicReceiver?.OpenDefinition == null
            || symbolicReceiver.TypeArguments.IsDefaultOrEmpty
            || !TryResolveOpenStaticMethod(symbolicReceiver.OpenDefinition, staticFn.Method, out var openMethod))
        {
            return false;
        }

        var openParameters = openMethod.GetParameters();
        if (openParameters.Length != arguments.Length)
        {
            // Optional/params/defaulted parameter shapes are not handled by this
            // narrow symbolic path; fall back to the ordinary resolution.
            return false;
        }

        var openDef = symbolicReceiver.OpenDefinition;
        var symbolicArgs = symbolicReceiver.TypeArguments;
        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
        for (var i = 0; i < arguments.Length; i++)
        {
            var argument = arguments[i];
            var openParamType = openParameters[i].ParameterType;
            var symbolicParamType = MemberLookup.MapOpenClrTypeToSymbolic(openParamType, openDef, symbolicArgs);

            if (LambdaBinder.TryGetFunctionLiteral(argument, out var functionLiteral)
                && symbolicParamType is ImportedTypeSymbol symbolicDelegateParam
                && symbolicDelegateParam.OpenDefinition != null
                && symbolicDelegateParam.HasTypeParameterArgument
                && TryBuildSymbolicDelegateTarget(openParamType, openDef, symbolicArgs, out var symbolicDelegateTarget))
            {
                // The substituted delegate target matches the literal's declared
                // (TResult-typed) shape, so the adapter returns the literal
                // unchanged (IsIdentityAdapter) — the lambda MethodDef is hosted
                // in the enclosing generic context. Wrap it in a conversion to
                // the symbolic constructed delegate type (`Comparison[TResult]`)
                // so the emitter materialises a `Comparison<!TResult>` instance
                // (rather than the natural `Func<...>` or the type-erased
                // `Comparison<object>`) that the callee's reified parameter
                // accepts. The classifier would reject this (the erased
                // `Comparison<object>` Invoke shape differs from the TResult
                // literal), so build the conversion node directly.
                var adapter = lambdas.CreateErasedFunctionLiteralAdapter(functionLiteral, symbolicDelegateTarget);
                convertedArgs.Add(new BoundConversionExpression(null, symbolicDelegateParam, adapter));
                continue;
            }

            if (symbolicParamType is TypeParameterSymbol || symbolicParamType == TypeSymbol.Error)
            {
                convertedArgs.Add(argument);
                continue;
            }

            var argLoc = i < ce.Arguments.Count ? ce.Arguments[i].Location : ce.Location;
            convertedArgs.Add(conversions.BindConversion(argLoc, argument, symbolicParamType));
        }

        var symbolicReturn = MemberLookup.MapOpenClrTypeToSymbolic(openMethod.ReturnType, openDef, symbolicArgs);
        var overriddenFn = new ImportedFunctionSymbol(
            staticFn.Name,
            classSymbol,
            staticFn.Method,
            staticFn.Declaration,
            returnTypeOverride: symbolicReturn);
        var refKinds = ComputeArgumentRefKinds(staticFn.Method.GetParameters());
        result = new BoundImportedCallExpression(
            null,
            overriddenFn,
            convertedArgs.MoveToImmutable(),
            refKinds,
            typeArgumentSymbols: default,
            staticContainerType: symbolicReceiver);
        return true;
    }

    /// <summary>
    /// Issue #1330: resolves the open generic <em>type</em> definition's method
    /// corresponding to <paramref name="closedMethod"/> (a static method on the
    /// type-erased closed shape, e.g. <c>Comparer&lt;object&gt;.Create</c>) by
    /// metadata-token identity, yielding e.g. <c>Comparer&lt;&gt;.Create</c>
    /// whose parameter/return types are stated in terms of the type's open
    /// generic parameters.
    /// </summary>
    private static bool TryResolveOpenStaticMethod(Type openDefinition, MethodInfo closedMethod, out MethodInfo openMethod)
    {
        openMethod = null;
        if (openDefinition == null || closedMethod == null)
        {
            return false;
        }

        try
        {
            foreach (var candidate in openDefinition.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
            {
                if (candidate.MetadataToken == closedMethod.MetadataToken && candidate.Module == closedMethod.Module)
                {
                    openMethod = candidate;
                    return true;
                }
            }
        }
        catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
        {
            return false;
        }

        return false;
    }

    /// <summary>
    /// Issue #1330: builds a <see cref="FunctionTypeSymbol"/> for an open
    /// delegate parameter type (e.g. <c>Comparison&lt;T&gt;</c>) by substituting
    /// the receiver's symbolic type arguments into the delegate's
    /// <c>Invoke</c> signature, producing the symbolic target
    /// <c>(TResult, TResult) -&gt; int32</c>. Returns <see langword="false"/> when
    /// the parameter is not a delegate type.
    /// </summary>
    private static bool TryBuildSymbolicDelegateTarget(
        Type openParameterType,
        Type openDefinition,
        ImmutableArray<TypeSymbol> symbolicArgs,
        out FunctionTypeSymbol target)
    {
        target = null;
        if (openParameterType == null)
        {
            return false;
        }

        var invoke = openParameterType.GetMethodSafe("Invoke");
        if (invoke == null)
        {
            return false;
        }

        var invokeParameters = invoke.GetParameters();
        var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(invokeParameters.Length);
        foreach (var parameter in invokeParameters)
        {
            parameterTypes.Add(MemberLookup.MapOpenClrTypeToSymbolic(parameter.ParameterType, openDefinition, symbolicArgs));
        }

        var returnType = invoke.ReturnType.IsSameAs(typeof(void))
            ? TypeSymbol.Void
            : MemberLookup.MapOpenClrTypeToSymbolic(invoke.ReturnType, openDefinition, symbolicArgs);
        target = FunctionTypeSymbol.Get(parameterTypes.ToImmutable(), returnType);
        return true;
    }

    /// <summary>
    /// Issue #1512: builds a symbolic <see cref="FunctionTypeSymbol"/> for a
    /// lambda argument bound to a generic CLR/imported method whose delegate
    /// parameter mentions a method type parameter (e.g.
    /// <c>Task.ContinueWith&lt;TResult&gt;(Func&lt;Task,TResult&gt;)</c>). The
    /// CLOSED method's parameter is type-erased (<c>Func&lt;Task,object&gt;</c>),
    /// which would force the lambda's bound function type — and therefore its
    /// synthesized return — to <c>object</c>, so the delegate emits as
    /// <c>Func&lt;Task,object&gt;</c> instead of <c>Func&lt;Task,T&gt;</c>. This
    /// recovers the real shape by substituting the inferred symbolic method type
    /// arguments (and any receiver-level type arguments) through the OPEN
    /// method's delegate parameter via <see cref="MemberLookup.MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray{TypeSymbol}, MethodInfo, ImmutableArray{TypeSymbol})"/>.
    /// Returns <see langword="false"/> (deferring to the erased target) when the
    /// parameter is not a delegate, the method is not generic, or no recovered
    /// position contains a type parameter / same-compilation user type.
    /// </summary>
    private static bool TryBuildSymbolicDelegateTargetForMethodParam(
        MethodInfo closedMethod,
        int paramIndex,
        ImmutableArray<TypeSymbol> symbolicMethodTypeArgs,
        TypeSymbol receiverType,
        out FunctionTypeSymbol target)
    {
        target = null;
        if (closedMethod == null
            || !closedMethod.IsGenericMethod
            || symbolicMethodTypeArgs.IsDefaultOrEmpty
            || !symbolicMethodTypeArgs.Any(s => s != null
                && (TypeSymbol.ContainsTypeParameter(s) || TypeSymbol.ContainsSameCompilationUserType(s))))
        {
            return false;
        }

        MethodInfo openMethod;
        ParameterInfo[] openParams;
        try
        {
            openMethod = closedMethod.IsGenericMethodDefinition ? closedMethod : closedMethod.GetGenericMethodDefinition();
            openParams = openMethod.GetParameters();
        }
        catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
        {
            return false;
        }

        if (paramIndex < 0 || paramIndex >= openParams.Length)
        {
            return false;
        }

        var openParamType = openParams[paramIndex].ParameterType;
        var invoke = openParamType?.GetMethodSafe("Invoke");
        if (invoke == null)
        {
            return false;
        }

        Type receiverOpenDef = null;
        ImmutableArray<TypeSymbol> receiverTypeArgs = default;
        if (receiverType is ImportedTypeSymbol imp && imp.OpenDefinition != null && !imp.TypeArguments.IsDefaultOrEmpty)
        {
            receiverOpenDef = imp.OpenDefinition;
            receiverTypeArgs = imp.TypeArguments;
        }

        var invokeParameters = invoke.GetParameters();
        var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(invokeParameters.Length);
        foreach (var parameter in invokeParameters)
        {
            parameterTypes.Add(MemberLookup.MapOpenClrTypeToSymbolic(
                parameter.ParameterType, receiverOpenDef, receiverTypeArgs, openMethod, symbolicMethodTypeArgs));
        }

        var returnType = invoke.ReturnType.IsSameAs(typeof(void))
            ? TypeSymbol.Void
            : MemberLookup.MapOpenClrTypeToSymbolic(invoke.ReturnType, receiverOpenDef, receiverTypeArgs, openMethod, symbolicMethodTypeArgs);

        var candidate = FunctionTypeSymbol.Get(parameterTypes.ToImmutable(), returnType);

        // Only override the erased target when the recovered shape actually
        // carries a type parameter or same-compilation user type; otherwise the
        // ordinary closed-CLR delegate target is already correct.
        var carries = (returnType != null && (TypeSymbol.ContainsTypeParameter(returnType) || TypeSymbol.ContainsSameCompilationUserType(returnType)))
            || parameterTypes.Any(p => p != null && (TypeSymbol.ContainsTypeParameter(p) || TypeSymbol.ContainsSameCompilationUserType(p)));
        if (!carries)
        {
            return false;
        }

        target = candidate;
        return true;
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
        // Issue #1507: a slice/array receiver (`[]T` / `[N]T`) carries a null
        // (user element) or array-shaped ClrType, so the extension-method probe
        // below — gated on a non-null receiver ClrType — would never be added
        // and the untyped lambda parameter would never be target-typed from the
        // matching LINQ delegate. Normalize such a receiver to a symbolic
        // `IEnumerable[elementType]` (recovering the element type exactly as the
        // `List[T]`/`sequence[T]` paths do) purely for the purpose of inferring
        // the deferred lambda targets; the finally-bound call keeps the original
        // slice/array receiver expression.
        var receiverType = receiver?.Type;
        if (receiverType != null
            && TryNormalizeSliceArrayReceiverForLambdaInference(receiverType, out var normalizedReceiverType))
        {
            receiverType = normalizedReceiverType;
        }

        var probes = this.memberLookup.CollectImportedMethodProbes(
            classSymbol?.ClassType,
            classSymbol == null ? receiverType?.ClrType : null,
            methodName,
            includeExtensions: classSymbol == null && receiverType?.ClrType != null);

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
        foreach (var probe in probes)
        {
            if (TryMapDeferredLambdaTargetsSymbolic(probe.Methods, probe.ReceiverParameterOffset, receiverType, ce, deferredIndices, boundArgs, deferred, out var symbolicTargets, out var exactReturnIndices))
            {
                foreach (var idx in deferredIndices)
                {
                    var inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[idx]);
                    if (inner is LambdaExpressionSyntax lambdaSyntax && symbolicTargets.TryGetValue(idx, out var target))
                    {
                        // Issue #2345: when this slot's return type was fully
                        // recovered (e.g. `void` for an Action-shaped
                        // parameter), bind against the real target so the
                        // void-discard / ordinary target-typed return-type
                        // inference applies instead of inferring the return
                        // type purely from the lambda body.
                        boundArgs[idx] = lambdas.BindLambdaExpression(lambdaSyntax, target, inferReturnTypeFromBody: !exactReturnIndices.Contains(idx));
                    }
                }

                return;
            }
        }

        foreach (var probe in probes)
        {
            var offset = probe.ReceiverParameterOffset;
            var methods = probe.Methods;
            var argTypes = new System.Type[boundArgs.Length + offset];
            if (offset == 1)
            {
                argTypes[0] = receiverType.ClrType;
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

            // Issue #1812: `interpolatedStringArgs` is intentionally omitted
            // here. This Resolve call is a best-effort probe purely to
            // discover a deferred (untyped) arrow-lambda argument's delegate
            // parameter type by narrowing candidates on the other,
            // already-bound arguments; it is never the final overload
            // decision. The call is re-resolved for real via the ordinary
            // static/instance/extension Resolve call sites once every
            // argument (including the now-typed lambda) is bound — those
            // sites already pass the flag, so an interpolated-string argument
            // sharing a call with a deferred lambda still resolves/rebinds
            // correctly overall.
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
                    || !MemberLookup.TryGetLambdaTargetFunctionType(parameterType, out var fn)
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
        foreach (var probe in probes)
        {
            if (TryMapDeferredLambdaParameterTargets(probe.Methods, probe.ReceiverParameterOffset, receiverType, ce, deferredIndices, boundArgs, out var partialTargets))
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
        TypeSymbol receiverType,
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
            if (receiverType?.ClrType is not System.Type receiverClrType)
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
    ///
    /// Issue #2345: also recovers the delegate's <em>return</em> shape when it
    /// is fully closed by the same unification (including the common case of a
    /// <c>void</c>-returning <c>Action</c>-shaped delegate). When recovered,
    /// the corresponding slot in <paramref name="exactReturnIndices"/> is
    /// marked so callers bind that lambda against the real target (not
    /// <c>inferReturnTypeFromBody</c>) — this is what lets a block-bodied
    /// lambda whose trailing statement calls a fluent/self-returning method
    /// correctly discard that value instead of being mis-inferred as a
    /// value-returning <c>Func</c> (see <c>InferLambdaReturnType</c>'s issue
    /// #889 void-discard rule). When the return type still contains an
    /// unresolved method type parameter, the slot keeps the previous
    /// placeholder behavior (return type inferred from the lambda body).
    /// </summary>
    private bool TryMapDeferredLambdaTargetsSymbolic(
        IReadOnlyList<MethodInfo> methods,
        int offset,
        TypeSymbol receiverType,
        CallExpressionSyntax ce,
        List<int> deferredIndices,
        BoundExpression[] boundArgs,
        HashSet<int> deferred,
        out Dictionary<int, FunctionTypeSymbol> targets,
        out HashSet<int> exactReturnIndices)
    {
        exactReturnIndices = new HashSet<int>();

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
        if (offset == 1 && receiverType == null)
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
            symbolicArgs[0] = receiverType;
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
        Dictionary<int, TypeSymbol> agreedReturnTypes = null;
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
            var slotReturnTypes = new Dictionary<int, TypeSymbol>();
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
                    invoke = delegateType?.GetMethodSafe("Invoke");
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

                // Issue #2345: recover the delegate's return shape too, when it
                // is fully closed by this unification (most commonly `void`,
                // for an Action-shaped constraints/configuration delegate).
                // Candidates that leave the return type open (e.g. still
                // containing an unresolved method type parameter) fall back to
                // the pre-existing placeholder + inferReturnTypeFromBody
                // behavior for that slot.
                var returnClrType = invoke.ReturnType;
                var mappedReturn = returnClrType != null && returnClrType.IsSameAs(typeof(void))
                    ? TypeSymbol.Void
                    : MemberLookup.MapOpenClrTypeToSymbolic(returnClrType, openDefinition: null, typeArguments: default, openMethodDefinition: openMethod, methodTypeArguments: methodTypeArgs);
                if (mappedReturn != null && mappedReturn != TypeSymbol.Error && !TypeSymbol.ContainsTypeParameter(mappedReturn))
                {
                    slotReturnTypes[idx] = mappedReturn;
                }
            }

            if (!candidateUsable || slotTargets.Count != deferredIndices.Count)
            {
                continue;
            }

            if (agreed == null)
            {
                agreed = slotTargets;
                agreedReturnTypes = slotReturnTypes;
            }
            else if (!SymbolicLambdaParameterTypesAgree(agreed, slotTargets))
            {
                return false;
            }
            else
            {
                // Issue #2345: parameter shapes agree across candidates, but
                // only keep a recovered return type for a slot when every
                // agreeing candidate recovered the *same* return type;
                // otherwise that slot falls back to the pre-existing
                // placeholder + inferReturnTypeFromBody behavior.
                foreach (var idx in deferredIndices)
                {
                    if (agreedReturnTypes.TryGetValue(idx, out var existingReturn))
                    {
                        if (!slotReturnTypes.TryGetValue(idx, out var otherReturn) || !Equals(existingReturn, otherReturn))
                        {
                            agreedReturnTypes.Remove(idx);
                        }
                    }
                }
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
            if (agreedReturnTypes != null && agreedReturnTypes.TryGetValue(kv.Key, out var exactReturn))
            {
                // Issue #2345: the delegate's return shape was fully closed by
                // unification (e.g. `void` for an Action-shaped parameter) —
                // bind against the real target so the caller does NOT pass
                // inferReturnTypeFromBody, letting InferLambdaReturnType's
                // void-discard rule (issue #889) and ordinary target-typed
                // inference apply.
                built[kv.Key] = FunctionTypeSymbol.Get(kv.Value, exactReturn);
                exactReturnIndices.Add(kv.Key);
            }
            else
            {
                // The return slot is a placeholder; callers bind with
                // inferReturnTypeFromBody so the lambda infers its own return type.
                built[kv.Key] = FunctionTypeSymbol.Get(kv.Value, TypeSymbol.Object);
            }
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
    /// <param name="receiverType">The receiver's static type (for symbolic by-ref-parameter recovery); may be <see langword="null"/>.</param>
    /// <param name="typeArgSymbols">The explicit type-argument symbols (issue #1599, for recovering a placeholder-closed out-parameter pointee); default when absent.</param>
    /// <returns>The argument vector with inline out-var placeholders rebound.</returns>
    private ImmutableArray<BoundExpression> RebindInlineOutVarArguments(
        CallExpressionSyntax ce,
        ImmutableArray<BoundExpression> arguments,
        System.Reflection.MethodInfo resolvedMethod,
        ImmutableArray<int> parameterMapping,
        TypeSymbol receiverType = null,
        ImmutableArray<TypeSymbol> typeArgSymbols = default)
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

            // Issue #1107: when the by-ref parameter's pointee is a type-level
            // generic parameter on the receiver (e.g. `Dictionary[string,
            // Entry].TryGetValue(string, out TValue)`), the resolved CLR method
            // erased `TValue` to `object`, so the out-var local would bind as
            // `object` and member access on it (`found.V`) would fail (GS0158).
            // Recover the symbolic pointee type from the receiver's symbolic
            // type arguments (mirroring `ResolveInstanceReturnTypeFromReceiver`).
            var pointeeType = ResolveInstanceParameterPointeeTypeFromReceiver(receiverType, resolvedMethod, paramIndex)
                ?? ResolveMethodGenericParameterPointeeType(resolvedMethod, paramIndex, typeArgSymbols)
                ?? TypeSymbol.FromClrType(pointeeClr);
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

    /// <summary>
    /// Issue #1599: recovers the pointee type of an <c>out</c>/<c>ref</c> parameter that
    /// is typed by one of the resolved generic method's own type parameters (e.g. the
    /// <c>out TEnum</c> of <c>Enum.TryParse&lt;TEnum&gt;(string, out TEnum)</c>) from the
    /// explicit type-argument symbols. When the method was closed over a value-type
    /// placeholder (or an <see cref="object"/> erasure) — as happens for a
    /// same-compilation user value type under a <c>where T : struct</c> constraint — the
    /// closed CLR parameter carries the placeholder, which must not leak into an inline
    /// <c>out var</c> local. Returns <see langword="null"/> when no recovery applies so
    /// the caller falls back to the CLR pointee type.
    /// </summary>
    /// <param name="resolvedMethod">The closed generic method selected by overload resolution.</param>
    /// <param name="parameterIndex">The zero-based parameter position of the out/ref argument.</param>
    /// <param name="typeArgSymbols">The explicit type-argument symbols, or default.</param>
    /// <returns>The recovered pointee type symbol, or <see langword="null"/>.</returns>
    private static TypeSymbol ResolveMethodGenericParameterPointeeType(
        System.Reflection.MethodInfo resolvedMethod,
        int parameterIndex,
        ImmutableArray<TypeSymbol> typeArgSymbols)
    {
        if (!typeArgSymbols.IsDefaultOrEmpty
            && OverloadResolution.TryGetGenericMethodParameterPosition(resolvedMethod, parameterIndex, out var position)
            && position >= 0
            && position < typeArgSymbols.Length)
        {
            return typeArgSymbols[position];
        }

        return null;
    }

    internal BoundExpression BindAccessorCall(BoundExpression receiver, ImportedClassSymbol classSymbol, CallExpressionSyntax ce)
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
                //
                // Issue #2193: but if a same-named user extension function has a
                // function-typed parameter at this position, the CLR candidate
                // set is not authoritative — target-typing the lambda to a CLR
                // delegate (e.g. the void `SendOrPostCallback` of
                // `SynchronizationContext.Send`) would erase the lambda's return
                // type and break inference of the extension's result type
                // parameter (GS0151). Bind the lambda with its natural type so
                // both the CLR instance method and the user extension can compete
                // (delegate-reshaping conversions still make it applicable to a
                // concrete CLR delegate parameter when that path is chosen).
                var argName = argumentNames.IsDefault ? null : argumentNames[argSlot];
                if (UserExtensionHasFunctionTypedParameterAt(receiver, methodName, argSlot))
                {
                    boundArguments.Add(BindExpression(inner));
                }
                else
                {
                    if (!delegateTargetCandidatesComputed)
                    {
                        delegateTargetCandidatesComputed = true;
                        delegateTargetCandidateParams = CollectDelegateTargetCandidateParameterLists(receiver, classSymbol, methodName);
                    }

                    // Issue #2345: an explicitly-typed lambda whose matching
                    // delegate parameter is an *open* generic (e.g. an imported
                    // generic method's `Action<Builder<TColumns>>`, where
                    // `TColumns` only closes once the method's type arguments
                    // are inferred from the call's other arguments) cannot be
                    // target-typed yet. Binding it now with no target is only
                    // safe for an expression-bodied lambda (`-> expr`), whose
                    // return type is unambiguously the expression's type either
                    // way. A block-bodied lambda (`-> { ... }`) is different:
                    // with no target, a trailing call expression-statement (e.g.
                    // a fluent/self-returning builder method) is treated as the
                    // block's *value*, producing a `Func<..., TResult>`-shaped
                    // lambda instead of the `void`-returning `Action` the (still
                    // unresolved) target actually expects — which mismatches the
                    // real parameter and cascades into "cannot find function" at
                    // the outer call. Defer such lambdas exactly like an
                    // untyped arrow lambda so the staged inference below
                    // (`ResolveDeferredArrowLambdaArguments`) can close the
                    // generic method's type arguments from the other arguments
                    // first, then bind this lambda against the now-closed
                    // delegate target (its own explicit parameter types are
                    // unaffected — only return-type inference depends on the
                    // target).
                    if (inner is LambdaExpressionSyntax { Body: BlockExpressionSyntax } blockLambda
                        && argumentNames.IsDefault
                        && !TryResolveDelegateTargetFromCandidates(delegateTargetCandidateParams, paramOffset: 0, sourceArgIndex: argSlot, argName: argName, target: out _, blockedByOpenGenericParameter: out var blocked)
                        && blocked)
                    {
                        deferredArrowLambdaIndices.Add(argSlot);
                        boundArguments.Add(new BoundErrorExpression(blockLambda));
                    }
                    else
                    {
                        boundArguments.Add(BindCallArgumentWithDelegateTargetTyping(
                            argument, delegateTargetCandidateParams, sourceArgIndex: argSlot, argName: argName, paramOffset: 0));
                    }
                }
            }
            else
            {
                boundArguments.Add(BindArgumentDeferringBranchy(inner));
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
                // Issue #1538: now that the imported static overload is chosen,
                // re-bind any inline `out var`/`out let`/`out _` placeholders
                // against the resolved by-ref parameter so the synthesized local
                // is declared with the inferred (substituted) pointee type and
                // leaks into the enclosing block scope. Without this the
                // placeholder (an Error-typed address-of) would flow into the
                // parameter-conversion path below and the inline-declared local
                // would never exist for the rest of the body. Static calls have
                // no receiver, so pass null; the mapping aligns source args to
                // parameters for out-parameters in any position.
                arguments = RebindInlineOutVarArguments(ce, arguments, staticFn.Method, staticMapping, receiver?.Type, typeArgSymbols);

                // Issue #1330: when the receiver is a generic type constructed
                // over an in-scope generic type parameter (`Comparer[TResult]`),
                // bind the static call symbolically — substituting the receiver's
                // symbolic arguments through the resolved method's parameter and
                // return types — so a delegate parameter surfaces as
                // `Comparison[TResult]` (the lambda flows through as an identity
                // adapter hosted in the enclosing generic context rather than a
                // type-erased `<object>` adapter referencing an out-of-scope
                // type parameter), the call's result type is the symbolic
                // `Comparer[TResult]`, and the emitter parents the call at the
                // constructed `Comparer<!TResult>` TypeSpec. Yields verifiable IL
                // exactly as the concrete-argument receiver does.
                if (classSymbol.SymbolicReceiver != null
                    && argumentNames.IsDefault
                    && !staticIsExpanded
                    && staticMapping.IsDefault
                    && TryBindSymbolicImportedStaticCall(ce, classSymbol, staticFn, arguments, out var symbolicStaticCall))
                {
                    return symbolicStaticCall;
                }

                var staticParameters = staticFn.Method.GetParameters();
                var staticExpandedArgs = staticIsExpanded
                    ? overloads.ExpandParamsArguments(arguments, staticParameters, ce, parameterMapping: staticMapping)
                    : arguments;
                var staticDownstreamMapping = staticIsExpanded ? default : staticMapping;

                // Issue #1325 / #1471: recover the symbolic method type-argument
                // vector before parameter conversion so a bare `default`
                // argument closed over an open type parameter (e.g.
                // `Task.FromResult[T?](default)`) materialises against the real
                // type parameter instead of the erased `object` placeholder.
                // Issue #1512: computed BEFORE the delegate rebind so a lambda
                // argument whose return is a method type parameter recovers its
                // symbolic delegate target rather than erasing to `object`.
                var staticSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(
                    receiverType: null,
                    ImmutableArray.CreateRange(arguments.Select(a => a?.Type)));
                var staticSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(staticFn.Method, typeArgSymbols, staticSymbolicArgs);
                var staticTypeArgSymbolsForCall = !staticSymbolicTypeArgs.IsDefault ? staticSymbolicTypeArgs : typeArgSymbols;

                // Issue #1638: shared CLR call-argument-construction pipeline
                // (interpolation rebind → handler args → delegate rebind →
                // parameter conversions). Issue #889: void-izes value-returning
                // func/arrow literals passed to void-returning delegate
                // parameters (System.Action / Action<...>), mirroring the
                // instance path. Issue #506 follow-up: ensures value-type →
                // object boxing fires for fixed-arity CLR static calls (e.g.
                // `String.Format("{0}", 42)` selecting the fixed `(string,
                // object)` overload).
                var staticConvertedArgs = BuildResolvedClrCallArguments(
                    staticExpandedArgs,
                    ce.Arguments,
                    staticParameters,
                    staticDownstreamMapping,
                    receiver: null,
                    ce.Location,
                    ce,
                    ClrCallDelegateRebindMode.Full,
                    out var staticHandlerPrelude,
                    out _,
                    method: staticFn.Method,
                    symbolicMethodTypeArgs: staticTypeArgSymbolsForCall);
                var staticArguments = OverloadResolver.BuildOrderedCallArguments(staticConvertedArgs, staticDownstreamMapping, staticParameters);
                var refKinds = ComputeArgumentRefKinds(staticParameters);
                overloads.ValidateRefArguments(staticArguments, refKinds, methodName, ce.Location);

                BoundExpression staticCall = new BoundImportedCallExpression(null, staticFn, staticArguments, refKinds, staticTypeArgSymbolsForCall);
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

            // Issue #1833: a value-type-erased type argument (a concrete
            // non-enum struct, or a bare `[T struct]` type parameter) explicitly
            // supplied to a generic BCL method whose type parameter carries an
            // `Enum` (or any other concrete) base-class constraint is now
            // rejected by `SatisfiesGenericConstraints`, so the candidate above
            // was silently dropped exactly like any other inapplicable overload.
            // Report the specific constraint violation here — before falling
            // back to the generic "cannot find function" diagnostic — so the
            // caller gets a clear bind-time error instead of only discovering
            // the problem at CLR verification.
            if (explicitTypeArgs != null
                && TryReportGenericValueTypeBaseConstraintViolation(classSymbol.ClassType, methodName, explicitTypeArgs, typeArgSymbols, ce.Location))
            {
                return new BoundErrorExpression(null);
            }

            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
            return new BoundErrorExpression(null);
        }

        // Issue #1320: normalize a sequence[T]/asyncsequence[T] or user-element
        // array receiver (whose ClrType is null during binding) to its erased
        // CLR shape so the shared CLR-instance member-lookup path below resolves
        // its enumerable surface (GetEnumerator, ...) uniformly with an
        // explicitly-typed IEnumerable[T] parameter and a primitive-element
        // receiver. The bound call keeps the original receiver expression.
        var effectiveReceiverType = receiver?.Type;
        if (receiver?.Type != null
            && TryNormalizeSymbolicEnumerableReceiver(receiver.Type, out var normalizedReceiverType))
        {
            effectiveReceiverType = normalizedReceiverType;
        }

        if (receiver == null || effectiveReceiverType?.ClrType == null)
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
                var tpOverloads = MemberLookup.CollectSourceInstanceMethods(tpRecv, methodName);
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
                var tpClassOverloads = MemberLookup.CollectSourceInstanceMethods(tpClassRecv, methodName);
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
                var userOverloads = MemberLookup.CollectSourceInstanceMethods(userClass, methodName);
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
            // user-type receivers (struct/class/interface). Issue #1188:
            // extension functions overload, so select the best matching
            // overload across all (receiver, name) candidates.
            if (TryBindExtensionFunctionOverload(receiver, methodName, arguments, ce, argumentNames, out var userExtResult))
            {
                return userExtResult;
            }

            // Issue #296: a GSharp class inheriting an imported CLR base class
            // exposes the base's instance members. After user-defined and
            // extension lookups fail, resolve the call against the imported
            // base CLR type so inherited members are callable on the derived
            // GSharp instance. Inherited instance members take precedence over
            // imported extension methods.
            // Issue #1136: when the user class/struct declares no explicit
            // imported base, every .NET type still inherits System.Object's
            // instance members (GetType/ToString/GetHashCode/Equals). Fall back
            // to typeof(object) so those resolve. TryBindInheritedClrInstanceCall
            // returns false for any name Object does not define, so unknown
            // methods still report GS0159 below.
            // Issue #2210: use the transitive walk (issue #1582) rather than
            // only `inheritedDerived`'s own ImportedBaseType, so a metadata
            // base reached through one or more intermediate G#-defined base
            // classes (`class C : B` where `B : SomeImportedBase`) still
            // surfaces its inherited methods, matching how field/property
            // access already walks the chain.
            // Issue #2218 follow-up: only surface `protected`/`protected
            // internal` inherited members when `receiver` IS the current
            // implicit/explicit `this` — this path (BindAccessorCall) also
            // handles an arbitrary qualified `receiver.Method(...)` call, so
            // without this check protected inherited members would be
            // callable through any receiver expression, leaking accessibility.
            var allowProtectedInherited = IsCurrentThisReceiver(receiver);
            if (receiver != null && receiver.Type is StructSymbol inheritedDerived
                && (GetInheritedClrBaseType(inheritedDerived) ?? typeof(object)) is System.Type inheritedBaseClr
                && TryBindInheritedClrInstanceCall(receiver, inheritedBaseClr, methodName, arguments, ce, out var inheritedCall, explicitTypeArgs, typeArgSymbols, argumentNames, allowProtectedInherited: allowProtectedInherited))
            {
                return inheritedCall;
            }

            // Issue #1218: an enum value is a CLR value type whose base chain is
            // System.Enum -> System.ValueType -> System.Object. Its inherited
            // instance members (Enum.HasFlag, Object/ValueType ToString /
            // GetHashCode / Equals, Object.GetType) are callable on enum values.
            // Resolve against typeof(System.Enum); SafeGetMethods walks the base
            // types so all inherited members are found, and the helper returns
            // false for any name Enum/Object does not define (still GS0159).
            // Enum members are all public, so protected admission stays off here.
            if (receiver != null && receiver.Type is EnumSymbol
                && TryBindInheritedClrInstanceCall(receiver, typeof(System.Enum), methodName, arguments, ce, out var enumInheritedCall, explicitTypeArgs, typeArgSymbols, argumentNames, mapEnumArgumentsToBaseClr: true))
            {
                return enumInheritedCall;
            }

            // Issue #294: imported [Extension] method dispatched with instance
            // (receiver) syntax, when the receiver carries a CLR type even
            // though its symbol is a user/interface shape.
            if (receiver != null && TryBindImportedExtensionCall(receiver, methodName, arguments, ce, out var userPathExt, explicitTypeArgs, typeArgSymbols, argumentNames))
            {
                return userPathExt;
            }

            // Issue #1181: a user interface that extends an imported/BCL
            // interface (e.g. `interface IBox : IDisposable`) inherits that
            // interface's members. After user-declared interface members and
            // extension lookups fail, resolve the call against the transitive
            // imported base interfaces so `b.Dispose()` (b : IBox) binds and
            // emits a verifiable `callvirt IDisposable::Dispose`.
            if (receiver != null && receiver.Type is InterfaceSymbol importedBaseIfaceRecv
                && TryBindInterfaceImportedBaseInstanceCall(receiver, importedBaseIfaceRecv, methodName, arguments, ce, out var importedBaseIfaceCall, explicitTypeArgs, typeArgSymbols, argumentNames))
            {
                return importedBaseIfaceCall;
            }

            // Issue #1550: a value of ANY type parameter is ultimately a
            // System.Object, so the universal object instance members
            // (ToString, GetHashCode, Equals(object), GetType) are callable on
            // any type-parameter receiver even when no constraint supplies them.
            // Runs AFTER the constraint-dispatch paths above (#1052 / #1056 /
            // #943) so a constraint that redeclares one of these names still
            // wins there. Emitted as a verifiable
            // `constrained. !!T  callvirt System.Object::Method(...)` sequence,
            // which dispatches to any override for value, struct/enum and
            // reference type parameters alike without a manual box.
            if (receiver != null && receiver.Type is TypeParameterSymbol tpObjRecv
                && TryBindConstrainedObjectMemberCall(receiver, tpObjRecv, methodName, arguments, ce, argumentNames, out var constrainedObjectCall))
            {
                return constrainedObjectCall;
            }

            // Issue #2304: a source-declared interface (`InterfaceSymbol`,
            // ClrType still null at bind time) implicitly derives from
            // `System.Object` for member-access purposes, exactly like the
            // type-parameter fallback just above. Run AFTER every
            // user/imported-interface member and extension lookup so a
            // same-named interface/extension member still wins.
            if (receiver != null && receiver.Type is InterfaceSymbol
                && TryBindInterfaceObjectMemberCall(receiver, methodName, arguments, ce, argumentNames, out var ifaceObjectCall))
            {
                return ifaceObjectCall;
            }

            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
            return new BoundErrorExpression(null);
        }

        // Prefer a user-defined class method when the receiver is a user
        // class symbol that has one with this name. (BCL lookup is the
        // fallback for imported CLR types.)
        if (receiver.Type is StructSymbol userClassPriority)
        {
            var priorityOverloads = MemberLookup.CollectSourceInstanceMethods(userClassPriority, methodName);
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
            : effectiveReceiverType.ClrType;

        // Issue #529: use interface-aware method enumeration so that
        // methods declared on a base interface (e.g.
        // IEnumerable<T>.GetEnumerator() surfaced through
        // IReadOnlyList<T>) are found.
        var candidates = new List<MethodInfo>(MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(clrType, methodName));

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
                    // Issue #2347: a bare method group (e.g. a static BCL
                    // method or another CLR method reference) passed to a
                    // generic static/instance method has no fixed CLR type
                    // until the target delegate parameter is known. Defer it
                    // like an untyped lambda — leave the argTypes slot null
                    // so applicability/generic inference proceed using the
                    // other arguments — instead of aborting the whole
                    // candidate set; it is resolved against the winning
                    // overload's parameter type afterwards by
                    // BindClrParameterConversions.
                    if (!OverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]))
                    {
                        argsAllTyped = false;
                        break;
                    }
                }

                if (arguments[i].Type is StructSymbol { IsClass: true })
                {
                    hasUserClassArg = true;
                }

                argTypes[i] = t;
            }

            if (argsAllTyped)
            {
                // Issue #658 / #1634: supplementary interface check for user-class
                // args, threaded as a call-local parameter into Resolve instead of
                // a shared static so nested/concurrent binds can't clobber it.
                Func<Type, Type, bool> supplementaryInterfaceCheck = hasUserClassArg
                    ? (source, target) => IsUserClassAssignableToInterfaceFromArgs(arguments, argTypes, source, target)
                    : null;

                var resolution = OverloadResolution.Resolve(
                    candidates,
                    argTypes,
                    explicitTypeArgs,
                    scope.References.MapClrTypeToReferences,
                    ComputeInterpolatedStringArgFlags(ce.Arguments, arguments.Length),
                    argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames,
                    supplementaryInterfaceCheck: supplementaryInterfaceCheck,
                    constantNarrowingArgumentCheck: MakeConstantNarrowingArgumentCheck(arguments));
                switch (resolution.Outcome)
                {
                    case OverloadResolution.ResolutionOutcome.Resolved:
                        // Issue #2193: a CLR/imported instance method that shares a
                        // name with a user extension function must not automatically
                        // win overload resolution when it is only applicable through
                        // a lossy delegate-reshaping conversion (e.g. a G# function
                        // value `(T) -> TResult` discarding its result to satisfy a
                        // named void delegate parameter like
                        // `SynchronizationContext.Send(SendOrPostCallback, object)`)
                        // while an in-scope user extension is a strictly better
                        // (identity/standard) match. Merge the user-extension
                        // candidate set into the decision and prefer the extension
                        // when it is strictly better; instance methods that are a
                        // good (non-reshaping) match still win unconditionally.
                        if (receiver != null
                            && TryPreferBetterExtensionOverClrInstanceMethod(receiver, methodName, resolution.Best, argTypes, arguments, ce, argumentNames, out var betterExtensionCall))
                        {
                            return betterExtensionCall;
                        }

                        // Issue #977: now that the overload is chosen, re-bind
                        // any inline `out var`/`out let`/`out _` placeholders
                        // against the resolved by-ref parameter so the new
                        // local is declared with the inferred pointee type.
                        arguments = RebindInlineOutVarArguments(ce, arguments, resolution.Best, resolution.ParameterMapping, receiver?.Type, typeArgSymbols);

                        // Issue #1512: for a genuine INSTANCE method the receiver
                        // is `this`, not a formal parameter — `GetParameters()`
                        // excludes it. The method-type-argument inference vector
                        // must therefore align with the method's parameters and
                        // must NOT carry the receiver as slot 0 (unlike the
                        // extension-method path, where the receiver IS param 0).
                        // Including it shifted every real argument by one slot, so
                        // a method type parameter inferable only from a lambda
                        // argument (e.g. `TResult` of
                        // `Task.ContinueWith<TResult>(Func<Task,TResult>)`) was
                        // never unified and the call collapsed to `<object>`. The
                        // receiver still drives return-type Var substitution via
                        // `ResolveCallReturnTypeFromSymbolicTypeArgs` below.
                        var instSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(null, ImmutableArray.CreateRange(arguments.Select(a => a?.Type)));
                        var instSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(resolution.Best, typeArgSymbols, instSymbolicArgs);
                        var instTypeArgSymbolsForCall = !instSymbolicTypeArgs.IsDefault ? instSymbolicTypeArgs : typeArgSymbols;
                        var returnType = ResolveImportedGenericReturnType(resolution.Best, typeArgSymbols)
                            ?? MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(resolution.Best, instSymbolicTypeArgs, effectiveReceiverType)
                            ?? ResolveInstanceReturnTypeFromReceiver(effectiveReceiverType, resolution.Best)
                            ?? MapClrMethodReturnType(resolution.Best);
                        var instParameters = resolution.Best.GetParameters();
                        var instMapping = resolution.ParameterMapping;
                        var instExpandedArgs = resolution.IsExpanded
                            ? overloads.ExpandParamsArguments(arguments, instParameters, ce, parameterMapping: instMapping)
                            : arguments;
                        var instDownstreamMapping = resolution.IsExpanded ? default : instMapping;

                        // Issue #1638: shared CLR call-argument-construction
                        // pipeline (interpolation rebind → handler args →
                        // delegate rebind → parameter conversions).
                        var instConvertedArgs = BuildResolvedClrCallArguments(
                            instExpandedArgs,
                            ce.Arguments,
                            instParameters,
                            instDownstreamMapping,
                            receiver,
                            ce.Location,
                            ce,
                            ClrCallDelegateRebindMode.Full,
                            out var instHandlerPrelude,
                            out var instUpdatedReceiver,
                            method: resolution.Best,
                            symbolicMethodTypeArgs: instTypeArgSymbolsForCall,
                            receiverType: effectiveReceiverType,
                            hasConversionReceiverTypeOverride: true,
                            conversionReceiverType: receiver?.Type);
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
        // Issue #1188: extension functions overload, so select the best
        // matching overload across all (receiver, name) candidates.
        if (TryBindExtensionFunctionOverload(receiver, methodName, arguments, ce, argumentNames, out var extResult))
        {
            return extResult;
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

        // Issue #2304: an imported interface (`ImportedTypeSymbol` whose
        // `ClrType.IsInterface` is true) implicitly derives from
        // `System.Object` for member-access purposes. `Type.GetMethods()` on
        // an interface type never reports Object's members (only the
        // interface's own transitive base interfaces are walked above), so
        // ToString/GetHashCode/Equals/GetType otherwise dead-end here. Run
        // AFTER every instance/extension lookup so a same-named member still
        // wins.
        if (clrType is { IsInterface: true }
            && TryBindInterfaceObjectMemberCall(receiver, methodName, arguments, ce, argumentNames, out var importedIfaceObjectCall))
        {
            return importedIfaceObjectCall;
        }

        Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
        return new BoundErrorExpression(null);
    }

    /// <summary>
    /// Issue #2193: returns <see langword="true"/> when a user-defined extension
    /// function for the <c>(receiver, name)</c> pair declares a function-typed
    /// (arrow / delegate) parameter at the given user-argument position. The
    /// extension's synthetic receiver occupies <c>Parameters[0]</c>, so user
    /// argument <paramref name="argSlot"/> aligns with <c>Parameters[argSlot + 1]</c>.
    /// Used to suppress CLR-derived lambda target-typing that would otherwise
    /// erase the lambda's return type and break the extension's type-argument
    /// inference.
    /// </summary>
    private bool UserExtensionHasFunctionTypedParameterAt(BoundExpression receiver, string methodName, int argSlot)
    {
        if (receiver?.Type == null)
        {
            return false;
        }

        var extCandidates = scope.TryLookupExtensionFunctions(receiver.Type, methodName);
        if (extCandidates.IsDefaultOrEmpty)
        {
            return false;
        }

        var paramIndex = argSlot + 1;
        foreach (var candidate in extCandidates)
        {
            if (candidate != null
                && paramIndex < candidate.Parameters.Length
                && candidate.Parameters[paramIndex].Type is FunctionTypeSymbol)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #2193: overload-resolution tie-break that merges the user-defined
    /// extension-function candidate set for <c>(receiver type, name)</c> into a
    /// resolved CLR/imported instance-method call and prefers the extension when
    /// it is a strictly better match.
    /// <para>
    /// The defect: a same-named BCL instance method can be <em>applicable</em> to
    /// a call only through a lossy delegate-reshaping conversion — e.g. a G#
    /// function value <c>(T) -&gt; TResult</c> discarding its result to satisfy the
    /// named void delegate parameter of
    /// <c>SynchronizationContext.Send(SendOrPostCallback, object)</c>. Because the
    /// CLR-instance path commits as soon as it resolves, the user extension
    /// <c>Send[T, TResult]((T) -&gt; TResult, T) TResult</c> — an exact match — never
    /// competed, so the call bound to the <c>void</c> member (GS0124 / GS0151).
    /// </para>
    /// <para>
    /// The fix is deliberately conservative so it does not disturb normal
    /// instance-method resolution: the extension is only preferred when (a) the
    /// resolved instance method's <em>worst</em> argument conversion is a
    /// delegate-reshaping conversion (rank ≥
    /// <see cref="OverloadResolution.ImplicitConversionKind.LambdaToVoidDelegate"/>),
    /// and (b) some applicable user extension matches the same arguments with a
    /// strictly better worst-case conversion. An instance method that matches by
    /// identity / standard implicit conversion always wins, so a genuine member
    /// that is the better match is never shadowed.
    /// </para>
    /// </summary>
    private bool TryPreferBetterExtensionOverClrInstanceMethod(
        BoundExpression receiver,
        string methodName,
        MethodInfo clrBest,
        Type[] argTypes,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        out BoundExpression result)
    {
        result = null;
        if (receiver?.Type == null || clrBest == null || argTypes == null)
        {
            return false;
        }

        var extCandidates = scope.TryLookupExtensionFunctions(receiver.Type, methodName);
        if (extCandidates.IsDefaultOrEmpty)
        {
            return false;
        }

        // Only intervene when the CLR instance method is applicable solely via a
        // lossy delegate-reshaping conversion; a good (identity/standard implicit)
        // instance match is never overridden.
        var clrWorst = ComputeClrCandidateWorstConversionRank(clrBest, argTypes);
        if (!IsDelegateReshapingConversion(clrWorst))
        {
            return false;
        }

        // The extension must be a strictly better match than the instance method.
        var extWorst = ComputeBestApplicableExtensionWorstConversionRank(extCandidates, argTypes);
        if (extWorst == OverloadResolution.ImplicitConversionKind.None
            || (int)extWorst >= (int)clrWorst)
        {
            return false;
        }

        if (TryBindExtensionFunctionOverload(receiver, methodName, arguments, ce, argumentNames, out var extResult)
            && extResult is not BoundErrorExpression)
        {
            result = extResult;
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #2193: a delegate-reshaping implicit conversion (rank ≥
    /// <see cref="OverloadResolution.ImplicitConversionKind.LambdaToVoidDelegate"/>
    /// and ≤
    /// <see cref="OverloadResolution.ImplicitConversionKind.DelegateReturnNumericWidening"/>)
    /// reshapes a G# function value to satisfy a differently-shaped or
    /// differently-named CLR delegate parameter (discarding a return value,
    /// widening/covarying a return type, or retargeting to a named delegate).
    /// These are the "worst"-ranked conversions and are the loose applicability
    /// that lets a same-named BCL instance method shadow an exact user extension.
    /// </summary>
    private static bool IsDelegateReshapingConversion(OverloadResolution.ImplicitConversionKind kind)
    {
        return kind is OverloadResolution.ImplicitConversionKind.LambdaToVoidDelegate
            or OverloadResolution.ImplicitConversionKind.DelegateReturnCovariance
            or OverloadResolution.ImplicitConversionKind.DelegateStructuralMatch
            or OverloadResolution.ImplicitConversionKind.DelegateReturnNumericWidening;
    }

    /// <summary>
    /// Issue #2193: classifies each supplied argument against the corresponding
    /// parameter of a resolved CLR candidate and returns the <em>worst</em>
    /// (highest-ordinal) implicit-conversion rank across all arguments. Returns
    /// <see cref="OverloadResolution.ImplicitConversionKind.None"/> when the
    /// arities do not line up positionally (the candidate matched in an expanded
    /// / named / defaulted form this cheap check cannot reason about, so the
    /// tie-break is skipped and the instance method keeps winning).
    /// </summary>
    private static OverloadResolution.ImplicitConversionKind ComputeClrCandidateWorstConversionRank(MethodInfo candidate, Type[] argTypes)
    {
        var parameters = candidate.GetParameters();
        if (parameters.Length != argTypes.Length)
        {
            return OverloadResolution.ImplicitConversionKind.None;
        }

        var worst = OverloadResolution.ImplicitConversionKind.Identity;
        for (var i = 0; i < argTypes.Length; i++)
        {
            var kind = OverloadResolution.ClassifyImplicit(parameters[i].ParameterType, argTypes[i]);
            if (kind == OverloadResolution.ImplicitConversionKind.None)
            {
                return OverloadResolution.ImplicitConversionKind.None;
            }

            if ((int)kind > (int)worst)
            {
                worst = kind;
            }
        }

        return worst;
    }

    /// <summary>
    /// Issue #2193: across every user extension overload for the
    /// <c>(receiver, name)</c> pair, computes each applicable overload's worst
    /// argument-conversion rank (using the same CLR-type projection that produced
    /// <paramref name="argTypes"/>) and returns the <em>best</em> (lowest-ordinal)
    /// worst-rank. The extension's synthetic receiver slot lives in
    /// <c>Parameters[0]</c>, so user arguments align against <c>Parameters[1..]</c>.
    /// Returns <see cref="OverloadResolution.ImplicitConversionKind.None"/> when
    /// no overload lines up positionally with the arguments.
    /// </summary>
    private OverloadResolution.ImplicitConversionKind ComputeBestApplicableExtensionWorstConversionRank(
        ImmutableArray<FunctionSymbol> extCandidates,
        Type[] argTypes)
    {
        var best = OverloadResolution.ImplicitConversionKind.None;
        foreach (var candidate in extCandidates)
        {
            if (candidate == null || candidate.Parameters.Length != argTypes.Length + 1)
            {
                continue;
            }

            var worst = OverloadResolution.ImplicitConversionKind.Identity;
            var applicable = true;
            for (var i = 0; i < argTypes.Length; i++)
            {
                var paramClr = GetEffectiveArgumentClrTypeForOverloadResolution(candidate.Parameters[i + 1].Type);
                var kind = OverloadResolution.ClassifyImplicit(paramClr, argTypes[i]);
                if (kind == OverloadResolution.ImplicitConversionKind.None)
                {
                    applicable = false;
                    break;
                }

                if ((int)kind > (int)worst)
                {
                    worst = kind;
                }
            }

            if (!applicable)
            {
                continue;
            }

            if (best == OverloadResolution.ImplicitConversionKind.None || (int)worst < (int)best)
            {
                best = worst;
            }
        }

        return best;
    }

    /// <summary>
    /// Issue #1188: resolves an instance-syntax call <c>receiver.Method(args)</c>
    /// against the user-defined extension functions visible from the current
    /// scope, supporting overloading. Collects every extension overload matching
    /// the (receiver type, name) pair and selects the single best applicable one
    /// through the standard overload-resolution machinery before delegating to
    /// <see cref="OverloadResolver.BindExtensionFunctionCall"/>.
    /// </summary>
    /// <remarks>
    /// Extension function symbols carry their receiver in <c>Parameters[0]</c> and
    /// never set <see cref="FunctionSymbol.ExplicitReceiverParameter"/>, so user
    /// arguments line up against <c>Parameters[1..]</c>. To reuse the existing
    /// instance-overload selector (which keys parameter alignment off
    /// <c>ExplicitReceiverParameter</c>) the receiver is prepended as the first
    /// positional argument; this makes the candidate's synthetic receiver slot
    /// participate in applicability/convertibility ranking and in generic receiver
    /// inference exactly as <see cref="OverloadResolver.BindExtensionFunctionCall"/>
    /// does once a candidate is chosen.
    /// </remarks>
    /// <param name="receiver">The bound call receiver.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The bound user arguments (excluding the receiver).</param>
    /// <param name="ce">The originating call syntax.</param>
    /// <param name="argumentNames">The named-argument layout, or default.</param>
    /// <param name="result">The bound call, when an extension overload matched.</param>
    /// <returns><see langword="true"/> when at least one extension overload matched the (receiver, name) pair.</returns>
    private bool TryBindExtensionFunctionOverload(
        BoundExpression receiver,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        out BoundExpression result)
    {
        result = null;
        if (receiver == null)
        {
            return false;
        }

        var candidates = scope.TryLookupExtensionFunctions(receiver.Type, methodName);
        if (candidates.IsDefaultOrEmpty)
        {
            return false;
        }

        var selected = candidates[0];
        if (candidates.Length > 1)
        {
            var allArguments = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length + 1);
            allArguments.Add(receiver);
            allArguments.AddRange(arguments);

            var allNames = argumentNames;
            if (!argumentNames.IsDefault)
            {
                var namesBuilder = ImmutableArray.CreateBuilder<string>(argumentNames.Length + 1);
                namesBuilder.Add(null);
                namesBuilder.AddRange(argumentNames);
                allNames = namesBuilder.ToImmutable();
            }

            selected = overloads.SelectInstanceOverloadOrReport(candidates, allArguments.ToImmutable(), ce, methodName, allNames);
            if (selected == null)
            {
                result = new BoundErrorExpression(null);
                return true;
            }
        }

        result = overloads.BindExtensionFunctionCall(receiver, selected, arguments, ce, argumentNames);
        return true;
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
            var hasVariadicErrors = false;

            // Issue #1823: route through the #1630 canonical helper so
            // trailing elements get the same per-element coercion applied
            // at every other variadic pack site (previously packed raw,
            // uncoerced elements here).
            permutedArgs = OverloadResolver.PackOrPassThroughVariadicArguments(
                conversions,
                Diagnostics,
                ce,
                arguments,
                fldFixedCount,
                sliceType,
                methodName,
                i => i < ce.Arguments.Count ? ce.Arguments[i].Location : ce.Location,
                ref hasVariadicErrors);

            if (hasVariadicErrors)
            {
                result = new BoundErrorExpression(null);
                return true;
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
        var invoke = memberClrType.GetMethodSafe("Invoke");
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
        ImmutableArray<string> argumentNames = default,
        bool mapEnumArgumentsToBaseClr = false,
        bool allowProtectedInherited = false)
    {
        result = null;

        // Issue #2210: start from the public (+ self-interface DIM) candidates
        // this helper has always resolved, then union in any `protected` /
        // `protected internal` instance methods reachable from a derived G#
        // type — so a call like `OnPropertyChanged(...)` inherited from an
        // imported `protected` base method (e.g. CommunityToolkit.Mvvm's
        // ObservableObject) can resolve. Reuses the same accessibility filter
        // (public/Family/FamilyOrAssembly) already applied to
        // `base.Method(...)` calls (issue #1260).
        // Issue #2218 follow-up: this helper is shared by the general
        // qualified-accessor call path (any `receiver.Method(...)`, not just
        // `this.`/implicit-this), so a resolved `protected` candidate is only
        // actually usable when `allowProtectedInherited` is set by the
        // caller (i.e. it already verified `receiver` IS the current
        // implicit/explicit `this`). Otherwise `TryResolveAndBindClrInstanceCall`
        // below rejects the resolved protected candidate with a GS0379
        // accessibility diagnostic instead of silently binding it.
        var candidates = new List<MethodInfo>(MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(importedBaseClr, methodName));
        foreach (var protectedCandidate in CollectBaseClrMethodCandidates(importedBaseClr, methodName))
        {
            if (!MemberLookup.HasSameSignature(candidates, protectedCandidate))
            {
                candidates.Add(protectedCandidate);
            }
        }

        if (candidates.Count == 0)
        {
            return false;
        }

        return TryResolveAndBindClrInstanceCall(receiver, candidates, importedBaseClr, methodName, arguments, ce, out result, explicitTypeArgs, typeArgSymbols, argumentNames, mapEnumArgumentsToBaseClr, allowProtectedInherited: allowProtectedInherited);
    }

    /// <summary>
    /// Issue #1181: resolves an instance method call against the imported/BCL
    /// base interfaces of a user interface receiver. A user interface
    /// <c>interface IBox : IDisposable</c> has a null <c>ClrType</c>, so the
    /// regular imported-instance walks find nothing; this projects every
    /// transitive imported base interface's public instance methods onto the
    /// receiver (matching how user-base-interface members are surfaced) and
    /// runs the shared overload resolution. The emitted
    /// <see cref="BoundImportedInstanceCallExpression"/> dispatches via
    /// <c>callvirt</c> on the imported interface method, which is verifiable
    /// because <c>IBox</c> carries an InterfaceImpl row to each imported base.
    /// Runs only after user member-table lookup fails, so user-declared
    /// interface members keep priority.
    /// </summary>
    /// <param name="receiver">The interface-typed receiver expression.</param>
    /// <param name="interfaceSymbol">The user interface symbol of the receiver.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The bound call arguments.</param>
    /// <param name="ce">The call syntax (for diagnostics/locations).</param>
    /// <param name="result">The bound call on success, or an error node on ambiguity.</param>
    /// <param name="explicitTypeArgs">Explicit CLR type arguments, when present.</param>
    /// <param name="typeArgSymbols">Explicit symbolic type arguments, when present.</param>
    /// <param name="argumentNames">Named-argument labels, when present.</param>
    /// <returns>True when the call resolved (or reported a precise ambiguity).</returns>
    internal bool TryBindInterfaceImportedBaseInstanceCall(
        BoundExpression receiver,
        InterfaceSymbol interfaceSymbol,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        out BoundExpression result,
        System.Type[] explicitTypeArgs = null,
        ImmutableArray<TypeSymbol> typeArgSymbols = default,
        ImmutableArray<string> argumentNames = default)
    {
        result = null;

        var clrBases = MemberLookup.GetTransitiveClrBaseInterfaces(interfaceSymbol);
        if (clrBases.Count == 0)
        {
            return false;
        }

        var candidates = new List<MethodInfo>();
        foreach (var clrBase in clrBases)
        {
            foreach (var m in ClrTypeUtilities.SafeGetMethods(clrBase, BindingFlags.Instance | BindingFlags.Public))
            {
                if (string.Equals(m.Name, methodName, System.StringComparison.Ordinal)
                    && !MemberLookup.HasSameSignature(candidates, m))
                {
                    candidates.Add(m);
                }
            }
        }

        if (candidates.Count == 0)
        {
            return false;
        }

        return TryResolveAndBindClrInstanceCall(receiver, candidates, importedBaseClr: clrBases[0], methodName, arguments, ce, out result, explicitTypeArgs, typeArgSymbols, argumentNames);
    }

    /// <summary>
    /// Issue #296 / #1181: shared overload-resolution + bound-call construction
    /// core for an imported-instance method call against a pre-collected
    /// <paramref name="candidates"/> set. Factored out of
    /// <see cref="TryBindInheritedClrInstanceCall"/> so the inherited-base-class
    /// path and the user-interface imported-base path share one implementation.
    /// </summary>
    /// <param name="receiver">The receiver expression.</param>
    /// <param name="candidates">The candidate CLR methods.</param>
    /// <param name="importedBaseClr">A representative CLR type for named-argument diagnostics.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The bound call arguments.</param>
    /// <param name="ce">The call syntax.</param>
    /// <param name="result">The bound call on success.</param>
    /// <param name="explicitTypeArgs">Explicit CLR type arguments, when present.</param>
    /// <param name="typeArgSymbols">Explicit symbolic type arguments, when present.</param>
    /// <param name="argumentNames">Named-argument labels, when present.</param>
    /// <param name="mapEnumArgumentsToBaseClr">When <see langword="true"/>, enum-typed arguments resolve as the inherited base CLR type (<c>System.Enum</c>) instead of their erased underlying primitive, so members such as <c>HasFlag(System.Enum)</c> match.</param>
    /// <param name="nonVirtualBaseCall">Issue #1260: when <see langword="true"/>, the resolved call is a <c>base.M(...)</c> access into an imported/BCL base and is flagged so the emitter writes a non-virtual <c>call</c>; an <c>abstract</c> best match is reported as GS0413.</param>
    /// <param name="baseMemberLocation">Issue #1260: the location of the member identifier for the GS0413 abstract-base diagnostic (used only when <paramref name="nonVirtualBaseCall"/> is set).</param>
    /// <param name="allowProtectedInherited">Issue #2218 follow-up: when <see langword="false"/>, a resolved <c>protected</c>/<c>protected internal</c> candidate is rejected with a GS0379 accessibility diagnostic instead of being bound. Defaults to <see langword="true"/> for the <c>base.M(...)</c> and user-interface imported-base callers, which never surface a protected candidate they aren't entitled to call.</param>
    /// <returns>True when the call resolved (or reported a precise ambiguity).</returns>
    private bool TryResolveAndBindClrInstanceCall(
        BoundExpression receiver,
        IReadOnlyList<MethodInfo> candidates,
        System.Type importedBaseClr,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        out BoundExpression result,
        System.Type[] explicitTypeArgs,
        ImmutableArray<TypeSymbol> typeArgSymbols,
        ImmutableArray<string> argumentNames,
        bool mapEnumArgumentsToBaseClr = false,
        bool nonVirtualBaseCall = false,
        TextLocation? baseMemberLocation = null,
        bool allowProtectedInherited = true)
    {
        result = null;

        var argTypes = new System.Type[arguments.Length];
        var hasUserClassArg = false;
        for (var i = 0; i < arguments.Length; i++)
        {
            // Issue #1218: when resolving an inherited call against System.Enum
            // (e.g. HasFlag(System.Enum)), an enum-typed argument is the boxed
            // System.Enum the parameter expects. The default mapping erases an
            // enum to its underlying int32 (issue #661), which would not match a
            // System.Enum parameter, so map it to the base CLR type instead.
            if (mapEnumArgumentsToBaseClr && arguments[i].Type is EnumSymbol)
            {
                argTypes[i] = importedBaseClr;
                continue;
            }

            // Issue #530: use GetEffectiveArgumentClrType (see instance method path).
            // Issue #533: allow null (nil literal) through.
            // Issue #658: use overload-resolution variant for user classes.
            var t = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type);
            if (t == null && arguments[i].Type != TypeSymbol.Null)
            {
                // Issue #2347: defer an unresolved method-group argument (see
                // TryBindImportedExtensionCall) instead of failing outright;
                // BindClrParameterConversions resolves it once the candidate
                // (and its parameter type) is known.
                if (!OverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]))
                {
                    return false;
                }
            }

            if (arguments[i].Type is StructSymbol { IsClass: true })
            {
                hasUserClassArg = true;
            }

            argTypes[i] = t;
        }

        // Issue #658 / #1634: supplementary interface check for user-class args,
        // threaded as a call-local parameter into Resolve instead of a shared
        // static so nested/concurrent binds can't clobber it.
        Func<Type, Type, bool> supplementaryInterfaceCheck = hasUserClassArg
            ? (source, target) => IsUserClassAssignableToInterfaceFromArgs(arguments, argTypes, source, target)
            : null;

        var resolution = OverloadResolution.Resolve(
            candidates,
            argTypes,
            explicitTypeArgs,
            scope.References.MapClrTypeToReferences,
            ComputeInterpolatedStringArgFlags(ce.Arguments, arguments.Length),
            argumentNames: argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames,
            supplementaryInterfaceCheck: supplementaryInterfaceCheck,
            constantNarrowingArgumentCheck: MakeConstantNarrowingArgumentCheck(arguments));

        switch (resolution.Outcome)
        {
            case OverloadResolution.ResolutionOutcome.Resolved:
                // Issue #1260: a `base.M(...)` into an abstract BCL member has no
                // base implementation to delegate to (e.g. Stream.Read). Match C#
                // (CS0205) with a clean diagnostic instead of emitting invalid IL.
                if (nonVirtualBaseCall && resolution.Best.IsAbstract)
                {
                    Diagnostics.ReportBaseClassCallAbstractMember(baseMemberLocation ?? ce.Location, importedBaseClr?.Name ?? "object", methodName);
                    result = new BoundErrorExpression(null);
                    return true;
                }

                // Issue #2218 follow-up: the candidate set unioned in by
                // TryBindInheritedClrInstanceCall (issue #2210) may include a
                // `protected`/`protected internal` member reachable only via
                // `base.M(...)` (always legitimate — see nonVirtualBaseCall)
                // or the current implicit/explicit `this` (only when the
                // caller passed `allowProtectedInherited: true`). Any other
                // qualified `receiver.Method(...)` call resolving to such a
                // member is an accessibility violation: report the same GS0379
                // diagnostic G# already uses for a protected member accessed
                // from outside its declaring/derived type, instead of
                // silently binding it.
                if (!allowProtectedInherited && !nonVirtualBaseCall
                    && !resolution.Best.IsPublic && (resolution.Best.IsFamily || resolution.Best.IsFamilyOrAssembly))
                {
                    Diagnostics.ReportProtectedMemberInaccessible(ce.Identifier.Location, methodName, ClrTypeDisplayName(resolution.Best.DeclaringType ?? importedBaseClr));
                    result = new BoundErrorExpression(null);
                    return true;
                }

                // Issue #1512: an instance method (incl. one inherited from an
                // imported generic base) excludes the receiver from its formal
                // parameter list, so the method-type-argument inference vector must
                // not carry the receiver as slot 0 — otherwise lambda-only-inferable
                // method type parameters never unify and erase to `<object>`.
                var inheritedSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(null, ImmutableArray.CreateRange(arguments.Select(a => a?.Type)));
                var inheritedSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(resolution.Best, typeArgSymbols, inheritedSymbolicArgs);
                var inheritedTypeArgSymbolsForCall = !inheritedSymbolicTypeArgs.IsDefault ? inheritedSymbolicTypeArgs : typeArgSymbols;
                var returnType = ResolveImportedGenericReturnType(resolution.Best, typeArgSymbols)
                    ?? MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(resolution.Best, inheritedSymbolicTypeArgs, receiver?.Type)
                    ?? ResolveInstanceReturnTypeFromReceiver(receiver?.Type, resolution.Best)
                    ?? MapClrMethodReturnType(resolution.Best);
                var inheritedParameters = resolution.Best.GetParameters();
                var inheritedMapping = resolution.ParameterMapping;
                var inheritedExpandedArgs = resolution.IsExpanded
                    ? overloads.ExpandParamsArguments(arguments, inheritedParameters, ce, parameterMapping: inheritedMapping)
                    : arguments;
                var inheritedDownstreamMapping = resolution.IsExpanded ? default : inheritedMapping;

                // Issue #1638: shared CLR call-argument-construction pipeline
                // (interpolation rebind → handler args → delegate rebind →
                // parameter conversions). Previously this inherited-instance
                // path skipped straight to handler args, so an interpolated
                // string argument targeting an IFormattable/FormattableString
                // parameter of an inherited (base-class) member was never
                // re-lowered to FormattableStringFactory.Create(...).
                var inheritedConvertedArgs = BuildResolvedClrCallArguments(
                    inheritedExpandedArgs,
                    ce.Arguments,
                    inheritedParameters,
                    inheritedDownstreamMapping,
                    receiver,
                    ce.Location,
                    ce,
                    ClrCallDelegateRebindMode.Full,
                    out var inheritedHandlerPrelude,
                    out var inheritedUpdatedReceiver,
                    method: resolution.Best,
                    symbolicMethodTypeArgs: inheritedTypeArgSymbolsForCall,
                    receiverType: receiver?.Type);
                var inheritedArguments = OverloadResolver.BuildOrderedCallArguments(inheritedConvertedArgs, inheritedDownstreamMapping, inheritedParameters);
                var refKinds = ComputeArgumentRefKinds(inheritedParameters);
                overloads.ValidateRefArguments(inheritedArguments, refKinds, methodName, ce.Location);
                BoundExpression inheritedCall = new BoundImportedInstanceCallExpression(null, inheritedUpdatedReceiver ?? receiver, resolution.Best, returnType, inheritedArguments, refKinds, inheritedTypeArgSymbolsForCall, isNonVirtualBaseCall: nonVirtualBaseCall);
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
            var hasVariadicErrors = false;

            // Issue #1823: route through the #1630 canonical helper so
            // trailing elements get the same per-element coercion applied
            // at every other variadic pack site (previously packed raw,
            // uncoerced elements here).
            permutedArgs = OverloadResolver.PackOrPassThroughVariadicArguments(
                conversions,
                Diagnostics,
                ce,
                arguments,
                fixedParamCount,
                sliceType,
                variadicParam.Name,
                i => i < ce.Arguments.Count ? ce.Arguments[i].Location : ce.Location,
                ref hasVariadicErrors);

            if (hasVariadicErrors)
            {
                return new BoundErrorExpression(null);
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

        // Issue #1423: a user class that implements a generic collection
        // interface (e.g. `class EntryList : IReadOnlyCollection[Entry]`, which
        // extends `IEnumerable[Entry]`) erases to `System.Object` via
        // TryProjectErasedClrType (it has no imported base class), so an
        // extension method whose `this` self-parameter is `IEnumerable<TSource>`
        // (LINQ Where/Select/OrderBy/…) cannot match the receiver and TSource
        // cannot be inferred. Project the receiver to the most-derived
        // implemented CLR interface instead so overload resolution sees the
        // collection element type; the bound receiver expression is unchanged.
        if (receiver.Type is StructSymbol { IsClass: true } userReceiverClass
            && (receiverClrType == null || receiverClrType.IsSameAs(typeof(object)))
            && TryProjectUserClassReceiverInterface(userReceiverClass, out var receiverIface))
        {
            receiverClrType = receiverIface;
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
                // Issue #2347: a bare method group passed as a generic
                // extension-method argument (e.g. `key.All(Char.IsAsciiHexDigit)`)
                // has no fixed CLR type until the extension candidate's target
                // delegate parameter is known — defer it exactly like an
                // untyped lambda (leave the argTypes slot null so generic
                // inference/applicability resolve TSource from the receiver
                // and the other arguments) instead of failing the whole
                // extension-call candidate. It is resolved against the
                // winning candidate's (possibly generic-inferred) parameter
                // type afterwards by BindClrParameterConversions.
                if (!OverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]))
                {
                    // Issue #833: argument may carry an open TP (e.g. `T`,
                    // `[]T`). Project to an erased shape so resolution can run.
                    if (!MemberLookup.TryProjectErasedClrType(arguments[i].Type, out t))
                    {
                        return false;
                    }
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
        // Issue #658 / #1634: supplementary interface check for user-class args,
        // threaded as a call-local parameter into Resolve instead of a shared
        // static so nested/concurrent binds can't clobber it.
        Func<Type, Type, bool> supplementaryInterfaceCheck = hasUserClassArg
            ? (source, target) => IsUserClassAssignableToInterfaceFromArgs(arguments, argTypes, source, target)
            : null;

        // Issue #1311: imported extension calls dispatch as
        // `Class.Method(this receiver, args…)`, so argTypes slot 0 is the
        // receiver and user argument `i` lives at slot `i + 1`.
        // Issue #1812: mirror the flag every other CLR-call path already passes
        // — an interpolated-string argument to an extension method's
        // IFormattable/FormattableString (or handler) parameter must resolve
        // consistently with the instance/inherited/static/ctor paths. Offset by
        // 1 (receiverArgCount) since slot 0 here is the receiver, not a
        // user-supplied argument.
        var resolution = OverloadResolution.Resolve(
            candidates,
            argTypes,
            explicitTypeArgs,
            scope.References.MapClrTypeToReferences,
            ComputeInterpolatedStringArgFlags(ce.Arguments, argTypes.Length, receiverArgCount: 1),
            argumentNames: extensionArgumentNames,
            supplementaryInterfaceCheck: supplementaryInterfaceCheck,
            constantNarrowingArgumentCheck: MakeConstantNarrowingArgumentCheck(arguments, argumentOffset: 1));

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

        var importedClass = new ImportedClassSymbol(declaringType, ce, references: scope.References);

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

        // Issue #1638: shared CLR call-argument-construction pipeline
        // (interpolation rebind → handler args → delegate rebind →
        // parameter conversions). The receiver occupies bound[0] /
        // parameters[0] (receiverArgCount: 1), so both the interpolation
        // rebind and handler-args steps must skip that synthesised slot
        // (it has no source syntax and, per the extension-call ADR, no
        // separate BoundExpression that needs updating outside `bound`).
        //
        // Issue #1150: the delegate-rebind step deliberately narrows to
        // ONLY numeric-return-widening (rather than the full erasing
        // rebind used by ctor/static/instance/inherited dispatch): a full
        // erasing rebind of a non-numeric-widening func/arrow literal
        // would erase the produced delegate to the generic LINQ method's
        // type-erased shape (e.g. `Func<object,object>`) while the call
        // site re-closes the generic method over the real (symbolic) type
        // argument — see Issue #1334 for the ilverify StackUnexpected
        // mismatch this narrowing avoids.
        //
        // Issue #506 follow-up: still routes through BindClrParameterConversions
        // so value-type → object boxing fires for fixed-arity imported
        // extension calls too.
        bound = BuildResolvedClrCallArguments(
            bound,
            ce.Arguments,
            parameters,
            downstreamMapping,
            receiver,
            ce.Location,
            ce,
            ClrCallDelegateRebindMode.NumericWideningOnly,
            out var extensionHandlerPrelude,
            out var extensionUpdatedReceiver,
            receiverArgCount: 1);
        if (extensionUpdatedReceiver != null && extensionUpdatedReceiver != receiver)
        {
            bound = bound.SetItem(0, extensionUpdatedReceiver);
        }

        // Issue #327 / #343: re-order arguments into parameter positions when
        // named arguments were used; otherwise fall through to the existing
        // trailing-optional fill.
        bound = OverloadResolver.BuildOrderedCallArguments(bound, downstreamMapping, parameters);

        var refKinds = ComputeArgumentRefKinds(parameters);
        overloads.ValidateRefArguments(bound, refKinds, methodName, ce.Location);
        result = WrapWithHandlerPrelude(new BoundImportedCallExpression(null, function, bound, refKinds, extensionTypeArgSymbolsForCall), extensionHandlerPrelude, ce);
        return true;
    }

    /// <summary>
    /// Issue #1423: projects a user-declared class to the implemented CLR
    /// interface best suited to drive extension-method receiver matching and
    /// generic inference. Prefers an implemented interface that is, or extends,
    /// <c>IEnumerable&lt;T&gt;</c> (so LINQ-style extensions whose <c>this</c>
    /// self-parameter is <c>IEnumerable&lt;TSource&gt;</c> bind and infer
    /// <c>TSource</c>), choosing the most-derived such interface so any
    /// methods declared on the richer interface remain reachable. Falls back to
    /// the first implemented CLR interface so non-collection extensions can
    /// still match an interface receiver.
    /// </summary>
    /// <param name="userClass">The user-declared class receiver.</param>
    /// <param name="clrInterface">The projected CLR interface type, on success.</param>
    /// <returns><see langword="true"/> when an implemented CLR interface was found.</returns>
    private static bool TryProjectUserClassReceiverInterface(StructSymbol userClass, out Type clrInterface)
    {
        clrInterface = null;
        if (userClass.ImplementedClrInterfaces.IsDefaultOrEmpty)
        {
            return false;
        }

        Type firstInterface = null;
        Type bestEnumerable = null;
        foreach (var implemented in userClass.ImplementedClrInterfaces)
        {
            var clr = implemented?.ClrType;
            if (clr == null || !clr.IsInterface)
            {
                continue;
            }

            firstInterface ??= clr;

            // A generic collection interface (IReadOnlyCollection<T>,
            // ICollection<T>, IList<T>, IEnumerable<T>, …) exposes
            // IEnumerable<T> through its base interfaces, letting overload
            // resolution recover the element type. Prefer the most-derived
            // such interface (the one whose interface set is largest).
            if (ImplementsGenericEnumerable(clr)
                && (bestEnumerable == null
                    || SafeInterfaceCount(clr) > SafeInterfaceCount(bestEnumerable)))
            {
                bestEnumerable = clr;
            }
        }

        clrInterface = bestEnumerable ?? firstInterface;
        return clrInterface != null;
    }

    private static bool ImplementsGenericEnumerable(Type clr)
    {
        if (clr.IsGenericType && clr.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IEnumerable`1")
        {
            return true;
        }

        try
        {
            foreach (var iface in clr.GetInterfaces())
            {
                if (iface.IsGenericType && iface.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IEnumerable`1")
                {
                    return true;
                }
            }
        }
        catch (Exception)
        {
            // Cross-context (MLC) types may throw on GetInterfaces(); ignore.
        }

        return false;
    }

    private static int SafeInterfaceCount(Type clr)
    {
        try
        {
            return clr.GetInterfaces().Length;
        }
        catch (Exception)
        {
            return 0;
        }
    }

    /// <summary>
    /// Issue #1638: selects which delegate-argument rebind step
    /// <see cref="BuildResolvedClrCallArguments"/> runs between the
    /// interpolated-string-handler pass and the CLR parameter-conversion
    /// pass.
    /// </summary>
    private enum ClrCallDelegateRebindMode
    {
        /// <summary>Full erasing rebind (<see cref="RebindFunctionLiteralDelegateArguments"/>): used by ctor/static/instance/inherited dispatch.</summary>
        Full,

        /// <summary>
        /// Issue #1150 / #1334: numeric-return-widening-only rebind
        /// (<see cref="RebindNumericReturnWideningDelegateArguments"/>).
        /// Imported EXTENSION dispatch deliberately narrows to this subset:
        /// a full erasing rebind of a non-numeric-widening literal would
        /// erase the delegate to the generic LINQ method's type-erased
        /// shape (e.g. <c>Func&lt;object,object&gt;</c>) while the call site
        /// re-closes the generic method over the real (symbolic) type
        /// argument, producing an ilverify StackUnexpected mismatch.
        /// </summary>
        NumericWideningOnly,
    }

    /// <summary>
    /// Issue #1638: the shared post-overload-resolution CLR call-argument
    /// construction pipeline — <c>RebindFormattableInterpolationArguments →
    /// ApplyInterpolatedStringHandlers → (delegate rebind) →
    /// BindClrParameterConversions</c> — used by every resolved CLR call
    /// dispatch (ctor, static, instance, inherited-instance, extension).
    /// Centralising the sequence keeps a fix applied once (e.g. a step
    /// re-ordering or a missing step) from drifting out of sync across the
    /// five call sites.
    ///
    /// <c>argumentSyntax</c> is the call's source argument syntax list, used
    /// to detect interpolated-string arguments; it does NOT include a slot
    /// for a synthesised receiver. <c>delegateRebindMode</c> selects which
    /// delegate-argument rebind step runs; see
    /// <see cref="ClrCallDelegateRebindMode"/>. <c>receiverType</c> is passed
    /// to the delegate-rebind step's symbolic-target lookup. Issue
    /// #1512/#1320: <c>conversionReceiverType</c> is the receiver type passed
    /// to <see cref="ConversionClassifier.BindClrParameterConversions"/>
    /// instead — the instance-call path deliberately feeds the delegate
    /// rebind the enumerable-normalized receiver type while feeding the
    /// parameter-conversion pass the raw (un-normalized) receiver type, so
    /// this can differ from <c>receiverType</c>; defaults to it via
    /// <c>hasConversionReceiverTypeOverride</c> when not overridden.
    /// <c>receiverArgCount</c> is the number of leading argument/parameter
    /// slots reserved for a synthesised receiver (0 for plain calls, 1 for
    /// imported extension calls).
    /// </summary>
    private ImmutableArray<BoundExpression> BuildResolvedClrCallArguments(
        ImmutableArray<BoundExpression> arguments,
        SeparatedSyntaxList<ExpressionSyntax> argumentSyntax,
        ParameterInfo[] parameters,
        ImmutableArray<int> parameterMapping,
        BoundExpression receiver,
        TextLocation location,
        CallExpressionSyntax call,
        ClrCallDelegateRebindMode delegateRebindMode,
        out ImmutableArray<BoundStatement> preludeStatements,
        out BoundExpression updatedReceiver,
        MethodInfo method = null,
        ImmutableArray<TypeSymbol> symbolicMethodTypeArgs = default,
        TypeSymbol receiverType = null,
        bool hasConversionReceiverTypeOverride = false,
        TypeSymbol conversionReceiverType = null,
        int receiverArgCount = 0)
    {
        var rebound = RebindFormattableInterpolationArguments(arguments, argumentSyntax, parameters, parameterMapping, receiverArgCount);
        var handlerArgs = ApplyInterpolatedStringHandlers(parameters, rebound, receiver, location, parameterMapping, out preludeStatements, out updatedReceiver);
        var delegateArgs = delegateRebindMode == ClrCallDelegateRebindMode.Full
            ? RebindFunctionLiteralDelegateArguments(handlerArgs, parameters, parameterMapping, method, symbolicMethodTypeArgs, receiverType)
            : RebindNumericReturnWideningDelegateArguments(handlerArgs, parameters, parameterMapping);
        var effectiveConversionReceiverType = hasConversionReceiverTypeOverride ? conversionReceiverType : receiverType;
        return conversions.BindClrParameterConversions(delegateArgs, parameters, call, parameterMapping, receiverArgCount, method, effectiveConversionReceiverType, symbolicMethodTypeArgs);
    }

    private ImmutableArray<BoundExpression> RebindFunctionLiteralDelegateArguments(
        ImmutableArray<BoundExpression> arguments,
        ParameterInfo[] parameters,
        ImmutableArray<int> parameterMapping = default,
        MethodInfo method = null,
        ImmutableArray<TypeSymbol> symbolicMethodTypeArgs = default,
        TypeSymbol receiverType = null)
    {
        ImmutableArray<BoundExpression>.Builder builder = null;
        for (var i = 0; i < arguments.Length; i++)
        {
            var paramIndex = parameterMapping.IsDefault ? i : parameterMapping[i];
            var argument = arguments[i];
            var rebound = argument;
            if (paramIndex < parameters.Length
                && LambdaBinder.TryGetFunctionLiteral(argument, out var literal)
                && MemberLookup.TryGetLambdaTargetFunctionType(parameters[paramIndex].ParameterType, out var targetFunctionType)
                && literal.FunctionType != targetFunctionType)
            {
                // Issue #1512: when the call is a generic method whose delegate
                // parameter mentions a method type parameter, the closed CLR
                // parameter type erases that slot to `object`, so the literal
                // would be rebound to e.g. `(Task) -> object` and emit a
                // `Func<Task,object>` delegate where `Func<Task,T>` is required.
                // Prefer the symbolic delegate target recovered from the OPEN
                // method parameter substituted with the inferred symbolic method
                // type arguments — including when it already equals the literal's
                // bound function type, so the erasing rebind below is skipped.
                if (TryBuildSymbolicDelegateTargetForMethodParam(method, paramIndex, symbolicMethodTypeArgs, receiverType, out var symbolicTarget))
                {
                    targetFunctionType = symbolicTarget;
                }
                else if (TypeSymbol.ContainsTypeParameter(literal.FunctionType) || TypeSymbol.ContainsSameCompilationUserType(literal.FunctionType))
                {
                    // Issue #1502 (ctor path): no method-generic recovery applies
                    // (this is a constructor call, or a non-generic/erasure-free
                    // method), yet the literal's bound function type already
                    // carries a type parameter or same-compilation user type —
                    // e.g. a `Lazy[T](() -> v)` ctor argument pre-bound against
                    // the OPEN ctor's symbolic delegate shape by
                    // TryResolveSymbolicDelegateTargetForCtor. The CLR parameter
                    // type here is only the erased placeholder shape (type
                    // parameters closed with `object`); re-erasing the
                    // already-correct symbolic literal below would downgrade
                    // `Func<T>` back to `Func<object>` and produce an
                    // unverifiable delegate. Keep the literal's existing
                    // (already symbolic) function type instead of erasing it.
                    targetFunctionType = literal.FunctionType;
                }

                if (literal.FunctionType != targetFunctionType)
                {
                    rebound = lambdas.CreateErasedFunctionLiteralAdapter(literal, targetFunctionType);
                }
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

    // Issue #1150: reshape only those func/arrow literal arguments whose natural
    // numeric return type implicitly, losslessly widens to the corresponding
    // delegate parameter's return type. The reshape routes through the erased
    // adapter (the established pattern for generic-LINQ dispatch), inserting the
    // numeric return-widening conversion in the body so the produced delegate's
    // return type matches the target. Literals whose return already matches the
    // target (the common LINQ case: Where/Single/Select with bool/string
    // selectors) are left completely untouched, preserving their natural
    // concrete delegate signature.
    //
    // Issue #1334: the widening gate is deliberately restricted to NUMERIC
    // (value-type primitive) return widening — matching the equivalent guard on
    // the BindConversion path. A non-numeric implicit widening (a reference
    // covariance, or a same-compilation user-type return widening to the
    // type-erased `object` of a generic LINQ projection such as
    // `Select<TSource, TResult>` where `TResult` is recovered symbolically) must
    // NOT be erased here: doing so materialised the lambda as `Func<object,
    // object>` while the call site re-closed `Select<Entry, Filter>`, producing
    // an ilverify StackUnexpected mismatch. Reference covariance is handled by
    // the CLR delegate's natural variance at emit, so leaving such literals at
    // their concrete delegate signature is both correct and verifiable.
    private ImmutableArray<BoundExpression> RebindNumericReturnWideningDelegateArguments(
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
                && literal.FunctionType is FunctionTypeSymbol literalFnType
                && literalFnType.ReturnType != TypeSymbol.Void
                && literalFnType.ReturnType != TypeSymbol.Error
                && MemberLookup.TryGetLambdaTargetFunctionType(parameters[paramIndex].ParameterType, out var targetFunctionType)
                && targetFunctionType.ReturnType != TypeSymbol.Void
                && targetFunctionType.ReturnType != TypeSymbol.Error
                && targetFunctionType.Arity == literalFnType.Arity
                && !ReferenceEquals(literalFnType.ReturnType, targetFunctionType.ReturnType)
                && ConversionClassifier.IsNumericReturnWidening(literalFnType.ReturnType, targetFunctionType.ReturnType))
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
    /// <c>supplementaryInterfaceCheck</c> argument to
    /// <see cref="OverloadResolution.Resolve{T}"/> during overload resolution for
    /// calls that include user-class arguments.
    /// </summary>
    private static bool IsUserClassAssignableToInterface(
        ImmutableArray<BoundExpression>.Builder boundArguments,
        System.Type[] argTypes,
        System.Type source,
        System.Type target)
    {
        for (var i = 0; i < boundArguments.Count; i++)
        {
            if (!ClrTypeUtilities.AreSame(argTypes[i], source))
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
            if (!ClrTypeUtilities.AreSame(argTypes[i], source))
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

        // Issue #1104: the parenthesis-less PROPERTY form `base[BaseClass].Prop`
        // (read) and `base[BaseClass].Prop = value` (write). Route to the shared
        // base-class property read/write path with the explicit ancestor
        // selector so resolution + GS0383/GS0384/GS0385 diagnostics + non-virtual
        // `call instance ... <SelectorBase>::get_/set_Prop` emission all reuse
        // the same code as plain `base.Prop`. A base-class selector is required;
        // an interface selector in this position is not a supported form and is
        // reported via the member-not-found path below by falling through to the
        // call handling (which yields a clear diagnostic).
        if (syntax.IsPropertyAccess && ifaceType is StructSymbol propSelector && propSelector.IsClass)
        {
            if (syntax.IsPropertyWrite)
            {
                var boundValue = BindExpression(syntax.Value);
                return BindBaseClassPropertyWrite(
                    syntax.MethodIdentifier.Text,
                    syntax.MethodIdentifier.Location,
                    syntax.BaseKeyword.Location,
                    boundValue,
                    syntax.Value.Location,
                    syntax.EqualsToken.Location,
                    explicitBaseType: propSelector,
                    selectorLocation: syntax.InterfaceTypeClause.Location);
            }

            var memberName = new NameExpressionSyntax(syntax.SyntaxTree, syntax.MethodIdentifier);
            return BindBaseClassPropertyRead(
                memberName,
                syntax.BaseKeyword.Location,
                explicitBaseType: propSelector,
                selectorLocation: syntax.InterfaceTypeClause.Location);
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
        if (!TryResolveBaseSearchType(baseLocation, explicitBaseType, selectorLocation, out var searchBase, out var clrBaseFallback))
        {
            return new BoundErrorExpression(null);
        }

        var methodName = ce.Identifier.Text;

        // Resolve the overload set on the user base chain (this-first from the
        // search base), which walks grandparents — so the nearest user base
        // implementation of an inherited member is chosen.
        var baseOverloads = searchBase != null
            ? TypeMemberModel.GetMethods(searchBase, methodName, MemberQuery.Instance(MemberKinds.Method))
            : ImmutableArray<FunctionSymbol>.Empty;
        if (baseOverloads.IsEmpty)
        {
            // Issue #1260: no GSharp base declares the member (the class derives
            // directly from a BCL base, or the nearest user base does not declare
            // it). Fall back to the imported/BCL base type so `base.Dispose(...)`,
            // `base.ToString()`, etc. resolve and emit a non-virtual `call`.
            if (TryBindBaseClrInstanceCall(ce, methodName, clrBaseFallback, out var bclResult))
            {
                return bclResult;
            }

            Diagnostics.ReportBaseClassCallMemberNotFound(ce.Identifier.Location, searchBase?.Name ?? ClrTypeDisplayName(clrBaseFallback), methodName);
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
    /// Issue #1260: binds a <c>base.M(args)</c> call into an imported/BCL base
    /// class. Resolves the overload set against <paramref name="clrBase"/>
    /// (which walks the CLR base chain), runs the shared imported-instance
    /// overload resolution, and produces a
    /// <see cref="BoundImportedInstanceCallExpression"/> flagged as a non-virtual
    /// base call so the emitter writes <c>call</c> (not <c>callvirt</c>) — exactly
    /// like C# <c>base.M(...)</c>. A base call to an <c>abstract</c> BCL member
    /// (no implementation to delegate to) is reported as GS0413.
    /// </summary>
    /// <param name="ce">The method-call syntax.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="clrBase">The CLR base type to resolve the inherited member against.</param>
    /// <param name="result">The bound non-virtual base call (or an error node) when handled.</param>
    /// <returns><see langword="true"/> when the call resolved (or a precise diagnostic was reported); <see langword="false"/> when no candidate member exists.</returns>
    private bool TryBindBaseClrInstanceCall(
        CallExpressionSyntax ce,
        string methodName,
        System.Type clrBase,
        out BoundExpression result)
    {
        result = null;

        var candidates = CollectBaseClrMethodCandidates(clrBase, methodName);
        if (candidates.Count == 0)
        {
            return false;
        }

        if (!overloads.TryAnalyzeCallArgumentLayout(ce.Arguments, out _, out var argumentNames))
        {
            result = new BoundErrorExpression(null);
            return true;
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(ce.Arguments.Count);
        foreach (var argument in ce.Arguments)
        {
            boundArguments.Add(BindExpression(OverloadResolver.UnwrapNamedArgumentValue(argument)));
        }

        var arguments = boundArguments.ToImmutable();
        var receiver = new BoundVariableExpression(null, function.ThisParameter);
        return TryResolveAndBindClrInstanceCall(
            receiver,
            candidates,
            clrBase,
            methodName,
            arguments,
            ce,
            out result,
            explicitTypeArgs: null,
            typeArgSymbols: default,
            argumentNames: argumentNames,
            nonVirtualBaseCall: true,
            baseMemberLocation: ce.Identifier.Location);
    }

    /// <summary>Issue #1260: a readable display name for a CLR base type used in base-call member-not-found diagnostics.</summary>
    private static string ClrTypeDisplayName(System.Type clrType) => clrType?.Name ?? "object";

    /// <summary>
    /// Issue #1260: collects the candidate inherited CLR instance methods named
    /// <paramref name="methodName"/> that are reachable for a <c>base.M(...)</c>
    /// call against <paramref name="clrBase"/>. Unlike the ordinary inherited-CLR
    /// lookup (public only), a base call may target a <c>protected</c> virtual
    /// member (e.g. <c>System.IO.Stream.Dispose(bool)</c>), so this includes
    /// non-public methods but excludes members a derived type cannot legally
    /// call via <c>base</c> (<c>private</c>, and other-assembly <c>internal</c>).
    /// </summary>
    /// <param name="clrBase">The CLR base type to search (its base chain is walked by reflection).</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <returns>The deduplicated candidate methods (most-derived signature wins).</returns>
    private static IReadOnlyList<MethodInfo> CollectBaseClrMethodCandidates(System.Type clrBase, string methodName)
    {
        var result = new List<MethodInfo>();
        if (clrBase == null)
        {
            return result;
        }

        foreach (var m in ClrTypeUtilities.SafeGetMethods(clrBase, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance))
        {
            if (!string.Equals(m.Name, methodName, System.StringComparison.Ordinal))
            {
                continue;
            }

            // Accessible to a derived type via `base`: public, protected
            // (Family), or protected-internal (FamilyOrAssembly). Exclude
            // private and (cross-assembly) internal members.
            if (!(m.IsPublic || m.IsFamily || m.IsFamilyOrAssembly))
            {
                continue;
            }

            if (!MemberLookup.HasSameSignature(result, m))
            {
                result.Add(m);
            }
        }

        return result;
    }

    /// <summary>
    /// Issue #1104 / #1260: resolves the base class to start a
    /// <c>base.Member</c> search from, shared by the base-method-call path
    /// (<see cref="BindBaseClassCall"/>) and the base-property-access path
    /// (<see cref="BindBaseClassPropertyRead"/> /
    /// <see cref="BindBaseClassPropertyWrite"/>). Reports GS0383 when the call
    /// site is not an instance member of a class and GS0385 when a bracketed
    /// <c>base[Type]</c> selector does not name an actual base class.
    /// <para>
    /// Issue #1260: a class with no GSharp base class still inherits the members
    /// of its imported/BCL base (or <c>System.Object</c>), so when there is no
    /// user <see cref="StructSymbol"/> base this no longer reports GS0383.
    /// Instead it returns with <paramref name="searchBase"/> <see langword="null"/>
    /// and <paramref name="clrBaseFallback"/> set to the CLR base type to resolve
    /// inherited members against. <paramref name="clrBaseFallback"/> is always
    /// non-<see langword="null"/> on success (defaulting to <c>typeof(object)</c>)
    /// so a multi-level user → user → BCL chain can fall back when the nearest
    /// user base does not declare the member.
    /// </para>
    /// </summary>
    /// <param name="baseLocation">The location of the <c>base</c> token (for GS0383).</param>
    /// <param name="explicitBaseType">The class named in <c>base[BaseClass]</c>, or <see langword="null"/> for the plain form.</param>
    /// <param name="selectorLocation">The location of the bracketed selector (for GS0385).</param>
    /// <param name="searchBase">The resolved GSharp base class to start the member search from, or <see langword="null"/> when the class derives only from an imported/BCL base.</param>
    /// <param name="clrBaseFallback">The CLR base type to resolve inherited BCL members against (issue #1260); always set on success.</param>
    /// <returns><see langword="true"/> when the access site is a valid class instance member.</returns>
    private bool TryResolveBaseSearchType(
        TextLocation baseLocation,
        StructSymbol explicitBaseType,
        TextLocation selectorLocation,
        out StructSymbol searchBase,
        out System.Type clrBaseFallback)
    {
        searchBase = null;
        clrBaseFallback = null;

        // The access site must live in an instance member of a class. Top-level
        // functions, `shared` statics, and structs (no base class) all fail.
        var enclosingType = function?.ReceiverType as StructSymbol;
        if (enclosingType == null || function?.ThisParameter == null || !enclosingType.IsClass)
        {
            Diagnostics.ReportBaseClassCallHasNoBaseClass(baseLocation, EnclosingTypeDisplayName());
            return false;
        }

        // Determine the base class to start the member search from. For the
        // bracketed form, the named selector must be an actual base class of
        // the enclosing type; for the plain form, use the immediate base.
        if (explicitBaseType != null)
        {
            if (!IsBaseClassOf(enclosingType, explicitBaseType))
            {
                Diagnostics.ReportBaseClassCallSelectorNotBaseClass(selectorLocation, enclosingType.Name, explicitBaseType.Name);
                return false;
            }

            searchBase = explicitBaseType;
        }
        else
        {
            searchBase = enclosingType.BaseClass;
        }

        // Issue #1260: the CLR base type used for inherited-BCL member lookup —
        // walk from the search base (or the enclosing type when there is no user
        // base) to the topmost user class and take its imported CLR base,
        // defaulting to System.Object so universally-inherited members
        // (ToString/Equals/GetHashCode/GetType) resolve.
        clrBaseFallback = ResolveClrBaseSearchType(searchBase ?? enclosingType);
        return true;
    }

    /// <summary>
    /// Issue #1260: returns the CLR base type whose inherited instance members a
    /// <c>base.Member</c> access resolves against. Walks the GSharp base-class
    /// chain from <paramref name="from"/> to the topmost user class and returns
    /// that class's imported/BCL base (<see cref="StructSymbol.ImportedBaseType"/>),
    /// defaulting to <c>typeof(object)</c> when no class in the chain declares an
    /// imported base.
    /// </summary>
    /// <param name="from">The GSharp class to start walking from.</param>
    /// <returns>The CLR base type for inherited-member lookup.</returns>
    private static System.Type ResolveClrBaseSearchType(StructSymbol from)
    {
        for (var t = from; t != null; t = t.BaseClass)
        {
            if (t.ImportedBaseType?.ClrType is System.Type clr)
            {
                return clr;
            }
        }

        return typeof(object);
    }

    /// <summary>
    /// Issue #1104: binds a base-class property READ of the form
    /// <c>base.Prop</c> (or the bracketed <c>base[BaseClass].Prop</c> form).
    /// Resolves <c>Prop</c> on the nearest base class's property set (walking
    /// grandparents) and wraps the property's getter accessor in a
    /// <see cref="BoundBaseClassCallExpression"/> so the emitter produces a
    /// non-virtual <c>call instance R BaseClass::get_Prop()</c> — exactly like
    /// C# <c>base.Prop</c>. This lets an override reference the inherited member
    /// it shadows without re-entering its own getter (infinite recursion).
    /// </summary>
    /// <param name="member">The member-name syntax (<c>Prop</c>).</param>
    /// <param name="baseLocation">The location of the <c>base</c> token for context diagnostics.</param>
    /// <param name="explicitBaseType">The class named in <c>base[BaseClass]</c>, or <see langword="null"/> for the plain form.</param>
    /// <param name="selectorLocation">The location of the bracketed selector (for GS0385).</param>
    /// <returns>The bound base-class property read, or a bound error on failure.</returns>
    private BoundExpression BindBaseClassPropertyRead(
        NameExpressionSyntax member,
        TextLocation baseLocation,
        StructSymbol explicitBaseType,
        TextLocation selectorLocation)
    {
        if (!TryResolveBaseSearchType(baseLocation, explicitBaseType, selectorLocation, out var searchBase, out var clrBaseFallback))
        {
            return new BoundErrorExpression(null);
        }

        var memberName = member.IdentifierToken.Text;
        if (searchBase == null || !TypeMemberModel.TryGetProperty(searchBase, memberName, out var prop, out var declaringType))
        {
            // Issue #1260: no GSharp base declares the property — fall back to the
            // imported/BCL base type so `base.Prop` reads the inherited member
            // non-virtually (e.g. a virtual/overridable BCL property).
            if (TryBindBaseClrPropertyRead(member, clrBaseFallback, out var bclRead))
            {
                return bclRead;
            }

            Diagnostics.ReportBaseClassCallMemberNotFound(member.IdentifierToken.Location, searchBase?.Name ?? ClrTypeDisplayName(clrBaseFallback), memberName);
            return new BoundErrorExpression(null);
        }

        if (!prop.HasGetter)
        {
            Diagnostics.ReportCannotAssign(member.IdentifierToken.Location, memberName);
            return new BoundErrorExpression(null);
        }

        // Issue #950 / #2044: enforce `protected`/`private` property access
        // against the declaring type.
        if (!AccessibilityChecker.IsAccessible(prop.Accessibility, declaringType, this.function))
        {
            Diagnostics.ReportMemberInaccessible(member.IdentifierToken.Location, prop.Name, declaringType.Name, prop.Accessibility);
        }

        var receiver = new BoundVariableExpression(null, function.ThisParameter);

        // Issue #1347: an auto-property has no getter FunctionSymbol — its
        // getter is a compiler-synthesized backing-field read. Route the base
        // access through the property so the emitter resolves the synthesized
        // `get_Prop` MethodDef and the interpreter reads the backing field,
        // rather than mis-binding the read as a write (GS0127).
        if (prop.GetterSymbol == null)
        {
            return new BoundBaseClassCallExpression(
                member,
                receiver,
                declaringType,
                method: null,
                ImmutableArray<BoundExpression>.Empty,
                prop.Type,
                property: prop,
                isSetterAccessor: false);
        }

        return new BoundBaseClassCallExpression(
            member,
            receiver,
            declaringType,
            prop.GetterSymbol,
            ImmutableArray<BoundExpression>.Empty,
            prop.Type);
    }

    /// <summary>
    /// Issue #1104: binds a base-class property WRITE of the form
    /// <c>base.Prop = value</c>. Resolves <c>Prop</c> on the nearest base
    /// class's property set (walking grandparents) and wraps the property's
    /// setter accessor in a <see cref="BoundBaseClassCallExpression"/> so the
    /// emitter produces a non-virtual
    /// <c>call instance void BaseClass::set_Prop(value)</c>.
    /// </summary>
    /// <param name="memberName">The property name.</param>
    /// <param name="memberLocation">The location of the property name token.</param>
    /// <param name="baseLocation">The location of the <c>base</c> token for context diagnostics.</param>
    /// <param name="value">The already-bound right-hand value expression.</param>
    /// <param name="valueLocation">The location of the value expression (for conversion diagnostics).</param>
    /// <param name="equalsLocation">The location of the <c>=</c> token (for GS cannot-assign).</param>
    /// <param name="explicitBaseType">The class named in <c>base[BaseClass]</c>, or <see langword="null"/> for the plain <c>base.Prop</c> form.</param>
    /// <param name="selectorLocation">The location of the bracketed selector (for GS0385); use <paramref name="baseLocation"/> for the plain form.</param>
    /// <returns>The bound base-class property write, or a bound error on failure.</returns>
    private BoundExpression BindBaseClassPropertyWrite(
        string memberName,
        TextLocation memberLocation,
        TextLocation baseLocation,
        BoundExpression value,
        TextLocation valueLocation,
        TextLocation equalsLocation,
        StructSymbol explicitBaseType,
        TextLocation selectorLocation)
    {
        if (!TryResolveBaseSearchType(baseLocation, explicitBaseType, selectorLocation, out var searchBase, out var clrBaseFallback))
        {
            return new BoundErrorExpression(null);
        }

        if (searchBase == null || !TypeMemberModel.TryGetProperty(searchBase, memberName, out var prop, out var declaringType))
        {
            // Issue #1260: no GSharp base declares the property — fall back to the
            // imported/BCL base type so `base.Prop = value` writes the inherited
            // member non-virtually.
            if (TryBindBaseClrPropertyWrite(memberName, memberLocation, value, valueLocation, equalsLocation, clrBaseFallback, out var bclWrite))
            {
                return bclWrite;
            }

            Diagnostics.ReportBaseClassCallMemberNotFound(memberLocation, searchBase?.Name ?? ClrTypeDisplayName(clrBaseFallback), memberName);
            return new BoundErrorExpression(null);
        }

        if (!prop.HasSetter)
        {
            Diagnostics.ReportCannotAssign(equalsLocation, memberName);
            return new BoundErrorExpression(null);
        }

        // Issue #950 / #2044: enforce `protected`/`private` property
        // assignment against the declaring type.
        if (!AccessibilityChecker.IsAccessible(prop.Accessibility, declaringType, this.function))
        {
            Diagnostics.ReportMemberInaccessible(memberLocation, prop.Name, declaringType.Name, prop.Accessibility);
        }

        var converted = conversions.BindConversion(valueLocation, value, prop.Type);
        var receiver = new BoundVariableExpression(null, function.ThisParameter);

        // Issue #1347: an auto-property has no setter FunctionSymbol — its
        // setter is a compiler-synthesized backing-field write. Route the base
        // assignment through the property so the emitter resolves the
        // synthesized `set_Prop` MethodDef and the interpreter writes the
        // backing field.
        if (prop.SetterSymbol == null)
        {
            return new BoundBaseClassCallExpression(
                value.Syntax,
                receiver,
                declaringType,
                method: null,
                ImmutableArray.Create(converted),
                TypeSymbol.Void,
                property: prop,
                isSetterAccessor: true);
        }

        return new BoundBaseClassCallExpression(
            value.Syntax,
            receiver,
            declaringType,
            prop.SetterSymbol,
            ImmutableArray.Create(converted));
    }

    /// <summary>
    /// Issue #1260: binds a <c>base.Prop</c> READ into an imported/BCL base
    /// class. Resolves the inherited CLR property's getter and wraps it in a
    /// non-virtual <see cref="BoundImportedInstanceCallExpression"/> so the
    /// emitter produces <c>call instance R BaseClass::get_Prop()</c> — exactly
    /// like C# <c>base.Prop</c>. An <c>abstract</c> getter (no implementation)
    /// is reported as GS0413.
    /// </summary>
    /// <param name="member">The member-name syntax (<c>Prop</c>).</param>
    /// <param name="clrBase">The CLR base type to resolve the inherited property against.</param>
    /// <param name="result">The bound non-virtual property read (or an error node) when handled.</param>
    /// <returns><see langword="true"/> when a readable inherited property was found (or a precise diagnostic was reported).</returns>
    private bool TryBindBaseClrPropertyRead(
        NameExpressionSyntax member,
        System.Type clrBase,
        out BoundExpression result)
    {
        result = null;

        var memberName = member.IdentifierToken.Text;
        var clrProp = ClrTypeUtilities.SafeGetProperty(clrBase, memberName, BindingFlags.Public | BindingFlags.Instance);
        if (clrProp == null || clrProp.GetIndexParameters().Length != 0 || !clrProp.CanRead)
        {
            return false;
        }

        var getter = clrProp.GetGetMethod(nonPublic: false);
        if (getter == null)
        {
            return false;
        }

        if (getter.IsAbstract)
        {
            Diagnostics.ReportBaseClassCallAbstractMember(member.IdentifierToken.Location, clrProp.DeclaringType?.Name ?? clrBase.Name, memberName);
            result = new BoundErrorExpression(null);
            return true;
        }

        var receiver = new BoundVariableExpression(null, function.ThisParameter);
        result = new BoundImportedInstanceCallExpression(
            member,
            receiver,
            getter,
            TypeSymbol.FromClrType(clrProp.PropertyType),
            ImmutableArray<BoundExpression>.Empty,
            isNonVirtualBaseCall: true);
        return true;
    }

    /// <summary>
    /// Issue #1260: binds a <c>base.Prop = value</c> WRITE into an imported/BCL
    /// base class. Resolves the inherited CLR property's setter and wraps it in a
    /// non-virtual <see cref="BoundImportedInstanceCallExpression"/> so the
    /// emitter produces <c>call instance void BaseClass::set_Prop(value)</c>.
    /// An <c>abstract</c> setter (no implementation) is reported as GS0413.
    /// </summary>
    /// <param name="memberName">The property name.</param>
    /// <param name="memberLocation">The location of the property name token.</param>
    /// <param name="value">The already-bound right-hand value expression.</param>
    /// <param name="valueLocation">The location of the value expression (for conversion diagnostics).</param>
    /// <param name="equalsLocation">The location of the <c>=</c> token (for GS cannot-assign).</param>
    /// <param name="clrBase">The CLR base type to resolve the inherited property against.</param>
    /// <param name="result">The bound non-virtual property write (or an error node) when handled.</param>
    /// <returns><see langword="true"/> when a writable inherited property was found (or a precise diagnostic was reported).</returns>
    private bool TryBindBaseClrPropertyWrite(
        string memberName,
        TextLocation memberLocation,
        BoundExpression value,
        TextLocation valueLocation,
        TextLocation equalsLocation,
        System.Type clrBase,
        out BoundExpression result)
    {
        result = null;

        var clrProp = ClrTypeUtilities.SafeGetProperty(clrBase, memberName, BindingFlags.Public | BindingFlags.Instance);
        if (clrProp == null || clrProp.GetIndexParameters().Length != 0)
        {
            return false;
        }

        if (!clrProp.CanWrite)
        {
            Diagnostics.ReportCannotAssign(equalsLocation, memberName);
            result = new BoundErrorExpression(null);
            return true;
        }

        var setter = clrProp.GetSetMethod(nonPublic: false);
        if (setter == null)
        {
            Diagnostics.ReportCannotAssign(equalsLocation, memberName);
            result = new BoundErrorExpression(null);
            return true;
        }

        if (setter.IsAbstract)
        {
            Diagnostics.ReportBaseClassCallAbstractMember(memberLocation, clrProp.DeclaringType?.Name ?? clrBase.Name, memberName);
            result = new BoundErrorExpression(null);
            return true;
        }

        var converted = conversions.BindConversion(valueLocation, value, TypeSymbol.FromClrType(clrProp.PropertyType));
        var receiver = new BoundVariableExpression(null, function.ThisParameter);
        result = new BoundImportedInstanceCallExpression(
            value.Syntax,
            receiver,
            setter,
            TypeSymbol.Void,
            ImmutableArray.Create(converted),
            isNonVirtualBaseCall: true);
        return true;
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

        var candidates = new List<MethodInfo>(MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(clrType, methodName));
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
                // Issue #2347: defer an unresolved method-group argument (see
                // TryBindImportedExtensionCall) instead of failing outright.
                if (!OverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]))
                {
                    return false;
                }
            }

            argTypes[i] = t;
        }

        // Issue #1852 (follow-up from #1812 N1): mark which positional
        // arguments are interpolated-string literals so overload resolution
        // treats them as applicable to an IFormattable/FormattableString (or
        // handler) parameter, just like every other CLR-call Resolve site.
        var interpolatedStringArgs = ComputeInterpolatedStringArgFlags(ce.Arguments, arguments.Length);
        var resolution = OverloadResolution.Resolve(
            candidates,
            argTypes,
            null,
            scope.References.MapClrTypeToReferences,
            interpolatedStringArgs,
            argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames,
            constantNarrowingArgumentCheck: MakeConstantNarrowingArgumentCheck(arguments));
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
            ?? MapClrMethodReturnType(method);

        // Issue #1852: re-lower each interpolated-string argument whose
        // resolved parameter is IFormattable/FormattableString-shaped to
        // FormattableStringFactory.Create(...) — mirroring
        // RebindFormattableInterpolationArguments, the same step every other
        // CLR-call path runs — WITHOUT routing through the rest of
        // BuildResolvedClrCallArguments (ApplyInterpolatedStringHandlers,
        // delegate rebind, BindClrParameterConversions). This path
        // deliberately skips the CLR boxing/conversion pass below (see the
        // "deliberately skip" comment on orderedArgs): the emitted MemberRef
        // parameter is the interface type-variable `!0`, passed unconverted,
        // so routing every argument through the conversion pipeline would
        // risk an ilverify mismatch. Only the specific interpolated-string
        // arguments actually bound to a handler parameter are touched; every
        // other argument (and the overload choice itself, unaffected unless a
        // candidate's applicability actually depended on the flag) is
        // unchanged.
        arguments = RebindFormattableInterpolationArguments(arguments, ce.Arguments, parameters, resolution.ParameterMapping);

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

    /// <summary>
    /// Issue #1550: binds a call to a universal <see cref="object"/> instance
    /// member (<c>ToString</c>, <c>GetHashCode</c>, <c>Equals(object)</c>,
    /// <c>GetType</c>) dispatched through ANY type-parameter receiver, even one
    /// without a matching user/CLR constraint. The method is resolved against
    /// <c>typeof(object)</c>; the resulting
    /// <see cref="BoundImportedInstanceCallExpression"/> carries the constrained
    /// type parameter (and a <see langword="null"/> constrained interface type,
    /// so the emitted <c>MemberRef</c> is parented at <c>System.Object</c>) so
    /// the emitter produces a verifiable
    /// <c>constrained. !!T  callvirt System.Object::Method(...)</c> sequence.
    /// The <c>constrained.</c> prefix dispatches to any override for value,
    /// struct/enum-constrained and reference type parameters alike without a
    /// manual box.
    /// </summary>
    /// <param name="receiver">The bound receiver (its type is the constrained type parameter).</param>
    /// <param name="tp">The receiver's type parameter.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The bound argument expressions.</param>
    /// <param name="ce">The originating call-expression syntax.</param>
    /// <param name="argumentNames">Optional named-argument labels in source order.</param>
    /// <param name="result">The bound constrained call on success.</param>
    /// <returns><see langword="true"/> when a matching object member was found and bound.</returns>
    private bool TryBindConstrainedObjectMemberCall(
        BoundExpression receiver,
        TypeParameterSymbol tp,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        out BoundExpression result)
    {
        result = null;

        var candidates = new List<MethodInfo>(MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(object), methodName));
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
                // Issue #2347: defer an unresolved method-group argument (see
                // TryBindImportedExtensionCall) instead of failing outright.
                if (!OverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]))
                {
                    return false;
                }
            }

            argTypes[i] = t;
        }

        // Issue #1812: `interpolatedStringArgs` is deliberately left null here.
        // Candidates are drawn only from `typeof(object)`'s public instance
        // methods (ToString, Equals(object), GetHashCode, GetType) — none
        // declares an IFormattable/FormattableString/handler parameter, so an
        // interpolated-string argument could never take the Tier-4
        // (ADR-0055) conversion path against any candidate here regardless of
        // the flag. Unlike TryBindConstrainedClrInterfaceCall above, this path
        // does run the full CLR parameter-conversion pass afterward, but that
        // fact is irrelevant given no candidate parameter shape could match.
        // Constant-narrowing is intentionally omitted for the same reason:
        // object members expose only zero parameters or Equals(object), never a
        // narrower integer parameter.
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

        // A concrete object member has a concrete return type (string / int32 /
        // bool / System.Type). Resolve it nullable-obliviously: the receiver is
        // an erased type parameter (ADR-0004 / #313), so the BCL's `string?`
        // annotation on `object.ToString()` must not leak a spurious nullable
        // return into the generic context (which would reject the common
        // `func Show[T struct]() string -> v.ToString()` shape with GS0156).
        var returnType = TypeSymbol.FromClrType(method.ReturnType);

        // Unlike the CLR-interface path, the parameter of a matched object
        // member (e.g. Equals(object)) is a real System.Object, so a `T`-typed
        // argument must be boxed. Run the normal CLR conversion pass so the
        // emitter widens (boxes) the `!!T` value to object.
        var mapping = resolution.ParameterMapping;
        var convertedArgs = conversions.BindClrParameterConversions(arguments, parameters, ce, mapping, method: method, receiverType: receiver.Type);
        var orderedArgs = OverloadResolver.BuildOrderedCallArguments(convertedArgs, mapping, parameters);
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
            constrainedInterfaceType: null);
        return true;
    }

    /// <summary>
    /// Issue #2304: binds a call to a universal <see cref="object"/> instance
    /// member (<c>ToString</c>, <c>GetHashCode</c>, <c>Equals(object)</c>,
    /// <c>GetType</c>) dispatched through an INTERFACE-typed receiver — either
    /// a source-declared <see cref="InterfaceSymbol"/> (whose <c>ClrType</c> is
    /// still <see langword="null"/> at bind time) or an imported interface
    /// (an <see cref="ImportedTypeSymbol"/> whose <c>ClrType.IsInterface</c> is
    /// <see langword="true"/>). Every interface implicitly derives from
    /// <see cref="object"/> at the CLR/C# layer for member-access purposes —
    /// <c>Type.GetMethods()</c> on an interface type never reports it, though,
    /// so the shared CLR-instance-method enumeration (which walks only an
    /// interface's own transitive base interfaces) never finds these names and
    /// the call otherwise dead-ends at <c>GS0159</c>.
    /// </summary>
    /// <remarks>
    /// Unlike <see cref="TryBindConstrainedObjectMemberCall"/> (used for an
    /// erased type-parameter receiver), no <c>constrained.</c> prefix is
    /// needed here: an interface-typed receiver is ALWAYS a genuine managed
    /// reference at the CLR level (never an unboxed value), so a plain
    /// <c>callvirt System.Object::Method(...)</c> against that reference is
    /// already verifiable and dispatches to the runtime type's override.
    /// </remarks>
    /// <param name="receiver">The bound receiver (its static type is the interface).</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The bound argument expressions.</param>
    /// <param name="ce">The originating call-expression syntax.</param>
    /// <param name="argumentNames">Optional named-argument labels in source order.</param>
    /// <param name="result">The bound call on success.</param>
    /// <returns><see langword="true"/> when a matching object member was found and bound.</returns>
    private bool TryBindInterfaceObjectMemberCall(
        BoundExpression receiver,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        out BoundExpression result)
    {
        result = null;

        var candidates = new List<MethodInfo>(MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(object), methodName));
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
                // Issue #2347: defer an unresolved method-group argument (see
                // TryBindImportedExtensionCall) instead of failing outright.
                if (!OverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]))
                {
                    return false;
                }
            }

            argTypes[i] = t;
        }

        // Constant-narrowing is intentionally omitted: the only object member
        // with an argument is Equals(object), so there is no narrower integer
        // parameter for §10.2.11 to target.
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
        var returnType = TypeSymbol.FromClrType(method.ReturnType);

        var mapping = resolution.ParameterMapping;
        var convertedArgs = conversions.BindClrParameterConversions(arguments, parameters, ce, mapping, method: method, receiverType: receiver.Type);
        var orderedArgs = OverloadResolver.BuildOrderedCallArguments(convertedArgs, mapping, parameters);
        var refKinds = ComputeArgumentRefKinds(parameters);

        result = new BoundImportedInstanceCallExpression(
            ce,
            receiver,
            method,
            returnType,
            orderedArgs,
            refKinds,
            default,
            constrainedReceiverTypeParameter: null,
            constrainedInterfaceType: null);
        return true;
    }
}
