// <copyright file="CSharpToGSharpTranslator.Patterns.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Operations
import Microsoft.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq

partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        private func TranslateExpression(expression ExpressionSyntax?) GExpression? {
            if this.state.HoistedExpressionValues.TryGetValue(expression!!, out var hoistedValue) {
                return hoistedValue
            }
            // Issue #4262 follow-up (item 2): this exact read was rewritten by
            // EmitGuardedFieldLocalCaptures to reference the synthesized local
            // that already captured the field/property non-null (see
            // DocumentTranslationState.GuardCapturedFieldReads).
            if this.state.GuardCapturedFieldReads.TryGetValue(expression!!, out var guardCapturedName) {
                return IdentifierExpression(guardCapturedName)
            }
            // ADR-0169 M5 / issue #3778: in an analyzer TEST project, the
            // constant string that reaches the harness's source parameter is
            // not data — it is C# source the migrated verifier will compile as
            // G#. It is intercepted here, above the ordinary literal and
            // string-concatenation paths, because a composed
            // `Model + """…"""` must translate as ONE compilation unit and
            // neither operand compiles alone.
            if this.TryTranslateAnalyzerSnippet(expression, out var snippet) {
                return snippet
            }
            switch expression {
                case literal is LiteralExpressionSyntax {
                    return this.TranslateLiteral(literal)
                }
                case identifier is IdentifierNameSyntax {
                    return this.TranslateIdentifierName(identifier)
                }
                case refExpression is RefExpressionSyntax {
                    return this.TranslateRefExpression(refExpression)
                }
                case generic is GenericNameSyntax {
                    // A generic name used as an expression is most often a generic
                    // *method* group (`Method<T>(...)`), whose bracket type arguments
                    // are applied by the enclosing invocation — there the bare
                    // identifier is correct. But it can also be a constructed generic
                    // *type* used as the receiver of a static member access
                    // (`Mp4Operation<ChapterInfo?>.FromCompleted(...)`); dropping the
                    // type arguments there picks the wrong (non-generic) overload
                    // (GS0144). Render the type with its arguments as `T[args]` so the
                    // static member resolves on the constructed generic type.
                    if this.context.GetSymbolInfo(generic).Symbol is INamedTypeSymbol genericType {
                        let typeRef GTypeReference? = this.typeMapper.Map(
                            genericType,
                            this.context,
                            generic.GetLocation()
                        )
                        return TypeExpression(typeRef)
                    }
                    if this.TryTranslateLiftedLocalFunctionReference(generic, out var liftedGeneric) {
                        let invoke IMethodSymbol? = GetDelegateInvokeMethod(
                            this.context.GetTypeInfo(generic).ConvertedType
                        )
                        if invoke != nil && this.context.GetSymbolInfo(generic).Symbol is IMethodSymbol localFunction {
                            return this.typeMapper.WithMetadataImportCollisionQualification(
                                () -> this.TranslateExactMethodGroupArgument(generic, localFunction, invoke)
                            )
                        }
                        return liftedGeneric
                    }
                    return IdentifierExpression(
                        this.EmittedName(this.context.GetSymbolInfo(generic).Symbol, generic.Identifier.ValueText)
                    )
                }
                case ThisExpressionSyntax {
                    return ThisExpression()
                }
                case BaseExpressionSyntax {
                    // Issue #986: C# `base.M(...)` maps directly to the G#
                    // base-class call form `base.M(...)`, which emits a
                    // non-virtual `call` into the base implementation. The
                    // `base` receiver is rendered as a bare identifier; the
                    // enclosing member-access / invocation supplies the `.M(...)`.
                    return IdentifierExpression("base")
                }
                case member is MemberAccessExpressionSyntax {
                    return this.TranslateMemberAccess(member)
                }
                case invocation is InvocationExpressionSyntax {
                    return this.TranslateInvocation(invocation)
                }
                case creation is ObjectCreationExpressionSyntax {
                    return this.TranslateObjectCreation(creation)
                }
                case cast is CastExpressionSyntax {
                    return this.TranslateCast(cast)
                }
                case with is WithExpressionSyntax {
                    return this.TranslateWith(with)
                }
                case binary is BinaryExpressionSyntax when binary.IsKind(SyntaxKind.AsExpression) || binary.IsKind(
                    SyntaxKind.IsExpression
                ) {
                    // Issue #4173: a BARE `expr is Type` with no designator,
                    // pattern combinator, or subpattern parses as this OLDER
                    // BinaryExpressionSyntax/IsExpression node, not a pattern —
                    // it never reaches TranslateIsPattern at all. Every I1/
                    // I1b/I4/I5 null-conditional-access idiom needs to see
                    // this form too (it is the COMMONEST real-world spelling
                    // for a plain type probe), or I7's deliberately
                    // non-discriminating ConditionalAccessExpressionSyntax ->
                    // ExpressionSyntax map row (and the pre-existing, equally
                    // unconditional MemberAccessExpressionSyntax row) would
                    // make it silently vacuous/over-matching here.
                    if binary.IsKind(SyntaxKind.IsExpression) &&
                        this.InAnalyzerApiMode &&
                        this
                        .TryTranslateAnalyzerNullConditionalTypeTest(
                        binary.Left,
                        binary.Right,
                        designation: nil,
                        binary,
                        out var analyzerBareTypeTest
                    ) {
                        return analyzerBareTypeTest
                    }
                    // `e as T` / `e is T`: the right operand is a type. Render it as
                    // a type expression so array/qualified types map to canonical G#
                    // (e.g. `o as []object`, `o is []object`).
                    return BinaryExpression(
                        this.TranslateExpression(binary.Left),
                        binary.OperatorToken.Text,
                        TypeExpression(
                            if binary.Right is TypeSyntax typeOperand {
                                this.MapTypeSyntax(typeOperand)
                            } else {
                                cast[GTypeReference](NamedTypeReference(binary.Right.ToString()))
                            }
                        )
                    )
                }
                case binary is BinaryExpressionSyntax {
                    // Issue #941: C# null-coalescing `a ?? b` now maps directly to
                    // G#'s `a ?? b` (the operator token text is identical), so it
                    // flows through the generic binary translation below.
                    return this.TranslateBinaryExpression(binary)
                }
                case prefix is PrefixUnaryExpressionSyntax {
                    if prefix.IsKind(SyntaxKind.PreIncrementExpression) || prefix.IsKind(
                        SyntaxKind.PreDecrementExpression
                    ) {
                        // ADR-0126 defines compound assignments as value-producing,
                        // so this preserves both the mutation and prefix result.
                        return AssignmentExpression(
                            this.TranslateExpression(prefix.Operand),
                            LiteralExpression.Int("1"),
                            if prefix.IsKind(SyntaxKind.PreIncrementExpression) {
                                "+="
                            } else {
                                "-="
                            }
                        )
                    }
                    // ADR-0187: a C# from-end index `^n` is a first-class G#
                    // `System.Index` expression in every position, so it
                    // round-trips verbatim — as a bracket argument, a saved
                    // local, an argument, or a range bound.
                    if prefix.IsKind(SyntaxKind.IndexExpression) {
                        return FromEndIndexExpression(this.TranslateExpression(prefix.Operand))
                    }
                    // C# `~x` (one's-complement) and every other prefix
                    // operator token are spelled identically in G# (ADR-0187).
                    let prefixOp = prefix.OperatorToken.Text
                    return UnaryExpression(prefixOp, this.TranslateExpression(prefix.Operand))
                }
                case parenthesized is ParenthesizedExpressionSyntax {
                    return ParenthesizedExpression(this.TranslateExpression(parenthesized.Expression))
                }
                case checkedExpr is CheckedExpressionSyntax {
                    // Issue #1881: `checked(expr)`/`unchecked(expr)` maps directly to
                    // the G# `checked(...)`/`unchecked(...)` expression (gsc now
                    // supports both natively).
                    return CheckedExpression(
                        this.TranslateExpression(checkedExpr.Expression),
                        checkedExpr.IsKind(SyntaxKind.CheckedExpression)
                    )
                }
                case interpolated is InterpolatedStringExpressionSyntax {
                    return this.TranslateInterpolatedString(interpolated)
                }
                case tuple is TupleExpressionSyntax {
                    // ADR-0172: preserve C# element labels (`(Line: 1, …)`)
                    // as G# labeled tuple-literal elements.
                    return TupleLiteralExpression(
                        tuple
                            .Arguments
                            .Select((a ArgumentSyntax) -> this.TranslateValueWithNullForgiveness(a.Expression)!!)
                            .ToList(),
                        tuple.Arguments.Select((a ArgumentSyntax) -> a.NameColon?.Name.Identifier.ValueText).ToList()
                    )
                }
                case anonymous is AnonymousObjectCreationExpressionSyntax {
                    return this.TranslateAnonymousObjectCreation(anonymous)
                }
                case range_ is RangeExpressionSyntax {
                    // ADR-0187: a reusable C# range value keeps its readable
                    // `a..b` / `^a..^b` / `..` form as a G# System.Range value.
                    return RangeIndexExpression(
                        if range_.LeftOperand != nil {
                            this.TranslateExpression(range_.LeftOperand)
                        } else {
                            default(GExpression?)
                        },
                        if range_.RightOperand != nil {
                            this.TranslateExpression(range_.RightOperand)
                        } else {
                            default(GExpression?)
                        }
                    )
                }
                case elementAccess is ElementAccessExpressionSyntax {
                    if elementAccess
                        .ArgumentList
                        .Arguments
                        .Count == 1 &&
                        elementAccess
                        .ArgumentList
                        .Arguments[0]
                        .Expression is RangeExpressionSyntax sliceRange {
                        // `span[a..b]` / `span[..n]` / `span[i..]`: gsc has its own
                        // native range-index operator (Issue #1896), so lower
                        // directly to that same `recv[start..end]` form instead
                        // of desugaring to `Slice`.
                        return this.TranslateRangeSlice(
                            this.TranslateReceiverWithNullForgiveness(elementAccess.Expression),
                            sliceRange
                        )
                    }
                    // Issue #1893: a multi-index access (`grid[r, c, ...]`) against
                    // a genuine multi-dim array (Rank > 1) needs every index — the
                    // single-index path below only ever reads argument 0.
                    if elementAccess
                        .ArgumentList
                        .Arguments
                        .Count > 1 &&
                        (this.context.GetTypeInfo(elementAccess.Expression).Type is IArrayTypeSymbol and {Rank: > 1}) {
                        return this.TranslateMultiDimElementAccess(elementAccess)
                    }
                    // Issue #1987: `list[i]` against a ref-returning indexer
                    // (`ref T this[int i]`) DECLARED IN THE TRANSLATED SOURCE
                    // (as opposed to a BCL type like `Span<T>`, whose
                    // ref-returning indexer gsc's binder already auto-
                    // dereferences via `BoundClrIndexExpression` +
                    // `AutoDereferenceRefReturn` — that shape is genuinely
                    // gap-free and must keep translating as-is).
                    //
                    // Issue #3879 (ADR-0060 amendment) closed the plain-`ref`
                    // half of this gap: G#'s indexer grammar now HAS a ref-return
                    // modifier (`prop this[i T] ref U -> lvalue`), the
                    // declaration site translates, and gsc's emitter loads
                    // through the returned managed pointer at the read — so a
                    // plain index expression is now the correct lowering, with
                    // the same read semantics C# gives it. Issue #4220 also
                    // preserves the readonly form at its declaration.
                    //
                    // Issue #4350: a multi-parameter user/CLR indexer
                    // (`slice[index, fromEnd]`) keeps EVERY argument, in source
                    // order; only the single-`int32` indexer shape is coerced.
                    let indexedReceiver GExpression? = this.TranslateReceiverWithNullForgiveness(
                        elementAccess.Expression
                    )
                    if elementAccess.ArgumentList.Arguments.Count > 1 {
                        return IndexExpression(
                            indexedReceiver,
                            this.TranslateIndexArguments(elementAccess.ArgumentList)
                        )
                    }
                    let index GExpression? = if elementAccess.ArgumentList.Arguments.Count > 0 {
                        this.CoerceIndexToInt32(
                            elementAccess,
                            this.TranslateIndexArgumentWithNullForgiveness(elementAccess.ArgumentList.Arguments[0])
                        )
                    } else {
                        cast[GExpression](IdentifierExpression("nil"))
                    }
                    return IndexExpression(indexedReceiver, index)
                }
                case simpleLambda is SimpleLambdaExpressionSyntax {
                    return this.TranslateLambda(simpleLambda)
                }
                case parenLambda is ParenthesizedLambdaExpressionSyntax {
                    return this.TranslateLambda(parenLambda)
                }
                case anonymousMethod is AnonymousMethodExpressionSyntax {
                    return this.TranslateLambda(anonymousMethod)
                }
                case awaitExpression is AwaitExpressionSyntax {
                    return AwaitExpression(this.TranslateExpression(awaitExpression.Expression))
                }
                case switchExpression is SwitchExpressionSyntax {
                    return this.TranslateSwitchExpression(switchExpression)
                }
                case conditional is ConditionalExpressionSyntax {
                    // ADR-0169 analyzer mode: the Roslyn location-picking
                    // ternary lowers to G#'s Symbol.Location.
                    if this.InAnalyzerApiMode && this.TryTranslateAnalyzerLocationsTernary(
                        conditional,
                        out var analyzerLocation
                    ) {
                        return analyzerLocation
                    }
                    // A C# ternary `cond ? a : b` maps to the canonical G#
                    // value-position `if` expression `if cond { a } else { b }`
                    // (ADR-0064, sample IfExpression.gs; ADR-0115 §B).
                    return this.TranslateConditionalExpression(conditional)
                }
                case query is QueryExpressionSyntax {
                    return this.TranslateQuery(query)
                }
                case implicitCreation is ImplicitObjectCreationExpressionSyntax {
                    return this.TranslateImplicitObjectCreation(implicitCreation)
                }
                case predefinedType is PredefinedTypeSyntax {
                    return this.TranslatePredefinedTypeExpression(predefinedType)
                }
                case conditionalAccess is ConditionalAccessExpressionSyntax {
                    // ADR-0169 analyzer mode: `namespaceSymbol?.ToDisplayString()`
                    // collapses to the receiver — G#'s ContainingNamespace is
                    // already the (nullable) display string.
                    if this.InAnalyzerApiMode && this.TryTranslateAnalyzerConditionalDisplay(
                        conditionalAccess,
                        out var analyzerDisplay
                    ) {
                        return analyzerDisplay
                    }
                    if this.TryTranslateNullConditionalStaticExtensionHelper(conditionalAccess, out var enumExtResult) {
                        return enumExtResult
                    }
                    if this.ContainsFunctionArgumentSpillSeam(conditionalAccess.WhenNotNull) {
                        return this.TranslateWithLocalAssignmentSeam(
                            conditionalAccess,
                            () -> this.TranslateConditionalAccessWithLocalAssignmentSeam(conditionalAccess)
                        )
                    }
                    if this.RequiresLocalAssignmentSeam(conditionalAccess.WhenNotNull) {
                        return this.TranslateConditionalAccessWithLocalAssignmentSeam(conditionalAccess)
                    }
                    if DependsOnEnclosingConditionalReceiver(conditionalAccess.Expression) &&
                        FindLeadingElementBinding(
                        conditionalAccess.WhenNotNull
                    ) is ElementBindingExpressionSyntax conditionalIndexBinding &&
                        !this
                        .ConditionalIndexReceiverIsNullable(conditionalAccess.Expression) {
                        return this.TranslateNonNullableConditionalIndex(
                            conditionalAccess.WhenNotNull,
                            conditionalIndexBinding,
                            this.TranslateExpression(conditionalAccess.Expression)
                        )
                    }
                    // Issue #3700: gsc's `?[i]` is a single postfix STEP whose
                    // result is `T?`, unlike `?.` — which swallows the whole
                    // continuation into its guarded branch. A C# `a?[i].B`
                    // therefore cannot be printed flat: gsc reads it as
                    // `(a?[i]).B` and rejects the dereference of a `T?`
                    // (GS0158 / GS0116). Re-split it at the index so the
                    // continuation hangs off a second `?` seam instead.
                    if TryFindConditionalIndexContinuation(conditionalAccess.WhenNotNull, out var chainedIndexBinding) {
                        return this.TranslateConditionalIndexWithContinuation(conditionalAccess, chainedIndexBinding)
                    }
                    return ConditionalAccessExpression(
                        this.TranslateExpression(conditionalAccess.Expression),
                        this.TranslateWithConditionalReceiver(conditionalAccess.WhenNotNull, nil)
                    )
                }
                case replacedBinding is ElementBindingExpressionSyntax when this
                    .state
                    .ConditionalElementBindingReplacements
                    .TryGetValue(replacedBinding, out var bindingReplacement) {
                    // Issue #3700: the index step is already the inner `?` seam's
                    // target; the rest of the chain reads the conditional receiver.
                    return bindingReplacement
                }
                case memberBinding is MemberBindingExpressionSyntax {
                    // Issue #1879: `word?.DoubledLength` binds to the same
                    // instance extension property as `word.DoubledLength`
                    // (lowered to a get-only receiver-clause `func`,
                    // ADR-0115 §B.19); the call-site rewrite `TranslateMemberAccess`
                    // applies to the plain form must also apply here, or the
                    // print emits a bare property-style access on a func member
                    // — a silent-wrong `?.` read.
                    let bindingMemberName = this.GetPatternMemberName(memberBinding.Name)
                    let emittedBindingMemberName string? = this.EmittedName(
                        this.GetPatternMemberSymbol(memberBinding),
                        bindingMemberName
                    )
                    if this.GetPatternMemberSymbol(memberBinding) is IPropertySymbol extBindingProperty &&
                        !extBindingProperty.IsStatic &&
                        TryGetExtensionBlockOwner(extBindingProperty, out _) {
                        return InvocationExpression(
                            MemberAccessExpression(
                                this.state.ConditionalReceiverReplacement ?? ConditionalReceiverExpression(),
                                emittedBindingMemberName
                            ),
                            List[GExpression](),
                            nil
                        )
                    }
                    // The `.b` continuation normally uses the empty conditional
                    // receiver; static-helper prefix rebuilding temporarily
                    // supplies the guarded receiver instead.
                    return MemberAccessExpression(
                        this.state.ConditionalReceiverReplacement ?? ConditionalReceiverExpression(),
                        emittedBindingMemberName
                    )
                }
                case elementBinding is ElementBindingExpressionSyntax {
                    let bindingReceiver = if this
                        .state
                        .ConditionalElementReceivers
                        .TryGetValue(elementBinding, out var elementReceiver) {
                        elementReceiver
                    } else {
                        this.state.ConditionalReceiverReplacement ?? ConditionalReceiverExpression()
                    }
                    if elementBinding
                        .ArgumentList
                        .Arguments
                        .Count == 1 &&
                        elementBinding
                        .ArgumentList
                        .Arguments[0]
                        .Expression is RangeExpressionSyntax conditionalRange {
                        return this.TranslateRangeSlice(bindingReceiver, conditionalRange)
                    }
                    if elementBinding.ArgumentList.Arguments.Count > 1 {
                        return IndexExpression(
                            bindingReceiver,
                            this.TranslateIndexArguments(elementBinding.ArgumentList)
                        )
                    }
                    let bindingIndex GExpression? = if elementBinding.ArgumentList.Arguments.Count > 0 {
                        this.TranslateIndexArgumentWithNullForgiveness(elementBinding.ArgumentList.Arguments[0])
                    } else {
                        cast[GExpression](IdentifierExpression("nil"))
                    }
                    return IndexExpression(bindingReceiver, bindingIndex)
                }
                case typeOf is TypeOfExpressionSyntax {
                    return TypeOfExpression(this.MapTypeOfOperand(typeOf.Type))
                }
                case explicitDefault is DefaultExpressionSyntax {
                    return DefaultValueExpression(this.MapTypeSyntax(explicitDefault.Type))
                }
                case isPattern is IsPatternExpressionSyntax {
                    return this.TranslateIsPattern(isPattern)
                }
                case arrayCreation is ArrayCreationExpressionSyntax {
                    return this.TranslateArrayCreation(arrayCreation)
                }
                case implicitArray is ImplicitArrayCreationExpressionSyntax {
                    return this.TranslateImplicitArrayCreation(implicitArray)
                }
                case initializer is InitializerExpressionSyntax {
                    return this.TranslateInitializerExpression(initializer)
                }
                case sizeOf is SizeOfExpressionSyntax {
                    return this.TranslateSizeOf(sizeOf)
                }
                case aliasQualified is AliasQualifiedNameSyntax {
                    if this.context.GetSymbolInfo(aliasQualified).Symbol is INamedTypeSymbol qualifiedType {
                        return TypeExpression(
                            this.typeMapper.Map(qualifiedType, this.context, aliasQualified.GetLocation())
                        )
                    }
                    // `global::System` → drop the `global::` alias and keep the namespace name.
                    return IdentifierExpression(this.EmittedName(aliasQualified.Name, aliasQualified.Name.Identifier))
                }
                case nestedAssignment is AssignmentExpressionSyntax {
                    // A value-position deconstruction assignment may already have
                    // been lowered into statements by its enclosing seam.
                    if this.state.SuppressedAssignments.Contains(nestedAssignment) {
                        // A property/indexer/non-trivial target cannot be read back:
                        // doing so can invoke a getter, fail for set-only storage, or
                        // re-evaluate its receiver/index. FlattenChainedAssignment
                        // captured the converted RHS before writing it; return that
                        // exact assignment result.
                        if this.state.AssignmentValues.TryGetValue(nestedAssignment, out var assignmentValue) {
                            return assignmentValue
                        }
                        // A deconstruction assignment (`(a, b) = ...`) has no
                        // single "target" to read back — LowerTupleAssignmentForValue
                        // already computed its value (a tuple of the assigned
                        // elements) when the write was hoisted; reuse it rather
                        // than trying to read `nestedAssignment.Left` (a tuple
                        // TARGET pattern, not a value expression) (issue #1974).
                        if nestedAssignment.Left is TupleExpressionSyntax leftTuplePattern &&
                            this
                            .state
                            .TupleAssignmentValues
                            .TryGetValue(leftTuplePattern, out var cachedTupleValue) {
                            return cachedTupleValue
                        }
                        var hoistedTarget GExpression? = this.TranslateExpression(nestedAssignment.Left)
                        // Issue #1907: `x ??= y` only runs its assignment when `x`
                        // was null, so reading `x` back afterward is exactly the
                        // non-null narrowing C# itself performs post-`??=` — needed
                        // when `x`'s own declared/promoted type is nullable but the
                        // read occurs where a non-null value is expected (e.g. a
                        // `field`-keyword getter returning a non-nullable property
                        // type from a nullable-promoted backing field).
                        if nestedAssignment.IsKind(SyntaxKind.CoalesceAssignmentExpression) {
                            hoistedTarget = NonNullAssertionExpression(hoistedTarget)
                        }
                        return hoistedTarget
                    }
                    // ADR-0161 / issue #3350: no enclosing seam claimed this node —
                    // it lives somewhere no statement can legally be hoisted to,
                    // the canonical case being a short-circuited `&&`/`||`/`??`
                    // operand, whose write must run only when that operand is
                    // evaluated. This used to fall back to the RHS alone, which
                    // SILENTLY DROPPED the write (issue #1723).
                    //
                    // G# assignment is a value-yielding expression, so the faithful
                    // translation is simply the assignment itself, emitted exactly
                    // where C# put it.
                    return this.TranslateAssignmentAsExpression(nestedAssignment)
                }
                case throwExpression is ThrowExpressionSyntax {
                    // `a ?? throw e`, `cond ? a : throw e`, a `switch` arm value.
                    // G# supports throw-as-expression natively (issue #1153);
                    // map it directly to a G# throw-expression.
                    return ThrowExpression(
                        this.TranslateExpression(throwExpression.Expression),
                        this.ResolveExpressionType(throwExpression)
                    )
                }
                case suppressNullable is PostfixUnaryExpressionSyntax when suppressNullable.IsKind(
                    SyntaxKind.SuppressNullableWarningExpression
                ) {
                    // C# erases `expr!`; G# checks `expr!!` at run time. Preserve
                    // the operand when its actual sink accepts nil, and use the
                    // checked G# spelling only where the sink still requires a
                    // non-null reference (ADR-0115 §B, issue #3775).
                    // A null literal is never forgivable: preserve `nil` so its
                    // target type accepts nullable sinks and rejects non-null ones.
                    if IsNullOrSuppressedNull(suppressNullable.Operand) {
                        return this.TranslateExpression(suppressNullable.Operand)
                    }
                    let suppressed GExpression? = this.TranslateExpression(suppressNullable.Operand)
                    let (suppressTargetType, suppressTargetSymbol) = this.FindNullForgivingTarget(suppressNullable)
                    return if this.GSharpExpressionIsStaticallyNonNull(suppressNullable.Operand, suppressed) ||
                        this.NullForgivingTargetAcceptsNil(suppressTargetType, suppressTargetSymbol) {
                        suppressed
                    } else {
                        this.ReportForgivenStoreBridge(
                            suppressNullable,
                            suppressed,
                            EnsureNonNullAssertion(suppressed),
                            suppressTargetSymbol
                        )
                    }
                }
                case postfixValue is PostfixUnaryExpressionSyntax when postfixValue.IsKind(
                    SyntaxKind.PostIncrementExpression
                ) ||
                    postfixValue
                    .IsKind(SyntaxKind.PostDecrementExpression) {
                    // A post-increment/decrement used in value position. When the
                    // enclosing statement seam already hoisted the mutation into a
                    // trailing statement, the node is suppressed here and reads as
                    // its pre-increment value (ADR-0115 §B).
                    if this.state.SuppressedPostfix.Contains(postfixValue) {
                        return this.TranslateExpression(postfixValue.Operand)
                    }
                    // gsc issue #1027: G# now models inc/dec as value-producing
                    // expressions, so a postfix in a position with no statement seam
                    // (e.g. inside a short-circuit `&&` condition) emits the faithful
                    // inline `x++` / `x--` form.
                    return IncrementDecrementExpression(
                        this.TranslateExpression(postfixValue.Operand),
                        postfixValue.OperatorToken.Text,
                        isPrefix: false
                    )
                }
                case stackAlloc is StackAllocArrayCreationExpressionSyntax {
                    return this.TranslateStackAlloc(stackAlloc)
                }
                case implicitStackAlloc is ImplicitStackAllocArrayCreationExpressionSyntax {
                    return this.TranslateImplicitStackAlloc(implicitStackAlloc)
                }
                case collectionExpression is CollectionExpressionSyntax {
                    return this.TranslateCollectionExpression(collectionExpression)
                }
                case fieldExpression is FieldExpressionSyntax {
                    return this.TranslateFieldExpression(fieldExpression)
                }
                default {
                    this.context.ReportUnsupported(
                        expression,
                        "expression '${expression!!.Kind()}' has no canonical G# form yet; emitted an identifier placeholder (ADR-0115 §B)."
                    )
                    return IdentifierExpression("nil")
                }
            }
        }

        private func TranslateConditionalAccessWithLocalAssignmentSeam(
            conditionalAccess ConditionalAccessExpressionSyntax
        ) GExpression {
            let receiver GExpression? = this.CaptureReceiverOnce(
                this.TranslateExpression(conditionalAccess.Expression),
                conditionalAccess.Expression,
                "a conditional-access expression here has no enclosing evaluation seam to capture its receiver once."
            )
            let previousReceiver GExpression? = this.state.ConditionalReceiverReplacement
            this.state.ConditionalReceiverReplacement = NonNullAssertionExpression(receiver)
            var whenNotNull GExpression
            try {
                whenNotNull = this.TranslateWithLocalAssignmentSeam(
                    conditionalAccess.WhenNotNull,
                    () -> this.TranslateExpression(conditionalAccess.WhenNotNull)!!
                )
            } finally {
                this.state.ConditionalReceiverReplacement = previousReceiver
            }
            let conditionalType ITypeSymbol? = this.context.GetTypeInfo(conditionalAccess).Type
            var nullableType GTypeReference? = this.typeMapper.Map(
                conditionalType,
                this.context,
                conditionalAccess.GetLocation()
            )
            if !nullableType!!.IsNullable {
                nullableType = MakeNullable(nullableType)
            }
            return ParenthesizedExpression(
                IfExpression(
                    BinaryExpression(receiver, "!=", LiteralExpression.Null()),
                    whenNotNull,
                    DefaultValueExpression(nullableType)
                )
            )
        }

        private func TranslateNonNullableConditionalIndex(
            continuation ExpressionSyntax,
            elementBinding ElementBindingExpressionSyntax,
            receiver GExpression?
        ) GExpression? {
            this.state.ConditionalElementReceivers.Add(elementBinding, receiver!!)
            try {
                return this.TranslateExpression(continuation)
            } finally {
                this.state.ConditionalElementReceivers.Remove(elementBinding)
            }
        }

        /// Issue #3700: emits `a?[i]?rest` for a C# `a?[i].rest`,
        /// giving the continuation its own guarded seam (see
        /// (cref:TryFindConditionalIndexContinuation)).
        /// @param conditionalAccess The C# conditional access.
        /// @param elementBinding Its leading `?[i]` binding.
        /// @returns The nested conditional-access form.
        private func TranslateConditionalIndexWithContinuation(
            conditionalAccess ConditionalAccessExpressionSyntax,
            elementBinding ElementBindingExpressionSyntax?
        ) GExpression {
            let receiver GExpression? = this.TranslateExpression(conditionalAccess.Expression)
            // Translate the index step first, while the binding still renders as
            // the index itself; it becomes the inner seam's target.
            let indexStep GExpression? = this.TranslateExpression(elementBinding)
            this.state.ConditionalElementBindingReplacements.Add(elementBinding!!, ConditionalReceiverExpression())
            var continuation GExpression?
            try {
                continuation = this.TranslateExpression(conditionalAccess.WhenNotNull)
            } finally {
                this.state.ConditionalElementBindingReplacements.Remove(elementBinding!!)
            }
            return ConditionalAccessExpression(receiver, ConditionalAccessExpression(indexStep, continuation))
        }

        private func ConditionalIndexReceiverIsNullable(receiver ExpressionSyntax) bool {
            let result = FindConditionalAccessResult(receiver)
            let resultTypeInfo = this.context.GetTypeInfo(result)
            let resultType ITypeSymbol? = resultTypeInfo.Type ?? resultTypeInfo.ConvertedType
            return FindLeadingElementBinding(receiver) != nil ||
                (
                resultType is INamedTypeSymbol namedResultType &&
                    namedResultType
                    .OriginalDefinition
                    .SpecialType == SpecialType.System_Nullable_T
            ) ||
                this.NullableReferenceValueMayBeNull(result) || this.ReceiverValueIsPromotedNullable(result) ||
                this.ReceiverIsNullableReferenceFieldOrProperty(result)
        }

        // A constant pattern whose expression is actually a bare/qualified TYPE
        // reference (Roslyn parses `is T`/`not T` after a pattern combinator as a
        // ConstantPattern over an identifier, since it cannot tell at parse time
        // that the identifier names a type). Such a pattern is a type test, not an
        // equality, so it must lower to `x is T` rather than `x == T`.
        private func IsTypeReferencePattern(expression ExpressionSyntax) bool -> this
            .context
            .GetSymbolInfo(expression)
            .Symbol is ITypeSymbol

        // Maps a pattern expression that refers to a TYPE to its G# type
        // reference. A bare type name parses as a TypeSyntax (IdentifierName /
        // generic / array), but a fully-qualified type name (`App.Auth.MfaChallenge`)
        // parses as a MemberAccessExpressionSyntax — which is NOT a TypeSyntax —
        // so it is mapped through its resolved type symbol instead (issue #2258).
        private func MapTypeReferenceExpression(expression ExpressionSyntax?) GTypeReference? {
            if expression is TypeSyntax typeSyntax {
                return this.MapTypeSyntax(typeSyntax)
            }
            let typeSymbol ITypeSymbol? = this.context.GetSymbolInfo(expression).Symbol as ITypeSymbol
            return if typeSymbol != nil {
                this.typeMapper.Map(typeSymbol, this.context, expression!!.GetLocation())
            } else {
                cast[GTypeReference](NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType))
            }
        }

        private func TranslateIsPattern(isPattern IsPatternExpressionSyntax) GExpression? {
            // ADR-0169 analyzer mode: the C# base-call detection idiom has no
            // direct G# counterpart (#3536).
            if this.InAnalyzerApiMode && this.TryTranslateAnalyzerBaseCallCheck(isPattern, out var analyzerBaseCall) {
                return analyzerBaseCall
            }
            // Issue #4173, I1/I1b/I4/I5: every null-conditional-access idiom
            // that hinges on `<scrutinee> is <Type>` — G# folds a?.b onto the
            // same node as a.b (and a?[i] onto a[i]), distinguished only by a
            // flag, and `<x>.WhenNotNull`/`<x>.Expression is <Type>` (a
            // CAE-typed x) have no direct G# counterpart at all.
            if this.InAnalyzerApiMode && this.TryTranslateAnalyzerNullConditionalTypeTest(
                isPattern.Expression,
                IsPatternTypeSyntax(isPattern.Pattern),
                if isPattern.Pattern is DeclarationPatternSyntax withPatternDesignation {
                    withPatternDesignation.Designation
                } else {
                    default(VariableDesignationSyntax?)
                },
                isPattern,
                out var analyzerNullConditionalTypeTest
            ) {
                return analyzerNullConditionalTypeTest
            }
            // ADR-0166 / issue #3409: a binding pattern whose designations G#
            // scopes natively is emitted verbatim (`x is T t && t.M`), keeping
            // the C# names and needing no spill or narrowing substitution.
            let nativeVariables GExpression? = this.TryTranslateNativePatternVariables(isPattern)
            if nativeVariables != nil {
                return nativeVariables
            }
            var receiver GExpression? = this.TranslateExpression(isPattern.Expression)
            let receiverType ITypeSymbol? = this.context.GetTypeInfo(isPattern.Expression).Type
            // ADR-0162 / issues #3347/#3424: G# evaluates a native boolean
            // pattern subject exactly once. Use that form when C# introduces no
            // pattern local and gsc cannot smart-cast the original scrutinee.
            // An implicit property/field can translate to a bare identifier, but
            // only bare locals and parameters are smart-castable (ADR-0069).
            // Issue #3555: a property subpattern whose VALUE is itself a
            // type-matching pattern with further subpatterns (`ContainingSymbol:
            // IMethodSymbol { MethodKind: … }`) cannot be guard-lowered even
            // over a smart-castable scrutinee — gsc narrows only the scrutinee
            // local, never member CHAINS, so the lowered
            // `x.Prop is T && x.Prop.M == …` fails GS0158 on the unnarrowed
            // second read. Such shapes must take the native pattern form.
            // Issue #4173 round 3: a CAE-mentioning pattern has no sound native
            // G# pattern form (its faithful rewrite is a PREDICATE, not a type
            // test) — TranslatePattern below builds a native GPattern, so a
            // CAE-mentioning pattern must be refused here too and fall through
            // to the final legacy boolean lowering (TranslatePatternTest),
            // where BuildTypeTestExpression's leaf hook handles it soundly.
            let requiresNativeDisjunctiveNarrowing = this.RequiresNativeDisjunctiveNarrowing(isPattern)
            if !PatternIntroducesBinding(isPattern.Pattern) && !this.PatternMentionsConditionalAccessType(
                isPattern.Pattern,
                out _
            ) &&
                (
                requiresNativeDisjunctiveNarrowing ||
                    (
                    !PatternReadsScrutineeAtMostOnce(isPattern.Pattern) && !this.IsSmartCastableScrutinee(
                        isPattern.Expression
                    )
                ) ||
                    PatternRequiresNestedTypeNarrowing(isPattern.Pattern) ||
                    this.PatternTestsMembersOfNullableMember(isPattern.Pattern)
            ) {
                let bindings = List[(Symbol ISymbol, Replacement GExpression)]()
                let guards = List[GExpression]()
                let outerBooleanPattern = this.state.TranslatingBooleanPattern
                this.state.TranslatingBooleanPattern = true
                var pattern GPattern?
                try {
                    pattern = this.TranslatePattern(
                        isPattern.Pattern,
                        receiver,
                        bindings,
                        HashSet[string](StringComparer.Ordinal),
                        guards
                    )
                } finally {
                    this.state.TranslatingBooleanPattern = outerBooleanPattern
                }
                if pattern != nil && bindings.Count == 0 && guards.Count == 0 {
                    return PatternTestExpression(receiver, pattern)
                }
            }
            // A pattern that binds a designation, or tests more than one
            // sub-pattern, reads the translated scrutinee more than once:
            // `BuildPatternNarrowingReplacement` substitutes it at every binder
            // reference, a recursive/property pattern re-embeds it per member
            // test, and `and`/`or`/parenthesized combinators re-embed it per
            // branch. A non-trivial scrutinee (anything beyond a bare
            // identifier/`this`/literal — e.g. a method call or a property read
            // with a side effect) must then be evaluated exactly once into a
            // local and reused, matching C# semantics (issue #1731). A pattern
            // that reads the scrutinee at most once (a bare type test, a
            // constant/relational pattern) is left untouched, avoiding an
            // unnecessary temp. Some shapes (a single escaping/non-smart-
            // castable declaration pattern over a reference type) are already
            // hoisted more precisely by <see cref="TryBuildPositiveGuardHoist"/>/
            // <see cref="TryBuildNegatedGuardHoist"/> before reaching here — for
            // those, `receiver` is already a bare local and this is a no-op.
            if !PatternReadsScrutineeAtMostOnce(isPattern.Pattern) {
                receiver = this.SpillOperand(receiver!!, isPattern.Expression)
            }
            let test = this.TranslatePatternTest(receiver, isPattern.Pattern, receiverType, isPattern.Expression)
            return this.MaterializeFallbackPatternBindings(isPattern, receiver, test)
        }

        // Issue #4356: true when a property subpattern reads a member whose
        // declared type is a nullable reference (or, in ADR-0169 analyzer mode,
        // whose G# analyzer-API counterpart is `T?` although Roslyn's is not)
        // more than once through a property pattern — nested (`{ P: { X: 0 } }`,
        // `{ P: not { X: 1 } }`) or extended (`{ P.X: 0 }`). C# reads `P` once and
        // tests every nested subpattern against that one value. Guard-lowering
        // cannot: it emits `o.P != nil && o.P!!.X == 0`, which reads `P` twice,
        // so a getter that is non-nil and then nil throws where C# matches
        // (and gsc never narrows the unstable second read anyway). G#'s native
        // property pattern evaluates each member once, like C#, so such
        // patterns take that form (see TranslateIsPattern). This is a
        // preference for the clearer output, not the correctness guarantee:
        // a shape the native form cannot express falls back to the lowering,
        // which binds a nested member once itself (TranslatePatternTest).
        private func PatternTestsMembersOfNullableMember(pattern PatternSyntax) bool {
            // Only shapes whose native G# spelling is exact: a property
            // pattern, optionally negated or parenthesized. Anything else
            // (a positional nested pattern, a combinator) stays on the
            // lowering, which binds the member once itself.
            let IsNativePropertyPatternShape = func (nested PatternSyntax) bool {
                if nested is UnaryPatternSyntax unary {
                    return IsNativePropertyPatternShape(unary.Pattern)
                }
                if nested is ParenthesizedPatternSyntax parenthesized {
                    return IsNativePropertyPatternShape(parenthesized.Pattern)
                }
                return nested is RecursivePatternSyntax recursive &&
                    recursive.PositionalPatternClause == nil &&
                    recursive.PropertyPatternClause != nil &&
                    recursive.PropertyPatternClause!!
                    .Subpatterns
                    .Count > 0
            }
            let IsNullableReference = func (type ITypeSymbol?) bool {
                return type != nil &&
                    type.IsReferenceType == true &&
                    type.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated
            }
            switch pattern {
                case recursive is RecursivePatternSyntax {
                    for subpattern in recursive
                        .PropertyPatternClause
                        ?.Subpatterns ??
                        default(SeparatedSyntaxList[SubpatternSyntax]) {
                        if subpattern.NameColon != nil &&
                            IsNativePropertyPatternShape(subpattern.Pattern) &&
                            (
                            IsNullableReference(this.TryGetSubpatternMemberType(subpattern)) ||
                                this.IsGSharpNullableAnalyzerApiMember(
                                this.GetPatternMemberSymbol(subpattern.NameColon!!.Name)
                            )
                        ) {
                            return true
                        }
                        if subpattern.ExpressionColon?.Expression is MemberAccessExpressionSyntax path {
                            for var link ExpressionSyntax? = path.Expression;
                                link != nil;
                                link = (link as MemberAccessExpressionSyntax)
                                ?.Expression {
                                if IsNullableReference(
                                    this.ResolveDeclaredReceiverType(this.context.GetTypeInfo(link).Type, link)
                                ) ||
                                    this.IsGSharpNullableAnalyzerApiMember(this.context.GetSymbolInfo(link).Symbol) {
                                    return true
                                }
                            }
                        }
                        if this.PatternTestsMembersOfNullableMember(subpattern.Pattern) {
                            return true
                        }
                    }
                    for subpattern in recursive
                        .PositionalPatternClause
                        ?.Subpatterns ??
                        default(SeparatedSyntaxList[SubpatternSyntax]) {
                        if this.PatternTestsMembersOfNullableMember(subpattern.Pattern) {
                            return true
                        }
                    }
                    return false
                }
                case unary is UnaryPatternSyntax {
                    return this.PatternTestsMembersOfNullableMember(unary.Pattern)
                }
                case binary is BinaryPatternSyntax {
                    return this.PatternTestsMembersOfNullableMember(binary.Left) ||
                        this.PatternTestsMembersOfNullableMember(binary.Right)
                }
                case parenthesized is ParenthesizedPatternSyntax {
                    return this.PatternTestsMembersOfNullableMember(parenthesized.Pattern)
                }
                default {
                    return false
                }
            }
        }

        private func MaterializeFallbackPatternBindings(
            isPattern IsPatternExpressionSyntax,
            receiver GExpression?,
            test GExpression
        ) GExpression {
            // Reassigned binders need real writable locals. Bindings whose
            // scrutinee moved into a short-circuit block need the same treatment
            // so later conjuncts and selected branches do not reference a
            // block-local spill.
            let crossesShortCircuitBoundary = this.state.ShortCircuitSpillDeclarations != nil
            let materializedBinders = this
                .EnumeratePatternBinders(isPattern.Pattern)
                .Where((binder ILocalSymbol) -> crossesShortCircuitBoundary || this.IsLocalReassigned(binder))
                .ToList()
            if materializedBinders.Count == 0 {
                return test
            }
            let declarations List[GStatement]? = this
                .state
                .ShortCircuitSpillDeclarations ??
                this
                .state
                .PendingSpillPrologue
            if declarations == nil {
                this.context.ReportUnsupported(
                    isPattern,
                    "a fallback pattern binder requiring materialized storage reached an expression without a declaration seam (issue #3419)."
                )
                return test
            }
            StripTopLevelNegation(isPattern.Pattern, out var negated)
            let assignments = List[GStatement](materializedBinders.Count)
            for binder in materializedBinders {
                if !this.state.PatternBindings.TryGetValue(binder, out var replacement) {
                    this.context.ReportUnsupported(
                        isPattern.Pattern,
                        "fallback pattern binder '${binder.Name}' has no translated matched-value expression for materialized storage (issue #3419)."
                    )
                    continue
                }
                if negated {
                    replacement = this.BuildNegatedPatternBindingValue(binder, receiver, isPattern.Expression)
                }
                var storageType GTypeReference? = this.typeMapper.Map(
                    binder.Type,
                    this.context,
                    isPattern.Pattern.GetLocation()
                )
                if binder.Type.IsReferenceType {
                    storageType = MakeNullable(storageType)
                }
                let name string? = this.EmittedName(binder, binder.Name)
                let local = IdentifierExpression(name)
                declarations.Add(LocalDeclarationStatement(BindingKind.Var, name, storageType))
                assignments.Add(AssignmentStatement(local, replacement))
                this
                    .state
                    .PatternBindings[binder] = if binder
                    .Type
                    .IsReferenceType &&
                    binder.NullableAnnotation != Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated {
                    cast[GExpression](NonNullAssertionExpression(local))
                } else {
                    cast[GExpression](local)
                }
            }
            if assignments.Count == 0 {
                return test
            }
            return BinaryExpression(
                test,
                if negated {
                    "||"
                } else {
                    "&&"
                },
                BlockExpression(assignments, LiteralExpression.Bool(!negated))
            )
        }

        private func BuildNegatedPatternBindingValue(
            binder ILocalSymbol,
            receiver GExpression?,
            receiverSyntax ExpressionSyntax
        ) GExpression {
            let targetType GTypeReference? = this.typeMapper.Map(
                binder.Type,
                this.context,
                receiverSyntax.GetLocation()
            )
            if binder.Type.IsValueType {
                let receiverType ITypeSymbol? = this.context.GetTypeInfo(receiverSyntax).Type
                if receiverType is INamedTypeSymbol nullableReceiver &&
                    nullableReceiver
                    .OriginalDefinition
                    .SpecialType == SpecialType.System_Nullable_T &&
                    nullableReceiver
                    .TypeArguments
                    .Length == 1 &&
                    SymbolEqualityComparer
                    .Default
                    .Equals(nullableReceiver.TypeArguments[0], binder.Type) {
                    return NonNullAssertionExpression(receiver)
                }
                return if targetType is NamedTypeReference namedTarget {
                    cast[GExpression](
                        InvocationExpression(
                            IdentifierExpression(namedTarget.Name),
                            []GExpression{receiver!!},
                            namedTarget.TypeArguments
                        )
                    )
                } else {
                    cast[GExpression](NonNullAssertionExpression(receiver))
                }
            }
            return NonNullAssertionExpression(
                ParenthesizedExpression(BinaryExpression(receiver, "as", TypeExpression(targetType)))
            )
        }

        /// Issue #4356: whether the boolean lowering of [`pattern`](paramref)
        /// over a NULLABLE nested member embeds that member more than once — a
        /// type test, a `!= nil` guard, and one read per property/positional
        /// subpattern each read it, and a designation re-reads it wherever it is
        /// used. That is the shape where a re-read is not merely redundant but
        /// wrong: the first read is what the nil test (or type test) proved,
        /// and a later read that yields nil throws where C# matches or falls
        /// through. A single subpattern over a member that needs no guard reads
        /// it once and needs no local.
        ///
        /// A NON-nullable member re-read (`expr.Kind == A || expr.Kind == B`
        /// for `{ Kind: A or B }`) is left as it was: it cannot fail a nil
        /// test it never had, the self-migration inventory keeps the synthesized
        /// temporaries it would add retired (Issue3347RemainingSpillInventoryTests),
        /// and it is a pre-existing readability tradeoff outside #4356.
        /// @param pattern The nested pattern.
        /// @param receiverType The receiver's declared C# type, if known.
        /// @param receiver The translated receiver (for the analyzer-mode registry).
        /// @returns True when a single-evaluation local is needed.
        private func LoweredPatternReadsReceiverMoreThanOnce(
            pattern PatternSyntax?,
            receiverType ITypeSymbol?,
            receiver GExpression?
        ) bool {
            let gsharpNullable = this.IsGSharpNullablePatternReceiver(receiver)
            let CountReads = func (current PatternSyntax?) int32 {
                switch current {
                    case recursive is RecursivePatternSyntax {
                        if recursive.Designation is SingleVariableDesignationSyntax {
                            return 2
                        }
                        let guarded = recursive.Type == nil &&
                            (gsharpNullable || receiverType != nil) &&
                            (
                            gsharpNullable ||
                                (
                                receiverType!!.IsReferenceType &&
                                    receiverType!!.NullableAnnotation == Microsoft
                                    .CodeAnalysis
                                    .NullableAnnotation
                                    .Annotated
                            ) ||
                                receiverType!!
                                .OriginalDefinition
                                ?.SpecialType == SpecialType.System_Nullable_T
                        )
                        return (
                            if recursive.Type != nil {
                                1
                            } else {
                                0
                            }
                        ) +
                            (
                            if guarded {
                                1
                            } else {
                                0
                            }
                        ) +
                            (recursive.PropertyPatternClause?.Subpatterns.Count ?? 0) +
                            (recursive.PositionalPatternClause?.Subpatterns.Count ?? 0)
                    }
                    case unary is UnaryPatternSyntax {
                        return CountReads(unary.Pattern)
                    }
                    case parenthesized is ParenthesizedPatternSyntax {
                        return CountReads(parenthesized.Pattern)
                    }
                    case binary is BinaryPatternSyntax {
                        return CountReads(binary.Left) + CountReads(binary.Right)
                    }
                    default {
                        return if PatternReadsScrutineeAtMostOnce(current) {
                            1
                        } else {
                            2
                        }
                    }
                }
            }
            let nullableMember = gsharpNullable ||
                (
                receiverType != nil &&
                    (
                    (
                        receiverType.IsReferenceType &&
                            receiverType.NullableAnnotation == Microsoft
                            .CodeAnalysis
                            .NullableAnnotation
                            .Annotated
                    ) ||
                        receiverType
                        .OriginalDefinition
                        ?.SpecialType == SpecialType.System_Nullable_T
                )
            )
            return nullableMember && CountReads(pattern) > 1
        }

        /// Issue #4356: THE test for whether an extended-property-path link is
        /// nullable in the emitted G# — a Roslyn-annotated nullable reference, a
        /// `Nullable<T>` value, or a member that is `T?` only on
        /// the ADR-0169 analyzer API. Every lowering that walks such a path
        /// (the `is`-expression lowering and the typed switch arm) asks
        /// this one predicate, so a link cannot be nullable to one and not the
        /// other.
        /// @param declaredType The link's declared C# type.
        /// @param link The link's syntax.
        /// @returns True when the link needs a nil guard and a single read.
        private func IsNullablePatternLink(declaredType ITypeSymbol?, link ExpressionSyntax) bool -> (
            declaredType != nil &&
                declaredType.IsReferenceType == true &&
                declaredType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated
        ) ||
            IsNullableValueType(declaredType) ||
            this.IsGSharpNullableAnalyzerApiMember(this.context.GetSymbolInfo(link).Symbol)

        /// Issue #4356: the declared type of a property/field a pattern slot reads
        /// (a property subpattern's member, or a positional slot's matching
        /// member), registering [`memberAccess`](paramref) as a G#-nullable
        /// receiver when the ADR-0169 analyzer map makes it `T?`. Every
        /// nested-member entry point passes this type to TranslatePatternTest, so
        /// the read-once classifier always knows the slot's nullability.
        /// @param member The slot's member symbol, if bound.
        /// @param memberAccess The translated member read.
        /// @returns The member's declared type, or null.
        private func RegisterPatternMemberSlot(member ISymbol?, memberAccess GExpression) ITypeSymbol? {
            if this.IsGSharpNullableAnalyzerApiMember(member) {
                this.state.GSharpNullablePatternReceivers.Add(memberAccess)
            }
            return switch member {
                case property is IPropertySymbol: property.Type
                case field is IFieldSymbol: field.Type
                default: default(ITypeSymbol?)
            }
        }

        /// Issue #4356: whether a pattern-lowering receiver's EMITTED G# type is a
        /// nullable reference although its Roslyn type is not (an ADR-0169
        /// analyzer-API member such as `ParameterSyntax.Identifier`, or a
        /// local bound to one). See
        /// `DocumentTranslationState.GSharpNullablePatternReceivers`.
        /// @param receiver The translated receiver.
        /// @returns True when the receiver is `T?` in G#.
        private func IsGSharpNullablePatternReceiver(receiver GExpression?) bool -> receiver != nil &&
            this
            .state
            .GSharpNullablePatternReceivers
            .Contains(receiver)

        /// Issue #4356: binds a nested pattern member to a `let` local once,
        /// inside the test that reads it, and translates that test over the local.
        /// @param member The member value, e.g. `o.P`.
        /// @param test Builds the test over the bound local.
        /// @returns `{ let t = member; test(t) }`.
        private func BindPatternMemberOnce(member GExpression?, test(GExpression) -> GExpression) GExpression {
            let temp = this.NewSpillName()
            let local = IdentifierExpression(temp)
            if this.IsGSharpNullablePatternReceiver(member) {
                this.state.GSharpNullablePatternReceivers.Add(local)
            }
            return BlockExpression(
                List[GStatement]{LocalDeclarationStatement(BindingKind.Let, temp, type: nil, initializer: member)},
                test(local)
            )
        }

        /// Issue #4356: as (cref:BindPatternMemberOnce), for a nested
        /// pattern that declares a designation: the local is a `var` declared
        /// in [`declarations`](paramref) (so a binder that refers to it stays
        /// in scope after the test) and assigned inside the test.
        /// @param member The member value, e.g. `o.P`.
        /// @param memberType The member's C# type.
        /// @param gsharpNullable Whether the member is `T?` only on the G# analyzer API.
        /// @param declarations The enclosing declaration seam.
        /// @param test Builds the test over the stored local.
        /// @returns `{ t = member; test(t) }`.
        private func StorePatternMemberOnce(
            member GExpression?,
            memberType ITypeSymbol,
            gsharpNullable bool,
            declarations List[GStatement],
            test(GExpression) -> GExpression
        ) GExpression {
            var storageType GTypeReference? = this.typeMapper.Map(memberType, this.context, location: nil)
            if memberType.IsReferenceType || gsharpNullable {
                storageType = MakeNullable(storageType)
            }
            let temp = this.NewSpillName()
            let local = IdentifierExpression(temp)
            this.state.StoredPatternCaptures.Add(local)
            if gsharpNullable {
                this.state.GSharpNullablePatternReceivers.Add(local)
            }
            declarations.Add(LocalDeclarationStatement(BindingKind.Var, temp, storageType))
            return BlockExpression(List[GStatement]{AssignmentStatement(local, member)}, test(local))
        }

        private func TranslatePatternTest(
            receiver GExpression?,
            pattern PatternSyntax?,
            receiverType ITypeSymbol? = nil,
            receiverSyntax ExpressionSyntax? = nil,
            isNestedPatternMember bool = false
        ) GExpression {
            // Issue #4356: C# evaluates a subpattern's member ONCE and tests
            // every nested subpattern against that one value; for a NULLABLE
            // member (see LoweredPatternReadsReceiverMoreThanOnce) a re-read can
            // be nil after the first read was proved non-nil. TranslateIsPattern
            // applies that rule to the top-level scrutinee (it spills a
            // non-trivial one into a local when the pattern reads it more than
            // once); this is the same rule for a NESTED member (`o.P` in
            // `{ P: { X: 0 } }`, `{ P: (0, 0) }`, `{ P: not { X: 1 } }`, a list
            // element), which the lowering below would otherwise re-embed in a
            // `!= nil` guard and in every member test — reading an unstable
            // getter twice, where a value that is non-nil and then nil throws.
            // The local is bound INSIDE the test (`{ let t = o.P; t != nil &&
            // t.X == 0 }`), never in the statement prologue, so it is evaluated
            // only after the enclosing guard has proved `o` non-nil; and a `let`
            // local is smart-cast by that guard, so no `!!` is needed.
            // A pattern that declares a designation needs its binder's
            // replacement visible OUTSIDE the test, so its local is a `var`
            // declared in the enclosing declaration seam and only ASSIGNED
            // inside the test (`{ t = o.P; t != nil && t.X == 0 }`) — same
            // single read, same evaluation order. In ADR-0169 analyzer mode a
            // member whose G# counterpart is `T?` but whose Roslyn type is a
            // struct counts as nullable here too (GSharpNullablePatternReceivers).
            if isNestedPatternMember && !IsTrivialOperand(receiver!!) && this.LoweredPatternReadsReceiverMoreThanOnce(
                pattern,
                receiverType,
                receiver
            ) {
                let test(GExpression) -> GExpression = (local GExpression) -> this.TranslatePatternTest(
                    local,
                    pattern,
                    receiverType,
                    receiverSyntax,
                    isNestedPatternMember
                )
                if !PatternIntroducesBinding(pattern) {
                    return this.BindPatternMemberOnce(receiver, test)
                }
                let declarations List[GStatement]? = this
                    .state
                    .ShortCircuitSpillDeclarations ??
                    this
                    .state
                    .PendingSpillPrologue
                if declarations != nil && receiverType != nil && receiverType.TypeKind != TypeKind.Error {
                    return this.StorePatternMemberOnce(
                        receiver,
                        receiverType,
                        this.IsGSharpNullablePatternReceiver(receiver),
                        declarations,
                        test
                    )
                }
            }
            switch pattern {
                case paramsNull is ConstantPatternSyntax when paramsNull.Expression.IsKind(
                    SyntaxKind.NullLiteralExpression
                ) &&
                    this
                    .IsParamsArrayOperand(receiverSyntax) {
                    // ADR-0159 / issue #3501: `args is null` where `args` is a
                    // C# `params` array. A G# variadic parameter always
                    // materializes an array, so the compare is statically
                    // decided and gsc reports GS0523 — fold it the same way the
                    // `args == null` spelling is folded (see
                    // TryFoldParamsArrayNullCheck).
                    return LiteralExpression.Bool(false)
                }
                case constant is ConstantPatternSyntax when constant.Expression.IsKind(
                    SyntaxKind.NullLiteralExpression
                ) {
                    // `x is null` → `x == nil`.
                    return BinaryExpression(receiver, "==", LiteralExpression.Null())
                }
                case constant is ConstantPatternSyntax when this.IsTypeReferencePattern(constant.Expression) {
                    // Roslyn parses `x is T` where `T` is a bare type name after a
                    // combinator (e.g. `is Frame child and not EmptyFrame`) as a
                    // ConstantPattern over an identifier — but the identifier binds
                    // to a TYPE, so it is a type test, not an equality. `x is T`.
                    return this.BuildTypeTestExpression(receiver, constant.Expression, constant)
                }
                case constant is ConstantPatternSyntax when receiverType?.SpecialType == SpecialType.System_Object {
                    // Issue #3501: an `object?`-typed receiver (`token.Value is
                    // true`) has no `==` against the constant's type (GS0129),
                    // but gsc binds the constant PATTERN over object natively —
                    // keep the `is` form.
                    return BinaryExpression(receiver, "is", this.TranslateExpression(constant.Expression))
                }
                case constant is ConstantPatternSyntax {
                    // `x is 0` / `x is "moov"` / `x is true`. G# `is` only tests a
                    // type, so a constant pattern lowers to an equality test
                    // (ADR-0115 §B). A numeric literal is retyped to the receiver's
                    // type so `uint8? is 11` → `b == (11 as uint8?)` (G# has no
                    // implicit numeric promotion: a bare `b == 11` is GS0129).
                    return BinaryExpression(
                        receiver,
                        "==",
                        this.CoercePatternConstant(
                            constant.Expression,
                            this.TranslateExpression(constant.Expression),
                            receiverType
                        )
                    )
                }
                case relational is RelationalPatternSyntax {
                    // `x is > 0` → `x > 0` (with the same numeric retyping).
                    return BinaryExpression(
                        receiver,
                        relational.OperatorToken.Text,
                        this.CoercePatternConstant(
                            relational.Expression,
                            this.TranslateExpression(relational.Expression),
                            receiverType
                        )
                    )
                }
                case declaration is DeclarationPatternSyntax {
                    // `x is T t` → the boolean test `x is T`; the binder `t` is a
                    // Kotlin-style smart cast of `x` inside the guarded block, so
                    // references to `t` are rewritten to the narrowed `x` (ADR-0069).
                    if declaration.Designation is SingleVariableDesignationSyntax single &&
                        this
                        .context
                        .GetDeclaredSymbol(single) is {} boundSymbol {
                        if this.IsConditionalAccessAnalyzerType(declaration.Type) {
                            // Issue #4173 round 3, §4.2(d): a CAE designator can
                            // only reach here at top level, under top-level `not`,
                            // or under `and` (GS0390 / CS8780 forbid it elsewhere)
                            // — bind by SUBSTITUTION (re-evaluating the receiver at
                            // each use), the same convention I4/I5 already use.
                            this
                                .state
                                .PatternBindings[boundSymbol] = NonNullAssertionExpression(
                                this.InvokeNullConditionalChain("AsNullConditionalHop", receiver)
                            )
                        } else if this.IsPlainAccessAnalyzerType(declaration.Type, out var sharedGsNodeName) {
                            // A shared-node analyzer type (e.g.
                            // MemberAccessExpressionSyntax -> AccessorExpressionSyntax)
                            // must narrow to the mapped G# node explicitly — the
                            // smart-castable branch of BuildPatternNarrowingReplacement
                            // would otherwise bind `t` to the bare, un-narrowed
                            // receiver, relying on gsc's own flow-narrowing of the
                            // now-SUFFIXED type test to have proven `t`'s type.
                            this.state.PatternBindings[boundSymbol] = NarrowToType(receiver, sharedGsNodeName)
                        } else {
                            this.state.PatternBindings[boundSymbol] = this.BuildPatternNarrowingReplacement(
                                receiver,
                                receiverSyntax,
                                declaration.Type
                            )!!
                        }
                    }
                    return this.BuildTypeTestExpression(receiver, declaration.Type, declaration)
                }
                case typePattern is TypePatternSyntax {
                    // `x is T` (no binder) → boolean test `x is T`.
                    return this.BuildTypeTestExpression(receiver, typePattern.Type, typePattern)
                }
                case recursive is RecursivePatternSyntax {
                    return this.TranslateRecursivePatternTest(
                        receiver,
                        recursive,
                        receiverSyntax,
                        receiverType,
                        isNestedPatternMember
                    )
                }
                case DiscardPatternSyntax {
                    // `_` always matches and binds nothing (reached as the leaf of
                    // an extended property path whose links still need guarding,
                    // issue #4356).
                    return LiteralExpression.Bool(true)
                }
                case varPattern is VarPatternSyntax {
                    // `x is var v` ALWAYS matches (it also matches `null`, unlike a
                    // type/declaration pattern), so it lowers to the literal `true`
                    // test; `v` binds directly to the receiver — no non-null
                    // narrowing, since (unlike `x is T t`) a `var` pattern never
                    // requires non-null (issue #1888).
                    if varPattern.Designation is SingleVariableDesignationSyntax varSingle &&
                        this
                        .context
                        .GetDeclaredSymbol(varSingle) is {} varBound {
                        this.state.PatternBindings[varBound] = receiver!!
                        this.RegisterProjectedPatternBinding(varBound, receiverType)
                    } else if varPattern.Designation is ParenthesizedVariableDesignationSyntax {
                        // `var (a, b)` binds the deconstructed elements; G# has no
                        // canonical form for that, so keep the loud gap rather than
                        // silently emit a bindingless match (issue #1888). `var _`
                        // (discard designation) correctly stays a bindingless always-true.
                        this.context.ReportUnsupported(
                            varPattern,
                            "var pattern with tuple designation ('var (a, b)') has no canonical G# form yet (ADR-0115 §B)."
                        )
                    }
                    return LiteralExpression.Bool(true)
                }
                case unary is UnaryPatternSyntax when unary.IsKind(SyntaxKind.NotPattern) {
                    return this.TranslateNotPatternTest(
                        receiver,
                        unary.Pattern,
                        receiverType,
                        receiverSyntax,
                        isNestedPatternMember
                    )
                }
                case binaryPattern is BinaryPatternSyntax when binaryPattern.OperatorToken.IsKind(
                    SyntaxKind.OrKeyword
                ) ||
                    binaryPattern
                    .OperatorToken
                    .IsKind(SyntaxKind.AndKeyword) {
                    // `x is 11 or 12` → `x == 11 || x == 12`;
                    // `x is A and B` → `(x is A) && (x is B)`.
                    let isOr = binaryPattern.OperatorToken.IsKind(SyntaxKind.OrKeyword)
                    return BinaryExpression(
                        this.TranslatePatternTest(
                            receiver,
                            binaryPattern.Left,
                            receiverType,
                            receiverSyntax,
                            isNestedPatternMember
                        ),
                        if isOr {
                            "||"
                        } else {
                            "&&"
                        },
                        this.TranslatePatternTest(
                            receiver,
                            binaryPattern.Right,
                            receiverType,
                            receiverSyntax,
                            isNestedPatternMember
                        )
                    )
                }
                case parenthesized is ParenthesizedPatternSyntax {
                    return ParenthesizedExpression(
                        this.TranslatePatternTest(
                            receiver,
                            parenthesized.Pattern,
                            receiverType,
                            receiverSyntax,
                            isNestedPatternMember
                        )
                    )
                }
                case listPattern is ListPatternSyntax {
                    let projectedListReceiver ITypeSymbol? = if receiverSyntax == nil {
                        default(ITypeSymbol?)
                    } else {
                        this.GetManagedReferenceArrayProjectedExpressionType(receiverSyntax)
                    }
                    return this.TranslateListPatternTest(
                        receiver,
                        listPattern,
                        projectedListReceiver ?? receiverType,
                        isNestedPatternMember
                    )
                }
                default {
                    this.context.ReportUnsupported(
                        pattern,
                        "is-pattern '${pattern!!.Kind()}' has no canonical G# form yet (ADR-0115 §B)."
                    )
                    return BinaryExpression(receiver, "!=", LiteralExpression.Null())
                }
            }
        }

        // Issue #1889: G#'s `is` operator only tests a type (ADR-0115 §B), so —
        // same as the recursive/positional-pattern branches above — a list
        // pattern lowers to a hand-composed boolean: a length test (exact when
        // there is no slice, a minimum when there is) ANDed with a per-element
        // test against the element read at that position. An element before the
        // (at most one) slice reads forward from the start; an element after it
        // reads backward from the end (gsc has no negative array index, so
        // `Length - distanceFromEnd` spells that out). A discard element
        // contributes no test, matching the positional-pattern discard carve-out.
        private func TranslateListPatternTest(
            receiver GExpression?,
            listPattern ListPatternSyntax,
            receiverType ITypeSymbol?,
            isNestedPatternMember bool = false
        ) GExpression {
            var receiver = receiver
            let elements = listPattern.Patterns
            let sliceIndex = FindSlicePatternIndex(elements)
            let elementType ITypeSymbol? = this.GetListPatternElementType(listPattern, receiverType)
            // Issue #4356: the nil guard below tests `receiver`; every read under
            // it goes through `receiver!!` when it is a stored `var` capture,
            // whose element bindings are materialized outside the guard.
            let guardedReceiver GExpression? = receiver
            receiver = if this.state.StoredPatternCaptures.Contains(receiver!!) {
                cast[GExpression](NonNullAssertionExpression(receiver))
            } else {
                receiver
            }
            let lengthAccess = MemberAccessExpression(receiver, "Length")
            var test GExpression = if sliceIndex < 0 {
                BinaryExpression(lengthAccess, "==", LiteralExpression.Int(elements.Count.ToString()))
            } else {
                BinaryExpression(lengthAccess, ">=", LiteralExpression.Int((elements.Count - 1).ToString()))
            }
            for var i = 0; i < elements.Count; i++ {
                let element = elements[i]
                if element is SlicePatternSyntax slice {
                    let sliceTest GExpression? = this.TranslateSlicePatternTest(
                        receiver,
                        slice,
                        i,
                        elements.Count - i - 1,
                        receiverType,
                        isNestedPatternMember
                    )
                    if sliceTest != nil {
                        test = BinaryExpression(test, "&&", sliceTest)
                    }
                    continue
                }
                if element is DiscardPatternSyntax {
                    continue
                }
                let elementReceiver = this.BuildListElementReceiver(
                    receiver,
                    lengthAccess,
                    i,
                    elements.Count,
                    sliceIndex
                )
                let elementTest = this.TranslatePatternTest(
                    elementReceiver,
                    element,
                    elementType,
                    isNestedPatternMember: isNestedPatternMember
                )
                test = BinaryExpression(test, "&&", elementTest)
            }
            // Issue #4356: a list pattern never matches nil, and a NESTED member
            // tested with one (`{ P: [1] }`, `P` an `int[]?`) arrives here bound
            // to a `let` local that is `T?` in G#. Guard it first: the guard both
            // makes the pattern fall through on nil, as C# does, and smart-casts
            // the local for the `.Length` / index reads.
            if isNestedPatternMember &&
                (
                this.IsGSharpNullablePatternReceiver(guardedReceiver) ||
                    (
                    receiverType != nil &&
                        receiverType.IsReferenceType == true &&
                        receiverType.NullableAnnotation == Microsoft
                        .CodeAnalysis
                        .NullableAnnotation
                        .Annotated
                )
            ) {
                test = BinaryExpression(BinaryExpression(guardedReceiver, "!=", LiteralExpression.Null()), "&&", test)
            }
            return test
        }

        private func GetListPatternElementType(listPattern ListPatternSyntax, receiverType ITypeSymbol?) ITypeSymbol? {
            if this.context.SemanticModel.GetOperation(listPattern) is IListPatternOperation listOperation {
                var indexer ISymbol? = listOperation.IndexerSymbol
                if receiverType is INamedTypeSymbol projectedReceiver && indexer != nil {
                    indexer = this.GetProjectedMember(projectedReceiver, indexer) ?? indexer
                }
                let indexedElement ITypeSymbol? = switch indexer {
                    case property is IPropertySymbol: property.Type
                    case method is IMethodSymbol: method.ReturnType
                    default: default(ITypeSymbol?)
                }
                if indexedElement != nil {
                    return indexedElement
                }
            }
            return GetEnumerableElementType(receiverType)
        }

        // Issue #1889: a slice ("rest") subpattern either captures the middle
        // slice (`.. var rest`/`.. T rest`, a binder — registered as a
        // patternBindings substitution, same mechanism as a top-level `var`/
        // declaration pattern) or tests it against a nested subpattern (`..[>
        // 0]`, recursed against the materialized slice value); a bare `..`
        // contributes neither. Returns `null` when there is no additional
        // boolean test to AND in (a bare discard slice, or a successful bind).
        private func TranslateSlicePatternTest(
            receiver GExpression?,
            slice SlicePatternSyntax,
            prefixCount int32,
            suffixCount int32,
            receiverType ITypeSymbol?,
            isNestedPatternMember bool = false
        ) GExpression? {
            switch slice.Pattern {
                case nil {
                    return nil
                }
                case VarPatternSyntax{Designation: SingleVariableDesignationSyntax variable} when this
                    .context
                    .GetDeclaredSymbol(variable) is {} boundSymbol {
                    this.state.PatternBindings[boundSymbol] = BuildSliceExpression(receiver, prefixCount, suffixCount)
                    this.RegisterProjectedPatternBinding(
                        boundSymbol,
                        this.GetProjectedSlicePatternType(
                            slice,
                            receiverType,
                            (receiverType as IArrayTypeSymbol)?.ElementType
                        )
                    )
                    return nil
                }
                case varPatternSyntax is VarPatternSyntax when varPatternSyntax.Designation is DiscardDesignationSyntax {
                    return nil
                }
                case varTuple is VarPatternSyntax when varTuple.Designation is ParenthesizedVariableDesignationSyntax {
                    this.context.ReportUnsupported(
                        varTuple,
                        "var pattern with tuple designation ('var (a, b)') has no canonical G# form yet (ADR-0115 §B)."
                    )
                    return nil
                }
                case DeclarationPatternSyntax{Designation: SingleVariableDesignationSyntax declVariable} when this
                    .context
                    .GetDeclaredSymbol(declVariable) is {} declBoundSymbol {
                    // A typed slice capture (`.. T rest`) can only ever narrow to
                    // the slice's own `[]T` type, so the (redundant) type check is
                    // dropped — same bind-only treatment as the `var` capture above.
                    this
                        .state
                        .PatternBindings[declBoundSymbol] = BuildSliceExpression(receiver, prefixCount, suffixCount)
                    this.RegisterProjectedPatternBinding(
                        declBoundSymbol,
                        this.GetProjectedSlicePatternType(
                            slice,
                            receiverType,
                            (receiverType as IArrayTypeSymbol)?.ElementType
                        )
                    )
                    return nil
                }
                default {
                    let nestedSliceType ITypeSymbol? = this.GetProjectedSlicePatternType(
                        slice,
                        receiverType,
                        (receiverType as IArrayTypeSymbol)?.ElementType
                    ) ??
                        receiverType
                    // A nested subpattern tested against the middle slice (e.g.
                    // `.. { Length: 0 }`, `.. [1, 2]`) — recurse the normal
                    // boolean-test lowering against the materialized slice value.
                    return this.TranslatePatternTest(
                        BuildSliceExpression(receiver, prefixCount, suffixCount),
                        slice.Pattern,
                        nestedSliceType,
                        isNestedPatternMember: isNestedPatternMember
                    )
                }
            }
        }

        // Issue #1889: the index of an element read forward from the start (no
        // slice yet seen, or before it) vs. backward from the end (past it) —
        // shared by the boolean-test and G#-pattern lowering paths.
        private func BuildListElementReceiver(
            receiver GExpression?,
            lengthAccess GExpression,
            index int32,
            elementCount int32,
            sliceIndex int32
        ) GExpression {
            if sliceIndex < 0 || index < sliceIndex {
                return IndexExpression(receiver, LiteralExpression.Int(index.ToString()))
            }
            return IndexExpression(
                receiver,
                BinaryExpression(lengthAccess, "-", LiteralExpression.Int((elementCount - index).ToString()))
            )
        }

        private func TranslateNotPatternTest(
            receiver GExpression?,
            inner PatternSyntax,
            receiverType ITypeSymbol? = nil,
            receiverSyntax ExpressionSyntax? = nil,
            isNestedPatternMember bool = false
        ) GExpression {
            switch inner {
                case paramsNull is ConstantPatternSyntax when paramsNull.Expression.IsKind(
                    SyntaxKind.NullLiteralExpression
                ) &&
                    this
                    .IsParamsArrayOperand(receiverSyntax) {
                    // ADR-0159 / issue #3501: `args is not null` on a C#
                    // `params` array — always true for a G# variadic, which
                    // materializes an array; the `!= nil` spelling would be
                    // GS0523 (see TryFoldParamsArrayNullCheck).
                    return LiteralExpression.Bool(true)
                }
                case constant is ConstantPatternSyntax when constant.Expression.IsKind(
                    SyntaxKind.NullLiteralExpression
                ) {
                    // `x is not null` → `x != nil`.
                    return BinaryExpression(receiver, "!=", LiteralExpression.Null())
                }
                case constant is ConstantPatternSyntax when this.IsTypeReferencePattern(constant.Expression) {
                    // `x is not T` where Roslyn parsed `T` as a ConstantPattern
                    // identifier that binds to a TYPE → `!(x is T)`.
                    return UnaryExpression(
                        "!",
                        ParenthesizedExpression(this.BuildTypeTestExpression(receiver, constant.Expression, constant))
                    )
                }
                case constant is ConstantPatternSyntax {
                    // `x is not 6` → `x != 6` (with numeric retyping to the receiver).
                    return BinaryExpression(
                        receiver,
                        "!=",
                        this.CoercePatternConstant(
                            constant.Expression,
                            this.TranslateExpression(constant.Expression),
                            receiverType
                        )
                    )
                }
                case RecursivePatternSyntax{Type: nil} emptyRecursive when(
                    emptyRecursive.PropertyPatternClause is nil or {Subpatterns: {Count: 0}}
                ) {
                    // `x is not { } d` → `x == nil`; the designator `d` is the
                    // non-null view (used on the matched side), bound to `x`.
                    BindPatternDesignation(emptyRecursive.Designation, receiver)
                    return BinaryExpression(receiver, "==", LiteralExpression.Null())
                }
                case typePattern is TypePatternSyntax {
                    // `x is not T` → `!(x is T)`.
                    return UnaryExpression(
                        "!",
                        ParenthesizedExpression(this.BuildTypeTestExpression(receiver, typePattern.Type, typePattern))
                    )
                }
                case declaration is DeclarationPatternSyntax {
                    // `x is not T t` → `!(x is T)`; `t` is the non-null `T` view,
                    // bound to `x` for use on the matched side.
                    if this.IsConditionalAccessAnalyzerType(declaration.Type) {
                        // Issue #4173 round 3, §4.2(d): bind by SUBSTITUTION, same
                        // as TranslatePatternTest's DeclarationPatternSyntax case.
                        BindPatternDesignation(
                            declaration.Designation,
                            NonNullAssertionExpression(
                                this.InvokeNullConditionalChain("AsNullConditionalHop", receiver)
                            )
                        )
                    } else if this.IsPlainAccessAnalyzerType(declaration.Type, out var sharedGsNodeName) {
                        BindPatternDesignation(declaration.Designation, NarrowToType(receiver, sharedGsNodeName))
                    } else {
                        BindPatternDesignation(declaration.Designation, receiver)
                    }
                    return UnaryExpression(
                        "!",
                        ParenthesizedExpression(this.BuildTypeTestExpression(receiver, declaration.Type, declaration))
                    )
                }
                default {
                    // General negation: `!( <inner test> )`.
                    return UnaryExpression(
                        "!",
                        ParenthesizedExpression(
                            this.TranslatePatternTest(
                                receiver,
                                inner,
                                receiverType,
                                receiverSyntax,
                                isNestedPatternMember
                            )
                        )
                    )
                }
            }
        }

        // Retypes a constant/relational pattern's literal operand to the receiver's
        // numeric type so the lowered `==`/`!=`/`<`… comparison type-checks. G# has
        // no implicit numeric promotion, so `uint8? is 11` lowered to `b == 11`
        // (where `11` is `int32`) is GS0129; coercing the literal yields the
        // accepted `b == (11 as uint8?)`. Mirrors the constant branch of
        // <see cref="TranslateBinaryExpression"/>. Non-numeric receivers/literals
        // (string/enum/type tests) are left untouched.
        private func CoercePatternConstant(
            constantSyntax ExpressionSyntax,
            constant GExpression?,
            receiverType ITypeSymbol?
        ) GExpression? {
            if receiverType == nil {
                return constant
            }
            let constantType ITypeSymbol? = this.context.GetTypeInfo(constantSyntax).Type
            if TryGetNumericKind(receiverType, out var receiverUnderlying) &&
                TryGetNumericKind(constantType, out var constantUnderlying) &&
                receiverUnderlying != constantUnderlying &&
                this
                .context
                .SemanticModel
                .GetConstantValue(constantSyntax)
                .HasValue {
                return this.CoerceOperandTo(constant, receiverType, constantSyntax.GetLocation())
            }
            return constant
        }

        private func TranslateRecursivePatternTest(
            receiver GExpression?,
            recursive RecursivePatternSyntax,
            receiverSyntax ExpressionSyntax? = nil,
            receiverType ITypeSymbol? = nil,
            isNestedPatternMember bool = false
        ) GExpression {
            // Bind the designator (`is { } x`, `is Circle c`) to the narrowed
            // receiver so later references read the matched value (ADR-0069 smart
            // cast). `is { } x` narrows away only nullability; `is Circle c`
            // additionally downcasts.
            if recursive.Designation is SingleVariableDesignationSyntax recVar && this.context.GetDeclaredSymbol(
                recVar
            ) is {} recBound {
                // Issue #4173 round 3 (adversarial-review follow-up): a
                // designated `T { }`/`T { ... }` recursive pattern over one of
                // the three shared-node analyzer types reaches this SAME
                // binding hazard as DeclarationPatternSyntax's designator
                // above — BuildPatternNarrowingReplacement's smart-castable
                // branch returns the bare, un-narrowed receiver (relying on
                // flow-narrowing from a TEST expression this type never
                // narrows, since the CAE/plain-access test is a predicate/
                // suffixed-pattern test over a DIFFERENT expression than the
                // designator's own declared type), and its fallback branch
                // calls MapTypeSyntax directly — bypassing the discriminator
                // entirely, mirrored from the same call site this round
                // already fixed for DeclarationPatternSyntax.
                if this.IsConditionalAccessAnalyzerType(recursive.Type) {
                    this
                        .state
                        .PatternBindings[recBound] = NonNullAssertionExpression(
                        this.InvokeNullConditionalChain("AsNullConditionalHop", receiver)
                    )
                } else if this.IsPlainAccessAnalyzerType(recursive.Type, out var sharedGsNodeName) {
                    this.state.PatternBindings[recBound] = NarrowToType(receiver, sharedGsNodeName)
                } else {
                    this.state.PatternBindings[recBound] = this.BuildPatternNarrowingReplacement(
                        receiver,
                        receiverSyntax,
                        recursive.Type
                    )!!
                }
            }
            // A bare recursive pattern with no type prefix (`{ A: 0 }`, `(0, 0)`)
            // starts the test with a null check on `receiver` — correct when
            // `receiver` is a reference type (the common case, e.g. a nullable
            // record), but a tuple or struct positional pattern (issue #1887,
            // `(int, int)`) is a VALUE type: it can never be null, and gsc
            // rejects `!= nil` against one. Skip the null check for a value-type
            // receiver; the member-access sub-tests below are the whole test
            // (and if there happen to be none, e.g. every position is a discard,
            // `true` is the correct always-matches result).
            let patternOperation IOperation? = this.context.SemanticModel.GetOperation(recursive)
            var receiverIsValueType = recursive.Type == nil &&
                patternOperation is IRecursivePatternOperation &&
                patternOperation
                .MatchedType
                .IsValueType == true
            // Issue #1943: a NULLABLE value-type receiver (`(int, int)?`)
            // narrows to the SAME non-nullable `MatchedType` a non-nullable
            // value-type receiver (`(int, int)`) does, so the check above can't
            // tell the two apart — but unlike the non-nullable case, it CAN be
            // null at runtime; skipping its guard the same way would let a null
            // subject fault the member-access chain below (`p.Item1` on a null
            // `p`). `IPatternOperation.InputType` (the pattern's UN-narrowed
            // input type, unlike `MatchedType`) still reports the original
            // `System.Nullable<T>`, so it reliably distinguishes the two shapes
            // regardless of the corpus's nullable-annotations context (the same
            // concern `ResolveDeclaredReceiverType` documents below for a
            // reference-type receiver). G# models a value-type `T?` directly
            // (no `Nullable<T>` member surface, see
            // <see cref="TranslateMemberAccess"/>'s `Value`/`HasValue` rewrite)
            // and relies on the same Kotlin-style smart-cast a reference-type
            // receiver does, so the guard is the same `!= nil` test.
            var receiverIsNullableValueType = recursive.Type == nil &&
                patternOperation is IPatternOperation recursiveOperation &&
                recursiveOperation
                .InputType
                ?.OriginalDefinition
                .SpecialType == SpecialType.System_Nullable_T
            // Issue #4315: a bare recursive pattern ALWAYS tests its subject for
            // null, nested or not (`{ Address: { } }` is false when `Address` is
            // null). Issue #1923 once skipped the guard for a nested member whose
            // declared type is a non-nullable reference, on the premise that gsc
            // rejects `!= nil` against one (GS0129). That premise is stale:
            // `== nil` / `!= nil` is legal on every reference-shaped operand
            // (BoundBinaryOperator.IsNullCompare); GS0129 is reserved for an
            // imported METHOD-call result with explicit non-null metadata, which a
            // pattern member access never is. The skip was also unsound: a
            // declared-non-null member is null at run time whenever it was never
            // assigned, came from oblivious code or was `null!`-initialized, so
            // dropping the guard threw a NullReferenceException (or matched
            // `{ }`) where C# yields false. The only reference receiver still
            // exempt is a `params` array below (GS0523).
            var receiverIsNonNullableReference = false
            // ADR-0159 / issue #3501: a C# `params` array subject
            // (`args is { Length: > 0 }`) can be null in C# but a G# variadic
            // always materializes an array — gsc rejects the defensive
            // `!= nil` guard outright (GS0523), so skip it even though this is
            // a top-level subject.
            if recursive.Type == nil &&
                receiverSyntax != nil &&
                (this.context.GetSymbolInfo(receiverSyntax).Symbol is IParameterSymbol and {IsParams: true}) {
                receiverIsNonNullableReference = true
            }
            // Issue #4356: an analyzer-API member whose G# type is `T?` although
            // Roslyn's is a struct (or non-null) is guarded like any nullable
            // reference — the Roslyn-derived classification above cannot see it.
            if this.IsGSharpNullablePatternReceiver(receiver) {
                receiverIsValueType = false
                receiverIsNullableValueType = false
                receiverIsNonNullableReference = false
            }
            var test GExpression? = if recursive.Type != nil {
                this.BuildTypeTestExpression(receiver, recursive.Type, recursive)
            } else {
                cast[GExpression](
                    if ((receiverIsValueType && !receiverIsNullableValueType) || receiverIsNonNullableReference) {
                        default(BinaryExpression?)
                    } else {
                        BinaryExpression(receiver, "!=", LiteralExpression.Null())
                    }
                )
            }
            // Issue #1943/#1545: gsc's `&&`/`||` short-circuit narrowing
            // classifier (`SmartCastStability.TryClassifyNilGuardLeaf`,
            // `referenceNullableOnly: true`) deliberately rejects a nullable
            // VALUE type — narrowing `Nullable<T>` to `T` is not an IL no-op
            // the way narrowing a nullable reference is, and the short-circuit
            // path doesn't emit the unwrap (a separately-tracked gsc-side
            // gap). So `candidate != nil && candidate.Item1 == 0` does NOT
            // smart-cast `candidate` inside the `&&` chain and fails to
            // compile (GS0158, "Cannot find member Item1"). The member
            // accesses below must instead force-unwrap explicitly (`candidate
            // !! .Item1`, the same `!!` rewrite <see cref="TranslateMemberAccess"/>
            // already uses for a C# `Nullable<T>.Value` read) — safe here
            // because `test`'s own `!= nil` guard already proved it non-null
            // at runtime.
            var memberReceiver GExpression? = if receiverIsNullableValueType {
                cast[GExpression](NonNullAssertionExpression(receiver))
            } else {
                receiver
            }
            // Issue #4356: the same holds for a nested subpattern member over a
            // nullable REFERENCE (`{ DeclaringType: { IsInterface: true } }`)
            // when the receiver is still a member-access chain rather than a
            // local. That happens only when the nested pattern declares a
            // designation: otherwise TranslatePatternTest has already bound the
            // member to a `let` local once, which the guard smart-casts (and
            // TranslateIsPattern usually routes the whole pattern to G#'s native
            // property pattern first, see PatternTestsMembersOfNullableMember).
            // For a designation-bearing nested pattern the member is still read
            // by the guard and again by each member test — the pre-existing
            // fallback shape, kept so its binder stays visible. gsc narrows such a chain after `!= nil`
            // only when every link is stable (SmartCastStability: a `let`
            // field, or a non-virtual get-only auto-property); an imported
            // `MethodInfo.DeclaringType` is neither, so
            // `c.DeclaringType != nil && c.DeclaringType.IsInterface` bound
            // only through gsc's old member-lookup carve-out for stated-nullable
            // chains. The `!!` is safe for the same reason as above — the guard
            // just proved the receiver non-nil — and where gsc DID narrow the
            // chain it reports the assertion redundant (GS0536), which the
            // polish pass strips.
            if test is BinaryExpression &&
                test.Operator == "!=" &&
                recursive.Type == nil &&
                !receiverIsValueType &&
                isNestedPatternMember &&
                (!(receiver is IdentifierExpression) || this.state.StoredPatternCaptures.Contains(receiver)) {
                // A stored `var` capture (StorePatternMemberOnce) is read by
                // descendant bindings AFTER the test, outside the guard that
                // narrows it, so its reads below the guard assert too.
                memberReceiver = EnsureNonNullAssertion(receiver)
            }
            // The typed form of the same hazard (`Outer(Inner(var a, _))`): a
            // stored capture's type test narrows it only inside the test
            // block, but a descendant binding reads it after the test, so
            // member reads go through the narrowed `(t as Inner)!!`.
            if recursive.Type != nil && isNestedPatternMember && this.state.StoredPatternCaptures.Contains(receiver!!) {
                memberReceiver = this.BuildPatternNarrowingReplacement(receiver, receiverSyntax: nil, recursive.Type)
            }
            if recursive.PropertyPatternClause != nil {
                for sub in recursive.PropertyPatternClause!!.Subpatterns {
                    if sub.NameColon == nil && sub.ExpressionColon == nil {
                        this.context.ReportUnsupported(
                            sub,
                            "positional subpattern has no canonical G# form yet (ADR-0115 §B)."
                        )
                        continue
                    }
                    var memberTest GExpression
                    if sub.NameColon != nil {
                        let memberName string? = this.GetSubpatternMemberName(sub)
                        let subpatternMember ISymbol? = this.GetPatternMemberSymbol(sub.NameColon!!.Name)
                        let memberAccess GExpression = MemberAccessExpression(
                            memberReceiver,
                            this.EmittedName(subpatternMember, memberName)
                        )
                        if this.IsGSharpNullableAnalyzerApiMember(subpatternMember) {
                            this.state.GSharpNullablePatternReceivers.Add(memberAccess)
                        }
                        let memberType ITypeSymbol? = this.TryGetSubpatternMemberType(sub)
                        memberTest = this.TranslatePatternTest(
                            memberAccess,
                            sub.Pattern,
                            memberType,
                            isNestedPatternMember: true
                        )
                    } else {
                        // Issue #1971: an extended subpattern (`Start.X: 0`)
                        // dotted chain needs a per-intermediate nullable-guard,
                        // not a single flat member access — see
                        // <see cref="TranslateExtendedPropertyMemberTest"/>.
                        memberTest = this.TranslateExtendedPropertyMemberTest(
                            sub.ExpressionColon!!.Expression,
                            sub.Pattern,
                            memberReceiver
                        )
                    }
                    test = if test == nil {
                        memberTest
                    } else {
                        cast[GExpression](BinaryExpression(test, "&&", memberTest))
                    }
                }
            }
            if recursive.PositionalPatternClause != nil {
                // Issue #1887: `x is (0, 0)` / `x is Point(0, 0)` deconstructs `x`
                // positionally. G# has no positional-pattern syntax, but a
                // positional subpattern against a tuple or a record's
                // (compiler-synthesized) `Deconstruct` reads exactly the same
                // members a property pattern would — `Item1`/`Item2` for a tuple,
                // the matching property for a record — so it lowers to the same
                // nested member-access test a property subpattern uses.
                let subs = recursive.PositionalPatternClause!!.Subpatterns
                let positional PositionalSlots? = this.TryGetPositionalMembers(
                    recursive,
                    subs.Count,
                    out var positionalFailure
                )
                let projectedReceiverType ITypeSymbol? = if receiverSyntax == nil {
                    default(ITypeSymbol?)
                } else {
                    this.GetManagedReferenceArrayProjectedExpressionType(receiverSyntax)
                }
                var positionalLookupType ITypeSymbol? = if recursive.Type != nil {
                    this.context.GetTypeInfo(recursive.Type).Type
                } else {
                    projectedReceiverType ?? receiverType
                }
                if (projectedReceiverType ?? receiverType) is INamedTypeSymbol projectedReceiver &&
                    positionalLookupType is INamedTypeSymbol positionalType {
                    positionalLookupType = ReceiverTypeHierarchy(projectedReceiver).FirstOrDefault(
                        (candidate INamedTypeSymbol) -> SymbolEqualityComparer.Default.Equals(
                            candidate.OriginalDefinition,
                            positionalType.OriginalDefinition
                        )
                    ) ??
                        positionalLookupType
                }
                for var i = 0; i < subs.Count; i++ {
                    let sub = subs[i]
                    if sub.Pattern is DiscardPatternSyntax {
                        // A discard position (`(0, _)`) imposes no constraint —
                        // same as an omitted field in a property pattern — so it
                        // contributes no test at all.
                        continue
                    }
                    if !this.TryResolvePositionalSlot(
                        sub,
                        i,
                        positional,
                        positionalFailure,
                        positionalLookupType,
                        out var memberName,
                        out var memberSymbol,
                        out var slotFailure
                    ) {
                        this.context.ReportUnsupported(
                            sub,
                            PositionalSubpatternGapMessage("positional subpattern", slotFailure)
                        )
                        continue
                    }
                    let memberAccess GExpression = MemberAccessExpression(
                        memberReceiver,
                        this.EmittedName(memberSymbol, memberName)
                    )
                    // Issue #4356: the slot's type lets a nested test over a
                    // NULLABLE slot guard it and read it once, as C#'s single
                    // Deconstruct call does (TranslatePatternTest), exactly as
                    // the property-subpattern loop above passes its member type.
                    let declaredSlotType ITypeSymbol? = this.RegisterPatternMemberSlot(memberSymbol, memberAccess)
                    let slotType ITypeSymbol? = this.GetProjectedPatternMemberType(
                        positionalLookupType,
                        memberSymbol
                    ) ??
                        declaredSlotType
                    let memberTest = this.TranslatePatternTest(
                        memberAccess,
                        sub.Pattern,
                        slotType,
                        isNestedPatternMember: true
                    )
                    test = if test == nil {
                        memberTest
                    } else {
                        cast[GExpression](BinaryExpression(test, "&&", memberTest))
                    }
                }
            }
            // Every position was a discard (`(_, _)`) against a value-type
            // receiver: no null check applies and no member test was emitted, so
            // the pattern always matches.
            return (test ?? LiteralExpression.Bool(true))
        }

        // Issue #1923: prefers the DECLARED symbol type bound to
        // <paramref name="receiverSyntax"/> (an `ILocalSymbol`/`IParameterSymbol`/
        // `IPropertySymbol`/`IFieldSymbol`'s own `.Type`) over
        // <paramref name="receiverType"/> when available, falling back to
        // <paramref name="receiverType"/> itself otherwise (e.g. a synthesized
        // member-access receiver whose type already came from a declared
        // property/field symbol). Mirrors <see cref="IsNullableInitializer"/>'s
        // "declared annotation survives a disabled nullable context" fallback:
        // `receiverType`, when sourced from `GetTypeInfo(expr).Type` (Roslyn's
        // flow-sensitive converted type), reports `NullableAnnotation.None` for
        // a `T?` local/parameter once the corpus compiles with nullable
        // annotations disabled, which would make a genuinely nullable receiver
        // look non-nullable.
        private func ResolveDeclaredReceiverType(
            receiverType ITypeSymbol?,
            receiverSyntax ExpressionSyntax?
        ) ITypeSymbol? {
            if receiverSyntax == nil {
                return receiverType
            }
            let symbol ISymbol? = this.context.GetSymbolInfo(receiverSyntax).Symbol
            return switch symbol {
                case l is ILocalSymbol: l.Type
                case p is IParameterSymbol: p.Type
                case pr is IPropertySymbol: pr.Type
                case f is IFieldSymbol: f.Type
                default: receiverType
            }
        }

        // Issue #1923: resolves the DECLARED C# type of a named property-pattern
        // subpattern's member (`sub.NameColon.Name`, e.g. `Address` in
        // `{ Address: { City: "Lima" } }`), so a NESTED bare recursive pattern
        // can tell whether its receiver is a non-nullable reference type — and
        // therefore whether the `!= nil` guard `TranslateRecursivePatternTest`
        // would otherwise emit is even legal in G#'s stricter null model.
        // Returns null for an expression-colon subpattern (`sub.ExpressionColon`)
        // or when the identifier does not bind to a property/field, in which
        // case the caller conservatively falls back to emitting the guard.
        private func TryGetSubpatternMemberType(sub SubpatternSyntax) ITypeSymbol? {
            if sub.NameColon == nil {
                return nil
            }
            let symbol ISymbol? = this.context.SemanticModel.GetSymbolInfo(sub.NameColon!!.Name).Symbol
            return switch symbol {
                case p is IPropertySymbol: p.Type
                case f is IFieldSymbol: f.Type
                default: default(ITypeSymbol?)
            }
        }

        private func GetSubpatternMemberName(sub SubpatternSyntax) string? {
            return if sub.NameColon == nil {
                default(string?)
            } else {
                this.GetPatternMemberName(sub.NameColon!!.Name)
            }
        }

        private func GetPatternMemberName(name SimpleNameSyntax) string {
            if this
                .context
                .SemanticModel
                .GetSymbolInfo(name)
                .Symbol is IFieldSymbol{ContainingType: {IsTupleType: true}} tupleField {
                return (tupleField.CorrespondingTupleField ?? tupleField).Name
            }
            return name.Identifier.ValueText
        }

        private func GetPatternMemberSymbol(node SyntaxNode?) ISymbol? {
            let symbol ISymbol? = this.context.GetSymbolInfo(node).Symbol
            return if symbol is IFieldSymbol{ContainingType: {IsTupleType: true}} tupleField {
                cast[ISymbol](tupleField.CorrespondingTupleField ?? tupleField)
            } else {
                symbol
            }
        }

        // Splits an extended property subpattern's dotted member path
        // (`Start.X`, `A.B.C`, ...) into its leaf-to-root identifier chain
        // (`["Start", "X"]`, `["A", "B", "C"]`), using each bound member's
        // allocated emitted name. Shared by the
        // is-form guard builder (<see cref="TranslateExtendedPropertyMemberTest"/>)
        // and the switch-arm nested-field builder (<see cref="ExtendedPropertyFieldTree"/>).
        private func SplitMemberPath(memberPath ExpressionSyntax) List[string] {
            let names = List[string]()
            var current = memberPath
            while current is MemberAccessExpressionSyntax memberAccess {
                names.Insert(
                    0,
                    this.EmittedName(
                        this.GetPatternMemberSymbol(memberAccess),
                        this.GetPatternMemberName(memberAccess.Name)
                    )!!
                )
                current = memberAccess.Expression
            }
            let rootName string? = if current is SimpleNameSyntax simpleName {
                this.EmittedName(this.GetPatternMemberSymbol(simpleName), this.GetPatternMemberName(simpleName))
            } else {
                current.ToString()
            }
            names.Insert(0, rootName!!)
            return names
        }

        // Issue #1971 (follow-up to #1891/#1969): a C# extended property
        // subpattern (`Start.X: 0`) implicitly null-checks every intermediate
        // member of the dotted chain — `null` at any step means the whole
        // pattern doesn't match (no throw), mirroring how a nested recursive
        // pattern (`{ Start: { X: 0 } }`) against a nullable-typed field is
        // bound (see `PatternBinder.BindPropertyPattern`'s issue #1923 comment,
        // and the corresponding null guard `MethodBodyEmitter.EmitPropertyPattern`
        // emits for a `NullableTypeSymbol` subject). The is-form lowering
        // previously flattened the whole path into a single raw member-access
        // chain (`recv.Start.X == 0`) with no such guard: G#'s non-null-by-default
        // type contract means a raw `ldfld` on a null intermediate NREs instead of
        // falling through like C# does. This walks the chain once, building the
        // nested member access AND an `!= nil` guard for each intermediate step
        // whose DECLARED type is a nullable reference (a non-nullable
        // intermediate keeps the guard-free raw access — G#'s own non-null
        // contract already guarantees it, so no guard is needed there).
        private func TranslateExtendedPropertyMemberTest(
            memberPath ExpressionSyntax,
            leafPattern PatternSyntax,
            receiver GExpression?
        ) GExpression {
            let names = SplitMemberPath(memberPath)
            // `intermediateExprs[i]` is the sub-expression whose runtime value
            // is used as the receiver for the access producing `names[i + 1]`
            // (e.g. for `Start.X`, `intermediateExprs[0]` is the `Start`
            // sub-expression — its declared nullability decides whether a
            // guard is needed before reading `.X`). Walked positionally from
            // the outermost `MemberAccessExpressionSyntax` inward, so it lines
            // up with `names` regardless of repeated identifiers in the chain.
            let intermediateExprs = [names.Count - 1]ExpressionSyntax
            var current = memberPath
            var pos = names.Count - 1
            while current is MemberAccessExpressionSyntax memberAccess {
                pos--
                intermediateExprs[pos] = memberAccess.Expression
                current = memberAccess.Expression
            }
            return this.TranslateExtendedPropertyLink(names, intermediateExprs, 0, receiver, memberPath, leafPattern)
        }

        // Issue #4356: one link of an extended property path. A nullable
        // intermediate is read ONCE, into a `let` local bound inside the test
        // (`{ let t = s.Start; t != nil && t.X == 0 }`): the `!= nil` guard and
        // the next link then read the same value, as C# does, and the guard
        // smart-casts the local so the next link needs no `!!`. Re-reading the
        // member (`s.Start != nil && s.Start.X == 0`) evaluated an unstable
        // getter twice and bound only through gsc's old member-lookup carve-out.
        private func TranslateExtendedPropertyLink(
            names List[string],
            intermediateExprs[]ExpressionSyntax,
            index int32,
            memberReceiver GExpression?,
            memberPath ExpressionSyntax,
            leafPattern PatternSyntax
        ) GExpression {
            if index == names.Count - 1 {
                let finalMemberAccess GExpression = MemberAccessExpression(memberReceiver, names[index])
                if this.IsGSharpNullableAnalyzerApiMember(this.context.GetSymbolInfo(memberPath).Symbol) {
                    this.state.GSharpNullablePatternReceivers.Add(finalMemberAccess)
                }
                let leafType ITypeSymbol? = this.context.GetTypeInfo(memberPath).Type
                return this.TranslatePatternTest(finalMemberAccess, leafPattern, leafType, isNestedPatternMember: true)
            }
            let link GExpression = MemberAccessExpression(memberReceiver, names[index])
            let declaredType ITypeSymbol? = this.ResolveDeclaredReceiverType(
                this.context.GetTypeInfo(intermediateExprs[index]).Type,
                intermediateExprs[index]
            )
            // The emitted G# type decides, not Roslyn's: an analyzer-API link
            // such as `Identifier` (a Roslyn struct) is `SyntaxToken?` in G#.
            let gsharpNullableLink = this.IsGSharpNullableAnalyzerApiMember(
                this.context.GetSymbolInfo(intermediateExprs[index]).Symbol
            )
            // A `Nullable<T>` value link (`P` in `P.X` for a `Point?` P) is
            // nullable too. gsc's `&&` guard narrows a nullable REFERENCE local
            // but not a nullable VALUE one (unwrapping `Nullable<T>` is a real
            // conversion, #1943), so the next link reads it through `!!` —
            // safe, the guard just proved it has a value.
            let nullableValueLink = IsNullableValueType(declaredType)
            if this.IsNullablePatternLink(declaredType, intermediateExprs[index]) {
                if gsharpNullableLink {
                    this.state.GSharpNullablePatternReceivers.Add(link)
                }
                let rest(GExpression) -> GExpression = (local GExpression) -> BinaryExpression(
                    BinaryExpression(local, "!=", LiteralExpression.Null()),
                    "&&",
                    this.TranslateExtendedPropertyLink(
                        names,
                        intermediateExprs,
                        index + 1,
                        if nullableValueLink {
                            cast[GExpression](NonNullAssertionExpression(local))
                        } else {
                            local
                        },
                        memberPath,
                        leafPattern
                    )
                )
                // A leaf that declares a designation (`Identifier.Text: var t`)
                // leaves its binder's replacement reading through this local
                // after the test, so the local must outlive the block: a `var`
                // declared in the enclosing seam, assigned in the test.
                let declarations List[GStatement]? = this
                    .state
                    .ShortCircuitSpillDeclarations ??
                    this
                    .state
                    .PendingSpillPrologue
                if PatternIntroducesBinding(leafPattern) && declarations != nil && declaredType != nil {
                    // The binder's replacement reads the next link through this
                    // `var` AFTER the test, where the guard no longer narrows
                    // it, so that read asserts — safe, the guard proved it.
                    return this.StorePatternMemberOnce(
                        link,
                        declaredType,
                        gsharpNullableLink,
                        declarations,
                        func (local GExpression) GExpression {
                            return BinaryExpression(
                                BinaryExpression(local, "!=", LiteralExpression.Null()),
                                "&&",
                                this.TranslateExtendedPropertyLink(
                                    names,
                                    intermediateExprs,
                                    index + 1,
                                    NonNullAssertionExpression(local),
                                    memberPath,
                                    leafPattern
                                )
                            )
                        }
                    )
                }
                return this.BindPatternMemberOnce(link, rest)
            }
            return this.TranslateExtendedPropertyLink(
                names,
                intermediateExprs,
                index + 1,
                link,
                memberPath,
                leafPattern
            )
        }

        // Issue #1891: lowers an extended property subpattern's dotted member
        // path (`Start.X`, `A.B.C`, ...) to nested G# `PropertyPattern` fields —
        // `Start.X: 0` becomes `Start: { X: 0 }` — since a G# property-pattern
        // field is a single identifier with no dotted form. Supports any chain
        // depth; the innermost field carries the actual subpattern translated
        // against the fully-qualified member-access receiver (so a binding like
        // `Start.X: var x` still reads `receiver.Start.X`).
        //
        // Issue #1971: multiple subpatterns sharing a leftmost identifier
        // prefix (`{ A.B: 0, A.C: 1 }`) are grouped through
        // <see cref="ExtendedPropertyFieldTree"/> before being converted, so
        // they merge into one nested field (`{ A: { B: 0, C: 1 } }`) instead of
        // emitting the same top-level field name twice.
        // Resolves the member each positional subpattern of `recursive`
        // deconstructs to (issue #1887), so a positional pattern can lower to the
        // same nested member-access form a property pattern uses. Returns null
        // when no canonical mapping exists, with `failureReason` saying why, so
        // callers report the loud "no canonical G# form" diagnostic (a
        // CS2GS-GAP that fails the translate stage) instead of guessing.
        // For a `Deconstruct`, each slot's member (possibly inherited) gives
        // callers its real casing and declared type (issue #4382); see
        // PositionalSlots.
        private func TryGetPositionalMembers(
            recursive RecursivePatternSyntax?,
            arity int32,
            out failureReason string?
        ) PositionalSlots? {
            failureReason = nil
            if this.context.SemanticModel.GetOperation(recursive!!) is not IRecursivePatternOperation operation {
                failureReason = "the pattern has no bound recursive-pattern operation"
                return nil
            }
            if (operation.MatchedType is INamedTypeSymbol and {IsTupleType: true}) {
                // `(0, 0)` against a `(int, int)` tuple: positions bind to the
                // always-present `Item1`/`Item2` fields regardless of any
                // user-declared tuple element names.
                let tupleNames = [arity]string
                for var i = 0; i < arity; i++ {
                    tupleNames[i] = "Item" + (i + 1).ToString(CultureInfo.InvariantCulture)
                }
                return PositionalSlots(true, tupleNames, Array.Empty[ISymbol](), Array.Empty[string]())
            }
            // Roslyn has already picked the Deconstruct overload whose arity
            // matches the pattern, so only its shape is checked here.
            if operation.DeconstructSymbol is not IMethodSymbol deconstruct {
                failureReason = "no Deconstruct method was bound for '${operation.MatchedType?.Name}'"
                return nil
            }
            if deconstruct.IsExtensionMethod || deconstruct.ReducedFrom != nil {
                // An extension Deconstruct is declared away from the type, and
                // nothing ties its out-parameters to the type's members.
                failureReason = "'${deconstruct.ContainingType?.Name}.${deconstruct.Name}' is an extension Deconstruct"
                return nil
            }
            if deconstruct.Parameters.Length != arity || deconstruct.Parameters.Any(
                (parameter IParameterSymbol) -> parameter.RefKind != RefKind.Out
            ) {
                failureReason = "'${deconstruct.Name}' does not take $arity out-parameter(s)"
                return nil
            }
            // Each slot resolves on its own: a slot that stays unresolved
            // (null member, with its reason) fails only if its subpattern
            // tests something, so `Inner(var a, _)` still lowers when only the
            // discarded slot has no matching member.
            let names = [arity]string?
            let members = [arity]ISymbol?
            let failures = CreateNullableFailureArray(arity)
            for var i = 0; i < arity; i++ {
                // Issue #4476: receive the reason in an `out var` local (typed
                // as the parameter, which self-migration widens to `string?`
                // because it is assigned null) and store it like `names[i]`,
                // rather than passing the non-null `string[]` element by
                // reference, which is GS0612 in the migrated G#.
                let member ISymbol? = this.FindDeconstructSlotMember(
                    operation.MatchedType,
                    deconstruct,
                    deconstruct.Parameters[i],
                    recursive,
                    out var failure
                )
                names[i] = member?.Name
                members[i] = member
                failures[i] = failure
            }
            return PositionalSlots(false, names, members, failures)
        }

        // Issue #4382: finds the property or field that `deconstruct`'s
        // out-parameter `parameter` reads. Candidates are the names that match
        // the parameter case-insensitively anywhere in the declaring type's
        // inheritance graph (base classes, and base interfaces for an
        // interface); each name is then resolved by Roslyn's own member lookup
        // FROM THE DECLARING TYPE, so hiding (`new`), overriding and interface
        // diamonds follow C#, not a hand-rolled walk. An exactly-named
        // property wins (a record's positional properties). Otherwise the C#
        // convention `out T x` <-> `X` applies: exactly one property or field
        // whose name matches case-insensitively. Either way the member's type
        // must be the parameter's (a pattern tests the value Deconstruct
        // returns, not a wider member it converts). The member must then be
        // readable as `receiver.Name` on `matchedType` at `pattern`:
        // accessible there, and resolved by member lookup on `matchedType`
        // (a class, an interface or a constrained type parameter) to that
        // same slot, not to a member that hides it. Anything else returns
        // null with a reason.
        private func FindDeconstructSlotMember(
            matchedType ITypeSymbol?,
            deconstruct IMethodSymbol,
            parameter IParameterSymbol,
            pattern SyntaxNode?,
            out failureReason string?
        ) ISymbol? {
            let IsSameSlot = func (symbol ISymbol, slot ISymbol?) bool {
                for var current ISymbol? = symbol;
                    current != nil;
                    current = (current as IPropertySymbol)
                    ?.OverriddenProperty {
                    if SymbolEqualityComparer.Default.Equals(current.OriginalDefinition, slot!!.OriginalDefinition) {
                        return true
                    }
                }
                return false
            }
            let IsDeconstructSlotCandidate = func (member ISymbol) bool {
                return (
                    member is IPropertySymbol &&
                        member.IsIndexer == false ||
                        member is IFieldSymbol &&
                        member.IsImplicitlyDeclared == false
                ) &&
                    !member.IsStatic
            }
            failureReason = nil
            let declaringType INamedTypeSymbol? = deconstruct.ContainingType
            let searched = List[ITypeSymbol]()
            for var current ITypeSymbol? = declaringType; current != nil; current = current!!.BaseType {
                searched.Add(current)
            }
            if declaringType!!.TypeKind == TypeKind.Interface {
                searched.AddRange(declaringType!!.AllInterfaces)
            }
            let names = HashSet[string](StringComparer.Ordinal)
            for type in searched {
                for member in type.GetMembers() {
                    if IsDeconstructSlotCandidate(member) && string.Equals(
                        member.Name,
                        parameter.Name,
                        StringComparison.OrdinalIgnoreCase
                    ) {
                        names.Add(member.Name)
                    }
                }
            }
            // Look each name up where the Deconstruct body would: inside its
            // declaration when it is in source, else at the pattern.
            var declaringModel = this.context.SemanticModel
            var declaringPosition = pattern!!.SpanStart
            let declaringSyntax SyntaxReference? = deconstruct.DeclaringSyntaxReferences.FirstOrDefault()
            if declaringSyntax != nil {
                declaringModel = this.context.SemanticModel.Compilation.GetSemanticModel(declaringSyntax.SyntaxTree)
                declaringPosition = declaringSyntax.Span.Start
            }
            var match ISymbol? = nil
            let candidates = List[ISymbol]()
            for name in names.OrderBy((name string) -> name, StringComparer.Ordinal) {
                let found = declaringModel.LookupSymbols(declaringPosition, declaringType, name)
                if found.Length != 1 || !IsDeconstructSlotCandidate(found[0]) {
                    if found.Length > 1 {
                        failureReason = "Deconstruct out-parameter '${parameter.Name}' matches '$name' ambiguously on '${declaringType!!.Name}'"
                        return nil
                    }
                    continue
                }
                if found[0] is IPropertySymbol && name == parameter.Name {
                    // Issue #1887: an exactly-named property.
                    match = found[0]
                    break
                }
                candidates.Add(found[0])
            }
            if match == nil {
                if candidates.Count == 0 {
                    failureReason = "Deconstruct out-parameter '${parameter.Name}' has no matching property or field"
                    return nil
                }
                if candidates.Count > 1 {
                    failureReason = "Deconstruct out-parameter '${parameter.Name}' matches several members case-insensitively (" +
                        string.Join(", ", candidates.Select((candidate ISymbol) -> "'${candidate.Name}'")) + ")"
                    return nil
                }
                match = candidates[0]
            }
            let memberType = if match is IPropertySymbol property {
                property.Type
            } else {
                (cast[IFieldSymbol](match)).Type
            }
            if !SymbolEqualityComparer.Default.Equals(memberType, parameter.Type) {
                failureReason = "Deconstruct out-parameter '${parameter.Name}' is '${parameter.Type.ToDisplayString()}' but member '${match.Name}' is '${memberType.ToDisplayString()}'"
                return nil
            }
            // Accessibility is judged from the pattern's enclosing type and
            // THROUGH the matched type, as C# judges `receiver.Name`: a
            // protected member is readable only through the accessing type
            // or one derived from it.
            let enclosing ISymbol? = this.context.SemanticModel.GetEnclosingSymbol(pattern!!.SpanStart)
            let within = enclosing as INamedTypeSymbol ??
                cast[ISymbol](enclosing?.ContainingType) ??
                this
                .context
                .SemanticModel
                .Compilation
                .Assembly
            let compilation = this.context.SemanticModel.Compilation
            if !compilation.IsSymbolAccessibleWithin(match, within, matchedType) {
                failureReason = "Deconstruct out-parameter '${parameter.Name}' reads '${match.Name}', which is not accessible here"
                return nil
            }
            // A property is read through its getter, which can be missing or
            // less accessible than the property itself.
            if match is IPropertySymbol{GetMethod: var getter} &&
                (getter == nil || !compilation.IsSymbolAccessibleWithin(getter, within, matchedType)) {
                failureReason = "Deconstruct out-parameter '${parameter.Name}' reads '${match.Name}', whose getter is not accessible here"
                return nil
            }
            // The lowering reads `receiver.Name` on the matched type. Member
            // lookup there (through base classes, base interfaces or a type
            // parameter's constraints) must reach the same slot: `match`
            // itself or a property that overrides it. Anything else (a `new`
            // member in a derived class or interface, a method, a nested
            // type, an interface diamond) would read a different member.
            let reached = this.context.SemanticModel.LookupSymbols(pattern!!.SpanStart, matchedType, match.Name)
            let other ISymbol? = reached.FirstOrDefault((symbol ISymbol) -> !IsSameSlot(symbol, match))
            if other != nil || reached.IsEmpty {
                failureReason = if other != nil {
                    "Deconstruct out-parameter '${parameter.Name}' reads '${match.ContainingType.Name}.${match.Name}', which '${other.ContainingType?.Name}.${other.Name}' hides"
                } else {
                    "Deconstruct out-parameter '${parameter.Name}' reads '${match.ContainingType.Name}.${match.Name}', which is not reachable by name on '${matchedType!!.Name}'"
                }
                return nil
            }
            return match
        }

        // Resolves positional subpattern `index`'s member name and symbol from
        // `positional` (see TryGetPositionalMembers). For a Deconstruct, the
        // resolved member wins even over a `name:` label, which names the
        // out-parameter (`Outer(p: 0)`), not the member, so an unresolved
        // slot stays unresolved even when labelled. A tuple keeps the label
        // or `ItemN`, looked up on `lookupType`. When unresolved, returns
        // false and `failure` says why (`positionalFailure` when the whole
        // pattern failed to resolve).
        private func TryResolvePositionalSlot(
            sub SubpatternSyntax,
            index int32,
            positional PositionalSlots?,
            positionalFailure string?,
            lookupType ITypeSymbol?,
            out memberName string?,
            out memberSymbol ISymbol?,
            out failure string?
        ) bool {
            memberName = nil
            memberSymbol = nil
            failure = positionalFailure
            if positional == nil {
                return false
            }
            if !positional.IsTuple {
                // A write to an out parameter drops the narrowing of the others (ADR-0208 R12), so
                // the member is read from a local.
                let member = positional.Members[index]
                memberSymbol = member
                if member == nil {
                    failure = positional.Failures[index]
                    return false
                }
                memberName = member.Name
                return true
            }
            memberName = sub.NameColon?.Name.Identifier.ValueText ?? positional.Names[index]
            memberSymbol = if sub.NameColon != nil {
                this.GetPatternMemberSymbol(sub.NameColon!!.Name)
            } else {
                (lookupType as INamedTypeSymbol)?.GetMembers(memberName!!).FirstOrDefault()
            }
            return true
        }

        private func BindPatternDesignation(designation VariableDesignationSyntax?, receiver GExpression?) {
            if designation is SingleVariableDesignationSyntax variable && this.context.GetDeclaredSymbol(
                variable
            ) is {} boundSymbol {
                this.state.PatternBindings[boundSymbol] = receiver!!
            }
        }

        // Builds the smart-cast replacement expression a pattern designator
        // (`x is T t`, `x is { } t`) is rewritten to inside the guarded region.
        // gsc flow-narrows only a bare local/parameter scrutinee (ADR-0069); when
        // the scrutinee is a member-access chain, indexer or method-call result it
        // is NOT narrowed, so re-emitting the bare receiver at each use of `t`
        // leaves it at its (often nullable / wider) declared type and a member
        // access then fails to bind (GS0158). For those non-smart-castable
        // receivers we materialise the narrowing explicitly:
        //   • reference target `T`  → `(receiver as T)!!` (downcast + non-null);
        //   • value target `T`      → `receiver!!`        (G# has no `as` for value
        //                                                  types; the match already
        //                                                  proved it non-null);
        //   • `is { } t` (no type)  → `receiver!!`        (non-null view only).
        // A smart-castable bare local keeps the existing bare-receiver binding so
        // currently passing translations are unchanged.
        private func BuildPatternNarrowingReplacement(
            receiver GExpression?,
            receiverSyntax ExpressionSyntax?,
            narrowedTypeSyntax TypeSyntax?
        ) GExpression? {
            if narrowedTypeSyntax == nil &&
                receiverSyntax != nil &&
                this
                .context
                .GetTypeInfo(receiverSyntax)
                .Type is INamedTypeSymbol nullableReceiver &&
                nullableReceiver
                .OriginalDefinition
                .SpecialType == SpecialType.System_Nullable_T {
                return NonNullAssertionExpression(receiver)
            }
            let bindingUsedInsideCondition = narrowedTypeSyntax?.Ancestors().Any(
                (node SyntaxNode) -> node is WhenClauseSyntax ||
                    (
                    node is BinaryExpressionSyntax binary &&
                        (
                        binary.IsKind(SyntaxKind.LogicalAndExpression) || binary.IsKind(SyntaxKind.LogicalOrExpression)
                    )
                )
            ) == true
            if !bindingUsedInsideCondition && receiverSyntax != nil && this.IsSmartCastableScrutinee(receiverSyntax) &&
                !(this.context.GetTypeInfo(receiverSyntax).Type is ITypeParameterSymbol) {
                return receiver
            }
            if narrowedTypeSyntax == nil {
                return NonNullAssertionExpression(receiver)
            }
            let narrowedType ITypeSymbol? = this.context.GetTypeInfo(narrowedTypeSyntax).Type
            if narrowedType != nil && narrowedType.IsValueType {
                return NonNullAssertionExpression(receiver)
            }
            return NonNullAssertionExpression(
                ParenthesizedExpression(
                    BinaryExpression(receiver, "as", TypeExpression(this.MapTypeSyntax(narrowedTypeSyntax)))
                )
            )
        }

        private func TranslateArrayCreation(creation ArrayCreationExpressionSyntax) GExpression {
            var elementType GTypeReference? = this.GetArrayElementType(creation, creation.Type.ElementType)
            let elementTypeSymbol ITypeSymbol? = (
                this.context.GetTypeInfo(creation).Type as IArrayTypeSymbol
            )?.ElementType
            if creation.Type.RankSpecifiers.Count > 0 && creation.Type.RankSpecifiers[0].Sizes.Count > 1 {
                let rank = creation.Type.RankSpecifiers[0].Sizes.Count
                if creation.Initializer != nil {
                    let leaves = List[ExpressionSyntax]()
                    var dimensions IReadOnlyList[GExpression]
                    if creation
                        .Type
                        .RankSpecifiers[0]
                        .Sizes
                        .All((size ExpressionSyntax) -> size.IsKind(SyntaxKind.OmittedArraySizeExpression)) {
                        let inferredDimensions = [rank]int32
                        FlattenRectangularArrayInitializer(creation.Initializer, 0, rank, inferredDimensions, leaves)
                        dimensions = inferredDimensions.Select(
                            (d int32) -> cast[GExpression](
                                LiteralExpression.Int(d.ToString(CultureInfo.InvariantCulture))
                            )
                        )
                            .ToList()
                    } else {
                        dimensions = creation
                            .Type
                            .RankSpecifiers[0]
                            .Sizes
                            .Select(this.TranslateRectangularInitializerDimension)
                            .ToList()
                        FlattenRectangularArrayInitializer(creation.Initializer, 0, rank, [rank]int32, leaves)
                    }
                    let leafElementType GTypeReference? = this.PromoteElementTypeForNullElements(
                        elementType,
                        elementTypeSymbol,
                        leaves
                    )
                    let leafAcceptsNil = leafElementType!!.IsNullable
                    return ArrayAllocationExpression(
                        leafElementType,
                        dimensions,
                        leaves.Select(
                            (expression ExpressionSyntax) -> this.TranslateArrayInitializerElement(
                                expression,
                                elementTypeSymbol,
                                leafAcceptsNil
                            )!!
                        )
                            .ToList()
                    )
                }
                return ArrayAllocationExpression(
                    elementType,
                    creation
                        .Type
                        .RankSpecifiers[0]
                        .Sizes
                        .Select(
                        (size ExpressionSyntax) -> this.CoerceLengthToInt32(size, this.TranslateExpression(size))!!
                    )
                        .ToList()
                )
            }
            if creation.Initializer != nil {
                // `new T[]{a, b}` / `new T[0]` (with an explicit, possibly empty,
                // initializer) → the slice literal `[]T{a, b}`.
                let literalElementType GTypeReference? = this.PromoteElementTypeForNullElements(
                    elementType,
                    elementTypeSymbol,
                    creation.Initializer!!.Expressions,
                    creation
                )
                let literalAcceptsNil = literalElementType!!.IsNullable
                return ArrayLiteralExpression(
                    literalElementType,
                    creation.Initializer!!
                        .Expressions
                        .Select(
                        (expression ExpressionSyntax) -> this.TranslateArrayInitializerElement(
                            expression,
                            elementTypeSymbol,
                            literalAcceptsNil
                        )!!
                    )
                        .ToList()
                )
            }
            // `new T[n]` (runtime/constant length, no initializer) → the native
            // G# zero-initialised allocation form `[n]T` (issue #1272), which
            // yields a zero-initialised slice `[]T` of length `n`. C# accepts
            // any integral length (`uint`/`long`/…); gsc's `[n]T` requires an
            // `int32` length, so a non-`int32` numeric length is coerced via the
            // conversion-call form (`int32(n)`).
            var length GExpression?
            if creation
                .Type
                .RankSpecifiers
                .Count > 0 &&
                creation
                .Type
                .RankSpecifiers[0]
                .Sizes
                .Count > 0 &&
                creation
                .Type
                .RankSpecifiers[0]
                .Sizes[0] is {} sizeExpr &&
                !sizeExpr
                .IsKind(SyntaxKind.OmittedArraySizeExpression) {
                length = this.CoerceLengthToInt32(sizeExpr, this.TranslateExpression(sizeExpr))
            } else {
                length = LiteralExpression.Int("0")
            }
            // Issue #4482: an element of this array passed by `out`/`ref` to a
            // parameter cs2gs emits `T?` is storage the callee may write nil
            // into, and gsc requires by-ref storage to match the parameter's
            // nullability exactly (GS0612). Widen the ELEMENT (`[n]T?`).
            if elementType != nil && elementType.IsNullable == false && this.ResolveValueSink(
                creation
            ) is ILocalSymbol arrayLocal &&
                this.IsWidenedArrayElementLocal(arrayLocal) {
                elementType = MakeNullable(elementType)
            }
            return ArrayAllocationExpression(elementType, length)
        }

        // Issues #4482, #4500 and #4507: the one decision "this local's
        // `new T[n]` allocation has a `T?` element". The allocation, its
        // inferred local aliases, and every element read/write ask it, so they
        // cannot disagree.
        // Only a rank-1 allocation takes the widening branch in
        // TranslateArrayCreation (a rectangular one returns earlier), and the
        // initializer may be parenthesized.
        private func IsWidenedArrayElementLocal(local ILocalSymbol) bool {
            let owner ILocalSymbol? = this.GetArrayAllocationOwner(
                local,
                HashSet[ILocalSymbol](SymbolEqualityComparer.Default)
            )
            return owner != nil &&
                (this.ElementPassedToNullableByRefParameter(owner) || this.ElementWrittenMaybeNil(owner))
        }

        private func IsNullableArrayElementAccess(expression ExpressionSyntax?) bool {
            var expression = expression
            expression = Unparenthesize(expression)
            if expression is not ElementAccessExpressionSyntax elementAccess {
                return false
            }
            if this.ArrayExpressionHasNullableReferenceLikeElement(elementAccess.Expression) {
                return true
            }
            let projectedElement ITypeSymbol? = (
                this.GetManagedReferenceArrayProjectedExpressionType(elementAccess.Expression) as IArrayTypeSymbol
            )?.ElementType
            return projectedElement != nil &&
                projectedElement.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated &&
                this.IsReferenceLikeOrManagedReference(projectedElement)
        }

        private func ArrayExpressionHasNullableReferenceLikeElement(
            expression ExpressionSyntax
        ) bool -> this.ArrayExpressionHasNullableElement(expression, requireReferenceLikeElement: true)

        private func ArrayExpressionHasNullableElement(
            expression ExpressionSyntax?
        ) bool -> this.ArrayExpressionHasNullableElement(expression, requireReferenceLikeElement: false)

        private func IsReferenceLikeOrManagedReference(type ITypeSymbol?) bool -> type != nil &&
            (
            type.IsReferenceType || CSharpTypeMapper.IsRecognizedManagedReferenceConsumerType(
                type,
                this.context.Compilation
            )
        )

        private func ArrayExpressionHasNullableElement(
            expression ExpressionSyntax?,
            requireReferenceLikeElement bool
        ) bool {
            var expression = expression
            expression = Unparenthesize(expression)
            let typeInfo = this.context.GetTypeInfo(expression)
            if (typeInfo.Type ?? typeInfo.ConvertedType) is not IArrayTypeSymbol array ||
                (requireReferenceLikeElement && !this.IsReferenceLikeOrManagedReference(array.ElementType)) {
                return false
            }
            return this.GetMappedArrayElement(expression)
                ?.IsNullable == true ||
                (
                this.context.GetSymbolInfo(expression).Symbol is ILocalSymbol local && this.IsWidenedArrayElementLocal(
                    local
                )
            )
        }

        private func GetMappedArrayElementType(expression ExpressionSyntax?) ITypeSymbol? {
            var expression = expression
            expression = Unparenthesize(expression)
            let typeInfo = this.context.GetTypeInfo(expression)
            if (typeInfo.Type ?? typeInfo.ConvertedType) is not IArrayTypeSymbol array {
                return nil
            }
            let mappedElement GTypeReference? = this.GetMappedArrayElement(expression)
            let projectedElement ITypeSymbol? = if mappedElement == nil {
                array.ElementType
            } else {
                this.ApplyMappedArrayElementShape(array.ElementType, mappedElement)
            }
            return if this
                .context
                .GetSymbolInfo(expression)
                .Symbol is ILocalSymbol local &&
                this
                .IsWidenedArrayElementLocal(local) {
                projectedElement!!.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.Annotated)
            } else {
                projectedElement
            }
        }

        private func GetMappedArrayElement(expression ExpressionSyntax?) GTypeReference? {
            var expression = expression
            expression = Unparenthesize(expression)
            let typeInfo = this.context.GetTypeInfo(expression)
            if (typeInfo.Type ?? typeInfo.ConvertedType) is not IArrayTypeSymbol array {
                return nil
            }
            if expression is MemberAccessExpressionSyntax member &&
                this
                .context
                .GetSymbolInfo(member)
                .Symbol is IPropertySymbol property &&
                property
                .ContainingType
                .IsAnonymousType &&
                this
                .typeMapper
                .GetAnonymousPropertyType(
                property,
                this.context,
                member.GetLocation()
            ) is ArrayTypeReference mergedArray {
                return mergedArray.ElementType
            }
            if !this
                .state
                .ManagedReferenceArrayNullable
                .MappedArrayElementByElementType
                .TryGetValue(array.ElementType, out var mappedElement) {
                // Issue #4556: only the element's shape is read here; the
                // mapping is never printed, so it must not synthesize imports.
                mappedElement = (
                    this.typeMapper.MapWithoutImportTracking(
                        array,
                        this.context,
                        expression!!.GetLocation()
                    ) as ArrayTypeReference
                )?.ElementType
                this
                    .state
                    .ManagedReferenceArrayNullable
                    .MappedArrayElementByElementType
                    .Add(array.ElementType, mappedElement)
            }
            return mappedElement
        }

        private func ApplyMappedArrayElementShape(source ITypeSymbol?, mapped GTypeReference?) ITypeSymbol? {
            if source is IArrayTypeSymbol sourceArray && mapped is ArrayTypeReference mappedArray {
                let element ITypeSymbol? = this.ApplyMappedArrayElementShape(
                    sourceArray.ElementType,
                    mappedArray.ElementType
                )
                return this
                    .context
                    .Compilation
                    .CreateArrayTypeSymbol(element!!, sourceArray.Rank, element!!.NullableAnnotation)
                    .WithNullableAnnotation(
                    if mapped.IsNullable {
                        Microsoft.CodeAnalysis.NullableAnnotation.Annotated
                    } else {
                        source.NullableAnnotation
                    }
                )
            }
            if source is INamedTypeSymbol{IsTupleType: true} tuple &&
                mapped is TupleTypeReference mappedTuple &&
                tuple
                .TupleElements
                .Length == mappedTuple
                .ElementTypes
                .Count {
                let elements = tuple
                    .TupleElements
                    .Select(
                    (element IFieldSymbol, index int32) -> this.ApplyMappedArrayElementShape(
                        element.Type,
                        mappedTuple.ElementTypes[index]
                    )!!
                )
                    .ToImmutableArray()
                if elements.Select((element ITypeSymbol, index int32) -> (element, index)).All(
                    (pair(element ITypeSymbol, index int32)) -> SymbolEqualityComparer.IncludeNullability.Equals(
                        pair.Item1,
                        tuple.TupleElements[pair.Item2].Type
                    )
                ) {
                    return source
                }
                let names = tuple
                    .TupleElements
                    .Select(
                    (element IFieldSymbol) -> if element.IsImplicitlyDeclared {
                        default(string?)
                    } else {
                        element.Name
                    }
                )
                    .ToImmutableArray()
                let annotations = elements.Select((element ITypeSymbol) -> element.NullableAnnotation)
                    .ToImmutableArray()
                return this
                    .context
                    .Compilation
                    .CreateTupleTypeSymbol(elements, names, default(ImmutableArray[Location?]), annotations)
            }
            if source is INamedTypeSymbol named &&
                mapped is NamedTypeReference mappedNamed &&
                named
                .TypeArguments
                .Length == mappedNamed
                .TypeArguments
                .Count {
                let arguments = named
                    .TypeArguments
                    .Select(
                    (argument ITypeSymbol, index int32) -> this.ApplyMappedArrayElementShape(
                        argument,
                        mappedNamed.TypeArguments[index]
                    )!!
                )
                    .ToImmutableArray()
                let annotations = arguments.Select((argument ITypeSymbol) -> argument.NullableAnnotation)
                    .ToImmutableArray()
                var definition = named.ConstructedFrom
                if named.ContainingType != nil &&
                    mappedNamed.ContainingType != nil &&
                    this.ApplyMappedArrayElementShape(
                    named.ContainingType,
                    mappedNamed.ContainingType
                ) is INamedTypeSymbol containingType {
                    definition = containingType.GetTypeMembers(named.Name, named.Arity).FirstOrDefault(
                        (candidate INamedTypeSymbol) -> candidate.MetadataName == named.MetadataName
                    ) ??
                        definition
                }
                let projected = if named.Arity == 0 {
                    definition
                } else {
                    definition.Construct(arguments, annotations)
                }
                return projected.WithNullableAnnotation(
                    if mapped.IsNullable {
                        Microsoft.CodeAnalysis.NullableAnnotation.Annotated
                    } else {
                        source.NullableAnnotation
                    }
                )
            }
            if source is INamedTypeSymbol delegateType &&
                delegateType.DelegateInvokeMethod is {} invoke &&
                mapped is ArrowTypeReference arrow {
                let arguments = delegateType.TypeArguments.ToArray()
                for var index = 0; index < arguments.Length; index++ {
                    let parameter = delegateType.ConstructedFrom.TypeParameters[index]
                    if !invoke.ReturnsVoid && arrow.ReturnTypes.Count == 1 && SymbolEqualityComparer.Default.Equals(
                        invoke.OriginalDefinition.ReturnType,
                        parameter
                    ) {
                        arguments[index] = this.ApplyMappedArrayElementShape(arguments[index], arrow.ReturnTypes[0])!!
                        continue
                    }
                    for var parameterIndex = 0;
                        parameterIndex < invoke
                        .Parameters
                        .Length &&
                        parameterIndex < arrow
                        .ParameterTypes
                        .Count;
                        parameterIndex++ {
                        if SymbolEqualityComparer.Default.Equals(
                            invoke.OriginalDefinition.Parameters[parameterIndex].Type,
                            parameter
                        ) {
                            arguments[index] = this.ApplyMappedArrayElementShape(
                                arguments[index],
                                arrow.ParameterTypes[parameterIndex]
                            )!!
                            break
                        }
                    }
                }
                let immutableArguments = arguments.ToImmutableArray()
                let projected = if delegateType.Arity == 0 {
                    delegateType
                } else {
                    delegateType.ConstructedFrom.Construct(
                        immutableArguments,
                        immutableArguments.Select((argument ITypeSymbol) -> argument.NullableAnnotation)
                            .ToImmutableArray()
                    )
                }
                return projected.WithNullableAnnotation(
                    if mapped.IsNullable {
                        Microsoft.CodeAnalysis.NullableAnnotation.Annotated
                    } else {
                        source.NullableAnnotation
                    }
                )
            }
            return if mapped!!.IsNullable {
                source!!.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.Annotated)
            } else {
                source
            }
        }

        private func GetArrayAllocationOwner(local ILocalSymbol, visited HashSet[ILocalSymbol]) ILocalSymbol? {
            if local.Type is not(IArrayTypeSymbol and {Rank: 1, ElementType: {IsReferenceType: true}}) || !visited.Add(
                local
            ) {
                return nil
            }
            for reference in local.DeclaringSyntaxReferences {
                let declaration = reference.GetSyntax()
                if declaration is SingleVariableDesignationSyntax designation && this.GetDeconstructionAliasValue(
                    designation
                ) is {} deconstructedValue &&
                    this
                    .context
                    .GetSymbolInfo(deconstructedValue)
                    .Symbol is ILocalSymbol deconstructedSource {
                    return this.GetArrayAllocationOwner(deconstructedSource, visited)
                }
                if !(declaration is VariableDeclaratorSyntax{Initializer: {Value: {} initializer}} declarator) {
                    continue
                }
                let value ExpressionSyntax? = StripParentheses(initializer)
                if value is ArrayCreationExpressionSyntax && value.Initializer == nil {
                    return local
                }
                if (declarator.Parent is VariableDeclarationSyntax and {Type: {IsVar: true}}) &&
                    this
                    .context
                    .GetSymbolInfo(value)
                    .Symbol is ILocalSymbol source {
                    return this.GetArrayAllocationOwner(source, visited)
                }
            }
            return nil
        }

        private func GetDeconstructionAliasValue(designation SingleVariableDesignationSyntax) ExpressionSyntax? {
            var target SyntaxNode = designation
            let elementIndices = Stack[int32]()
            while true {
                switch target.Parent {
                    case parenthesized is ParenthesizedVariableDesignationSyntax {
                        elementIndices.Push(parenthesized.Variables.IndexOf(cast[VariableDesignationSyntax](target)))
                        target = parenthesized
                        continue
                    }
                    case declaration is DeclarationExpressionSyntax when declaration.Type.IsVar {
                        target = declaration
                        continue
                    }
                    case argument is ArgumentSyntax when argument.Parent is TupleExpressionSyntax tuple {
                        elementIndices.Push(tuple.Arguments.IndexOf(argument))
                        target = tuple
                        continue
                    }
                    case assignment is AssignmentExpressionSyntax when assignment.Left == target {
                        var value ExpressionSyntax? = assignment.Right
                        for index in elementIndices {
                            value = StripParentheses(value)
                            if value is not TupleExpressionSyntax tupleValue ||
                                index < 0 ||
                                index >= tupleValue
                                .Arguments
                                .Count {
                                return nil
                            }
                            value = tupleValue.Arguments[index].Expression
                        }
                        return StripParentheses(value)
                    }
                    default {
                        return nil
                    }
                }
            }
        }

        private func IsArrayAllocationAlias(expression ExpressionSyntax, owner ILocalSymbol?) bool -> this
            .context
            .GetSymbolInfo(expression)
            .Symbol is ILocalSymbol local &&
            SymbolEqualityComparer
            .Default
            .Equals(this.GetArrayAllocationOwner(local, HashSet[ILocalSymbol](SymbolEqualityComparer.Default)), owner)

        // Issue #4482: whether some `local[i]` in the local's scope is passed
        // by `out`/`ref` to a parameter whose emitted type is `T?`.
        private func ElementPassedToNullableByRefParameter(local ILocalSymbol?) bool {
            let scope_ SyntaxNode? = this.GetNullabilityScope(local)
            if scope_ == nil {
                return false
            }
            for argument in scope_.DescendantNodes().OfType[ArgumentSyntax]() {
                if !argument.RefKindKeyword.IsKind(SyntaxKind.OutKeyword) && !argument.RefKindKeyword.IsKind(
                    SyntaxKind.RefKeyword
                ) {
                    continue
                }
                if argument.Expression is ElementAccessExpressionSyntax elementAccess && this.IsArrayAllocationAlias(
                    elementAccess.Expression,
                    local
                ) &&
                    this
                    .context
                    .SemanticModel
                    .GetOperation(argument) is IArgumentOperation{Parameter: {} parameter} &&
                    parameter
                    .Type
                    .IsReferenceType &&
                    (
                    parameter
                        .Type
                        .NullableAnnotation == Microsoft
                        .CodeAnalysis
                        .NullableAnnotation
                        .Annotated ||
                        this.ShouldPromoteToNullableReference(parameter)
                ) {
                    return true
                }
            }
            return false
        }

        // Issue #4500: the same rule for a plain element WRITE. `names[i] =
        // member?.Name` stores a value that may be nil in G# (its emitted
        // type is `T?`: IsNullableInitializer, or a symbol cs2gs promotes), so
        // the element must be `T?` too. Otherwise the write is bridged with
        // `!!`, which throws on the nil that C# simply stores.
        private func ElementWrittenMaybeNil(local ILocalSymbol?) bool {
            let scope_ SyntaxNode? = this.GetNullabilityScope(local)
            if scope_ == nil {
                return false
            }
            for assignment in scope_.DescendantNodes().OfType[AssignmentExpressionSyntax]() {
                if assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) &&
                    assignment.Left is ElementAccessExpressionSyntax elementAccess &&
                    this.IsArrayAllocationAlias(elementAccess.Expression, local) &&
                    (
                    IsNullOrSuppressedNull(assignment.Right) ||
                        (
                        this
                            .context
                            .GetTypeInfo(assignment.Right)
                            .Nullability
                            .FlowState != Microsoft
                            .CodeAnalysis
                            .NullableFlowState
                            .NotNull &&
                            (
                            this.IsNullableInitializer(assignment.Right) || this.ShouldPromoteToNullableReference(
                                this.context.GetSymbolInfo(assignment.Right).Symbol
                            )
                        )
                    )
                ) {
                    return true
                }
            }
            return false
        }

        private func TranslateRectangularInitializerDimension(size ExpressionSyntax) GExpression? {
            let constant = this.context.SemanticModel.GetConstantValue(size)
            if constant.HasValue && TryGetNonNegativeInt32(constant.Value, out var value) {
                return LiteralExpression.Int(value.ToString(CultureInfo.InvariantCulture))
            }
            return this.CoerceLengthToInt32(size, this.TranslateExpression(size))
        }

        /// Issue #4350: translates every argument of a multi-parameter indexer
        /// access, preserving source order (and so C#'s left-to-right single
        /// evaluation of each argument).
        private func TranslateIndexArguments(arguments BracketedArgumentListSyntax) List[GExpression] {
            // Review finding (#4350): a named index argument binds by name, so
            // `grid[column: c, row: r]` targets `this[int row, int column]`
            // in the opposite order to its text. G# index arguments are purely
            // positional; an in-order named list simply drops its names, and a
            // REORDERED one is reported rather than silently swapping the
            // bound parameters.
            for var i = 0; i < arguments.Arguments.Count; i++ {
                let argument = arguments.Arguments[i]
                if argument.NameColon != nil &&
                    this
                    .context
                    .SemanticModel
                    .GetOperation(argument) is IArgumentOperation{Parameter: {} parameter} &&
                    parameter.Ordinal != i {
                    this.context.Report(
                        TranslationDiagnostic(
                            "ElementAccessExpression",
                            "named index argument '${argument.NameColon!!.Name.Identifier.ValueText}' is out of parameter order; G# index arguments are positional, so reordered named index arguments have no faithful translation (issue #4350).",
                            argument.GetLocation(),
                            TranslationSeverity.Unsupported
                        )
                    )
                    break
                }
            }
            return arguments.Arguments.Select(this.TranslateIndexArgumentWithNullForgiveness).ToList()
        }

        /// Translates a CLR rectangular-array element access directly to native
        /// G# multi-index syntax. Runtime preserves left-to-right single
        /// evaluation, per-dimension bounds checks, and row-major storage.
        private func TranslateMultiDimElementAccess(elementAccess ElementAccessExpressionSyntax) GExpression {
            let target GExpression? = this.TranslateReceiverWithNullForgiveness(elementAccess.Expression)
            return IndexExpression(
                target,
                elementAccess
                    .ArgumentList
                    .Arguments
                    .Select(
                    (a ArgumentSyntax) -> this.CoerceMultiDimIndexToInt32(
                        a.Expression,
                        this.TranslateExpression(a.Expression)
                    )!!
                )
                    .ToList()
            )
        }

        private func TranslateStackAlloc(node StackAllocArrayCreationExpressionSyntax) GExpression {
            // gsc issues #1024, #1057, #1041: C# `stackalloc T[n]` → G#-style
            // `stackalloc [n]gT` (the bracketed count first, then the element
            // type). In a safe context this yields `Span[T]`; targeting a raw
            // pointer inside an `unsafe` context yields `*T`. The element type
            // is mapped through the standard C#→G# type mapper (`byte`→`uint8`).
            // A C# initializer (`stackalloc byte[] { 1, 2 }`) maps to the
            // faithful G# initializer (`stackalloc [2]uint8{1, 2}`); an omitted
            // size is inferred from the initializer length.
            var elementType GTypeReference?
            var count GExpression?
            if node.Type is ArrayTypeSyntax arrayType {
                elementType = this.MapTypeSyntax(arrayType.ElementType)
                count = if arrayType
                    .RankSpecifiers
                    .Count > 0 &&
                    arrayType
                    .RankSpecifiers[0]
                    .Sizes
                    .Count > 0 &&
                    arrayType
                    .RankSpecifiers[0]
                    .Sizes[0] is {} sizeExpr &&
                    !sizeExpr.IsKind(SyntaxKind.OmittedArraySizeExpression) {
                    this.TranslateExpression(sizeExpr)
                } else {
                    default(GExpression?)
                }
            } else {
                elementType = NamedTypeReference("uint8")
                count = nil
            }
            var elements List[GExpression]? = nil
            if node.Initializer != nil {
                elements = node.Initializer!!.Expressions.Select(this.TranslateExpression).ToList()
            }
            // An explicit initializer supplies the length; fall back to the
            // element count when no size is spelled.
            if count == nil && node.Initializer != nil {
                count = LiteralExpression.Int(
                    node.Initializer!!.Expressions.Count.ToString(CultureInfo.InvariantCulture)
                )
            }
            return StackAllocExpression(elementType, (count ?? LiteralExpression.Int("0")), elements)
        }

        // Issue #1897: the implicit-typed form `stackalloc[] { 5, 6, 7 }` (no
        // element-type spelled at all — C# infers it from the initializer/
        // target). Maps to the same G# count-inferred initializer shape
        // (`stackalloc []T{a, b, …}`) as the explicit omitted-size form
        // (`stackalloc int[] { … }`, handled by <see cref="TranslateStackAlloc"/>);
        // the element type is recovered from the expression's converted type
        // (`Span<T>`/`T*`) since there is no type syntax on this node to read.
        private func TranslateImplicitStackAlloc(node ImplicitStackAllocArrayCreationExpressionSyntax) GExpression {
            let elementType GTypeReference? = this.GetArrayElementType(node, nil)
            let elementTypeSymbol ITypeSymbol? = GetCollectionElementTypeSymbol(
                this.context.GetTypeInfo(node).ConvertedType ?? this.context.GetTypeInfo(node).Type
            )
            let elements = node
                .Initializer
                .Expressions
                .Select(
                (expression ExpressionSyntax) -> this.TranslateArrayInitializerElement(expression, elementTypeSymbol)!!
            )
                .ToList()
            let count GExpression = LiteralExpression.Int(
                node.Initializer.Expressions.Count.ToString(CultureInfo.InvariantCulture)
            )
            return StackAllocExpression(elementType, count, elements)
        }

        private func TranslateArrayInitializerElement(
            expression ExpressionSyntax,
            elementType ITypeSymbol?,
            elementTypeAcceptsNil bool = false
        ) GExpression? {
            var translated GExpression? = this.TranslateExpression(expression)
            // Issues #3682 and #4525: the effective translated element type
            // accepts nil, so no initializer element needs (or may take) a
            // `!!` bridge against the C# element annotation.
            if elementTypeAcceptsNil {
                return translated
            }
            // Issue #4612: the array the element is stored into, used only to
            // classify a reported bridge.
            let arrayType ITypeSymbol? = if expression.Parent is InitializerExpressionSyntax initializer {
                this.ArrayTypeOfInitializer(initializer)
            } else {
                default(IArrayTypeSymbol?)
            }
            translated = this.ForgiveNullableReferenceValue(
                expression,
                translated,
                elementType,
                targetSymbol: nil,
                reportedTarget: arrayType
            )
            if translated is NonNullAssertionExpression || !this.TargetWillRemainNonNullableReference(
                elementType,
                targetSymbol: nil
            ) ||
                IsNullOrSuppressedNull(expression) {
                return translated
            }
            let symbol ISymbol? = this.context.GetSymbolInfo(expression).Symbol
            let sourceType ITypeSymbol? = switch symbol {
                case property is IPropertySymbol: property.Type
                case field is IFieldSymbol: field.Type
                case local is ILocalSymbol: local.Type
                case parameter is IParameterSymbol: parameter.Type
                case method is IMethodSymbol: method.ReturnType
                default: default(ITypeSymbol?)
            }
            return if sourceType != nil &&
                sourceType.IsReferenceType == true &&
                (
                sourceType.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated ||
                    this.ShouldPromoteToNullableReference(symbol)
            ) {
                this.ReportStoreBridge(expression, translated, EnsureNonNullAssertion(translated), arrayType)
            } else {
                translated
            }
        }

        private func TranslateImplicitArrayCreation(creation ImplicitArrayCreationExpressionSyntax) GExpression {
            let elementType GTypeReference? = this.GetArrayElementType(creation, nil)
            // Issue #4116: prefer the BOUND PARAMETER's array element type,
            // when this literal is passed directly as a call argument, over
            // the literal's own best-common-type-inferred `Type`/
            // `ConvertedType`. In a nullable-OBLIVIOUS file (no `#nullable
            // enable` — exactly the migrated corpus's own state), Roslyn
            // does not compute per-EXPRESSION nullable annotations at all:
            // `GetTypeInfo(creation).Type` and `.ConvertedType` both report
            // `NullableAnnotation.None` for `new[] { a, n }`, even when it
            // flows straight into a BCL sink like
            // `MethodInfo.Invoke(object?, object?[]?)`. The bound PARAMETER
            // SYMBOL itself, resolved from the enclosing argument's
            // operation, is unaffected by that — parameter annotations come
            // from the callee's OWN (already nullable-annotated) metadata
            // regardless of the caller's nullable context — so it is
            // preferred here when available, falling back to the literal's
            // natural type otherwise.
            let arrayType IArrayTypeSymbol? = this.TryGetArgumentParameterArrayType(creation) ??
                this
                .context
                .GetTypeInfo(creation)
                .Type as IArrayTypeSymbol
            let elementTypeSymbol ITypeSymbol? = arrayType?.ElementType
            if arrayType != nil && arrayType.Rank > 1 {
                let dims = [arrayType.Rank]int32
                let leaves = List[ExpressionSyntax]()
                FlattenRectangularArrayInitializer(creation.Initializer, level: 0, rank: arrayType.Rank, dims, leaves)
                let leafElementType GTypeReference? = this.PromoteElementTypeForNullElements(
                    elementType,
                    elementTypeSymbol,
                    leaves,
                    creation
                )
                let leafAcceptsNil = leafElementType!!.IsNullable
                return ArrayAllocationExpression(
                    leafElementType,
                    dims.Select(
                        (d int32) -> cast[GExpression](LiteralExpression.Int(d.ToString(CultureInfo.InvariantCulture)))
                    )
                        .ToList(),
                    leaves.Select(
                        (expression ExpressionSyntax) -> this.TranslateArrayInitializerElement(
                            expression,
                            elementTypeSymbol,
                            leafAcceptsNil
                        )!!
                    )
                        .ToList()
                )
            }
            let literalElementType GTypeReference? = this.PromoteElementTypeForNullElements(
                elementType,
                elementTypeSymbol,
                creation.Initializer.Expressions,
                creation
            )
            let literalAcceptsNil = literalElementType!!.IsNullable
            return ArrayLiteralExpression(
                literalElementType,
                creation
                    .Initializer
                    .Expressions
                    .Select(
                    (expression ExpressionSyntax) -> this.TranslateArrayInitializerElement(
                        expression,
                        elementTypeSymbol,
                        literalAcceptsNil
                    )!!
                )
                    .ToList()
            )
        }

        // Issue #4116: when `arrayExpression` is passed DIRECTLY as a call
        // argument, resolves the array type of the BOUND PARAMETER it binds
        // to — via the argument's own IArgumentOperation, not the
        // expression's own GetTypeInfo — so its element's real nullable
        // annotation (sourced from the callee's metadata) is visible even in
        // a nullable-oblivious file, where GetTypeInfo never populates
        // per-expression annotations at all. Returns null for every other
        // position (a nested initializer, a return, a local initializer,
        // …), where the literal's own natural type is exactly what's wanted.
        //
        // Walks the OPERATION tree, not the syntax tree: a semantics-
        // preserving wrap (`eqMethod.Invoke(null, (new[] { m1, n }))`) still
        // binds to the same argument/parameter, but Roslyn's operation tree
        // elides a ParenthesizedExpressionSyntax entirely — it produces NO
        // IOperation node of its own, so `GetOperation` on the ArgumentSyntax
        // (or on the ParenthesizedExpressionSyntax) returns null even though
        // the ArrayCreationOperation's own `.Parent` already IS the
        // IArgumentOperation directly. Starting from the array expression's
        // own operation and walking its OPERATION-tree parent (skipping only
        // an intervening IConversionOperation, e.g. an implicit array
        // covariance conversion) sidesteps the syntax-level parenthesization
        // question entirely.
        private func TryGetArgumentParameterArrayType(arrayExpression ExpressionSyntax) IArrayTypeSymbol? {
            var operation IOperation? = this.context.SemanticModel.GetOperation(arrayExpression)?.Parent
            while operation is IConversionOperation {
                operation = operation.Parent
            }
            return (operation as IArgumentOperation)?.Parameter?.Type as IArrayTypeSymbol
        }

        private func TranslateInitializerExpression(initializer InitializerExpressionSyntax) GExpression {
            if this.context.GetTypeInfo(initializer).ConvertedType is IArrayTypeSymbol{Rank: > 1} arrayType {
                var rectangularElementType GTypeReference? = this.GetArrayElementType(initializer, nil)
                let dims = [arrayType.Rank]int32
                let leaves = List[ExpressionSyntax]()
                FlattenRectangularArrayInitializer(initializer, level: 0, rank: arrayType.Rank, dims, leaves)
                rectangularElementType = this.PromoteElementTypeForNullElements(
                    rectangularElementType,
                    arrayType.ElementType,
                    leaves,
                    initializer
                )
                return ArrayAllocationExpression(
                    rectangularElementType,
                    dims.Select(
                        (d int32) -> cast[GExpression](LiteralExpression.Int(d.ToString(CultureInfo.InvariantCulture)))
                    )
                        .ToList(),
                    leaves.Select(
                        (expression ExpressionSyntax) -> this.TranslateArrayInitializerElement(
                            expression,
                            arrayType.ElementType,
                            rectangularElementType!!.IsNullable
                        )!!
                    )
                        .ToList()
                )
            }
            // A bare `{ a, b, c }` array initializer (a field/local of array type
            // initialised without `new T[]`) or a collection-initializer element
            // list reaching value position maps to the slice literal `[]T{ … }`,
            // using the bound (converted) element type.
            var elementType GTypeReference? = this.GetArrayElementType(initializer, nil)
            let elementTypeSymbol ITypeSymbol? = GetCollectionElementTypeSymbol(
                this.context.GetTypeInfo(initializer).ConvertedType ?? this.context.GetTypeInfo(initializer).Type
            )
            elementType = this.PromoteElementTypeForNullElements(
                elementType,
                elementTypeSymbol,
                initializer.Expressions,
                initializer
            )
            return ArrayLiteralExpression(
                elementType,
                initializer
                    .Expressions
                    .Select(
                    (expression ExpressionSyntax) -> this.TranslateArrayInitializerElement(
                        expression,
                        elementTypeSymbol,
                        elementType!!.IsNullable
                    )!!
                )
                    .ToList()
            )
        }

        // ADR-0161 / issue #3350: translates a C# assignment used in VALUE position
        // into G#'s assignment expression, preserving the write where C# put it.
        //
        // A deconstruction assignment (`(a, b) = …`) has no single target and is
        // left to the existing tuple lowering. G# has no `??=` expression, so
        // that one uses a native block/if expression below.
        private func TranslateAssignmentAsExpression(assignment AssignmentExpressionSyntax) GExpression? {
            if assignment.Left is TupleExpressionSyntax {
                // Unchanged fallback: still better than nothing, and these shapes
                // are handled by their own lowerings when a seam is available.
                return this.TranslateExpression(assignment.Right)
            }
            if assignment.IsKind(SyntaxKind.CoalesceAssignmentExpression) {
                return this.TranslateCoalescingAssignmentAsExpression(assignment)
            }
            // Issue #3640: a true-discard assignment (`_ = e`) in VALUE position —
            // e.g. an expression-lambda body `t => _ = t.Exception`, which binds
            // to a value-returning delegate, so it reaches here rather than the
            // statement-level discard lowering in TranslateExpressionStatements.
            // G# has no discard assignment target (`_` would be an undeclared
            // identifier, GS0125). C# defines the value of `_ = e` as the value
            // of `e` and the write itself is a no-op, so the faithful translation
            // is the RHS alone; a nested discard (`_ = (_ = e)`) unwinds through
            // the same branch recursively. Only a simple assignment can target a
            // discard (C# rejects compound forms like `_ += e`).
            if assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) &&
                assignment.Left is IdentifierNameSyntax{Identifier: {ValueText: "_"}} discardTarget &&
                this.IsTrueDiscard(discardTarget) {
                return this.TranslateExpression(assignment.Right)
            }
            var result GExpression? = AssignmentExpression(
                this.TranslateAssignmentTarget(assignment.Left),
                this.TranslateAssignmentValue(assignment),
                assignment.OperatorToken.Text
            )
            // A materialized non-null reference binder uses nullable storage
            // because its declaration precedes the guard. Its assignment result
            // still has the binder's non-null C# type.
            if assignment.Left is IdentifierNameSyntax identifier &&
                this
                .context
                .GetSymbolInfo(identifier)
                .Symbol is {} symbol &&
                this
                .state
                .PatternBindings
                .TryGetValue(symbol, out var replacement) &&
                replacement is NonNullAssertionExpression {
                result = EnsureNonNullAssertion(result)
            }
            return result
        }

        private func TranslateCoalescingAssignmentAsExpression(assignment AssignmentExpressionSyntax) GExpression? {
            let statements = List[GStatement]()
            let target GExpression? = this.MakeDuplicationSafeTarget(
                this.TranslateAssignmentTarget(assignment.Left)!!,
                statements,
                assignment.Left
            )
            let current GExpression? = this.SpillOperand(target!!, statements)
            let value = IfExpression(
                BinaryExpression(current, "==", LiteralExpression.Null()),
                AssignmentExpression(target, this.TranslateAssignmentValue(assignment)),
                current
            )
            // Issue #3774: G# `!!` is a CHECKED assertion that THROWS on nil, not
            // C#'s erased `!`, so an assertion here is faithful only when the
            // `??=` expression's value genuinely cannot be nil — and its value is
            // nil exactly when the right-hand side is. Roslyn's flow state proves
            // that in a nullable-ENABLED compilation, and
            // `NullableReferenceValueMayBeNull` reads the C# annotations. Neither
            // says anything in an OBLIVIOUS compilation, where a same-project
            // member the whole-program taint analysis promoted to `T?` still reads
            // as non-null — so `cache ??= Make()` (C#: yields null) gained a
            // guaranteed throw. Consult the promotion result too in that mode,
            // which is the same "can this be nil at runtime in G#" question the
            // rest of the bridge already asks; a literal / provably non-null RHS
            // keeps its assertion.
            let rightHandSideMayBeNil = this.NullableReferenceValueMayBeNull(assignment.Right) ||
                (this.IsObliviousCompilation() && this.IsNullablePromotedValue(assignment.Right))
            let result GExpression? = if this
                .context
                .GetTypeInfo(assignment)
                .Nullability
                .FlowState == Microsoft
                .CodeAnalysis
                .NullableFlowState
                .NotNull ||
                !rightHandSideMayBeNil {
                EnsureNonNullAssertion(value)
            } else {
                cast[GExpression](value)
            }
            return if statements.Count == 0 {
                result
            } else {
                cast[GExpression](BlockExpression(statements, result))
            }
        }

        private func TranslateSizeOf(sizeOf SizeOfExpressionSyntax) GExpression {
            // `sizeof(T)` for a primitive type is a compile-time constant; emit the
            // byte width directly (G# has no `sizeof` operator). For non-primitive
            // types fall back to the call-shaped form so the output still parses.
            let type ITypeSymbol? = this.context.GetTypeInfo(sizeOf.Type).Type
            let size int32? = switch type?.SpecialType {
                case SpecialType.System_Boolean or SpecialType.System_SByte or SpecialType.System_Byte: 1
                case SpecialType.System_Int16 or SpecialType.System_UInt16 or SpecialType.System_Char: 2
                case SpecialType.System_Int32 or SpecialType.System_UInt32 or SpecialType.System_Single: 4
                case SpecialType.System_Int64 or SpecialType.System_UInt64 or SpecialType.System_Double: 8
                case SpecialType.System_Decimal: 16
                default: nil
            }
            if (size != nil) {
                return LiteralExpression.Int(size.ToString(CultureInfo.InvariantCulture))
            }
            return InvocationExpression(
                IdentifierExpression("sizeof"),
                List[GExpression]{TypeExpression(this.MapTypeSyntax(sizeOf.Type))}
            )
        }

        private func GetArrayElementType(
            arrayExpression ExpressionSyntax,
            elementTypeSyntax TypeSyntax?
        ) GTypeReference? {
            let nullableElementSyntax = elementTypeSyntax is NullableTypeSyntax
            let info = this.context.GetTypeInfo(arrayExpression)
            let arrayType ITypeSymbol? = info.Type ?? info.ConvertedType
            if arrayType is IArrayTypeSymbol array && this.typeMapper.Map(
                array,
                this.context,
                arrayExpression.GetLocation()
            ) is ArrayTypeReference mappedArray {
                return if nullableElementSyntax {
                    MakeNullable(mappedArray.ElementType)
                } else {
                    mappedArray.ElementType
                }
            }
            if arrayType is INamedTypeSymbol{IsGenericType: true} generic && generic.TypeArguments.Length == 1 {
                let mapped GTypeReference? = this.typeMapper.Map(
                    generic.TypeArguments[0],
                    this.context,
                    arrayExpression.GetLocation()
                )
                return if nullableElementSyntax {
                    MakeNullable(mapped)
                } else {
                    mapped
                }
            }
            if elementTypeSyntax != nil {
                let mapped GTypeReference? = this.MapTypeSyntax(elementTypeSyntax)
                return if nullableElementSyntax {
                    MakeNullable(mapped)
                } else {
                    mapped
                }
            }
            return NamedTypeReference("object")
        }

        private func TranslateCollectionExpression(collection CollectionExpressionSyntax) GExpression {
            // An empty collection expression (`[]`) targeting a concrete
            // constructible collection class (e.g. `Dictionary<,> d = []`,
            // `List<T> l = []`) maps to a constructor call of that type. The slice
            // literal `[]T{ … }` only models arrays/spans; a `Dictionary`'s element
            // type is `KeyValuePair<,>`, whose generic `[...]` would otherwise be
            // emitted into a malformed `[]KeyValuePair[…]{}` literal (ADR-0115 §B).
            var target ITypeSymbol? = this
                .context
                .GetTypeInfo(collection)
                .ConvertedType ??
                this
                .context
                .GetTypeInfo(collection)
                .Type
            let originalElementType ITypeSymbol? = GetCollectionTargetElementType(target)
            if target is INamedTypeSymbol namedCollectionTarget {
                target = this.GetManagedReferenceArrayProjectedCollectionType(collection, namedCollectionTarget)
            }
            let isConstructibleClassTarget = target is INamedTypeSymbol namedTarget &&
                namedTarget.TypeKind == TypeKind.Class &&
                this
                .typeMapper
                .Map(namedTarget, this.context, collection.GetLocation()) is NamedTypeReference
            let targetRef NamedTypeReference? = if isConstructibleClassTarget {
                cast[NamedTypeReference](
                    this.typeMapper.Map(cast[INamedTypeSymbol](target), this.context, collection.GetLocation())
                )
            } else {
                default(NamedTypeReference?)
            }
            let collectionOperation ICollectionExpressionOperation? = this
                .context
                .SemanticModel
                .GetOperation(collection) as ICollectionExpressionOperation
            if collection.Elements.Count == 0 && isConstructibleClassTarget {
                return InvocationExpression(
                    IdentifierExpression(targetRef!!.Name),
                    List[GExpression](),
                    if targetRef!!.TypeArguments.Count > 0 {
                        targetRef!!.TypeArguments
                    } else {
                        default(IReadOnlyList[GTypeReference]?)
                    }
                )
            }
            let elementTypeSymbol ITypeSymbol? = GetCollectionTargetElementType(target)
            var elementType GTypeReference?
            if target is IArrayTypeSymbol targetArray && this.typeMapper.Map(
                targetArray,
                this.context,
                collection.GetLocation()
            ) is ArrayTypeReference mappedArray {
                elementType = mappedArray.ElementType
            } else {
                elementType = if elementTypeSymbol != nil {
                    this.typeMapper.Map(elementTypeSymbol, this.context, collection.GetLocation())
                } else {
                    this.GetCollectionElementType(collection)
                }
            }
            // A `List<T>`/`HashSet<T>`/... collection-expression target maps to
            // the canonical G# collection-initializer form (`List[int32]{...}`,
            // ADR-0117) — NOT the array/slice literal `[]T{...}`, which does not
            // convert to a constructed collection class (issue #1897). Issue
            // #3096: native `...source` elements keep this form initializer-safe.
            if isConstructibleClassTarget {
                let initElements = List[CollectionInitializerElement]()
                for var i = 0; i < collection.Elements.Count; i++ {
                    let element = collection.Elements[i]
                    if element is SpreadElementSyntax spread {
                        initElements.Add(
                            CollectionInitializerElement(
                                SpreadElementExpression(this.TranslateExpression(spread.Expression))
                            )
                        )
                    } else {
                        let expressionElement = cast[ExpressionElementSyntax](element)
                        let operationElementType ITypeSymbol? = collectionOperation?.Elements[i].Type
                        let boundElementType ITypeSymbol? = if operationElementType != nil &&
                            originalElementType != nil &&
                            !SymbolEqualityComparer
                            .Default
                            .Equals(operationElementType, originalElementType) {
                            operationElementType
                        } else {
                            this.GetCollectionAddParameterType(
                                collection,
                                target,
                                elementTypeSymbol ?? operationElementType
                            ) ??
                                elementTypeSymbol ??
                                operationElementType
                        }
                        let boundElementRef GTypeReference? = if boundElementType != nil {
                            this.typeMapper.Map(boundElementType, this.context, element.GetLocation())
                        } else {
                            elementType
                        }
                        initElements.Add(
                            CollectionInitializerElement(
                                this.CoerceCollectionElement(
                                    expressionElement.Expression,
                                    boundElementRef,
                                    boundElementType
                                )
                            )
                        )
                    }
                }
                return CollectionInitializerExpression(BuildConstruction(targetRef, List[GExpression]()), initElements)
            }
            // C# 12 collection expression `[a, b, c]` targeting an array/span.
            // The target type supplies the element type, so it maps to the
            // canonical G# slice literal `[]T{ … }` (ADR-0115 §B). Spreads map
            // directly to native G# ellipsis elements, with no statement-hosted
            // build/append temporary (issue #3096).
            //
            // Issue #3682: `[null, null, "d"]` writes a `nil` into the slice's
            // element type, which the C# target left non-nullable.
            //
            // Issue #3848 (family B): and the same widening when the generated
            // DECLARATION this literal is written into had its element slot
            // promoted, so the literal and the slot agree (gsc GS0155).
            let sliceElementType GTypeReference? = this.PromoteElementTypeForNullElements(
                elementType,
                elementTypeSymbol,
                collection
                    .Elements
                    .OfType[ExpressionElementSyntax]()
                    .Select((e ExpressionElementSyntax) -> e.Expression),
                collection
            )
            let sliceAcceptsNil = sliceElementType!!.IsNullable
            let elements = List[GExpression]()
            for element in collection.Elements {
                if element is SpreadElementSyntax spread {
                    elements.Add(SpreadElementExpression(this.TranslateExpression(spread.Expression)))
                } else {
                    let expressionElement = cast[ExpressionElementSyntax](element)
                    // Nullable elements still need their bound slot recorded
                    // before translating any explicit C# `!` inside them.
                    if elementTypeSymbol != nil {
                        this.state.CollectionElementSlots[expressionElement.Expression] = elementTypeSymbol
                    }
                    elements.Add(
                        if sliceAcceptsNil {
                            this.TranslateExpression(expressionElement.Expression)
                        } else {
                            this.CoerceCollectionElement(expressionElement.Expression, elementType, elementTypeSymbol)
                        }
                    )
                }
            }
            // An empty collection expression targeting a one-dimensional array
            // (`T[] a = []`) is lowered by csc to the cached `Array.Empty<T>()`
            // singleton, never a fresh zero-length array. A `[]T{}` literal would
            // allocate on every evaluation (24 bytes for a struct element), so a
            // migrated hot path such as `Gsharp.Runtime.Values`'
            // `ManagedLocationKey.Element` would allocate more than its C# source
            // (issue #4684). Mirror the C# lowering; an explicit `new T[0]` is a
            // distinct expression that keeps its literal.
            if collection
                .Elements
                .Count == 0 &&
                target is IArrayTypeSymbol &&
                target.Rank == 1 &&
                CanUseCachedEmptyArray(sliceElementType) &&
                !TryGetCollectionBuilder(target, out _, out _) {
                return MakeArrayEmptyInvocation(sliceElementType)
            }
            let slice = ArrayLiteralExpression(sliceElementType, elements)
            // Issue #3684 (F16): a `[CollectionBuilder]` target that is not a
            // constructible CLASS — `ImmutableArray<T>` and friends are STRUCTS,
            // so the collection-initializer path above never sees them — has no
            // conversion from the slice literal either (GS0155). C# itself
            // lowers such a collection expression to a call of the declared
            // builder factory, so emit that call directly, handing it the slice
            // (gsc's existing `[]T` → `ReadOnlySpan[T]` implicit conversion
            // covers the factory's span parameter).
            if TryGetCollectionBuilder(target, out var builderType, out var builderMethodName) && this.typeMapper.Map(
                builderType,
                this.context,
                collection.GetLocation()
            ) is NamedTypeReference builderRef {
                return InvocationExpression(
                    MemberAccessExpression(IdentifierExpression(builderRef.Name), builderMethodName),
                    List[GExpression]{slice},
                    List[GTypeReference]{sliceElementType!!}
                )
            }
            return slice
        }

        private func CoerceCollectionElement(
            element ExpressionSyntax,
            elementType GTypeReference?,
            targetElementSymbol ITypeSymbol?
        ) GExpression? {
            if targetElementSymbol != nil {
                this.state.CollectionElementSlots[element] = targetElementSymbol
            }
            // A bare integer literal in a typed-narrower array (`[0, 0]` into a
            // `byte[]`) needs an explicit G# conversion, since untyped numeric
            // literals do not auto-narrow. Wrap such elements in `T(elem)`.
            var translated GExpression? = this.TranslateExpression(element)
            let elementInfo = this.context.GetTypeInfo(element)
            let elementSymbol ITypeSymbol? = elementInfo.Type
            let convertedSymbol ITypeSymbol? = elementInfo.ConvertedType
            let declaredElementType ITypeSymbol? = this.GetDeclaredValueType(element)
            // Issue #4612: the collection the element is stored into, used only
            // to classify a reported bridge.
            let collectionType ITypeSymbol? = if element.Parent?.Parent is CollectionExpressionSyntax collection {
                this.context.GetTypeInfo(collection).ConvertedType
            } else {
                default(ITypeSymbol?)
            }
            translated = this.ForgiveNullableReferenceValue(
                element,
                translated,
                targetElementSymbol ?? convertedSymbol,
                targetSymbol: nil,
                reportedTarget: collectionType,
                reportedSlotType: targetElementSymbol
            )
            translated = this.AssertFlowNarrowedNullableReference(element, translated, elementType)
            if IsNullOrSuppressedNull(element) &&
                targetElementSymbol?.IsReferenceType == true &&
                targetElementSymbol!!.NullableAnnotation != Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                // C# permits this warning-level write. A typed default retains
                // the target's static type and the nil value without `!!`.
                return DefaultValueExpression(elementType)
            }
            if !IsNullOrSuppressedNull(element) && !this.IsWithinExpressionTreeLambda(element) &&
                targetElementSymbol?.IsReferenceType == true &&
                targetElementSymbol!!.NullableAnnotation != Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated &&
                elementInfo
                .Nullability
                .FlowState != Microsoft
                .CodeAnalysis
                .NullableFlowState
                .NotNull &&
                (
                elementInfo
                    .Nullability
                    .Annotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated ||
                    elementSymbol?.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated ||
                    declaredElementType?.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated
            ) {
                // Reported against the collection the element is stored into.
                translated = this.ReportStoreBridge(
                    element,
                    translated,
                    EnsureNonNullAssertion(translated),
                    collectionType,
                    targetElementSymbol
                )
            }
            let numericTarget ITypeSymbol? = targetElementSymbol ?? convertedSymbol
            if elementSymbol != nil && numericTarget != nil && !SymbolEqualityComparer.Default.Equals(
                elementSymbol,
                numericTarget
            ) &&
                IsPrimitiveNumeric(elementSymbol) &&
                IsPrimitiveNumeric(numericTarget) {
                return ConversionExpression(elementType, translated)
            }
            return translated
        }

        private func GetCollectionElementType(collection CollectionExpressionSyntax) GTypeReference? {
            let target ITypeSymbol? = this
                .context
                .GetTypeInfo(collection)
                .ConvertedType ??
                this
                .context
                .GetTypeInfo(collection)
                .Type
            let elementType ITypeSymbol? = GetCollectionTargetElementType(target)
            if elementType != nil {
                return this.typeMapper.Map(elementType, this.context, collection.GetLocation())
            }
            // No bound target type: fall back to the natural element type of the
            // first element, or `object` for an empty literal.
            let firstExpression ExpressionSyntax? = collection
                .Elements
                .OfType[ExpressionElementSyntax]()
                .Select((e ExpressionElementSyntax) -> e.Expression)
                .FirstOrDefault()
            if firstExpression != nil && this.context.GetTypeInfo(firstExpression).Type is {} natural {
                return this.typeMapper.Map(natural, this.context, collection.GetLocation())
            }
            return NamedTypeReference("object")
        }

        /// Issue #4525: a constructible collection's elements are bound through
        /// its `Add` method, so a nullable `Add(T?)` parameter keeps a
        /// legitimately null element from being asserted. Roslyn does not expose
        /// the bound Add method, and C# overload resolution (hiding, generic
        /// inference, extension methods, candidate sets spanning the hierarchy) is
        /// not modeled. The helper is therefore fail-safe: the nullable parameter
        /// is used only when exactly one accessible, non-generic, instance Add
        /// exists with no extension Add in scope. Any other shape with a nullable
        /// or default element reports Unsupported instead of guessing.
        /// @returns The nullable Add parameter type, or null when the element type stands.
        private func GetCollectionAddParameterType(
            collection CollectionExpressionSyntax,
            target ITypeSymbol?,
            elementType ITypeSymbol?
        ) ITypeSymbol? {
            if elementType == nil || target == nil {
                return nil
            }
            let nullableElement = collection
                .Elements
                .OfType[ExpressionElementSyntax]()
                .Any(
                (item ExpressionElementSyntax) -> IsNullOrDefaultLiteral(item.Expression) ||
                    this
                    .context
                    .GetTypeInfo(item.Expression)
                    .Type
                    ?.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated
            )
            let enclosing ISymbol? = this.context.SemanticModel.GetEnclosingSymbol(collection.SpanStart)
            let within = cast[ISymbol](enclosing?.ContainingType) ?? this.context.Compilation.Assembly
            let candidates = List[IMethodSymbol]()
            for var type ITypeSymbol? = target; type != nil; type = type!!.BaseType {
                for add in type.GetMembers("Add").OfType[IMethodSymbol]() {
                    if !add.IsStatic &&
                        add
                        .Parameters
                        .Length == 1 &&
                        this
                        .context
                        .Compilation
                        .IsSymbolAccessibleWithin(add, within) &&
                        !candidates
                        .Any(
                        (seen IMethodSymbol) -> !add.IsGenericMethod &&
                            !seen.IsGenericMethod &&
                            SymbolEqualityComparer
                            .Default
                            .Equals(seen.Parameters[0].Type, add.Parameters[0].Type)
                    ) {
                        candidates.Add(add)
                    }
                }
            }
            let hasExtensionAdd = this
                .context
                .SemanticModel
                .LookupSymbols(
                collection.SpanStart,
                container: cast[INamespaceOrTypeSymbol](target),
                name: "Add",
                includeReducedExtensionMethods: true
            )
                .OfType[IMethodSymbol]()
                .Any((method IMethodSymbol) -> method.MethodKind == MethodKind.ReducedExtension)
            let decidable = !hasExtensionAdd &&
                candidates.Count == 1 &&
                !candidates[0].IsGenericMethod &&
                SymbolEqualityComparer
                .Default
                .Equals(candidates[0].Parameters[0].Type, elementType)
            if !decidable {
                if nullableElement {
                    this.context.ReportUnsupported(
                        collection,
                        "collection expression element binds through an Add overload set whose nullability cannot be decided; no exact G# translation exists."
                    )
                }
                return nil
            }
            let parameterType = candidates[0].Parameters[0].Type
            return if parameterType.NullableAnnotation == Microsoft.CodeAnalysis.NullableAnnotation.Annotated {
                parameterType
            } else {
                default(ITypeSymbol?)
            }
        }

        private func GetManagedReferenceArrayProjectedCollectionType(
            collection CollectionExpressionSyntax,
            target INamedTypeSymbol
        ) INamedTypeSymbol {
            let originalElementType ITypeSymbol? = GetCollectionTargetElementType(target.OriginalDefinition)
            if originalElementType == nil {
                return target
            }
            let replacements = Dictionary[ITypeParameterSymbol, ITypeSymbol](SymbolEqualityComparer.Default)
            for collectionElement in collection.Elements {
                // A spread contributes its projected enumerable element type
                // exactly as a plain element contributes its own projected type.
                let projectedElement ITypeSymbol? = switch collectionElement {
                    case item is ExpressionElementSyntax: this.GetManagedReferenceArrayProjectedArgumentType(
                        item.Expression
                    )
                    case spread is SpreadElementSyntax: this.GetMappedArrayElementType(spread.Expression) ??
                        GetEnumerableElementType(this.GetManagedReferenceArrayProjectedArgumentType(spread.Expression))
                    default: default(ITypeSymbol?)
                }
                if projectedElement == nil {
                    continue
                }
                for parameter in NamedTypeAndContainingTypes(target).SelectMany(
                    func (type INamedTypeSymbol) IEnumerable[ITypeParameterSymbol] {
                        return type.OriginalDefinition.TypeParameters
                    }
                ) {
                    if !TryGetProjectedTypeArgument(
                        originalElementType,
                        projectedElement,
                        parameter,
                        this.context.Compilation,
                        out var replacement,
                        out var conflictingProjection
                    ) {
                        continue
                    }
                    if conflictingProjection ||
                        (
                        replacements.TryGetValue(parameter, out var existing) &&
                            !SymbolEqualityComparer
                            .IncludeNullability
                            .Equals(existing, replacement)
                    ) {
                        if this.IsRejectableManagedReferenceProjection(
                            switch collectionElement {
                                case item is ExpressionElementSyntax: item.Expression
                                case spread is SpreadElementSyntax: spread.Expression
                                default: cast[ExpressionSyntax](collection)
                            },
                            projectedElement,
                            nil
                        ) {
                            this.context.ReportUnsupported(
                                collection,
                                "collection expression elements have conflicting managed-reference projections."
                            )
                        }
                        return target
                    }
                    replacements[parameter] = replacement!!
                }
            }
            if replacements.Count == 0 {
                return target
            }
            let projected = ProjectNamedType(target, replacements)
            if this.ProjectedResultMatchesDestination(collection, projected, out _) {
                return projected
            }
            if this.ResolveValueSink(collection) is ILocalSymbol local && this.IsLocalDeclarationInitializer(
                collection,
                local
            ) {
                this.state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType[local] = projected
                return projected
            }
            if this.IsRejectableManagedReferenceProjection(collection, projected, target) {
                this.context.ReportUnsupported(
                    collection,
                    "collection expression managed-reference projection cannot change fixed destination storage; no exact G# translation exists."
                )
            }
            return target
        }

        // Issue #1896: gsc has its OWN native range-index syntax
        // (`recv[start..end]` / `recv[..end]` / `recv[start..]` / `recv[..]`,
        // with `^n` from-end bounds on either side — Parser.ParseIndexArgument /
        // ParseIndexBound) and its binder (BindRangeSlice) resolves it directly
        // against arrays, `string`, and any CLR span-like type with a
        // `Length`+`Slice(int,int)` shape or a `System.Range` indexer — the same
        // set of receivers C# itself allows a range index against. So the
        // C# range index needs no desugaring at all: it round-trips to the
        // identical native G# form (`GExpression.IndexExpression` wrapping a
        // `RangeIndexExpression`, already used by the issue #1889 list-pattern
        // slice lowering below). This also drops #1894's `Length`-arithmetic
        // and receiver-spill workarounds entirely — gsc's own `^n` bound
        // handles from-end offsets and the receiver is only ever embedded once.
        private func TranslateRangeSlice(receiver GExpression?, $range RangeExpressionSyntax) GExpression {
            let start GExpression? = if $range.LeftOperand != nil {
                this.TranslateRangeBound($range.LeftOperand)
            } else {
                default(GExpression?)
            }
            let end GExpression? = if $range.RightOperand != nil {
                this.TranslateRangeBound($range.RightOperand)
            } else {
                default(GExpression?)
            }
            return IndexExpression(receiver, RangeIndexExpression(start, end))
        }

        private func TranslateRangeBound(bound ExpressionSyntax?) GExpression? -> this.TranslateExpression(bound)

        private func ResolveExpressionType(expression ExpressionSyntax) GTypeReference? {
            let info = this.context.GetTypeInfo(expression)
            var type ITypeSymbol? = info.ConvertedType ?? info.Type
            // Issue #1894 regression: a range-slice bound (e.g. the `Next()` in
            // `Data[Next()..2]`) is implicitly converted by the C# compiler to
            // `System.Index` purely because it sits inside a `Range`-indexer
            // argument list — the value itself is, and always was, an `int`.
            // `TranslateRangeSlice` already re-lowers the whole range to its
            // own native `RangeIndexExpression` (with `^n` bounds emitted as
            // `FromEndIndexExpression`) before this operand is ever typed, so
            // that Index/Range conversion is a compiler-internal artifact, never
            // an actual value the translation carries forward. Falling back to
            // the operand's own natural type here avoids gapping perfectly valid
            // int-typed range bounds as "Index has no canonical G# type".
            if CSharpTypeMapper.IsSystemIndexOrRange(type) &&
                info.Type != nil &&
                !CSharpTypeMapper.IsSystemIndexOrRange(info.Type) {
                type = info.Type
            }
            if type == nil || type.SpecialType == SpecialType.System_Void || type.TypeKind == TypeKind.Error {
                return nil
            }
            return this.typeMapper.Map(type, this.context, expression.GetLocation())
        }

        shared {
            private func FindLeadingElementBinding(
                expression ExpressionSyntax
            ) ElementBindingExpressionSyntax? -> switch expression {
                case elementBinding is ElementBindingExpressionSyntax: elementBinding
                case parenthesized is ParenthesizedExpressionSyntax: FindLeadingElementBinding(parenthesized.Expression)
                case invocation is InvocationExpressionSyntax: FindLeadingElementBinding(invocation.Expression)
                case memberAccess is MemberAccessExpressionSyntax: FindLeadingElementBinding(memberAccess.Expression)
                case elementAccess is ElementAccessExpressionSyntax: FindLeadingElementBinding(elementAccess.Expression)
                default: default(ElementBindingExpressionSyntax?)
            }

            /// Issue #3700: matches a conditional-access continuation that is rooted
            /// at a null-conditional INDEX (`a?[i].B`, `a?[i].M()`,
            /// `a?[i][j]`) and carries at least one further postfix step.
            /// @remarks gsc parses `?.` and `?[` asymmetrically: the member form
            /// takes the whole trailing chain as its guarded continuation, while the
            /// index form is one postfix step whose result is `T?`. Printing the
            /// C# shape flat therefore says `(a?[i]).B` to gsc, which rejects
            /// the dereference. Asserting the index result instead
            /// (`a?[i]!!.B`) would be actively wrong: it throws when `a`
            /// itself is nil, which is the case `?[` exists to short-circuit.
            /// @param whenNotNull The conditional-access continuation.
            /// @param elementBinding The leading `?[i]` binding when matched.
            /// @returns `true` when the continuation must be re-split.
            private func TryFindConditionalIndexContinuation(
                whenNotNull ExpressionSyntax,
                out elementBinding ElementBindingExpressionSyntax?
            ) bool {
                elementBinding = nil
                for var current ExpressionSyntax? = whenNotNull; current != nil; {
                    switch current {
                        case parenthesized is ParenthesizedExpressionSyntax {
                            current = parenthesized.Expression
                            continue
                        }
                        case nested is ConditionalAccessExpressionSyntax {
                            current = nested.Expression
                            continue
                        }
                        case invocation is InvocationExpressionSyntax {
                            current = invocation.Expression
                            continue
                        }
                        case memberAccess is MemberAccessExpressionSyntax {
                            current = memberAccess.Expression
                            continue
                        }
                        case elementAccess is ElementAccessExpressionSyntax {
                            current = elementAccess.Expression
                            continue
                        }
                        case binding is ElementBindingExpressionSyntax {
                            elementBinding = binding
                            current = nil
                            continue
                        }
                        default {
                            return false
                        }
                    }
                }
                // Fire only when the step DIRECTLY after the index is an ordinary
                // `.` / `[`. A bare `a?[i]` needs no second seam, and `a?[i]?.b`
                // already has one (re-splitting it would print `[i]??.b`).
                return elementBinding != nil &&
                    (
                    (
                        elementBinding.Parent is MemberAccessExpressionSyntax member &&
                            member.Expression == elementBinding
                    ) ||
                        (
                        elementBinding.Parent is ElementAccessExpressionSyntax element &&
                            element.Expression == elementBinding
                    )
                )
            }

            private func FindConditionalAccessResult(
                expression ExpressionSyntax
            ) ExpressionSyntax -> switch expression {
                case parenthesized is ParenthesizedExpressionSyntax: FindConditionalAccessResult(
                    parenthesized.Expression
                )
                case conditionalAccess is ConditionalAccessExpressionSyntax: FindConditionalAccessResult(
                    conditionalAccess.WhenNotNull
                )
                default: expression
            }

            // Issue #3555: true when a property subpattern's value is itself a
            // type-matching pattern that tests MEMBERS of the narrowed value — the
            // shape guard-lowering cannot express (see TranslateIsPattern).
            private func PatternRequiresNestedTypeNarrowing(pattern PatternSyntax) bool {
                switch pattern {
                    case recursive is RecursivePatternSyntax {
                        for subpattern in recursive
                            .PropertyPatternClause
                            ?.Subpatterns ??
                            default(SeparatedSyntaxList[SubpatternSyntax]) {
                            if subpattern.Pattern is RecursivePatternSyntax{Type: not nil} nestedTyped &&
                                (
                                nestedTyped.PropertyPatternClause is {Subpatterns: {Count: > 0}} ||
                                    nestedTyped.PositionalPatternClause is {Subpatterns: {Count: > 0}}
                            ) {
                                return true
                            }
                            if PatternRequiresNestedTypeNarrowing(subpattern.Pattern) {
                                return true
                            }
                        }
                        for subpattern in recursive
                            .PositionalPatternClause
                            ?.Subpatterns ??
                            default(SeparatedSyntaxList[SubpatternSyntax]) {
                            if PatternRequiresNestedTypeNarrowing(subpattern.Pattern) {
                                return true
                            }
                        }
                        return false
                    }
                    case unary is UnaryPatternSyntax {
                        return PatternRequiresNestedTypeNarrowing(unary.Pattern)
                    }
                    case binary is BinaryPatternSyntax {
                        return PatternRequiresNestedTypeNarrowing(binary.Left) ||
                            PatternRequiresNestedTypeNarrowing(binary.Right)
                    }
                    case parenthesized is ParenthesizedPatternSyntax {
                        return PatternRequiresNestedTypeNarrowing(parenthesized.Pattern)
                    }
                    default {
                        return false
                    }
                }
            }

            // See <see cref="TranslateIsPattern"/>: true when translating `pattern`
            // against its scrutinee embeds the scrutinee at MOST one time, so no
            // spill is needed regardless of whether the scrutinee is trivial.
            private func PatternReadsScrutineeAtMostOnce(pattern PatternSyntax?) bool -> switch pattern {
                case _ is ConstantPatternSyntax: true
                case _ is RelationalPatternSyntax: true
                case unary is UnaryPatternSyntax: PatternReadsScrutineeAtMostOnce(unary.Pattern)
                case parenthesized is ParenthesizedPatternSyntax: PatternReadsScrutineeAtMostOnce(parenthesized.Pattern)
                case _ is DeclarationPatternSyntax: false
                case recursive is RecursivePatternSyntax: recursive.Designation == nil &&
                    recursive.PropertyPatternClause == nil &&
                    recursive.PositionalPatternClause == nil
                case _ is VarPatternSyntax: false
                case _ is BinaryPatternSyntax: false
                default: false
            }

            private func IsNullableValueType(type ITypeSymbol?) bool -> type
                ?.OriginalDefinition
                ?.SpecialType == SpecialType.System_Nullable_T

            // Issue #1889: the materialized slice value for a list pattern's `..`
            // element — `receiver[prefix..^suffix]` (open at whichever end has a
            // zero count), matching gsc's own array-slice binder (BindArraySlice).
            private func BuildSliceExpression(receiver GExpression?, prefixCount int32, suffixCount int32) GExpression {
                let start GExpression? = if prefixCount == 0 {
                    default(LiteralExpression?)
                } else {
                    LiteralExpression.Int(prefixCount.ToString())
                }
                let end GExpression? = if suffixCount == 0 {
                    default(FromEndIndexExpression?)
                } else {
                    FromEndIndexExpression(LiteralExpression.Int(suffixCount.ToString()))
                }
                return IndexExpression(receiver, RangeIndexExpression(start, end))
            }

            private func FindSlicePatternIndex(elements SeparatedSyntaxList[PatternSyntax]) int32 {
                for var i = 0; i < elements.Count; i++ {
                    if elements[i] is SlicePatternSyntax {
                        return i
                    }
                }
                return -1
            }

            private func PositionalSubpatternGapMessage(
                prefix string,
                failureReason string?
            ) string -> if failureReason == nil {
                "$prefix has no canonical G# form yet (ADR-0115 §B)."
            } else {
                "$prefix has no canonical G# form yet (ADR-0115 §B): $failureReason."
            }

            private func TryGetNonNegativeInt32(value object?, out result int32) bool {
                let candidate = switch value {
                    case item is int8: int64(item)
                    case item is uint8: int64(item)
                    case item is int16: int64(item)
                    case item is uint16: int64(item)
                    case item is char: int64(item)
                    case item is int32: int64(item)
                    case item is uint32 when item <= uint32(int32.MaxValue): int64(item)
                    case item is int64 when item >= int64(0) && item <= int64(int32.MaxValue): item
                    case item is uint64 when item <= uint64(int32.MaxValue): int64(item)
                    default: int64(-1)
                }
                if candidate >= int64(0) && candidate <= int64(int32.MaxValue) {
                    result = int32(candidate)
                    return true
                }
                result = 0
                return false
            }

            /// Recursively walks a rectangular multi-dim initializer
            /// (`{{1, 2, 3}, {4, 5, 6}}`), recording each level's element count
            /// into [`dims`](paramref) (once, from the first branch — C#
            /// guarantees every branch at a level is the same length) and
            /// collecting the leaf value expressions into [`leaves`](paramref)
            /// in row-major order.
            private func FlattenRectangularArrayInitializer(
                node InitializerExpressionSyntax?,
                level int32,
                rank int32,
                dims[]int32,
                leaves List[ExpressionSyntax]
            ) {
                dims[level] = node!!.Expressions.Count
                if level == rank - 1 {
                    leaves.AddRange(node!!.Expressions)
                    return
                }
                for child in node!!.Expressions {
                    FlattenRectangularArrayInitializer(
                        cast[InitializerExpressionSyntax](child),
                        level + 1,
                        rank,
                        dims,
                        leaves
                    )
                }
            }

            private func GetCollectionElementTypeSymbol(type ITypeSymbol?) ITypeSymbol? -> switch type {
                case array is IArrayTypeSymbol: array.ElementType
                case pointer is IPointerTypeSymbol: pointer.PointedAtType
                case INamedTypeSymbol{TypeArguments: {Length: > 0}} named: named.TypeArguments[0]
                default: default(ITypeSymbol?)
            }

            private func CanUseCachedEmptyArray(elementType GTypeReference?) bool -> !(
                (elementType is PointerTypeReference || elementType is FunctionPointerTypeReference)
            )

            private func MakeArrayEmptyInvocation(
                elementType GTypeReference?
            ) InvocationExpression -> InvocationExpression(
                MemberAccessExpression(MemberAccessExpression(IdentifierExpression("System"), "Array"), "Empty"),
                List[GExpression](),
                List[GTypeReference]{elementType!!}
            )

            /// The `[CollectionBuilder(typeof(B), "M")]` factory declared on a
            /// collection-expression target, when the target carries one and the
            /// named factory is a single-type-parameter generic method (the only
            /// shape whose call cs2gs can spell without inferring anything).
            /// @param target The collection expression's target type.
            /// @param builderType Receives the builder type.
            /// @param methodName Receives the factory method name.
            /// @returns `true` when a usable builder was found.
            private func TryGetCollectionBuilder(
                target ITypeSymbol?,
                out builderType INamedTypeSymbol?,
                out methodName string?
            ) bool {
                builderType = nil
                methodName = nil
                if target is not INamedTypeSymbol named {
                    return false
                }
                for attribute in named.OriginalDefinition.GetAttributes() {
                    if attribute
                        .AttributeClass
                        ?.Name != "CollectionBuilderAttribute" ||
                        !(
                        attribute.ConstructorArguments is [
                            {Value: INamedTypeSymbol declaredBuilder},
                            {Value: string declaredMethod}
                        ]
                    ) {
                        continue
                    }
                    if !declaredBuilder
                        .GetMembers(declaredMethod)
                        .OfType[IMethodSymbol]()
                        .Any((m IMethodSymbol) -> m.IsStatic && m.Arity == 1) {
                        continue
                    }
                    builderType = declaredBuilder
                    methodName = declaredMethod
                    return true
                }
                return false
            }

            private func IsPrimitiveNumeric(type ITypeSymbol?) bool -> switch type!!.SpecialType {
                case SpecialType.System_SByte or
                    SpecialType.System_Byte or
                    SpecialType.System_Int16 or
                    SpecialType.System_UInt16 or
                    SpecialType.System_Int32 or
                    SpecialType.System_UInt32 or
                    SpecialType.System_Int64 or
                    SpecialType.System_UInt64 or
                    SpecialType.System_Single or
                    SpecialType.System_Double or
                    SpecialType.System_Decimal or
                    SpecialType.System_Char: true
                default: false
            }

            private func GetCollectionTargetElementType(
                target ITypeSymbol?
            ) ITypeSymbol? -> if IsSpanParamsCollectionType(target) {
                (cast[INamedTypeSymbol](target)).TypeArguments[0]
            } else {
                GetEnumerableElementType(target)
            }

            private func GetEnumerableElementType(type ITypeSymbol?, asynchronous bool = false) ITypeSymbol? {
                switch type {
                    case nil {
                        return nil
                    }
                    case array is IArrayTypeSymbol {
                        return array.ElementType
                    }
                    case named is INamedTypeSymbol {
                        if IsEnumerableContract(named, asynchronous) {
                            return named.TypeArguments[0]
                        }
                        for iface in named.AllInterfaces {
                            if IsEnumerableContract(iface, asynchronous) {
                                return iface.TypeArguments[0]
                            }
                        }
                        return nil
                    }
                    default {
                        return nil
                    }
                }
            }

            private func IsEnumerableContract(type INamedTypeSymbol, asynchronous bool) bool {
                let definition = type.OriginalDefinition
                if !asynchronous {
                    return definition.SpecialType == SpecialType.System_Collections_Generic_IEnumerable_T
                }
                let genericNamespace INamespaceSymbol? = definition.ContainingNamespace
                let collectionsNamespace INamespaceSymbol? = genericNamespace?.ContainingNamespace
                let systemNamespace INamespaceSymbol? = collectionsNamespace?.ContainingNamespace
                return definition.MetadataName == "IAsyncEnumerable`1" &&
                    genericNamespace?.Name == "Generic" &&
                    collectionsNamespace?.Name == "Collections" &&
                    systemNamespace?.Name == "System" &&
                    systemNamespace!!
                    .ContainingNamespace
                    .IsGlobalNamespace
            }
        }
    }
}
