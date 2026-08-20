// <copyright file="CSharpToGSharpTranslator.Patterns.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using Microsoft.CodeAnalysis.Text;

namespace Cs2Gs.Translator;

public sealed partial class CSharpToGSharpTranslator
{
    private sealed partial class DeclarationVisitor
    {
        private GExpression TranslateExpression(ExpressionSyntax expression)
        {
            if (this.state.HoistedExpressionValues.TryGetValue(expression, out GExpression hoistedValue))
            {
                return hoistedValue;
            }

            switch (expression)
            {
                case LiteralExpressionSyntax literal:
                    return this.TranslateLiteral(literal);

                case IdentifierNameSyntax identifier:
                    return this.TranslateIdentifierName(identifier);

                case RefExpressionSyntax refExpression:
                    return this.TranslateRefExpression(refExpression);

                case GenericNameSyntax generic:
                    // A generic name used as an expression is most often a generic
                    // *method* group (`Method<T>(...)`), whose bracket type arguments
                    // are applied by the enclosing invocation — there the bare
                    // identifier is correct. But it can also be a constructed generic
                    // *type* used as the receiver of a static member access
                    // (`Mp4Operation<ChapterInfo?>.FromCompleted(...)`); dropping the
                    // type arguments there picks the wrong (non-generic) overload
                    // (GS0144). Render the type with its arguments as `T[args]` so the
                    // static member resolves on the constructed generic type.
                    if (this.context.GetSymbolInfo(generic).Symbol is INamedTypeSymbol genericType)
                    {
                        GTypeReference typeRef = this.typeMapper.Map(
                            genericType, this.context, generic.GetLocation());
                        return new TypeExpression(typeRef);
                    }

                    return new IdentifierExpression(this.EmittedName(
                        this.context.GetSymbolInfo(generic).Symbol,
                        generic.Identifier.ValueText));

                case ThisExpressionSyntax:
                    return new ThisExpression();

                case BaseExpressionSyntax:
                    // Issue #986: C# `base.M(...)` maps directly to the G#
                    // base-class call form `base.M(...)`, which emits a
                    // non-virtual `call` into the base implementation. The
                    // `base` receiver is rendered as a bare identifier; the
                    // enclosing member-access / invocation supplies the `.M(...)`.
                    return new IdentifierExpression("base");

                case MemberAccessExpressionSyntax member:
                    return this.TranslateMemberAccess(member);

                case InvocationExpressionSyntax invocation:
                    return this.TranslateInvocation(invocation);

                case ObjectCreationExpressionSyntax creation:
                    return this.TranslateObjectCreation(creation);

                case CastExpressionSyntax cast:
                    return this.TranslateCast(cast);

                case WithExpressionSyntax with:
                    return this.TranslateWith(with);

                case BinaryExpressionSyntax binary
                    when binary.IsKind(SyntaxKind.AsExpression) || binary.IsKind(SyntaxKind.IsExpression):
                    // `e as T` / `e is T`: the right operand is a type. Render it as
                    // a type expression so array/qualified types map to canonical G#
                    // (e.g. `o as []object`, `o is []object`).
                    return new BinaryExpression(
                        this.TranslateExpression(binary.Left),
                        binary.OperatorToken.Text,
                        new TypeExpression(binary.Right is TypeSyntax typeOperand
                            ? this.MapTypeSyntax(typeOperand)
                            : new NamedTypeReference(binary.Right.ToString())));

                case BinaryExpressionSyntax binary:
                    // Issue #941: C# null-coalescing `a ?? b` now maps directly to
                    // G#'s `a ?? b` (the operator token text is identical), so it
                    // flows through the generic binary translation below.
                    return this.TranslateBinaryExpression(binary);

                case PrefixUnaryExpressionSyntax prefix:
                    if (prefix.IsKind(SyntaxKind.PreIncrementExpression)
                        || prefix.IsKind(SyntaxKind.PreDecrementExpression))
                    {
                        // ADR-0126 defines compound assignments as value-producing,
                        // so this preserves both the mutation and prefix result.
                        return new AssignmentExpression(
                            this.TranslateExpression(prefix.Operand),
                            LiteralExpression.Int("1"),
                            prefix.IsKind(SyntaxKind.PreIncrementExpression) ? "+=" : "-=");
                    }

                    // Issue #1894: a C# from-end index `^n` (SyntaxKind.IndexExpression)
                    // shares its `^` token with bitwise complement, and gsc's own G#
                    // grammar only recognises a bare `^n` as "from-end" INSIDE an
                    // index bracket (Parser.ParseIndexBound) — everywhere else `^n`
                    // parses as the one's-complement operator. G# has no
                    // `System.Index` value type, so a from-end index printed outside
                    // a direct `[...]`/`?[...]` bracket (bound to a local, passed as
                    // an argument, returned, used as a range bound, ...) would
                    // silently re-bind to the wrong (complemented) integer instead of
                    // gapping loudly. Only the direct bracket-argument position is
                    // safe to emit as a bare `^n`; every other position reports a gap.
                    if (prefix.IsKind(SyntaxKind.IndexExpression) && !IsDirectIndexBracketArgument(prefix))
                    {
                        this.context.Report(new TranslationDiagnostic(
                            "IndexExpression",
                            "a from-end index '^n' has no canonical G# form outside a direct '[...]' index bracket: G# has no 'System.Index' value type, so storing, returning, or otherwise reusing '^n' apart from the bracket it indexes cannot preserve from-end semantics (issue #1894).",
                            prefix.GetLocation(),
                            TranslationSeverity.Unsupported));
                        return LiteralExpression.Int("0");
                    }

                    // G# uses the Go-style `^` for bitwise complement; C# spells it
                    // `~`. Every other prefix operator token is identical.
                    string prefixOp = prefix.IsKind(SyntaxKind.BitwiseNotExpression)
                        ? "^"
                        : prefix.OperatorToken.Text;
                    return new UnaryExpression(
                        prefixOp,
                        this.TranslateExpression(prefix.Operand));

                case ParenthesizedExpressionSyntax parenthesized:
                    return new ParenthesizedExpression(this.TranslateExpression(parenthesized.Expression));

                case CheckedExpressionSyntax checkedExpr:
                    // Issue #1881: `checked(expr)`/`unchecked(expr)` maps directly to
                    // the G# `checked(...)`/`unchecked(...)` expression (gsc now
                    // supports both natively).
                    return new CheckedExpression(
                        this.TranslateExpression(checkedExpr.Expression),
                        checkedExpr.IsKind(SyntaxKind.CheckedExpression));

                case InterpolatedStringExpressionSyntax interpolated:
                    return this.TranslateInterpolatedString(interpolated);

                case TupleExpressionSyntax tuple:
                    return new TupleLiteralExpression(
                        tuple.Arguments.Select(a => this.TranslateValueWithNullForgiveness(a.Expression)).ToList());

                case AnonymousObjectCreationExpressionSyntax anonymous:
                    return this.TranslateAnonymousObjectCreation(anonymous);

                case ElementAccessExpressionSyntax elementAccess:
                    if (elementAccess.ArgumentList.Arguments.Count == 1 &&
                        elementAccess.ArgumentList.Arguments[0].Expression is RangeExpressionSyntax sliceRange)
                    {
                        // `span[a..b]` / `span[..n]` / `span[i..]`: gsc has its own
                        // native range-index operator (Issue #1896), so lower
                        // directly to that same `recv[start..end]` form instead
                        // of desugaring to `Slice`.
                        return this.TranslateRangeSlice(
                            this.TranslateReceiverWithNullForgiveness(elementAccess.Expression),
                            sliceRange);
                    }

                    // Issue #1893: a multi-index access (`grid[r, c, ...]`) against
                    // a genuine multi-dim array (Rank > 1) needs every index — the
                    // single-index path below only ever reads argument 0.
                    if (elementAccess.ArgumentList.Arguments.Count > 1 &&
                        this.context.GetTypeInfo(elementAccess.Expression).Type is IArrayTypeSymbol { Rank: > 1 })
                    {
                        return this.TranslateMultiDimElementAccess(elementAccess);
                    }

                    // Issue #1987: `list[i]` against a ref-returning indexer
                    // (`ref T this[int i]`) DECLARED IN THE TRANSLATED SOURCE
                    // (as opposed to a BCL type like `Span<T>`, whose
                    // ref-returning indexer gsc's binder already auto-
                    // dereferences via `BoundClrIndexExpression` +
                    // `AutoDereferenceRefReturn` — that shape is genuinely
                    // gap-free and must keep translating as-is). A ref-
                    // returning indexer declared in the C# project being
                    // translated has no gsc counterpart at all: G#'s own
                    // `prop this[i T] U` indexer syntax has no ref-return
                    // modifier, so the element access below would lower to a
                    // plain call-under-index that gsc rejects with a generic
                    // compile error instead of a precise gap. Detect it here.
                    if (this.context.GetSymbolInfo(elementAccess).Symbol is IPropertySymbol { RefKind: not RefKind.None } refIndexer &&
                        refIndexer.Locations.Any(l => l.IsInSource))
                    {
                        this.context.ReportUnsupported(
                            elementAccess,
                            $"element access '{elementAccess}' targets ref-returning indexer '{refIndexer.ContainingType?.Name}.this[]' which has no canonical G# form yet: G#'s user-defined indexer syntax has no ref-return modifier, so aliasing its element via a plain index expression would drop the ref semantics (issue #1987).");
                        return new IdentifierExpression("nil");
                    }

                    GExpression index = elementAccess.ArgumentList.Arguments.Count > 0
                        ? this.CoerceIndexToInt32(
                            elementAccess,
                            this.TranslateIndexArgumentWithNullForgiveness(
                                elementAccess.ArgumentList.Arguments[0]))
                        : new IdentifierExpression("nil");
                    return new IndexExpression(
                        this.TranslateReceiverWithNullForgiveness(elementAccess.Expression),
                        index);

                case SimpleLambdaExpressionSyntax simpleLambda:
                    return this.TranslateContextualLambda(simpleLambda);

                case ParenthesizedLambdaExpressionSyntax parenLambda:
                    return this.TranslateContextualLambda(parenLambda);

                // `delegate (params) { … }` is semantically a block-bodied lambda
                // (C# spec §12.19); route it through the same lowering rather than
                // a parallel path so closures, spills, and mutability scoping all
                // just work (issue #1898).
                case AnonymousMethodExpressionSyntax anonymousMethod:
                    return this.TranslateContextualLambda(anonymousMethod);

                case AwaitExpressionSyntax awaitExpression:
                    return new AwaitExpression(this.TranslateExpression(awaitExpression.Expression));

                case SwitchExpressionSyntax switchExpression:
                    return this.TranslateSwitchExpression(switchExpression);

                case ConditionalExpressionSyntax conditional:
                    // ADR-0169 analyzer mode: the Roslyn location-picking
                    // ternary lowers to G#'s Symbol.Location.
                    if (this.InAnalyzerApiMode
                        && this.TryTranslateAnalyzerLocationsTernary(conditional, out GExpression analyzerLocation))
                    {
                        return analyzerLocation;
                    }

                    // A C# ternary `cond ? a : b` maps to the canonical G#
                    // value-position `if` expression `if cond { a } else { b }`
                    // (ADR-0064, sample IfExpression.gs; ADR-0115 §B).
                    return this.TranslateConditionalExpression(conditional);

                case QueryExpressionSyntax query:
                    return this.TranslateQuery(query);

                case ImplicitObjectCreationExpressionSyntax implicitCreation:
                    return this.TranslateImplicitObjectCreation(implicitCreation);

                case PredefinedTypeSyntax predefinedType:
                    return this.TranslatePredefinedTypeExpression(predefinedType);

                case ConditionalAccessExpressionSyntax conditionalAccess:
                    // ADR-0169 analyzer mode: `namespaceSymbol?.ToDisplayString()`
                    // collapses to the receiver — G#'s ContainingNamespace is
                    // already the (nullable) display string.
                    if (this.InAnalyzerApiMode
                        && this.TryTranslateAnalyzerConditionalDisplay(conditionalAccess, out GExpression analyzerDisplay))
                    {
                        return analyzerDisplay;
                    }

                    if (this.TryTranslateNullConditionalStaticExtensionHelper(
                            conditionalAccess,
                            out GExpression enumExtResult))
                    {
                        return enumExtResult;
                    }

                    if (this.RequiresLocalAssignmentSeam(conditionalAccess.WhenNotNull))
                    {
                        return this.TranslateConditionalAccessWithLocalAssignmentSeam(
                            conditionalAccess);
                    }

                    if (DependsOnEnclosingConditionalReceiver(conditionalAccess.Expression)
                        && FindLeadingElementBinding(conditionalAccess.WhenNotNull)
                            is ElementBindingExpressionSyntax conditionalIndexBinding
                        && !this.ConditionalIndexReceiverIsNullable(conditionalAccess.Expression))
                    {
                        return this.TranslateNonNullableConditionalIndex(
                            conditionalAccess.WhenNotNull,
                            conditionalIndexBinding,
                            this.TranslateExpression(conditionalAccess.Expression));
                    }

                    return new ConditionalAccessExpression(
                        this.TranslateExpression(conditionalAccess.Expression),
                        this.TranslateExpression(conditionalAccess.WhenNotNull));

                case MemberBindingExpressionSyntax memberBinding:
                    // Issue #1879: `word?.DoubledLength` binds to the same
                    // instance extension property as `word.DoubledLength`
                    // (lowered to a get-only receiver-clause `func`,
                    // ADR-0115 §B.19); the call-site rewrite `TranslateMemberAccess`
                    // applies to the plain form must also apply here, or the
                    // print emits a bare property-style access on a func member
                    // — a silent-wrong `?.` read.
                    string bindingMemberName = this.GetPatternMemberName(memberBinding.Name);
                    string emittedBindingMemberName = this.EmittedName(
                        this.GetPatternMemberSymbol(memberBinding),
                        bindingMemberName);
                    if (this.GetPatternMemberSymbol(memberBinding) is IPropertySymbol extBindingProperty
                        && !extBindingProperty.IsStatic
                        && TryGetExtensionBlockOwner(extBindingProperty, out _))
                    {
                        return new InvocationExpression(
                            new MemberAccessExpression(
                                this.state.ConditionalReceiverReplacement ??
                                    new ConditionalReceiverExpression(),
                                emittedBindingMemberName),
                            new List<GExpression>(),
                            null);
                    }

                    // The `.b` continuation normally uses the empty conditional
                    // receiver; static-helper prefix rebuilding temporarily
                    // supplies the guarded receiver instead.
                    return new MemberAccessExpression(
                        this.state.ConditionalReceiverReplacement ??
                            new ConditionalReceiverExpression(),
                        emittedBindingMemberName);

                case ElementBindingExpressionSyntax elementBinding:
                    GExpression bindingReceiver =
                        this.state.ConditionalElementReceivers.TryGetValue(
                            elementBinding,
                            out GExpression elementReceiver)
                                ? elementReceiver
                                : this.state.ConditionalReceiverReplacement ??
                                    new ConditionalReceiverExpression();
                    if (elementBinding.ArgumentList.Arguments.Count == 1 &&
                        elementBinding.ArgumentList.Arguments[0].Expression is RangeExpressionSyntax conditionalRange)
                    {
                        return this.TranslateRangeSlice(bindingReceiver, conditionalRange);
                    }

                    GExpression bindingIndex = elementBinding.ArgumentList.Arguments.Count > 0
                        ? this.TranslateIndexArgumentWithNullForgiveness(
                            elementBinding.ArgumentList.Arguments[0])
                        : new IdentifierExpression("nil");
                    return new IndexExpression(bindingReceiver, bindingIndex);

                case TypeOfExpressionSyntax typeOf:
                    return new TypeOfExpression(this.MapTypeOfOperand(typeOf.Type));

                case DefaultExpressionSyntax explicitDefault:
                    return new DefaultValueExpression(this.MapTypeSyntax(explicitDefault.Type));

                case IsPatternExpressionSyntax isPattern:
                    return this.TranslateIsPattern(isPattern);

                case ArrayCreationExpressionSyntax arrayCreation:
                    return this.TranslateArrayCreation(arrayCreation);

                case ImplicitArrayCreationExpressionSyntax implicitArray:
                    return this.TranslateImplicitArrayCreation(implicitArray);

                case InitializerExpressionSyntax initializer:
                    return this.TranslateInitializerExpression(initializer);

                case SizeOfExpressionSyntax sizeOf:
                    return this.TranslateSizeOf(sizeOf);

                case AliasQualifiedNameSyntax aliasQualified:
                    // `global::System` → drop the `global::` alias and keep the name.
                    return new IdentifierExpression(this.EmittedName(
                        aliasQualified.Name,
                        aliasQualified.Name.Identifier));

                case AssignmentExpressionSyntax nestedAssignment:
                    // A value-position deconstruction assignment may already have
                    // been lowered into statements by its enclosing seam.
                    if (this.state.SuppressedAssignments.Contains(nestedAssignment))
                    {
                        // A property/indexer/non-trivial target cannot be read back:
                        // doing so can invoke a getter, fail for set-only storage, or
                        // re-evaluate its receiver/index. FlattenChainedAssignment
                        // captured the converted RHS before writing it; return that
                        // exact assignment result.
                        if (this.state.AssignmentValues.TryGetValue(
                                nestedAssignment,
                                out GExpression assignmentValue))
                        {
                            return assignmentValue;
                        }

                        // A deconstruction assignment (`(a, b) = ...`) has no
                        // single "target" to read back — LowerTupleAssignmentForValue
                        // already computed its value (a tuple of the assigned
                        // elements) when the write was hoisted; reuse it rather
                        // than trying to read `nestedAssignment.Left` (a tuple
                        // TARGET pattern, not a value expression) (issue #1974).
                        if (nestedAssignment.Left is TupleExpressionSyntax leftTuplePattern &&
                            this.state.TupleAssignmentValues.TryGetValue(leftTuplePattern, out GExpression cachedTupleValue))
                        {
                            return cachedTupleValue;
                        }

                        GExpression hoistedTarget = this.TranslateExpression(nestedAssignment.Left);

                        // Issue #1907: `x ??= y` only runs its assignment when `x`
                        // was null, so reading `x` back afterward is exactly the
                        // non-null narrowing C# itself performs post-`??=` — needed
                        // when `x`'s own declared/promoted type is nullable but the
                        // read occurs where a non-null value is expected (e.g. a
                        // `field`-keyword getter returning a non-nullable property
                        // type from a nullable-promoted backing field).
                        if (nestedAssignment.IsKind(SyntaxKind.CoalesceAssignmentExpression))
                        {
                            hoistedTarget = new NonNullAssertionExpression(hoistedTarget);
                        }

                        return hoistedTarget;
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
                    return this.TranslateAssignmentAsExpression(nestedAssignment);

                case ThrowExpressionSyntax throwExpression:
                    // `a ?? throw e`, `cond ? a : throw e`, a `switch` arm value.
                    // G# supports throw-as-expression natively (issue #1153);
                    // map it directly to a G# throw-expression.
                    return new ThrowExpression(
                        this.TranslateExpression(throwExpression.Expression),
                        this.ResolveExpressionType(throwExpression));

                case PostfixUnaryExpressionSyntax suppressNullable
                    when suppressNullable.IsKind(SyntaxKind.SuppressNullableWarningExpression):
                    // The C# null-forgiving operator `expr!` maps to G#'s postfix
                    // non-null assertion `expr!!` when the translated operand
                    // still has a nullable static type (ADR-0115 §B).
                    // A null literal is never forgivable: preserve `nil` so its
                    // target type accepts nullable sinks and rejects non-null ones.
                    if (IsNullOrSuppressedNull(suppressNullable.Operand))
                    {
                        return this.TranslateExpression(suppressNullable.Operand);
                    }

                    GExpression suppressed = this.TranslateExpression(suppressNullable.Operand);
                    return this.GSharpExpressionIsStaticallyNonNull(
                        suppressNullable.Operand,
                        suppressed)
                            ? suppressed
                            : EnsureNonNullAssertion(suppressed);

                case PostfixUnaryExpressionSyntax postfixValue
                    when postfixValue.IsKind(SyntaxKind.PostIncrementExpression)
                        || postfixValue.IsKind(SyntaxKind.PostDecrementExpression):
                    // A post-increment/decrement used in value position. When the
                    // enclosing statement seam already hoisted the mutation into a
                    // trailing statement, the node is suppressed here and reads as
                    // its pre-increment value (ADR-0115 §B).
                    if (this.state.SuppressedPostfix.Contains(postfixValue))
                    {
                        return this.TranslateExpression(postfixValue.Operand);
                    }

                    // gsc issue #1027: G# now models inc/dec as value-producing
                    // expressions, so a postfix in a position with no statement seam
                    // (e.g. inside a short-circuit `&&` condition) emits the faithful
                    // inline `x++` / `x--` form.
                    return new IncrementDecrementExpression(
                        this.TranslateExpression(postfixValue.Operand),
                        postfixValue.OperatorToken.Text,
                        isPrefix: false);

                case StackAllocArrayCreationExpressionSyntax stackAlloc:
                    return this.TranslateStackAlloc(stackAlloc);

                case ImplicitStackAllocArrayCreationExpressionSyntax implicitStackAlloc:
                    return this.TranslateImplicitStackAlloc(implicitStackAlloc);

                case CollectionExpressionSyntax collectionExpression:
                    return this.TranslateCollectionExpression(collectionExpression);

                case FieldExpressionSyntax fieldExpression:
                    return this.TranslateFieldExpression(fieldExpression);

                default:
                    this.context.ReportUnsupported(
                        expression,
                        $"expression '{expression.Kind()}' has no canonical G# form yet; emitted an identifier placeholder (ADR-0115 §B).");
                    return new IdentifierExpression("nil");
            }
        }

        private static ElementBindingExpressionSyntax FindLeadingElementBinding(
            ExpressionSyntax expression) =>
            expression switch
            {
                ElementBindingExpressionSyntax elementBinding => elementBinding,
                ParenthesizedExpressionSyntax parenthesized =>
                    FindLeadingElementBinding(parenthesized.Expression),
                InvocationExpressionSyntax invocation =>
                    FindLeadingElementBinding(invocation.Expression),
                MemberAccessExpressionSyntax memberAccess =>
                    FindLeadingElementBinding(memberAccess.Expression),
                ElementAccessExpressionSyntax elementAccess =>
                    FindLeadingElementBinding(elementAccess.Expression),
                _ => null,
            };

        private GExpression TranslateConditionalAccessWithLocalAssignmentSeam(
            ConditionalAccessExpressionSyntax conditionalAccess)
        {
            GExpression receiver = this.CaptureReceiverOnce(
                this.TranslateExpression(conditionalAccess.Expression),
                conditionalAccess.Expression,
                "a conditional-access expression here has no enclosing evaluation seam to capture its receiver once.");
            GExpression previousReceiver = this.state.ConditionalReceiverReplacement;
            this.state.ConditionalReceiverReplacement =
                new NonNullAssertionExpression(receiver);
            GExpression whenNotNull;
            try
            {
                whenNotNull = this.TranslateWithLocalAssignmentSeam(
                    conditionalAccess.WhenNotNull,
                    () => this.TranslateExpression(conditionalAccess.WhenNotNull));
            }
            finally
            {
                this.state.ConditionalReceiverReplacement = previousReceiver;
            }

            ITypeSymbol conditionalType = this.context.GetTypeInfo(conditionalAccess).Type;
            GTypeReference nullableType = this.typeMapper.Map(
                conditionalType,
                this.context,
                conditionalAccess.GetLocation());
            if (!nullableType.IsNullable)
            {
                nullableType = MakeNullable(nullableType);
            }

            return new ParenthesizedExpression(
                new IfExpression(
                    new BinaryExpression(receiver, "!=", LiteralExpression.Null()),
                    whenNotNull,
                    new DefaultValueExpression(nullableType)));
        }

        private GExpression TranslateNonNullableConditionalIndex(
            ExpressionSyntax continuation,
            ElementBindingExpressionSyntax elementBinding,
            GExpression receiver)
        {
            this.state.ConditionalElementReceivers.Add(elementBinding, receiver);
            try
            {
                return this.TranslateExpression(continuation);
            }
            finally
            {
                this.state.ConditionalElementReceivers.Remove(elementBinding);
            }
        }

        private bool ConditionalIndexReceiverIsNullable(ExpressionSyntax receiver)
        {
            ExpressionSyntax result = FindConditionalAccessResult(receiver);
            TypeInfo resultTypeInfo = this.context.GetTypeInfo(result);
            ITypeSymbol resultType = resultTypeInfo.Type ?? resultTypeInfo.ConvertedType;
            return FindLeadingElementBinding(receiver) != null
                || resultType is INamedTypeSymbol
                    { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T }
                || this.NullableReferenceValueMayBeNull(result)
                || this.ReceiverValueIsPromotedNullable(result)
                || this.ReceiverIsNullableReferenceFieldOrProperty(result);
        }

        private static ExpressionSyntax FindConditionalAccessResult(ExpressionSyntax expression) =>
            expression switch
            {
                ParenthesizedExpressionSyntax parenthesized =>
                    FindConditionalAccessResult(parenthesized.Expression),
                ConditionalAccessExpressionSyntax conditionalAccess =>
                    FindConditionalAccessResult(conditionalAccess.WhenNotNull),
                _ => expression,
            };

        // A constant pattern whose expression is actually a bare/qualified TYPE
        // reference (Roslyn parses `is T`/`not T` after a pattern combinator as a
        // ConstantPattern over an identifier, since it cannot tell at parse time
        // that the identifier names a type). Such a pattern is a type test, not an
        // equality, so it must lower to `x is T` rather than `x == T`.
        private bool IsTypeReferencePattern(ExpressionSyntax expression) =>
            this.context.GetSymbolInfo(expression).Symbol is ITypeSymbol;

        // Maps a pattern expression that refers to a TYPE to its G# type
        // reference. A bare type name parses as a TypeSyntax (IdentifierName /
        // generic / array), but a fully-qualified type name (`App.Auth.MfaChallenge`)
        // parses as a MemberAccessExpressionSyntax — which is NOT a TypeSyntax —
        // so it is mapped through its resolved type symbol instead (issue #2258).
        private GTypeReference MapTypeReferenceExpression(ExpressionSyntax expression)
        {
            if (expression is TypeSyntax typeSyntax)
            {
                return this.MapTypeSyntax(typeSyntax);
            }

            ITypeSymbol typeSymbol = this.context.GetSymbolInfo(expression).Symbol as ITypeSymbol;
            return typeSymbol != null
                ? this.typeMapper.Map(typeSymbol, this.context, expression.GetLocation())
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);
        }

        private GExpression TranslateIsPattern(IsPatternExpressionSyntax isPattern)
        {
            // Issue #1967: `x is Index i` (or any nested designation inside a
            // recursive/positional pattern) declares `i` via a pattern designation,
            // not a declarator — check the whole pattern tree here, the entry point
            // for every non-loop-condition `is`-pattern.
            this.ReportIndexOrRangeDesignationsInPattern(isPattern.Pattern);

            // ADR-0166 / issue #3409: a binding pattern whose designations G#
            // scopes natively is emitted verbatim (`x is T t && t.M`), keeping
            // the C# names and needing no spill or narrowing substitution.
            GExpression nativeVariables = this.TryTranslateNativePatternVariables(isPattern);
            if (nativeVariables != null)
            {
                return nativeVariables;
            }

            GExpression receiver = this.TranslateExpression(isPattern.Expression);
            ITypeSymbol receiverType = this.context.GetTypeInfo(isPattern.Expression).Type;

            // ADR-0162 / issues #3347/#3424: G# evaluates a native boolean
            // pattern subject exactly once. Use that form when C# introduces no
            // pattern local and gsc cannot smart-cast the original scrutinee.
            // An implicit property/field can translate to a bare identifier, but
            // only bare locals and parameters are smart-castable (ADR-0069).
            if (!PatternIntroducesBinding(isPattern.Pattern)
                && !PatternReadsScrutineeAtMostOnce(isPattern.Pattern)
                && !this.IsSmartCastableScrutinee(isPattern.Expression))
            {
                var bindings = new List<(ISymbol Symbol, GExpression Replacement)>();
                var guards = new List<GExpression>();
                bool outerBooleanPattern = this.state.TranslatingBooleanPattern;
                this.state.TranslatingBooleanPattern = true;
                GPattern pattern;
                try
                {
                    pattern = this.TranslatePattern(
                        isPattern.Pattern,
                        receiver,
                        bindings,
                        new HashSet<string>(System.StringComparer.Ordinal),
                        guards);
                }
                finally
                {
                    this.state.TranslatingBooleanPattern = outerBooleanPattern;
                }

                if (pattern != null && bindings.Count == 0 && guards.Count == 0)
                {
                    return new PatternTestExpression(receiver, pattern);
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
            if (!PatternReadsScrutineeAtMostOnce(isPattern.Pattern))
            {
                receiver = this.SpillOperand(receiver, isPattern.Expression);
            }

            GExpression test = this.TranslatePatternTest(
                receiver,
                isPattern.Pattern,
                receiverType,
                isPattern.Expression);
            return this.MaterializeFallbackPatternBindings(isPattern, receiver, test);
        }

        private GExpression MaterializeFallbackPatternBindings(
            IsPatternExpressionSyntax isPattern,
            GExpression receiver,
            GExpression test)
        {
            // Reassigned binders need real writable locals. Bindings whose
            // scrutinee moved into a short-circuit block need the same treatment
            // so later conjuncts and selected branches do not reference a
            // block-local spill.
            bool crossesShortCircuitBoundary =
                this.state.ShortCircuitSpillDeclarations != null;
            List<ILocalSymbol> materializedBinders = this.EnumeratePatternBinders(isPattern.Pattern)
                .Where(binder =>
                    crossesShortCircuitBoundary
                    || this.IsLocalReassigned(binder))
                .ToList();
            if (materializedBinders.Count == 0)
            {
                return test;
            }

            List<GStatement> declarations =
                this.state.ShortCircuitSpillDeclarations
                ?? this.state.PendingSpillPrologue;
            if (declarations == null)
            {
                this.context.ReportUnsupported(
                    isPattern,
                    "a fallback pattern binder requiring materialized storage reached an expression without a declaration seam (issue #3419).");
                return test;
            }

            StripTopLevelNegation(isPattern.Pattern, out bool negated);
            var assignments = new List<GStatement>(materializedBinders.Count);
            foreach (ILocalSymbol binder in materializedBinders)
            {
                if (!this.state.PatternBindings.TryGetValue(
                        binder,
                        out GExpression replacement))
                {
                    this.context.ReportUnsupported(
                        isPattern.Pattern,
                        $"fallback pattern binder '{binder.Name}' has no translated matched-value expression for materialized storage (issue #3419).");
                    continue;
                }

                if (negated)
                {
                    replacement = this.BuildNegatedPatternBindingValue(
                        binder,
                        receiver,
                        isPattern.Expression);
                }

                GTypeReference storageType = this.typeMapper.Map(
                    binder.Type,
                    this.context,
                    isPattern.Pattern.GetLocation());
                if (binder.Type.IsReferenceType)
                {
                    storageType = MakeNullable(storageType);
                }

                string name = this.EmittedName(binder, binder.Name);
                var local = new IdentifierExpression(name);
                declarations.Add(new LocalDeclarationStatement(
                    BindingKind.Var,
                    name,
                    storageType));
                assignments.Add(new AssignmentStatement(local, replacement));
                this.state.PatternBindings[binder] =
                    binder.Type.IsReferenceType
                        && binder.NullableAnnotation != NullableAnnotation.Annotated
                            ? new NonNullAssertionExpression(local)
                            : local;
            }

            if (assignments.Count == 0)
            {
                return test;
            }

            return new BinaryExpression(
                test,
                negated ? "||" : "&&",
                new BlockExpression(
                    assignments,
                    LiteralExpression.Bool(!negated)));
        }

        private GExpression BuildNegatedPatternBindingValue(
            ILocalSymbol binder,
            GExpression receiver,
            ExpressionSyntax receiverSyntax)
        {
            GTypeReference targetType = this.typeMapper.Map(
                binder.Type,
                this.context,
                receiverSyntax.GetLocation());
            if (binder.Type.IsValueType)
            {
                ITypeSymbol receiverType = this.context.GetTypeInfo(receiverSyntax).Type;
                if (receiverType is INamedTypeSymbol nullableReceiver
                    && nullableReceiver.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T
                    && nullableReceiver.TypeArguments.Length == 1
                    && SymbolEqualityComparer.Default.Equals(
                        nullableReceiver.TypeArguments[0],
                        binder.Type))
                {
                    return new NonNullAssertionExpression(receiver);
                }

                return targetType is NamedTypeReference namedTarget
                    ? new InvocationExpression(
                        new IdentifierExpression(namedTarget.Name),
                        new[] { receiver },
                        namedTarget.TypeArguments)
                    : new NonNullAssertionExpression(receiver);
            }

            return new NonNullAssertionExpression(
                new ParenthesizedExpression(
                    new BinaryExpression(
                        receiver,
                        "as",
                        new TypeExpression(targetType))));
        }

        // See <see cref="TranslateIsPattern"/>: true when translating `pattern`
        // against its scrutinee embeds the scrutinee at MOST one time, so no
        // spill is needed regardless of whether the scrutinee is trivial.
        private static bool PatternReadsScrutineeAtMostOnce(PatternSyntax pattern) =>
            pattern switch
            {
                // `x is null` / `x is 0` / `x is > 0`: a single equality/relational
                // test against the receiver, no designation possible.
                ConstantPatternSyntax => true,
                RelationalPatternSyntax => true,

                // `x is not P` / `(P)`: reads the receiver exactly as many times as
                // the inner pattern does.
                UnaryPatternSyntax unary => PatternReadsScrutineeAtMostOnce(unary.Pattern),
                ParenthesizedPatternSyntax parenthesized => PatternReadsScrutineeAtMostOnce(parenthesized.Pattern),

                // `x is T t`: always binds a designation, narrowing-replacing the
                // receiver at every later reference to `t` — more than one read
                // whenever `t` is actually used.
                DeclarationPatternSyntax => false,

                // `x is Circle` (no designation/subpatterns) reads the receiver
                // once; `x is Circle c`, `x is { X: 1 }`, or `x is Circle(1, 2)`
                // each read it more than once (a designation narrowing-replaces
                // it, and each property/positional subpattern re-embeds it).
                RecursivePatternSyntax recursive =>
                    recursive.Designation == null
                    && recursive.PropertyPatternClause == null
                    && recursive.PositionalPatternClause == null,

                // `x is var v`: always binds a designation.
                VarPatternSyntax => false,

                // `x is A or B` / `x is A and B`: the receiver is re-embedded once
                // per branch.
                BinaryPatternSyntax => false,

                _ => false,
            };

        private GExpression TranslatePatternTest(
            GExpression receiver,
            PatternSyntax pattern,
            ITypeSymbol receiverType = null,
            ExpressionSyntax receiverSyntax = null,
            bool isNestedPatternMember = false)
        {
            switch (pattern)
            {
                case ConstantPatternSyntax constant
                    when constant.Expression.IsKind(SyntaxKind.NullLiteralExpression):
                    // `x is null` → `x == nil`.
                    return new BinaryExpression(receiver, "==", LiteralExpression.Null());

                case ConstantPatternSyntax constant
                    when this.IsTypeReferencePattern(constant.Expression):
                    // Roslyn parses `x is T` where `T` is a bare type name after a
                    // combinator (e.g. `is Frame child and not EmptyFrame`) as a
                    // ConstantPattern over an identifier — but the identifier binds
                    // to a TYPE, so it is a type test, not an equality. `x is T`.
                    return new BinaryExpression(
                        receiver,
                        "is",
                        new TypeExpression(this.MapTypeReferenceExpression(constant.Expression)));

                case ConstantPatternSyntax constant:
                    // `x is 0` / `x is "moov"` / `x is true`. G# `is` only tests a
                    // type, so a constant pattern lowers to an equality test
                    // (ADR-0115 §B). A numeric literal is retyped to the receiver's
                    // type so `uint8? is 11` → `b == (11 as uint8?)` (G# has no
                    // implicit numeric promotion: a bare `b == 11` is GS0129).
                    return new BinaryExpression(
                        receiver,
                        "==",
                        this.CoercePatternConstant(
                            constant.Expression,
                            this.TranslateExpression(constant.Expression),
                            receiverType));

                case RelationalPatternSyntax relational:
                    // `x is > 0` → `x > 0` (with the same numeric retyping).
                    return new BinaryExpression(
                        receiver,
                        relational.OperatorToken.Text,
                        this.CoercePatternConstant(
                            relational.Expression,
                            this.TranslateExpression(relational.Expression),
                            receiverType));

                case DeclarationPatternSyntax declaration:
                    // `x is T t` → the boolean test `x is T`; the binder `t` is a
                    // Kotlin-style smart cast of `x` inside the guarded block, so
                    // references to `t` are rewritten to the narrowed `x` (ADR-0069).
                    if (declaration.Designation is SingleVariableDesignationSyntax single &&
                        this.context.GetDeclaredSymbol(single) is { } boundSymbol)
                    {
                        this.state.PatternBindings[boundSymbol] =
                            this.BuildPatternNarrowingReplacement(receiver, receiverSyntax, declaration.Type);
                    }

                    return new BinaryExpression(
                        receiver,
                        "is",
                        new TypeExpression(this.MapTypeSyntax(declaration.Type)));

                case TypePatternSyntax typePattern:
                    // `x is T` (no binder) → boolean test `x is T`.
                    return new BinaryExpression(
                        receiver,
                        "is",
                        new TypeExpression(this.MapTypeSyntax(typePattern.Type)));

                case RecursivePatternSyntax recursive:
                    return this.TranslateRecursivePatternTest(receiver, recursive, receiverSyntax, receiverType, isNestedPatternMember);

                case VarPatternSyntax varPattern:
                    // `x is var v` ALWAYS matches (it also matches `null`, unlike a
                    // type/declaration pattern), so it lowers to the literal `true`
                    // test; `v` binds directly to the receiver — no non-null
                    // narrowing, since (unlike `x is T t`) a `var` pattern never
                    // requires non-null (issue #1888).
                    if (varPattern.Designation is SingleVariableDesignationSyntax varSingle &&
                        this.context.GetDeclaredSymbol(varSingle) is { } varBound)
                    {
                        this.state.PatternBindings[varBound] = receiver;
                    }
                    else if (varPattern.Designation is ParenthesizedVariableDesignationSyntax)
                    {
                        // `var (a, b)` binds the deconstructed elements; G# has no
                        // canonical form for that, so keep the loud gap rather than
                        // silently emit a bindingless match (issue #1888). `var _`
                        // (discard designation) correctly stays a bindingless always-true.
                        this.context.ReportUnsupported(varPattern, "var pattern with tuple designation ('var (a, b)') has no canonical G# form yet (ADR-0115 §B).");
                    }

                    return LiteralExpression.Bool(true);

                case UnaryPatternSyntax unary when unary.IsKind(SyntaxKind.NotPattern):
                    return this.TranslateNotPatternTest(receiver, unary.Pattern, receiverType, isNestedPatternMember);

                case BinaryPatternSyntax binaryPattern
                    when binaryPattern.OperatorToken.IsKind(SyntaxKind.OrKeyword)
                        || binaryPattern.OperatorToken.IsKind(SyntaxKind.AndKeyword):
                    // `x is 11 or 12` → `x == 11 || x == 12`;
                    // `x is A and B` → `(x is A) && (x is B)`.
                    bool isOr = binaryPattern.OperatorToken.IsKind(SyntaxKind.OrKeyword);
                    return new BinaryExpression(
                        this.TranslatePatternTest(receiver, binaryPattern.Left, receiverType, receiverSyntax, isNestedPatternMember),
                        isOr ? "||" : "&&",
                        this.TranslatePatternTest(receiver, binaryPattern.Right, receiverType, receiverSyntax, isNestedPatternMember));

                case ParenthesizedPatternSyntax parenthesized:
                    return new ParenthesizedExpression(
                        this.TranslatePatternTest(receiver, parenthesized.Pattern, receiverType, receiverSyntax, isNestedPatternMember));

                case ListPatternSyntax listPattern:
                    return this.TranslateListPatternTest(receiver, listPattern, receiverType, isNestedPatternMember);

                default:
                    this.context.ReportUnsupported(
                        pattern,
                        $"is-pattern '{pattern.Kind()}' has no canonical G# form yet (ADR-0115 §B).");
                    return new BinaryExpression(receiver, "!=", LiteralExpression.Null());
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
        private GExpression TranslateListPatternTest(GExpression receiver, ListPatternSyntax listPattern, ITypeSymbol receiverType, bool isNestedPatternMember = false)
        {
            SeparatedSyntaxList<PatternSyntax> elements = listPattern.Patterns;
            int sliceIndex = FindSlicePatternIndex(elements);
            ITypeSymbol elementType = GetEnumerableElementType(receiverType);
            var lengthAccess = new MemberAccessExpression(receiver, "Length");

            GExpression test = sliceIndex < 0
                ? new BinaryExpression(lengthAccess, "==", LiteralExpression.Int(elements.Count.ToString()))
                : new BinaryExpression(lengthAccess, ">=", LiteralExpression.Int((elements.Count - 1).ToString()));

            for (int i = 0; i < elements.Count; i++)
            {
                PatternSyntax element = elements[i];
                if (element is SlicePatternSyntax slice)
                {
                    GExpression sliceTest = this.TranslateSlicePatternTest(receiver, slice, i, elements.Count - i - 1, receiverType, isNestedPatternMember);
                    if (sliceTest != null)
                    {
                        test = new BinaryExpression(test, "&&", sliceTest);
                    }

                    continue;
                }

                if (element is DiscardPatternSyntax)
                {
                    continue;
                }

                GExpression elementReceiver = this.BuildListElementReceiver(receiver, lengthAccess, i, elements.Count, sliceIndex);
                GExpression elementTest = this.TranslatePatternTest(elementReceiver, element, elementType, isNestedPatternMember: isNestedPatternMember);
                test = new BinaryExpression(test, "&&", elementTest);
            }

            return test;
        }

        // Issue #1889: a slice ("rest") subpattern either captures the middle
        // slice (`.. var rest`/`.. T rest`, a binder — registered as a
        // patternBindings substitution, same mechanism as a top-level `var`/
        // declaration pattern) or tests it against a nested subpattern (`..[>
        // 0]`, recursed against the materialized slice value); a bare `..`
        // contributes neither. Returns `null` when there is no additional
        // boolean test to AND in (a bare discard slice, or a successful bind).
        private GExpression TranslateSlicePatternTest(
            GExpression receiver, SlicePatternSyntax slice, int prefixCount, int suffixCount, ITypeSymbol receiverType, bool isNestedPatternMember = false)
        {
            switch (slice.Pattern)
            {
                case null:
                    return null;

                case VarPatternSyntax { Designation: SingleVariableDesignationSyntax variable }
                    when this.context.GetDeclaredSymbol(variable) is { } boundSymbol:
                    this.state.PatternBindings[boundSymbol] = BuildSliceExpression(receiver, prefixCount, suffixCount);
                    return null;

                case VarPatternSyntax { Designation: DiscardDesignationSyntax }:
                    return null;

                case VarPatternSyntax varTuple when varTuple.Designation is ParenthesizedVariableDesignationSyntax:
                    this.context.ReportUnsupported(varTuple, "var pattern with tuple designation ('var (a, b)') has no canonical G# form yet (ADR-0115 §B).");
                    return null;

                case DeclarationPatternSyntax { Designation: SingleVariableDesignationSyntax declVariable }
                    when this.context.GetDeclaredSymbol(declVariable) is { } declBoundSymbol:
                    // A typed slice capture (`.. T rest`) can only ever narrow to
                    // the slice's own `[]T` type, so the (redundant) type check is
                    // dropped — same bind-only treatment as the `var` capture above.
                    this.state.PatternBindings[declBoundSymbol] = BuildSliceExpression(receiver, prefixCount, suffixCount);
                    return null;

                default:
                    // A nested subpattern tested against the middle slice (e.g.
                    // `.. { Length: 0 }`, `.. [1, 2]`) — recurse the normal
                    // boolean-test lowering against the materialized slice value.
                    return this.TranslatePatternTest(BuildSliceExpression(receiver, prefixCount, suffixCount), slice.Pattern, receiverType, isNestedPatternMember: isNestedPatternMember);
            }
        }

        // Issue #1889: the index of an element read forward from the start (no
        // slice yet seen, or before it) vs. backward from the end (past it) —
        // shared by the boolean-test and G#-pattern lowering paths.
        private GExpression BuildListElementReceiver(GExpression receiver, GExpression lengthAccess, int index, int elementCount, int sliceIndex)
        {
            if (sliceIndex < 0 || index < sliceIndex)
            {
                return new IndexExpression(receiver, LiteralExpression.Int(index.ToString()));
            }

            return new IndexExpression(
                receiver,
                new BinaryExpression(lengthAccess, "-", LiteralExpression.Int((elementCount - index).ToString())));
        }

        // Issue #1889: the materialized slice value for a list pattern's `..`
        // element — `receiver[prefix..^suffix]` (open at whichever end has a
        // zero count), matching gsc's own array-slice binder (BindArraySlice).
        private static GExpression BuildSliceExpression(GExpression receiver, int prefixCount, int suffixCount)
        {
            GExpression start = prefixCount == 0 ? null : LiteralExpression.Int(prefixCount.ToString());
            GExpression end = suffixCount == 0 ? null : new FromEndIndexExpression(LiteralExpression.Int(suffixCount.ToString()));
            return new IndexExpression(receiver, new RangeIndexExpression(start, end));
        }

        private static int FindSlicePatternIndex(SeparatedSyntaxList<PatternSyntax> elements)
        {
            for (int i = 0; i < elements.Count; i++)
            {
                if (elements[i] is SlicePatternSyntax)
                {
                    return i;
                }
            }

            return -1;
        }

        private GExpression TranslateNotPatternTest(
            GExpression receiver, PatternSyntax inner, ITypeSymbol receiverType = null, bool isNestedPatternMember = false)
        {
            switch (inner)
            {
                case ConstantPatternSyntax constant
                    when constant.Expression.IsKind(SyntaxKind.NullLiteralExpression):
                    // `x is not null` → `x != nil`.
                    return new BinaryExpression(receiver, "!=", LiteralExpression.Null());

                case ConstantPatternSyntax constant
                    when this.IsTypeReferencePattern(constant.Expression):
                    // `x is not T` where Roslyn parsed `T` as a ConstantPattern
                    // identifier that binds to a TYPE → `!(x is T)`.
                    return new UnaryExpression(
                        "!",
                        new ParenthesizedExpression(new BinaryExpression(
                            receiver,
                            "is",
                            new TypeExpression(this.MapTypeReferenceExpression(constant.Expression)))));

                case ConstantPatternSyntax constant:
                    // `x is not 6` → `x != 6` (with numeric retyping to the receiver).
                    return new BinaryExpression(
                        receiver,
                        "!=",
                        this.CoercePatternConstant(
                            constant.Expression,
                            this.TranslateExpression(constant.Expression),
                            receiverType));

                case RecursivePatternSyntax { Type: null } emptyRecursive
                    when emptyRecursive.PropertyPatternClause is null or { Subpatterns.Count: 0 }:
                    // `x is not { } d` → `x == nil`; the designator `d` is the
                    // non-null view (used on the matched side), bound to `x`.
                    BindPatternDesignation(emptyRecursive.Designation, receiver);
                    return new BinaryExpression(receiver, "==", LiteralExpression.Null());

                case TypePatternSyntax typePattern:
                    // `x is not T` → `!(x is T)`.
                    return new UnaryExpression(
                        "!",
                        new ParenthesizedExpression(new BinaryExpression(
                            receiver,
                            "is",
                            new TypeExpression(this.MapTypeSyntax(typePattern.Type)))));

                case DeclarationPatternSyntax declaration:
                    // `x is not T t` → `!(x is T)`; `t` is the non-null `T` view,
                    // bound to `x` for use on the matched side.
                    BindPatternDesignation(declaration.Designation, receiver);
                    return new UnaryExpression(
                        "!",
                        new ParenthesizedExpression(new BinaryExpression(
                            receiver,
                            "is",
                            new TypeExpression(this.MapTypeSyntax(declaration.Type)))));

                default:
                    // General negation: `!( <inner test> )`.
                    return new UnaryExpression(
                        "!",
                        new ParenthesizedExpression(
                            this.TranslatePatternTest(receiver, inner, receiverType, isNestedPatternMember: isNestedPatternMember)));
            }
        }

        // Retypes a constant/relational pattern's literal operand to the receiver's
        // numeric type so the lowered `==`/`!=`/`<`… comparison type-checks. G# has
        // no implicit numeric promotion, so `uint8? is 11` lowered to `b == 11`
        // (where `11` is `int32`) is GS0129; coercing the literal yields the
        // accepted `b == (11 as uint8?)`. Mirrors the constant branch of
        // <see cref="TranslateBinaryExpression"/>. Non-numeric receivers/literals
        // (string/enum/type tests) are left untouched.
        private GExpression CoercePatternConstant(
            ExpressionSyntax constantSyntax, GExpression constant, ITypeSymbol receiverType)
        {
            if (receiverType == null)
            {
                return constant;
            }

            ITypeSymbol constantType = this.context.GetTypeInfo(constantSyntax).Type;
            if (TryGetNumericKind(receiverType, out SpecialType receiverUnderlying) &&
                TryGetNumericKind(constantType, out SpecialType constantUnderlying) &&
                receiverUnderlying != constantUnderlying &&
                this.context.SemanticModel.GetConstantValue(constantSyntax).HasValue)
            {
                return this.CoerceOperandTo(constant, receiverType);
            }

            return constant;
        }

        private GExpression TranslateRecursivePatternTest(
            GExpression receiver,
            RecursivePatternSyntax recursive,
            ExpressionSyntax receiverSyntax = null,
            ITypeSymbol receiverType = null,
            bool isNestedPatternMember = false)
        {
            // Bind the designator (`is { } x`, `is Circle c`) to the narrowed
            // receiver so later references read the matched value (ADR-0069 smart
            // cast). `is { } x` narrows away only nullability; `is Circle c`
            // additionally downcasts.
            if (recursive.Designation is SingleVariableDesignationSyntax recVar &&
                this.context.GetDeclaredSymbol(recVar) is { } recBound)
            {
                this.state.PatternBindings[recBound] =
                    this.BuildPatternNarrowingReplacement(receiver, receiverSyntax, recursive.Type);
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
            IOperation patternOperation = this.context.SemanticModel.GetOperation(recursive);
            bool receiverIsValueType = recursive.Type == null &&
                patternOperation is IRecursivePatternOperation { MatchedType.IsValueType: true };

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
            bool receiverIsNullableValueType = recursive.Type == null &&
                patternOperation is IPatternOperation { InputType.OriginalDefinition.SpecialType: SpecialType.System_Nullable_T };

            // Issue #1923: a NESTED bare recursive pattern (`{ Address: { City:
            // "Lima" } }`) recurses into this method with `receiver` bound to the
            // member access (`person.Address`) and its declared/flow type passed
            // through as `receiverType`. Unlike C#, where every reference type is
            // nullable at runtime and a defensive `!= null` is always legal, G#'s
            // null model treats a non-nullable reference type as truly non-null —
            // `!= nil` against one is rejected (GS0129). Skip the null check when
            // the member's G# type is a non-nullable reference; the member-access
            // sub-tests below are then the whole test, matching the value-type
            // treatment above.
            //
            // `receiverType` (when it comes from `TranslateIsPattern`'s
            // `GetTypeInfo(...).Type`) is Roslyn's FLOW type, which reports
            // `NullableAnnotation.None` — not `Annotated` — for a `T?` local once
            // the corpus's nullable annotations context is disabled (the common
            // case here, see `IsNullableInitializer`). That would make a truly
            // nullable top-level receiver like `person` look non-nullable and
            // wrongly drop its guard. `ResolveDeclaredReceiverType` prefers the
            // bound symbol's own DECLARED type (`ILocalSymbol.Type`, etc.), which
            // reliably preserves the syntactic `?` regardless of context state;
            // it falls back to `receiverType` itself only when no symbol binds
            // (e.g. the constructed `person.Address` member access from the
            // property-pattern loop below, whose `receiverType` already comes
            // from a declared property/field symbol via
            // <see cref="TryGetSubpatternMemberType"/>).
            // The non-nullable-reference skip below applies ONLY to a NESTED
            // subpattern member (`isNestedPatternMember`), never to the
            // OUTER/top-level subject of the whole `is`/pattern expression
            // (e.g. `person` in `person is { ... }`). C# always defensively
            // null-checks the top-level subject regardless of its declared
            // nullability, and that guard pre-dates issue #1923 (issue
            // #1888), so it must stay unconditional there.
            ITypeSymbol declaredReceiverType = this.ResolveDeclaredReceiverType(receiverType, receiverSyntax);
            bool receiverIsNonNullableReference = isNestedPatternMember
                && recursive.Type == null
                && declaredReceiverType is { IsReferenceType: true }
                && declaredReceiverType.NullableAnnotation != NullableAnnotation.Annotated;

            GExpression test = recursive.Type != null
                ? new BinaryExpression(receiver, "is", new TypeExpression(this.MapTypeSyntax(recursive.Type)))
                : ((receiverIsValueType && !receiverIsNullableValueType) || receiverIsNonNullableReference) ? null : new BinaryExpression(receiver, "!=", LiteralExpression.Null());

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
            GExpression memberReceiver = receiverIsNullableValueType
                ? new NonNullAssertionExpression(receiver)
                : receiver;

            if (recursive.PropertyPatternClause != null)
            {
                foreach (SubpatternSyntax sub in recursive.PropertyPatternClause.Subpatterns)
                {
                    if (sub.NameColon == null && sub.ExpressionColon == null)
                    {
                        this.context.ReportUnsupported(sub, "positional subpattern has no canonical G# form yet (ADR-0115 §B).");
                        continue;
                    }

                    GExpression memberTest;
                    if (sub.NameColon != null)
                    {
                        string memberName = this.GetSubpatternMemberName(sub);
                        GExpression memberAccess = new MemberAccessExpression(
                            memberReceiver,
                            this.EmittedName(
                                this.GetPatternMemberSymbol(sub.NameColon.Name),
                                memberName));
                        ITypeSymbol memberType = this.TryGetSubpatternMemberType(sub);
                        memberTest = this.TranslatePatternTest(memberAccess, sub.Pattern, memberType, isNestedPatternMember: true);
                    }
                    else
                    {
                        // Issue #1971: an extended subpattern (`Start.X: 0`)
                        // dotted chain needs a per-intermediate nullable-guard,
                        // not a single flat member access — see
                        // <see cref="TranslateExtendedPropertyMemberTest"/>.
                        memberTest = this.TranslateExtendedPropertyMemberTest(sub.ExpressionColon.Expression, sub.Pattern, memberReceiver);
                    }

                    test = test == null ? memberTest : new BinaryExpression(test, "&&", memberTest);
                }
            }

            if (recursive.PositionalPatternClause != null)
            {
                // Issue #1887: `x is (0, 0)` / `x is Point(0, 0)` deconstructs `x`
                // positionally. G# has no positional-pattern syntax, but a
                // positional subpattern against a tuple or a record's
                // (compiler-synthesized) `Deconstruct` reads exactly the same
                // members a property pattern would — `Item1`/`Item2` for a tuple,
                // the matching property for a record — so it lowers to the same
                // nested member-access test a property subpattern uses.
                SeparatedSyntaxList<SubpatternSyntax> subs = recursive.PositionalPatternClause.Subpatterns;
                string[] memberNames = this.TryGetPositionalMemberNames(recursive, subs.Count);
                for (int i = 0; i < subs.Count; i++)
                {
                    SubpatternSyntax sub = subs[i];
                    if (sub.Pattern is DiscardPatternSyntax)
                    {
                        // A discard position (`(0, _)`) imposes no constraint —
                        // same as an omitted field in a property pattern — so it
                        // contributes no test at all.
                        continue;
                    }

                    string memberName = sub.NameColon?.Name.Identifier.ValueText ?? memberNames?[i];
                    if (memberName == null)
                    {
                        this.context.ReportUnsupported(sub, "positional subpattern has no canonical G# form yet (ADR-0115 §B).");
                        continue;
                    }

                    ISymbol memberSymbol = sub.NameColon != null
                        ? this.GetPatternMemberSymbol(sub.NameColon.Name)
                        : (recursive.Type != null
                            ? this.context.GetTypeInfo(recursive.Type).Type as INamedTypeSymbol
                            : receiverType as INamedTypeSymbol)?
                            .GetMembers(memberName)
                            .FirstOrDefault();
                    GExpression memberAccess = new MemberAccessExpression(
                        memberReceiver,
                        this.EmittedName(memberSymbol, memberName));
                    GExpression memberTest = this.TranslatePatternTest(memberAccess, sub.Pattern, isNestedPatternMember: true);
                    test = test == null ? memberTest : new BinaryExpression(test, "&&", memberTest);
                }
            }

            // Every position was a discard (`(_, _)`) against a value-type
            // receiver: no null check applies and no member test was emitted, so
            // the pattern always matches.
            return test ?? LiteralExpression.Bool(true);
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
        private ITypeSymbol ResolveDeclaredReceiverType(ITypeSymbol receiverType, ExpressionSyntax receiverSyntax)
        {
            if (receiverSyntax == null)
            {
                return receiverType;
            }

            ISymbol symbol = this.context.GetSymbolInfo(receiverSyntax).Symbol;
            return symbol switch
            {
                ILocalSymbol l => l.Type,
                IParameterSymbol p => p.Type,
                IPropertySymbol pr => pr.Type,
                IFieldSymbol f => f.Type,
                _ => receiverType,
            };
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
        private ITypeSymbol TryGetSubpatternMemberType(SubpatternSyntax sub)
        {
            if (sub.NameColon == null)
            {
                return null;
            }

            ISymbol symbol = this.context.SemanticModel.GetSymbolInfo(sub.NameColon.Name).Symbol;
            return symbol switch
            {
                IPropertySymbol p => p.Type,
                IFieldSymbol f => f.Type,
                _ => null,
            };
        }

        private string GetSubpatternMemberName(SubpatternSyntax sub)
        {
            return sub.NameColon == null
                ? null
                : this.GetPatternMemberName(sub.NameColon.Name);
        }

        private string GetPatternMemberName(SimpleNameSyntax name)
        {
            if (this.context.SemanticModel.GetSymbolInfo(name).Symbol
                is IFieldSymbol { ContainingType.IsTupleType: true } tupleField)
            {
                return (tupleField.CorrespondingTupleField ?? tupleField).Name;
            }

            return name.Identifier.ValueText;
        }

        private ISymbol GetPatternMemberSymbol(SyntaxNode node)
        {
            ISymbol symbol = this.context.GetSymbolInfo(node).Symbol;
            return symbol is IFieldSymbol { ContainingType.IsTupleType: true } tupleField
                ? tupleField.CorrespondingTupleField ?? tupleField
                : symbol;
        }

        // Splits an extended property subpattern's dotted member path
        // (`Start.X`, `A.B.C`, ...) into its leaf-to-root identifier chain
        // (`["Start", "X"]`, `["A", "B", "C"]`), using each bound member's
        // allocated emitted name. Shared by the
        // is-form guard builder (<see cref="TranslateExtendedPropertyMemberTest"/>)
        // and the switch-arm nested-field builder (<see cref="ExtendedPropertyFieldTree"/>).
        private List<string> SplitMemberPath(ExpressionSyntax memberPath)
        {
            var names = new List<string>();
            ExpressionSyntax current = memberPath;
            while (current is MemberAccessExpressionSyntax memberAccess)
            {
                names.Insert(0, this.EmittedName(
                    this.GetPatternMemberSymbol(memberAccess),
                    this.GetPatternMemberName(memberAccess.Name)));
                current = memberAccess.Expression;
            }

            string rootName = current is SimpleNameSyntax simpleName
                ? this.EmittedName(
                    this.GetPatternMemberSymbol(simpleName),
                    this.GetPatternMemberName(simpleName))
                : current.ToString();
            names.Insert(0, rootName);
            return names;
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
        private GExpression TranslateExtendedPropertyMemberTest(
            ExpressionSyntax memberPath,
            PatternSyntax leafPattern,
            GExpression receiver)
        {
            List<string> names = SplitMemberPath(memberPath);

            // `intermediateExprs[i]` is the sub-expression whose runtime value
            // is used as the receiver for the access producing `names[i + 1]`
            // (e.g. for `Start.X`, `intermediateExprs[0]` is the `Start`
            // sub-expression — its declared nullability decides whether a
            // guard is needed before reading `.X`). Walked positionally from
            // the outermost `MemberAccessExpressionSyntax` inward, so it lines
            // up with `names` regardless of repeated identifiers in the chain.
            var intermediateExprs = new ExpressionSyntax[names.Count - 1];
            ExpressionSyntax current = memberPath;
            int pos = names.Count - 1;
            while (current is MemberAccessExpressionSyntax memberAccess)
            {
                pos--;
                intermediateExprs[pos] = memberAccess.Expression;
                current = memberAccess.Expression;
            }

            GExpression memberReceiver = receiver;
            GExpression guard = null;
            for (int i = 0; i < names.Count - 1; i++)
            {
                memberReceiver = new MemberAccessExpression(memberReceiver, names[i]);

                ITypeSymbol declaredType = this.ResolveDeclaredReceiverType(
                    this.context.GetTypeInfo(intermediateExprs[i]).Type, intermediateExprs[i]);
                if (declaredType is { IsReferenceType: true } && declaredType.NullableAnnotation == NullableAnnotation.Annotated)
                {
                    GExpression stepGuard = new BinaryExpression(memberReceiver, "!=", LiteralExpression.Null());
                    guard = guard == null ? stepGuard : new BinaryExpression(guard, "&&", stepGuard);
                }
            }

            string leafName = names[^1];
            GExpression finalMemberAccess = new MemberAccessExpression(memberReceiver, leafName);
            ITypeSymbol leafType = this.context.GetTypeInfo(memberPath).Type;
            GExpression leafTest = this.TranslatePatternTest(finalMemberAccess, leafPattern, leafType, isNestedPatternMember: true);

            return guard == null ? leafTest : new BinaryExpression(guard, "&&", leafTest);
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
        // Resolves the property name each positional subpattern of `recursive`
        // deconstructs to (issue #1887), so a positional pattern can lower to the
        // same nested member-access form a property pattern uses. Returns null
        // when no canonical mapping exists (an explicit `Deconstruct` whose
        // out-parameters don't share a name with a same-named property), so
        // callers fall back to the loud "no canonical G# form" diagnostic instead
        // of silently dropping the subpattern.
        private string[] TryGetPositionalMemberNames(RecursivePatternSyntax recursive, int arity)
        {
            if (this.context.SemanticModel.GetOperation(recursive) is not IRecursivePatternOperation operation)
            {
                return null;
            }

            if (operation.MatchedType is INamedTypeSymbol { IsTupleType: true })
            {
                // `(0, 0)` against a `(int, int)` tuple: positions bind to the
                // always-present `Item1`/`Item2` fields regardless of any
                // user-declared tuple element names.
                var tupleNames = new string[arity];
                for (int i = 0; i < arity; i++)
                {
                    tupleNames[i] = "Item" + (i + 1).ToString(CultureInfo.InvariantCulture);
                }

                return tupleNames;
            }

            if (operation.DeconstructSymbol is not IMethodSymbol deconstruct || deconstruct.Parameters.Length != arity)
            {
                return null;
            }

            var names = new string[arity];
            for (int i = 0; i < arity; i++)
            {
                string name = deconstruct.Parameters[i].Name;
                if (!HasMatchingProperty(operation.MatchedType, name))
                {
                    return null;
                }

                names[i] = name;
            }

            return names;
        }

        // Walks the base-type chain looking for a property named `name` (a
        // record's positional properties are declared directly on the record,
        // but this also covers a Deconstruct that mirrors an inherited property).
        private static bool HasMatchingProperty(ITypeSymbol type, string name)
        {
            for (ITypeSymbol current = type; current != null; current = current.BaseType)
            {
                if (current.GetMembers(name).OfType<IPropertySymbol>().Any())
                {
                    return true;
                }
            }

            return false;
        }

        private void BindPatternDesignation(VariableDesignationSyntax designation, GExpression receiver)
        {
            if (designation is SingleVariableDesignationSyntax variable &&
                this.context.GetDeclaredSymbol(variable) is { } boundSymbol)
            {
                this.state.PatternBindings[boundSymbol] = receiver;
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
        private GExpression BuildPatternNarrowingReplacement(
            GExpression receiver, ExpressionSyntax receiverSyntax, TypeSyntax narrowedTypeSyntax)
        {
            if (narrowedTypeSyntax == null
                && receiverSyntax != null
                && this.context.GetTypeInfo(receiverSyntax).Type is INamedTypeSymbol nullableReceiver
                && nullableReceiver.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T)
            {
                return new NonNullAssertionExpression(receiver);
            }

            bool bindingUsedInsideCondition = narrowedTypeSyntax?.Ancestors().Any(node =>
                node is WhenClauseSyntax
                || (node is BinaryExpressionSyntax binary
                    && (binary.IsKind(SyntaxKind.LogicalAndExpression)
                        || binary.IsKind(SyntaxKind.LogicalOrExpression)))) == true;
            if (!bindingUsedInsideCondition
                && receiverSyntax != null
                && this.IsSmartCastableScrutinee(receiverSyntax)
                && this.context.GetTypeInfo(receiverSyntax).Type is not ITypeParameterSymbol)
            {
                return receiver;
            }

            if (narrowedTypeSyntax == null)
            {
                return new NonNullAssertionExpression(receiver);
            }

            ITypeSymbol narrowedType = this.context.GetTypeInfo(narrowedTypeSyntax).Type;
            if (narrowedType != null && narrowedType.IsValueType)
            {
                return new NonNullAssertionExpression(receiver);
            }

            return new NonNullAssertionExpression(
                new ParenthesizedExpression(
                    new BinaryExpression(
                        receiver,
                        "as",
                        new TypeExpression(this.MapTypeSyntax(narrowedTypeSyntax)))));
        }

        private GExpression TranslateArrayCreation(ArrayCreationExpressionSyntax creation)
        {
            GTypeReference elementType = this.GetArrayElementType(creation, creation.Type.ElementType);
            ITypeSymbol elementTypeSymbol =
                (this.context.GetTypeInfo(creation).Type as IArrayTypeSymbol)?.ElementType;

            if (creation.Type.RankSpecifiers.Count > 0 && creation.Type.RankSpecifiers[0].Sizes.Count > 1)
            {
                int rank = creation.Type.RankSpecifiers[0].Sizes.Count;
                if (creation.Initializer != null)
                {
                    var leaves = new List<ExpressionSyntax>();
                    IReadOnlyList<GExpression> dimensions;
                    if (creation.Type.RankSpecifiers[0].Sizes.All(
                        size => size.IsKind(SyntaxKind.OmittedArraySizeExpression)))
                    {
                        var inferredDimensions = new int[rank];
                        FlattenRectangularArrayInitializer(
                            creation.Initializer,
                            0,
                            rank,
                            inferredDimensions,
                            leaves);
                        dimensions = inferredDimensions
                            .Select(d => (GExpression)LiteralExpression.Int(
                                d.ToString(CultureInfo.InvariantCulture)))
                            .ToList();
                    }
                    else
                    {
                        dimensions = creation.Type.RankSpecifiers[0].Sizes
                            .Select(this.TranslateRectangularInitializerDimension)
                            .ToList();
                        FlattenRectangularArrayInitializer(
                            creation.Initializer,
                            0,
                            rank,
                            new int[rank],
                            leaves);
                    }

                    return new ArrayAllocationExpression(
                        elementType,
                        dimensions,
                        leaves.Select(expression =>
                            this.TranslateArrayInitializerElement(expression, elementTypeSymbol)).ToList());
                }

                return new ArrayAllocationExpression(
                    elementType,
                    creation.Type.RankSpecifiers[0].Sizes
                        .Select(size => this.CoerceLengthToInt32(size, this.TranslateExpression(size)))
                        .ToList());
            }

            if (creation.Initializer != null)
            {
                // `new T[]{a, b}` / `new T[0]` (with an explicit, possibly empty,
                // initializer) → the slice literal `[]T{a, b}`.
                return new ArrayLiteralExpression(
                    elementType,
                    creation.Initializer.Expressions
                        .Select(expression =>
                            this.TranslateArrayInitializerElement(expression, elementTypeSymbol))
                        .ToList());
            }

            // `new T[n]` (runtime/constant length, no initializer) → the native
            // G# zero-initialised allocation form `[n]T` (issue #1272), which
            // yields a zero-initialised slice `[]T` of length `n`. C# accepts
            // any integral length (`uint`/`long`/…); gsc's `[n]T` requires an
            // `int32` length, so a non-`int32` numeric length is coerced via the
            // conversion-call form (`int32(n)`).
            GExpression length;
            if (creation.Type.RankSpecifiers.Count > 0 &&
                creation.Type.RankSpecifiers[0].Sizes.Count > 0 &&
                creation.Type.RankSpecifiers[0].Sizes[0] is { } sizeExpr &&
                !sizeExpr.IsKind(SyntaxKind.OmittedArraySizeExpression))
            {
                length = this.CoerceLengthToInt32(sizeExpr, this.TranslateExpression(sizeExpr));
            }
            else
            {
                length = LiteralExpression.Int("0");
            }

            return new ArrayAllocationExpression(elementType, length);
        }

        private GExpression TranslateRectangularInitializerDimension(ExpressionSyntax size)
        {
            Optional<object> constant = this.context.SemanticModel.GetConstantValue(size);
            if (constant.HasValue && TryGetNonNegativeInt32(constant.Value, out int value))
            {
                return LiteralExpression.Int(value.ToString(CultureInfo.InvariantCulture));
            }

            return this.CoerceLengthToInt32(size, this.TranslateExpression(size));
        }

        private static bool TryGetNonNegativeInt32(object value, out int result)
        {
            long candidate = value switch
            {
                sbyte item => item,
                byte item => item,
                short item => item,
                ushort item => item,
                char item => item,
                int item => item,
                uint item when item <= int.MaxValue => item,
                long item when item is >= 0 and <= int.MaxValue => item,
                ulong item when item <= int.MaxValue => (long)item,
                _ => -1,
            };

            if (candidate is >= 0 and <= int.MaxValue)
            {
                result = (int)candidate;
                return true;
            }

            result = 0;
            return false;
        }

        /// <summary>
        /// Recursively walks a rectangular multi-dim initializer
        /// (<c>{{1, 2, 3}, {4, 5, 6}}</c>), recording each level's element count
        /// into <paramref name="dims"/> (once, from the first branch — C#
        /// guarantees every branch at a level is the same length) and
        /// collecting the leaf value expressions into <paramref name="leaves"/>
        /// in row-major order.
        /// </summary>
        private static void FlattenRectangularArrayInitializer(
            InitializerExpressionSyntax node, int level, int rank, int[] dims, List<ExpressionSyntax> leaves)
        {
            dims[level] = node.Expressions.Count;
            if (level == rank - 1)
            {
                leaves.AddRange(node.Expressions);
                return;
            }

            foreach (ExpressionSyntax child in node.Expressions)
            {
                FlattenRectangularArrayInitializer(
                    (InitializerExpressionSyntax)child, level + 1, rank, dims, leaves);
            }
        }

        /// <summary>
        /// Translates a CLR rectangular-array element access directly to native
        /// G# multi-index syntax. Runtime preserves left-to-right single
        /// evaluation, per-dimension bounds checks, and row-major storage.
        /// </summary>
        private GExpression TranslateMultiDimElementAccess(ElementAccessExpressionSyntax elementAccess)
        {
            GExpression target = this.TranslateReceiverWithNullForgiveness(elementAccess.Expression);
            return new IndexExpression(
                target,
                elementAccess.ArgumentList.Arguments
                    .Select(a => this.CoerceMultiDimIndexToInt32(
                        a.Expression,
                        this.TranslateExpression(a.Expression)))
                    .ToList());
        }

        private GExpression TranslateStackAlloc(StackAllocArrayCreationExpressionSyntax node)
        {
            // gsc issues #1024, #1057, #1041: C# `stackalloc T[n]` → G#-style
            // `stackalloc [n]gT` (the bracketed count first, then the element
            // type). In a safe context this yields `Span[T]`; targeting a raw
            // pointer inside an `unsafe` context yields `*T`. The element type
            // is mapped through the standard C#→G# type mapper (`byte`→`uint8`).
            // A C# initializer (`stackalloc byte[] { 1, 2 }`) maps to the
            // faithful G# initializer (`stackalloc [2]uint8{1, 2}`); an omitted
            // size is inferred from the initializer length.
            GTypeReference elementType;
            GExpression count;
            if (node.Type is ArrayTypeSyntax arrayType)
            {
                elementType = this.MapTypeSyntax(arrayType.ElementType);
                count = arrayType.RankSpecifiers.Count > 0 &&
                    arrayType.RankSpecifiers[0].Sizes.Count > 0 &&
                    arrayType.RankSpecifiers[0].Sizes[0] is { } sizeExpr &&
                    !sizeExpr.IsKind(SyntaxKind.OmittedArraySizeExpression)
                    ? this.TranslateExpression(sizeExpr)
                    : null;
            }
            else
            {
                elementType = new NamedTypeReference("uint8");
                count = null;
            }

            List<GExpression> elements = null;
            if (node.Initializer != null)
            {
                elements = node.Initializer.Expressions.Select(this.TranslateExpression).ToList();
            }

            // An explicit initializer supplies the length; fall back to the
            // element count when no size is spelled.
            if (count == null && node.Initializer != null)
            {
                count = LiteralExpression.Int(
                    node.Initializer.Expressions.Count.ToString(CultureInfo.InvariantCulture));
            }

            return new StackAllocExpression(elementType, count ?? LiteralExpression.Int("0"), elements);
        }

        // Issue #1897: the implicit-typed form `stackalloc[] { 5, 6, 7 }` (no
        // element-type spelled at all — C# infers it from the initializer/
        // target). Maps to the same G# count-inferred initializer shape
        // (`stackalloc []T{a, b, …}`) as the explicit omitted-size form
        // (`stackalloc int[] { … }`, handled by <see cref="TranslateStackAlloc"/>);
        // the element type is recovered from the expression's converted type
        // (`Span<T>`/`T*`) since there is no type syntax on this node to read.
        private GExpression TranslateImplicitStackAlloc(ImplicitStackAllocArrayCreationExpressionSyntax node)
        {
            GTypeReference elementType = this.GetArrayElementType(node, null);
            ITypeSymbol elementTypeSymbol = GetCollectionElementTypeSymbol(
                this.context.GetTypeInfo(node).ConvertedType ?? this.context.GetTypeInfo(node).Type);
            List<GExpression> elements = node.Initializer.Expressions
                .Select(expression =>
                    this.TranslateArrayInitializerElement(expression, elementTypeSymbol))
                .ToList();
            GExpression count = LiteralExpression.Int(
                node.Initializer.Expressions.Count.ToString(CultureInfo.InvariantCulture));

            return new StackAllocExpression(elementType, count, elements);
        }

        private GExpression TranslateArrayInitializerElement(
            ExpressionSyntax expression,
            ITypeSymbol elementType)
        {
            GExpression translated = this.TranslateExpression(expression);
            translated = this.ForgiveNullableReferenceValue(
                expression,
                translated,
                elementType,
                targetSymbol: null);
            if (translated is NonNullAssertionExpression
                || !this.TargetWillRemainNonNullableReference(elementType, targetSymbol: null)
                || IsNullOrSuppressedNull(expression))
            {
                return translated;
            }

            ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;
            ITypeSymbol sourceType = symbol switch
            {
                IPropertySymbol property => property.Type,
                IFieldSymbol field => field.Type,
                ILocalSymbol local => local.Type,
                IParameterSymbol parameter => parameter.Type,
                IMethodSymbol method => method.ReturnType,
                _ => null,
            };
            return sourceType is { IsReferenceType: true }
                && (sourceType.NullableAnnotation == NullableAnnotation.Annotated
                    || this.ShouldPromoteToNullableReference(symbol))
                ? EnsureNonNullAssertion(translated)
                : translated;
        }

        private static ITypeSymbol GetCollectionElementTypeSymbol(ITypeSymbol type) =>
            type switch
            {
                IArrayTypeSymbol array => array.ElementType,
                IPointerTypeSymbol pointer => pointer.PointedAtType,
                INamedTypeSymbol { TypeArguments.Length: > 0 } named => named.TypeArguments[0],
                _ => null,
            };

        private GExpression TranslateImplicitArrayCreation(ImplicitArrayCreationExpressionSyntax creation)
        {
            GTypeReference elementType = this.GetArrayElementType(creation, null);
            IArrayTypeSymbol arrayType = this.context.GetTypeInfo(creation).Type as IArrayTypeSymbol;
            ITypeSymbol elementTypeSymbol = arrayType?.ElementType;
            if (arrayType is { Rank: > 1 })
            {
                var dims = new int[arrayType.Rank];
                var leaves = new List<ExpressionSyntax>();
                FlattenRectangularArrayInitializer(
                    creation.Initializer,
                    level: 0,
                    rank: arrayType.Rank,
                    dims,
                    leaves);
                return new ArrayAllocationExpression(
                    elementType,
                    dims.Select(d => (GExpression)LiteralExpression.Int(
                        d.ToString(CultureInfo.InvariantCulture))).ToList(),
                    leaves.Select(expression =>
                        this.TranslateArrayInitializerElement(expression, elementTypeSymbol)).ToList());
            }

            return new ArrayLiteralExpression(
                elementType,
                creation.Initializer.Expressions
                    .Select(expression =>
                        this.TranslateArrayInitializerElement(expression, elementTypeSymbol))
                    .ToList());
        }

        private GExpression TranslateInitializerExpression(InitializerExpressionSyntax initializer)
        {
            if (this.context.GetTypeInfo(initializer).ConvertedType is IArrayTypeSymbol { Rank: > 1 } arrayType)
            {
                GTypeReference rectangularElementType = this.GetArrayElementType(initializer, null);
                var dims = new int[arrayType.Rank];
                var leaves = new List<ExpressionSyntax>();
                FlattenRectangularArrayInitializer(
                    initializer,
                    level: 0,
                    rank: arrayType.Rank,
                    dims,
                    leaves);
                return new ArrayAllocationExpression(
                    rectangularElementType,
                    dims.Select(d => (GExpression)LiteralExpression.Int(
                        d.ToString(CultureInfo.InvariantCulture))).ToList(),
                    leaves.Select(expression =>
                        this.TranslateArrayInitializerElement(expression, arrayType.ElementType)).ToList());
            }

            // A bare `{ a, b, c }` array initializer (a field/local of array type
            // initialised without `new T[]`) or a collection-initializer element
            // list reaching value position maps to the slice literal `[]T{ … }`,
            // using the bound (converted) element type.
            GTypeReference elementType = this.GetArrayElementType(initializer, null);
            ITypeSymbol elementTypeSymbol = GetCollectionElementTypeSymbol(
                this.context.GetTypeInfo(initializer).ConvertedType ??
                this.context.GetTypeInfo(initializer).Type);
            return new ArrayLiteralExpression(
                elementType,
                initializer.Expressions
                    .Select(expression =>
                        this.TranslateArrayInitializerElement(expression, elementTypeSymbol))
                    .ToList());
        }

        // ADR-0161 / issue #3350: translates a C# assignment used in VALUE position
        // into G#'s assignment expression, preserving the write where C# put it.
        //
        // A deconstruction assignment (`(a, b) = …`) has no single target and is
        // left to the existing tuple lowering. G# has no `??=` expression, so
        // that one uses a native block/if expression below.
        private GExpression TranslateAssignmentAsExpression(AssignmentExpressionSyntax assignment)
        {
            if (assignment.Left is TupleExpressionSyntax)
            {
                // Unchanged fallback: still better than nothing, and these shapes
                // are handled by their own lowerings when a seam is available.
                return this.TranslateExpression(assignment.Right);
            }

            if (assignment.IsKind(SyntaxKind.CoalesceAssignmentExpression))
            {
                return this.TranslateCoalescingAssignmentAsExpression(assignment);
            }

            GExpression result = new AssignmentExpression(
                this.TranslateAssignmentTarget(assignment.Left),
                this.TranslateAssignmentValue(assignment),
                assignment.OperatorToken.Text);

            // A materialized non-null reference binder uses nullable storage
            // because its declaration precedes the guard. Its assignment result
            // still has the binder's non-null C# type.
            if (assignment.Left is IdentifierNameSyntax identifier
                && this.context.GetSymbolInfo(identifier).Symbol is { } symbol
                && this.state.PatternBindings.TryGetValue(
                    symbol,
                    out GExpression replacement)
                && replacement is NonNullAssertionExpression)
            {
                result = EnsureNonNullAssertion(result);
            }

            return result;
        }

        private GExpression TranslateCoalescingAssignmentAsExpression(
            AssignmentExpressionSyntax assignment)
        {
            var statements = new List<GStatement>();
            GExpression target = this.MakeDuplicationSafeTarget(
                this.TranslateAssignmentTarget(assignment.Left),
                statements,
                assignment.Left);
            GExpression current = this.SpillOperand(target, statements);
            var value = new IfExpression(
                new BinaryExpression(current, "==", LiteralExpression.Null()),
                new AssignmentExpression(
                    target,
                    this.TranslateAssignmentValue(assignment)),
                current);
            GExpression result =
                this.context.GetTypeInfo(assignment).Nullability.FlowState == NullableFlowState.NotNull
                || !this.NullableReferenceValueMayBeNull(assignment.Right)
                ? EnsureNonNullAssertion(value)
                : value;
            return statements.Count == 0
                ? result
                : new BlockExpression(statements, result);
        }

        private GExpression TranslateSizeOf(SizeOfExpressionSyntax sizeOf)
        {
            // `sizeof(T)` for a primitive type is a compile-time constant; emit the
            // byte width directly (G# has no `sizeof` operator). For non-primitive
            // types fall back to the call-shaped form so the output still parses.
            ITypeSymbol type = this.context.GetTypeInfo(sizeOf.Type).Type;
            int? size = type?.SpecialType switch
            {
                SpecialType.System_Boolean or SpecialType.System_SByte or SpecialType.System_Byte => 1,
                SpecialType.System_Int16 or SpecialType.System_UInt16 or SpecialType.System_Char => 2,
                SpecialType.System_Int32 or SpecialType.System_UInt32 or SpecialType.System_Single => 4,
                SpecialType.System_Int64 or SpecialType.System_UInt64 or SpecialType.System_Double => 8,
                SpecialType.System_Decimal => 16,
                _ => null,
            };

            if (size.HasValue)
            {
                return LiteralExpression.Int(size.Value.ToString(CultureInfo.InvariantCulture));
            }

            return new InvocationExpression(
                new IdentifierExpression("sizeof"),
                new List<GExpression> { new TypeExpression(this.MapTypeSyntax(sizeOf.Type)) });
        }

        private GTypeReference GetArrayElementType(ExpressionSyntax arrayExpression, TypeSyntax elementTypeSyntax)
        {
            bool nullableElementSyntax = elementTypeSyntax is NullableTypeSyntax;

            TypeInfo info = this.context.GetTypeInfo(arrayExpression);
            ITypeSymbol arrayType = info.Type ?? info.ConvertedType;
            if (arrayType is IArrayTypeSymbol array)
            {
                GTypeReference mapped = this.typeMapper.Map(
                    array.ElementType,
                    this.context,
                    arrayExpression.GetLocation());
                return nullableElementSyntax ? MakeNullable(mapped) : mapped;
            }

            if (arrayType is INamedTypeSymbol { IsGenericType: true } generic &&
                generic.TypeArguments.Length == 1)
            {
                GTypeReference mapped = this.typeMapper.Map(
                    generic.TypeArguments[0],
                    this.context,
                    arrayExpression.GetLocation());
                return nullableElementSyntax ? MakeNullable(mapped) : mapped;
            }

            if (elementTypeSyntax != null)
            {
                GTypeReference mapped = this.MapTypeSyntax(elementTypeSyntax);
                return nullableElementSyntax ? MakeNullable(mapped) : mapped;
            }

            return new NamedTypeReference("object");
        }

        private GExpression TranslateCollectionExpression(CollectionExpressionSyntax collection)
        {
            // An empty collection expression (`[]`) targeting a concrete
            // constructible collection class (e.g. `Dictionary<,> d = []`,
            // `List<T> l = []`) maps to a constructor call of that type. The slice
            // literal `[]T{ … }` only models arrays/spans; a `Dictionary`'s element
            // type is `KeyValuePair<,>`, whose generic `[...]` would otherwise be
            // emitted into a malformed `[]KeyValuePair[…]{}` literal (ADR-0115 §B).
            ITypeSymbol target = this.context.GetTypeInfo(collection).ConvertedType
                ?? this.context.GetTypeInfo(collection).Type;
            bool isConstructibleClassTarget =
                target is INamedTypeSymbol { TypeKind: TypeKind.Class } namedTarget &&
                this.typeMapper.Map(namedTarget, this.context, collection.GetLocation()) is NamedTypeReference;
            NamedTypeReference targetRef = isConstructibleClassTarget
                ? (NamedTypeReference)this.typeMapper.Map((INamedTypeSymbol)target, this.context, collection.GetLocation())
                : null;

            if (collection.Elements.Count == 0 && isConstructibleClassTarget)
            {
                return new InvocationExpression(
                    new IdentifierExpression(targetRef.Name),
                    new List<GExpression>(),
                    targetRef.TypeArguments.Count > 0 ? targetRef.TypeArguments : null);
            }

            ITypeSymbol elementTypeSymbol = GetEnumerableElementType(target);
            GTypeReference elementType = elementTypeSymbol != null
                ? this.typeMapper.Map(elementTypeSymbol, this.context, collection.GetLocation())
                : this.GetCollectionElementType(collection);

            // A `List<T>`/`HashSet<T>`/... collection-expression target maps to
            // the canonical G# collection-initializer form (`List[int32]{...}`,
            // ADR-0117) — NOT the array/slice literal `[]T{...}`, which does not
            // convert to a constructed collection class (issue #1897). Issue
            // #3096: native `...source` elements keep this form initializer-safe.
            if (isConstructibleClassTarget)
            {
                var initElements = new List<CollectionInitializerElement>();
                foreach (CollectionElementSyntax element in collection.Elements)
                {
                    if (element is SpreadElementSyntax spread)
                    {
                        initElements.Add(new CollectionInitializerElement(
                            new SpreadElementExpression(this.TranslateExpression(spread.Expression))));
                    }
                    else
                    {
                        var expressionElement = (ExpressionElementSyntax)element;
                        initElements.Add(new CollectionInitializerElement(
                            this.CoerceCollectionElement(
                                expressionElement.Expression,
                                elementType,
                                elementTypeSymbol)));
                    }
                }

                return new CollectionInitializerExpression(
                    BuildConstruction(targetRef, new List<GExpression>()), initElements);
            }

            // C# 12 collection expression `[a, b, c]` targeting an array/span.
            // The target type supplies the element type, so it maps to the
            // canonical G# slice literal `[]T{ … }` (ADR-0115 §B). Spreads map
            // directly to native G# ellipsis elements, with no statement-hosted
            // build/append temporary (issue #3096).
            var elements = new List<GExpression>();
            foreach (CollectionElementSyntax element in collection.Elements)
            {
                if (element is SpreadElementSyntax spread)
                {
                    elements.Add(new SpreadElementExpression(this.TranslateExpression(spread.Expression)));
                }
                else
                {
                    var expressionElement = (ExpressionElementSyntax)element;
                    elements.Add(this.CoerceCollectionElement(
                        expressionElement.Expression,
                        elementType,
                        elementTypeSymbol));
                }
            }

            return new ArrayLiteralExpression(elementType, elements);
        }

        private GExpression CoerceCollectionElement(
            ExpressionSyntax element,
            GTypeReference elementType,
            ITypeSymbol targetElementSymbol)
        {
            // A bare integer literal in a typed-narrower array (`[0, 0]` into a
            // `byte[]`) needs an explicit G# conversion, since untyped numeric
            // literals do not auto-narrow. Wrap such elements in `T(elem)`.
            GExpression translated = this.TranslateExpression(element);
            ITypeSymbol elementSymbol = this.context.GetTypeInfo(element).Type;
            ITypeSymbol convertedSymbol = this.context.GetTypeInfo(element).ConvertedType;
            translated = this.ForgiveNullableReferenceValue(
                element,
                translated,
                targetElementSymbol ?? convertedSymbol,
                targetSymbol: null);
            translated = this.AssertFlowNarrowedNullableReference(
                element,
                translated,
                elementType);
            if (elementSymbol != null && convertedSymbol != null &&
                !SymbolEqualityComparer.Default.Equals(elementSymbol, convertedSymbol) &&
                IsPrimitiveNumeric(elementSymbol) && IsPrimitiveNumeric(convertedSymbol))
            {
                return new ConversionExpression(elementType, translated);
            }

            return translated;
        }

        private static bool IsPrimitiveNumeric(ITypeSymbol type) => type.SpecialType switch
        {
            SpecialType.System_SByte or SpecialType.System_Byte or
            SpecialType.System_Int16 or SpecialType.System_UInt16 or
            SpecialType.System_Int32 or SpecialType.System_UInt32 or
            SpecialType.System_Int64 or SpecialType.System_UInt64 or
            SpecialType.System_Single or SpecialType.System_Double or
            SpecialType.System_Decimal or SpecialType.System_Char => true,
            _ => false,
        };

        private GTypeReference GetCollectionElementType(CollectionExpressionSyntax collection)
        {
            ITypeSymbol target = this.context.GetTypeInfo(collection).ConvertedType
                ?? this.context.GetTypeInfo(collection).Type;
            ITypeSymbol elementType = GetEnumerableElementType(target);
            if (elementType != null)
            {
                return this.typeMapper.Map(elementType, this.context, collection.GetLocation());
            }

            // No bound target type: fall back to the natural element type of the
            // first element, or `object` for an empty literal.
            ExpressionSyntax firstExpression = collection.Elements
                .OfType<ExpressionElementSyntax>()
                .Select(e => e.Expression)
                .FirstOrDefault();
            if (firstExpression != null &&
                this.context.GetTypeInfo(firstExpression).Type is { } natural)
            {
                return this.typeMapper.Map(natural, this.context, collection.GetLocation());
            }

            return new NamedTypeReference("object");
        }

        private static ITypeSymbol GetEnumerableElementType(ITypeSymbol type)
        {
            switch (type)
            {
                case null:
                    return null;
                case IArrayTypeSymbol array:
                    return array.ElementType;
                case INamedTypeSymbol named:
                    if (named.IsGenericType && named.TypeArguments.Length == 1)
                    {
                        return named.TypeArguments[0];
                    }

                    foreach (INamedTypeSymbol iface in named.AllInterfaces)
                    {
                        if (iface.OriginalDefinition.SpecialType == SpecialType.System_Collections_Generic_IEnumerable_T &&
                            iface.TypeArguments.Length == 1)
                        {
                            return iface.TypeArguments[0];
                        }
                    }

                    return null;
                default:
                    return null;
            }
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
        private GExpression TranslateRangeSlice(GExpression receiver, RangeExpressionSyntax range)
        {
            GExpression start = range.LeftOperand != null ? this.TranslateRangeBound(range.LeftOperand) : null;
            GExpression end = range.RightOperand != null ? this.TranslateRangeBound(range.RightOperand) : null;
            return new IndexExpression(receiver, new RangeIndexExpression(start, end));
        }

        private GExpression TranslateRangeBound(ExpressionSyntax bound) =>
            bound is PrefixUnaryExpressionSyntax fromEnd && fromEnd.IsKind(SyntaxKind.IndexExpression)
                ? new FromEndIndexExpression(this.TranslateExpression(fromEnd.Operand))
                : this.TranslateExpression(bound);

        private GTypeReference ResolveExpressionType(ExpressionSyntax expression)
        {
            TypeInfo info = this.context.GetTypeInfo(expression);
            ITypeSymbol type = info.ConvertedType ?? info.Type;

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
            if (CSharpTypeMapper.IsSystemIndexOrRange(type) && info.Type != null && !CSharpTypeMapper.IsSystemIndexOrRange(info.Type))
            {
                type = info.Type;
            }

            if (type == null || type.SpecialType == SpecialType.System_Void || type.TypeKind == TypeKind.Error)
            {
                return null;
            }

            return this.typeMapper.Map(type, this.context, expression.GetLocation());
        }
    }
}
