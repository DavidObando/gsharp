// <copyright file="StatementBinder.Loops.cs" company="GSharp">
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
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class StatementBinder
{
    private static TypeSymbol GetIteratorElementType(TypeSymbol type)
    {
        if (type is SequenceTypeSymbol seq)
        {
            return seq.ElementType;
        }

        // Issue #798: `async sequence[T]` (ADR-0041) is AsyncSequenceTypeSymbol;
        // surface its ElementType the same way SequenceTypeSymbol does so
        // `yield` accepts the symbolic T rather than collapsing to `object`
        // through the type-erased ClrType.
        if (type is AsyncSequenceTypeSymbol aseq)
        {
            return aseq.ElementType;
        }

        // #313 / issue #798: when the iterator return type is an
        // `ImportedTypeSymbol` constructed over symbolic type arguments
        // (e.g. `IEnumerable[T]` / `IAsyncEnumerable[T]` inside a generic
        // function), prefer the symbolic TypeArguments[0] over the
        // type-erased ClrType form (`IEnumerable<object>`). Otherwise the
        // element type collapses to `object`, and `yield v` where `v: T`
        // fails to bind because the binder doesn't accept the implicit
        // `T → object` conversion ("Cannot convert type 'T' to 'object'").
        if (type is ImportedTypeSymbol importedSym
            && importedSym.OpenDefinition != null
            && !importedSym.TypeArguments.IsDefaultOrEmpty)
        {
            var def = importedSym.OpenDefinition;
            if (def.FullName == "System.Collections.Generic.IEnumerable`1" ||
                def.FullName == "System.Collections.Generic.IEnumerator`1" ||
                def.FullName == "System.Collections.Generic.IAsyncEnumerable`1" ||
                def.FullName == "System.Collections.Generic.IAsyncEnumerator`1")
            {
                return importedSym.TypeArguments[0];
            }
        }

        var clr = type?.ClrType;
        if (clr == null)
        {
            return TypeSymbol.FromClrType(typeof(object));
        }

        if (clr.IsGenericType && !clr.IsGenericTypeDefinition)
        {
            var def = clr.GetGenericTypeDefinition();
            if (def.FullName == "System.Collections.Generic.IEnumerable`1" ||
                def.FullName == "System.Collections.Generic.IEnumerator`1")
            {
                return TypeSymbol.FromClrType(clr.GetGenericArguments()[0]);
            }

            // Async iterators: IAsyncEnumerable<T> / IAsyncEnumerator<T>
            if (def.FullName == "System.Collections.Generic.IAsyncEnumerable`1" ||
                def.FullName == "System.Collections.Generic.IAsyncEnumerator`1")
            {
                return TypeSymbol.FromClrType(clr.GetGenericArguments()[0]);
            }
        }

        return TypeSymbol.FromClrType(typeof(object));
    }

    private TypeSymbol ResolveExceptionType()
    {
        if (scope.References.TryResolveType("System.Exception", out var t))
        {
            return TypeSymbol.FromClrType(t);
        }

        return null;
    }

    private BoundStatement BindForInfiniteStatement(ForInfiniteStatementSyntax syntax)
    {
        return BindForInfiniteStatementCore(syntax, syntax.Body, labelName: null);
    }

    /// <summary>
    /// Binds a <c>for { body }</c> infinite loop, with optional ADR-0070 label.
    /// </summary>
    /// <param name="originatingSyntax">Originating syntax for diagnostics.</param>
    /// <param name="bodySyntax">The loop body.</param>
    /// <param name="labelName">The ADR-0070 label, or <see langword="null"/>.</param>
    /// <returns>The bound for-infinite statement.</returns>
    private BoundStatement BindForInfiniteStatementCore(SyntaxNode originatingSyntax, StatementSyntax bodySyntax, string labelName)
    {
        scope = new BoundScope(scope);

        var body = BindLoopBody(bodySyntax, labelName, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        return new BoundForInfiniteStatement(null, body, breakLabel, continueLabel);
    }

    private BoundStatement BindForEllipsisStatement(ForEllipsisStatementSyntax syntax)
    {
        return BindForEllipsisStatementCore(syntax, syntax, labelName: null);
    }

    private BoundStatement BindForEllipsisStatementCore(ForEllipsisStatementSyntax syntax, SyntaxNode originatingSyntax, string labelName)
    {
        var lowerBound = bindExpressionWithTargetType(syntax.LowerBound, TypeSymbol.Int32);
        var upperBound = bindExpressionWithTargetType(syntax.UpperBound, TypeSymbol.Int32);

        scope = new BoundScope(scope);

        var variable = bindLocalVariable(syntax.Identifier, isReadOnly: false, type: TypeSymbol.Int32);
        var body = BindLoopBody(syntax.Body, labelName, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        return new BoundForEllipsisStatement(null, variable, lowerBound, upperBound, body, breakLabel, continueLabel);
    }

    private BoundStatement BindForRangeStatement(ForRangeStatementSyntax syntax)
    {
        return BindForRangeStatementCore(syntax, labelName: null, originatingSyntax: syntax);
    }

    private BoundStatement BindForTupleRangeStatement(ForTupleRangeStatementSyntax syntax)
    {
        return BindForTupleRangeStatementCore(syntax, labelName: null, originatingSyntax: syntax);
    }

    /// <summary>
    /// Issue #1922: binds <c>for (a, b, ...) in coll { ... }</c> by
    /// synthesizing a hidden single-identifier <see cref="ForRangeStatementSyntax"/>
    /// (same shape cs2gs used to hand-emit as a temp variable plus a separate
    /// <c>let (a, b) = tmp</c>) and delegating to
    /// <see cref="BindForRangeStatementCore"/>'s <c>bindLoopPrelude</c> hook —
    /// so every iteration strategy (arrays, slices, dictionaries, CLR/pattern
    /// enumerables, sequences, strings) keeps working with zero duplication.
    /// </summary>
    /// <param name="syntax">The deconstructing for-range syntax.</param>
    /// <param name="labelName">The ADR-0070 label, or <see langword="null"/>.</param>
    /// <param name="originatingSyntax">Syntax node used for the resulting bound node.</param>
    /// <returns>The bound for-range statement.</returns>
    private BoundStatement BindForTupleRangeStatementCore(ForTupleRangeStatementSyntax syntax, string labelName, SyntaxNode originatingSyntax)
    {
        var tempName = $"<fortuple{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>";
        var tempIdentifier = new SyntaxToken(syntax.SyntaxTree, SyntaxKind.IdentifierToken, syntax.OpenParenToken.Position, tempName, null);
        var syntheticForRange = new ForRangeStatementSyntax(
            syntax.SyntaxTree,
            syntax.Keyword,
            tempIdentifier,
            commaToken: null,
            secondIdentifier: null,
            colonEqualsToken: null,
            rangeKeyword: null,
            inToken: syntax.InToken,
            collection: syntax.Collection,
            body: syntax.Body);

        return BindForRangeStatementCore(
            syntheticForRange,
            labelName,
            originatingSyntax,
            bindLoopPrelude: elementVariable => BindForTupleLoopPrelude(
                syntax.Identifiers,
                syntax.CloseParenToken.Location,
                syntax.OpenParenToken.Location,
                elementVariable));
    }

    /// <summary>
    /// Core for-range binder; accepts an optional ADR-0070 label name that is
    /// pushed onto the loop stack so a nested <c>break label</c> / <c>continue
    /// label</c> resolves to this loop's targets.
    /// </summary>
    /// <param name="syntax">The for-range syntax.</param>
    /// <param name="labelName">The ADR-0070 label, or <see langword="null"/>.</param>
    /// <param name="originatingSyntax">Syntax node used for the resulting bound node.</param>
    /// <param name="bindLoopPrelude">
    /// Issue #1922: optional hook invoked with the newly-declared single loop
    /// variable, still inside its scope, right before the body is bound.
    /// Lets <c>for (a, b) in coll</c> declare its deconstructed element
    /// locals (visible to the body) and return the field-extraction
    /// statements to prepend, reusing this method's entire iteration-strategy
    /// dispatch (arrays, slices, dictionaries, CLR/pattern enumerables,
    /// sequences, strings) instead of duplicating it.
    /// </param>
    /// <returns>The bound for-range statement.</returns>
    private BoundStatement BindForRangeStatementCore(
        ForRangeStatementSyntax syntax,
        string labelName,
        SyntaxNode originatingSyntax,
        Func<VariableSymbol, ImmutableArray<BoundStatement>> bindLoopPrelude = null)
    {
        var collection = bindExpression(syntax.Collection);

        // Decide iteration strategy and element/key types based on the
        // collection type.
        ForRangeKind iterationKind;
        TypeSymbol keyType;
        TypeSymbol valueType;
        switch (collection.Type)
        {
            case ArrayTypeSymbol arr:
                iterationKind = ForRangeKind.Indexed;
                keyType = TypeSymbol.Int32;
                valueType = arr.ElementType;
                break;
            case SliceTypeSymbol slice:
                iterationKind = ForRangeKind.Indexed;
                keyType = TypeSymbol.Int32;
                valueType = slice.ElementType;
                break;

            // Issue #209: NullabilityAnnotatedTypeSymbol carries inner-position nullable
            // flags; extract element/key/value types using those flags so that
            // `for k, v := range dict` sees the proper nullable types.
            case NullabilityAnnotatedTypeSymbol annotated when annotated.ClrType != null:
                // Issue #520: CLR SZ arrays (`T[]`) implement IEnumerable<T> via
                // runtime magic but `Array.GetEnumerator()` returns the non-generic
                // IEnumerator whose Current is System.Object. Routing them through
                // the Enumerable path would assign a boxed reference into the
                // value-typed loop variable (the pointer's low 32 bits surface as
                // garbage). Use the Indexed path instead so we emit `ldelem <T>`
                // with the array's actual element type — same lowering C#'s
                // `foreach (T x in arr)` produces.
                if (annotated.ClrType.IsArray && annotated.ClrType.GetArrayRank() == 1)
                {
                    iterationKind = ForRangeKind.Indexed;
                    keyType = TypeSymbol.Int32;
                    valueType = annotated.GetTypeArgumentSymbolForClrType(annotated.ClrType.GetElementType());
                }
                else if (MemberLookup.TryGetClrDictionaryTypes(annotated.ClrType, out var aDKey, out var aDVal))
                {
                    iterationKind = ForRangeKind.Dictionary;
                    keyType = annotated.GetTypeArgumentSymbolForClrType(aDKey);
                    valueType = annotated.GetTypeArgumentSymbolForClrType(aDVal);
                }
                else if (MemberLookup.TryGetClrEnumerableElementType(annotated.ClrType, out var aElemType))
                {
                    iterationKind = ForRangeKind.Enumerable;
                    keyType = TypeSymbol.Int32;
                    valueType = annotated.GetTypeArgumentSymbolForClrType(aElemType);
                }
                else if (MemberLookup.TryGetClrPatternEnumerableElementType(annotated.ClrType, out var aPatternElemType))
                {
                    iterationKind = ForRangeKind.PatternEnumerator;
                    keyType = TypeSymbol.Int32;
                    valueType = TypeSymbol.FromClrType(aPatternElemType);
                }
                else
                {
                    Diagnostics.ReportTypeNotIndexable(syntax.Collection.Location, collection.Type);
                    return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
                }

                break;

            // Issue #774: an open generic receiver such as `IEnumerable[T]`,
            // `Dictionary[K, V]`, or a user `MyList[T]` carries symbolic
            // type arguments on the ImportedTypeSymbol while its ClrType is
            // erased to the corresponding `<object>` shape. Probe the
            // OpenDefinition for the enumerable / dictionary shape and map
            // each open CLR type argument back to the symbolic argument so
            // the loop variable's type is the user's `T` (not `object`).
            //
            // Issue #939: this path must also fire when the symbolic type
            // argument is a *same-compilation* user `class`/`data struct`
            // (e.g. `List[Item]`). Such arguments are not type parameters, so
            // `HasTypeParameterArgument` is false, yet their CLR type is still
            // erased to `<object>` on the closed `ClrType`. Mirror the indexer
            // path's `MapErasedIndexerElementType` substitutability test so the
            // loop variable recovers the member-bearing user `Item` symbol
            // rather than the erased `object`.
            case ImportedTypeSymbol openImp when openImp.OpenDefinition != null && openImp.HasSubstitutableTypeArgument:
                if (MemberLookup.TryGetClrDictionaryTypes(openImp.OpenDefinition, out var openDKey, out var openDVal))
                {
                    iterationKind = ForRangeKind.Dictionary;
                    keyType = MapOpenClrTypeToSymbolic(openDKey, openImp);
                    valueType = MapOpenClrTypeToSymbolic(openDVal, openImp);
                }
                else if (MemberLookup.TryGetClrEnumerableElementType(openImp.OpenDefinition, out var openElemType))
                {
                    iterationKind = ForRangeKind.Enumerable;
                    keyType = TypeSymbol.Int32;
                    valueType = MapOpenClrTypeToSymbolic(openElemType, openImp);
                }
                else if (MemberLookup.TryGetClrPatternEnumerableElementType(openImp.OpenDefinition, out var openPatternElemType))
                {
                    iterationKind = ForRangeKind.PatternEnumerator;
                    keyType = TypeSymbol.Int32;
                    valueType = MapOpenClrTypeToSymbolic(openPatternElemType, openImp);
                }
                else
                {
                    Diagnostics.ReportTypeNotIndexable(syntax.Collection.Location, collection.Type);
                    return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
                }

                break;
            case ImportedTypeSymbol imp when imp.ClrType != null:
                // Issue #520: CLR SZ arrays (`T[]`) — see the matching note in the
                // NullabilityAnnotatedTypeSymbol branch above. Detect first and
                // route to the Indexed path so iteration emits `ldelem <T>`
                // (type-aware) rather than walking a boxing IEnumerator.
                if (imp.ClrType.IsArray && imp.ClrType.GetArrayRank() == 1)
                {
                    iterationKind = ForRangeKind.Indexed;
                    keyType = TypeSymbol.Int32;
                    valueType = TypeSymbol.FromClrType(imp.ClrType.GetElementType());
                }
                else if (MemberLookup.TryGetClrDictionaryTypes(imp.ClrType, out var dKey, out var dVal))
                {
                    iterationKind = ForRangeKind.Dictionary;
                    keyType = TypeSymbol.FromClrType(dKey);
                    valueType = TypeSymbol.FromClrType(dVal);
                }
                else if (MemberLookup.TryGetClrEnumerableElementType(imp.ClrType, out var elemType))
                {
                    iterationKind = ForRangeKind.Enumerable;
                    keyType = TypeSymbol.Int32;
                    valueType = TypeSymbol.FromClrType(elemType);
                }
                else if (MemberLookup.TryGetClrPatternEnumerableElementType(imp.ClrType, out var patternElemType))
                {
                    iterationKind = ForRangeKind.PatternEnumerator;
                    keyType = TypeSymbol.Int32;
                    valueType = TypeSymbol.FromClrType(patternElemType);
                }
                else
                {
                    Diagnostics.ReportTypeNotIndexable(syntax.Collection.Location, collection.Type);
                    return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
                }

                break;
            case StructSymbol userType when MemberLookup.TryGetUserPatternEnumerableElementType(userType, out var userElemType):
                iterationKind = ForRangeKind.PatternEnumerator;
                keyType = TypeSymbol.Int32;
                valueType = userElemType;
                break;
            case SequenceTypeSymbol seq:
                // ADR-0040: sequence[T] is IEnumerable[T] — iterate via Enumerable strategy.
                iterationKind = ForRangeKind.Enumerable;
                keyType = TypeSymbol.Int32;
                valueType = seq.ElementType;
                break;
            default:
                // Issue #537: `string` is iterable over `char` via its indexer
                // and Length property — same fast-path C# uses for
                // `foreach (char c in str)`.
                if (collection.Type == TypeSymbol.String)
                {
                    iterationKind = ForRangeKind.Indexed;
                    keyType = TypeSymbol.Int32;
                    valueType = TypeSymbol.Char;
                    break;
                }

                if (collection.Type != TypeSymbol.Error)
                {
                    Diagnostics.ReportTypeNotIndexable(syntax.Collection.Location, collection.Type);
                }

                return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        scope = new BoundScope(scope);

        VariableSymbol keyVariable = null;
        VariableSymbol valueVariable;
        if (syntax.SecondIdentifier != null)
        {
            keyVariable = bindLocalVariable(syntax.FirstIdentifier, isReadOnly: false, type: keyType);
            valueVariable = bindLocalVariable(syntax.SecondIdentifier, isReadOnly: false, type: valueType);
        }
        else
        {
            // `for v := range coll` — single var binds the value/element.
            //
            // Issue #1328: a SINGLE-identifier iteration over a dictionary
            // binds the whole `KeyValuePair[K, V]` element (the static type of
            // `Current`), matching `foreach (var kv in dict)` and single-var
            // iteration over an `IEnumerable[KeyValuePair[K, V]]`. The two-var
            // form `for k, v in dict` continues to destructure into K and V.
            // The symbolic `[K, V]` arguments are preserved so `kv.Key`/`kv.Value`
            // expose the user element types rather than erasing to `object`.
            var singleVarType = iterationKind == ForRangeKind.Dictionary
                ? BuildKeyValuePairType(keyType, valueType)
                : valueType;
            valueVariable = bindLocalVariable(syntax.FirstIdentifier, isReadOnly: false, type: singleVarType);
        }

        var prelude = bindLoopPrelude?.Invoke(valueVariable) ?? ImmutableArray<BoundStatement>.Empty;
        var body = BindLoopBody(syntax.Body, labelName, out var breakLabel, out var continueLabel);
        if (!prelude.IsEmpty)
        {
            body = new BoundBlockStatement(originatingSyntax, prelude.Add(body));
        }

        scope = scope.Parent;

        return new BoundForRangeStatement(originatingSyntax, keyVariable, valueVariable, collection, iterationKind, body, breakLabel, continueLabel);
    }

    /// <summary>
    /// Issue #774: maps an open generic CLR <see cref="Type"/> (such as the
    /// element type extracted from <c>IEnumerable&lt;TParam&gt;</c>) back to
    /// the symbolic <see cref="TypeSymbol"/> carried on
    /// <paramref name="openImp"/>'s <see cref="ImportedTypeSymbol.TypeArguments"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// For a generic parameter declared on <see cref="ImportedTypeSymbol.OpenDefinition"/>,
    /// the result is the symbolic argument at the same ordinal — e.g. the
    /// <c>T</c> in <c>IEnumerable[T]</c> becomes the function-level
    /// <see cref="TypeParameterSymbol"/> <c>T</c>.
    /// </para>
    /// <para>
    /// For a constructed generic type whose arguments transitively reference
    /// open parameters (e.g. <c>KeyValuePair&lt;TKey, TValue&gt;</c> on
    /// <c>Dictionary&lt;TKey, TValue&gt;</c>), the helper recurses and
    /// reconstructs the closed shape via <see cref="ImportedTypeSymbol.GetConstructed"/>
    /// so downstream emit keeps the symbolic projection.
    /// </para>
    /// <para>
    /// For anything else (closed primitive, unrelated CLR type, unmapped
    /// parameter), falls back to <see cref="TypeSymbol.FromClrType"/>.
    /// </para>
    /// </remarks>
    /// <summary>
    /// Issue #774: maps an open generic CLR <see cref="Type"/> back to the
    /// matching symbolic <see cref="TypeSymbol"/> on
    /// <paramref name="openImp"/>. Thin local wrapper kept so the existing
    /// case body reads cleanly; the implementation lives on
    /// <see cref="MemberLookup"/> so the lowerer can reuse it when
    /// synthesising symbolic enumerator types.
    /// </summary>
    /// <param name="openClr">The open CLR type to map.</param>
    /// <param name="openImp">The receiver carrying symbolic type arguments.</param>
    /// <returns>The mapped <see cref="TypeSymbol"/>.</returns>
    private static TypeSymbol MapOpenClrTypeToSymbolic(Type openClr, ImportedTypeSymbol openImp)
        => MemberLookup.MapOpenClrTypeToSymbolic(openClr, openImp);

    /// <summary>
    /// Issue #1328: builds the symbolic <c>KeyValuePair[K, V]</c> element type
    /// for a single-identifier dictionary iteration. The closed
    /// <c>ImportedTypeSymbol.ClrType</c> is the type-erased
    /// <c>KeyValuePair&lt;object, object&gt;</c> (mirroring the #313/#671
    /// convention) while the symbolic <c>[K, V]</c> arguments are preserved so
    /// member access on the loop variable (<c>kv.Key</c>/<c>kv.Value</c>)
    /// recovers the user element types instead of erasing to <c>object</c>.
    /// This matches the element type the lowerer synthesises for the same loop
    /// (<see cref="System.Collections.Generic.IEnumerable{T}"/> of
    /// <c>KeyValuePair[K, V]</c>).
    /// </summary>
    /// <param name="keyType">The symbolic key type <c>K</c>.</param>
    /// <param name="valueType">The symbolic value type <c>V</c>.</param>
    /// <returns>The constructed <c>KeyValuePair[K, V]</c> symbol.</returns>
    private static TypeSymbol BuildKeyValuePairType(TypeSymbol keyType, TypeSymbol valueType)
        => ImportedTypeSymbol.GetConstructed(
            typeof(System.Collections.Generic.KeyValuePair<object, object>),
            typeof(System.Collections.Generic.KeyValuePair<,>),
            ImmutableArray.Create(keyType, valueType));

    private BoundStatement BindForConditionStatement(ForConditionStatementSyntax syntax)
    {
        return BindForConditionStatementCore(syntax, syntax.Condition, syntax.Body, labelName: null);
    }

    /// <summary>
    /// Core <c>for cond { body }</c> binder; accepts an optional ADR-0070 label.
    /// </summary>
    /// <param name="originatingSyntax">Originating syntax for diagnostics.</param>
    /// <param name="conditionSyntax">Loop condition.</param>
    /// <param name="bodySyntax">Loop body.</param>
    /// <param name="labelName">The ADR-0070 label, or <see langword="null"/>.</param>
    /// <returns>The lowered bound block.</returns>
    private BoundStatement BindForConditionStatementCore(
        SyntaxNode originatingSyntax,
        ExpressionSyntax conditionSyntax,
        StatementSyntax bodySyntax,
        string labelName)
    {
        // Lowers to:
        //   {
        //     goto checkLabel
        //     bodyLabel:
        //     <body>
        //     continueLabel:
        //     checkLabel:
        //     if cond goto bodyLabel
        //     breakLabel:
        //   }
        scope = new BoundScope(scope);

        var condition = bindExpressionWithTargetType(conditionSyntax, TypeSymbol.Bool);
        var body = BindLoopBody(bodySyntax, labelName, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        var bodyLabel = new BoundLabel($"body{binderCtx.LabelCounter}");
        var checkLabel = new BoundLabel($"check{binderCtx.LabelCounter}");

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(new BoundGotoStatement(originatingSyntax, checkLabel));
        statements.Add(new BoundLabelStatement(originatingSyntax, bodyLabel));
        statements.Add(body);
        statements.Add(new BoundLabelStatement(originatingSyntax, continueLabel));
        statements.Add(new BoundLabelStatement(originatingSyntax, checkLabel));
        statements.Add(new BoundConditionalGotoStatement(originatingSyntax, bodyLabel, condition, jumpIfTrue: true));
        statements.Add(new BoundLabelStatement(originatingSyntax, breakLabel));

        return new BoundBlockStatement(originatingSyntax, statements.ToImmutable());
    }

    private BoundStatement BindForClauseStatement(ForClauseStatementSyntax syntax)
    {
        return BindForClauseStatementCore(syntax, syntax, labelName: null);
    }

    /// <summary>
    /// Core C-style <c>for init; cond; post { body }</c> binder; accepts an
    /// optional ADR-0070 label.
    /// </summary>
    /// <param name="syntax">The for-clause syntax.</param>
    /// <param name="originatingSyntax">Syntax used for bound-node diagnostics.</param>
    /// <param name="labelName">The ADR-0070 label, or <see langword="null"/>.</param>
    /// <returns>The lowered bound block.</returns>
    private BoundStatement BindForClauseStatementCore(ForClauseStatementSyntax syntax, SyntaxNode originatingSyntax, string labelName)
    {
        // Lowers to:
        //   {
        //     <init>?
        //     goto checkLabel
        //     bodyLabel:
        //     <body>
        //     continueLabel:
        //     <post>?
        //     checkLabel:
        //     [if cond] goto bodyLabel
        //     breakLabel:
        //   }
        scope = new BoundScope(scope);

        var init = syntax.Initializer == null ? null : BindStatement(syntax.Initializer);
        var condition = syntax.Condition == null ? null : bindExpressionWithTargetType(syntax.Condition, TypeSymbol.Bool);
        var post = syntax.Post == null ? null : BindStatement(syntax.Post);
        var body = BindLoopBody(syntax.Body, labelName, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        var bodyLabel = new BoundLabel($"body{binderCtx.LabelCounter}");
        var checkLabel = new BoundLabel($"check{binderCtx.LabelCounter}");

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        if (init != null)
        {
            statements.Add(init);
        }

        statements.Add(new BoundGotoStatement(originatingSyntax, checkLabel));
        statements.Add(new BoundLabelStatement(originatingSyntax, bodyLabel));
        statements.Add(body);
        statements.Add(new BoundLabelStatement(originatingSyntax, continueLabel));
        if (post != null)
        {
            statements.Add(post);
        }

        statements.Add(new BoundLabelStatement(originatingSyntax, checkLabel));
        if (condition == null)
        {
            statements.Add(new BoundGotoStatement(originatingSyntax, bodyLabel));
        }
        else
        {
            statements.Add(new BoundConditionalGotoStatement(originatingSyntax, bodyLabel, condition, jumpIfTrue: true));
        }

        statements.Add(new BoundLabelStatement(originatingSyntax, breakLabel));

        return new BoundBlockStatement(originatingSyntax, statements.ToImmutable());
    }

    private BoundStatement BindWhileStatement(WhileStatementSyntax syntax)
    {
        // ADR-0070: `while cond { body }` shares the lowering of `for cond { body }`.
        return BindForConditionStatementCore(syntax, syntax.Condition, syntax.Body, labelName: null);
    }

    /// <summary>
    /// Issue #1885: lowers <c>lock expr { body }</c> to the classic
    /// <c>System.Threading.Monitor.Enter</c> / <c>try</c> / <c>finally</c> /
    /// <c>Monitor.Exit</c> pattern, evaluating <c>expr</c> exactly once into a
    /// synthesized readonly local so <c>Enter</c> and <c>Exit</c> always
    /// agree on the same monitor. Any reference-type target is accepted; a
    /// value-type target is rejected (matches C# CS0185) because Monitor
    /// would box a fresh copy on every entry, defeating mutual exclusion.
    /// </summary>
    private BoundStatement BindLockStatement(LockStatementSyntax syntax)
    {
        var target = bindExpression(syntax.Expression);
        if (target is BoundErrorExpression)
        {
            return BindErrorStatement();
        }

        if (!IsLockableReferenceType(target.Type))
        {
            Diagnostics.ReportLockTargetMustBeReferenceType(syntax.Expression.Location, target.Type ?? TypeSymbol.Error);
            return BindErrorStatement();
        }

        var tempVar = new LocalVariableSymbol($"$lock$target${binderCtx.SyntheticLocalCounter++}", isReadOnly: true, target.Type);
        scope.TryDeclareVariable(tempVar);
        var tempDecl = new BoundVariableDeclaration(syntax, tempVar, target);
        BoundExpression TempAsObject()
        {
            var read = new BoundVariableExpression(syntax, tempVar);
            return read.Type == TypeSymbol.Object ? read : new BoundConversionExpression(syntax, TypeSymbol.Object, read);
        }

        var monitorType = typeof(System.Threading.Monitor);
        var importedClass = new ImportedClassSymbol(monitorType, declaration: null);
        var enterMethod = monitorType.GetMethod("Enter", new[] { typeof(object) });
        var exitMethod = monitorType.GetMethod("Exit", new[] { typeof(object) });
        var enterFn = new ImportedFunctionSymbol(enterMethod.Name, importedClass, enterMethod, declaration: null);
        var exitFn = new ImportedFunctionSymbol(exitMethod.Name, importedClass, exitMethod, declaration: null);

        var enterStmt = new BoundExpressionStatement(
            syntax,
            new BoundImportedCallExpression(syntax, enterFn, ImmutableArray.Create(TempAsObject())));

        var body = BindStatement(syntax.Body);
        var exitCall = new BoundImportedCallExpression(syntax, exitFn, ImmutableArray.Create(TempAsObject()));
        var tryStmt = BuildCleanupTryStatement(ImmutableArray.Create(body), exitCall);

        return new BoundBlockStatement(syntax, ImmutableArray.Create<BoundStatement>(tempDecl, enterStmt, tryStmt));
    }

    /// <summary>
    /// Issue #1885: true when <paramref name="type"/> is a reference type and
    /// therefore a legal <c>lock</c> target. Unwraps a nullable annotation to
    /// check the underlying type. G# classes (<see cref="StructSymbol"/> with
    /// <c>IsClass</c>), interfaces, arrays, delegates, and function-value
    /// types are always reference types; imported CLR types defer to
    /// <c>ClrType.IsValueType</c>.
    /// </summary>
    private static bool IsLockableReferenceType(TypeSymbol type)
    {
        if (type == null || type == TypeSymbol.Error)
        {
            return true;
        }

        if (type is NullableTypeSymbol nullable)
        {
            type = nullable.UnderlyingType;
        }

        switch (type)
        {
            case StructSymbol structType:
                return structType.IsClass;
            case EnumSymbol:
                return false;
            case InterfaceSymbol:
            case ArrayTypeSymbol:
            case DelegateTypeSymbol:
            case FunctionTypeSymbol:
                return true;
        }

        return type.ClrType == null || !type.ClrType.IsValueType;
    }

    private BoundStatement BindDoWhileStatement(DoWhileStatementSyntax syntax)
    {
        return BindDoWhileStatementCore(syntax, syntax.Body, syntax.Condition, labelName: null);
    }

    /// <summary>
    /// Lowers a <c>do { body } while cond</c> (or labeled equivalent) to the
    /// canonical post-test goto/label block (ADR-0070). The body runs once
    /// unconditionally before the first condition test.
    /// </summary>
    /// <param name="originatingSyntax">The originating syntax node (used for diagnostics).</param>
    /// <param name="bodySyntax">The loop body statement.</param>
    /// <param name="conditionSyntax">The loop condition expression.</param>
    /// <param name="labelName">The ADR-0070 loop label, or <see langword="null"/>.</param>
    /// <returns>The bound block statement representing the lowered loop.</returns>
    private BoundStatement BindDoWhileStatementCore(
        SyntaxNode originatingSyntax,
        StatementSyntax bodySyntax,
        ExpressionSyntax conditionSyntax,
        string labelName)
    {
        // Lowers to:
        //   {
        //     bodyLabel:
        //     <body>
        //     continueLabel:
        //     if cond goto bodyLabel
        //     breakLabel:
        //   }
        scope = new BoundScope(scope);

        var condition = bindExpressionWithTargetType(conditionSyntax, TypeSymbol.Bool);
        var body = BindLoopBody(bodySyntax, labelName, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        var bodyLabel = new BoundLabel($"body{binderCtx.LabelCounter}");

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(new BoundLabelStatement(originatingSyntax, bodyLabel));
        statements.Add(body);
        statements.Add(new BoundLabelStatement(originatingSyntax, continueLabel));
        statements.Add(new BoundConditionalGotoStatement(originatingSyntax, bodyLabel, condition, jumpIfTrue: true));
        statements.Add(new BoundLabelStatement(originatingSyntax, breakLabel));

        return new BoundBlockStatement(originatingSyntax, statements.ToImmutable());
    }

    private BoundStatement BindLabeledStatement(LabeledStatementSyntax syntax)
    {
        var labelName = syntax.LabelIdentifier.Text;
        var inner = syntax.Statement;

        // Issue #1884: a label on any non-loop statement is a `goto` target
        // rather than an ADR-0070 loop label. Emit a BoundLabelStatement
        // immediately ahead of the bound inner statement, grouped in a
        // BoundBlockStatement purely for return-shape convenience — Lowerer
        // flattens it into the enclosing statement list, so it introduces no
        // new binder scope (a `label: var x = …` still declares `x` into the
        // enclosing block, matching C#'s `goto`/label semantics).
        if (!IsLabelableLoop(inner))
        {
            var userLabel = DefineUserLabel(labelName, syntax.LabelIdentifier.Location);
            var boundInner = BindStatement(inner);
            return new BoundBlockStatement(
                syntax,
                ImmutableArray.Create(new BoundLabelStatement(syntax, userLabel), boundInner));
        }

        // ADR-0070: a label that shadows an enclosing live loop's label is a
        // warning — the inner label wins for break/continue resolution.
        foreach (var frame in binderCtx.LoopStack)
        {
            if (frame.LabelName == labelName)
            {
                Diagnostics.ReportLabelShadowsEnclosingLoop(syntax.LabelIdentifier.Location, labelName);
                break;
            }
        }

        return inner.Kind switch
        {
            SyntaxKind.WhileStatement =>
                BindForConditionStatementCore(syntax, ((WhileStatementSyntax)inner).Condition, ((WhileStatementSyntax)inner).Body, labelName),
            SyntaxKind.DoWhileStatement =>
                BindDoWhileStatementCore(syntax, ((DoWhileStatementSyntax)inner).Body, ((DoWhileStatementSyntax)inner).Condition, labelName),
            SyntaxKind.ForInfiniteStatement =>
                BindForInfiniteStatementCore(syntax, ((ForInfiniteStatementSyntax)inner).Body, labelName),
            SyntaxKind.ForEllipsisStatement =>
                BindForEllipsisStatementCore((ForEllipsisStatementSyntax)inner, syntax, labelName),
            SyntaxKind.ForConditionStatement =>
                BindForConditionStatementCore(syntax, ((ForConditionStatementSyntax)inner).Condition, ((ForConditionStatementSyntax)inner).Body, labelName),
            SyntaxKind.ForClauseStatement =>
                BindForClauseStatementCore((ForClauseStatementSyntax)inner, syntax, labelName),
            SyntaxKind.ForRangeStatement =>
                BindForRangeStatementCore((ForRangeStatementSyntax)inner, labelName, syntax),
            SyntaxKind.ForTupleRangeStatement =>
                BindForTupleRangeStatementCore((ForTupleRangeStatementSyntax)inner, labelName, syntax),
            SyntaxKind.AwaitForRangeStatement =>
                BindAwaitForRangeStatementCore((AwaitForRangeStatementSyntax)inner, labelName, syntax),
            _ => BindStatement(inner),
        };
    }

    private static bool IsLabelableLoop(StatementSyntax stmt)
    {
        return stmt.Kind switch
        {
            SyntaxKind.WhileStatement => true,
            SyntaxKind.DoWhileStatement => true,
            SyntaxKind.ForInfiniteStatement => true,
            SyntaxKind.ForEllipsisStatement => true,
            SyntaxKind.ForConditionStatement => true,
            SyntaxKind.ForClauseStatement => true,
            SyntaxKind.ForRangeStatement => true,
            SyntaxKind.ForTupleRangeStatement => true,
            SyntaxKind.AwaitForRangeStatement => true,
            _ => false,
        };
    }

    private BoundStatement BindLabeledForRange(LabeledStatementSyntax labelSyntax, ForRangeStatementSyntax inner, string labelName)
    {
        return BindForRangeStatementCore(inner, labelName, labelSyntax);
    }
}
