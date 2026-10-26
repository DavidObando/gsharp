// <copyright file="ExpressionBinder.Calls.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import System.Text
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import SystemObject = System.Object
import GSharp.Core.CodeAnalysis
import System.Globalization
import System.Runtime.CompilerServices
import System.Threading

internal partial class ExpressionBinder {
    private func BindWithExpression(syntax WithExpressionSyntax) BoundExpression {
        let receiver = BindExpression(syntax.Receiver)
        return LowerCopyOrWith(receiver, syntax.Initializers, syntax.WithToken.Location, syntax)
    }

    private func LowerCopyOrWith(
        receiver BoundExpression,
        overrides GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[FieldInitializerSyntax],
        diagnosticLocation TextLocation,
        copySyntax SyntaxNode
    ) BoundExpression {
        var receiver = receiver
        if receiver.Type == TypeSymbol.Error {
            return BoundErrorExpression(nil)
        }
        // ADR-0186 §4: copying reads every member of the receiver, so a
        // platform receiver is a coercion to non-null (checked and unwrapped).
        receiver = binderCtx.InsertPlatformCheck(receiver, diagnosticLocation, "a copy/with receiver")
        // Native copies preserve the whole value or dispatch through the
        // record clone; reconstructing visible members loses private state
        // and incorrectly reruns construction initializers.
        let normalizedReceiverType = ImportedTypeSymbol.NormalizeSemanticAggregate(
            receiver.Type,
            receiver.Type.ClrType,
            $scope.References
        )
        let structType StructSymbol? = switch normalizedReceiverType {
            case aggregate is StructSymbol: aggregate
            case NullabilityAnnotatedTypeSymbol{BaseType: StructSymbol aggregate}: aggregate
            default: default(StructSymbol?)
        }
        if structType == nil || !structType.IsData {
            Diagnostics.ReportCopyOrWithNotDataStruct(diagnosticLocation, receiver.Type)
            return BoundErrorExpression(nil)
        }
        if !object.ReferenceEquals(receiver.Type, structType) {
            receiver = BoundConversionExpression(nil, structType, receiver)
        }
        let tempName = "$$copy" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
            CultureInfo.InvariantCulture
        )
        let tempVar = LocalVariableSymbol(tempName, isReadOnly: true, structType)
        $scope.TryDeclareVariable(tempVar)
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(BoundVariableDeclaration(nil, tempVar, receiver))
        let captured = BoundVariableExpression(nil, tempVar)
        var copy BoundExpression
        if structType.IsClass && structType.ClrType is {} importedType {
            let cloneMethods = ClrTypeUtilities
                .SafeGetMethods(importedType, BindingFlags.Public | BindingFlags.Instance)
                .Where(
                (method MethodInfo) -> method.Name == "<Clone>$$" && !method.IsGenericMethod && method.GetParameters()
                    .Length == 0 &&
                    ClrTypeUtilities.AreSame(method.ReturnType, importedType)
            )
                .Take(2)
                .ToArray()
            if cloneMethods.Length != 1 {
                Diagnostics.ReportUnableToFindMember(diagnosticLocation, "<Clone>$$")
                return BoundErrorExpression(nil)
            }
            copy = BoundImportedInstanceCallExpression(
                copySyntax,
                captured,
                cloneMethods[0],
                structType,
                ImmutableArray[BoundExpression].Empty
            )
        } else {
            copy = BoundStructLiteralExpression(
                copySyntax,
                structType,
                ImmutableArray[BoundFieldInitializer].Empty,
                captured
            )
        }
        let copiedValue = LocalVariableSymbol(tempName + "result", isReadOnly: true, structType)
        $scope.TryDeclareVariable(copiedValue)
        statements.Add(BoundVariableDeclaration(nil, copiedValue, copy))
        let seen = HashSet[string]()
        for initSyntax in overrides {
            let memberName = initSyntax.FieldIdentifier.ValueText
            if !seen.Add(memberName) {
                Diagnostics.ReportSymbolAlreadyDeclared(initSyntax.FieldIdentifier.Location, memberName)
                continue
            }
            let hasUpdateProperty = TypeMemberModel.TryGetProperty(
                structType,
                memberName,
                out var updateProperty,
                out var updatePropertyDeclaringType
            )
            if TypeMemberModel.TryGetFieldIncludingInherited(
                structType,
                memberName,
                MemberQuery.Instance(MemberKinds.Field),
                out var field,
                out var fieldDeclaringType
            ) &&
                (
                !hasUpdateProperty ||
                    IsFieldAtLeastAsNearAsProperty(
                    structType,
                    fieldDeclaringType!!,
                    Invariant.Required(
                        updateProperty,
                        "a resolved property has a symbol",
                        expression: "updateProperty"
                    ),
                    Invariant.Required(
                        updatePropertyDeclaringType,
                        "a resolved property has a declaring type",
                        expression: "updatePropertyDeclaringType"
                    )
                )
            ) {
                // Issue #2059: a `with` update is a write to the named field —
                // enforce the same `protected`/`private` accessibility rule as a
                // plain assignment / composite literal member init (issue #950 /
                // #2044 / #2059).
                if !AccessibilityChecker.IsAccessible(field!!.Accessibility, fieldDeclaringType, this.function) {
                    Diagnostics.ReportMemberInaccessible(
                        initSyntax.FieldIdentifier.Location,
                        field!!.Name,
                        fieldDeclaringType!!.Name,
                        field!!.Accessibility
                    )
                }
                let fieldValueExpr = BindExpression(initSyntax.Value, field!!.Type)
                statements.Add(
                    BoundExpressionStatement(
                        initSyntax,
                        BoundFieldAssignmentExpression(
                            initSyntax,
                            copiedValue,
                            fieldDeclaringType!!,
                            field!!,
                            fieldValueExpr
                        )
                    )
                )
                continue
            }
            // Issue #2291: an imported C# record surfaces its positional
            // members as auto-properties (compiler-mangled backing fields),
            // not plain public fields like a gsc-native data class — fall
            // back to a settable property with the same name so `with`
            // updates a record's positional member through its setter/init
            // accessor instead of failing to find a field at all.
            if TypeMemberModel.TryGetProperty(
                structType,
                memberName,
                out var property,
                out var propertyDeclaringType
            ) &&
                property!!
                .HasSetter {
                propertyDeclaringType = Invariant.Required(
                    propertyDeclaringType,
                    "a user-defined struct property has a declaring type",
                    expression: "propertyDeclaringType"
                )
                if !AccessibilityChecker.IsAccessible(
                    property!!.SetterAccessibility,
                    propertyDeclaringType,
                    this.function
                ) {
                    Diagnostics.ReportMemberInaccessible(
                        initSyntax.FieldIdentifier.Location,
                        property!!.Name,
                        propertyDeclaringType.Name,
                        property!!.SetterAccessibility
                    )
                }
                let propertyValueExpr = BindExpression(initSyntax.Value, property!!.Type)
                statements.Add(
                    BoundExpressionStatement(
                        initSyntax,
                        BoundPropertyAssignmentExpression(
                            initSyntax,
                            BoundVariableExpression(nil, copiedValue),
                            propertyDeclaringType,
                            property!!,
                            propertyValueExpr
                        )
                    )
                )
                continue
            }
            Diagnostics.ReportUnableToFindMember(initSyntax.FieldIdentifier.Location, memberName)
        }
        return BoundBlockExpression(nil, statements.ToImmutable(), BoundVariableExpression(nil, copiedValue))
    }

    private func BindObjectCreationExpression(syntax ObjectCreationExpressionSyntax) BoundExpression {
        let target = BindExpression(
            Invariant.Required(syntax.Target, "an object creation has a target expression", expression: "syntax.Target")
        )
        return BindObjectInitializerSuffix(syntax, target)
    }

    /// Issue #569: applies the object-initializer suffix to an already-bound
    /// constructor call. Shared by (cref:BindObjectCreationExpression)
    /// (general path) and the accessor-step path for nested-type constructors
    /// with initializer suffixes (`Outer.Inner() { Prop = val }`).
    private func BindObjectInitializerSuffix(
        syntax ObjectCreationExpressionSyntax,
        target BoundExpression
    ) BoundExpression {
        if target.Type == TypeSymbol.Error || target.Type == nil {
            for init in syntax.Initializers {
                let _ = BindExpression(init.Value)
            }
            return BoundErrorExpression(nil)
        }
        let resultType = target.Type
        let tempName = "$$objinit" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
            CultureInfo.InvariantCulture
        )
        let tempVar = LocalVariableSymbol(tempName, isReadOnly: true, resultType)
        $scope.TryDeclareVariable(tempVar)
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(BoundVariableDeclaration(syntax, tempVar, target))
        let seen = HashSet[string]()
        for initSyntax in syntax.Initializers {
            let propertyName = initSyntax.PropertyIdentifier.ValueText
            if !seen.Add(propertyName) {
                Diagnostics.ReportSymbolAlreadyDeclared(initSyntax.PropertyIdentifier.Location, propertyName)
                continue
            }
            // Issue #1858: a braced member value `Prop = { a, b }` populates a
            // (typically get-only) collection member via `.Add(...)` calls —
            // the same target-less collection-initializer form already
            // supported by the struct/imported-class composite literals
            // (issue #1567). Handling it here lets a collection member
            // combine with constructor arguments in the initializer-suffix
            // form (gsc issue #522), which neither of those literals covers.
            if initSyntax.Value is CollectionInitializerExpressionSyntax{Target: nil} bracedInit {
                let bracedReceiver = BoundVariableExpression(initSyntax, tempVar)
                if TryEmitMemberCollectionInitializer(
                    bracedReceiver,
                    propertyName,
                    initSyntax.PropertyIdentifier,
                    bracedInit,
                    statements
                ) {
                    continue
                }
                // Not a collection member (or not found) — fall through to the
                // normal assignment path below, whose own lookup reports the
                // appropriate diagnostic (unfound member, unassignable, or the
                // defensive not-collection-initializable report when
                // BindExpression is reached on the braced value).

            }
            let assignment BoundExpression? = BindObjectInitializerAssignment(tempVar, resultType, initSyntax)
            if assignment == nil {
                continue
            }
            statements.Add(BoundExpressionStatement(initSyntax, assignment))
        }
        let resultExpr = BoundVariableExpression(syntax, tempVar)
        return BoundBlockExpression(syntax, statements.ToImmutable(), resultExpr)
    }

    /// Issue #479 / ADR-0117: binds a collection initializer
    /// (`List[int32]{1, 2, 3}`, `Dictionary[K, V]{"a": 1}`,
    /// `Dictionary[K, V](cmp){ ["k"] = v }`). The target constructor call
    /// is bound into a synthetic local; each element lowers to an
    /// `Add(...)` call (bare / `key: value` entries) or an indexer set
    /// (`[key] = value` entries); the block yields the local. The lowering
    /// uses only existing bound nodes, so emit and the interpreter both work
    /// without a new bound-node kind.
    private func BindCollectionInitializerExpression(syntax CollectionInitializerExpressionSyntax) BoundExpression {
        if syntax.BufferType != nil {
            return BindNativeBufferLiteral(syntax)
        }
        // Issue #1567: a target-less collection initializer only appears as a
        // composite/object-initializer member value (`T{ Prop: { a, b } }`) and
        // is consumed directly by the composite-literal binder — it never
        // reaches general expression binding. Guard defensively.
        if syntax.Target == nil {
            Diagnostics.ReportTypeNotCollectionInitializable(syntax.OpenBraceToken.Location, TypeSymbol.Error)
            BindCollectionElementsForDiagnostics(syntax)
            return BoundErrorExpression(nil)
        }
        return BindCollectionInitializerSuffix(syntax, BindExpression(syntax.Target!!))
    }

    private func BindCollectionInitializerSuffix(
        syntax CollectionInitializerExpressionSyntax,
        target BoundExpression
    ) BoundExpression {
        var target = target
        if target.Type == TypeSymbol.Error || target.Type == nil {
            BindCollectionElementsForDiagnostics(syntax)
            return BoundErrorExpression(nil)
        }
        if target is BoundStructLiteralExpression{StructType: {IsClass: false}} literal &&
            !literal.CallsDataConstructor &&
            !(literal.StructType.Definition ?? literal.StructType)
            .NeedsSynthesizedValueStructDefaultCtor {
            let initializers = literal.Initializers.ToBuilder()
            let initializedMembers = literal
                .Initializers
                .Select((initializer BoundFieldInitializer) -> initializer.MemberName)
                .ToHashSet(StringComparer.Ordinal)
            for field in literal.StructType.Fields {
                if !initializedMembers.Contains(field.Name) &&
                    GetStructFieldZeroValue(syntax, literal.StructType, field) is {} zeroValue {
                    initializers.Add(BoundFieldInitializer(field, zeroValue))
                }
            }
            target = BoundStructLiteralExpression(
                literal.Syntax,
                literal.StructType,
                initializers.ToImmutable(),
                literal.CopySource,
                literal.IsZeroInitialization
            )
        }
        let resultType = target.Type
        var hasNonIndexedElement = false
        var hasSpreadElement = false
        for element in syntax.Elements {
            hasNonIndexedElement |= !(element is IndexedCollectionElementSyntax) &&
                !(element is MemberCollectionElementSyntax)
            let expressionElement = element as ExpressionCollectionElementSyntax
            hasSpreadElement |= expressionElement?.Expression is SpreadElementExpressionSyntax
        }
        // A collection initializer requires an accessible instance `Add` for the
        // bare / key:value element forms. Indexed `[k] = v` entries go through
        // the indexer-set path, which reports its own GS0226/indexability errors.
        if (hasNonIndexedElement && !HasCollectionAdd(resultType)) ||
            (hasSpreadElement && !HasUnaryCollectionAdd(resultType)) {
            let diagnosticLocal = LocalVariableSymbol("$$collinitdiagnostic", isReadOnly: false, resultType)
            for member in syntax.Elements.OfType[MemberCollectionElementSyntax]() {
                let _ = BindInitializerMemberAssignment(
                    diagnosticLocal,
                    resultType,
                    member.Initializer.FieldIdentifier,
                    member.Initializer.ColonToken,
                    member.Initializer.Value,
                    member
                )
            }
            Diagnostics.ReportTypeNotCollectionInitializable(syntax.OpenBraceToken.Location, resultType)
            BindCollectionElementsForDiagnostics(syntax, skipMemberElements: true)
            return BoundErrorExpression(nil)
        }
        let tempName = "$$collinit" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
            CultureInfo.InvariantCulture
        )
        let tempVar = LocalVariableSymbol(tempName, isReadOnly: false, resultType)
        $scope.TryDeclareVariable(tempVar)
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(BoundVariableDeclaration(syntax, tempVar, target))
        if target is BoundDefaultExpression && resultType.ClrType is {IsValueType: true} clrType {
            AppendImportedStructZeroInitializers(syntax, clrType, tempVar, excludedMembers: nil, statements)
        }
        EmitCollectionElementAddStatements(tempVar, syntax.Elements, statements)
        let resultExpr = BoundVariableExpression(syntax, tempVar)
        return BoundBlockExpression(syntax, statements.ToImmutable(), resultExpr)
    }

    /// Issue #479 / ADR-0117 (and #1567): lowers each collection element into an
    /// `Add(...)` call (bare / `key: value` entries) or an indexer set
    /// (`[key] = value` entries) against the collection held by
    /// [`collectionLocal`](paramref), appending the required statements
    /// for each element.
    /// Shared by the standalone collection initializer and the member
    /// collection initializer that populates a get-only collection property.
    private func EmitCollectionElementAddStatements(
        collectionLocal LocalVariableSymbol,
        elements GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[CollectionElementSyntax],
        statements ImmutableArray[BoundStatement].Builder
    ) {
        let seenMembers = HashSet[string](StringComparer.Ordinal)
        for element in elements {
            var bound BoundExpression
            switch element {
                case member is MemberCollectionElementSyntax {
                    let initializer = member.Initializer
                    let memberName = initializer.FieldIdentifier.ValueText
                    if !seenMembers.Add(memberName) {
                        Diagnostics.ReportSymbolAlreadyDeclared(initializer.FieldIdentifier.Location, memberName)
                        continue
                    }
                    if initializer.Value is CollectionInitializerExpressionSyntax{Target: nil} braced &&
                        TryEmitMemberCollectionInitializer(
                        BoundVariableExpression(member, collectionLocal),
                        memberName,
                        initializer.FieldIdentifier,
                        braced,
                        statements
                    ) {
                        continue
                    }
                    let assignment BoundExpression? = BindInitializerMemberAssignment(
                        collectionLocal,
                        collectionLocal.Type,
                        initializer.FieldIdentifier,
                        initializer.ColonToken,
                        initializer.Value,
                        initializer
                    )
                    if assignment != nil {
                        statements.Add(BoundExpressionStatement(member, assignment))
                    }
                    continue
                }
                case ExpressionCollectionElementSyntax{Expression: SpreadElementExpressionSyntax spread} {
                    statements.AddRange(BindCollectionSpreadStatements(collectionLocal, spread))
                    continue
                }
                case bare is ExpressionCollectionElementSyntax {
                    bound = BindCollectionAddCall(collectionLocal, element, ImmutableArray.Create(bare.Expression))
                }
                case keyed is KeyedCollectionElementSyntax {
                    bound = BindCollectionAddCall(
                        collectionLocal,
                        element,
                        ImmutableArray.Create(keyed.Key, keyed.Value)
                    )
                }
                case indexed is IndexedCollectionElementSyntax {
                    bound = BindIndexedAssignmentToVariable(
                        collectionLocal,
                        indexed.Key,
                        indexed.Value,
                        indexed.EqualsToken.Location
                    )
                }
                default {
                    bound = BoundErrorExpression(nil)
                }
            }
            statements.Add(BoundExpressionStatement(element, bound))
        }
    }

    /// Issue #3096: lowers `...source` to a compiler-synthesized lambda
    /// that receives the collection and source as parameters, uses native
    /// for-range plus the target's ordinary `Add` overload, and returns
    /// the updated collection. Keeping the loop in a non-capturing lambda makes
    /// the outer initializer straight-line and verifiable even when another
    /// operand or assignment receiver is already on the IL evaluation stack.
    private func BindCollectionSpreadStatements(
        collectionLocal LocalVariableSymbol,
        spread SpreadElementExpressionSyntax
    ) ImmutableArray[BoundStatement] {
        let tree = spread.SyntaxTree
        let position = spread.Span.Start
        let sourceName = "$$spreadsource" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
            CultureInfo.InvariantCulture
        )
        let sourceToken = SyntaxToken(tree, SyntaxKind.IdentifierToken, position, sourceName, nil)
        var source = BindExpression(spread.Expression)
        if TypeSymbol.IsByRefLike(source.Type) {
            // A ref-like source cannot be captured by the synthesized lambda.
            // Materialize its ordinary ToArray() value first; the call still
            // evaluates the source exactly once and preserves element order.
            source = BindAccessorCall(
                source,
                classSymbol: nil,
                SynthesizeInstanceCall(spread, "ToArray", ImmutableArray[ExpressionSyntax].Empty)
            )
        }
        let sourceLocal = LocalVariableSymbol(sourceName, isReadOnly: true, source.Type)
        $scope.TryDeclareVariable(sourceLocal)
        let _ = TryGetCollectionSpreadElementType(collectionLocal.Type, out var targetElementType)
        if function?.IsStaticInitializer == true && function!!.StaticOwnerType is InterfaceSymbol {
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
                targetElementType
            )
        }
        let targetName = "$$spreadtarget" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
            CultureInfo.InvariantCulture
        )
        let targetToken = SyntaxToken(tree, SyntaxKind.IdentifierToken, position, targetName, nil)
        let sourceParameterName = "$$spreaditems" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
            CultureInfo.InvariantCulture
        )
        let sourceParameterToken = SyntaxToken(tree, SyntaxKind.IdentifierToken, position, sourceParameterName, nil)
        let itemName = "$$spreaditem" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
            CultureInfo.InvariantCulture
        )
        let itemToken = SyntaxToken(tree, SyntaxKind.IdentifierToken, position, itemName, nil)
        let itemExpression = NameExpressionSyntax(tree, itemToken)
        let addCall = SynthesizeInstanceCall(spread, "Add", ImmutableArray.Create[ExpressionSyntax](itemExpression))
        let body = ExpressionStatementSyntax(
            tree,
            AccessorExpressionSyntax(
                tree,
                NameExpressionSyntax(tree, targetToken),
                SyntaxToken(tree, SyntaxKind.DotToken, position, ".", nil),
                addCall
            )
        )
        let loop = ForRangeStatementSyntax(
            tree,
            SyntaxToken(tree, SyntaxKind.ForKeyword, position, "for", nil),
            itemToken,
            typeClause: nil,
            commaToken: nil,
            secondIdentifier: nil,
            colonEqualsToken: nil,
            rangeKeyword: nil,
            inToken: SyntaxToken(tree, SyntaxKind.IdentifierToken, position, "in", nil),
            collection: NameExpressionSyntax(tree, sourceParameterToken),
            body: body
        )
        let parameterNodes = ImmutableArray.CreateBuilder[SyntaxNode]()
        parameterNodes.Add(ParameterSyntax(tree, targetToken, type: nil))
        parameterNodes.Add(SyntaxToken(tree, SyntaxKind.CommaToken, position, ",", nil))
        parameterNodes.Add(ParameterSyntax(tree, sourceParameterToken, type: nil))
        let lambdaBody = BlockExpressionSyntax(
            tree,
            SyntaxToken(tree, SyntaxKind.OpenBraceToken, position, "{", nil),
            ImmutableArray.Create[StatementSyntax](loop),
            expression: NameExpressionSyntax(tree, targetToken),
            SyntaxToken(tree, SyntaxKind.CloseBraceToken, position, "}", nil)
        )
        let lambda = LambdaExpressionSyntax(
            tree,
            SyntaxToken(tree, SyntaxKind.OpenParenthesisToken, position, "(", nil),
            GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ParameterSyntax](parameterNodes.ToImmutable()),
            SyntaxToken(tree, SyntaxKind.CloseParenthesisToken, position, ")", nil),
            SyntaxToken(tree, SyntaxKind.RightArrowToken, position, "->", nil),
            lambdaBody
        )
        let functionType = FunctionTypeSymbol.Get(
            ImmutableArray.Create(collectionLocal.Type, source.Type),
            collectionLocal.Type
        )
        var boundLambda = lambdas.BindLambdaExpression(lambda, functionType)
        if targetElementType != nil && boundLambda is BoundFunctionLiteralExpression literal {
            boundLambda = RewriteCollectionSpreadLambda(literal, targetElementType, spread)
        }
        let invocation = BoundIndirectCallExpression(
            spread,
            boundLambda,
            functionType,
            ImmutableArray.Create[BoundExpression](
                BoundVariableExpression(spread, collectionLocal),
                BoundVariableExpression(spread, sourceLocal)
            )
        )
        let assignment = BoundAssignmentExpression(spread, collectionLocal, invocation)
        return ImmutableArray.Create[BoundStatement](
            BoundVariableDeclaration(spread, sourceLocal, source),
            BoundExpressionStatement(spread, assignment)
        )
    }

    private func BindInterfaceStaticSpreadStatements(
        collectionLocal LocalVariableSymbol,
        spread SpreadElementExpressionSyntax,
        sourceLocal LocalVariableSymbol,
        sourceToken SyntaxToken,
        source BoundExpression,
        targetElementType TypeSymbol?
    ) ImmutableArray[BoundStatement] {
        let tree = spread.SyntaxTree
        let position = spread.Span.Start
        let itemName = "$$spreaditem" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
            CultureInfo.InvariantCulture
        )
        let itemToken = SyntaxToken(tree, SyntaxKind.IdentifierToken, position, itemName, nil)
        let addCall = SynthesizeInstanceCall(
            spread,
            "Add",
            ImmutableArray.Create[ExpressionSyntax](NameExpressionSyntax(tree, itemToken))
        )
        let loop = ForRangeStatementSyntax(
            tree,
            SyntaxToken(tree, SyntaxKind.ForKeyword, position, "for", nil),
            itemToken,
            typeClause: nil,
            commaToken: nil,
            secondIdentifier: nil,
            colonEqualsToken: nil,
            rangeKeyword: nil,
            inToken: SyntaxToken(tree, SyntaxKind.IdentifierToken, position, "in", nil),
            collection: NameExpressionSyntax(tree, sourceToken),
            body: ExpressionStatementSyntax(
                tree,
                AccessorExpressionSyntax(
                    tree,
                    NameExpressionSyntax(
                        tree,
                        SyntaxToken(tree, SyntaxKind.IdentifierToken, position, collectionLocal.Name, nil)
                    ),
                    SyntaxToken(tree, SyntaxKind.DotToken, position, ".", nil),
                    addCall
                )
            )
        )
        var bound = bindStatementList(ImmutableArray.Create[StatementSyntax](loop), nil).Single()
        if targetElementType != nil {
            bound = CollectionSpreadLoopRewriter(this, collectionLocal, targetElementType, spread).Rewrite(bound)
        }
        return ImmutableArray.Create[BoundStatement](
            BoundVariableDeclaration(spread, sourceLocal, source),
            Lowerer.Lower(bound)
        )
    }

    private func RewriteCollectionSpreadLambda(
        literal BoundFunctionLiteralExpression,
        targetElementType TypeSymbol,
        spread SpreadElementExpressionSyntax
    ) BoundFunctionLiteralExpression {
        let body = cast[BoundBlockStatement](
            CollectionSpreadLoopRewriter(this, literal.Function.Parameters[0], targetElementType, spread).Rewrite(
                literal.Body
            )
        )
        return BoundFunctionLiteralExpression(
            literal.Syntax,
            literal.Function,
            literal.FunctionType,
            body,
            literal.CapturedVariables
        )
    }

    private func BindConvertedCollectionAddCall(
        receiverVariable VariableSymbol,
        itemVariable VariableSymbol,
        targetElementType TypeSymbol,
        spread SpreadElementExpressionSyntax
    ) BoundExpression {
        let placeholderName = "$$spreadconverted" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
            CultureInfo.InvariantCulture
        )
        let placeholderToken = SyntaxToken(
            spread.SyntaxTree,
            SyntaxKind.IdentifierToken,
            spread.Span.Start,
            placeholderName,
            nil
        )
        let placeholder = LocalVariableSymbol(placeholderName, isReadOnly: true, targetElementType)
        var add BoundExpression
        let previousScope = $scope
        $scope = BoundScope($scope)
        try {
            $scope.TryDeclareVariable(receiverVariable)
            $scope.TryDeclareVariable(placeholder)
            add = BindCollectionAddCall(
                receiverVariable,
                spread,
                ImmutableArray.Create[ExpressionSyntax](NameExpressionSyntax(spread.SyntaxTree, placeholderToken))
            )
        } finally {
            $scope = previousScope
        }
        let convertedItem = conversions.BindConversion(
            spread.Location,
            BoundVariableExpression(spread, itemVariable),
            targetElementType
        )
        return CollectionSpreadItemSubstitutionRewriter(placeholder, convertedItem).Rewrite(add)
    }

    private class CollectionSpreadLoopRewriter : BoundTreeRewriter {
        private let binder ExpressionBinder
        private let receiver VariableSymbol
        private let targetElementType TypeSymbol
        private let spread SpreadElementExpressionSyntax

        init(
            binder ExpressionBinder,
            receiver VariableSymbol,
            targetElementType TypeSymbol,
            spread SpreadElementExpressionSyntax
        ) {
            this.binder = binder
            this.receiver = receiver
            this.targetElementType = targetElementType
            this.spread = spread
        }

        func Rewrite(statement BoundStatement) BoundStatement -> RewriteStatement(statement)

        protected override func RewriteForRangeStatement(node BoundForRangeStatement) BoundStatement {
            let add = binder.BindConvertedCollectionAddCall(receiver, node.ValueVariable, targetElementType, spread)
            return BoundForRangeStatement(
                node.Syntax,
                node.KeyVariable,
                node.ValueVariable,
                node.Collection,
                node.IterationKind,
                BoundExpressionStatement(spread, add),
                node.BreakLabel,
                node.ContinueLabel
            )
        }
    }

    private class CollectionSpreadItemSubstitutionRewriter : BoundTreeRewriter {
        private let placeholder VariableSymbol
        private let replacement BoundExpression

        init(placeholder VariableSymbol, replacement BoundExpression) {
            this.placeholder = placeholder
            this.replacement = replacement
        }

        func Rewrite(expression BoundExpression) BoundExpression -> RewriteExpression(expression)

        protected override func RewriteVariableExpression(
            node BoundVariableExpression
        ) BoundExpression -> if object.ReferenceEquals(node.Variable, placeholder) {
            replacement
        } else {
            cast[BoundExpression](node)
        }
    }

    /// Issue #1567: lowers a <em>member</em> collection initializer
    /// (`Member: { a, b }` / `Member = { a, b }`) that populates a
    /// get-only (or settable) collection property of a just-constructed
    /// [`receiver`](paramref). Reads `receiver.Member` — a get-only
    /// property is readable even though it cannot be assigned — into a synthetic
    /// local and reuses the standalone collection-initializer element lowering to
    /// emit an `Add(...)` call / indexer set per element. Because the
    /// collection is a reference type the local aliases the property's collection
    /// in place, mirroring the C# `receiver.Member.Add(x)` lowering.
    /// Returns `false` when the member is not a collection (its
    /// type exposes no accessible `Add` for non-indexed elements), so the
    /// caller falls back to its normal assignment / GS0127 handling.
    private func TryEmitMemberCollectionInitializer(
        receiver BoundExpression,
        memberName string,
        anchor SyntaxNode,
        braced CollectionInitializerExpressionSyntax,
        statements ImmutableArray[BoundStatement].Builder
    ) bool {
        let tree = anchor.SyntaxTree
        let position = anchor.Span.Start
        let nameToken = SyntaxToken(tree, SyntaxKind.IdentifierToken, position, memberName, nil)
        let nameSyntax = NameExpressionSyntax(tree, nameToken)
        let propRead = BindAccessorStep(receiver, classSymbol: nil, nameSyntax)
        if propRead is BoundErrorExpression || propRead.Type == nil || propRead.Type == TypeSymbol.Error {
            return false
        }
        // Reference nullability is metadata-only here. Keep the runtime value
        // unchecked so assignment/Add arguments run before callvirt observes a
        // null receiver, matching C# evaluation order.
        let memberLocalType = if propRead.Type is NullableTypeSymbol nullableMember && Conversion.IsReferenceLikeTarget(
            nullableMember.UnderlyingType
        ) {
            nullableMember.UnderlyingType
        } else {
            propRead.Type
        }
        let nestedObjectAssignments = ImmutableArray.CreateBuilder[AssignmentExpressionSyntax?](braced.Elements.Count)
        var hasNonIndexedElement = false
        var hasSpreadElement = false
        var allElementsAreAssignments = braced.Elements.Count > 0
        for element in braced.Elements {
            let expressionElement = element as ExpressionCollectionElementSyntax
            let assignment AssignmentExpressionSyntax? = expressionElement?.Expression as AssignmentExpressionSyntax
            nestedObjectAssignments.Add(assignment)
            allElementsAreAssignments &= assignment != nil
            hasNonIndexedElement |= !(element is IndexedCollectionElementSyntax) &&
                !(element is MemberCollectionElementSyntax)
            hasSpreadElement |= expressionElement?.Expression is SpreadElementExpressionSyntax
        }
        let isNestedObjectInitializer = allElementsAreAssignments
        if !isNestedObjectInitializer &&
            (
            (hasNonIndexedElement && !HasCollectionAdd(memberLocalType)) ||
                (hasSpreadElement && !HasUnaryCollectionAdd(memberLocalType))
        ) {
            return false
        }
        let tempName = "$$collinit" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
            CultureInfo.InvariantCulture
        )
        let memberLocal = LocalVariableSymbol(tempName, isReadOnly: false, memberLocalType)
        $scope.TryDeclareVariable(memberLocal)
        statements.Add(BoundVariableDeclaration(braced, memberLocal, propRead))
        if isNestedObjectInitializer {
            for assignment in nestedObjectAssignments {
                let nonNullAssignment = Invariant.Required(
                    assignment,
                    "a nested collection initializer contains only assignment elements",
                    expression: "assignment"
                )
                let initializer = PropertyInitializerSyntax(
                    nonNullAssignment.SyntaxTree,
                    nonNullAssignment.IdentifierToken,
                    nonNullAssignment.EqualsToken,
                    nonNullAssignment.Expression
                )
                let boundAssignment BoundExpression? = BindObjectInitializerAssignment(
                    memberLocal,
                    memberLocalType,
                    initializer
                )
                if boundAssignment != nil {
                    statements.Add(BoundExpressionStatement(initializer, boundAssignment))
                }
            }
            return true
        }
        EmitCollectionElementAddStatements(memberLocal, braced.Elements, statements)
        return true
    }

    /// Issue #479 / ADR-0117: lowers one bare / key:value collection element to
    /// an `Add(...)` call on the synthetic collection local. A synthetic
    /// (cref:CallExpressionSyntax) named `Add` is bound through the
    /// shared accessor-call path so overload resolution, generic-argument
    /// inference, and parameter conversions all match a hand-written
    /// `coll.Add(...)`.
    private func BindCollectionAddCall(
        receiverLocal VariableSymbol,
        anchor SyntaxNode,
        arguments ImmutableArray[ExpressionSyntax]
    ) BoundExpression {
        let receiver = BoundVariableExpression(anchor, receiverLocal)
        let addCall = SynthesizeInstanceCall(anchor, "Add", arguments)
        return BindAccessorCall(receiver, classSymbol: nil, addCall)
    }

    /// Issue #479 / ADR-0117: builds a synthetic instance-call syntax node
    /// (`Add(arg0, arg1, …)`) anchored at [`anchor`](paramref) so the
    /// shared call binder can resolve the method and bind the argument syntaxes.
    private func SynthesizeInstanceCall(
        anchor SyntaxNode,
        methodName string,
        arguments ImmutableArray[ExpressionSyntax]
    ) CallExpressionSyntax {
        let tree = anchor.SyntaxTree
        let position = anchor.Span.Start
        let identifier = SyntaxToken(tree, SyntaxKind.IdentifierToken, position, methodName, nil)
        let openParen = SyntaxToken(tree, SyntaxKind.OpenParenthesisToken, position, "(", nil)
        let closeParen = SyntaxToken(tree, SyntaxKind.CloseParenthesisToken, position, ")", nil)
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        for var i = 0; i < arguments.Length; i++ {
            nodesAndSeparators.Add(arguments[i])
            if i < arguments.Length - 1 {
                nodesAndSeparators.Add(SyntaxToken(tree, SyntaxKind.CommaToken, position, ",", nil))
            }
        }
        let argumentList = GSharp
            .Core
            .CodeAnalysis
            .Syntax
            .SeparatedSyntaxList[ExpressionSyntax](nodesAndSeparators.ToImmutable())
        let call = CallExpressionSyntax(tree, identifier, openParen, argumentList, closeParen)
        // Issue #4013: mark a synthesized collection-initializer `Add` so the
        // instance-call candidate lookup keeps offering an explicitly
        // implemented interface `Add` for THIS node only. An ordinary
        // author-written `xs.Add(…)` no longer reaches such a member — that is
        // the fix — but ADR-0117's collection literals and the #3096 spread
        // form legitimately fill a `Dictionary[K, V]` through the explicit
        // `ICollection<KeyValuePair<K, V>>.Add`, lowering the call through the
        // interface. Every synthesized `Add` in this binder is a collection
        // initializer's; the mark is per-node, so the arguments bound inside it
        // are unaffected.
        if string.Equals(methodName, "Add", StringComparison.Ordinal) {
            SynthesizedCollectionAddCalls.Add(call, MarkerValue)
        }
        return call
    }

    private func BindCollectionElementsForDiagnostics(
        syntax CollectionInitializerExpressionSyntax,
        skipMemberElements bool = false
    ) {
        for element in syntax.Elements {
            switch element {
                case member is MemberCollectionElementSyntax {
                    if !skipMemberElements {
                        let _ = BindExpression(member.Initializer.Value)
                    }
                }
                case ExpressionCollectionElementSyntax{Expression: SpreadElementExpressionSyntax spread} {
                    let _ = BindExpression(spread.Expression)
                }
                case bare is ExpressionCollectionElementSyntax {
                    let _ = BindExpression(bare.Expression)
                }
                case keyed is KeyedCollectionElementSyntax {
                    let _ = BindExpression(keyed.Key)
                    let _ = BindExpression(keyed.Value)
                }
                case indexed is IndexedCollectionElementSyntax {
                    let _ = BindExpression(indexed.Key)
                    let _ = BindExpression(indexed.Value)
                }
            }
        }
    }

    internal func TryBindIntrinsicCall(
        syntax CallExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        let name = syntax.Identifier.ValueText
        switch name {
            case "adapt" when syntax.Identifier.Text == "adapt" {
                {
                    result = bindStructuralAdaptation(syntax)
                    return true
                }
            }
            case "cast" {
                {
                    if syntax.TypeArgumentList == nil || syntax.TypeArgumentList.Arguments.Count != 1 {
                        Diagnostics.ReportWrongTypeArgumentCount(
                            syntax.TypeArgumentList?.Location ?? syntax.Identifier.Location,
                            name,
                            expectedCount: 1,
                            actualCount: syntax.TypeArgumentList?.Arguments.Count ?? 0
                        )
                        result = BoundErrorExpression(syntax)
                        return true
                    }
                    if syntax.Arguments.Count != 1 {
                        Diagnostics.ReportWrongArgumentCount(
                            syntax.Identifier.Location,
                            name,
                            expectedCount: 1,
                            actualCount: syntax.Arguments.Count
                        )
                        result = BoundErrorExpression(syntax)
                        return true
                    }
                    var targetType TypeSymbol? = bindTypeClause(syntax.TypeArgumentList!!.Arguments[0])
                    if targetType == nil {
                        result = BoundErrorExpression(syntax)
                        return true
                    }
                    // ADR-0186 §9: `cast[T]`'s argument is a cast target, not a
                    // slot — its top level is left alone in an oblivious scope
                    // (nested positions keep their platform reading), so
                    // `cast[string](o)` still produces a non-null `string`.
                    targetType = PlatformTypeSymbol.StripTopLevel(targetType)
                    reportObsoleteUseIfApplicable(
                        syntax.TypeArgumentList!!.Arguments[0].Location,
                        targetType,
                        targetType.Name
                    )
                    result = conversions.BindConversion(syntax.Arguments[0], targetType, allowExplicit: true)
                    return true
                }
            }
            case "len", "cap", "append", "delete", "close" {
                {
                    // ADR-0174 D12/D13 / GS0566: the Go-style built-ins are retired
                    // in favour of the members every receiver already has. A
                    // user-defined function of the same name is an ordinary call
                    // (the ADR keeps these names free for users), so only the bare,
                    // otherwise-undefined spelling reports. The arguments are still
                    // bound so their own diagnostics surface, and the first
                    // argument's type picks the replacement the message names for
                    // THIS site.
                    if !$scope.TryLookupFunctions(name).IsEmpty {
                        return false
                    }
                    let arguments = ImmutableArray.CreateBuilder[BoundExpression](syntax.Arguments.Count)
                    for argument in syntax.Arguments {
                        arguments.Add(BindExpression(argument))
                    }
                    let argumentTexts = syntax
                        .Arguments
                        .Select((argument ExpressionSyntax) -> syntax.SyntaxTree.Text.ToString(argument.Span))
                        .ToImmutableArray()
                    Diagnostics.ReportRetiredBuiltin(
                        syntax.Location,
                        syntax.SyntaxTree.Text.ToString(syntax.Span),
                        RetiredBuiltins.GetReplacementGuidance(
                            name,
                            if arguments.Count > 0 {
                                arguments[0].Type
                            } else {
                                default(TypeSymbol?)
                            },
                            argumentTexts
                        )
                    )
                    result = BoundErrorExpression(syntax)
                    return true
                }
            }
            default {
                return false
            }
        }
    }

    internal func TryBindClrConstructorCall(
        syntax CallExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        let name = syntax.Identifier.ValueText
        var clrType Type? = nil
        var openGenericDefinition Type? = nil
        var symbolicTypeArgs = default(ImmutableArray[TypeSymbol])
        if syntax.TypeArgumentList != nil {
            // `List[int]()`, `Dictionary[string, int]()`, etc. Resolve the open
            // generic via imports (mangled `Name`N`) and construct the closed
            // type via Type.MakeGenericType.
            if !$scope.TryLookupImportedGenericClass(
                name,
                syntax.TypeArgumentList.Arguments.Count,
                out var openType,
                out var openAmbiguity
            ) {
                return false
            }
            // Issue #3734: constructing a bare homonym is the same coin flip as
            // naming one in a type clause.
            if openAmbiguity != nil {
                Diagnostics.ReportAmbiguousImportedTypeReference(syntax.Identifier.Location, name, openAmbiguity)
            }
            if !TryResolveClrConstructionTypeArgs(
                syntax.TypeArgumentList!!,
                out var clrArgs,
                out symbolicTypeArgs,
                out var hasSymbolicArg
            ) {
                return false
            }
            // Issue #4032 (review finding 1): the constraint check added for
            // type CLAUSES did not cover the direct-construction expression
            // `Handler[string]()`, so under MetadataLoadContext — where
            // MakeGenericType validates nothing — that spelling still emitted an
            // instantiation the CLR refuses and threw TypeLoadException at run
            // time. Same defect, same remedy, one syntax over.
            if Binder.ReportUnsatisfiedGenericTypeConstraint(
                Diagnostics,
                openType,
                clrArgs,
                symbolicTypeArgs,
                syntax.Identifier.Location
            ) {
                // Issue #4051: `false` here means "not a CLR constructor call",
                // and overload resolution answered the question it was then
                // left holding with `GS0130 Function 'Handler' doesn't exist` —
                // beside the accurate GS0152, about a type that plainly does
                // exist. It IS a CLR constructor call; it is just a refused
                // one, and the refusal has already been explained. Claim it
                // with an error node so nothing downstream invents a second
                // reason.
                result = BoundErrorExpression(syntax)
                return true
            }
            try {
                clrType = openType!!.MakeGenericType(clrArgs)
            } catch (ArgumentException) {
                return false
            }
            // Issue #671: when one or more type arguments is a G# user-defined
            // type (its ClrType is null because the TypeDef is only produced
            // during emit), the closed CLR shape was type-erased to
            // `Open<object,...>`. Keep the openGenericDefinition + the real
            // symbolic args so the emitter can later re-emit the parent
            // TypeSpec using the user-defined TypeDef tokens.
            if !hasSymbolicArg {
                symbolicTypeArgs = default(ImmutableArray[TypeSymbol])
            } else {
                openGenericDefinition = openType
            }
        } else {
            if $scope.TryLookupTypeAlias(name, preferredArity: 0, out var typeAlias) &&
                typeAlias is ImportedTypeSymbol{ClrType: not nil} importedAlias {
                clrType = importedAlias.ClrType
            } else if $scope.TryLookupImport(name, out var aliasImport) &&
                aliasImport!!.IsAlias &&
                $scope.References!!.TryResolveType(aliasImport!!.Target, out var aliasedType) {
                clrType = aliasedType
            } else if $scope.TryLookupImportedClass(name, declaration: nil, out var importedClass, out var ambiguity) {
                // Issue #3734: `Thing()` with two imports each exporting a
                // `Thing` constructs whichever import came first.
                if ambiguity != nil {
                    Diagnostics.ReportAmbiguousImportedTypeReference(syntax.Identifier.Location, name, ambiguity)
                }
                clrType = importedClass!!.ClassType
            } else {
                let resolved = lookupTypeToken(syntax.Identifier)
                if resolved == TypeSymbol.Error {
                    result = BoundErrorExpression(syntax)
                    return true
                }
                if resolved is ImportedTypeSymbol{ClrType: not nil} importedType {
                    clrType = importedType.ClrType
                } else {
                    return false
                }
            }
        }
        if clrType is not Type resolvedClrType {
            return false
        }
        if syntax.TypeArgumentList == nil && resolvedClrType.IsGenericTypeDefinition {
            // User wrote `List(...)` without `[T]`; can't construct an open generic.
            return false
        }
        // Issue #3421: a nullable type-call target is unambiguously a checked
        // conversion, never construction. Resolve imported generic targets
        // here because ordinary name lookup does not materialize their closed
        // CLR type.
        if syntax.NullableQuestionToken != nil && syntax.Arguments.Count == 1 {
            var checkedTarget = TypeSymbol.FromClrTypeWithoutNullability(
                resolvedClrType,
                NullabilityFreeReason.TypeStructure
            )
            if ImportedTypeSymbol.TryCreateSemanticAggregate(
                resolvedClrType,
                $scope.References,
                out var nullableAggregate
            ) {
                checkedTarget = nullableAggregate
            }
            result = conversions.BindConversion(
                syntax.Arguments[0],
                NullableTypeSymbol.Get(checkedTarget),
                allowExplicit: true
            )
            return true
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
        if syntax.Arguments.Count == 0 && ImportedTypeSymbol.TryCreateSemanticAggregate(
            resolvedClrType,
            $scope.References,
            out var zeroAggregate
        ) &&
            zeroAggregate is {IsData: true, IsClass: false, HasDataConstructionPrimary: false} zeroData &&
            !BoundStructLiteralExpression
            .ValidateDataConstructor(
            zeroData,
            Diagnostics,
            syntax,
            this.function,
            binderCtx.References.CanAccessInternalMembers(resolvedClrType.Assembly)
        ) {
            result = BoundErrorExpression(syntax)
            return true
        }
        if openGenericDefinition == nil && ImportedTypeSymbol.TryCreateSemanticAggregate(
            resolvedClrType,
            $scope.References,
            out var dataClassAggregate
        ) &&
            dataClassAggregate!!.IsData &&
            dataClassAggregate!!
            .HasPrimaryConstructor {
            // Issue #2550: gsc data classes also expose a parameterless CLR
            // constructor as an implementation detail. Bind their source-level
            // construction through the imported primary-constructor metadata
            // so `Settings()` supplies declared defaults instead of selecting
            // that zero-initializing constructor. C# records have no gsc marker
            // and keep using CLR overload resolution (#2291/#2458).
            if ImportedAssemblySemantics.TryGetTypeSemantics(resolvedClrType, out _) {
                let primaryParameterCount = dataClassAggregate!!.PrimaryConstructorParameters.Length
                var primaryAcceptsArity = syntax.Arguments.Count <= primaryParameterCount
                if primaryAcceptsArity {
                    for var i = syntax.Arguments.Count; i < primaryParameterCount; i++ {
                        primaryAcceptsArity &= dataClassAggregate!!
                            .PrimaryConstructorParameters[i]
                            .HasExplicitDefaultValue
                    }
                }
                var hasMatchingSecondaryConstructor = false
                if !primaryAcceptsArity {
                    for constructor in ClrTypeUtilities.SafeGetConstructors(
                        resolvedClrType,
                        BindingFlags.Public | BindingFlags.Instance
                    ) {
                        if constructor.GetParameters().Length == syntax.Arguments.Count {
                            hasMatchingSecondaryConstructor = true
                            break
                        }
                    }
                }
                if !primaryAcceptsArity && hasMatchingSecondaryConstructor {
                    let boundSecondary = TryBindClrConstructorFromType(
                        resolvedClrType,
                        syntax,
                        out result,
                        out var noApplicableSecondary,
                        out var secondaryArguments,
                        resultTypeOverride: dataClassAggregate
                    )
                    if boundSecondary {
                        result = Invariant.Required(
                            result,
                            "a successful secondary constructor binding produces a result",
                            expression: "result"
                        )
                        return true
                    }
                    return FinishClrConstructorBindingFailure(
                        syntax,
                        name,
                        noApplicableSecondary,
                        secondaryArguments,
                        &result,
                        dataClassAggregate
                    )
                }
                result = overloads.BindConstructorCallExpression(syntax, dataClassAggregate!!)
                return true
            }
            let bound = TryBindClrConstructorFromType(
                resolvedClrType,
                syntax,
                out result,
                out var noApplicableOverload,
                out var aggregateArguments,
                resultTypeOverride: dataClassAggregate
            )
            if bound {
                result = Invariant.Required(
                    result,
                    "a successful aggregate constructor binding produces a result",
                    expression: "result"
                )
                return true
            }
            return FinishClrConstructorBindingFailure(
                syntax,
                name,
                noApplicableOverload,
                aggregateArguments,
                &result,
                dataClassAggregate
            )
        }
        if TryBindClrConstructorFromType(
            resolvedClrType,
            syntax,
            out result,
            out var clrNoApplicableOverload,
            out var clrArguments,
            openGenericDefinition,
            symbolicTypeArgs
        ) {
            return true
        }
        if openGenericDefinition == nil && ImportedTypeSymbol.TryCreateSemanticAggregate(
            resolvedClrType,
            $scope.References,
            out var aggregate
        ) &&
            aggregate!!.HasPrimaryConstructor {
            result = overloads.BindConstructorCallExpression(syntax, aggregate!!)
            return true
        }
        return FinishClrConstructorBindingFailure(
            syntax,
            name,
            clrNoApplicableOverload,
            clrArguments,
            &result,
            TypeSymbol.FromClrTypeWithoutNullability(resolvedClrType, NullabilityFreeReason.TypeStructure)
        )
    }

    /// Issue #5189: the closed CLR constructor type erases a same-compilation
    /// enum type argument to `object`, so its array parameter is `object[]`.
    /// An enum array argument rides through overload resolution as `int32[]`,
    /// which is not applicable to `object[]`. Use `object[]` for that argument
    /// so `Span[E](array)` selects the array constructor.
    /// @param argumentType The symbolic type of the bound argument.
    /// @param clrType The CLR type that overload resolution uses for the argument.
    /// @param symbolicTypeArgs The symbolic type arguments of the constructed type.
    /// @returns The CLR type to use for overload resolution.
    private func EraseEnumElementArrayForClosedConstruction(
        argumentType TypeSymbol,
        clrType Type,
        symbolicTypeArgs ImmutableArray[TypeSymbol]
    ) Type {
        if symbolicTypeArgs.IsDefaultOrEmpty || !clrType.IsSZArray {
            return clrType
        }
        let element TypeSymbol? = switch argumentType {
            case slice is SliceTypeSymbol: slice.ElementType
            case array is ArrayTypeSymbol: array.ElementType
            default: nil
        }
        if element is EnumSymbol && symbolicTypeArgs.Contains(element) {
            return typeof(object).MakeArrayType()
        }
        return clrType
    }

    private func FinishClrConstructorBindingFailure(
        syntax CallExpressionSyntax,
        typeName string,
        noApplicableOverload bool,
        boundArguments ImmutableArray[BoundExpression],
        @NotNullWhen(true) ref result BoundExpression?,
        conversionTarget TypeSymbol? = nil
    ) bool {
        var conversionTarget = conversionTarget
        if noApplicableOverload &&
            syntax
            .Arguments
            .Count == 1 &&
            boundArguments.Length == 1 &&
            conversionTarget != nil {
            if syntax.NullableQuestionToken != nil {
                conversionTarget = NullableTypeSymbol.Get(conversionTarget)
            }
            let argument = boundArguments[0]
            // Issue #3684 (family F8): the same fallback must cover the
            // value-typed target. `ImmutableArray[ParameterSymbol](method.Invoke(…))`
            // is a G# conversion call over an IMPORTED GENERIC value type — a
            // plain C# `(ImmutableArray<ParameterSymbol>)` cast — but the type
            // name binds as a constructor call, no `.ctor` takes a single
            // `object?`, and the reference-cast fallback below rejects a value
            // type outright, so the whole shape reported GS0267. An unboxing
            // cast from `object`/`ValueType`/`Enum`/a implemented interface is
            // exactly as checked (and as runtime-throwing) as the reference
            // case, so it belongs on the same fallback.
            if Conversion.HasCheckedReferenceConversion(argument.Type, conversionTarget) ||
                Conversion
                .HasCheckedUnboxingConversion(argument.Type, conversionTarget) {
                result = conversions.BindConversion(
                    syntax.Arguments[0].Location,
                    argument,
                    conversionTarget,
                    allowExplicit: true
                )
                return true
            }
            // Issue #3684 (family F8), third shape: a DELEGATE target —
            // `Func[TypeSymbol, TypeSymbol]((e TypeSymbol) -> …)`, the G# form
            // of a C# `(Func<TypeSymbol, TypeSymbol>)(e => …)` cast. The CLR
            // delegate `.ctor` takes `(object, IntPtr)`, so a one-argument call
            // never resolves and the whole conversion reported GS0267. Bind it
            // as the conversion it is, but only when one genuinely exists —
            // an argument that cannot convert still falls through to GS0267.
            if conversionTarget!!.ClrType is {} targetClr && ClrTypeUtilities.IsDelegateType(targetClr) &&
                argument.Type is {} argumentType &&
                Conversion
                .Classify(argumentType, conversionTarget!!).Exists {
                result = conversions.BindConversion(
                    syntax.Arguments[0].Location,
                    argument,
                    conversionTarget,
                    allowExplicit: true
                )
                return true
            }
            // Issue #3749, fourth shape: an ENUM (or any other) target reached
            // through the dotted spelling. The three arms above enumerate
            // particular conversion kinds; the simple-name conversion-call path
            // in `OverloadResolver.BindCallExpression` instead applies the
            // ADR-0047 §6 rule generally — a one-argument `T(x)` over a
            // non-constructible `T` IS the explicit conversion. Mirror that
            // here so `DebuggableAttribute.DebuggingModes(2)` reads the same as
            // the unnested `SomeEnum(2)`. Gated on an existing conversion, so a
            // genuinely unconvertible argument still falls through to the
            // not-found/overload diagnostics rather than a new one.
            if argument.Type is {} sourceType && sourceType != TypeSymbol.Error && Conversion.Classify(
                sourceType,
                conversionTarget!!
            )
                .Exists {
                result = conversions.BindConversion(
                    syntax.Arguments[0].Location,
                    argument,
                    conversionTarget,
                    allowExplicit: true
                )
                return true
            }
        }
        if syntax.TypeArgumentList == nil {
            result = nil
            return false
        }
        if result != nil {
            return true
        }
        if !noApplicableOverload {
            return false
        }
        Diagnostics.ReportNoApplicableOverload(syntax.Identifier.Location, typeName)
        result = BoundErrorExpression(syntax)
        return true
    }

    /// Issue #671: resolves the type arguments on a CLR generic construction
    /// call (`List[MyGs]()`, `Dictionary[string, MyGs]()`) into
    /// MakeGenericType-ready CLR types alongside their original symbolic
    /// TypeSymbol forms. A G# user-defined type argument has no
    /// reference-context CLR type (its TypeDef is produced at emit), so it is
    /// closed with a (cref:object) placeholder; the symbolic argument
    /// is preserved so the emitter can re-emit it as its own TypeDef token in
    /// the parent TypeSpec of the resulting MemberRef. Mirrors the
    /// construction-side handling in (cref:Binder.ConstructIfGeneric)
    /// and the generic-method side in
    /// (cref:TryResolveExplicitMethodTypeArgs).
    /// @param typeArgumentList The call's `[T1, T2]` list.
    /// @param clrArgs On success, the resolved (mapped) CLR type arguments ready for MakeGenericType.
    /// @param symbolicArgs On success, the symbolic type arguments in source order.
    /// @param hasSymbolicArg On success, whether any argument carries symbolic or tuple-conversion
    /// information to retain.
    /// @returns Whether all type arguments resolved.
    private func TryResolveClrConstructionTypeArgs(
        typeArgumentList TypeArgumentListSyntax,
        out clrArgs[]Type,
        out symbolicArgs ImmutableArray[TypeSymbol],
        out hasSymbolicArg bool
    ) bool {
        clrArgs = [typeArgumentList.Arguments.Count]Type
        let symbolic = ImmutableArray.CreateBuilder[TypeSymbol](typeArgumentList.Arguments.Count)
        hasSymbolicArg = false
        for var i = 0; i < typeArgumentList.Arguments.Count; i++ {
            let ta TypeSymbol? = bindTypeClause(typeArgumentList.Arguments[i])
            if ta == nil {
                symbolicArgs = default(ImmutableArray[TypeSymbol])
                return false
            }
            symbolic.Add(ta)
            if ta.ClrType == nil {
                // Issue #3087: retain the erased shape of symbolic tuple
                // arguments. Flattening the whole argument to object made
                // List[(...)].Add and LINQ receiver inference see List<object>
                // instead of List<ValueTuple<...>>.
                hasSymbolicArg = true
                if ((ta is TupleTypeSymbol or NullableTypeSymbol and {UnderlyingType: TupleTypeSymbol})) &&
                    MemberLookup
                    .TryProjectErasedClrType(ta, out var projected) {
                    clrArgs[i] = $scope.References!!.MapClrTypeToReferences(projected)!!
                } else {
                    clrArgs[i] = $scope.References!!.GetCoreType("System.Object")
                }
                continue
            }
            // Issues #2664/#3560: preserve symbolic shapes and tuple conversion
            // semantics so member arguments can recover their language target.
            // ADR-0172: a named-tuple-bearing argument at ANY nesting depth
            // (`List[(a int32, b string)]`) shares its CLR backing with the
            // unnamed shape — only the symbolic argument preserves the names.
            // Issue #3962: a fixed-length array `[N]T` shares its CLR backing
            // (`T[]`) with `[]T` and with every other length, so only the
            // symbolic argument preserves the length the author wrote —
            // otherwise `List[[3]int32]()` and `List[[4]int32]()` both infer
            // the one cached symbol for `List<System.Int32[]>`.
            // Issue #4024: the SLICE spelling `[]T` shares the same SZ-array
            // backing and is retained by the same gate — without it
            // `List[[]int32]()` carries no symbolic argument, reads as a
            // metadata-recovered `List<int[]>`, and rides the metadata
            // leniency into a `List[[3]int32]` slot.
            if TypeSymbol.RequiresSymbolicProjection(ta) ||
                ta is TupleTypeSymbol ||
                TypeSymbol.ContainsNamedTupleElements(ta) || TypeSymbol.ContainsSourceArrayShape(ta) {
                hasSymbolicArg = true
            }
            // Project host CLR type arguments onto the resolver's reference
            // set so they share openType's load context (its
            // MetadataLoadContext when references are supplied via /r:),
            // which MakeGenericType requires.
            // Issue #530: use ResolveClrTypeForGenericArg so that `int32?`
            // resolves to `Nullable<int>` (not bare `int`).
            clrArgs[i] = (resolveClrTypeForGenericArg(ta) ?? $scope.References!!.MapClrTypeToReferences(ta.ClrType))!!
        }
        symbolicArgs = symbolic.MoveToImmutable()
        return true
    }

    /// Binds a constructor invocation against an already-resolved CLR
    /// [`clrType`](paramref). Shared by the simple-name constructor path
    /// ((cref:TryBindClrConstructorCall)) and the fully-qualified path
    /// ((cref:TryBindQualifiedClrConstructorCall)) so that imported-type
    /// construction resolves identically regardless of how the type name was
    /// written (issue #293).
    /// @param clrType The closed CLR type to construct.
    /// @param syntax The call syntax carrying the arguments and location.
    /// @param result The bound constructor call on success.
    /// @param noApplicableOverload Whether the type and its constructors resolved but none accepted the
    /// supplied arguments. The caller reports this only after semantic-
    /// aggregate constructor fallback has also failed.
    /// @param boundArgumentsOnFailure Arguments already bound while testing constructor applicability.
    /// Populated when [`noApplicableOverload`](paramref) is true so
    /// checked-reference fallback can reuse them without mutating binder state
    /// a second time.
    /// @param openGenericDefinition Issue #671: when [`clrType`](paramref) was closed with a
    /// (cref:object) placeholder for one or more G# user-defined type
    /// arguments, the open generic definition (e.g. `List<>`) used to
    /// build the closed shape. Combined with [`symbolicTypeArgs`](paramref)
    /// it lets the emitter re-emit the parent TypeSpec using the user-defined
    /// TypeDef tokens. `null` when no symbolic substitution is
    /// in effect.
    /// @param symbolicTypeArgs Issue #671: the original symbolic type arguments in source order, used
    /// alongside [`openGenericDefinition`](paramref). Default when no
    /// symbolic substitution is in effect.
    /// @param resultTypeOverride Semantic result type to expose instead of a plain imported CLR type.
    /// Used for imported data aggregates so constructor binding still flows
    /// through shared CLR overload resolution without reintroducing dual type
    /// identity.
    /// @returns Whether a constructor was resolved and bound.
    private func TryBindClrConstructorFromType(
        clrType Type,
        syntax CallExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?,
        out noApplicableOverload bool,
        out boundArgumentsOnFailure ImmutableArray[BoundExpression],
        openGenericDefinition Type? = nil,
        symbolicTypeArgs ImmutableArray[TypeSymbol] = default(ImmutableArray[TypeSymbol]),
        resultTypeOverride TypeSymbol? = nil
    ) bool {
        result = nil
        noApplicableOverload = false
        boundArgumentsOnFailure = default(ImmutableArray[BoundExpression])
        if clrType.IsAbstract || clrType.IsInterface {
            return false
        }
        let inlineOutArguments = GetInlineOutArgumentIndices(syntax)
        // Issue #343: pre-validate named-argument layout for CLR constructor calls.
        if !overloads.TryAnalyzeCallArgumentLayout(syntax.Arguments, out _, out var argumentNames) {
            DeclareInvalidClrConstructorInlineOutLocals(syntax, inlineOutArguments, bindExplicitTyped: true)
            result = BoundErrorExpression(syntax)
            return true
        }
        // Issue #891: a constructor's delegate-typed parameter (e.g.
        // `Func<HttpClient> httpClientFactory`) target-types an arrow/func
        // literal argument before it is bound. Without this, an arrow lambda
        // whose body only throws (`() -> { throw ... }`) infers `() -> void`
        // and fails to match the `Func<...>` parameter; the call then misroutes
        // to the single-arg conversion path and reports the misleading GS0162
        // "named arguments are only supported for data-struct .copy(...)".
        let canAccessInternalConstructors = $scope.References!!.CanAccessInternalMembers(clrType.Assembly)
        var constructorFlags = BindingFlags.Public | BindingFlags.Instance
        if canAccessInternalConstructors {
            constructorFlags |= BindingFlags.NonPublic
        }
        var ctors = ClrTypeUtilities
            .SafeGetConstructors(clrType, constructorFlags)
            .Where(
            (constructor ConstructorInfo) -> constructor.IsPublic ||
                (canAccessInternalConstructors && (constructor.IsAssembly || constructor.IsFamilyOrAssembly))
        )
            .ToArray()
        if inlineOutArguments.Count > 0 {
            let invalidInlineOutArguments = inlineOutArguments.Where(
                (index int32) -> !ctors.Any(
                    (constructor ConstructorInfo) -> ConstructorSupportsInlineOutArgument(
                        constructor,
                        argumentNames,
                        index
                    )
                )
            )
                .ToArray()
            if invalidInlineOutArguments.Length > 0 {
                for index in invalidInlineOutArguments {
                    Diagnostics.ReportOutDeclarationOutsideOutArgument(
                        OverloadResolver.UnwrapNamedArgumentValue(syntax.Arguments[index]).Location
                    )
                }
                DeclareInvalidClrConstructorInlineOutLocals(syntax, inlineOutArguments, bindExplicitTyped: true)
                result = BoundErrorExpression(syntax)
                return true
            }
            ctors = ctors.Where(
                (constructor ConstructorInfo) -> ConstructorSupportsInlineOutArguments(
                    constructor,
                    argumentNames,
                    inlineOutArguments
                )
            )
                .ToArray()
        }
        let ctorParameterLists = List[[]ParameterInfo](ctors.Length)
        for constructor in ctors {
            ctorParameterLists.Add(constructor.GetParameters())
        }
        let boundArguments = ImmutableArray.CreateBuilder[BoundExpression](syntax.Arguments.Count)
        let symbolicCtorDelegateTargets = Dictionary[int32, TypeSymbol]()
        for var i = 0; i < syntax.Arguments.Count; i++ {
            let argName = if argumentNames.IsDefault {
                default(string?)
            } else {
                argumentNames[i]
            }
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
            let inner = OverloadResolver.UnwrapNamedArgumentValue(syntax.Arguments[i])
            if inner is LambdaExpressionSyntax ctorLambdaSyntax &&
                openGenericDefinition != nil &&
                TryResolveSymbolicDelegateTargetForCtor(
                openGenericDefinition,
                symbolicTypeArgs,
                sourceArgIndex: i,
                argName: argName,
                out var symbolicTarget
            ) &&
                symbolicTarget is {} resolvedSymbolicTarget {
                let literal = lambdas.BindLambdaExpression(ctorLambdaSyntax, resolvedSymbolicTarget.FunctionType)
                boundArguments.Add(
                    if ShouldConvertToNominalDelegate(resolvedSymbolicTarget.DelegateType) {
                        conversions.BindConversion(
                            syntax.Arguments[i].Location,
                            literal,
                            resolvedSymbolicTarget.DelegateType
                        )
                    } else {
                        literal
                    }
                )
                symbolicCtorDelegateTargets[i] = resolvedSymbolicTarget.DelegateType
                continue
            }
            if inner is RefArgumentExpressionSyntax refArgument {
                boundArguments.Add(BindRefArgumentExpression(refArgument, parameter: nil))
            } else {
                boundArguments.Add(
                    BindCallArgumentWithDelegateTargetTyping(
                        syntax.Arguments[i],
                        ctorParameterLists,
                        sourceArgumentCount: syntax.Arguments.Count,
                        sourceArgIndex: i,
                        argName: argName,
                        paramOffset: 0
                    )
                )
            }
        }
        // Phase A (overload resolution): pick a constructor via the shared
        // "better function member" resolver. Ambiguity surfaces a hard
        // binder diagnostic and the call falls back to the surrounding
        // pipeline (which will diagnose a missing match).
        let argTypes = [boundArguments.Count]Type?
        var argsAllTyped = true
        var hasUserClassArg = false
        for var i = 0; i < boundArguments.Count; i++ {
            if TryGetInlineOutVarArgument(syntax, i, out _) {
                argTypes[i] = ClrOverloadResolution.InlineOutVarArgumentType
                continue
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
            var t Type?
            let priorErase = eraseDelegateInnerEnumToObject
            eraseDelegateInnerEnumToObject = symbolicCtorDelegateTargets.ContainsKey(i)
            try {
                t = GetEffectiveArgumentClrTypeForOverloadResolution(boundArguments[i].Type)
            } finally {
                eraseDelegateInnerEnumToObject = priorErase
            }
            if t == nil && boundArguments[i].Type != TypeSymbol.Null {
                // Issue #2347: an unresolved method group (e.g. a bare BCL
                // static method passed where a delegate-typed constructor
                // parameter is expected) carries no CLR type yet — its shape
                // depends on the constructor overload eventually chosen.
                // Defer it exactly like an untyped lambda (leave the argTypes
                // slot null so generic inference/applicability fall back to
                // the other arguments) instead of aborting resolution
                // outright; it is resolved against the winning constructor's
                // parameter type afterwards by BindClrParameterConversions.
                if !ClrOverloadResolution.IsUnresolvedMethodGroupArgument(boundArguments[i]) {
                    argsAllTyped = false
                    break
                }
            }
            if (boundArguments[i].Type is StructSymbol and {IsClass: true}) {
                hasUserClassArg = true
            }
            argTypes[i] = if t != nil && openGenericDefinition != nil {
                EraseEnumElementArrayForClosedConstruction(boundArguments[i].Type, t, symbolicTypeArgs)
            } else {
                t
            }
        }
        var bestCtor ConstructorInfo? = nil
        var ctorMapping = default(ImmutableArray[int32])
        var ctorIsExpanded = false
        if argsAllTyped {
            let CheckUserClassInterface = func (source Type, target Type) bool {
                return IsUserClassAssignableToInterface(boundArguments, argTypes, source, target)
            }
            // Issue #658 / #1634: when any argument is a user-defined G# class,
            // pass a supplementary interface check into Resolve so
            // ClassifyImplicit recognises the user-class → CLR-interface
            // implicit reference conversion. Threaded as a call-local
            // parameter (not a shared static) so concurrent/nested binds never
            // observe another call's closure.
            var supplementaryInterfaceCheck((Type, Type) -> bool)? = nil
            if hasUserClassArg {
                supplementaryInterfaceCheck = CheckUserClassInterface
            }
            let resolution = ClrOverloadResolution.Resolve(
                ctors,
                argTypes,
                interpolatedStringArgs: ComputeInterpolatedStringArgFlags(syntax.Arguments, boundArguments.Count),
                argumentNames: if argumentNames.IsDefault {
                    default(IReadOnlyList[string?]?)
                } else {
                    cast[IReadOnlyList[string?]](argumentNames)
                },
                supplementaryInterfaceCheck: supplementaryInterfaceCheck,
                constantNarrowingArgumentCheck: MakeConstantNarrowingArgumentCheck(boundArguments),
                structuralProjectionArgumentCheck: MakeStructuralProjectionArgumentCheck(
                    boundArguments,
                    nativeConversions: conversions
                ),
                erasedArgumentMismatchCheck: MakeErasedArgumentMismatchCheck(boundArguments),
                delegateRefKindArgumentCheck: MakeDelegateRefKindArgumentCheck(boundArguments)
            )
            switch resolution.Outcome {
                case ClrOverloadResolution.ResolutionOutcome.Resolved {
                    bestCtor = Invariant.Required(
                        resolution.Best,
                        "a resolved constructor overload has a best constructor",
                        expression: "resolution.Best"
                    )
                    ctorMapping = resolution.ParameterMapping
                    ctorIsExpanded = resolution.IsExpanded
                }
                case ClrOverloadResolution.ResolutionOutcome.Ambiguous {
                    Diagnostics.ReportAmbiguousOverload(
                        syntax.Location,
                        clrType.Name,
                        resolution.Ambiguous.Length,
                        resolution.Ambiguous.Select(ClrOverloadResolution.FormatMethodSignature)
                    )
                    DeclareInvalidClrConstructorInlineOutLocals(syntax, inlineOutArguments)
                    result = BoundErrorExpression(syntax)
                    return true
                }
                default { }
            }
        }
        if bestCtor == nil {
            let hasInvalidExplicitTypedInlineOut = inlineOutArguments.Any(
                (index int32) -> (
                    OverloadResolver.UnwrapNamedArgumentValue(
                        syntax.Arguments[index]
                    ) is RefArgumentExpressionSyntax and
                        {DeclaredType: not nil}
                ) &&
                    boundArguments[index] is BoundAddressOfExpression{Operand: {Type: var operandType}} &&
                    operandType == TypeSymbol.Error
            )
            let hasErrorArgument = boundArguments.Any((argument BoundExpression) -> argument.Type == TypeSymbol.Error)
            if TryReportClrConstructorInlineOutTypeMismatch(
                syntax,
                inlineOutArguments,
                ctors,
                argumentNames,
                boundArguments,
                openGenericDefinition,
                symbolicTypeArgs
            ) ||
                (
                !hasInvalidExplicitTypedInlineOut &&
                    !hasErrorArgument &&
                    inlineOutArguments.Count > 0 &&
                    TryReportClrConstructorArgumentTypeMismatch(syntax, ctors, argumentNames, boundArguments)
            ) {
                DeclareClrConstructorInlineOutLocals(
                    syntax,
                    inlineOutArguments,
                    ctors,
                    argumentNames,
                    openGenericDefinition,
                    symbolicTypeArgs
                )
                result = BoundErrorExpression(syntax)
                return true
            }
            if hasInvalidExplicitTypedInlineOut || hasErrorArgument {
                DeclareClrConstructorInlineOutLocals(
                    syntax,
                    inlineOutArguments,
                    ctors,
                    argumentNames,
                    openGenericDefinition,
                    symbolicTypeArgs
                )
                result = BoundErrorExpression(syntax)
                return hasInvalidExplicitTypedInlineOut || inlineOutArguments.Count > 0
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
            if syntax
                .Arguments
                .Count == 0 &&
                argumentNames.IsDefault &&
                clrType.IsValueType &&
                !clrType.IsEnum &&
                !clrType.IsPrimitive &&
                !clrType
                .ContainsGenericParameters {
                result = BoundDefaultExpression(
                    syntax,
                    resultTypeOverride ??
                        (
                        if openGenericDefinition != nil && !symbolicTypeArgs.IsDefaultOrEmpty {
                            ImportedTypeSymbol.GetConstructed(clrType, openGenericDefinition, symbolicTypeArgs)
                        } else {
                            TypeSymbol.FromClrTypeWithoutNullability(clrType, NullabilityFreeReason.TypeStructure)
                        }
                    )
                )
                return true
            }
            // Issue #343: a CLR constructor call that mismatched on a name we
            // can show as "no such parameter" is more actionable than the
            // generic fallback diagnostic.
            if !argumentNames.IsDefault && overloads.TryReportUnknownNamedArgumentForClrConstructor(
                clrType,
                syntax,
                argumentNames
            ) {
                DeclareClrConstructorInlineOutLocals(
                    syntax,
                    inlineOutArguments,
                    ctors,
                    argumentNames,
                    openGenericDefinition,
                    symbolicTypeArgs
                )
                result = BoundErrorExpression(syntax)
                return true
            }
            if inlineOutArguments.Count > 0 {
                Diagnostics.ReportNoApplicableOverload(syntax.Identifier.Location, clrType.Name)
                DeclareClrConstructorInlineOutLocals(
                    syntax,
                    inlineOutArguments,
                    ctors,
                    argumentNames,
                    openGenericDefinition,
                    symbolicTypeArgs
                )
                result = BoundErrorExpression(syntax)
                return true
            }
            DeclareClrConstructorInlineOutLocals(
                syntax,
                inlineOutArguments,
                ctors,
                argumentNames,
                openGenericDefinition,
                symbolicTypeArgs
            )
            noApplicableOverload = true
            boundArgumentsOnFailure = boundArguments.MoveToImmutable()
            return false
        }
        let ctorParameters = bestCtor.GetParameters()
        let ctorRawArgs = RebindInlineOutConstructorArguments(
            syntax,
            boundArguments.MoveToImmutable(),
            bestCtor,
            ctorMapping,
            openGenericDefinition,
            symbolicTypeArgs
        )
        let ctorRefKinds = ComputeArgumentRefKinds(ctorParameters)
        let ctorDownstreamMapping = if ctorIsExpanded {
            default(ImmutableArray[int32])
        } else {
            ctorMapping
        }
        var ctorParameterTypeOverrides Dictionary[int32, TypeSymbol]? = nil
        if symbolicCtorDelegateTargets.Count > 0 {
            ctorParameterTypeOverrides = Dictionary[int32, TypeSymbol]()
            for pair in symbolicCtorDelegateTargets {
                let parameterIndex = if ctorMapping.IsDefault {
                    pair.Key
                } else {
                    ctorMapping[pair.Key]
                }
                ctorParameterTypeOverrides[parameterIndex] = pair.Value
            }
        }
        // Issue #3932: a ctor has no receiver, so neither #765's
        // TrySubstituteParameterTypeFromReceiver nor #1540's
        // TryRecoverReceiverTypeParameterSlot — the two helpers that keep a
        // `List[T].Add(v)` argument OFF the boxing path — can fire for a
        // `newobj`. Recover the same symbolic slot from the construction's own
        // type arguments instead, so `ValueTask[T](v)` converts `v` to `T` (the
        // real `!0` slot) rather than to the erased `object`. Without this the
        // binder inserts a boxing conversion and the emitter writes
        // `box !!T; newobj ValueTask`1<!!T>::.ctor(!0)` — unverifiable IL.
        // Runs AFTER the delegate targets above and never overwrites one: the
        // #1638 delegate recovery is strictly more specific.
        if openGenericDefinition != nil && !symbolicTypeArgs.IsDefaultOrEmpty {
            for var p = 0; p < ctorParameters.Length; p++ {
                if ctorParameterTypeOverrides != nil && ctorParameterTypeOverrides.ContainsKey(p) {
                    continue
                }
                // Issue #4400: an `in` slot's pointee is recovered the same way,
                // so an implicit `in` argument spills/addresses at `!0`, not at
                // the erased `object`.
                let recovered TypeSymbol? = ConversionClassifier.TrySubstituteCtorParameterTypeFromConstructedType(
                    openGenericDefinition,
                    symbolicTypeArgs,
                    bestCtor,
                    p,
                    peelByRef: ctorParameters[p]
                        .ParameterType
                        .IsByRef &&
                        ctorParameters[p].IsIn &&
                        !ctorParameters[p].IsOut
                )
                if recovered == nil {
                    continue
                }
                ctorParameterTypeOverrides ??= Dictionary[int32, TypeSymbol]()
                ctorParameterTypeOverrides!![p] = recovered
            }
        }
        // Issue #1638: route through the shared CLR call-argument-construction
        // pipeline (interpolation rebind → handler args → delegate rebind →
        // parameter conversions) so a Func/Action-literal argument to a CLR
        // ctor is void-ized/adapted the same way an instance/static call's
        // argument is, instead of skipping straight to boxing conversions.
        let ctorConvertedArgs = BuildResolvedClrCallArguments(
            ctorRawArgs,
            syntax.Arguments,
            ctorParameters,
            ctorMapping,
            receiver: nil,
            syntax.Location,
            syntax,
            ClrCallDelegateRebindMode.Full,
            out var ctorHandlerPrelude,
            out _,
            parameterTypeOverrides: ctorParameterTypeOverrides,
            isExpanded: ctorIsExpanded
        )
        let ctorArgs = OverloadResolver.BuildOrderedCallArguments(
            ctorConvertedArgs,
            ctorDownstreamMapping,
            ctorParameters
        )
        if !ctorRefKinds.IsDefault {
            overloads.ValidateRefArguments(ctorArgs, ctorRefKinds, clrType.Name, syntax.Location)
        }
        // Issue #671: when the closed CLR shape was type-erased to fit a G#
        // user-defined type argument, surface the result type as a constructed
        // ImportedTypeSymbol carrying the real symbolic arguments. The emitter
        // uses this to re-emit the parent TypeSpec of the ctor MemberRef with
        // the user-defined TypeDef tokens (so the NEWOBJ targets, e.g.,
        // `List<MyGs>` rather than the erased `List<object>`).
        var resultType TypeSymbol
        if resultTypeOverride != nil {
            resultType = resultTypeOverride
        } else if openGenericDefinition != nil && !symbolicTypeArgs.IsDefaultOrEmpty {
            resultType = ImportedTypeSymbol.GetConstructed(clrType, openGenericDefinition, symbolicTypeArgs)
        } else {
            resultType = TypeSymbol.FromClrTypeWithoutNullability(clrType, NullabilityFreeReason.TypeStructure)
        }
        let ctorCall BoundExpression = BoundClrConstructorCallExpression(
            syntax,
            clrType,
            bestCtor,
            ctorArgs,
            resultType,
            ctorRefKinds
        )
        result = WrapWithHandlerPrelude(ctorCall, ctorHandlerPrelude, syntax)
        return true
    }

    private func TryReportClrConstructorArgumentTypeMismatch(
        syntax CallExpressionSyntax,
        constructors IReadOnlyList[ConstructorInfo],
        argumentNames ImmutableArray[string],
        boundArguments ImmutableArray[BoundExpression].Builder
    ) bool {
        let candidates = constructors
            .Where((constructor ConstructorInfo) -> constructor.GetParameters().Length == syntax.Arguments.Count)
            .Take(2)
            .ToArray()
        if candidates.Length != 1 {
            return false
        }
        let parameters = candidates[0].GetParameters()
        for var index = 0; index < boundArguments.Count; index++ {
            let name string? = if argumentNames.IsDefault {
                default(string?)
            } else {
                argumentNames[index]
            }
            let parameterIndex = if name == nil {
                index
            } else {
                FindClrParameterIndex(parameters, name)
            }
            if parameterIndex < 0 || parameterIndex >= parameters.Length {
                return false
            }
            let parameter = parameters[parameterIndex]
            // The parameter's bare shape: this only diagnoses a failed
            // overload resolution, which compared erased shapes.
            let expectedType = ClrNullability.GetParameterTypeSymbol(parameter).StripToBareShape()
            let actualType = if boundArguments[index] is BoundAddressOfExpression address {
                address.Operand.Type
            } else {
                boundArguments[index].Type
            }
            if actualType == TypeSymbol.Error {
                continue
            }
            let isCompatible = if parameter.ParameterType.IsByRef {
                DeclarationBinder.TypeSignaturesEquivalent(expectedType, actualType)
            } else {
                Conversion.Classify(actualType, expectedType).IsImplicit
            }
            if !isCompatible {
                Diagnostics.ReportWrongArgumentType(
                    syntax.Arguments[index].Location,
                    parameter.Name ?? "value",
                    expectedType,
                    actualType
                )
                return true
            }
        }
        return false
    }

    private func TryReportClrConstructorInlineOutTypeMismatch(
        syntax CallExpressionSyntax,
        inlineOutArguments IReadOnlyList[int32],
        constructors IReadOnlyList[ConstructorInfo],
        argumentNames ImmutableArray[string],
        boundArguments ImmutableArray[BoundExpression].Builder,
        openGenericDefinition Type?,
        symbolicTypeArguments ImmutableArray[TypeSymbol]
    ) bool {
        for index in inlineOutArguments {
            let inlineOut = cast[RefArgumentExpressionSyntax](
                OverloadResolver.UnwrapNamedArgumentValue(syntax.Arguments[index])
            )
            if inlineOut.DeclaredType == nil ||
                !(boundArguments[index] is BoundAddressOfExpression{Operand: {Type: var actualType}}) ||
                actualType == TypeSymbol.Error {
                continue
            }
            var expectedType TypeSymbol? = nil
            var parameterName string? = nil
            for constructor in constructors {
                let parameters = constructor.GetParameters()
                let name string? = if argumentNames.IsDefault {
                    default(string?)
                } else {
                    argumentNames[index]
                }
                let parameterIndex = if name == nil {
                    index
                } else {
                    FindClrParameterIndex(parameters, name)
                }
                if parameterIndex < 0 ||
                    parameterIndex >= parameters.Length ||
                    !parameters[parameterIndex].IsOut ||
                    parameters[parameterIndex].IsIn {
                    continue
                }
                let candidateType = ResolveConstructorParameterPointeeType(
                    constructor,
                    parameterIndex,
                    openGenericDefinition,
                    symbolicTypeArguments
                ) ??
                    ClrNullability
                    .GetParameterTypeSymbol(parameters[parameterIndex]).StripToBareShape()
                if expectedType != nil && !DeclarationBinder.TypeSignaturesEquivalent(expectedType, candidateType) {
                    expectedType = nil
                    break
                }
                expectedType = candidateType
                parameterName = parameters[parameterIndex].Name ?? "value"
            }
            if expectedType != nil && !DeclarationBinder.TypeSignaturesEquivalent(expectedType, actualType) {
                Diagnostics.ReportWrongArgumentType(
                    inlineOut.Location,
                    parameterName ?? "value",
                    expectedType,
                    actualType
                )
                return true
            }
        }
        return false
    }

    private func DeclareInvalidClrConstructorInlineOutLocals(
        syntax CallExpressionSyntax,
        inlineOutArguments IReadOnlyList[int32],
        bindExplicitTyped bool = false
    ) {
        let errorParameter = ParameterSymbol("value", TypeSymbol.Error, refKind: RefKind.Out)
        for index in inlineOutArguments {
            let inlineOut = cast[RefArgumentExpressionSyntax](
                OverloadResolver.UnwrapNamedArgumentValue(syntax.Arguments[index])
            )
            if !inlineOut.IsDiscard && (bindExplicitTyped || inlineOut.DeclaredType == nil) {
                let _ = BindRefArgumentExpression(inlineOut, errorParameter)
            }
        }
    }

    private func DeclareClrConstructorInlineOutLocals(
        syntax CallExpressionSyntax,
        inlineOutArguments IReadOnlyList[int32],
        constructors IReadOnlyList[ConstructorInfo],
        argumentNames ImmutableArray[string],
        openGenericDefinition Type?,
        symbolicTypeArguments ImmutableArray[TypeSymbol]
    ) {
        for index in inlineOutArguments {
            let inlineOut = cast[RefArgumentExpressionSyntax](
                OverloadResolver.UnwrapNamedArgumentValue(syntax.Arguments[index])
            )
            if inlineOut.IsDiscard || inlineOut.DeclaredType != nil {
                continue
            }
            let name string? = if argumentNames.IsDefault {
                default(string?)
            } else {
                argumentNames[index]
            }
            var matchingConstructor ConstructorInfo? = nil
            var matchingParameterIndex = -1
            for constructor in constructors {
                let parameters = constructor.GetParameters()
                let parameterIndex = if name == nil {
                    index
                } else {
                    FindClrParameterIndex(parameters, name)
                }
                if parameterIndex < 0 ||
                    parameterIndex >= parameters.Length ||
                    !parameters[parameterIndex].IsOut ||
                    parameters[parameterIndex].IsIn {
                    continue
                }
                if matchingConstructor != nil {
                    matchingConstructor = nil
                    matchingParameterIndex = -1
                    break
                }
                matchingConstructor = constructor
                matchingParameterIndex = parameterIndex
            }
            if matchingConstructor == nil {
                let errorParameter = ParameterSymbol("value", TypeSymbol.Error, refKind: RefKind.Out)
                let _ = BindRefArgumentExpression(inlineOut, errorParameter)
                continue
            }
            let parameter = matchingConstructor.GetParameters()[matchingParameterIndex]
            let pointeeType = ResolveConstructorParameterPointeeType(
                matchingConstructor,
                matchingParameterIndex,
                openGenericDefinition,
                symbolicTypeArguments
            ) ??
                ClrNullability
                .GetParameterTypeSymbol(parameter).StripToBareShape()
            let resolvedParameter = RefCapabilities.CreateParameterSymbol(parameter, pointeeType, "value")
            let _ = BindRefArgumentExpression(inlineOut, resolvedParameter)
        }
    }

    private func RebindInlineOutConstructorArguments(
        syntax CallExpressionSyntax,
        arguments ImmutableArray[BoundExpression],
        constructor ConstructorInfo,
        parameterMapping ImmutableArray[int32],
        openGenericDefinition Type?,
        symbolicTypeArguments ImmutableArray[TypeSymbol]
    ) ImmutableArray[BoundExpression] {
        var rebuilt ImmutableArray[BoundExpression].Builder? = nil
        let parameters = constructor.GetParameters()
        for var i = 0; i < arguments.Length; i++ {
            if !TryGetInlineOutVarArgument(syntax, i, out var refArgument) {
                continue
            }
            if refArgument.DeclaredType != nil {
                continue
            }
            let parameterIndex = if parameterMapping.IsDefault {
                i
            } else {
                parameterMapping[i]
            }
            let parameter = parameters[parameterIndex]
            let pointeeType = ResolveConstructorParameterPointeeType(
                constructor,
                parameterIndex,
                openGenericDefinition,
                symbolicTypeArguments
            ) ??
                ClrNullability
                .GetParameterTypeSymbol(parameter).StripToBareShape()
            let syntheticParameter = RefCapabilities.CreateParameterSymbol(parameter, pointeeType, "value")
            rebuilt ??= arguments.ToBuilder()
            rebuilt!![i] = BindRefArgumentExpression(refArgument, syntheticParameter)
        }
        return rebuilt?.ToImmutable() ?? arguments
    }

    /// Issue #891: binds a single call argument, target-typing arrow/func
    /// literals against the matching delegate-typed parameter discovered from
    /// the candidate (constructor or method) parameter lists. This lets an
    /// arrow lambda — including a statement body that only throws — be bound
    /// directly as the corresponding delegate (Func/Action) instead of
    /// inferring a standalone (often void) function type that fails overload
    /// resolution and misroutes the call.
    private func BindCallArgumentWithDelegateTargetTyping(
        argumentSyntax ExpressionSyntax,
        candidateParameterLists IReadOnlyList[[]ParameterInfo],
        sourceArgumentCount int32,
        sourceArgIndex int32,
        argName string?,
        paramOffset int32
    ) BoundExpression {
        let inner = OverloadResolver.UnwrapNamedArgumentValue(argumentSyntax)
        if IsTargetDependentBlockArgumentSyntax(inner) &&
            TryResolveTargetDependentBlockTarget(
            candidateParameterLists,
            paramOffset,
            sourceArgumentCount,
            sourceArgIndex,
            argName,
            inner,
            out var blockTarget
        ) {
            return BindExpression(inner, blockTarget!!)
        }
        if inner is LambdaExpressionSyntax lambdaSyntax &&
            TryResolveDelegateTargetFromCandidates(
            candidateParameterLists,
            paramOffset,
            sourceArgIndex,
            argName,
            out var target,
            out var nominalTarget,
            out _,
            out _
        ) {
            return BindLambdaWithDelegateTarget(argumentSyntax, lambdaSyntax, target!!, nominalTarget)
        }
        return BindExpression(inner)
    }

    private func BindLambdaWithDelegateTarget(
        argumentSyntax ExpressionSyntax,
        lambdaSyntax LambdaExpressionSyntax,
        target FunctionTypeSymbol,
        nominalTarget TypeSymbol?
    ) BoundExpression {
        let literal = lambdas.BindLambdaExpression(lambdaSyntax, target)
        return if nominalTarget != nil && ShouldConvertToNominalDelegate(nominalTarget) {
            conversions.BindConversion(argumentSyntax.Location, literal, nominalTarget)
        } else {
            literal
        }
    }

    /// Issue #569: resolves a nested type constructor call when the call
    /// identifier names a nested type within a containing CLR type.
    /// For example, `Outer.Inner()` where `Inner` is a nested class
    /// inside `Outer`. Supports generic nested types via
    /// `Outer.Inner[T]()` and deeply-nested types via recursive accessor
    /// chains (`Outer.Middle.Inner()` is handled by the accessor step
    /// resolving `Outer.Middle` as a nested type that becomes the new
    /// classSymbol for the terminal call). This unifies the call-expression
    /// path with the type-clause resolution that #526 added.
    /// @param containingType The CLR type of the outer class (e.g. `Outer`).
    /// @param syntax The call expression (identifier = nested type name, args = ctor args).
    /// @param result The bound constructor call on success.
    /// @returns Whether a nested type was found and a constructor was bound.
    private func TryBindNestedTypeConstructorCall(
        containingType Type,
        syntax CallExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        let nestedName = syntax.Identifier.ValueText
        let arity = syntax.TypeArgumentList?.Arguments.Count ?? 0
        var nestedType Type? = nil
        // Try arity-mangled name first for generic nested types (e.g. Inner`1).
        if arity > 0 {
            $scope.References!!.TryResolveNestedType(
                containingType,
                nestedName + "`" + arity.ToString(),
                out nestedType
            )
        }
        if nestedType == nil {
            $scope.References!!.TryResolveNestedType(containingType, nestedName, out nestedType)
        }
        if nestedType == nil {
            return false
        }
        // Close generic nested type if type arguments were provided.
        if arity > 0 && nestedType.IsGenericTypeDefinition {
            if syntax.TypeArgumentList is not TypeArgumentListSyntax typeArguments {
                return false
            }
            let clrArgs = [arity]Type
            for var i = 0; i < arity; i++ {
                let ta = bindTypeClause(typeArguments.Arguments[i])
                if ta?.ClrType == nil {
                    return false
                }
                clrArgs[i] = $scope.References!!.MapClrTypeToReferences(ta!!.ClrType)!!
            }
            try {
                nestedType = nestedType.MakeGenericType(clrArgs)
            } catch (ArgumentException) {
                return false
            }
        } else if nestedType!!.IsGenericTypeDefinition {
            // Nested type is generic but no type arguments supplied — cannot construct.
            return false
        }
        let bound = TryBindClrConstructorFromType(
            nestedType!!,
            syntax,
            out result,
            out var noApplicableOverload,
            out var boundArguments
        )
        return bound ||
            FinishClrConstructorBindingFailure(
            syntax,
            nestedType!!.Name,
            noApplicableOverload,
            boundArguments,
            &result,
            TypeSymbol.FromClrTypeWithoutNullability(nestedType, NullabilityFreeReason.TypeStructure)
        )
    }

    private class SymbolicDelegateTarget {
        init(delegateType TypeSymbol, functionType FunctionTypeSymbol) {
            DelegateType = delegateType
            FunctionType = functionType
        }

        prop DelegateType TypeSymbol {
            get;
        }

        prop FunctionType FunctionTypeSymbol {
            get;
        }
    }

    shared {
        /// Issue #4013: the synthesized collection-initializer `Add` call
        /// nodes, which keep the pre-#4013 candidate view. Weak-keyed so the marks
        /// die with the syntax nodes, and thread-safe like the other process-wide
        /// binder caches.
        private let SynthesizedCollectionAddCalls ConditionalWeakTable[
            CallExpressionSyntax,
            object
        ] = ConditionalWeakTable[CallExpressionSyntax, object]()

        /// The value stored for every marked node; only the key matters.
        private let MarkerValue object = SystemObject()

        private func TryGetCollectionSpreadElementType(
            collectionType TypeSymbol,
            @NotNullWhen(true) out elementType TypeSymbol?
        ) bool {
            switch collectionType {
                case slice is SliceTypeSymbol {
                    elementType = slice.ElementType
                    return true
                }
                case array is ArrayTypeSymbol {
                    elementType = array.ElementType
                    return true
                }
                case sequence_ is SequenceTypeSymbol {
                    elementType = sequence_.ElementType
                    return true
                }
                case imported is ImportedTypeSymbol when imported.OpenDefinition != nil &&
                    MemberLookup
                    .TryGetClrEnumerableElementType(imported.OpenDefinition, out var openElement) {
                    elementType = MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(
                        openElement,
                        imported,
                        NullabilityFreeReason.TypeStructure
                    )
                    return true
                }
                case annotated is NullabilityAnnotatedTypeSymbol when annotated.ClrType != nil &&
                    MemberLookup
                    .TryGetClrEnumerableElementType(annotated.ClrType, out var annotatedElement) {
                    elementType = annotated.GetTypeArgumentSymbolForClrType(annotatedElement)
                    return true
                }
                case imported is ImportedTypeSymbol when imported.ClrType != nil &&
                    MemberLookup
                    .TryGetClrEnumerableElementType(imported.ClrType, out var importedElement) {
                    elementType = TypeSymbol.FromClrTypeWithoutNullability(
                        importedElement,
                        NullabilityFreeReason.TypeStructure
                    )
                    return true
                }
                case user is StructSymbol when MemberLookup.TryGetUserPatternEnumerableElementType(
                    user,
                    out var userElement
                ) {
                    elementType = Invariant.Required(
                        userElement,
                        "a successful user enumerable-element lookup produces an element type",
                        expression: "userElement"
                    )
                    return true
                }
            }
            let userParameterTypes = TypeMemberModel
                .GetMethods(collectionType, "Add", MemberQuery.Instance(MemberKinds.Method))
                .Where((method FunctionSymbol) -> method.Parameters.Length == 1)
                .Select((method FunctionSymbol) -> method.Parameters[0].Type)
                .Distinct()
                .ToArray()
            if userParameterTypes.Length == 1 {
                elementType = userParameterTypes[0]
                return true
            }
            elementType = nil
            if collectionType?.ClrType == nil {
                return false
            }
            var clrElement Type? = nil
            var elementParameter ParameterInfo? = nil
            // Issue #4013: the collection-literal view again (see HasCollectionAdd).
            // Passing the narrowed ordinary-call view here would change which
            // element type a literal infers — `List[T]` would stop seeing
            // `IList.Add(object)` beside `Add(T)` and so stop being ambiguous —
            // which is a behaviour change this issue is not about. Kept identical
            // to the pre-#4013 candidate set on purpose.
            for method in MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
                collectionType.ClrType,
                "Add",
                includeInternal: false,
                includeExplicitInterfaceMembers: true
            ) {
                let parameters = method.GetParameters()
                if parameters.Length != 1 {
                    continue
                }
                if clrElement != nil && !clrElement.IsSameAs(parameters[0].ParameterType) {
                    return false
                }
                clrElement = parameters[0].ParameterType
                elementParameter = parameters[0]
            }
            if elementParameter == nil {
                return false
            }
            elementType = ClrNullability.GetParameterTypeSymbol(elementParameter)
            return true
        }

        private func HasCollectionAdd(type TypeSymbol) bool {
            if !TypeMemberModel.GetMethods(type, "Add", MemberQuery.Instance(MemberKinds.Method)).IsDefaultOrEmpty {
                return true
            }
            // Issue #4013: the collection-literal `Add` probe deliberately keeps
            // seeing an explicitly-implemented interface `Add`, which the
            // ordinary-call candidate view no longer offers. `Dictionary[K, V]`
            // implements `ICollection<KeyValuePair<K, V>>.Add` explicitly, and the
            // #3096 spread form fills a dictionary through exactly that member,
            // emitting the call through the interface. Without the wider view
            // `Dictionary[string, int32](){ ...pairs }` reports GS0369.
            return type.ClrType is {} clrType && MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
                clrType,
                "Add",
                includeInternal: false,
                includeExplicitInterfaceMembers: true
            )
                .Count > 0
        }

        private func HasUnaryCollectionAdd(type TypeSymbol) bool {
            if TypeMemberModel.GetMethods(type, "Add", MemberQuery.Instance(MemberKinds.Method)).Any(
                IsCallableWithSingleArgument
            ) {
                return true
            }
            if type.ClrType is not{} clrType {
                return false
            }
            // Issue #4013: same wider view as HasCollectionAdd above — the unary
            // `Add` a spread needs on a `Dictionary[K, V]` is the explicit
            // `ICollection<KeyValuePair<K, V>>.Add`.
            for method in MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
                clrType,
                "Add",
                includeInternal: false,
                includeExplicitInterfaceMembers: true
            ) {
                if IsCallableWithSingleArgument(method.GetParameters()) {
                    return true
                }
            }
            return false
        }

        // Reviewer finding: this is a capability PROBE for "is there an Add
        // overload reachable with exactly one argument", not the overload
        // resolution itself — BindCollectionAddCall does the real resolution
        // (§D). Requiring exactly one DECLARED parameter wrongly rejected
        // `Add(child Node, trace bool = false)`, which is callable with one
        // argument via its trailing optional parameter. Mirrors the
        // required-parameter-count scan OverloadResolver.Candidates.cs'
        // IsApplicableUserCallable already uses.
        private func IsCallableWithSingleArgument(method FunctionSymbol) bool {
            let paramLen = method.Parameters.Length
            if paramLen == 0 {
                return false
            }
            let isVariadic = method.Parameters[paramLen - 1].IsVariadic
            let fixedParamCount = if isVariadic {
                paramLen - 1
            } else {
                paramLen
            }
            var requiredParamCount = fixedParamCount
            for var i = fixedParamCount - 1; i >= 0; i-- {
                if !method.Parameters[i].HasExplicitDefaultValue {
                    break
                }
                requiredParamCount = i
            }
            return requiredParamCount <= 1
        }

        // Reviewer finding: mirrors the FunctionSymbol overload above — a
        // TRAILING `params` array (e.g. an imported `Add(T item, params U[]
        // rest)`) is callable with a single non-params argument, so it must not
        // count toward the required parameter count. Only a params array in the
        // LAST declared position qualifies; C# forbids it anywhere else.
        private func IsCallableWithSingleArgument(parameters[]ParameterInfo) bool {
            let paramLen = parameters.Length
            if paramLen == 0 {
                return false
            }
            let isVariadic = HasParamArrayAttribute(parameters[paramLen - 1])
            let fixedParamCount = if isVariadic {
                paramLen - 1
            } else {
                paramLen
            }
            var requiredParamCount = fixedParamCount
            for var i = fixedParamCount - 1; i >= 0; i-- {
                if !parameters[i].IsOptional {
                    break
                }
                requiredParamCount = i
            }
            return requiredParamCount <= 1
        }

        private func HasParamArrayAttribute(parameter ParameterInfo) bool {
            for attribute in parameter.GetCustomAttributesData() {
                if string.Equals(
                    attribute.AttributeType.FullName,
                    "System.ParamArrayAttribute",
                    StringComparison.Ordinal
                ) {
                    return true
                }
            }
            return false
        }

        /// Issue #4013: whether [`call`](paramref) is a synthesized
        /// collection-initializer `Add`, which may still bind to an
        /// explicitly-implemented interface member.
        /// @param call The call syntax being bound.
        /// @returns True for a synthesized collection `Add`.
        internal func IsSynthesizedCollectionAddCall(call CallExpressionSyntax?) bool -> call != nil &&
            SynthesizedCollectionAddCalls.TryGetValue(call, out _)

        private func TryGetCopyOverrides(
            call CallExpressionSyntax,
            @MaybeNullWhen(false) out overrides GSharp
                .Core
                .CodeAnalysis
                .Syntax
                .SeparatedSyntaxList[FieldInitializerSyntax]
        ) bool {
            let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
            for node in call.Arguments.GetWithSeparators() {
                if node is SyntaxToken token {
                    nodesAndSeparators.Add(token)
                    continue
                }
                if node is NamedArgumentExpressionSyntax named {
                    nodesAndSeparators.Add(
                        FieldInitializerSyntax(named.SyntaxTree, named.NameToken, named.EqualsToken, named.Expression)
                    )
                    continue
                }
                overrides = default(GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[FieldInitializerSyntax]?)!!
                return false
            }
            overrides = GSharp
                .Core
                .CodeAnalysis
                .Syntax
                .SeparatedSyntaxList[FieldInitializerSyntax](nodesAndSeparators.ToImmutable())
            return true
        }

        private func ComputeArgumentRefKinds(parameters[]ParameterInfo) ImmutableArray[RefKind] {
            var hasAnyRef = false
            for var i = 0; i < parameters.Length; i++ {
                if parameters[i].ParameterType.IsByRef {
                    hasAnyRef = true
                    break
                }
            }
            if !hasAnyRef {
                return default(ImmutableArray[RefKind])
            }
            let builder = ImmutableArray.CreateBuilder[RefKind](parameters.Length)
            for var i = 0; i < parameters.Length; i++ {
                let p = parameters[i]
                if !p.ParameterType.IsByRef {
                    builder.Add(RefKind.None)
                } else if p.IsOut && !p.IsIn {
                    builder.Add(RefKind.Out)
                } else if p.IsIn && !p.IsOut {
                    builder.Add(RefKind.In)
                } else {
                    builder.Add(RefKind.Ref)
                }
            }
            return builder.MoveToImmutable()
        }

        private func GetInlineOutArgumentIndices(syntax CallExpressionSyntax) List[int32] {
            let result = List[int32]()
            for var i = 0; i < syntax.Arguments.Count; i++ {
                if (
                    OverloadResolver.UnwrapNamedArgumentValue(syntax.Arguments[i]) is RefArgumentExpressionSyntax and
                        {IsInlineDeclaration: true}
                ) {
                    result.Add(i)
                }
            }
            return result
        }

        private func ConstructorSupportsInlineOutArguments(
            constructor ConstructorInfo,
            argumentNames ImmutableArray[string],
            inlineOutArguments IReadOnlyList[int32]
        ) bool {
            for sourceIndex in inlineOutArguments {
                if !ConstructorSupportsInlineOutArgument(constructor, argumentNames, sourceIndex) {
                    return false
                }
            }
            return true
        }

        private func ConstructorSupportsInlineOutArgument(
            constructor ConstructorInfo,
            argumentNames ImmutableArray[string],
            sourceIndex int32
        ) bool {
            let parameters = constructor.GetParameters()
            let name string? = if argumentNames.IsDefault {
                default(string?)
            } else {
                argumentNames[sourceIndex]
            }
            let parameterIndex = if name == nil {
                sourceIndex
            } else {
                FindClrParameterIndex(parameters, name)
            }
            return parameterIndex >= 0 &&
                parameterIndex < parameters.Length &&
                parameters[parameterIndex].IsOut &&
                !parameters[parameterIndex].IsIn
        }

        private func FindClrParameterIndex(parameters[]ParameterInfo, argumentName string) int32 {
            let parameterNames = parameters.Select((parameter ParameterInfo) -> parameter.Name ?? string.Empty)
                .ToArray()
            for var i = 0; i < parameters.Length; i++ {
                if OverloadResolver.ClrParameterNameMatches(
                    parameters[i].Name ?? string.Empty,
                    argumentName,
                    parameterNames
                ) {
                    return i
                }
            }
            return -1
        }

        private func ResolveConstructorParameterPointeeType(
            constructor ConstructorInfo,
            parameterIndex int32,
            openGenericDefinition Type?,
            symbolicTypeArguments ImmutableArray[TypeSymbol]
        ) TypeSymbol? {
            if openGenericDefinition == nil || symbolicTypeArguments.IsDefaultOrEmpty {
                return nil
            }
            let openConstructor ConstructorInfo? = ClrTypeUtilities.SafeGetConstructors(
                openGenericDefinition,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
            )
                .FirstOrDefault(
                (candidate ConstructorInfo) -> candidate.MetadataToken == constructor.MetadataToken &&
                    candidate.Module == constructor.Module
            )
            if openConstructor == nil {
                return nil
            }
            let openParameters = openConstructor.GetParameters()
            if parameterIndex >= openParameters.Length {
                return nil
            }
            let openParameter = openParameters[parameterIndex]
            return if openParameter.ParameterType.IsByRef {
                MemberLookup.GetClrOpenParameterPointeeTypeSymbol(
                    openParameter,
                    openGenericDefinition,
                    symbolicTypeArguments
                )
            } else {
                default(TypeSymbol?)
            }
        }

        /// Issue #891 / #2345 / #3149: discovers the closed delegate function shape
        /// and nominal identity shared by a lambda argument's candidate parameters.
        /// Open generic candidates are reported separately so all-open block lambdas
        /// and mixed open/closed sets can wait for overload resolution.
        private func TryResolveDelegateTargetFromCandidates(
            candidateParameterLists IReadOnlyList[[]ParameterInfo],
            paramOffset int32,
            sourceArgIndex int32,
            argName string?,
            @NotNullWhen(true) out target FunctionTypeSymbol?,
            out nominalTarget TypeSymbol?,
            out blockedByOpenGenericParameter bool,
            out sawOpenGenericParameter bool
        ) bool {
            target = default(FunctionTypeSymbol?)
            nominalTarget = nil
            blockedByOpenGenericParameter = false
            sawOpenGenericParameter = false
            var nominalTargetsAgree = true
            var sawAnyMatchingSlot = false
            for parameters in candidateParameterLists {
                var paramIndex int32
                if !string.IsNullOrEmpty(argName) {
                    paramIndex = -1
                    for var p = 0; p < parameters.Length; p++ {
                        if string.Equals(parameters[p].Name, argName, StringComparison.Ordinal) {
                            paramIndex = p
                            break
                        }
                    }
                    if paramIndex < 0 {
                        continue
                    }
                } else {
                    paramIndex = sourceArgIndex + paramOffset
                    if paramIndex < 0 || paramIndex >= parameters.Length {
                        continue
                    }
                }
                let parameterType Type? = parameters[paramIndex].ParameterType
                if parameterType == nil {
                    continue
                }
                sawAnyMatchingSlot = true
                if parameterType.ContainsGenericParameters {
                    // Open generic delegate parameters are resolved later, once the
                    // generic method's type arguments have been inferred.
                    blockedByOpenGenericParameter = true
                    sawOpenGenericParameter = true
                    continue
                }
                // Issue #2782: a general Delegate candidate has no Invoke shape with which to
                // contextually bind the lambda. It can still win overload
                // resolution, so a sibling's concrete delegate signature must not
                // pin (and potentially erase) the lambda's natural return type.
                let parameterFullName = parameterType.FullName
                if string.Equals(parameterFullName, "System.Delegate", StringComparison.Ordinal) || string.Equals(
                    parameterFullName,
                    "System.MulticastDelegate",
                    StringComparison.Ordinal
                ) {
                    target = default(FunctionTypeSymbol?)
                    nominalTarget = nil
                    blockedByOpenGenericParameter = false
                    sawOpenGenericParameter = false
                    return false
                }
                if !MemberLookup.TryGetLambdaTargetFunctionType(parameterType, out var candidate) || candidate == nil {
                    continue
                }
                if target == nil {
                    target = candidate
                } else if !object.ReferenceEquals(target, candidate) && !target.Equals(candidate) {
                    // Candidates disagree on the delegate shape — leave the lambda
                    // to be bound without a target (overload resolution decides).
                    target = default(FunctionTypeSymbol?)
                    nominalTarget = nil
                    blockedByOpenGenericParameter = false
                    sawOpenGenericParameter = false
                    return false
                }
                // The delegate slot's bare shape: a function literal is never nil.
                let nominalCandidate = ClrNullability.GetParameterTypeSymbol(parameters[paramIndex]).StripToBareShape()
                if nominalTargetsAgree {
                    if nominalTarget == nil {
                        nominalTarget = nominalCandidate
                    } else if !SameDelegateIdentity(nominalTarget, nominalCandidate) {
                        // Issue #3149: reached but not mutation-pinned. TryBindClrConstructorCall
                        // is the sole constructor caller; BindAccessorCall also consumes this output.
                        nominalTarget = nil
                        nominalTargetsAgree = false
                    }
                }
            }
            // Only report the "blocked" signal when every matching slot was open —
            // if some candidate produced a usable closed target, that target wins
            // and there is nothing left to defer.
            blockedByOpenGenericParameter = blockedByOpenGenericParameter && target == nil && sawAnyMatchingSlot
            // Issue #3149: reached but not mutation-pinned. BindAccessorCall consumes
            // sawOpen to defer mixed open/closed candidates, so this reset must remain.
            if sawOpenGenericParameter {
                nominalTarget = nil
            }
            return target != nil
        }

        /// Issue #1502: resolves the symbolic delegate target shape for a lambda
        /// argument at [`sourceArgIndex`](paramref) (or named
        /// [`argName`](paramref)) of a constructed-generic CLR constructor whose
        /// type arguments include a same-compilation user-defined type. The closed
        /// CLR ctor parameter is type-erased (e.g. `Func<object>`); this
        /// recovers the exact mapped delegate identity and its real shape (e.g.
        /// `Func<Foo>` and `() -> Foo`) by substituting the
        /// receiver's symbolic type arguments through the OPEN constructor's
        /// parameter type. Returns `false` (deferring to the ordinary
        /// erased path) when there is no symbolic substitution in effect, when the
        /// candidate ctors disagree on identity or shape, or when no open ctor
        /// exposes a delegate parameter at that position.
        private func TryResolveSymbolicDelegateTargetForCtor(
            openGenericDefinition Type?,
            symbolicTypeArgs ImmutableArray[TypeSymbol],
            sourceArgIndex int32,
            argName string?,
            @NotNullWhen(true) out target SymbolicDelegateTarget?
        ) bool {
            target = nil
            if openGenericDefinition == nil || symbolicTypeArgs.IsDefaultOrEmpty {
                return false
            }
            var openCtors[]ConstructorInfo
            try {
                openCtors = openGenericDefinition.GetConstructors(BindingFlags.Public | BindingFlags.Instance)
            } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                return false
            }
            for ctor in openCtors {
                let parameters = ctor.GetParameters()
                var paramIndex int32
                if !string.IsNullOrEmpty(argName) {
                    paramIndex = -1
                    for var p = 0; p < parameters.Length; p++ {
                        if string.Equals(parameters[p].Name, argName, StringComparison.Ordinal) {
                            paramIndex = p
                            break
                        }
                    }
                    if paramIndex < 0 {
                        continue
                    }
                } else {
                    paramIndex = sourceArgIndex
                    if paramIndex < 0 || paramIndex >= parameters.Length {
                        continue
                    }
                }
                if !TryBuildSymbolicDelegateTarget(
                    parameters[paramIndex].ParameterType,
                    openGenericDefinition,
                    symbolicTypeArgs,
                    out var mappedDelegate,
                    out var candidate
                ) ||
                    mappedDelegate == nil ||
                    candidate == nil {
                    continue
                }
                if target == nil {
                    target = SymbolicDelegateTarget(mappedDelegate, candidate)
                } else if !SameDelegateIdentity(target.DelegateType, mappedDelegate) ||
                    (
                    !object.ReferenceEquals(target.FunctionType, candidate) && !target.FunctionType.Equals(candidate)
                ) {
                    target = nil
                    return false
                }
            }
            return target != nil && target.FunctionType != nil
        }
    }
}
