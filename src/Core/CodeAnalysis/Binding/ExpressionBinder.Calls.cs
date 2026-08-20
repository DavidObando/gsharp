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
        var explicitValues = new Dictionary<string, (FieldSymbol? Field, PropertySymbol? Property, BoundExpression Value)>();
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
                propertyDeclaringType = Invariant.Required(propertyDeclaringType, "a user-defined struct property has a declaring type");
                if (!AccessibilityChecker.IsAccessible(property.SetterAccessibility, propertyDeclaringType, this.function))
                {
                    Diagnostics.ReportMemberInaccessible(initSyntax.FieldIdentifier.Location, property.Name, propertyDeclaringType.Name, property.SetterAccessibility);
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
        var target = BindExpression(
            Invariant.Required(syntax.Target, "an object creation has a target expression"));
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
        var hasNonIndexedElement = false;
        var hasSpreadElement = false;
        foreach (var element in syntax.Elements)
        {
            hasNonIndexedElement |= element is not IndexedCollectionElementSyntax;
            var expressionElement = element as ExpressionCollectionElementSyntax;
            hasSpreadElement |= expressionElement?.Expression is SpreadElementExpressionSyntax;
        }

        // A collection initializer requires an accessible instance `Add` for the
        // bare / key:value element forms. Indexed `[k] = v` entries go through
        // the indexer-set path, which reports its own GS0226/indexability errors.
        if ((hasNonIndexedElement && !HasCollectionAdd(resultType)) ||
            (hasSpreadElement && !HasUnaryCollectionAdd(resultType)))
        {
            Diagnostics.ReportTypeNotCollectionInitializable(syntax.OpenBraceToken.Location, resultType);
            BindCollectionElementsForDiagnostics(syntax);
            return new BoundErrorExpression(null);
        }

        var tempName = "$collinit" + System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var tempVar = new LocalVariableSymbol(tempName, isReadOnly: false, resultType);
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
    /// <paramref name="collectionLocal"/>, appending the required statements
    /// for each element.
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
                case ExpressionCollectionElementSyntax { Expression: SpreadElementExpressionSyntax spread }:
                    statements.AddRange(BindCollectionSpreadStatements(collectionLocal, spread));
                    continue;
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
    /// Issue #3096: lowers <c>...source</c> to a compiler-synthesized lambda
    /// that receives the collection and source as parameters, uses native
    /// for-range plus the target's ordinary <c>Add</c> overload, and returns
    /// the updated collection. Keeping the loop in a non-capturing lambda makes
    /// the outer initializer straight-line and verifiable even when another
    /// operand or assignment receiver is already on the IL evaluation stack.
    /// </summary>
    private ImmutableArray<BoundStatement> BindCollectionSpreadStatements(
        LocalVariableSymbol collectionLocal,
        SpreadElementExpressionSyntax spread)
    {
        var tree = spread.SyntaxTree;
        var position = spread.Span.Start;
        var sourceName = "$spreadsource" +
            System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)
                .ToString(System.Globalization.CultureInfo.InvariantCulture);
        var sourceToken = new SyntaxToken(tree, SyntaxKind.IdentifierToken, position, sourceName, null);
        var source = BindExpression(spread.Expression);
        if (TypeSymbol.IsByRefLike(source.Type))
        {
            // A ref-like source cannot be captured by the synthesized lambda.
            // Materialize its ordinary ToArray() value first; the call still
            // evaluates the source exactly once and preserves element order.
            source = BindAccessorCall(
                source,
                classSymbol: null,
                SynthesizeInstanceCall(spread, "ToArray", ImmutableArray<ExpressionSyntax>.Empty));
        }

        var sourceLocal = new LocalVariableSymbol(sourceName, isReadOnly: true, source.Type);
        scope.TryDeclareVariable(sourceLocal);
        _ = TryGetCollectionSpreadElementType(collectionLocal.Type, out var targetElementType);
        if (function?.IsStaticInitializer == true &&
            function.StaticOwnerType is InterfaceSymbol)
        {
            // BindInterfaceStaticSpreadStatements branches on
            // `targetElementType != null` itself, so null is a shape it handles.
            // Asserting here would make that branch dead code and turn a handled
            // case into GS9998.
            return BindInterfaceStaticSpreadStatements(
                collectionLocal,
                spread,
                sourceLocal,
                sourceToken,
                source,
                targetElementType);
        }

        var targetName = "$spreadtarget" +
            System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)
                .ToString(System.Globalization.CultureInfo.InvariantCulture);
        var targetToken = new SyntaxToken(tree, SyntaxKind.IdentifierToken, position, targetName, null);
        var sourceParameterName = "$spreaditems" +
            System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)
                .ToString(System.Globalization.CultureInfo.InvariantCulture);
        var sourceParameterToken = new SyntaxToken(
            tree,
            SyntaxKind.IdentifierToken,
            position,
            sourceParameterName,
            null);
        var itemName = "$spreaditem" +
            System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)
                .ToString(System.Globalization.CultureInfo.InvariantCulture);
        var itemToken = new SyntaxToken(tree, SyntaxKind.IdentifierToken, position, itemName, null);
        var itemExpression = new NameExpressionSyntax(tree, itemToken);
        var addCall = SynthesizeInstanceCall(
            spread,
            "Add",
            ImmutableArray.Create<ExpressionSyntax>(itemExpression));
        var body = new ExpressionStatementSyntax(
            tree,
            new AccessorExpressionSyntax(
                tree,
                new NameExpressionSyntax(tree, targetToken),
                new SyntaxToken(tree, SyntaxKind.DotToken, position, ".", null),
                addCall));
        var loop = new ForRangeStatementSyntax(
            tree,
            new SyntaxToken(tree, SyntaxKind.ForKeyword, position, "for", null),
            itemToken,
            commaToken: null,
            secondIdentifier: null,
            colonEqualsToken: null,
            rangeKeyword: null,
            inToken: new SyntaxToken(tree, SyntaxKind.IdentifierToken, position, "in", null),
            collection: new NameExpressionSyntax(tree, sourceParameterToken),
            body: body);

        var parameterNodes = ImmutableArray.CreateBuilder<SyntaxNode>();
        parameterNodes.Add(new ParameterSyntax(tree, targetToken, type: null));
        parameterNodes.Add(new SyntaxToken(tree, SyntaxKind.CommaToken, position, ",", null));
        parameterNodes.Add(new ParameterSyntax(tree, sourceParameterToken, type: null));
        var lambdaBody = new BlockExpressionSyntax(
            tree,
            new SyntaxToken(tree, SyntaxKind.OpenBraceToken, position, "{", null),
            ImmutableArray.Create<StatementSyntax>(loop),
            expression: new NameExpressionSyntax(tree, targetToken),
            new SyntaxToken(tree, SyntaxKind.CloseBraceToken, position, "}", null));
        var lambda = new LambdaExpressionSyntax(
            tree,
            new SyntaxToken(tree, SyntaxKind.OpenParenthesisToken, position, "(", null),
            new SeparatedSyntaxList<ParameterSyntax>(parameterNodes.ToImmutable()),
            new SyntaxToken(tree, SyntaxKind.CloseParenthesisToken, position, ")", null),
            new SyntaxToken(tree, SyntaxKind.RightArrowToken, position, "->", null),
            lambdaBody);
        var functionType = FunctionTypeSymbol.Get(
            ImmutableArray.Create(collectionLocal.Type, source.Type),
            collectionLocal.Type);
        BoundExpression boundLambda = lambdas.BindLambdaExpression(lambda, functionType);
        if (targetElementType != null &&
            boundLambda is BoundFunctionLiteralExpression literal)
        {
            boundLambda = RewriteCollectionSpreadLambda(literal, targetElementType, spread);
        }

        var invocation = new BoundIndirectCallExpression(
            spread,
            boundLambda,
            functionType,
            ImmutableArray.Create<BoundExpression>(
                new BoundVariableExpression(spread, collectionLocal),
                new BoundVariableExpression(spread, sourceLocal)));
        var assignment = new BoundAssignmentExpression(spread, collectionLocal, invocation);

        return ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(spread, sourceLocal, source),
            new BoundExpressionStatement(spread, assignment));
    }

    private ImmutableArray<BoundStatement> BindInterfaceStaticSpreadStatements(
        LocalVariableSymbol collectionLocal,
        SpreadElementExpressionSyntax spread,
        LocalVariableSymbol sourceLocal,
        SyntaxToken sourceToken,
        BoundExpression source,
        TypeSymbol? targetElementType)
    {
        var tree = spread.SyntaxTree;
        var position = spread.Span.Start;
        var itemName = "$spreaditem" +
            System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)
                .ToString(System.Globalization.CultureInfo.InvariantCulture);
        var itemToken = new SyntaxToken(tree, SyntaxKind.IdentifierToken, position, itemName, null);
        var addCall = SynthesizeInstanceCall(
            spread,
            "Add",
            ImmutableArray.Create<ExpressionSyntax>(new NameExpressionSyntax(tree, itemToken)));
        var loop = new ForRangeStatementSyntax(
            tree,
            new SyntaxToken(tree, SyntaxKind.ForKeyword, position, "for", null),
            itemToken,
            commaToken: null,
            secondIdentifier: null,
            colonEqualsToken: null,
            rangeKeyword: null,
            inToken: new SyntaxToken(tree, SyntaxKind.IdentifierToken, position, "in", null),
            collection: new NameExpressionSyntax(tree, sourceToken),
            body: new ExpressionStatementSyntax(
                tree,
                new AccessorExpressionSyntax(
                    tree,
                    new NameExpressionSyntax(
                        tree,
                        new SyntaxToken(
                            tree,
                            SyntaxKind.IdentifierToken,
                            position,
                            collectionLocal.Name,
                            null)),
                    new SyntaxToken(tree, SyntaxKind.DotToken, position, ".", null),
                    addCall)));
        BoundStatement bound = bindStatementList(
            ImmutableArray.Create<StatementSyntax>(loop),
            null).Single();
        if (targetElementType != null)
        {
            bound = new CollectionSpreadLoopRewriter(
                this,
                collectionLocal,
                targetElementType,
                spread).Rewrite(bound);
        }

        return ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(spread, sourceLocal, source),
            Lowerer.Lower(bound));
    }

    private BoundFunctionLiteralExpression RewriteCollectionSpreadLambda(
        BoundFunctionLiteralExpression literal,
        TypeSymbol targetElementType,
        SpreadElementExpressionSyntax spread)
    {
        var body = (BoundBlockStatement)new CollectionSpreadLoopRewriter(
            this,
            literal.Function.Parameters[0],
            targetElementType,
            spread).Rewrite(literal.Body);
        return new BoundFunctionLiteralExpression(
            literal.Syntax,
            literal.Function,
            literal.FunctionType,
            body,
            literal.CapturedVariables);
    }

    private BoundExpression BindConvertedCollectionAddCall(
        VariableSymbol receiverVariable,
        VariableSymbol itemVariable,
        TypeSymbol targetElementType,
        SpreadElementExpressionSyntax spread)
    {
        var placeholderName = "$spreadconverted" +
            System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)
                .ToString(System.Globalization.CultureInfo.InvariantCulture);
        var placeholderToken = new SyntaxToken(
            spread.SyntaxTree,
            SyntaxKind.IdentifierToken,
            spread.Span.Start,
            placeholderName,
            null);
        var placeholder = new LocalVariableSymbol(
            placeholderName,
            isReadOnly: true,
            targetElementType);

        BoundExpression add;
        var previousScope = scope;
        scope = new BoundScope(scope);
        try
        {
            scope.TryDeclareVariable(receiverVariable);
            scope.TryDeclareVariable(placeholder);
            add = BindCollectionAddCall(
                receiverVariable,
                spread,
                ImmutableArray.Create<ExpressionSyntax>(
                    new NameExpressionSyntax(spread.SyntaxTree, placeholderToken)));
        }
        finally
        {
            scope = previousScope;
        }

        var convertedItem = conversions.BindConversion(
            spread.Location,
            new BoundVariableExpression(spread, itemVariable),
            targetElementType);
        return new CollectionSpreadItemSubstitutionRewriter(
            placeholder,
            convertedItem).Rewrite(add);
    }

    private static bool TryGetCollectionSpreadElementType(
        TypeSymbol collectionType,
        [NotNullWhen(true)] out TypeSymbol? elementType)
    {
        switch (collectionType)
        {
            case SliceTypeSymbol slice:
                elementType = slice.ElementType;
                return true;
            case ArrayTypeSymbol array:
                elementType = array.ElementType;
                return true;
            case SequenceTypeSymbol sequence:
                elementType = sequence.ElementType;
                return true;
            case ImportedTypeSymbol imported
                when imported.OpenDefinition != null &&
                     MemberLookup.TryGetClrEnumerableElementType(
                         imported.OpenDefinition,
                         out var openElement):
                elementType = MemberLookup.MapOpenClrTypeToSymbolic(
                    openElement,
                    imported);
                return true;
            case NullabilityAnnotatedTypeSymbol annotated
                when annotated.ClrType != null &&
                     MemberLookup.TryGetClrEnumerableElementType(
                         annotated.ClrType,
                         out var annotatedElement):
                elementType = annotated.GetTypeArgumentSymbolForClrType(
                    annotatedElement);
                return true;
            case ImportedTypeSymbol imported
                when imported.ClrType != null &&
                     MemberLookup.TryGetClrEnumerableElementType(
                         imported.ClrType,
                         out var importedElement):
                elementType = TypeSymbol.FromClrType(importedElement);
                return true;
            case StructSymbol user
                when MemberLookup.TryGetUserPatternEnumerableElementType(
                    user,
                    out var userElement):
                elementType = Invariant.Required(userElement, "a successful user enumerable-element lookup produces an element type");
                return true;
        }

        var userParameterTypes = TypeMemberModel
            .GetMethods(
                collectionType,
                "Add",
                MemberQuery.Instance(MemberKinds.Method))
            .Where(method => method.Parameters.Length == 1)
            .Select(method => method.Parameters[0].Type)
            .Distinct()
            .ToArray();
        if (userParameterTypes.Length == 1)
        {
            elementType = userParameterTypes[0];
            return true;
        }

        elementType = null;
        if (collectionType?.ClrType == null)
        {
            return false;
        }

        Type? clrElement = null;
        foreach (var method in MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
            collectionType.ClrType,
            "Add"))
        {
            var parameters = method.GetParameters();
            if (parameters.Length != 1)
            {
                continue;
            }

            if (clrElement != null &&
                !clrElement.IsSameAs(parameters[0].ParameterType))
            {
                return false;
            }

            clrElement = parameters[0].ParameterType;
        }

        if (clrElement == null)
        {
            return false;
        }

        elementType = TypeSymbol.FromClrType(clrElement);
        return true;
    }

    private sealed class CollectionSpreadLoopRewriter : BoundTreeRewriter
    {
        private readonly ExpressionBinder binder;
        private readonly VariableSymbol receiver;
        private readonly TypeSymbol targetElementType;
        private readonly SpreadElementExpressionSyntax spread;

        public CollectionSpreadLoopRewriter(
            ExpressionBinder binder,
            VariableSymbol receiver,
            TypeSymbol targetElementType,
            SpreadElementExpressionSyntax spread)
        {
            this.binder = binder;
            this.receiver = receiver;
            this.targetElementType = targetElementType;
            this.spread = spread;
        }

        public BoundStatement Rewrite(BoundStatement statement)
            => RewriteStatement(statement);

        protected override BoundStatement RewriteForRangeStatement(
            BoundForRangeStatement node)
        {
            var add = binder.BindConvertedCollectionAddCall(
                receiver,
                node.ValueVariable,
                targetElementType,
                spread);
            return new BoundForRangeStatement(
                node.Syntax,
                node.KeyVariable,
                node.ValueVariable,
                node.Collection,
                node.IterationKind,
                new BoundExpressionStatement(spread, add),
                node.BreakLabel,
                node.ContinueLabel);
        }
    }

    private sealed class CollectionSpreadItemSubstitutionRewriter : BoundTreeRewriter
    {
        private readonly VariableSymbol placeholder;
        private readonly BoundExpression replacement;

        public CollectionSpreadItemSubstitutionRewriter(
            VariableSymbol placeholder,
            BoundExpression replacement)
        {
            this.placeholder = placeholder;
            this.replacement = replacement;
        }

        public BoundExpression Rewrite(BoundExpression expression)
            => RewriteExpression(expression);

        protected override BoundExpression RewriteVariableExpression(
            BoundVariableExpression node)
            => ReferenceEquals(node.Variable, placeholder)
                ? replacement
                : node;
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

        // Reference nullability is metadata-only here. Keep the runtime value
        // unchecked so assignment/Add arguments run before callvirt observes a
        // null receiver, matching C# evaluation order.
        TypeSymbol memberLocalType = propRead.Type is NullableTypeSymbol nullableMember
            && Conversion.IsReferenceLikeTarget(nullableMember.UnderlyingType)
                ? nullableMember.UnderlyingType
                : propRead.Type;
        var nestedObjectAssignments = ImmutableArray.CreateBuilder<AssignmentExpressionSyntax?>(braced.Elements.Count);
        var hasNonIndexedElement = false;
        var hasSpreadElement = false;
        var allElementsAreAssignments = braced.Elements.Count > 0;
        foreach (var element in braced.Elements)
        {
            var expressionElement = element as ExpressionCollectionElementSyntax;
            var assignment = expressionElement?.Expression as AssignmentExpressionSyntax;
            nestedObjectAssignments.Add(assignment);
            allElementsAreAssignments &= assignment is not null;
            hasNonIndexedElement |= element is not IndexedCollectionElementSyntax;
            hasSpreadElement |= expressionElement?.Expression is SpreadElementExpressionSyntax;
        }

        var isNestedObjectInitializer = allElementsAreAssignments;
        if (!isNestedObjectInitializer &&
            ((hasNonIndexedElement && !HasCollectionAdd(memberLocalType)) ||
             (hasSpreadElement && !HasUnaryCollectionAdd(memberLocalType))))
        {
            return false;
        }

        var tempName = "$collinit" + System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var memberLocal = new LocalVariableSymbol(tempName, isReadOnly: false, memberLocalType);
        scope.TryDeclareVariable(memberLocal);
        statements.Add(new BoundVariableDeclaration(braced, memberLocal, propRead));

        if (isNestedObjectInitializer)
        {
            foreach (var assignment in nestedObjectAssignments)
            {
                var nonNullAssignment = Invariant.Required(
                    assignment,
                    "a nested collection initializer contains only assignment elements");
                var initializer = new PropertyInitializerSyntax(
                    nonNullAssignment.SyntaxTree,
                    nonNullAssignment.IdentifierToken,
                    nonNullAssignment.EqualsToken,
                    nonNullAssignment.Expression);
                var boundAssignment = BindObjectInitializerAssignment(memberLocal, memberLocalType, initializer);
                if (boundAssignment != null)
                {
                    statements.Add(new BoundExpressionStatement(initializer, boundAssignment));
                }
            }

            return true;
        }

        EmitCollectionElementAddStatements(memberLocal, braced.Elements, statements);
        return true;
    }

    private static bool HasCollectionAdd(TypeSymbol type)
    {
        if (!TypeMemberModel.GetMethods(type, "Add", MemberQuery.Instance(MemberKinds.Method)).IsDefaultOrEmpty)
        {
            return true;
        }

        return type.ClrType is { } clrType
            && MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(clrType, "Add").Count > 0;
    }

    private static bool HasUnaryCollectionAdd(TypeSymbol type)
    {
        if (TypeMemberModel.GetMethods(type, "Add", MemberQuery.Instance(MemberKinds.Method))
            .Any(method => method.Parameters.Length == 1))
        {
            return true;
        }

        if (type.ClrType is not { } clrType)
        {
            return false;
        }

        foreach (var method in MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(clrType, "Add"))
        {
            if (method.GetParameters().Length == 1)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #479 / ADR-0117: lowers one bare / key:value collection element to
    /// an <c>Add(...)</c> call on the synthetic collection local. A synthetic
    /// <see cref="CallExpressionSyntax"/> named <c>Add</c> is bound through the
    /// shared accessor-call path so overload resolution, generic-argument
    /// inference, and parameter conversions all match a hand-written
    /// <c>coll.Add(...)</c>.
    /// </summary>
    private BoundExpression BindCollectionAddCall(VariableSymbol receiverLocal, SyntaxNode anchor, ImmutableArray<ExpressionSyntax> arguments)
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
                case ExpressionCollectionElementSyntax { Expression: SpreadElementExpressionSyntax spread }:
                    _ = BindExpression(spread.Expression);
                    break;
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

    private static bool TryGetCopyOverrides(
        CallExpressionSyntax call,
        [MaybeNullWhen(false)] out SeparatedSyntaxList<FieldInitializerSyntax> overrides)
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

    internal bool TryBindIntrinsicCall(
        CallExpressionSyntax syntax,
        [NotNullWhen(true)] out BoundExpression? result)
    {
        result = null;
        var name = syntax.Identifier.Text;
        switch (name)
        {
            case "cast":
            {
                if (syntax.TypeArgumentList == null
                    || syntax.TypeArgumentList.Arguments.Count != 1)
                {
                    Diagnostics.ReportWrongTypeArgumentCount(
                        syntax.TypeArgumentList?.Location ?? syntax.Identifier.Location,
                        name,
                        expectedCount: 1,
                        actualCount: syntax.TypeArgumentList?.Arguments.Count ?? 0);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                if (syntax.Arguments.Count != 1)
                {
                    Diagnostics.ReportWrongArgumentCount(
                        syntax.Identifier.Location,
                        name,
                        expectedCount: 1,
                        actualCount: syntax.Arguments.Count);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                var targetType = bindTypeClause(syntax.TypeArgumentList.Arguments[0]);
                if (targetType == null)
                {
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                reportObsoleteUseIfApplicable(
                    syntax.TypeArgumentList.Arguments[0].Location,
                    targetType,
                    targetType.Name);
                result = conversions.BindConversion(
                    syntax.Arguments[0],
                    targetType,
                    allowExplicit: true);
                return true;
            }

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
                    || (name == "len"
                        && (operand.Type == TypeSymbol.String
                            || operand.Type is MapTypeSymbol or RectangularArrayTypeSymbol));
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

    internal bool TryBindClrConstructorCall(
        CallExpressionSyntax syntax,
        [NotNullWhen(true)] out BoundExpression? result)
    {
        result = null;
        var name = syntax.Identifier.Text;

        System.Type? clrType = null;
        System.Type? openGenericDefinition = null;
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
        }

        if (clrType is not System.Type resolvedClrType)
        {
            return false;
        }

        if (syntax.TypeArgumentList == null && resolvedClrType.IsGenericTypeDefinition)
        {
            // User wrote `List(...)` without `[T]`; can't construct an open generic.
            return false;
        }

        // Issue #3421: a nullable type-call target is unambiguously a checked
        // conversion, never construction. Resolve imported generic targets
        // here because ordinary name lookup does not materialize their closed
        // CLR type.
        if (syntax.NullableQuestionToken != null && syntax.Arguments.Count == 1)
        {
            TypeSymbol checkedTarget = TypeSymbol.FromClrType(resolvedClrType);
            if (ImportedTypeSymbol.TryCreateSemanticAggregate(
                    resolvedClrType,
                    scope.References,
                    out var nullableAggregate))
            {
                checkedTarget = nullableAggregate;
            }

            result = conversions.BindConversion(
                syntax.Arguments[0],
                NullableTypeSymbol.Get(checkedTarget),
                allowExplicit: true);
            return true;
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
            && ImportedTypeSymbol.TryCreateSemanticAggregate(resolvedClrType, scope.References, out var dataClassAggregate)
            && dataClassAggregate.IsData
            && dataClassAggregate.HasPrimaryConstructor)
        {
            // Issue #2550: gsc data classes also expose a parameterless CLR
            // constructor as an implementation detail. Bind their source-level
            // construction through the imported primary-constructor metadata
            // so `Settings()` supplies declared defaults instead of selecting
            // that zero-initializing constructor. C# records have no gsc marker
            // and keep using CLR overload resolution (#2291/#2458).
            if (ImportedAssemblySemantics.TryGetTypeSemantics(resolvedClrType, out _))
            {
                var primaryParameterCount = dataClassAggregate.PrimaryConstructorParameters.Length;
                var primaryAcceptsArity = syntax.Arguments.Count <= primaryParameterCount;
                if (primaryAcceptsArity)
                {
                    for (var i = syntax.Arguments.Count; i < primaryParameterCount; i++)
                    {
                        primaryAcceptsArity &=
                            dataClassAggregate.PrimaryConstructorParameters[i].HasExplicitDefaultValue;
                    }
                }

                var hasMatchingSecondaryConstructor = false;
                if (!primaryAcceptsArity)
                {
                    foreach (var constructor in ClrTypeUtilities.SafeGetConstructors(
                                 resolvedClrType,
                                 BindingFlags.Public | BindingFlags.Instance))
                    {
                        if (constructor.GetParameters().Length == syntax.Arguments.Count)
                        {
                            hasMatchingSecondaryConstructor = true;
                            break;
                        }
                    }
                }

                if (!primaryAcceptsArity && hasMatchingSecondaryConstructor)
                {
                    var boundSecondary = TryBindClrConstructorFromType(
                        resolvedClrType,
                        syntax,
                        out result,
                        out var noApplicableSecondary,
                        out var secondaryArguments,
                        resultTypeOverride: dataClassAggregate);
                    if (boundSecondary)
                    {
                        result = Invariant.Required(
                            result,
                            "a successful secondary constructor binding produces a result");
                        return true;
                    }

                    return FinishClrConstructorBindingFailure(
                        syntax,
                        name,
                        noApplicableSecondary,
                        secondaryArguments,
                        ref result,
                        dataClassAggregate);
                }

                result = overloads.BindConstructorCallExpression(syntax, dataClassAggregate);
                return true;
            }

            var bound = TryBindClrConstructorFromType(
                resolvedClrType,
                syntax,
                out result,
                out var noApplicableOverload,
                out var aggregateArguments,
                resultTypeOverride: dataClassAggregate);
            if (bound)
            {
                result = Invariant.Required(
                    result,
                    "a successful aggregate constructor binding produces a result");
                return true;
            }

            return FinishClrConstructorBindingFailure(
                syntax,
                name,
                noApplicableOverload,
                aggregateArguments,
                ref result,
                dataClassAggregate);
        }

        if (TryBindClrConstructorFromType(
                resolvedClrType,
                syntax,
                out result,
                out var clrNoApplicableOverload,
                out var clrArguments,
                openGenericDefinition,
                symbolicTypeArgs))
        {
            return true;
        }

        if (openGenericDefinition == null
            && ImportedTypeSymbol.TryCreateSemanticAggregate(resolvedClrType, scope.References, out var aggregate)
            && aggregate.HasPrimaryConstructor)
        {
            result = overloads.BindConstructorCallExpression(syntax, aggregate);
            return true;
        }

        return FinishClrConstructorBindingFailure(
            syntax,
            name,
            clrNoApplicableOverload,
            clrArguments,
            ref result,
            TypeSymbol.FromClrType(resolvedClrType));
    }

    private bool FinishClrConstructorBindingFailure(
        CallExpressionSyntax syntax,
        string typeName,
        bool noApplicableOverload,
        ImmutableArray<BoundExpression> boundArguments,
        [NotNullWhen(true)] ref BoundExpression? result,
        TypeSymbol? conversionTarget = null)
    {
        if (noApplicableOverload
            && syntax.Arguments.Count == 1
            && boundArguments.Length == 1
            && conversionTarget != null)
        {
            if (syntax.NullableQuestionToken != null)
            {
                conversionTarget = NullableTypeSymbol.Get(conversionTarget);
            }

            var argument = boundArguments[0];
            if (Conversion.HasCheckedReferenceConversion(argument.Type, conversionTarget))
            {
                result = conversions.BindConversion(
                    syntax.Arguments[0].Location,
                    argument,
                    conversionTarget,
                    allowExplicit: true);
                return true;
            }
        }

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
                // Issue #3087: retain the erased shape of symbolic tuple
                // arguments. Flattening the whole argument to object made
                // List[(...)].Add and LINQ receiver inference see List<object>
                // instead of List<ValueTuple<...>>.
                hasSymbolicArg = true;
                if ((ta is TupleTypeSymbol
                        or NullableTypeSymbol { UnderlyingType: TupleTypeSymbol })
                    && MemberLookup.TryProjectErasedClrType(ta, out var projected))
                {
                    clrArgs[i] = scope.References.MapClrTypeToReferences(projected);
                }
                else
                {
                    clrArgs[i] = scope.References.GetCoreType("System.Object");
                }

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
    /// <param name="boundArgumentsOnFailure">
    /// Arguments already bound while testing constructor applicability.
    /// Populated when <paramref name="noApplicableOverload"/> is true so
    /// checked-reference fallback can reuse them without mutating binder state
    /// a second time.
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
        [NotNullWhen(true)] out BoundExpression? result,
        out bool noApplicableOverload,
        out ImmutableArray<BoundExpression> boundArgumentsOnFailure,
        System.Type? openGenericDefinition = null,
        ImmutableArray<TypeSymbol> symbolicTypeArgs = default,
        TypeSymbol? resultTypeOverride = null)
    {
        result = null;
        noApplicableOverload = false;
        boundArgumentsOnFailure = default;

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
        bool canAccessInternalConstructors = scope.References.CanAccessInternalMembers(clrType.Assembly);
        BindingFlags constructorFlags = BindingFlags.Public | BindingFlags.Instance;
        if (canAccessInternalConstructors)
        {
            constructorFlags |= BindingFlags.NonPublic;
        }

        var ctors = ClrTypeUtilities.SafeGetConstructors(clrType, constructorFlags)
            .Where(constructor =>
                constructor.IsPublic
                || (canAccessInternalConstructors
                    && (constructor.IsAssembly || constructor.IsFamilyOrAssembly)))
            .ToArray();

        var inlineOutArguments = GetInlineOutArgumentIndices(syntax);
        if (inlineOutArguments.Count > 0)
        {
            var invalidInlineOutArguments = inlineOutArguments
                .Where(index => !ctors.Any(constructor => ConstructorSupportsInlineOutArgument(
                    constructor,
                    argumentNames,
                    index)))
                .ToArray();
            if (invalidInlineOutArguments.Length > 0)
            {
                foreach (var index in invalidInlineOutArguments)
                {
                    Diagnostics.ReportOutDeclarationOutsideOutArgument(
                        OverloadResolver.UnwrapNamedArgumentValue(syntax.Arguments[index]).Location);
                }

                result = new BoundErrorExpression(syntax);
                return true;
            }

            ctors = ctors
                .Where(constructor => ConstructorSupportsInlineOutArguments(
                    constructor,
                    argumentNames,
                    inlineOutArguments))
                .ToArray();
        }

        var ctorParameterLists = new List<ParameterInfo[]>(ctors.Length);
        foreach (var constructor in ctors)
        {
            ctorParameterLists.Add(constructor.GetParameters());
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
        var symbolicCtorDelegateTargets = new Dictionary<int, TypeSymbol>();
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
                && openGenericDefinition is not null
                && TryResolveSymbolicDelegateTargetForCtor(
                    openGenericDefinition,
                    symbolicTypeArgs,
                    sourceArgIndex: i,
                    argName: argName,
                    out var symbolicTarget)
                && symbolicTarget is { } resolvedSymbolicTarget)
            {
                var literal = lambdas.BindLambdaExpression(
                    ctorLambdaSyntax,
                    resolvedSymbolicTarget.FunctionType);
                boundArguments.Add(ShouldConvertToNominalDelegate(resolvedSymbolicTarget.DelegateType)
                    ? conversions.BindConversion(
                        syntax.Arguments[i].Location,
                        literal,
                        resolvedSymbolicTarget.DelegateType)
                    : literal);
                symbolicCtorDelegateTargets[i] = resolvedSymbolicTarget.DelegateType;
                continue;
            }

            if (inner is RefArgumentExpressionSyntax refArgument)
            {
                boundArguments.Add(BindRefArgumentExpression(refArgument, parameter: null));
            }
            else
            {
                boundArguments.Add(BindCallArgumentWithDelegateTargetTyping(
                    syntax.Arguments[i],
                    ctorParameterLists,
                    sourceArgumentCount: syntax.Arguments.Count,
                    sourceArgIndex: i,
                    argName: argName,
                    paramOffset: 0));
            }
        }

        // Phase A (overload resolution): pick a constructor via the shared
        // "better function member" resolver. Ambiguity surfaces a hard
        // binder diagnostic and the call falls back to the surrounding
        // pipeline (which will diagnose a missing match).
        var argTypes = new System.Type?[boundArguments.Count];
        var argsAllTyped = true;
        var hasUserClassArg = false;
        for (var i = 0; i < boundArguments.Count; i++)
        {
            if (TryGetInlineOutVarArgument(syntax, i, out _))
            {
                argTypes[i] = ClrOverloadResolution.InlineOutVarArgumentType;
                continue;
            }

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
            System.Type? t;
            var priorErase = eraseDelegateInnerEnumToObject;
            eraseDelegateInnerEnumToObject = symbolicCtorDelegateTargets.ContainsKey(i);
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
                if (!ClrOverloadResolution.IsUnresolvedMethodGroupArgument(boundArguments[i]))
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

        ConstructorInfo? bestCtor = null;
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
            Func<Type, Type, bool>? supplementaryInterfaceCheck = null;
            if (hasUserClassArg)
            {
                supplementaryInterfaceCheck = CheckUserClassInterface;
            }

            bool CheckUserClassInterface(Type source, Type target) =>
                IsUserClassAssignableToInterface(boundArguments, argTypes, source, target);

            var resolution = ClrOverloadResolution.Resolve(
                ctors,
                argTypes,
                interpolatedStringArgs: ComputeInterpolatedStringArgFlags(syntax.Arguments, boundArguments.Count),
                argumentNames: argumentNames.IsDefault ? null : (IReadOnlyList<string?>)argumentNames,
                supplementaryInterfaceCheck: supplementaryInterfaceCheck,
                constantNarrowingArgumentCheck: MakeConstantNarrowingArgumentCheck(boundArguments),
                structuralProjectionArgumentCheck: MakeStructuralProjectionArgumentCheck(boundArguments),
                delegateRefKindArgumentCheck: MakeDelegateRefKindArgumentCheck(boundArguments));
            switch (resolution.Outcome)
            {
                case ClrOverloadResolution.ResolutionOutcome.Resolved:
                    bestCtor = Invariant.Required(
                        resolution.Best,
                        "a resolved constructor overload has a best constructor");
                    ctorMapping = resolution.ParameterMapping;
                    ctorIsExpanded = resolution.IsExpanded;
                    break;
                case ClrOverloadResolution.ResolutionOutcome.Ambiguous:
                    Diagnostics.ReportAmbiguousOverload(syntax.Location, clrType.Name, resolution.Ambiguous.Length, resolution.Ambiguous.Select(ClrOverloadResolution.FormatMethodSignature));
                    result = new BoundErrorExpression(syntax);
                    return true;
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
            boundArgumentsOnFailure = boundArguments.MoveToImmutable();
            return false;
        }

        var ctorParameters = bestCtor.GetParameters();
        var ctorRawArgs = RebindInlineOutConstructorArguments(
            syntax,
            boundArguments.MoveToImmutable(),
            bestCtor,
            ctorMapping,
            openGenericDefinition,
            symbolicTypeArgs);
        var ctorRefKinds = ComputeArgumentRefKinds(ctorParameters);
        var ctorExpandedArgs = ctorIsExpanded
            ? overloads.ExpandParamsArguments(ctorRawArgs, ctorParameters, syntax, parameterMapping: ctorMapping)
            : ctorRawArgs;

        // Issue #506 follow-up: when expanded form fires (with or without
        // named arguments), the expander emits the arguments already in
        // parameter order with optional slots filled — downstream reorderers
        // therefore consume an identity mapping.
        var ctorDownstreamMapping = ctorIsExpanded ? default : ctorMapping;
        Dictionary<int, TypeSymbol>? ctorParameterTypeOverrides = null;
        if (symbolicCtorDelegateTargets.Count > 0)
        {
            ctorParameterTypeOverrides = new Dictionary<int, TypeSymbol>();
            foreach (var pair in symbolicCtorDelegateTargets)
            {
                var parameterIndex = ctorDownstreamMapping.IsDefault
                    ? pair.Key
                    : ctorDownstreamMapping[pair.Key];
                ctorParameterTypeOverrides[parameterIndex] = pair.Value;
            }
        }

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
            out _,
            parameterTypeOverrides: ctorParameterTypeOverrides);
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

    private static List<int> GetInlineOutArgumentIndices(CallExpressionSyntax syntax)
    {
        var result = new List<int>();
        for (var i = 0; i < syntax.Arguments.Count; i++)
        {
            if (OverloadResolver.UnwrapNamedArgumentValue(syntax.Arguments[i])
                is RefArgumentExpressionSyntax { IsInlineDeclaration: true })
            {
                result.Add(i);
            }
        }

        return result;
    }

    private static bool ConstructorSupportsInlineOutArguments(
        ConstructorInfo constructor,
        ImmutableArray<string> argumentNames,
        IReadOnlyList<int> inlineOutArguments)
    {
        foreach (var sourceIndex in inlineOutArguments)
        {
            if (!ConstructorSupportsInlineOutArgument(
                    constructor,
                    argumentNames,
                    sourceIndex))
            {
                return false;
            }
        }

        return true;
    }

    private static bool ConstructorSupportsInlineOutArgument(
        ConstructorInfo constructor,
        ImmutableArray<string> argumentNames,
        int sourceIndex)
    {
        var parameters = constructor.GetParameters();
        var name = argumentNames.IsDefault ? null : argumentNames[sourceIndex];
        var parameterIndex = name == null
            ? sourceIndex
            : FindClrParameterIndex(parameters, name);
        return parameterIndex >= 0
            && parameterIndex < parameters.Length
            && parameters[parameterIndex].IsOut
            && !parameters[parameterIndex].IsIn;
    }

    private static int FindClrParameterIndex(ParameterInfo[] parameters, string argumentName)
    {
        var parameterNames = parameters.Select(parameter => parameter.Name ?? string.Empty).ToArray();
        for (var i = 0; i < parameters.Length; i++)
        {
            if (OverloadResolver.ClrParameterNameMatches(
                    parameters[i].Name ?? string.Empty,
                    argumentName,
                    parameterNames))
            {
                return i;
            }
        }

        return -1;
    }

    private ImmutableArray<BoundExpression> RebindInlineOutConstructorArguments(
        CallExpressionSyntax syntax,
        ImmutableArray<BoundExpression> arguments,
        ConstructorInfo constructor,
        ImmutableArray<int> parameterMapping,
        Type? openGenericDefinition,
        ImmutableArray<TypeSymbol> symbolicTypeArguments)
    {
        ImmutableArray<BoundExpression>.Builder? rebuilt = null;
        var parameters = constructor.GetParameters();
        for (var i = 0; i < arguments.Length; i++)
        {
            if (!TryGetInlineOutVarArgument(syntax, i, out var refArgument))
            {
                continue;
            }

            var parameterIndex = parameterMapping.IsDefault ? i : parameterMapping[i];
            var parameter = parameters[parameterIndex];
            var pointeeType = ResolveConstructorParameterPointeeType(
                constructor,
                parameterIndex,
                openGenericDefinition,
                symbolicTypeArguments)
                ?? TypeSymbol.FromClrType(parameter.ParameterType.GetElementType());
            var syntheticParameter = new ParameterSymbol(
                parameter.Name ?? "value",
                pointeeType,
                refKind: RefKind.Out);
            rebuilt ??= arguments.ToBuilder();
            rebuilt[i] = BindRefArgumentExpression(refArgument, syntheticParameter);
        }

        return rebuilt?.ToImmutable() ?? arguments;
    }

    private static TypeSymbol? ResolveConstructorParameterPointeeType(
        ConstructorInfo constructor,
        int parameterIndex,
        Type? openGenericDefinition,
        ImmutableArray<TypeSymbol> symbolicTypeArguments)
    {
        if (openGenericDefinition == null || symbolicTypeArguments.IsDefaultOrEmpty)
        {
            return null;
        }

        var openConstructor = ClrTypeUtilities.SafeGetConstructors(
                openGenericDefinition,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
            .FirstOrDefault(candidate =>
                candidate.MetadataToken == constructor.MetadataToken
                && candidate.Module == constructor.Module);
        if (openConstructor == null)
        {
            return null;
        }

        var openParameters = openConstructor.GetParameters();
        if (parameterIndex >= openParameters.Length)
        {
            return null;
        }

        var openPointee = openParameters[parameterIndex].ParameterType.GetElementType();
        return openPointee == null
            ? null
            : MemberLookup.MapOpenClrTypeToSymbolic(
                openPointee,
                openGenericDefinition,
                symbolicTypeArguments);
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
        int sourceArgumentCount,
        int sourceArgIndex,
        string? argName,
        int paramOffset)
    {
        var inner = OverloadResolver.UnwrapNamedArgumentValue(argumentSyntax);
        if (IsTargetDependentBlockArgumentSyntax(inner)
            && TryResolveTargetDependentBlockTarget(
                candidateParameterLists,
                paramOffset,
                sourceArgumentCount,
                sourceArgIndex,
                argName,
                inner,
                out var blockTarget))
        {
            return BindExpression(inner, blockTarget);
        }

        if (inner is LambdaExpressionSyntax lambdaSyntax
            && TryResolveDelegateTargetFromCandidates(
                candidateParameterLists,
                paramOffset,
                sourceArgIndex,
                argName,
                out var target,
                out var nominalTarget,
                out _,
                out _))
        {
            return BindLambdaWithDelegateTarget(
                argumentSyntax,
                lambdaSyntax,
                target,
                nominalTarget);
        }

        return BindExpression(inner);
    }

    private BoundExpression BindLambdaWithDelegateTarget(
        ExpressionSyntax argumentSyntax,
        LambdaExpressionSyntax lambdaSyntax,
        FunctionTypeSymbol target,
        TypeSymbol? nominalTarget)
    {
        var literal = lambdas.BindLambdaExpression(lambdaSyntax, target);
        return nominalTarget != null && ShouldConvertToNominalDelegate(nominalTarget)
            ? conversions.BindConversion(argumentSyntax.Location, literal, nominalTarget)
            : literal;
    }

    /// <summary>
    /// Issue #891 / #2345 / #3149: discovers the closed delegate function shape
    /// and nominal identity shared by a lambda argument's candidate parameters.
    /// Open generic candidates are reported separately so all-open block lambdas
    /// and mixed open/closed sets can wait for overload resolution.
    /// </summary>
    private static bool TryResolveDelegateTargetFromCandidates(
        IReadOnlyList<ParameterInfo[]> candidateParameterLists,
        int paramOffset,
        int sourceArgIndex,
        string? argName,
        [NotNullWhen(true)] out FunctionTypeSymbol? target,
        out TypeSymbol? nominalTarget,
        out bool blockedByOpenGenericParameter,
        out bool sawOpenGenericParameter)
    {
        target = default;
        nominalTarget = null;
        blockedByOpenGenericParameter = false;
        sawOpenGenericParameter = false;
        var nominalTargetsAgree = true;
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
                sawOpenGenericParameter = true;
                continue;
            }

            // Issue #2782: a general Delegate candidate has no Invoke shape with which to
            // contextually bind the lambda. It can still win overload
            // resolution, so a sibling's concrete delegate signature must not
            // pin (and potentially erase) the lambda's natural return type.
            var parameterFullName = parameterType.FullName;
            if (string.Equals(parameterFullName, "System.Delegate", StringComparison.Ordinal)
                || string.Equals(parameterFullName, "System.MulticastDelegate", StringComparison.Ordinal))
            {
                target = default;
                nominalTarget = null;
                blockedByOpenGenericParameter = false;
                sawOpenGenericParameter = false;
                return false;
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
                target = default;
                nominalTarget = null;
                blockedByOpenGenericParameter = false;
                sawOpenGenericParameter = false;
                return false;
            }

            var nominalCandidate = TypeSymbol.FromClrType(parameterType);
            if (nominalTargetsAgree)
            {
                if (nominalTarget == null)
                {
                    nominalTarget = nominalCandidate;
                }
                else if (!SameDelegateIdentity(nominalTarget, nominalCandidate))
                {
                    // Issue #3149: reached but not mutation-pinned. TryBindClrConstructorCall
                    // is the sole constructor caller; BindAccessorCall also consumes this output.
                    nominalTarget = null;
                    nominalTargetsAgree = false;
                }
            }
        }

        // Only report the "blocked" signal when every matching slot was open —
        // if some candidate produced a usable closed target, that target wins
        // and there is nothing left to defer.
        blockedByOpenGenericParameter = blockedByOpenGenericParameter && target == null && sawAnyMatchingSlot;

        // Issue #3149: reached but not mutation-pinned. BindAccessorCall consumes
        // sawOpen to defer mixed open/closed candidates, so this reset must remain.
        if (sawOpenGenericParameter)
        {
            nominalTarget = null;
        }

        return target != null;
    }

    /// <summary>
    /// Issue #1502: resolves the symbolic delegate target shape for a lambda
    /// argument at <paramref name="sourceArgIndex"/> (or named
    /// <paramref name="argName"/>) of a constructed-generic CLR constructor whose
    /// type arguments include a same-compilation user-defined type. The closed
    /// CLR ctor parameter is type-erased (e.g. <c>Func&lt;object&gt;</c>); this
    /// recovers the exact mapped delegate identity and its real shape (e.g.
    /// <c>Func&lt;Foo&gt;</c> and <c>() -&gt; Foo</c>) by substituting the
    /// receiver's symbolic type arguments through the OPEN constructor's
    /// parameter type. Returns <see langword="false"/> (deferring to the ordinary
    /// erased path) when there is no symbolic substitution in effect, when the
    /// candidate ctors disagree on identity or shape, or when no open ctor
    /// exposes a delegate parameter at that position.
    /// </summary>
    private static bool TryResolveSymbolicDelegateTargetForCtor(
        Type openGenericDefinition,
        ImmutableArray<TypeSymbol> symbolicTypeArgs,
        int sourceArgIndex,
        string? argName,
        [NotNullWhen(true)] out SymbolicDelegateTarget? target)
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

            if (!TryBuildSymbolicDelegateTarget(
                    parameters[paramIndex].ParameterType,
                    openGenericDefinition,
                    symbolicTypeArgs,
                    out var mappedDelegate,
                    out var candidate)
                || mappedDelegate is null
                || candidate is null)
            {
                continue;
            }

            if (target == null)
            {
                target = new SymbolicDelegateTarget(mappedDelegate, candidate);
            }
            else if (!SameDelegateIdentity(target.DelegateType, mappedDelegate)
                || (!ReferenceEquals(target.FunctionType, candidate)
                    && !target.FunctionType.Equals(candidate)))
            {
                target = null;
                return false;
            }
        }

        return target is { FunctionType: not null };
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
    private bool TryBindNestedTypeConstructorCall(
        System.Type containingType,
        CallExpressionSyntax syntax,
        [NotNullWhen(true)] out BoundExpression? result)
    {
        result = null;
        var nestedName = syntax.Identifier.Text;
        var arity = syntax.TypeArgumentList?.Arguments.Count ?? 0;

        System.Type? nestedType = null;

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
            if (syntax.TypeArgumentList is not TypeArgumentListSyntax typeArguments)
            {
                return false;
            }

            var clrArgs = new System.Type[arity];
            for (var i = 0; i < arity; i++)
            {
                var ta = bindTypeClause(typeArguments.Arguments[i]);
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
            out var noApplicableOverload,
            out var boundArguments);
        return bound || FinishClrConstructorBindingFailure(
            syntax,
            nestedType.Name,
            noApplicableOverload,
            boundArguments,
            ref result,
            TypeSymbol.FromClrType(nestedType));
    }

    private sealed class SymbolicDelegateTarget
    {
        public SymbolicDelegateTarget(
            TypeSymbol delegateType,
            FunctionTypeSymbol functionType)
        {
            DelegateType = delegateType;
            FunctionType = functionType;
        }

        public TypeSymbol DelegateType { get; }

        public FunctionTypeSymbol FunctionType { get; }
    }
}
