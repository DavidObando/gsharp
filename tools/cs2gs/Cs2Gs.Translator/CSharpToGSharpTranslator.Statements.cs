// <copyright file="CSharpToGSharpTranslator.Statements.cs" company="GSharp">
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
        private IEnumerable<GStatement> TranslateLocalDeclaration(VariableDeclarationSyntax declaration, bool isConst, bool isUsing = false, bool isAwait = false)
        {
            // Issue #1900: `ref int r = ref xs[1];` — a ref local. `declaration.Type`
            // is a `RefTypeSyntax`; every declarator in this statement is a ref
            // local aliasing storage, which maps to G#'s native ref-aliasing local
            // (see TranslateRefExpression / TranslateRefLocalDeclaration).
            if (declaration.Type is RefTypeSyntax)
            {
                return this.TranslateRefLocalDeclaration(declaration);
            }

            var results = new List<GStatement>();
            bool hasExplicitType = !declaration.Type.IsVar;

            foreach (VariableDeclaratorSyntax declarator in declaration.Variables)
            {
                GExpression initializer;
                if (declarator.Initializer == null)
                {
                    initializer = null;
                }
                else if (declarator.Initializer.Value is ArrayCreationExpressionSyntax multiDimCreation &&
                    multiDimCreation.Type.RankSpecifiers.Count > 0 &&
                    multiDimCreation.Type.RankSpecifiers[0].Sizes.Count > 1)
                {
                    // Issue #1893: `T[,] grid = new T[d0, d1, ...]` / `= new
                    // T[,]{{...}}` — flat-lower to a tracked backing array (see
                    // TranslateMultiDimArrayCreationForLocal) rather than the
                    // general single-dim initializer path below, which would
                    // silently drop every dimension past the first.
                    var multiDimPrologue = new List<GStatement>();
                    initializer = this.TranslateMultiDimArrayCreationForLocal(
                        multiDimCreation,
                        SanitizeIdentifier(declarator.Identifier.Text),
                        this.context.GetDeclaredSymbol(declarator),
                        multiDimPrologue);
                    results.AddRange(multiDimPrologue);
                }
                else
                {
                    // `int y = (x = 5) + 1;` — a value-position assignment nested in
                    // the initializer is hoisted into a preceding assignment
                    // statement; it runs once, exactly where C# would evaluate it
                    // (issue #1723).
                    List<AssignmentExpressionSyntax> initializerEmbedded =
                        this.CollectEmbeddedAssignments(declarator.Initializer.Value, includeSelf: true);
                    foreach (AssignmentExpressionSyntax node in initializerEmbedded)
                    {
                        results.AddRange(this.FlattenChainedAssignment(node));
                    }

                    foreach (AssignmentExpressionSyntax node in initializerEmbedded)
                    {
                        this.state.SuppressedAssignments.Add(node);
                    }

                    try
                    {
                        initializer = this.CoercePointerConversion(
                            declarator.Initializer.Value,
                            this.CoerceConstantToUnsigned(
                                declarator.Initializer.Value,
                                this.TranslateExpression(declarator.Initializer.Value)));
                    }
                    finally
                    {
                        foreach (AssignmentExpressionSyntax node in initializerEmbedded)
                        {
                            this.state.SuppressedAssignments.Remove(node);
                        }
                    }
                }

                // Issue #1954: `var g2 = grid;` — a simple `var` local initialized
                // directly from another local/parameter/field that is ITSELF a
                // tracked flat-lowered multi-dim array (see `multiDimArrays`)
                // aliases the SAME flat backing array, so `g2` is registered under
                // the SAME `MultiDimArrayInfo` (any rank) rather than losing
                // tracking and reporting the loud gap on its first `g2[i, j]`
                // access. An explicitly-typed declaration, or a RHS that is
                // anything other than a bare name/member reference to a tracked
                // symbol (a method call, a conditional, ...), is not "simple
                // aliasing" and is left to report the gap as before.
                if (!hasExplicitType &&
                    declarator.Initializer?.Value is IdentifierNameSyntax or MemberAccessExpressionSyntax &&
                    this.context.GetSymbolInfo(declarator.Initializer.Value).Symbol is { } rhsAliasSymbol &&
                    this.state.MultiDimArrays.TryGetValue(rhsAliasSymbol, out MultiDimArrayInfo aliasedInfo) &&
                    this.context.GetDeclaredSymbol(declarator) is { } declaredAliasSymbol)
                {
                    this.state.MultiDimArrays[declaredAliasSymbol] = aliasedInfo;
                }

                // Issue #1894: a local's declared type normally only reaches
                // CSharpTypeMapper.Map when an explicit type clause is emitted
                // below — but when the declared type equals the initializer's
                // natural type (the common case, e.g. `Index x = ^3;` or the
                // `var`-inferred equivalent), the type clause is elided entirely
                // and Map is never called, so an Index/Range-typed local would
                // slip through with no diagnostic. Check the bound local symbol's
                // type directly so every Index/Range local gaps loudly regardless
                // of whether a type clause ends up in the printed G#.
                if (this.context.GetDeclaredSymbol(declarator) is ILocalSymbol { Type: { } localType } &&
                    CSharpTypeMapper.IsSystemIndexOrRange(localType))
                {
                    this.context.Report(new TranslationDiagnostic(
                        localType.Name,
                        $"local '{declarator.Identifier.Text}' has type 'System.{localType.Name}', which has no canonical G# type — see CSharpTypeMapper.Map (issue #1894).",
                        declarator.GetLocation(),
                        TranslationSeverity.Unsupported));
                }

                BindingKind binding;
                if (isConst)
                {
                    binding = BindingKind.Const;
                }
                else if (isUsing)
                {
                    // A `using` resource is read-only after acquisition; it maps to
                    // the immutable `using let` form (sample Defer.gs).
                    binding = BindingKind.Let;
                }
                else
                {
                    var local = this.context.GetDeclaredSymbol(declarator) as ILocalSymbol;
                    binding = local != null && this.IsLocalReassigned(local)
                        ? BindingKind.Var
                        : BindingKind.Let;
                }

                // An immutable `let` requires an initializer; a declaration with no
                // initializer (e.g. a pre-declared `out` target, `int x;`) must bind
                // as mutable `var <name> <type>` so the zero value is named and the
                // subsequent assignment is legal (spec §Bindings, ADR-0115 §B.3).
                if (declarator.Initializer == null && binding == BindingKind.Let)
                {
                    binding = BindingKind.Var;
                }

                // A type clause is required when there is no initializer (it names
                // the zero/default value, spec §Bindings). With an initializer the
                // type is normally inferred (ADR-0115 §B.3) — but when the C#
                // developer wrote an explicit type that differs from the
                // initializer's natural type (an implicit conversion, e.g.
                // `long startSample = 0;` where `0` is `int`), G# would re-infer
                // the narrower natural type and later operations (e.g. `+=` with an
                // `int64` value) fail with GS0129. In that case preserve the
                // developer's declared type so the binding keeps the intended type.
                GTypeReference type = null;
                if (hasExplicitType)
                {
                    bool emitType = initializer == null;

                    // Prefer the local symbol's type: it carries the flow
                    // nullable annotation (`SttsBox?`), whereas
                    // `GetTypeInfo(declaration.Type)` reports the bare type and
                    // silently drops the `?`, so a nullable-enabled local would
                    // be rendered non-nullable and later `= nil`/`== nil` fail.
                    ITypeSymbol declaredType =
                        (this.context.GetDeclaredSymbol(declarator) as ILocalSymbol)?.Type
                        ?? this.context.GetTypeInfo(declaration.Type).Type;

                    if (!emitType && initializer != null && declaredType != null)
                    {
                        // Preserve the explicit type only when it differs from the
                        // initializer's natural type (an implicit conversion). When
                        // they match, omit the clause and rely on inference — the
                        // idiomatic common case. A declared nullable reference
                        // (`Box?`) whose initializer is non-null would infer the
                        // narrower non-null type, so always emit it to keep the `?`.
                        ITypeSymbol naturalType =
                            this.context.GetTypeInfo(declarator.Initializer.Value).Type;
                        if (naturalType == null
                            || !SymbolEqualityComparer.Default.Equals(declaredType, naturalType)
                            || IsAnnotatedNullableReference(declaredType))
                        {
                            emitType = true;
                        }
                        else if (this.context.GetDeclaredSymbol(declarator) is ILocalSymbol equalTypeLocal
                            && this.ShouldPromoteToNullableReference(equalTypeLocal))
                        {
                            // Issue #1737: the explicit-type-equals-initializer-type
                            // shape above bypasses the type clause entirely (relying
                            // on inference), which would also silently drop the
                            // #1072 nullable promotion below. Route it through the
                            // same emitType=true path as every other explicit-typed
                            // shape so `var x = e;` and `T x = e;` (declared type ==
                            // natural type) promote identically.
                            emitType = true;
                        }
                    }

                    if (emitType)
                    {
                        type = declaredType != null
                            ? this.typeMapper.Map(declaredType, this.context, declaration.Type.GetLocation())
                            : null;

                        // Issue #1072: a non-nullable reference/array local that is
                        // null-checked or null-assigned in its scope is really nullable.
                        if (this.context.GetDeclaredSymbol(declarator) is ILocalSymbol localSymbol)
                        {
                            type = this.PromoteIfUsedAsNullable(type, localSymbol);
                        }
                    }
                }
                else if (initializer != null &&
                    this.context.GetDeclaredSymbol(declarator) is ILocalSymbol inferredLocal &&
                    (this.ShouldPromoteToNullableReference(inferredLocal)
                        || (IsAnnotatedNullableReference(inferredLocal.Type)
                            && this.IsUsedAsNullable(inferredLocal, this.GetNullabilityScope(inferredLocal)))))
                {
                    // Issue #1072/#2305 (inferred-type form): a `var x = e` local
                    // whose uses prove it nullable needs an explicit `T?`.
                    // Otherwise G# may re-infer a non-null type from `e`, making a
                    // later nil check fail GS0129.
                    type = MakeNullable(this.typeMapper.Map(
                        inferredLocal.Type, this.context, declaration.Type.GetLocation()));
                }

                results.Add(new LocalDeclarationStatement(
                    binding,
                    SanitizeIdentifier(declarator.Identifier.Text),
                    type,
                    initializer,
                    isUsing: isUsing,
                    isAwait: isAwait));
            }

            return results;
        }

        /// <summary>
        /// Translates every declarator of a ref-local declaration (<c>ref int r =
        /// ref xs[1];</c>, issue #1900) into G#'s native ref-aliasing local
        /// (<c>let ref name T = lvalue</c> / <c>var ref name T = lvalue</c>,
        /// issue #491/ADR-0060 §follow-up). Unlike C#, the RHS carries no second
        /// `ref` keyword — the `ref` modifier on the binding itself is what marks
        /// the local as an alias. Reads and writes of the local afterward are
        /// ordinary identifier references; gsc routes them through the alias
        /// transparently, so — unlike a hand-rolled pointer lowering — no
        /// rewriting of later usages is needed here.
        /// </summary>
        private IEnumerable<GStatement> TranslateRefLocalDeclaration(VariableDeclarationSyntax declaration)
        {
            var results = new List<GStatement>();

            foreach (VariableDeclaratorSyntax declarator in declaration.Variables)
            {
                if (this.context.GetDeclaredSymbol(declarator) is not ILocalSymbol localSymbol)
                {
                    continue;
                }

                string name = SanitizeIdentifier(declarator.Identifier.Text);

                GExpression initializer = declarator.Initializer?.Value is RefExpressionSyntax refInit
                    ? this.TranslateRefExpression(refInit)
                    : null;

                if (initializer == null)
                {
                    string message = $"ref local '{declarator.Identifier.Text}' has no `ref` initializer expression; a ref local must be aliased at declaration (issue #1900).";
                    this.context.ReportUnsupported(declarator, message);
                    continue;
                }

                GTypeReference pointeeType = this.typeMapper.Map(localSymbol.Type, this.context, declaration.Type.GetLocation());

                // The alias is written through by a plain `name = value` in the
                // original C# (e.g. `r = 20;`) exactly like a normal local, so the
                // existing reassignment heuristic decides `let ref` vs `var ref`
                // the same way it decides `let` vs `var` for any other local.
                BindingKind binding = this.IsLocalReassigned(localSymbol) ? BindingKind.Var : BindingKind.Let;

                results.Add(new LocalDeclarationStatement(
                    binding,
                    name,
                    pointeeType,
                    initializer,
                    isRefAlias: true));
            }

            return results;
        }

        /// <summary>
        /// Translates a C# binary expression, inserting an explicit numeric
        /// conversion when C#'s implicit numeric promotion bridged two operands of
        /// different numeric types. G# has no implicit cross-type numeric promotion:
        /// an operator such as <c>==</c>/<c>&lt;</c>/<c>+</c> is per-primitive-type,
        /// so <c>uint16 == int32</c> (and the lifted <c>uint16? == int32</c>) is
        /// <c>GS0129</c>. The faithful fix mirrors C#: when one operand is a constant
        /// literal, retype the literal to the other operand's G# type; otherwise
        /// convert each C#-promoted operand to the common (promoted) type.
        /// </summary>
        private GExpression TranslateBinaryExpression(BinaryExpressionSyntax binary)
        {
            GExpression left = this.TranslateExpression(binary.Left);
            string op = binary.OperatorToken.Text;
            GExpression right = this.TranslateExpression(binary.Right);

            // C# string concatenation `a + b`: when the `+` operator binds to
            // `string`, C# implicitly converts each non-string operand to a string
            // (via `String.Concat`/`ToString`). G# has no implicit conversion, so a
            // `+` whose operands are not both `string` is GS0129 (`operator '+' is
            // not defined for 'Indent' and 'string'`). Rewrite each non-string
            // operand to an explicit `operand.ToString()` so the concatenation
            // type-checks, matching C#'s displayed value.
            if (binary.IsKind(SyntaxKind.AddExpression)
                && this.context.GetTypeInfo(binary).Type?.SpecialType == SpecialType.System_String)
            {
                left = this.CoerceConcatOperand(binary.Left, left);
                right = this.CoerceConcatOperand(binary.Right, right);
                return new BinaryExpression(left, op, right);
            }

            // C# null-coalescing `a ?? b`: the left is a nullable numeric, the
            // right must match the left's *underlying* (non-nullable) numeric type
            // (a `??` is not a symmetric arithmetic promotion of both sides). Only
            // apply this when both sides are numeric; mixed reference cases such as
            // `Task<T>? ?? Task` flow through unchanged.
            if (op == "??")
            {
                return this.TranslateNullCoalescing(binary, left, right);
            }

            // Issue #1232: G# now matches C#'s shift-count ergonomics — gsc
            // implicitly widens a narrower-order integer shift count to int32 —
            // so `<<` / `>>` translate straight through with no count coercion.
            // (`<<` / `>>` are not numeric-promotion operators, so they fall
            // through to the plain binary form below.)
            if (!IsNumericPromotionOperator(op))
            {
                return new BinaryExpression(left, op, right);
            }

            ITypeSymbol leftType = this.context.GetTypeInfo(binary.Left).Type;
            ITypeSymbol rightType = this.context.GetTypeInfo(binary.Right).Type;

            if (!TryGetNumericKind(leftType, out SpecialType leftUnderlying) ||
                !TryGetNumericKind(rightType, out SpecialType rightUnderlying))
            {
                return new BinaryExpression(left, op, right);
            }

            // Operand types already share an underlying numeric type (only the
            // nullability may differ, e.g. `int32? == 2`); G# accepts those directly,
            // so leave the expression untouched.
            if (leftUnderlying == rightUnderlying)
            {
                return new BinaryExpression(left, op, right);
            }

            bool leftConst = this.context.SemanticModel.GetConstantValue(binary.Left).HasValue;
            bool rightConst = this.context.SemanticModel.GetConstantValue(binary.Right).HasValue;

            // Prefer the minimal, faithful form: a constant expression is retyped to
            // the other (non-constant) operand's G# type so both operands share a
            // type (e.g. `channelCount == (2 as uint16?)`). This mirrors C#'s
            // constant-expression narrowing conversions (C# §10.2.11), which are
            // defined ONLY between integral types (int/long constants narrowing to
            // a smaller/differently-signed integral type) — never between a
            // floating-point/decimal type and an integral type. Issue #2352: a
            // `double`/`float`/`decimal` constant (including one folded from a
            // compile-time-constant sub-expression, e.g. `1.0 * 2.0`) must NEVER be
            // narrowed down to the other operand's integral type this way — nor may
            // a floating-point/decimal non-constant operand's declared type be used
            // to narrow an integral constant, since C# binary numeric promotion
            // always widens the integral side to match float/double/decimal,
            // regardless of which side happens to be a constant. Restricting this
            // branch to "both operands are integral" routes every
            // floating-point/decimal combination through the converted-type-driven
            // logic below instead, which always follows Roslyn's own promotion
            // direction.
            bool leftIsIntegral = IsIntegralNumericKind(leftUnderlying);
            bool rightIsIntegral = IsIntegralNumericKind(rightUnderlying);

            if (rightConst && !leftConst && leftIsIntegral && rightIsIntegral)
            {
                right = this.CoerceOperandTo(right, leftType);
                return new BinaryExpression(left, op, right);
            }

            if (leftConst && !rightConst && leftIsIntegral && rightIsIntegral)
            {
                left = this.CoerceOperandTo(left, rightType);
                return new BinaryExpression(left, op, right);
            }

            // Neither (or both) operand is a constant expression, or one side is a
            // floating-point/decimal type: convert each operand that C# promoted
            // (its declared type differs from the common converted type) to that
            // common type. Roslyn's `ConvertedType` always reflects the correct C#
            // binary numeric promotion direction here — including widening an
            // integral non-constant operand up to a constant's floating-point type
            // (issue #2352) — independent of which side is a compile-time constant.
            ITypeSymbol leftConverted = this.context.GetTypeInfo(binary.Left).ConvertedType;
            ITypeSymbol rightConverted = this.context.GetTypeInfo(binary.Right).ConvertedType;

            if (TryGetNumericKind(leftConverted, out SpecialType leftConvUnderlying) &&
                leftConvUnderlying != leftUnderlying)
            {
                left = this.CoerceOperandTo(left, leftConverted);
            }

            if (TryGetNumericKind(rightConverted, out SpecialType rightConvUnderlying) &&
                rightConvUnderlying != rightUnderlying)
            {
                right = this.CoerceOperandTo(right, rightConverted);
            }

            return new BinaryExpression(left, op, right);
        }

        // For a string-concatenation `+` operand: if the operand's C# type is not
        // already `string`, wrap the translated operand in an explicit
        // `operand.ToString()` call so G# (which has no implicit string conversion)
        // type-checks the concatenation. A string operand (including a nested
        // string `+` sub-expression, whose type is also `string`) is returned
        // unchanged, as is a bare `null` literal (`null.ToString()` would throw;
        // C# renders it as the empty string, and a translated `nil` keeps that
        // intent while remaining assignable to a `string` slot). The operand is
        // parenthesized when needed so member access binds to the whole operand.
        private GExpression CoerceConcatOperand(ExpressionSyntax operandSyntax, GExpression translated)
        {
            ITypeSymbol operandType = this.context.GetTypeInfo(operandSyntax).Type;
            if (operandType?.SpecialType == SpecialType.System_String)
            {
                return translated;
            }

            if (IsNullOrSuppressedNull(operandSyntax))
            {
                return translated;
            }

            GExpression receiver = translated is BinaryExpression or IfExpression || IsBareNumericLiteral(translated)
                ? new ParenthesizedExpression(translated)
                : translated;

            return new InvocationExpression(new MemberAccessExpression(receiver, "ToString"));
        }

        // Issue #1960 item 2: true when `assignment` is a `+=`/`-=` whose LEFT
        // side is delegate-typed (TypeKind.Delegate covers both a named delegate
        // and Action/Func-shaped BCL delegates) but is NOT a declared C# event —
        // i.e. a raw delegate multicast combine/remove, which has no G# form.
        // A real event access (`obj.Ticked += handler`) resolves to an
        // IEventSymbol and is excluded so it keeps flowing through the normal
        // compound-assignment path (G#'s event-subscription `+=`/`-=`).
        private bool IsDelegateMulticastCombine(AssignmentExpressionSyntax assignment, out string op)
        {
            op = assignment.OperatorToken.Text;
            if (!assignment.IsKind(SyntaxKind.AddAssignmentExpression) &&
                !assignment.IsKind(SyntaxKind.SubtractAssignmentExpression))
            {
                return false;
            }

            if (this.context.GetSymbolInfo(assignment.Left).Symbol is IEventSymbol)
            {
                return false;
            }

            return this.context.GetTypeInfo(assignment.Left).Type?.TypeKind == TypeKind.Delegate;
        }

        // Issue #914 (oblivious sink): a CLR event subscription `e += handler` /
        // `e -= handler` whose right-hand side is an oblivious-promoted nullable
        // function value (e.g. a `DataReceivedEventHandler eventHandler = null`
        // parameter that promotes to `((object, DataReceivedEventArgs) -> void)?`)
        // assigns a `T?` into the event's NAMED delegate type. gsc imports that
        // delegate target as a non-nullable reference — even when the C# BCL event
        // is annotated `DataReceivedEventHandler?`, the metadata annotation is not
        // carried onto the arrow type gsc converts through — so the extra `?` on
        // the promoted RHS is rejected (GS0155). Forgive it at the sink with `!!`,
        // exactly like every other promoted-nullable-into-non-nullable sink
        // (return/argument/tuple). Gated to a promoted RHS, so a nullable-enabled
        // compilation (nothing is promoted) and every non-promoted RHS are
        // byte-identical.
        private GExpression ForgiveEventSubscriptionRhs(
            AssignmentExpressionSyntax assignment, GExpression translatedRhs)
        {
            if ((!assignment.IsKind(SyntaxKind.AddAssignmentExpression)
                    && !assignment.IsKind(SyntaxKind.SubtractAssignmentExpression))
                || translatedRhs is NonNullAssertionExpression
                || this.context.GetSymbolInfo(assignment.Left).Symbol is not IEventSymbol eventSymbol
                || eventSymbol.Type is not { IsReferenceType: true })
            {
                return translatedRhs;
            }

            return this.IsNullablePromotedValue(assignment.Right)
                ? new NonNullAssertionExpression(translatedRhs)
                : translatedRhs;
        }

        // Issue #2259 (oblivious sink): an ELEMENT-access assignment target
        // (`arr[i] = …`, a `Dictionary`/user-indexer write, …) whose RHS is a
        // null-conditional access result (`x?[i]` / `x?.Member`) or any other
        // promoted-nullable value trips a `T? -> T` GS0156 once gsc's strict
        // nullability sees the RHS's true `T?` type. A field/property/local/
        // parameter assignment TARGET is instead widened to `T?` at its own
        // declaration by the whole-program taint analysis (see
        // ObliviousNullabilityAnalyzer's SimpleAssignmentExpression edge in
        // CollectEdges), but an element-access target has no single declaration
        // to widen — promoting the whole array/collection's element type would
        // ripple to every other read of it — so the minimal, generalized fix is
        // a `!!` assertion at the RHS use site instead, exactly like every other
        // promoted-nullable-into-non-nullable sink (return/argument/tuple/event).
        // Gated to an oblivious compilation and skipped when the resolved LHS
        // indexer is itself declared or promoted nullable (nothing to forgive),
        // so a nullable-enabled compilation and an already-nullable sink are
        // byte-identical.
        private GExpression ForgiveElementAccessAssignmentRhs(
            AssignmentExpressionSyntax assignment, GExpression translatedRhs)
        {
            if (!this.IsObliviousCompilation()
                || !assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                || translatedRhs is NonNullAssertionExpression
                || assignment.Left is not ElementAccessExpressionSyntax
                || !this.IsNullablePromotedValue(assignment.Right))
            {
                return translatedRhs;
            }

            ITypeSymbol leftType = this.context.GetTypeInfo(assignment.Left).Type;
            if (leftType is not { IsReferenceType: true }
                || leftType.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return translatedRhs;
            }

            if (this.context.GetSymbolInfo(assignment.Left).Symbol is IPropertySymbol indexer
                && this.ShouldPromoteToNullableReference(indexer))
            {
                return translatedRhs;
            }

            return new NonNullAssertionExpression(translatedRhs);
        }

        // For a compound numeric assignment `x OP= y` (`+= -= *= /= %= &= |= ^=`),
        // G# requires the RHS to share the LHS's numeric type; a mismatched RHS is
        // coerced to the LHS type via the conversion-call form (e.g. `x += int64(y)`).
        // A nullable RHS is coerced through the LHS's underlying numeric type.
        private GExpression CoerceCompoundAssignmentRhs(
            AssignmentExpressionSyntax assignment, GExpression rhs)
        {
            if (assignment.IsKind(SyntaxKind.SimpleAssignmentExpression))
            {
                return rhs;
            }

            // Issue #1232: compound shift (`<<=` / `>>=`). The RHS is a shift
            // count, NOT the LHS numeric type — gsc now implicitly widens a
            // narrower-order integer count to int32, so the count needs no
            // coercion. Return it unchanged (and, crucially, skip the LHS-type
            // numeric promotion below, which would wrongly coerce the count to
            // the LHS type, e.g. `uint32(count)` → GS0129).
            if (assignment.IsKind(SyntaxKind.LeftShiftAssignmentExpression) ||
                assignment.IsKind(SyntaxKind.RightShiftAssignmentExpression) ||
                assignment.IsKind(SyntaxKind.UnsignedRightShiftAssignmentExpression))
            {
                return rhs;
            }

            ITypeSymbol leftType = this.context.GetTypeInfo(assignment.Left).Type;
            ITypeSymbol rightType = this.context.GetTypeInfo(assignment.Right).Type;

            if (TryGetNumericKind(leftType, out SpecialType leftUnderlying) &&
                TryGetNumericKind(rightType, out SpecialType rightUnderlying) &&
                leftUnderlying != rightUnderlying)
            {
                return this.CoerceOperandTo(rhs, UnwrapNullable(leftType));
            }

            return rhs;
        }

        // C# array-creation lengths accept any integral type (`new T[uint]`,
        // `new T[long]`, …), but the native G# allocation form `[n]T` (issue
        // #1272) takes an `int32`. Coerce a non-`int32` numeric length to int32
        // via the conversion-call form so the allocation binds. A nullable or
        // non-numeric length is left unchanged.
        private GExpression CoerceLengthToInt32(
            ExpressionSyntax lengthSyntax, GExpression length)
        {
            ITypeSymbol lengthType = this.context.GetTypeInfo(lengthSyntax).Type;
            if (lengthType != null &&
                IsNonNullableValueType(lengthType) &&
                TryGetNumericKind(lengthType, out SpecialType underlying) &&
                underlying != SpecialType.System_Int32)
            {
                ITypeSymbol int32Type =
                    this.context.Compilation.GetSpecialType(SpecialType.System_Int32);
                return this.CoerceOperandTo(length, int32Type);
            }

            return length;
        }

        // G# array/indexer element access. Issue #1279: gsc now accepts ANY
        // C#-supported integer type as an array/slice element index (it converts
        // the wider/unsigned kinds — `uint`, `long`, `ulong`, `nint`, `nuint` —
        // to native int), so an ARRAY index needs no `int32(...)` coercion and is
        // emitted idiomatically. A user/CLR indexer (`List<T>`, `Span<T>`,
        // `IReadOnlyList<T>`, ...) whose single parameter is `int32` still binds
        // its argument to `int32` via normal conversion rules in gsc, so a wide
        // index against such an indexer is still wrapped in `int32(<index>)`.
        // Dictionary/other indexers keyed by a non-`int32` type, `System.Index`/
        // `System.Range` indices, and indices already `int`/narrower are left
        // untouched.
        private GExpression CoerceIndexToInt32(
            ElementAccessExpressionSyntax elementAccess, GExpression index)
        {
            if (elementAccess.ArgumentList.Arguments.Count != 1)
            {
                return index;
            }

            // Issue #1279: arrays accept any integer index in gsc — no coercion.
            if (this.context.GetTypeInfo(elementAccess.Expression).Type is IArrayTypeSymbol)
            {
                return index;
            }

            if (!this.IndexerTargetTypeIsInt32(elementAccess))
            {
                return index;
            }

            ExpressionSyntax indexSyntax = elementAccess.ArgumentList.Arguments[0].Expression;
            ITypeSymbol indexType = this.context.GetTypeInfo(indexSyntax).Type;
            if (indexType != null &&
                IsNonNullableValueType(indexType) &&
                IsIntegerNotWideningToInt32(indexType))
            {
                ITypeSymbol int32Type =
                    this.context.Compilation.GetSpecialType(SpecialType.System_Int32);
                return this.CoerceOperandTo(index, int32Type);
            }

            return index;
        }

        // Issue #1954: a multi-index access's flat index is rebuilt with real
        // arithmetic (`i0*dim1 + i1`, each `dim` an int32 hoisted `let`/
        // literal — see `TranslateMultiDimElementAccess`), unlike the
        // single-index path above where the index is handed unmodified to
        // gsc's own indexer, which itself accepts any integer kind (#1279).
        // Mixing a wide index (`long`/`ulong`/`nint`/`nuint`) into that int32
        // arithmetic needs the same widening-coercion rule `CoerceIndexToInt32`
        // applies, so this mirrors its tail check directly against the index
        // syntax rather than re-deriving it from an `ElementAccessExpression`
        // argument-count/indexer-target shape that does not apply here.
        private GExpression CoerceMultiDimIndexToInt32(ExpressionSyntax indexSyntax, GExpression index)
        {
            ITypeSymbol indexType = this.context.GetTypeInfo(indexSyntax).Type;
            if (indexType != null &&
                IsNonNullableValueType(indexType) &&
                IsIntegerNotWideningToInt32(indexType))
            {
                ITypeSymbol int32Type =
                    this.context.Compilation.GetSpecialType(SpecialType.System_Int32);
                return this.CoerceOperandTo(index, int32Type);
            }

            return index;
        }

        // Issue #1894/#1967: whether `expression` sits directly in a bracketed
        // index argument position (`recv[EXPR]` / `recv?[EXPR]` / a dictionary/
        // collection-initializer element `{ [EXPR] = v }`) — the one position
        // where gsc's own parser recognises a leading `^` as a from-end marker
        // rather than one's-complement (Parser.ParseIndexBound). A `^n` nested
        // any deeper (e.g. as a `RangeExpressionSyntax` bound, `recv[a..^n]`) is
        // NOT a direct argument — `TranslateRangeBound` emits it as its own
        // native `FromEndIndexExpression` (gsc's `^n`) before it ever reaches
        // this generic prefix-unary path (an inline `recv[a..^n]` slice never
        // gaps). `ImplicitElementAccessSyntax` is the initializer-element shape
        // (`{ [^1] = v }` inside a collection/object initializer) — Roslyn binds
        // its bracketed argument list directly to it (no `ElementAccessExpressionSyntax`
        // wrapper), so it must be recognised here too or a from-end index inside
        // an initializer element would over-gap (issue #1967).
        private static bool IsDirectIndexBracketArgument(ExpressionSyntax expression) =>
            expression.Parent is ArgumentSyntax
            {
                Parent: BracketedArgumentListSyntax
                {
                    Parent: ElementAccessExpressionSyntax or ElementBindingExpressionSyntax or ImplicitElementAccessSyntax,
                },
            };

        // Issue #1967: hardens the issue #1894 loud-gap check (see
        // `TranslateLocalDeclaration`'s declared-symbol check) against Index/Range
        // locals bound OUTSIDE a `var`/typed local declarator — `foreach (Index i in
        // xs)`, `x is Index i`/`case Index i`, `M(out Index i)`, and tuple/positional
        // deconstruction (`var (i, r) = ...`) all declare a NEW `ILocalSymbol`
        // without ever going through `TranslateLocalDeclaration`, so an Index/Range
        // local bound at one of those sites would silently bypass the existing
        // guard. Every one of those sites resolves its designation to a declared
        // symbol independently; this is the single choke point they all route
        // through to report the same gap uniformly.
        private void ReportIfIndexOrRangeTypedDesignation(SingleVariableDesignationSyntax designation)
        {
            if (designation == null || !this.state.ReportedIndexRangeDesignations.Add(designation))
            {
                return;
            }

            if (this.context.GetDeclaredSymbol(designation) is ILocalSymbol { Type: { } type } &&
                CSharpTypeMapper.IsSystemIndexOrRange(type))
            {
                this.context.Report(new TranslationDiagnostic(
                    type.Name,
                    $"local '{designation.Identifier.Text}' has type 'System.{type.Name}', which has no canonical G# type — see CSharpTypeMapper.Map (issue #1894).",
                    designation.GetLocation(),
                    TranslationSeverity.Unsupported));
            }
        }

        // Issue #1967: scans every `SingleVariableDesignationSyntax` nested
        // anywhere inside a pattern tree (a bare `Index i`, or one nested inside a
        // recursive/positional/list/`and`/`or`/`not` pattern) and reports the same
        // Index/Range loud gap as a declarator. Called once per pattern ROOT (never
        // from the recursive per-subpattern translators) so a nested designation is
        // checked exactly once.
        private void ReportIndexOrRangeDesignationsInPattern(PatternSyntax pattern)
        {
            if (pattern == null)
            {
                return;
            }

            foreach (SingleVariableDesignationSyntax designation in
                pattern.DescendantNodesAndSelf().OfType<SingleVariableDesignationSyntax>())
            {
                this.ReportIfIndexOrRangeTypedDesignation(designation);
            }
        }

        // Issue #1967: `foreach (Index i in xs)` declares its loop variable
        // directly on the `ForEachStatementSyntax` node itself (no designation
        // syntax at all — unlike every other declaration site), so it needs its
        // own symbol-based guard mirroring `ReportIfIndexOrRangeTypedDesignation`.
        private void ReportIfIndexOrRangeTypedForEachVariable(ForEachStatementSyntax forEach)
        {
            if (this.context.GetDeclaredSymbol(forEach) is ILocalSymbol { Type: { } type } &&
                CSharpTypeMapper.IsSystemIndexOrRange(type))
            {
                this.context.Report(new TranslationDiagnostic(
                    type.Name,
                    $"local '{forEach.Identifier.Text}' has type 'System.{type.Name}', which has no canonical G# type — see CSharpTypeMapper.Map (issue #1894).",
                    forEach.GetLocation(),
                    TranslationSeverity.Unsupported));
            }
        }

        // Issue #1967: `M(out Index i)` declares `i` via an out-argument
        // designation, not a declarator — check it here, the single choke point
        // every `out var`/`out T` argument translates through.
        private GExpression TranslateOutVarDesignation(SingleVariableDesignationSyntax single)
        {
            this.ReportIfIndexOrRangeTypedDesignation(single);
            return new OutArgumentExpression("out var", SanitizeIdentifier(single.Identifier.Text));
        }

        // Issue #1967: an Index/Range-typed LINQ query range variable
        // (`from Index i in xs`, `let i = <Index expr>`, `join`, or a query
        // continuation's `into y`) binds via a query clause, not a designation —
        // it never goes through `ReportIfIndexOrRangeTypedDesignation`. `type` is
        // the range variable's resolved element type (explicit `TypeSyntax` wins,
        // else inferred from the source collection/`let` expression — same
        // resolution `ResolveRangeVariableType`/`ResolveRangeVariableElementTypeSymbol`
        // use, so the loud gap and the actual G# type stay in sync).
        private void ReportIfIndexOrRangeTypedRangeVariable(SyntaxNode anchor, SyntaxToken identifier, ITypeSymbol type)
        {
            if (type != null && CSharpTypeMapper.IsSystemIndexOrRange(type))
            {
                this.context.Report(new TranslationDiagnostic(
                    type.Name,
                    $"query range variable '{identifier.Text}' has type 'System.{type.Name}', which has no canonical G# type — see CSharpTypeMapper.Map (issue #1894).",
                    anchor.GetLocation(),
                    TranslationSeverity.Unsupported));
            }
        }

        // Resolves an Index/Range check for a `from`/`join` range variable: an
        // explicit `TypeSyntax` wins, else the source collection's element type
        // (mirrors `ResolveRangeVariableType`'s own precedence).
        private void ReportIfIndexOrRangeTypedRangeVariable(
            SyntaxNode anchor, SyntaxToken identifier, TypeSyntax explicitType, ExpressionSyntax source)
        {
            ITypeSymbol type = explicitType != null
                ? this.context.GetTypeInfo(explicitType).Type
                : this.ResolveRangeVariableElementTypeSymbol(source);
            this.ReportIfIndexOrRangeTypedRangeVariable(anchor, identifier, type);
        }

        // Reports whether the element-access target indexes by `int32`: a C# array,
        // or a type whose bound indexer takes a single `int32` parameter (such as
        // `List<T>`, `Span<T>`, `IReadOnlyList<T>`). A `Dictionary<TKey, T>` or any
        // other indexer keyed by a non-`int32` type returns false.
        private bool IndexerTargetTypeIsInt32(ElementAccessExpressionSyntax elementAccess)
        {
            ITypeSymbol receiverType = this.context.GetTypeInfo(elementAccess.Expression).Type;
            if (receiverType is IArrayTypeSymbol)
            {
                return true;
            }

            if (this.context.GetSymbolInfo(elementAccess).Symbol is IPropertySymbol
                    { IsIndexer: true, Parameters.Length: 1 } indexer)
            {
                return indexer.Parameters[0].Type.SpecialType == SpecialType.System_Int32;
            }

            return false;
        }

        // Reports whether `type` is an integral type that does NOT implicitly widen
        // to `int32` in C# — `uint`/`uint32`, `long`/`int64`, `ulong`/`uint64`,
        // `nint`, and `nuint`. The narrow integrals (`byte`, `sbyte`, `short`,
        // `ushort`, `char`) and `int` itself widen to/are `int32` and return false.
        private static bool IsIntegerNotWideningToInt32(ITypeSymbol type)
        {
            switch (type.SpecialType)
            {
                case SpecialType.System_UInt32:
                case SpecialType.System_Int64:
                case SpecialType.System_UInt64:
                case SpecialType.System_IntPtr:
                case SpecialType.System_UIntPtr:
                    return true;
                default:
                    return false;
            }
        }

        // C# `a ?? b` where `a` is a nullable numeric and the operands' numeric
        // kinds differ: the coercion target is the *result* type of the whole
        // `??` expression — C#'s best-common-type computation (§12.15), exactly
        // as `GetTypeInfo(binary).Type` already reports it — not unconditionally
        // the left operand's type (issue #1725). When the right operand is
        // *wider* than the left (e.g. `long r = nullableInt ?? longDefault;`),
        // C# types the whole expression as the right operand's (wider) type and
        // converts the LEFT's non-null value instead; the old code coerced the
        // right operand DOWN to the left's narrower type, silently truncating
        // it (or truncating a `double` fallback to the left's integral type).
        //
        // gsc's own `??` binder (issue #1239) already performs this same
        // C#-faithful best-common-type widening and auto-converts the left
        // operand's non-null value whenever the left is the narrower side —
        // verified directly against gsc for int32?/int64, int32?/double,
        // int64?/int32 (left wider), float?/double, uint32?/int64, and
        // int32?/decimal (see Issue1725NullCoalescingNumericWideningEmitTests
        // for the runtime locks of each combo). The one gap gsc does not
        // fill on its own is a *constant* right operand whose natural
        // numeric kind differs
        // from the result (e.g. `x ?? 0` for `uint32? x`: the literal `0`'s
        // natural type `int32` differs from the `uint32` result C# computed
        // via its constant-literal conversion rule, which gsc's type-only
        // conversion lattice does not special-case) — only in that direction
        // is an explicit coercion required, and it always targets the
        // *result* type, never the left type. Coercing the right operand when
        // it already matches the result type is a no-op (skipped below), so
        // this also covers left-wider-than-right (right coerced up, as
        // before) and equal-kind operands (no coercion, unchanged).
        // Non-numeric coalescing (reference types, tasks) is left untouched.
        private GExpression TranslateNullCoalescing(
            BinaryExpressionSyntax binary, GExpression left, GExpression right)
        {
            ITypeSymbol leftType = this.context.GetTypeInfo(binary.Left).Type;
            ITypeSymbol rightType = this.context.GetTypeInfo(binary.Right).Type;

            if (TryGetNumericKind(leftType, out SpecialType leftUnderlying) &&
                TryGetNumericKind(rightType, out SpecialType rightUnderlying) &&
                leftUnderlying != rightUnderlying)
            {
                // `.Type` (not `.ConvertedType`) is the `??` expression's own
                // best-common-type per C# §12.15 — the value we need here.
                // `.ConvertedType` instead reflects an ENCLOSING conversion
                // (e.g. an assignment's target type), which would let an
                // outer context over-coerce this operand to the wrong type
                // (S1). `.Type` is only null for an unresolved/erroneous
                // expression; both operands already passed `TryGetNumericKind`
                // above, meaning the semantic model fully resolved this `??`,
                // so `.Type` is guaranteed non-null here.
                ITypeSymbol resultType = this.context.GetTypeInfo(binary).Type;

                if (TryGetNumericKind(resultType, out SpecialType resultUnderlying) &&
                    rightUnderlying != resultUnderlying)
                {
                    right = this.CoerceOperandTo(right, UnwrapNullable(resultType));
                }
            }

            return new BinaryExpression(left, "??", right);
        }

        // C# ternary `cond ? a : b` lowers to the G# value-position `if` expression.
        // Issue #1232: gsc now matches C#'s numeric ergonomics for conditional arms
        // — it adapts an in-range constant integer literal arm and implicitly widens
        // a narrower typed arm to the other arm's type. So a coercion is only needed
        // for the residual case G# still cannot unify on its own: when C#'s common
        // result type is STRICTLY WIDER than BOTH arm types (e.g. `cond ? u16 : i16`
        // whose C# common type is `int`, which equals neither arm). There we coerce
        // both diverging arms to the result type via the conversion-call form. The
        // idiomatic `cond ? 1u : 0` now translates to `if cond { 1u } else { 0 }`
        // (no cast on the `0`), letting gsc adapt the literal.
        private GExpression TranslateConditionalExpression(
            ConditionalExpressionSyntax conditional)
        {
            GExpression condition = this.TranslateExpression(conditional.Condition);
            GExpression whenTrue = this.TranslateValueWithNullForgiveness(conditional.WhenTrue);
            GExpression whenFalse = this.TranslateValueWithNullForgiveness(conditional.WhenFalse);

            ITypeSymbol resultType = this.context.GetTypeInfo(conditional).Type;
            ITypeSymbol trueType = this.context.GetTypeInfo(conditional.WhenTrue).Type;
            ITypeSymbol falseType = this.context.GetTypeInfo(conditional.WhenFalse).Type;

            // When C# computed a single numeric conditional type but an arm has a
            // different numeric type (e.g. `cond ? 1u : 0`, whose `0` is `int32`
            // while the result is `uint32`), coerce each mismatched arm to the
            // result type: G# requires both arms to share a type (GS0263) and does
            // no implicit promotion. Each arm is coerced independently so a ternary
            // with only one mismatched arm is still aligned.
            if (resultType != null &&
                IsNonNullableValueType(resultType) &&
                TryGetNumericKind(resultType, out SpecialType resultUnderlying))
            {
                if (TryGetNumericKind(trueType, out SpecialType trueUnderlying) &&
                    trueUnderlying != resultUnderlying)
                {
                    whenTrue = this.CoerceOperandTo(whenTrue, resultType);
                }

                if (TryGetNumericKind(falseType, out SpecialType falseUnderlying) &&
                    falseUnderlying != resultUnderlying)
                {
                    whenFalse = this.CoerceOperandTo(whenFalse, resultType);
                }
            }

            // A `null` arm (`cond ? value : null`) carries no type of its own, so
            // G# infers the conditional's type purely from the non-null arm — the
            // bare `nil` then fails to unify (GS0155 "cannot convert nil to T", and
            // the surrounding call cascades GS0159). C#'s common type already
            // records the nullable union (e.g. `IEnumerator<T>?`); re-emit the null
            // arm as `default(T?)` carrying that mapped nullable type so gsc unifies
            // the branches into the nullable type instead of guessing the non-null
            // one. Restricted to reference-type results (a `Nullable<V>` value
            // result is handled by C#'s own lifting / numeric paths above).
            if (resultType is { IsReferenceType: true })
            {
                GTypeReference nullableResult = MakeNullable(
                    this.typeMapper.Map(resultType, this.context, conditional.GetLocation()));

                if (IsNullLiteral(conditional.WhenTrue))
                {
                    whenTrue = new DefaultValueExpression(nullableResult);
                }

                if (IsNullLiteral(conditional.WhenFalse))
                {
                    whenFalse = new DefaultValueExpression(nullableResult);
                }
            }

            return new IfExpression(condition, whenTrue, whenFalse);
        }

        // Unwraps `System.Nullable<T>` to its underlying `T`; other types pass
        // through unchanged.
        private static ITypeSymbol UnwrapNullable(ITypeSymbol type)
        {
            if (type is INamedTypeSymbol named &&
                named.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T &&
                named.TypeArguments.Length == 1)
            {
                return named.TypeArguments[0];
            }

            return type;
        }

        // non-nullable value type target (e.g. `uint8`, `int32`) G# rejects
        // `(expr as T)` with GS0270 ("the 'as' operator requires the target type to
        // be a reference type or a nullable value type"); the canonical G# form is
        // the width-bearing conversion-call `T(expr)`. Only a reference type or a
        // nullable value type target (where `as` is valid) keeps the `as` form.
        private GExpression CoerceOperandTo(GExpression expression, ITypeSymbol targetType)
        {
            if (IsNonNullableValueType(targetType))
            {
                GTypeReference conversionTarget = this.typeMapper.Map(
                    targetType, this.context, Location.None);
                return new ConversionExpression(conversionTarget, expression);
            }

            GTypeReference target = this.typeMapper.Map(targetType, this.context, Location.None);
            return new ParenthesizedExpression(
                new BinaryExpression(expression, "as", new TypeExpression(target)));
        }

        // Wraps a translated expression in an explicit G# pointer conversion-call
        // (`*void(expr)`, `*uint8(expr)`, ...) when C# performed an IMPLICIT
        // pointer→pointer conversion at this position. In C# a pointer→pointer
        // conversion between DIFFERENT pointee types (`byte* → void*`,
        // `void* → byte*`, `int* → void*`, ...) is implicit, but per ADR-0122 §6
        // G# requires it to be spelled explicitly as the conversion-call
        // `*<TargetPointee>(expr)`; the bare operand is rejected with GS0156
        // ("An explicit conversion exists"). Applied at argument, assignment,
        // return, and local-initializer positions (issue #914).
        //
        // No wrap is emitted when the pointee types are identical (no conversion
        // is needed) — this also naturally covers an already-explicit C# cast
        // `(void*)x` bound to a `void*` target (source == converted == `void*`),
        // which cs2gs already renders as `*void(x)`, avoiding a double wrap. The
        // full target pointer type is mapped through the standard type mapper so
        // the pointee (`void`, `uint8`, `int32`, ...) is spelled with G# names.
        private GExpression CoercePointerConversion(ExpressionSyntax expression, GExpression translated)
        {
            if (expression == null)
            {
                return translated;
            }

            TypeInfo info = this.context.GetTypeInfo(expression);
            if (info.Type is IPointerTypeSymbol source &&
                info.ConvertedType is IPointerTypeSymbol target &&
                !SymbolEqualityComparer.Default.Equals(source.PointedAtType, target.PointedAtType))
            {
                GTypeReference targetRef = this.typeMapper.Map(target, this.context, expression.GetLocation());
                return new ConversionExpression(targetRef, translated);
            }

            return translated;
        }

        // Reports whether `type` is a value type that is not `System.Nullable<T>`,
        // i.e. a target for which G#'s `as` operator is invalid (GS0270) and the
        // conversion-call form must be used instead.
        private static bool IsNonNullableValueType(ITypeSymbol type)
        {
            if (type == null || !type.IsValueType)
            {
                return false;
            }

            if (type is INamedTypeSymbol named &&
                named.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T)
            {
                return false;
            }

            return true;
        }

        private static bool IsNumericPromotionOperator(string op)
        {
            switch (op)
            {
                case "==":
                case "!=":
                case "<":
                case "<=":
                case ">":
                case ">=":
                case "+":
                case "-":
                case "*":
                case "/":
                case "%":
                case "&":
                case "|":
                case "^":
                    return true;
                default:
                    return false;
            }
        }

        // Reports whether `type` is a numeric primitive (unwrapping Nullable<T>) and
        // yields its underlying special type. `char` is included because C# promotes
        // it to `int` in arithmetic/comparison/bitwise contexts, so a mismatched
        // `uint8 == 'A'` needs a G# conversion here. `bool`/`string` are excluded.
        private static bool TryGetNumericKind(ITypeSymbol type, out SpecialType underlying)
        {
            underlying = SpecialType.None;
            if (type == null)
            {
                return false;
            }

            if (type is INamedTypeSymbol named &&
                named.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T &&
                named.TypeArguments.Length == 1)
            {
                type = named.TypeArguments[0];
            }

            switch (type.SpecialType)
            {
                case SpecialType.System_Char:
                case SpecialType.System_SByte:
                case SpecialType.System_Byte:
                case SpecialType.System_Int16:
                case SpecialType.System_UInt16:
                case SpecialType.System_Int32:
                case SpecialType.System_UInt32:
                case SpecialType.System_Int64:
                case SpecialType.System_UInt64:
                case SpecialType.System_Single:
                case SpecialType.System_Double:
                case SpecialType.System_Decimal:
                    underlying = type.SpecialType;
                    return true;
                default:
                    return false;
            }
        }

        // Reports whether a numeric underlying kind (as classified by
        // <see cref="TryGetNumericKind"/>) is an INTEGRAL type — i.e. every numeric
        // primitive except the three floating-point/decimal kinds (`float`,
        // `double`, `decimal`). Issue #2352: C#'s constant-expression narrowing
        // conversions (C# §10.2.11) — the rule that lets cs2gs retype a constant
        // operand to the OTHER operand's (narrower or differently-signed) numeric
        // type instead of widening the non-constant operand — are defined only
        // between integral types. This gate keeps that retyping confined to
        // integral↔integral combinations so a `float`/`double`/`decimal` constant
        // (or non-constant) operand always instead follows the converted-type-driven
        // widening below, matching C#'s actual binary numeric promotion.
        private static bool IsIntegralNumericKind(SpecialType underlying)
        {
            switch (underlying)
            {
                case SpecialType.System_Single:
                case SpecialType.System_Double:
                case SpecialType.System_Decimal:
                    return false;
                default:
                    return true;
            }
        }

        private IEnumerable<GStatement> TranslateLabeledStatement(LabeledStatementSyntax labeledStatement)
        {
            // C# `label: statement;` is a single statement wrapper; G# has the
            // identical `label: statement` form (ADR-0070, generalized by
            // ADR-0139 / issue #1884). The inner statement can expand into more
            // than one G# statement (e.g. a declaration that needs a spill
            // prologue); the label is attached to the FIRST emitted statement
            // only — C# source has no way to target a position mid-expansion,
            // so this is a faithful mapping.
            string label = SanitizeIdentifier(labeledStatement.Identifier.Text);
            List<GStatement> inner = this.TranslateStatement(labeledStatement.Statement).ToList();
            if (inner.Count == 0)
            {
                return new[] { (GStatement)new LabeledStatement(label, new BlockStatement(new List<GStatement>())) };
            }

            var result = new List<GStatement> { new LabeledStatement(label, inner[0]) };
            result.AddRange(inner.Skip(1));
            return result;
        }

        private IEnumerable<GStatement> TranslateGotoStatement(GotoStatementSyntax gotoStatement)
        {
            switch (gotoStatement.Kind())
            {
                case SyntaxKind.GotoCaseStatement:
                case SyntaxKind.GotoDefaultStatement:
                    // ADR-0139 / issue #1884: `goto case K;` jumps to the
                    // statement list of the case labeled with the constant K
                    // WITHOUT re-evaluating the switch subject; `goto default;`
                    // jumps to the default section. Neither re-enters the
                    // switch, so both lower to a plain `goto` targeting a
                    // synthesized label placed at the top of the target arm's
                    // body (see TranslateSwitchStatement).
                    SwitchLabelSyntax target = this.ResolveGotoCaseOrDefaultTarget(gotoStatement);
                    if (target == null)
                    {
                        this.context.ReportUnsupported(gotoStatement, "goto target case/default label could not be resolved.");
                        return new[] { (GStatement)new RawStatement($"// unsupported: {gotoStatement.Kind()}") };
                    }

                    return new[] { (GStatement)new GotoStatement(GotoCaseOrDefaultLabelName(target)) };

                default:
                    // Plain `goto label;` — Expression is the label name as an
                    // IdentifierNameSyntax (verified against Roslyn 4.14).
                    string label = SanitizeIdentifier(((IdentifierNameSyntax)gotoStatement.Expression).Identifier.Text);
                    return new[] { (GStatement)new GotoStatement(label) };
            }
        }

        /// <summary>
        /// Resolves the <see cref="SwitchLabelSyntax"/> that a <c>goto case
        /// K;</c> / <c>goto default;</c> statement targets, by walking up to
        /// the nearest enclosing <c>switch</c> and matching on compile-time
        /// constant value (issue #1884). Returns <c>null</c> if the enclosing
        /// switch or matching label cannot be found (malformed input; the
        /// caller reports a translation gap).
        /// </summary>
        private SwitchLabelSyntax ResolveGotoCaseOrDefaultTarget(GotoStatementSyntax gotoStatement)
        {
            SwitchStatementSyntax enclosingSwitch = gotoStatement.Ancestors().OfType<SwitchStatementSyntax>().FirstOrDefault();
            if (enclosingSwitch == null)
            {
                return null;
            }

            if (gotoStatement.Kind() == SyntaxKind.GotoDefaultStatement)
            {
                return enclosingSwitch.Sections
                    .SelectMany(section => section.Labels)
                    .OfType<DefaultSwitchLabelSyntax>()
                    .FirstOrDefault();
            }

            Optional<object> targetValue = this.context.SemanticModel.GetConstantValue(gotoStatement.Expression);
            if (!targetValue.HasValue)
            {
                return null;
            }

            foreach (SwitchSectionSyntax section in enclosingSwitch.Sections)
            {
                foreach (SwitchLabelSyntax label in section.Labels)
                {
                    if (label is CaseSwitchLabelSyntax caseLabel)
                    {
                        Optional<object> caseValue = this.context.SemanticModel.GetConstantValue(caseLabel.Value);
                        if (caseValue.HasValue && Equals(targetValue.Value, caseValue.Value))
                        {
                            return caseLabel;
                        }
                    }
                }
            }

            return null;
        }

        /// <summary>
        /// The synthesized G# label name for a <c>goto case</c>/<c>goto
        /// default</c> target (issue #1884). Keyed by the target label's own
        /// source position (<see cref="SyntaxNode.SpanStart"/>), which is
        /// unique within the file and stable across the two independent call
        /// sites that must agree on the name: the arm that defines the label
        /// (<see cref="TranslateSwitchStatement"/>) and the <c>goto</c> that
        /// targets it (<see cref="ResolveGotoCaseOrDefaultTarget"/> callers).
        /// </summary>
        private static string GotoCaseOrDefaultLabelName(SwitchLabelSyntax label)
            => label is DefaultSwitchLabelSyntax
                ? $"__gotoDefault{label.SpanStart}"
                : $"__gotoCase{label.SpanStart}";

        private GStatement TranslateThrow(ThrowStatementSyntax throwStatement)
        {
            // C# `throw;` (re-throw) has no bare G# form (`throw` alone is GS0005);
            // re-emit the innermost caught exception variable, which reproduces the
            // exception type and message (ADR-0115 §B).
            if (throwStatement.Expression == null)
            {
                if (this.state.CurrentCatchVariable != null)
                {
                    return new ThrowStatement(new IdentifierExpression(this.state.CurrentCatchVariable));
                }

                this.context.ReportUnsupported(
                    throwStatement,
                    "a bare re-throw outside a named catch has no canonical G# form (G# has no bare 'throw'; ADR-0115 §B).");
                return new ThrowStatement(new IdentifierExpression("nil"));
            }

            return new ThrowStatement(this.TranslateExpression(throwStatement.Expression));
        }

        private GStatement TranslateTry(TryStatementSyntax node)
        {
            BlockStatement tryBlock = this.TranslateBlock(node.Block);

            // Per-clause exception type symbols, gathered up front so the
            // rethrow-lowering below (for `when` filters) can look ahead at
            // *sibling* catch types (issue #1724 follow-up / PR #1821 review).
            // Rationale: in C#, catch clauses are matched top-to-bottom by type;
            // when a clause's type matches but its `when` filter is false,
            // matching CONTINUES to the next sibling clause instead of leaving
            // the try. The per-catch `if !(filter) { throw ex }` lowering makes a
            // false filter escape the *whole* try, so a later sibling that would
            // have caught it in C# never runs. That is only faithful when no
            // later sibling could plausibly receive the same exception, so we
            // detect the unsafe shape below and diagnose it instead of silently
            // emitting wrong control flow.
            var catchTypeSymbols = new ITypeSymbol[node.Catches.Count];
            for (int i = 0; i < node.Catches.Count; i++)
            {
                CatchClauseSyntax c = node.Catches[i];
                catchTypeSymbols[i] = c.Declaration != null
                    ? this.context.GetTypeInfo(c.Declaration.Type).Type
                    : this.context.Compilation.GetTypeByMetadataName("System.Exception");
            }

            // Issue #2235 (follow-up to #1724): the first filtered clause whose
            // later sibling could overlap is where top-to-bottom fall-through
            // becomes unrepresentable as a per-clause rethrow. Instead of
            // reporting it as unsupported, merge that clause and every clause
            // after it (lazy but always-correct boundary — a tighter boundary
            // would need the same disjointness proof again) into ONE catch that
            // manually replays C#'s type-then-filter matching in its body.
            int mergeStartIndex = -1;
            for (int i = 0; i < node.Catches.Count; i++)
            {
                if (node.Catches[i].Filter != null && this.HasOverlappingLaterSibling(catchTypeSymbols, i))
                {
                    mergeStartIndex = i;
                    break;
                }
            }

            int loopEnd = mergeStartIndex == -1 ? node.Catches.Count : mergeStartIndex;
            var catches = new List<CatchClause>();
            for (int catchIndex = 0; catchIndex < loopEnd; catchIndex++)
            {
                CatchClauseSyntax catchClause = node.Catches[catchIndex];
                string variableName = null;
                GTypeReference exceptionType = null;
                if (catchClause.Declaration != null)
                {
                    ITypeSymbol typeSymbol = catchTypeSymbols[catchIndex];
                    exceptionType = typeSymbol != null
                        ? this.typeMapper.Map(typeSymbol, this.context, catchClause.Declaration.Type.GetLocation())
                        : new NamedTypeReference(catchClause.Declaration.Type.ToString());
                    variableName = SanitizeIdentifier(catchClause.Declaration.Identifier.Text);
                    if (string.IsNullOrEmpty(variableName))
                    {
                        // `catch (Exception)` with no binding: synthesize one so the
                        // G# typed-catch form (which requires a binder) is well-formed.
                        variableName = "ex";
                    }
                }
                else
                {
                    // A bare C# `catch { }` (catch-all, no declaration) has no G#
                    // equivalent: the parser requires the parenthesized typed-binder
                    // form `catch (e Exception) { }`. Synthesize a binder over the
                    // root `System.Exception` so the catch-all round-trips (ADR-0115).
                    variableName = "ex";
                    exceptionType = new NamedTypeReference("Exception");
                }

                string previousCatch = this.state.CurrentCatchVariable;
                this.state.CurrentCatchVariable = variableName;
                try
                {
                    BlockStatement body = this.TranslateBlock(catchClause.Block);
                    if (catchClause.Filter != null)
                    {
                        // No overlapping later sibling here by construction
                        // (loopEnd stops before mergeStartIndex, the first index
                        // for which HasOverlappingLaterSibling is true), so
                        // rethrow-lowering is safe: G# has no native `catch ...
                        // when (filter)` (no Filter on CatchClauseSyntax/
                        // TryStatementSyntax; grammar has no `when` on catch).
                        // Evaluate the filter first and rethrow the caught
                        // exception when it is false, so the exception
                        // propagates exactly as it would in C# instead of being
                        // silently swallowed (issue #1724). Note: unlike a real
                        // CLR exception filter, this runs after the stack has
                        // already unwound into the handler.
                        GExpression filter = this.TranslateExpression(catchClause.Filter.FilterExpression);
                        var rethrowIfFalse = new IfStatement(
                            new UnaryExpression("!", filter),
                            new BlockStatement(new List<GStatement> { new ThrowStatement(new IdentifierExpression(variableName)) }));
                        var statements = new List<GStatement> { rethrowIfFalse };
                        statements.AddRange(body.Statements);
                        body = new BlockStatement(statements, body.IsUnsafe);
                    }

                    catches.Add(new CatchClause(variableName, exceptionType, body));
                }
                finally
                {
                    this.state.CurrentCatchVariable = previousCatch;
                }
            }

            if (mergeStartIndex != -1)
            {
                // Issue #2235: `mergeStartIndex..end` all get merged into one
                // catch that manually replays C#'s top-to-bottom type-then-
                // filter matching, since no per-clause rethrow lowering can be
                // faithful once a later sibling could overlap.
                catches.Add(this.BuildMergedFilteredCatch(node, catchTypeSymbols, mergeStartIndex));
            }

            BlockStatement finallyBlock = node.Finally != null
                ? this.TranslateBlock(node.Finally.Block)
                : null;

            return new TryStatement(tryBlock, catches, finallyBlock);
        }

        /// <summary>
        /// Merges catch clauses <c>[mergeStartIndex, node.Catches.Count)</c> into
        /// a single G# catch clause that reproduces C#'s top-to-bottom, type-
        /// then-filter catch matching in its body (issue #2235, follow-up to
        /// #1724). Needed because a filtered clause with an overlapping later
        /// sibling has no faithful per-clause rethrow lowering: a false filter
        /// must fall through to that sibling in C#, not escape the whole
        /// <c>try</c>. The merged catch is typed at the narrowest type provably
        /// safe for every merged clause (the last clause's type, when it is a
        /// supertype of all the others; <c>System.Exception</c> otherwise), and
        /// its body dispatches on <c>ex is OriginalType</c> (G#'s Kotlin-style
        /// smart cast narrows <c>ex</c> inside each branch, ADR-0069) plus each
        /// clause's own filter, in source order, falling through to the next
        /// clause when a type test or filter fails and rethrowing if none of
        /// the merged clauses match (should not happen if the merge boundary is
        /// correct, but is a safe fallback).
        /// </summary>
        private CatchClause BuildMergedFilteredCatch(TryStatementSyntax node, ITypeSymbol[] catchTypeSymbols, int mergeStartIndex)
        {
            // Compiler-generated name (never a valid C# identifier a source
            // catch variable could use) so the per-clause rebind below always
            // fires, even when the original catch variable is itself named
            // "ex" — otherwise that clause's body would see the merged
            // binder's declared (unnarrowed) type instead of the smart-cast
            // narrowed subtype.
            const string sharedBinder = "__caught";
            var sharedBinderExpr = new IdentifierExpression(sharedBinder);

            // Safety-net fallback: unreachable if the merged catch's declared
            // type is a supertype of every merged clause's type, since then the
            // last clause's `is` test always succeeds.
            GStatement dispatch = new ThrowStatement(sharedBinderExpr);

            for (int i = node.Catches.Count - 1; i >= mergeStartIndex; i--)
            {
                CatchClauseSyntax clause = node.Catches[i];
                ITypeSymbol typeSymbol = catchTypeSymbols[i];
                GTypeReference clauseType = typeSymbol != null
                    ? this.typeMapper.Map(typeSymbol, this.context, clause.GetLocation())
                    : new NamedTypeReference("Exception");
                string originalName = clause.Declaration != null && !string.IsNullOrEmpty(clause.Declaration.Identifier.Text)
                    ? SanitizeIdentifier(clause.Declaration.Identifier.Text)
                    : sharedBinder;

                string previousCatch = this.state.CurrentCatchVariable;
                this.state.CurrentCatchVariable = originalName;
                BlockStatement body;
                GExpression filter = null;
                try
                {
                    body = this.TranslateBlock(clause.Block);
                    if (clause.Filter != null)
                    {
                        filter = this.TranslateExpression(clause.Filter.FilterExpression);
                    }
                }
                finally
                {
                    this.state.CurrentCatchVariable = previousCatch;
                }

                // Re-bind this clause's own catch-variable name to the shared
                // binder (narrowed to this clause's type by the `is` test below)
                // so the body's references to its original name still resolve.
                // Always emitted (sharedBinder can never collide with a
                // source name), so this also carries the narrowed type into
                // closures capturing the rebind, unlike the shared binder.
                var branchStatements = new List<GStatement>
                {
                    new LocalDeclarationStatement(BindingKind.Let, originalName, initializer: sharedBinderExpr),
                };

                GStatement matched = filter != null
                    ? new IfStatement(filter, body, new BlockStatement(new List<GStatement> { dispatch }))
                    : (GStatement)body;
                branchStatements.Add(matched);

                GExpression typeTest = new BinaryExpression(sharedBinderExpr, "is", new TypeExpression(clauseType));
                dispatch = new IfStatement(typeTest, new BlockStatement(branchStatements), new BlockStatement(new List<GStatement> { dispatch }));
            }

            GTypeReference mergedType = this.ComputeMergedCatchType(catchTypeSymbols, mergeStartIndex);
            return new CatchClause(sharedBinder, mergedType, new BlockStatement(new List<GStatement> { dispatch }));
        }

        /// <summary>
        /// Picks the merged catch's declared type (issue #2235): the last
        /// merged clause's type when it is a supertype-or-equal of every
        /// earlier merged clause's type (so it can safely catch all of them
        /// without the outer G# catch itself narrowing anything away);
        /// <c>System.Exception</c> otherwise (always safe, if less precise).
        /// </summary>
        private GTypeReference ComputeMergedCatchType(ITypeSymbol[] catchTypeSymbols, int mergeStartIndex)
        {
            int lastIndex = catchTypeSymbols.Length - 1;
            ITypeSymbol lastType = catchTypeSymbols[lastIndex];
            bool lastIsCommonSupertype = lastType != null;
            for (int i = mergeStartIndex; lastIsCommonSupertype && i < lastIndex; i++)
            {
                if (!DerivesFromOrEquals(catchTypeSymbols[i], lastType))
                {
                    lastIsCommonSupertype = false;
                }
            }

            if (lastIsCommonSupertype)
            {
                return this.typeMapper.Map(lastType, this.context, Location.None);
            }

            return new NamedTypeReference("Exception");
        }

        /// <summary>
        /// Whether any catch clause after <paramref name="filteredIndex"/> could
        /// still receive the same exception once the filtered clause's `when`
        /// is false — i.e. whether rethrow-lowering the filter at
        /// <paramref name="filteredIndex"/> would diverge from C#'s top-to-bottom,
        /// fall-through-on-false-filter matching (issue #1724 follow-up).
        /// </summary>
        /// <param name="catchTypeSymbols">The resolved exception type per catch clause, in source order.</param>
        /// <param name="filteredIndex">The index of the `when`-filtered clause being lowered.</param>
        /// <returns><see langword="true"/> when a later sibling could plausibly match.</returns>
        private bool HasOverlappingLaterSibling(ITypeSymbol[] catchTypeSymbols, int filteredIndex)
        {
            ITypeSymbol filteredType = catchTypeSymbols[filteredIndex];
            for (int i = filteredIndex + 1; i < catchTypeSymbols.Length; i++)
            {
                if (!AreDisjointExceptionTypes(filteredType, catchTypeSymbols[i]))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Whether two exception types can be <em>proven</em> disjoint — no
        /// runtime exception object can be an instance of both. Only single-
        /// inheritance class types can be proven disjoint this way (neither
        /// derives from the other); anything else (unresolved types, interfaces,
        /// or an equal/derived relationship) is treated conservatively as
        /// possibly-overlapping, per the "when in doubt, don't silently diverge"
        /// rule this method exists to serve.
        /// </summary>
        /// <param name="left">The first exception type, or <see langword="null"/> if unresolved.</param>
        /// <param name="right">The second exception type, or <see langword="null"/> if unresolved.</param>
        /// <returns><see langword="true"/> only when the types are provably disjoint.</returns>
        private static bool AreDisjointExceptionTypes(ITypeSymbol left, ITypeSymbol right)
        {
            if (left == null || right == null)
            {
                return false;
            }

            if (left.TypeKind != TypeKind.Class || right.TypeKind != TypeKind.Class)
            {
                return false;
            }

            if (SymbolEqualityComparer.Default.Equals(left, right))
            {
                return false;
            }

            return !DerivesFromOrEquals(left, right) && !DerivesFromOrEquals(right, left);
        }

        private static bool DerivesFromOrEquals(ITypeSymbol type, ITypeSymbol potentialBaseOrSelf)
        {
            for (ITypeSymbol t = type; t != null; t = t.BaseType)
            {
                if (SymbolEqualityComparer.Default.Equals(t, potentialBaseOrSelf))
                {
                    return true;
                }
            }

            return false;
        }

        private GStatement TranslateUsingStatement(UsingStatementSyntax node)
        {
            // C# `using (var r = e) body` / `await using (var r = e) body` has
            // no `using (...)` block form in G# (it is GS0005); it maps to a
            // scoped block holding a `using let` / `await using let` resource
            // declaration followed by the body, so the resource is disposed at
            // the end of that block (sample Defer.gs; ADR-0115 §B; ADR-0030).
            // The C# `await` keyword (issue #1903) selects `DisposeAsync` over
            // `Dispose` — dropping it silently would compile a sync `using`
            // against an `IAsyncDisposable`-only type and gsc would reject it
            // (GS0119), so it must be threaded through, never elided.
            bool isAwait = !node.AwaitKeyword.IsKind(SyntaxKind.None);
            var statements = new List<GStatement>();
            if (node.Declaration != null)
            {
                statements.AddRange(this.TranslateLocalDeclaration(node.Declaration, isConst: false, isUsing: true, isAwait: isAwait));
            }
            else if (node.Expression != null)
            {
                // `using (expr) body` (no declaration): the resource is the
                // expression value; bind it to a fresh `using let` so disposal
                // is scoped to the block.
                statements.Add(new LocalDeclarationStatement(
                    BindingKind.Let,
                    "__using",
                    type: null,
                    initializer: this.TranslateExpression(node.Expression),
                    isUsing: true,
                    isAwait: isAwait));
            }

            BlockStatement bodyBlock = this.TranslateStatementAsBlock(node.Statement);
            statements.AddRange(bodyBlock.Statements);
            return new BlockStatement(statements);
        }

        /// <summary>
        /// ADR-0143 §D: whether <paramref name="expression"/> is an invocation
        /// that binds to an ELIDED unimplemented C# partial method — a partial
        /// method DEFINITION with no implementation part. Such a call produces no
        /// runtime effect in C# and has no G# member to target (the declaration
        /// was elided in <see cref="TranslateMethod"/>), so the enclosing
        /// expression statement is dropped.
        /// </summary>
        private bool IsElidedPartialMethodInvocation(ExpressionSyntax expression)
        {
            if (expression is not InvocationExpressionSyntax invocation)
            {
                return false;
            }

            // The bound target may resolve to either the defining or the
            // implementing part; normalize to the definition and check whether it
            // is an unimplemented partial definition.
            if (this.context.GetSymbolInfo(invocation).Symbol is not IMethodSymbol method)
            {
                return false;
            }

            IMethodSymbol definition = method.PartialDefinitionPart ?? method;
            return definition.IsPartialDefinition && definition.PartialImplementationPart == null;
        }

        private GStatement TranslateExpressionStatement(ExpressionSyntax expression)
        {
            switch (expression)
            {
                case AssignmentExpressionSyntax assignment when this.IsDelegateMulticastCombine(assignment, out string combineOp):
                    // Issue #1960 item 2: `handler += Second;` / `handler -= Second;`
                    // on a plain delegate-typed target (NOT a declared `event` —
                    // those already lower to G#'s dedicated event-subscription
                    // `+=`/`-=` form, ADR-0052/ADR-0036) has no G# equivalent.
                    // G#'s `+=`/`-=` syntax binds ONLY to an actual CLR event
                    // (Parser.cs's `EventSubscriptionExpressionSyntax`; the binder's
                    // general compound-assignment fallback has no `+`/`-` operator
                    // for delegate/function types, and `Delegate.Combine`/`Remove`
                    // are reachable only from the compiler's own synthesized event
                    // accessors, not from ordinary call-expression binding). Rather
                    // than emit `+=`/`-=` that fails to bind in gsc, gap loudly.
                    string combineMessage =
                        $"delegate multicast '{combineOp}' on a non-event delegate-typed target has no G# equivalent: " +
                        "G#'s '+='/'-=' syntax binds only to a declared CLR event, and 'Delegate.Combine'/'Delegate.Remove' " +
                        "are reachable only from the compiler's own synthesized event accessors, not from ordinary call " +
                        "binding (issue #1960).";
                    this.context.ReportUnsupported(assignment, combineMessage);
                    return new RawStatement($"// unsupported: delegate multicast '{combineOp}'");

                case AssignmentExpressionSyntax assignment:
                    string op = assignment.OperatorToken.Text;
                    GExpression assignRhs = this.CoerceConstantToUnsigned(
                        assignment.Right,
                        this.TranslateExpression(assignment.Right));
                    assignRhs = this.CoerceCompoundAssignmentRhs(assignment, assignRhs);
                    assignRhs = this.CoercePointerConversion(assignment.Right, assignRhs);
                    assignRhs = this.ForgiveEventSubscriptionRhs(assignment, assignRhs);
                    assignRhs = this.ForgiveElementAccessAssignmentRhs(assignment, assignRhs);
                    return new AssignmentStatement(
                        this.TranslateAssignmentTarget(assignment.Left),
                        assignRhs,
                        op);

                case PostfixUnaryExpressionSyntax postfix
                    when postfix.IsKind(SyntaxKind.PostIncrementExpression)
                        || postfix.IsKind(SyntaxKind.PostDecrementExpression):
                    return new IncrementDecrementStatement(
                        this.TranslateExpression(postfix.Operand),
                        postfix.OperatorToken.Text);

                case PrefixUnaryExpressionSyntax prefix
                    when prefix.IsKind(SyntaxKind.PreIncrementExpression)
                        || prefix.IsKind(SyntaxKind.PreDecrementExpression):
                    // G# has no prefix ++/--; both forms are statements with the
                    // same effect, so emit the canonical postfix increment.
                    return new IncrementDecrementStatement(
                        this.TranslateExpression(prefix.Operand),
                        prefix.OperatorToken.Text);

                case SwitchExpressionSyntax switchExpression:
                    // A C# switch EXPRESSION used in statement position — reached
                    // via a discard (`_ = x switch { ... };`, lowered by
                    // TranslateExpressionStatements) or any other expression-
                    // statement context. G#'s switch-EXPRESSION arm form uses
                    // `case P: expr` (an expression per arm) and is only valid in
                    // value position; a bare switch expression at statement
                    // position is parsed as a switch STATEMENT, whose arms require
                    // a `case P { block }` body — so emitting the expression form
                    // here produces invalid G# (GS0005 "expected OpenBraceToken").
                    // Lower to a genuine switch STATEMENT instead, running each
                    // arm's expression for its side effect (the value is discarded,
                    // exactly as in C#'s `_ = <switch expr>`); issue #914.
                    return this.TranslateSwitchExpressionAsStatement(switchExpression);

                default:
                    return new ExpressionStatement(this.TranslateExpression(expression));
            }
        }

        // Translates the target (left-hand side) of an assignment. Two member-access
        // LHS shapes that gsc cannot bind through the usual receiver path are fixed
        // up here:
        //
        //   • `Prop.Member = v` where `Prop` is an *implicit-this* instance
        //     property/field of the enclosing type. gsc resolves a bare-identifier
        //     assignment receiver as a variable/parameter; an implicit-this property
        //     receiver has no local slot, so the member write fails (GS0158 /
        //     GS9998). Qualifying it as `this.Prop.Member = v` (or `self.Prop.Member
        //     = v` inside a lifted receiver-clause func, issue #938 — see
        //     <paramref name="left"/>'s <see cref="currentReceiverName"/>) routes the
        //     write through the expression-receiver path, which binds correctly.
        //     When `Prop` is itself declared-nullable (or promoted, issue #1072),
        //     the same `!!` the read path applies is inserted on the qualified
        //     receiver (`this.Prop!!.Member = v`) — the qualification and the
        //     null-forgiveness are independent fixes and compose.
        //
        //   • `recv.Member = v` where `recv` is a declared-nullable receiver that
        //     Roslyn flow-proved non-null (or was promoted to nullable, #1072).
        //     gsc does not flow-narrow an *assignment* receiver (only reads), so the
        //     bare nullable receiver fails to bind the setter (GS0158). A
        //     `recv!!.Member = v` re-establishes the non-null fact (mirrors the
        //     read-side <see cref="TranslateReceiverWithNullForgiveness"/> and its
        //     flow-independent <see cref="ReceiverIsNullableReferenceFieldOrProperty"/>
        //     companion, so nullable-oblivious corpora get the same assertion the
        //     read path does).
        private GExpression TranslateAssignmentTarget(ExpressionSyntax left)
        {
            if (left is MemberAccessExpressionSyntax member)
            {
                if (member.Expression is IdentifierNameSyntax receiverId &&
                    this.context.GetSymbolInfo(receiverId).Symbol is { IsStatic: false } receiverSymbol &&
                    receiverSymbol.Kind is SymbolKind.Property or SymbolKind.Field)
                {
                    GExpression qualifier = this.state.CurrentReceiverName != null
                        ? new IdentifierExpression(this.state.CurrentReceiverName)
                        : new ThisExpression();
                    GExpression qualifiedReceiver = new MemberAccessExpression(
                        qualifier, SanitizeIdentifier(receiverId.Identifier.Text));

                    if (this.ReceiverNeedsNullForgiveness(receiverId) ||
                        this.ReceiverIsNullableReferenceFieldOrProperty(receiverId))
                    {
                        qualifiedReceiver = new NonNullAssertionExpression(qualifiedReceiver);
                    }

                    return new MemberAccessExpression(
                        qualifiedReceiver, SanitizeIdentifier(member.Name.Identifier.Text));
                }

                if (this.ReceiverNeedsNullForgiveness(member.Expression) ||
                    this.ReceiverIsNullableReferenceFieldOrProperty(member.Expression) ||
                    (member.Expression is IdentifierNameSyntax hoistedId &&
                     this.context.GetSymbolInfo(hoistedId).Symbol is { } hoistedSymbol &&
                     this.state.HoistedNullableGuardLocals.Contains(hoistedSymbol)))
                {
                    return new MemberAccessExpression(
                        new NonNullAssertionExpression(this.TranslateExpression(member.Expression)),
                        SanitizeIdentifier(member.Name.Identifier.Text));
                }
            }

            return this.TranslateExpression(left);
        }

        /// <summary>
        /// Issue #1741: whether an identifier named <c>_</c> is a true C# discard
        /// (<see cref="IDiscardSymbol"/>) rather than a real variable/field named
        /// <c>_</c> that happens to be in scope. A real <c>_</c> binding is a normal
        /// assignment target, not a discard, and must not be dropped.
        /// </summary>
        /// <param name="identifier">The <c>_</c> identifier on the assignment's left side.</param>
        /// <returns><c>true</c> when <paramref name="identifier"/> is a genuine discard.</returns>
        private bool IsTrueDiscard(IdentifierNameSyntax identifier)
        {
            ISymbol symbol = this.context.GetSymbolInfo(identifier).Symbol;

            // No symbol at all means there is no real `_` binding in scope, so this
            // is a genuine discard; fall back to the name-based check.
            return symbol is IDiscardSymbol or null;
        }

        /// <summary>
        /// Translates an expression-statement that may expand into several G#
        /// statements: a tuple deconstruction (<c>var (a, b) = e</c>) or a chained
        /// assignment (<c>a = b = c</c>), neither of which has a single-statement G#
        /// form. Everything else delegates to <see cref="TranslateExpressionStatement"/>.
        /// </summary>
        private IEnumerable<GStatement> TranslateExpressionStatements(ExpressionSyntax expression)
        {
            if (expression is AssignmentExpressionSyntax assignment &&
                assignment.IsKind(SyntaxKind.SimpleAssignmentExpression))
            {
                if (assignment.Left is IdentifierNameSyntax { Identifier.ValueText: "_" } discardCandidate &&
                    this.IsTrueDiscard(discardCandidate))
                {
                    // C# statement-level discard `_ = e` (Roslyn parses the `_`
                    // target as an IdentifierNameSyntax). G# has no discard target
                    // (`_ = e` → GS0125), so drop the assignment and emit just the
                    // RHS as statement(s); `_ = a = b`, `_ = x ?? throw E`, and
                    // `_ = await ...` flow through the RHS translation (issue #914).
                    return this.TranslateExpressionStatements(assignment.Right);
                }

                if (this.TryGetDeconstructionTargets(assignment.Left, out BindingKind binding, out IReadOnlyList<string> names))
                {
                    // `var (a, b) = e` → `let (a, b) = e` (spec §Tuples).
                    return new[]
                    {
                        (GStatement)new TupleDeconstructionStatement(
                            binding,
                            names,
                            this.TranslateExpression(assignment.Right)),
                    };
                }

                // `(a, b) = (x, y)` deconstruction *assignment* to existing
                // variables. G# has no tuple-assignment form, so lower to
                // element-wise assignments (or, for a MIXED target such as
                // `(x, var y) = ...`, a mix of assignments and new bindings).
                // The whole RHS is captured ONCE via G#'s native
                // `let (t0, t1, ...) = rhs` deconstruction-declaration form —
                // this already handles every RHS shape the declaration path
                // does (a tuple literal, a tuple-returning call, a
                // Deconstruct-method type) and, being a single statement,
                // preserves C#'s evaluate-then-assign-all semantics (handles
                // aliasing such as the swap `(a, b) = (b, a)`); issue #1895,
                // ADR-0115 §B. A NESTED target (`((a, b), c) = ...`) has no
                // flat `t0, t1, ...` shape at the top level, but is lowered by
                // recursing: the nested arm gets its own temp, which is then
                // deconstructed by a SECOND `let (...) = temp` statement
                // (issue #1974) — G#'s grammar only needs a flat name list per
                // statement, and nothing stops chaining several of them. A
                // non-identifier target (`arr[i]`, `obj.F`, ...) anywhere in the
                // (possibly nested) target shape is handled by
                // `LowerTupleAssignment` capturing its receiver/index FIRST
                // (via `MakeDuplicationSafeTarget`, the same machinery chained
                // assignment already uses), before the RHS is spilled —
                // preserving C#'s left-to-right, targets-then-value evaluation
                // order (issue #2234, generalizing #1895).
                if (assignment.Left is TupleExpressionSyntax leftTuple)
                {
                    return this.LowerTupleAssignment(leftTuple, assignment.Right);
                }
            }

            // `a = b = c`, `a = b += c`, `a += b = c`, … — any assignment whose
            // RHS is itself an assignment (any operator, optionally parenthesized)
            // has no single-statement G# form; flatten innermost-first so every
            // link's write is preserved (issue #1723).
            if (expression is AssignmentExpressionSyntax outerAssignment &&
                Unwrap(outerAssignment.Right) is AssignmentExpressionSyntax)
            {
                return this.FlattenChainedAssignment(outerAssignment);
            }

            return this.WithHoistedAssignments(
                expression,
                includeSelf: false,
                () => this.WithHoistedPostfix(
                    expression,
                    () => new[] { this.TranslateExpressionStatement(expression) }).ToList());
        }

        // Strips parentheses so chain/assignment detection is parenthesis-transparent.
        private static ExpressionSyntax Unwrap(ExpressionSyntax expression)
        {
            while (expression is ParenthesizedExpressionSyntax paren)
            {
                expression = paren.Expression;
            }

            return expression;
        }

        /// <summary>
        /// Translates an expression in statement position, hoisting any embedded
        /// post-increment/decrement (`a[i++] = x`, `M(i--)`, `x = y++`) into
        /// trailing `i++` / `i--` statements. G# models inc/dec as statements, so
        /// the sub-expression is suppressed (read as its pre-increment value) and
        /// the mutation is appended after the main statement (ADR-0115 §B).
        /// </summary>
        private IEnumerable<GStatement> WithHoistedPostfix(
            ExpressionSyntax expression,
            Func<IEnumerable<GStatement>> buildMain)
        {
            List<PostfixUnaryExpressionSyntax> embedded = CollectEmbeddedPostfix(expression);
            if (embedded.Count == 0)
            {
                return buildMain();
            }

            foreach (PostfixUnaryExpressionSyntax node in embedded)
            {
                this.state.SuppressedPostfix.Add(node);
            }

            List<GStatement> statements;
            try
            {
                statements = buildMain().ToList();
            }
            finally
            {
                foreach (PostfixUnaryExpressionSyntax node in embedded)
                {
                    this.state.SuppressedPostfix.Remove(node);
                }
            }

            foreach (PostfixUnaryExpressionSyntax node in embedded)
            {
                statements.Add(new IncrementDecrementStatement(
                    this.TranslateExpression(node.Operand),
                    node.OperatorToken.Text));
            }

            return statements;
        }
    }
}
