// <copyright file="StatementBinder.Loops.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Threading

internal partial class StatementBinder {
    private func ResolveExceptionType() TypeSymbol? {
        if $scope.References!!.TryResolveType("System.Exception", out var t) {
            return TypeSymbol.FromClrTypeWithoutNullability(t, NullabilityFreeReason.TypeLiteral)
        }
        return nil
    }

    private func BindForInfiniteStatement(syntax ForInfiniteStatementSyntax) BoundStatement {
        return BindForInfiniteStatementCore(syntax, syntax.Body, labelName: nil)
    }

    /// Binds a `for { body }` infinite loop, with optional ADR-0070 label.
    /// @param originatingSyntax Originating syntax for diagnostics.
    /// @param bodySyntax The loop body.
    /// @param labelName The ADR-0070 label, or `null`.
    /// @returns The bound for-infinite statement.
    private func BindForInfiniteStatementCore(
        originatingSyntax SyntaxNode,
        bodySyntax StatementSyntax,
        labelName string?
    ) BoundStatement {
        $scope = BoundScope($scope)
        let body = BindLoopBody(bodySyntax, labelName, out var breakLabel, out var continueLabel)
        $scope = $scope.Pop()
        return BoundForInfiniteStatement(originatingSyntax, body, breakLabel, continueLabel)
    }

    private func BindForEllipsisStatement(syntax ForEllipsisStatementSyntax) BoundStatement {
        return BindForEllipsisStatementCore(syntax, syntax, labelName: nil)
    }

    private func BindForEllipsisStatementCore(
        syntax ForEllipsisStatementSyntax,
        originatingSyntax SyntaxNode,
        labelName string?
    ) BoundStatement {
        let lowerBound = bindExpressionWithTargetType(syntax.LowerBound, TypeSymbol.Int32)
        let upperBound = bindExpressionWithTargetType(syntax.UpperBound, TypeSymbol.Int32)
        $scope = BoundScope($scope)
        let variable = bindLocalVariable(syntax.Identifier, false, TypeSymbol.Int32)
        let body = BindLoopBody(syntax.Body, labelName, out var breakLabel, out var continueLabel)
        $scope = $scope.Pop()
        return BoundForEllipsisStatement(nil, variable, lowerBound, upperBound, body, breakLabel, continueLabel)
    }

    private func BindForRangeStatement(syntax ForRangeStatementSyntax) BoundStatement {
        return BindForRangeStatementCore(syntax, labelName: nil, originatingSyntax: syntax)
    }

    private func BindForTupleRangeStatement(syntax ForTupleRangeStatementSyntax) BoundStatement {
        return BindForTupleRangeStatementCore(syntax, labelName: nil, originatingSyntax: syntax)
    }

    /// Issue #1922: binds `for (a, b, ...) in coll { ... }` by
    /// synthesizing a hidden single-identifier (cref:ForRangeStatementSyntax)
    /// (same shape cs2gs used to hand-emit as a temp variable plus a separate
    /// `let (a, b) = tmp`) and delegating to
    /// (cref:BindForRangeStatementCore)'s `bindLoopPrelude` hook —
    /// so every iteration strategy (arrays, slices, dictionaries, CLR/pattern
    /// enumerables, sequences, strings) keeps working with zero duplication.
    /// @param syntax The deconstructing for-range syntax.
    /// @param labelName The ADR-0070 label, or `null`.
    /// @param originatingSyntax Syntax node used for the resulting bound node.
    /// @returns The bound for-range statement.
    private func BindForTupleRangeStatementCore(
        syntax ForTupleRangeStatementSyntax,
        labelName string?,
        originatingSyntax SyntaxNode
    ) BoundStatement {
        let tempName = "<fortuple${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
        let tempIdentifier = SyntaxToken(
            syntax.SyntaxTree,
            SyntaxKind.IdentifierToken,
            syntax.OpenParenToken.Position,
            tempName,
            nil
        )
        let syntheticForRange = ForRangeStatementSyntax(
            syntax.SyntaxTree,
            syntax.Keyword,
            tempIdentifier,
            typeClause: nil,
            commaToken: nil,
            secondIdentifier: nil,
            colonEqualsToken: nil,
            rangeKeyword: nil,
            inToken: syntax.InToken,
            collection: syntax.Collection,
            body: syntax.Body
        )
        return BindForRangeStatementCore(
            syntheticForRange,
            labelName,
            originatingSyntax,
            bindLoopPrelude: (elementVariable VariableSymbol) -> BindForTupleLoopPrelude(
                syntax.Identifiers,
                syntax.CloseParenToken.Location,
                syntax.OpenParenToken.Location,
                elementVariable
            )
        )
    }

    /// Core for-range binder; accepts an optional ADR-0070 label name that is
    /// pushed onto the loop stack so a nested `break label` / `continue
    /// label` resolves to this loop's targets.
    /// @param syntax The for-range syntax.
    /// @param labelName The ADR-0070 label, or `null`.
    /// @param originatingSyntax Syntax node used for the resulting bound node.
    /// @param bindLoopPrelude Issue #1922: optional hook invoked with the newly-declared single loop
    /// variable, still inside its scope, right before the body is bound.
    /// Lets `for (a, b) in coll` declare its deconstructed element
    /// locals (visible to the body) and return the field-extraction
    /// statements to prepend, reusing this method's entire iteration-strategy
    /// dispatch (arrays, slices, dictionaries, CLR/pattern enumerables,
    /// sequences, strings) instead of duplicating it.
    /// @returns The bound for-range statement.
    private func BindForRangeStatementCore(
        syntax ForRangeStatementSyntax,
        labelName string?,
        originatingSyntax SyntaxNode,
        bindLoopPrelude((VariableSymbol) -> ImmutableArray[BoundStatement])? = nil
    ) BoundStatement {
        var collection = bindExpression(syntax.Collection, false)
        ApplyHeaderCallableEffects(collection)
        // ADR-0186 §4/§5: a `foreach`/`range` source is one of the positions
        // the ADR names explicitly — "used where the language requires a
        // non-null reference" — so it takes the coercion check. It also has
        // to be unwrapped for §5a's reason, and the two are the same
        // operation: this switch dispatches on the collection's SYMBOL KIND,
        // so a platform wrapper matched no arm at all and
        // `for v in obliviousList()` reported GS0116 "not indexable" — the
        // receiver's platform-ness changing what the binder found.
        collection = binderCtx.InsertPlatformCheck(collection, syntax.Collection.Location, "a 'for … in' source")
        // ADR-0174 D3: `for v in ch` drains a channel until it is closed. Decided
        // before the enumerator probe: a channel handle has no GetEnumerator,
        // and a foreign `Channel<T>` must take the same receive path as `chan[T]`.
        if collection.Type != TypeSymbol.Error && ChannelTypeSymbol.TryGetChannelShape(
            collection.Type,
            out _,
            out _,
            out _
        ) {
            return BindForInChannelStatement(syntax, collection, labelName, originatingSyntax, bindLoopPrelude)
        }
        if collection.Type?.ClrType is {} collectionClrType {
            MemberLookup.ResolveGetEnumerator(collectionClrType, out var ambiguousGetEnumerator)
            if ambiguousGetEnumerator {
                Diagnostics.ReportAmbiguousImportedMember(syntax.Collection.Location, collection.Type, "GetEnumerator")
                return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
            }
        }
        // Decide iteration strategy and element/key types based on the
        // collection type.
        var iterationKind ForRangeKind
        var keyType TypeSymbol
        var valueType TypeSymbol
        switch collection.Type {
            case arr is ArrayTypeSymbol {
                iterationKind = ForRangeKind.Indexed
                keyType = TypeSymbol.Int32
                valueType = arr.ElementType
            }
            case slice is SliceTypeSymbol {
                iterationKind = ForRangeKind.Indexed
                keyType = TypeSymbol.Int32
                valueType = slice.ElementType
            }
            case rectangular is RectangularArrayTypeSymbol {
                iterationKind = ForRangeKind.PatternEnumerator
                keyType = TypeSymbol.Int32
                valueType = rectangular.ElementType
            }
            case annotated is NullabilityAnnotatedTypeSymbol when annotated.ClrType != nil {
                // Issue #520: CLR SZ arrays (`T[]`) implement IEnumerable<T> via
                // runtime magic but `Array.GetEnumerator()` returns the non-generic
                // IEnumerator whose Current is System.Object. Routing them through
                // the Enumerable path would assign a boxed reference into the
                // value-typed loop variable (the pointer's low 32 bits surface as
                // garbage). Use the Indexed path instead so we emit `ldelem <T>`
                // with the array's actual element type — same lowering C#'s
                // `foreach (T x in arr)` produces.
                if annotated.ClrType!!.IsArray && annotated.ClrType!!.GetArrayRank() == 1 {
                    iterationKind = ForRangeKind.Indexed
                    keyType = TypeSymbol.Int32
                    valueType = annotated.GetTypeArgumentSymbolForClrType(
                        Invariant.Required(
                            annotated.ClrType!!.GetElementType(),
                            "a single-dimensional CLR array has an element type",
                            expression: "annotated.ClrType.GetElementType()"
                        )
                    )
                } else if MemberLookup.GetProjectionReceiverImportedType(annotated) is ImportedTypeSymbol projected &&
                    MemberLookup
                    .TryGetClrDictionaryTypes(
                    Invariant.Required(
                        projected.OpenDefinition ?? projected.ClrType,
                        "an imported projection receiver has a CLR type",
                        expression: "projected.OpenDefinition ?? projected.ClrType"
                    ),
                    out var aDKey,
                    out var aDVal
                ) {
                    iterationKind = ForRangeKind.Dictionary
                    keyType = MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(
                        Invariant.Required(aDKey, "a dictionary has a key type", expression: "aDKey"),
                        projected,
                        NullabilityFreeReason.TypeStructure
                    )
                    valueType = MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(
                        Invariant.Required(aDVal, "a dictionary has a value type", expression: "aDVal"),
                        projected,
                        NullabilityFreeReason.TypeStructure
                    )
                } else if MemberLookup.GetProjectionReceiverImportedType(annotated) is ImportedTypeSymbol enumerable &&
                    MemberLookup
                    .TryGetClrEnumerableElementType(
                    Invariant.Required(
                        enumerable.OpenDefinition ?? enumerable.ClrType,
                        "an imported projection receiver has a CLR type",
                        expression: "enumerable.OpenDefinition ?? enumerable.ClrType"
                    ),
                    out var aElemType
                ) {
                    iterationKind = ForRangeKind.Enumerable
                    keyType = TypeSymbol.Int32
                    valueType = MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(
                        Invariant.Required(aElemType, "an enumerable has an element type", expression: "aElemType"),
                        enumerable,
                        NullabilityFreeReason.TypeStructure
                    )
                } else if MemberLookup.GetProjectionReceiverImportedType(annotated) is ImportedTypeSymbol pattern &&
                    MemberLookup
                    .TryGetClrPatternEnumerableCurrentMember(
                    Invariant.Required(
                        pattern.OpenDefinition ?? pattern.ClrType,
                        "an imported projection receiver has a CLR type",
                        expression: "pattern.OpenDefinition ?? pattern.ClrType"
                    ),
                    out var aPatternCurrent
                ) {
                    iterationKind = ForRangeKind.PatternEnumerator
                    keyType = TypeSymbol.Int32
                    valueType = MemberLookup.DereferenceByRefElement(
                        MemberLookup.GetClrMemberValueTypeSymbol(
                            aPatternCurrent!!,
                            pattern.OpenDefinition,
                            pattern.TypeArguments
                        )
                    )
                } else {
                    Diagnostics.ReportTypeNotIndexable(syntax.Collection.Location, collection.Type ?? TypeSymbol.Error)
                    return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
                }
            }
            case openImp is ImportedTypeSymbol when openImp.OpenDefinition != nil &&
                openImp
                .HasSubstitutableTypeArgument {
                if MemberLookup.TryGetClrDictionaryTypes(openImp.OpenDefinition!!, out var openDKey, out var openDVal) {
                    iterationKind = ForRangeKind.Dictionary
                    keyType = MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(
                        Invariant.Required(openDKey, "a dictionary definition has a key type", expression: "openDKey"),
                        openImp,
                        NullabilityFreeReason.TypeStructure
                    )
                    valueType = MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(
                        Invariant.Required(
                            openDVal,
                            "a dictionary definition has a value type",
                            expression: "openDVal"
                        ),
                        openImp,
                        NullabilityFreeReason.TypeStructure
                    )
                } else if MemberLookup.TryGetClrEnumerableElementType(openImp.OpenDefinition!!, out var openElemType) {
                    iterationKind = ForRangeKind.Enumerable
                    keyType = TypeSymbol.Int32
                    valueType = MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(
                        Invariant.Required(
                            openElemType,
                            "an enumerable definition has an element type",
                            expression: "openElemType"
                        ),
                        openImp,
                        NullabilityFreeReason.TypeStructure
                    )
                } else if MemberLookup.TryGetClrPatternEnumerableCurrentMember(
                    openImp.OpenDefinition!!,
                    out var openPatternCurrent
                ) {
                    iterationKind = ForRangeKind.PatternEnumerator
                    keyType = TypeSymbol.Int32
                    valueType = MemberLookup.DereferenceByRefElement(
                        MemberLookup.GetClrMemberValueTypeSymbol(
                            openPatternCurrent,
                            openImp.OpenDefinition,
                            openImp.TypeArguments
                        )
                    )
                } else {
                    Diagnostics.ReportTypeNotIndexable(syntax.Collection.Location, collection.Type ?? TypeSymbol.Error)
                    return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
                }
            }
            case imp is ImportedTypeSymbol when imp.ClrType != nil {
                // Issue #520: CLR SZ arrays (`T[]`) — see the matching note in the
                // NullabilityAnnotatedTypeSymbol branch above. Detect first and
                // route to the Indexed path so iteration emits `ldelem <T>`
                // (type-aware) rather than walking a boxing IEnumerator.
                if imp.ClrType!!.IsArray && imp.ClrType!!.GetArrayRank() == 1 {
                    iterationKind = ForRangeKind.Indexed
                    keyType = TypeSymbol.Int32
                    valueType = TypeSymbol.FromClrTypeWithoutNullability(
                        Invariant.Required(
                            imp.ClrType!!.GetElementType(),
                            "a single-dimensional CLR array has an element type",
                            expression: "imp.ClrType.GetElementType()"
                        ),
                        NullabilityFreeReason.TypeStructure
                    )
                } else if MemberLookup.TryGetClrDictionaryTypes(imp.ClrType!!, out var dKey, out var dVal) {
                    iterationKind = ForRangeKind.Dictionary
                    keyType = TypeSymbol.FromClrTypeWithoutNullability(dKey, NullabilityFreeReason.TypeStructure)
                    valueType = TypeSymbol.FromClrTypeWithoutNullability(dVal, NullabilityFreeReason.TypeStructure)
                } else if MemberLookup.TryGetClrEnumerableElementType(imp.ClrType!!, out var elemType) {
                    iterationKind = ForRangeKind.Enumerable
                    keyType = TypeSymbol.Int32
                    valueType = TypeSymbol.FromClrTypeWithoutNullability(elemType, NullabilityFreeReason.TypeStructure)
                } else if MemberLookup.TryGetClrPatternEnumerableCurrentMember(imp.ClrType!!, out var patternCurrent) {
                    iterationKind = ForRangeKind.PatternEnumerator
                    keyType = TypeSymbol.Int32
                    valueType = MemberLookup.DereferenceByRefElement(
                        MemberLookup.GetClrMemberValueTypeSymbol(patternCurrent)
                    )
                } else {
                    Diagnostics.ReportTypeNotIndexable(syntax.Collection.Location, collection.Type ?? TypeSymbol.Error)
                    return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
                }
            }
            case userType is StructSymbol when MemberLookup.TryGetUserPatternEnumerableElementType(
                userType,
                out var userElemType
            ) {
                iterationKind = ForRangeKind.PatternEnumerator
                keyType = TypeSymbol.Int32
                valueType = Invariant.Required(
                    userElemType,
                    "a pattern enumerable has an element type",
                    expression: "userElemType"
                )
            }
            case seq is SequenceTypeSymbol {
                // ADR-0040: sequence[T] is IEnumerable[T] — iterate via Enumerable strategy.
                iterationKind = ForRangeKind.Enumerable
                keyType = TypeSymbol.Int32
                valueType = seq.ElementType
            }
            case map_ is MapTypeSymbol {
                iterationKind = ForRangeKind.Dictionary
                keyType = map_.KeyType
                valueType = map_.ValueType
            }
            default {
                // Issue #537: `string` is iterable over `char` via its indexer
                // and Length property — same fast-path C# uses for
                // `foreach (char c in str)`.
                if collection.Type == TypeSymbol.String {
                    iterationKind = ForRangeKind.Indexed
                    keyType = TypeSymbol.Int32
                    valueType = TypeSymbol.Char
                    break
                }
                if collection.Type != TypeSymbol.Error {
                    Diagnostics.ReportTypeNotIndexable(syntax.Collection.Location, collection.Type ?? TypeSymbol.Error)
                }
                return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
            }
        }
        $scope = BoundScope($scope)
        var keyVariable VariableSymbol? = nil
        var valueVariable VariableSymbol
        var typedVariablePrelude = ImmutableArray[BoundStatement].Empty
        if syntax.SecondIdentifier != nil {
            keyVariable = bindLocalVariable(
                syntax.FirstIdentifier,
                false,
                Invariant.Required(keyType, "a range iteration has a key type", expression: "keyType")
            )
            valueVariable = bindLocalVariable(
                syntax.SecondIdentifier!!,
                false,
                Invariant.Required(valueType, "a range iteration has a value type", expression: "valueType")
            )
        } else {
            // `for v := range coll` — single var binds the value/element.
            //
            // Issue #1328: a SINGLE-identifier iteration over a dictionary
            // binds the whole `KeyValuePair[K, V]` element (the static type of
            // `Current`), matching `foreach (var kv in dict)` and single-var
            // iteration over an `IEnumerable[KeyValuePair[K, V]]`. The two-var
            // form `for k, v in dict` continues to destructure into K and V.
            // The symbolic `[K, V]` arguments are preserved so `kv.Key`/`kv.Value`
            // expose the user element types rather than erasing to `object`.
            let singleVarType = if iterationKind == ForRangeKind.Dictionary {
                BuildKeyValuePairType(
                    Invariant.Required(keyType, "a dictionary iteration has a key type", expression: "keyType"),
                    Invariant.Required(valueType, "a dictionary iteration has a value type", expression: "valueType")
                )
            } else {
                Invariant.Required(valueType, "a range iteration has a value type", expression: "valueType")
            }
            if syntax.TypeClause == nil {
                valueVariable = bindLocalVariable(syntax.FirstIdentifier, false, singleVarType)
            } else {
                let declaredType = bindTypeClause(syntax.TypeClause) ?? TypeSymbol.Error
                valueVariable = LocalVariableSymbol(
                    "<forrange${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
                    isReadOnly: false,
                    type: singleVarType
                )
                let declaredVariable = bindLocalVariable(syntax.FirstIdentifier, false, declaredType)
                let convertedValue = conversions.BindConversion(
                    syntax.TypeClause!!.Location,
                    BoundVariableExpression(syntax, valueVariable),
                    declaredType,
                    allowExplicit: true
                )
                typedVariablePrelude = ImmutableArray.Create[BoundStatement](
                    BoundVariableDeclaration(syntax, declaredVariable, convertedValue)
                )
            }
        }
        let prelude = typedVariablePrelude.AddRange(
            bindLoopPrelude?(valueVariable) ?? ImmutableArray[BoundStatement].Empty
        )
        var body = BindLoopBody(
            syntax.Body,
            labelName,
            out var breakLabel,
            out var continueLabel,
            iterationRunsUserCode: iterationKind != ForRangeKind.Indexed
        )
        if !prelude.IsEmpty {
            body = BoundBlockStatement(originatingSyntax, prelude.Add(body))
        }
        $scope = $scope.Pop()
        return BoundForRangeStatement(
            originatingSyntax,
            keyVariable,
            valueVariable,
            collection,
            iterationKind,
            body,
            breakLabel,
            continueLabel
        )
    }

    private func BindForConditionStatement(syntax ForConditionStatementSyntax) BoundStatement {
        return BindForConditionStatementCore(syntax, syntax.Condition, syntax.Body, labelName: nil)
    }

    /// Core `for cond { body }` binder; accepts an optional ADR-0070 label.
    /// @param originatingSyntax Originating syntax for diagnostics.
    /// @param conditionSyntax Loop condition.
    /// @param bodySyntax Loop body.
    /// @param labelName The ADR-0070 label, or `null`.
    /// @returns The lowered bound block.
    private func BindForConditionStatementCore(
        originatingSyntax SyntaxNode,
        conditionSyntax ExpressionSyntax,
        bodySyntax StatementSyntax,
        labelName string?
    ) BoundStatement {
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
        $scope = BoundScope($scope)
        let body = BindConditionedLoopBody(
            conditionSyntax,
            bodySyntax,
            labelName,
            out var breakLabel,
            out var continueLabel,
            out var condition,
            out _,
            postSyntax: nil
        )
        $scope = $scope.Pop()
        let bodyLabel = BoundLabel("body${binderCtx.LabelCounter}")
        let checkLabel = BoundLabel("check${binderCtx.LabelCounter}")
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(BoundGotoStatement(originatingSyntax, checkLabel))
        statements.Add(BoundLabelStatement(originatingSyntax, bodyLabel))
        statements.Add(body)
        statements.Add(BoundLabelStatement(originatingSyntax, continueLabel))
        statements.Add(BoundLabelStatement(originatingSyntax, checkLabel))
        statements.Add(
            BoundConditionalGotoStatement(
                originatingSyntax,
                bodyLabel,
                Invariant.Required(condition, "a conditional loop has a bound condition", expression: "condition"),
                jumpIfTrue: true
            )
        )
        statements.Add(BoundLabelStatement(originatingSyntax, breakLabel))
        return BoundBlockStatement(originatingSyntax, statements.ToImmutable())
    }

    private func BindForClauseStatement(syntax ForClauseStatementSyntax) BoundStatement {
        return BindForClauseStatementCore(syntax, syntax, labelName: nil)
    }

    /// Core C-style `for init; cond; post { body }` binder; accepts an
    /// optional ADR-0070 label.
    /// @param syntax The for-clause syntax.
    /// @param originatingSyntax Syntax used for bound-node diagnostics.
    /// @param labelName The ADR-0070 label, or `null`.
    /// @returns The lowered bound block.
    private func BindForClauseStatementCore(
        syntax ForClauseStatementSyntax,
        originatingSyntax SyntaxNode,
        labelName string?
    ) BoundStatement {
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
        $scope = BoundScope($scope)
        let init BoundStatement? = if syntax.Initializer == nil {
            default(BoundStatement?)
        } else {
            BindStatement(syntax.Initializer)
        }
        if init != nil {
            InvalidateNarrowingsForAssignedVariables(
                Invariant.Required(
                    syntax.Initializer,
                    "a bound for-clause initializer has initializer syntax",
                    expression: "syntax.Initializer"
                ),
                init
            )
            if binderCtx.NarrowedVariables.Count > 0 {
                ApplyAssignmentNarrowing(init, binderCtx.NarrowedVariables[binderCtx.NarrowedVariables.Count - 1])
            }
        }
        let body = BindConditionedLoopBody(
            syntax.Condition,
            syntax.Body,
            labelName,
            out var breakLabel,
            out var continueLabel,
            out var condition,
            out var post,
            syntax.Post
        )
        $scope = $scope.Pop()
        let bodyLabel = BoundLabel("body${binderCtx.LabelCounter}")
        let checkLabel = BoundLabel("check${binderCtx.LabelCounter}")
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        if init != nil {
            statements.Add(init)
        }
        statements.Add(BoundGotoStatement(originatingSyntax, checkLabel))
        statements.Add(BoundLabelStatement(originatingSyntax, bodyLabel))
        statements.Add(body)
        statements.Add(BoundLabelStatement(originatingSyntax, continueLabel))
        if post != nil {
            statements.Add(post)
        }
        statements.Add(BoundLabelStatement(originatingSyntax, checkLabel))
        if condition == nil {
            statements.Add(BoundGotoStatement(originatingSyntax, bodyLabel))
        } else {
            statements.Add(BoundConditionalGotoStatement(originatingSyntax, bodyLabel, condition, jumpIfTrue: true))
        }
        statements.Add(BoundLabelStatement(originatingSyntax, breakLabel))
        return BoundBlockStatement(originatingSyntax, statements.ToImmutable())
    }

    private func BindConditionedLoopBody(
        conditionSyntax ExpressionSyntax?,
        bodySyntax StatementSyntax,
        labelName string?,
        out breakLabel BoundLabel,
        out continueLabel BoundLabel,
        out condition BoundExpression?,
        out post BoundStatement?,
        postSyntax StatementSyntax?
    ) BoundStatement {
        var boundCondition BoundExpression? = nil
        var boundPost BoundStatement? = nil
        let headerParentScope = $scope
        let body = BindLoopBody(
            bodySyntax,
            labelName,
            out breakLabel,
            out continueLabel,
            bindIteration: func ()(Body BoundStatement, Tail BoundStatement?, Condition BoundExpression?) {
                // #4129: the header executes again too. Keeping its first binding
                // retained stale casts and pattern-variable identities after #2943
                // rebound only the body.
                $scope = BoundScope(headerParentScope)
                try {
                    boundCondition = if conditionSyntax == nil {
                        default(BoundExpression?)
                    } else {
                        bindExpressionWithTargetType(conditionSyntax, TypeSymbol.Bool)
                    }
                    ApplyHeaderCallableEffects(boundCondition)
                    boundPost = if postSyntax == nil {
                        default(BoundStatement?)
                    } else {
                        BindStatement(postSyntax)
                    }
                    let (patternWhenTrue, _) = PatternVariables.Classify(boundCondition)
                    let boundBody = PatternVariables.BindInScope(
                        binderCtx,
                        patternWhenTrue,
                        () -> BindConditionedLoopBodyCore(boundCondition, bodySyntax)
                    )
                    return (boundBody, boundPost, boundCondition)
                } finally {
                    $scope = headerParentScope
                }
            }
        )
        condition = boundCondition
        post = boundPost
        return body
    }

    private func BindConditionedLoopBodyCore(condition BoundExpression?, bodySyntax StatementSyntax) BoundStatement {
        let loopNarrow Dictionary[AccessPath, TypeSymbol]? = if condition == nil {
            default(Dictionary[AccessPath, TypeSymbol]?)
        } else {
            ComputeConditionNarrowing(condition).Then
        }
        if loopNarrow == nil {
            return Invariant.Required(
                BindStatement(bodySyntax),
                "a loop body has a bound statement",
                expression: "BindStatement(bodySyntax)"
            )
        }
        binderCtx.PushNarrowingFrame(loopNarrow)
        try {
            return Invariant.Required(
                BindStatement(bodySyntax),
                "a loop body has a bound statement",
                expression: "BindStatement(bodySyntax)"
            )
        } finally {
            binderCtx.EndNarrowingProof()
        }
    }

    private func BindWhileStatement(syntax WhileStatementSyntax) BoundStatement {
        // ADR-0070: `while cond { body }` shares the lowering of `for cond { body }`.
        return BindForConditionStatementCore(syntax, syntax.Condition, syntax.Body, labelName: nil)
    }

    private func BindWhileLetStatement(syntax WhileLetStatementSyntax) BoundStatement {
        return BindWhileLetStatementCore(syntax, syntax.Bindings, syntax.Body, labelName: nil)
    }

    /// ADR-0163 / issue #3352: lowers `while let` through the existing
    /// declaration, nil-check, goto, and loop-label nodes. Binding declarations
    /// sit at the check label, so their initializers run before every iteration
    /// and every `continue` re-enters through the same check.
    private func BindWhileLetStatementCore(
        originatingSyntax SyntaxNode,
        bindingSyntaxes GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[IfLetBindingClauseSyntax],
        bodySyntax StatementSyntax,
        labelName string?
    ) BoundStatement {
        // Lowers to:
        //   {
        //     goto checkLabel
        //     bodyLabel:
        //     <body, bindings narrowed to their underlying types>
        //     continueLabel:
        //     checkLabel:
        //     let a T1? = e1
        //     let b T2? = e2
        //     if a != nil && b != nil goto bodyLabel
        //     breakLabel:
        //   }
        let enclosingScope = $scope
        let clauses = List[WhileLetChannelClause]()
        var condition BoundExpression? = nil
        let body = BindLoopBody(
            bodySyntax,
            labelName,
            out var breakLabel,
            out var continueLabel,
            bindIteration: func ()(Body BoundStatement, Tail BoundStatement?, Condition BoundExpression?) {
                $scope = BoundScope(enclosingScope)
                let loopScope = $scope
                try {
                    clauses.Clear()
                    let localsForFrame = List[(Variable VariableSymbol, Underlying TypeSymbol)]()
                    let declarations = ImmutableArray.CreateBuilder[BoundStatement]()
                    var hasChannelGate = false
                    for binding in bindingSyntaxes {
                        // ADR-0174 D3: channel gates short-circuit in source order
                        // and do not join the nullable-value check chain.
                        if IsChannelReceiveSyntax(binding.Initializer, out var receive) {
                            let channelClause = BindWhileLetChannelClause(binding, receive, enclosingScope, loopScope)
                            clauses.Add(channelClause)
                            declarations.AddRange(channelClause.Declarations)
                            hasChannelGate |= channelClause.Gate != nil
                            continue
                        }
                        let (variable, underlying, declaration) = BindWhileLetBindingClause(
                            binding,
                            enclosingScope,
                            loopScope
                        )
                        clauses.Add(WhileLetChannelClause(ImmutableArray.Create(declaration), Gate: nil))
                        declarations.Add(declaration)
                        if variable != nil && underlying != nil {
                            localsForFrame.Add((variable, underlying))
                        }
                    }
                    condition = BuildNilCheckChain(originatingSyntax, localsForFrame) ??
                        BoundLiteralExpression(originatingSyntax, hasChannelGate, TypeSymbol.Bool)
                    let declarationBlock = BoundBlockStatement(originatingSyntax, declarations.ToImmutable())
                    return (BindConditionedLoopBodyCore(condition, bodySyntax), declarationBlock, condition)
                } finally {
                    $scope = enclosingScope
                }
            }
        )
        let bodyLabel = BoundLabel("body${binderCtx.LabelCounter}")
        let checkLabel = BoundLabel("check${binderCtx.LabelCounter}")
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(BoundGotoStatement(originatingSyntax, checkLabel))
        statements.Add(BoundLabelStatement(originatingSyntax, bodyLabel))
        statements.Add(body)
        statements.Add(BoundLabelStatement(originatingSyntax, continueLabel))
        statements.Add(BoundLabelStatement(originatingSyntax, checkLabel))
        for clause in clauses {
            statements.AddRange(clause.Declarations)
            if clause.Gate != nil {
                statements.Add(
                    BoundConditionalGotoStatement(originatingSyntax, breakLabel, clause.Gate, jumpIfTrue: false)
                )
            }
        }
        statements.Add(
            BoundConditionalGotoStatement(
                originatingSyntax,
                bodyLabel,
                Invariant.Required(condition, "a while-let loop has a bound condition", expression: "condition"),
                jumpIfTrue: true
            )
        )
        statements.Add(BoundLabelStatement(originatingSyntax, breakLabel))
        return BoundBlockStatement(originatingSyntax, statements.ToImmutable())
    }

    private func BindWhileLetBindingClause(
        binding IfLetBindingClauseSyntax,
        enclosingScope BoundScope,
        loopScope BoundScope
    )(Variable VariableSymbol?, Underlying TypeSymbol?, Declaration BoundStatement) {
        let savedScope = $scope
        $scope = BoundScope(enclosingScope)
        try {
            let bound = IfLetBindingSupport.BindBindingClause(
                binding,
                Diagnostics,
                conversions,
                bindTypeClause,
                (syntax ExpressionSyntax) -> {
                    return bindExpression(syntax, false)
                },
                (identifier SyntaxToken, isReadOnly bool, type TypeSymbol) -> {
                    let initializerScope = $scope
                    $scope = loopScope
                    try {
                        return bindLocalVariable(identifier, isReadOnly, type)
                    } finally {
                        $scope = initializerScope
                    }
                },
                reportNonNullableInitializer: (clause IfLetBindingClauseSyntax, initializer BoundExpression) -> {
                    // ADR-0174 D3: `while let v = ch` names the channel itself;
                    // the author almost certainly meant `<-ch`. Say so (GS0555)
                    // instead of the generic must-be-nullable GS0296.
                    if ChannelTypeSymbol.TryGetChannelShape(initializer.Type, out _, out var direction, out _) &&
                        direction != ChannelDirection
                        .Out {
                        let location = clause.Initializer.Location
                        Diagnostics.ReportWhileLetOverChannelNeedsReceive(
                            location,
                            clause.Identifier.ValueText,
                            location.Text?.ToString(location.Span) ?? "ch"
                        )
                        return
                    }
                    Diagnostics.ReportIfLetInitializerMustBeNullable(
                        clause.Initializer.Location,
                        clause.Identifier.ValueText,
                        Invariant.Required(
                            initializer.Type,
                            "a bound initializer has a type",
                            expression: "initializer.Type"
                        )
                    )
                }
            )
            let declaration = BoundVariableDeclaration(binding, bound.Variable, bound.Initializer)
            return if bound.IsValid {
                (bound.Variable, bound.Underlying, declaration)
            } else {
                (nil, nil, declaration)
            }
        } finally {
            $scope = savedScope
        }
    }

    /// Issue #1885: lowers `lock expr { body }` to the classic
    /// `System.Threading.Monitor.Enter` / `try` / `finally` /
    /// `Monitor.Exit` pattern, evaluating `expr` exactly once into a
    /// synthesized readonly local so `Enter` and `Exit` always
    /// agree on the same monitor. Any reference-type target is accepted; a
    /// value-type target is rejected (matches C# CS0185) because Monitor
    /// would box a fresh copy on every entry, defeating mutual exclusion.
    private func BindLockStatement(syntax LockStatementSyntax) BoundStatement {
        var target = bindExpression(syntax.Expression, false)
        if target is BoundErrorExpression {
            return BindErrorStatement()
        }
        // ADR-0186 §4: a `lock`/`sync` subject is a position the ADR names
        // explicitly, and like `throw` it has its own binding path rather
        // than passing through `BindConversion`. It also needs the unwrap for
        // §5's reason: `IsLockableReferenceType` below dispatches on the
        // target's symbol KIND, which a platform wrapper is not.
        target = binderCtx.InsertPlatformCheck(target, syntax.Expression.Location, "a 'lock' subject")
        if !IsLockableReferenceType(target.Type) {
            Diagnostics.ReportLockTargetMustBeReferenceType(syntax.Expression.Location, target.Type ?? TypeSymbol.Error)
            return BindErrorStatement()
        }
        let tempVar = LocalVariableSymbol(
            "$$lock$$target$$${binderCtx.SyntheticLocalCounter++}",
            isReadOnly: true,
            target.Type
        )
        $scope.TryDeclareVariable(tempVar)
        let tempDecl = BoundVariableDeclaration(syntax, tempVar, target)
        let TempAsObject = func () BoundExpression {
            let read = BoundVariableExpression(syntax, tempVar)
            return if read.Type == TypeSymbol.Object {
                cast[BoundExpression](read)
            } else {
                cast[BoundExpression](BoundConversionExpression(syntax, TypeSymbol.Object, read))
            }
        }
        let monitorType = typeof(Monitor)
        let importedClass = ImportedClassSymbol(monitorType, declaration: nil)
        let enterMethod = Invariant.Required(
            monitorType.GetMethod("Enter", []Type{typeof(object)}),
            "Monitor.Enter(object) exists",
            expression: "monitorType.GetMethod(\"Enter\", new[] { typeof(object) })"
        )
        let exitMethod = Invariant.Required(
            monitorType.GetMethod("Exit", []Type{typeof(object)}),
            "Monitor.Exit(object) exists",
            expression: "monitorType.GetMethod(\"Exit\", new[] { typeof(object) })"
        )
        let enterFn = ImportedFunctionSymbol(enterMethod.Name, importedClass, enterMethod, declaration: nil)
        let exitFn = ImportedFunctionSymbol(exitMethod.Name, importedClass, exitMethod, declaration: nil)
        let enterStmt = BoundExpressionStatement(
            syntax,
            BoundImportedCallExpression(syntax, enterFn, ImmutableArray.Create(TempAsObject()))
        )
        let body = BindStatement(syntax.Body)
        let exitCall = BoundImportedCallExpression(syntax, exitFn, ImmutableArray.Create(TempAsObject()))
        let tryStmt = BuildCleanupTryStatement(
            ImmutableArray.Create(Invariant.Required(body, "a lock statement has a bound body", expression: "body")),
            exitCall
        )
        return BoundBlockStatement(syntax, ImmutableArray.Create[BoundStatement](tempDecl, enterStmt, tryStmt))
    }

    private func BindDoWhileStatement(syntax DoWhileStatementSyntax) BoundStatement {
        return BindDoWhileStatementCore(syntax, syntax.Body, syntax.Condition, labelName: nil)
    }

    /// Lowers a `do { body } while cond` (or labeled equivalent) to the
    /// canonical post-test goto/label block (ADR-0070). The body runs once
    /// unconditionally before the first condition test.
    /// @param originatingSyntax The originating syntax node (used for diagnostics).
    /// @param bodySyntax The loop body statement.
    /// @param conditionSyntax The loop condition expression.
    /// @param labelName The ADR-0070 loop label, or `null`.
    /// @returns The bound block statement representing the lowered loop.
    private func BindDoWhileStatementCore(
        originatingSyntax SyntaxNode,
        bodySyntax StatementSyntax,
        conditionSyntax ExpressionSyntax,
        labelName string?
    ) BoundStatement {
        // Lowers to:
        //   {
        //     bodyLabel:
        //     <body>
        //     continueLabel:
        //     if cond goto bodyLabel
        //     breakLabel:
        //   }
        $scope = BoundScope($scope)
        var condition BoundExpression? = nil
        let headerParentScope = $scope
        let body = BindLoopBody(
            bodySyntax,
            labelName,
            out var breakLabel,
            out var continueLabel,
            bindIteration: () -> {
                $scope = BoundScope(headerParentScope)
                try {
                    condition = bindExpressionWithTargetType(conditionSyntax, TypeSymbol.Bool)
                    let boundBody = Invariant.Required(
                        BindStatement(bodySyntax),
                        "a loop body has a bound statement",
                        expression: "BindStatement(bodySyntax)"
                    )
                    return (boundBody, nil, condition)
                } finally {
                    $scope = headerParentScope
                }
            }
        )
        $scope = $scope.Pop()
        let bodyLabel = BoundLabel("body${binderCtx.LabelCounter}")
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(BoundLabelStatement(originatingSyntax, bodyLabel))
        statements.Add(body)
        statements.Add(BoundLabelStatement(originatingSyntax, continueLabel))
        statements.Add(
            BoundConditionalGotoStatement(
                originatingSyntax,
                bodyLabel,
                Invariant.Required(condition, "a do-while loop has a bound condition", expression: "condition"),
                jumpIfTrue: true
            )
        )
        statements.Add(BoundLabelStatement(originatingSyntax, breakLabel))
        return BoundBlockStatement(originatingSyntax, statements.ToImmutable())
    }

    private func BindLabeledStatement(syntax LabeledStatementSyntax) BoundStatement {
        let labelName = syntax.LabelIdentifier.ValueText
        let inner = syntax.Statement
        // Issue #1884: a label on any non-loop statement is a `goto` target
        // rather than an ADR-0070 loop label. Emit a BoundLabelStatement
        // immediately ahead of the bound inner statement, grouped in a
        // BoundBlockStatement purely for return-shape convenience — Lowerer
        // flattens it into the enclosing statement list, so it introduces no
        // new binder scope (a `label: var x = …` still declares `x` into the
        // enclosing block, matching C#'s `goto`/label semantics).
        if !IsLabelableLoop(inner) {
            let reachableOnEntry = currentStatementListFallsThrough
            let userLabel = DefineUserLabel(labelName, syntax.LabelIdentifier.Location)
            let boundInner = BindStatement(inner)
            let labeledStatement = BoundBlockStatement(
                syntax,
                ImmutableArray.Create[BoundStatement](
                    BoundLabelStatement(syntax, userLabel),
                    Invariant.Required(
                        boundInner,
                        "a labeled statement has a bound inner statement",
                        expression: "boundInner"
                    )
                )
            )
            if !reachableOnEntry && currentStatementListFallsThrough && !EndsInUnconditionalExit(boundInner) {
                internallyReachableFallthroughStatements.Add(labeledStatement)
            }
            return labeledStatement
        }
        // ADR-0070: a label that shadows an enclosing live loop's label is a
        // warning — the inner label wins for break/continue resolution.
        for frame in binderCtx.LoopStack {
            if frame.LabelName == labelName {
                Diagnostics.ReportLabelShadowsEnclosingLoop(syntax.LabelIdentifier.Location, labelName)
                break
            }
        }
        return switch inner.Kind {
            case SyntaxKind.WhileLetStatement: BindWhileLetStatementCore(
                syntax,
                (cast[WhileLetStatementSyntax](inner)).Bindings,
                (cast[WhileLetStatementSyntax](inner)).Body,
                labelName
            )
            case SyntaxKind.WhileStatement: BindForConditionStatementCore(
                syntax,
                (cast[WhileStatementSyntax](inner)).Condition,
                (cast[WhileStatementSyntax](inner)).Body,
                labelName
            )
            case SyntaxKind.DoWhileStatement: BindDoWhileStatementCore(
                syntax,
                (cast[DoWhileStatementSyntax](inner)).Body,
                (cast[DoWhileStatementSyntax](inner)).Condition,
                labelName
            )
            case SyntaxKind.ForInfiniteStatement: BindForInfiniteStatementCore(
                syntax,
                (cast[ForInfiniteStatementSyntax](inner)).Body,
                labelName
            )
            case SyntaxKind.ForEllipsisStatement: BindForEllipsisStatementCore(
                cast[ForEllipsisStatementSyntax](inner),
                syntax,
                labelName
            )
            case SyntaxKind.ForConditionStatement: BindForConditionStatementCore(
                syntax,
                (cast[ForConditionStatementSyntax](inner)).Condition,
                (cast[ForConditionStatementSyntax](inner)).Body,
                labelName
            )
            case SyntaxKind.ForClauseStatement: BindForClauseStatementCore(
                cast[ForClauseStatementSyntax](inner),
                syntax,
                labelName
            )
            case SyntaxKind.ForRangeStatement: BindForRangeStatementCore(
                cast[ForRangeStatementSyntax](inner),
                labelName,
                syntax
            )
            case SyntaxKind.ForTupleRangeStatement: BindForTupleRangeStatementCore(
                cast[ForTupleRangeStatementSyntax](inner),
                labelName,
                syntax
            )
            case SyntaxKind.AwaitForRangeStatement: BindAwaitForRangeStatementCore(
                cast[AwaitForRangeStatementSyntax](inner),
                labelName,
                syntax
            )
            default: Invariant.Required(
                BindStatement(inner),
                "a labeled statement has a bound inner statement",
                expression: "BindStatement(inner)"
            )
        }
    }

    private func BindLabeledForRange(
        labelSyntax LabeledStatementSyntax,
        inner ForRangeStatementSyntax,
        labelName string?
    ) BoundStatement {
        return BindForRangeStatementCore(inner, labelName, labelSyntax)
    }

    shared {
        private func GetIteratorElementType(type TypeSymbol) TypeSymbol {
            var type = type
            // ADR-0186 §9: an iterator declared in an oblivious scope returns
            // `IEnumerable[string!]!`; its shape is the underlying type's.
            type = PlatformTypeSymbol.StripTopLevel(type)
            if type is SequenceTypeSymbol seq {
                return seq.ElementType
            }
            // Issue #798: `async sequence[T]` (ADR-0041) is AsyncSequenceTypeSymbol;
            // surface its ElementType the same way SequenceTypeSymbol does so
            // `yield` accepts the symbolic T rather than collapsing to `object`
            // through the type-erased ClrType.
            if type is AsyncSequenceTypeSymbol aseq {
                return aseq.ElementType
            }
            // #313 / issue #798: when the iterator return type is an
            // `ImportedTypeSymbol` constructed over symbolic type arguments
            // (e.g. `IEnumerable[T]` / `IAsyncEnumerable[T]` inside a generic
            // function), prefer the symbolic TypeArguments[0] over the
            // type-erased ClrType form (`IEnumerable<object>`). Otherwise the
            // element type collapses to `object`, and `yield v` where `v: T`
            // fails to bind because the binder doesn't accept the implicit
            // `T → object` conversion ("Cannot convert type 'T' to 'object'").
            if type is ImportedTypeSymbol importedSym &&
                importedSym.OpenDefinition != nil &&
                !importedSym
                .TypeArguments
                .IsDefaultOrEmpty {
                let def = importedSym.OpenDefinition
                if def.FullName == "System.Collections.Generic.IEnumerable`1" ||
                    def.FullName == "System.Collections.Generic.IEnumerator`1" ||
                    def.FullName == "System.Collections.Generic.IAsyncEnumerable`1" ||
                    def.FullName == "System.Collections.Generic.IAsyncEnumerator`1" {
                    return importedSym.TypeArguments[0]
                }
            }
            let clr Type? = type?.ClrType
            if clr == nil {
                return TypeSymbol.FromClrTypeWithoutNullability(typeof(object), NullabilityFreeReason.TypeLiteral)
            }
            if clr.IsGenericType && !clr.IsGenericTypeDefinition {
                let def = clr.GetGenericTypeDefinition()
                if def.FullName == "System.Collections.Generic.IEnumerable`1" ||
                    def.FullName == "System.Collections.Generic.IEnumerator`1" {
                    return TypeSymbol.FromClrTypeWithoutNullability(
                        clr.GetGenericArguments()[0],
                        NullabilityFreeReason.TypeStructure
                    )
                }
                // Async iterators: IAsyncEnumerable<T> / IAsyncEnumerator<T>
                if def.FullName == "System.Collections.Generic.IAsyncEnumerable`1" ||
                    def.FullName == "System.Collections.Generic.IAsyncEnumerator`1" {
                    return TypeSymbol.FromClrTypeWithoutNullability(
                        clr.GetGenericArguments()[0],
                        NullabilityFreeReason.TypeStructure
                    )
                }
            }
            return TypeSymbol.FromClrTypeWithoutNullability(typeof(object), NullabilityFreeReason.TypeLiteral)
        }

        /// Issue #1328: builds the symbolic `KeyValuePair[K, V]` element type
        /// for a single-identifier dictionary iteration. The closed
        /// `ImportedTypeSymbol.ClrType` is the type-erased
        /// `KeyValuePair<object, object>` (mirroring the #313/#671
        /// convention) while the symbolic `[K, V]` arguments are preserved so
        /// member access on the loop variable (`kv.Key`/`kv.Value`)
        /// recovers the user element types instead of erasing to `object`.
        /// This matches the element type the lowerer synthesises for the same loop
        /// ((cref:System.Collections.Generic.IEnumerable{T}) of
        /// `KeyValuePair[K, V]`).
        /// @param keyType The symbolic key type `K`.
        /// @param valueType The symbolic value type `V`.
        /// @returns The constructed `KeyValuePair[K, V]` symbol.
        private func BuildKeyValuePairType(keyType TypeSymbol, valueType TypeSymbol) TypeSymbol -> ImportedTypeSymbol
            .GetConstructed(
            typeof(KeyValuePair[object, object]),
            typeof(System.Collections.Generic.KeyValuePair[_, _]),
            ImmutableArray.Create(keyType, valueType)
        )

        /// Issue #1885: true when [`type`](paramref) is a reference type and
        /// therefore a legal `lock` target. Unwraps a nullable annotation to
        /// check the underlying type. G# classes ((cref:StructSymbol) with
        /// `IsClass`), interfaces, arrays, delegates, and function-value
        /// types are always reference types; imported CLR types defer to
        /// `ClrType.IsValueType`.
        private func IsLockableReferenceType(type TypeSymbol?) bool {
            var type = type
            if type == nil || type == TypeSymbol.Error {
                return true
            }
            if type is NullableTypeSymbol nullable {
                type = nullable.UnderlyingType
            }
            switch type {
                case structType is StructSymbol {
                    return structType.IsClass
                }
                case EnumSymbol {
                    return false
                }
                case InterfaceSymbol, ArrayTypeSymbol, DelegateTypeSymbol, FunctionTypeSymbol {
                    return true
                }
            }
            return type!!.ClrType == nil || !type!!.ClrType!!.IsValueType
        }

        private func IsLabelableLoop(stmt StatementSyntax) bool {
            return switch stmt.Kind {
                case SyntaxKind.WhileLetStatement: true
                case SyntaxKind.WhileStatement: true
                case SyntaxKind.DoWhileStatement: true
                case SyntaxKind.ForInfiniteStatement: true
                case SyntaxKind.ForEllipsisStatement: true
                case SyntaxKind.ForConditionStatement: true
                case SyntaxKind.ForClauseStatement: true
                case SyntaxKind.ForRangeStatement: true
                case SyntaxKind.ForTupleRangeStatement: true
                case SyntaxKind.AwaitForRangeStatement: true
                default: false
            }
        }
    }
}
