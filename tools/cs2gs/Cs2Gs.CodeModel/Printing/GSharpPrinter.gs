// <copyright file="GSharpPrinter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Printing

import Cs2Gs.CodeModel.Ast
import System
import System.Collections.Generic
import System.Globalization
import System.Linq
import System.Runtime.InteropServices
import System.Text

/// Turns a G# emit AST into canonical G# source text following ADR-0115 §B:
/// deterministic ordering, 4-space indentation, K&R braces, visibility only
/// when non-default, in-body vs receiver-clause methods, base-first `:`
/// clauses, bracket generics, arrow delegate types, `${}` interpolation,
/// and `@Attr` application. The same AST always produces byte-identical
/// text.
shared class GSharpPrinter {
    private const IndentUnit string = "    "

    // Issue #3470: column budget for statement-level wrapping (see
    // RenderWrappable).
    private const MaxLineWidth int32 = 120

    // Unary operators (`+ - ! ^ * & <-`) bind at precedence 6 in G#'s
    // grammar — higher than every binary operator — per
    // SyntaxFacts.GetUnaryOperatorPrecedence.
    private const UnaryPrecedence int32 = 6

    // ADR-0151 / ADR-0201: the minimum precedence an `if let` / `while let`
    // binding initializer (statement or expression) may sit at without
    // parentheses. gsc parses such an
    // initializer only down to the logical-and tier — the first top-level
    // `&&` (or `||`) terminates it and starts the optional guard — so an
    // initializer whose own top-level operator is `&&` (2), `||` (1), or
    // `??` (0) must be wrapped. Comparison (3) and above are unambiguous.
    private const IfLetInitializerPrecedence int32 = 3

    /// Prints a compilation unit to canonical G# source text.
    /// @param unit The compilation unit to print.
    /// @returns The canonical G# source, terminated by a single newline.
    func Print(unit CompilationUnit?) string {
        if unit == nil {
            throw ArgumentNullException("unit")
        }
        return RenderCompilationUnit(unit)
    }

    /// Issue #943: renders a (cref:GTypeReference) to its G# surface form
    /// (e.g. `IComparable[T]`). Exposed so the translator can place a
    /// constructed-generic interface constraint into a type parameter's legacy
    /// constraint slot.
    /// @param type The type reference to render.
    /// @returns The rendered G# type form.
    func RenderTypeReference(type GTypeReference) string -> RenderType(type)

    /// Renders one expression exactly as (cref:Print) would print it at
    /// statement-expression position, so callers can make decisions about the
    /// printed text (for example whether it starts with a parenthesis) instead
    /// of duplicating printer rules.
    /// @param expression The expression to render.
    /// @returns The printed G# text.
    func RenderExpressionText(expression GExpression) string -> RenderExpression(expression, 0)

    /// ADR-0192: renders a method's signature — everything but its body and
    /// its method-level attributes (which gsc unions across partial parts),
    /// keeping parameter annotations and defaults — exactly as the printer
    /// would spell it. Used to check that the two parts of a partial method
    /// pair spell the same signature.
    /// @param method The method.
    /// @returns The rendered signature.
    func RenderMethodSignature(method MethodDeclaration?) string {
        if method == nil {
            throw ArgumentNullException("method")
        }
        let signature = MethodDeclaration(
            method.Name,
            method.Parameters,
            method.ReturnType,
            body: nil,
            method.TypeParameters,
            method.Receiver,
            method.Visibility,
            method.IsOpen,
            method.IsOverride,
            method.IsAsync,
            attributes: nil,
            expressionBody: nil,
            method.IsRefReturn,
            method.ExplicitInterfaceType,
            method.IsSuspend,
            method.IsReadOnlyRefReturn,
            method.IsPartial
        )
        return RenderMethod(signature, 0)
    }

    private func Indent(level int32) string {
        // ponytail: no shared cache — Print is a public static API and xunit
        // runs test classes in parallel, so a shared List<string> grown
        // on-demand here would race. Indent strings are tiny; allocate
        // per-call instead of guarding shared state.
        return string.Concat(Enumerable.Repeat(IndentUnit, level))
    }

    private func RenderVisibility(visibility Visibility) string {
        switch visibility {
            case Visibility.Public {
                return "public "
            }
            case Visibility.Internal {
                return "internal "
            }
            case Visibility.Private {
                return "private "
            }
            case Visibility.Protected {
                return "protected "
            }
            default {
                return string.Empty
            }
        }
    }

    private func RenderBinding(binding BindingKind) string {
        switch binding {
            case BindingKind.Let {
                return "let"
            }
            case BindingKind.Const {
                return "const"
            }
            case BindingKind.FixedBuffer {
                return "fixed"
            }
            default {
                return "var"
            }
        }
    }

    private func RenderKindKeyword(kind TypeDeclarationKind) string {
        switch kind {
            case TypeDeclarationKind.Class {
                return "class"
            }
            case TypeDeclarationKind.Struct {
                return "struct"
            }
            case TypeDeclarationKind.DataClass {
                return "data class"
            }
            case TypeDeclarationKind.DataStruct {
                return "data struct"
            }
            case TypeDeclarationKind.InlineStruct {
                return "inline struct"
            }
            case TypeDeclarationKind.Interface {
                return "interface"
            }
            default {
                return "class"
            }
        }
    }

    private func RenderType(type GTypeReference?) string {
        // Issue #1212: an array's own nullability is spelled `[]?T` (the `?`
        // sits right after `]`), distinct from an array of nullable elements
        // `[]T?` (where the element rendering carries its own trailing `?`).
        if type is ArrayTypeReference array {
            let arrayMarker = if array.IsNullable {
                "?"
            } else {
                string.Empty
            }
            return "[${String(',', array.Rank - 1)}]$arrayMarker${RenderArrayElementType(array.ElementType)}"
        }
        // Issue #1745: `type` can't be null here — RenderTypeCore already
        // dereferenced it above (via the `type is ArrayTypeReference` check)
        // and, for any other unsupported/null input, throws inside its
        // switch's default case before returning. The `type == null` guard
        // that used to sit here was dead code.
        let rendered = RenderTypeCore(type)
        if !type!!.IsNullable {
            return rendered
        }
        // A nullable function type must be parenthesized: `((T) -> R)?` (ADR-0137 /
        // issue #1399). A bare `(T) -> R?` binds `?` to the return type, not the
        // function type. Every other type spells nullable with a trailing `?`.
        return if type is ArrowTypeReference {
            "($rendered)?"
        } else {
            rendered + "?"
        }
    }

    private func RenderTypeCore(type GTypeReference?) string {
        switch type {
            case slice is NativeSliceTypeReference {
                return "${(if slice.IsReadOnly { "readonly " } else { string.Empty })}slice[${RenderType(slice.ElementType)}]"
            }
            case reference is ManagedReferenceTypeReference {
                return "${(if reference.IsReadOnly { "readonly " } else { string.Empty })}managed[${RenderType(reference.ElementType)}]"
            }
            case named is NamedTypeReference {
                let name = if named.ContainingType == nil {
                    named.Name
                } else {
                    "${RenderType(named.ContainingType)}.${named.Name}"
                }
                if named.TypeArguments.Count == 0 {
                    return name
                }
                return "$name[${string.Join(", ", named.TypeArguments.Select(RenderType))}]"
            }
            case array is ArrayTypeReference {
                return "[${String(',', array.Rank - 1)}]${RenderArrayElementType(array.ElementType)}"
            }
            case pointer is PointerTypeReference {
                return "*${RenderType(pointer.ElementType)}"
            }
            case tuple is TupleTypeReference {
                // ADR-0172: element names render name-first — `(line int32, column int32)`.
                return "(" + string.Join(
                    ", ",
                    tuple.ElementTypes.Select(
                        (t GTypeReference, i int32) -> if tuple.ElementNames?[i] is {} elementName {
                            "$elementName ${RenderType(t)}"
                        } else {
                            RenderType(t)
                        }
                    )
                ) +
                    ")"
            }
            case arrow is ArrowTypeReference {
                let prefix = if arrow.IsAsync {
                    "async "
                } else {
                    string.Empty
                }
                let parameters = string.Join(", ", arrow.ParameterTypes.Select(RenderType))
                let returns = RenderArrowReturn(arrow.ReturnTypes)
                return "$prefix($parameters) -> $returns"
            }
            case functionPointer is FunctionPointerTypeReference {
                return RenderFunctionPointer(functionPointer)
            }
            default {
                throw ArgumentException("Unsupported type reference: ${type?.GetType().Name}")
            }
        }
    }

    private func RenderArrayElementType(
        elementType GTypeReference
    ) string -> if elementType is FunctionPointerTypeReference &&
        elementType.IsManaged == false {
        "(${RenderType(elementType)})"
    } else {
        RenderType(elementType)
    }

    private func RenderFunctionPointer(functionPointer FunctionPointerTypeReference) string {
        let parameters = string.Join(", ", functionPointer.ParameterTypes.Select(RenderType))
        if functionPointer.IsManaged {
            // ADR-0122 §9: the managed function pointer omits the return type
            // entirely for a void-returning pointer, e.g. `*func(int)`.
            return if functionPointer.ReturnType == nil {
                "*func($parameters)"
            } else {
                "*func($parameters) ${RenderType(functionPointer.ReturnType)}"
            }
        }
        // ADR-0095 §2: the unmanaged raw form always spells the return type
        // explicitly, using `void` for a void-returning pointer.
        let returnText = if functionPointer.ReturnType == nil {
            "void"
        } else {
            RenderType(functionPointer.ReturnType)
        }
        // ADR-0095 v2 / issue #3611: the open model renders the source
        // spelling — bare `unmanaged (…)` for the platform default,
        // `unmanaged[A, B] (…)` for a convention list.
        if functionPointer.IsUnmanagedExtended {
            let slot = if functionPointer.UnmanagedConventions.Count == 0 {
                string.Empty
            } else {
                "[${string.Join(", ", functionPointer.UnmanagedConventions)}]"
            }
            return "unmanaged$slot ($parameters) -> $returnText"
        }
        return "unmanaged[${RenderCallingConvention(functionPointer.CallingConvention)}] ($parameters) -> $returnText"
    }

    private func RenderCallingConvention(callingConvention CallingConvention) string {
        // The G# `[CC]` identifier slot (see gsc's Binder.cs) recognises
        // "Cdecl"/"Stdcall"/"Thiscall"/"Fastcall" — capitalized-first-letter
        // spellings, distinct from the .NET CallingConvention enum's own
        // "StdCall"/"ThisCall"/"FastCall" member names.
        switch callingConvention {
            case CallingConvention.Cdecl {
                return "Cdecl"
            }
            case CallingConvention.StdCall {
                return "Stdcall"
            }
            case CallingConvention.ThisCall {
                return "Thiscall"
            }
            case CallingConvention.FastCall {
                return "Fastcall"
            }
            default {
                throw ArgumentException("Unsupported calling convention: $callingConvention")
            }
        }
    }

    private func RenderArrowReturn(returnTypes IReadOnlyList[GTypeReference]) string {
        if returnTypes.Count == 0 {
            return "void"
        }
        if returnTypes.Count == 1 {
            return RenderType(returnTypes[0])
        }
        return "(${string.Join(", ", returnTypes.Select(RenderType))})"
    }

    private func RenderParameter(parameter Parameter) string {
        let sb = StringBuilder()
        for attribute in parameter.Attributes {
            sb.Append(RenderAttributeInline(attribute))
            sb.Append(' ')
        }
        // ADR-0185: a tuple-destructuring arrow-lambda parameter renders as
        // `(name1 T1, name2 T2, ...)` — no ref-kind/variadic/default-value
        // modifiers apply to this shape.
        if parameter.IsDestructured {
            sb.Append('(')
            for var i = 0; i < parameter.DestructuredElements!!.Count; i++ {
                if i > 0 {
                    sb.Append(", ")
                }
                let element = parameter.DestructuredElements!![i]
                sb.Append(element.Name)
                sb.Append(' ')
                sb.Append(RenderType(element.Type))
            }
            sb.Append(')')
            return sb.ToString()
        }
        if !string.IsNullOrEmpty(parameter.RefKind) {
            sb.Append(parameter.RefKind)
            sb.Append(' ')
        }
        sb.Append(parameter.Name)
        sb.Append(' ')
        sb.Append(
            if parameter.IsVariadic {
                "...${RenderType(parameter.Type)}"
            } else {
                RenderType(parameter.Type)
            }
        )
        if parameter.DefaultValue != nil {
            sb.Append(" = ")
            sb.Append(RenderExpression(parameter.DefaultValue, 0))
        }
        return sb.ToString()
    }

    private func RenderParameterList(parameters IReadOnlyList[Parameter]?) string {
        return string.Join(", ", parameters!!.Select(RenderParameter))
    }

    private func RenderTypeParameter(typeParameter TypeParameter) string {
        let sb = StringBuilder()
        switch typeParameter.Variance {
            case Variance.Out {
                sb.Append("out ")
            }
            case Variance.In {
                sb.Append("in ")
            }
            default {
                let _ = 0
            }
        }
        sb.Append(typeParameter.Name)
        if !string.IsNullOrEmpty(typeParameter.LegacyConstraint) {
            sb.Append(' ')
            sb.Append(typeParameter.LegacyConstraint)
        }
        for flag in typeParameter.FlagConstraints {
            sb.Append(' ')
            sb.Append(flag)
        }
        return sb.ToString()
    }

    private func RenderTypeParameterList(typeParameters IReadOnlyList[TypeParameter]) string {
        if typeParameters.Count == 0 {
            return string.Empty
        }
        return "[${string.Join(", ", typeParameters.Select(RenderTypeParameter))}]"
    }

    private func RenderAttributeInline(attribute AttributeUse) string {
        let sb = StringBuilder()
        sb.Append('@')
        if !string.IsNullOrEmpty(attribute.Target) {
            sb.Append(attribute.Target)
            sb.Append(':')
        }
        sb.Append(attribute.Name)
        if attribute.Arguments.Count > 0 {
            sb.Append('(')
            sb.Append(string.Join(", ", attribute.Arguments.Select(RenderAttributeArgument)))
            sb.Append(')')
        }
        return sb.ToString()
    }

    private func RenderAttributeArgument(argument AttributeArgument) string {
        let value = RenderExpression(argument.Value, 0)
        return if string.IsNullOrEmpty(argument.Name) {
            value
        } else {
            "${argument.Name}${(if argument.IsMemberAssignment { " =" } else { ":" })} $value"
        }
    }

    // Shared escaper for double-quoted string/interpolation bodies and
    // single-quoted char bodies. `quoteChar` is the delimiter that needs
    // backslash-escaping for the given literal kind ('"' for strings and
    // interpolations, '\'' for chars); `escapeDollar` doubles '$' so it can't
    // be mistaken for an interpolation hole (only applies to string forms —
    // char literals have no interpolation syntax). Matches exactly the
    // escapes G#'s lexer accepts (Lexer.cs ReadCharLiteral / string scanning):
    // \\, \", \', \n, \r, \t, and \uXXXX for other control/non-printable
    // chars.
    private func RenderEscapedLiteralBody(value string?, quoteChar char, escapeDollar bool) string {
        let sb = StringBuilder()
        for ch in value!! {
            if ch == '\\' {
                sb.Append("\\\\")
            } else if ch == quoteChar {
                sb.Append('\\').Append(quoteChar)
            } else if escapeDollar && ch == '$' {
                sb.Append("$$$$")
            } else {
                switch ch {
                    case '\n' {
                        sb.Append("\\n")
                    }
                    case '\r' {
                        sb.Append("\\r")
                    }
                    case '\t' {
                        sb.Append("\\t")
                    }
                    default {
                        if ch < ' ' || ch == '\u007F' {
                            sb.Append("\\u").Append((int32(ch)).ToString("X4", CultureInfo.InvariantCulture))
                        } else {
                            sb.Append(ch)
                        }
                    }
                }
            }
        }
        return sb.ToString()
    }

    private func RenderStringLiteralBody(value string) string -> RenderEscapedLiteralBody(
        value,
        '"',
        escapeDollar: true
    )

    private func RenderInterpolationText(value string?) string -> RenderEscapedLiteralBody(
        value,
        '"',
        escapeDollar: true
    )

    // Issue #1722: char literals must escape the closing quote, backslash,
    // and control chars the same way strings do, or C#'s '\'' , '\\', '\n',
    // etc. produce malformed/corrupted G# (empty literal, unterminated
    // literal, or raw control bytes in the output file).
    private func RenderCharLiteralBody(value string) string -> RenderEscapedLiteralBody(
        value,
        '\'',
        escapeDollar: false
    )

    // Issue #1721: G# uses Go-style operator precedence (mirrored from
    // SyntaxFacts.GetBinaryOperatorPrecedence in src/Core/CodeAnalysis/Syntax),
    // which differs from C#'s: `<< >> & &^` are MULTIPLICATIVE (level 5, same
    // as `* / %`), `| ^` are ADDITIVE (level 4, same as `+ -`), and ALL
    // comparisons (`== != < <= > >=`) plus `is`/`as` share level 3. C# instead
    // ranks shifts below additive, bitwise `& ^ |` below equality, and
    // relational above equality. Because the translator preserves the
    // original C# expression tree shape (which encodes C# precedence via
    // nesting, not via G# tokens), printing that tree flat under G#'s table
    // silently re-associates it. `??` is handled outside this table (parsed
    // separately, right-associative, binding just below `||`) — see the
    // level-0 fallback comment on GetBinaryOperatorPrecedence.
    private func GetBinaryPrecedence(op string) int32 -> switch op {
        case "*" or "/" or "%" or "<<" or ">>" or ">>>" or "&" or "&^": 5
        case "+" or "-" or "|" or "^": 4
        case "==" or "!=" or "<" or "<=" or ">" or ">=" or "is" or "as": 3
        case "&&": 2
        case "||": 1
        case "??": 0
        default: throw ArgumentException("Unknown binary operator: $op")
    }

    /// Renders an expression, parenthesizing it if its own G# operator
    /// precedence is lower than [`minPrecedence`](paramref) (the
    /// precedence required by the surrounding context to reproduce the
    /// original tree shape when re-parsed).
    private func RenderExpression(expression GExpression?, indent int32, minPrecedence int32) string {
        if expression is BinaryExpression outerBinary {
            let precedence = GetBinaryPrecedence(outerBinary.Operator)
            // `??` is right-associative: its left operand must strictly
            // out-bind it (else a nested `??` on the left would silently
            // re-associate), while its right operand may sit at the same
            // level (a nested `??` on the right reproduces the natural
            // right-associative chain). Every other G# binary operator is
            // left-associative: the left operand may sit at the same level,
            // but the right operand must strictly out-bind it.
            let isRightAssociative = outerBinary.Operator == "??"
            let leftMin = if isRightAssociative {
                precedence + 1
            } else {
                precedence
            }
            let rightMin = if isRightAssociative {
                precedence
            } else {
                precedence + 1
            }
            let leftText = RenderBinaryOperand(outerBinary.Left, indent, leftMin)
            let rightText = RenderBinaryOperand(outerBinary.Right, indent, rightMin)
            let rendered = "$leftText ${outerBinary.Operator} $rightText"
            return if precedence < minPrecedence {
                "($rendered)"
            } else {
                rendered
            }
        }
        return RenderExpressionCore(expression, indent)
    }

    private func RenderExpression(expression GExpression?, indent int32) string -> RenderExpression(
        expression,
        indent,
        0
    )

    // Issue #4350 (review): a first-class Index/Range expression used as the
    // target of member access, a call, or an index keeps its grouping —
    // `(^i).Value` would otherwise print `^i.Value` (parsed `^(i.Value)`), and
    // `(1..3).Start` would print `1..3.Start`.
    private func RenderPostfixTarget(target GExpression?, indent int32) string -> if target is FromEndIndexExpression ||
        target is RangeIndexExpression {
        "(${RenderExpression(target, indent)})"
    } else {
        RenderExpression(target, indent)
    }

    // Issue #4350 (review): C#'s range operator binds tighter than every binary
    // operator (`saved ?? 1..2` is `saved ?? (1..2)`), but a G# standalone range
    // binds LOOSER than all of them, so a range operand of any binary operator
    // is parenthesized to keep the original tree shape when re-parsed.
    private func RenderBinaryOperand(
        operand GExpression,
        indent int32,
        minPrecedence int32
    ) string -> if operand is RangeIndexExpression {
        "(${RenderExpression(operand, indent)})"
    } else {
        RenderExpression(operand, indent, minPrecedence)
    }

    // Issue #3470: the printer renders each statement on one line regardless
    // of source formatting, producing 300+ character lines from deliberately
    // wrapped boolean chains and argument lists. Statement-level value
    // positions render through this budgeted entry point instead: when the
    // one-line form exceeds the column budget, `&&`/`||` chains break after
    // each operator and long argument lists break after `(` and each comma —
    // both continuations gsc's parser accepts (trailing-operator and
    // open-delimiter line joining). Anything else keeps the one-line form.
    private func RenderWrappable(expression GExpression?, indent int32, prefixWidth int32) string {
        let single = RenderExpression(expression, indent)
        // Issue #3501 B2: the budget applies to the FIRST line — an
        // expression whose one-line head is over budget even when a
        // block-bodied lambda argument already made the render multi-line.
        let firstLineEnd = single.IndexOf('\n')
        let firstLineLength = if firstLineEnd < 0 {
            single.Length
        } else {
            firstLineEnd
        }
        if prefixWidth + firstLineLength <= MaxLineWidth {
            return single
        }
        return RenderWrapped(expression, indent, prefixWidth) ?? single
    }

    private func RenderWrapped(expression GExpression?, indent int32, prefixWidth int32) string? {
        let continuation = Indent(indent + 1)
        if expression is BinaryExpression{Operator: "&&" or "||"} chainRoot {
            let operands = List[GExpression]()
            let Flatten = func (node GExpression) {
                if node is BinaryExpression nested && nested.Operator == chainRoot.Operator {
                    Flatten(nested.Left)
                    Flatten(nested.Right)
                } else {
                    operands.Add(node)
                }
            }
            Flatten(chainRoot)
            let operandMin = GetBinaryPrecedence(chainRoot.Operator) + 1
            let parts = operands.Select(
                (operand GExpression) -> {
                    let text = RenderExpression(operand, indent + 1, operandMin)
                    return if operand is InvocationExpression && text.IndexOf('\n') < 0 &&
                        continuation.Length +
                        text.Length > MaxLineWidth {
                        RenderWrapped(operand, indent + 1, continuation.Length) ?? text
                    } else {
                        text
                    }
                }
            )
            return string.Join((` ` + "${chainRoot.Operator}" + `
` + "$continuation"), parts)
        }
        if TryFlattenAccessChain(expression, out var chainHead, out var chainLinks) && chainLinks.Count >= 2 {
            let headText = RenderPostfixTarget(chainHead, indent)
            let chain = StringBuilder(headText)
            for link in chainLinks {
                chain.Append('\n').Append(continuation).Append(link)
            }
            return chain.ToString()
        }
        if expression is InvocationExpression{Arguments: {Count: > 0}} invocation {
            let target = RenderPostfixTarget(invocation.Target, indent)
            let typeArgs = if invocation.TypeArguments.Count == 0 {
                string.Empty
            } else {
                "[${string.Join(", ", invocation.TypeArguments.Select(RenderType))}]"
            }
            let argTexts = invocation.Arguments.Select(
                (argument GExpression) -> RenderWrappable(argument, indent + 1, continuation.Length)
            )
            return ("$target" + "$typeArgs" + `(
` + "$continuation") + string.Join((`,
` + "$continuation"), argTexts) + ")"
        }
        if expression is ObjectCreationInitializerExpression objectCreationWrap {
            let construction = RenderWrapped(objectCreationWrap.Construction, indent, prefixWidth) ??
                RenderExpression(objectCreationWrap.Construction, indent)
            let memberTexts = objectCreationWrap.MemberInitializers.Select(
                (field FieldInitializer) -> "${field.Name} = ${RenderExpression(field.Value, indent + 1)}"
            )
            return construction + "{\n" + continuation + string.Join((`,
` + "$continuation"), memberTexts) + "}"
        }
        return nil
    }

    private func RenderExpressionCore(expression GExpression?, indent int32) string {
        switch expression {
            case block is BlockExpression {
                return RenderBranch(block.Statements, block.Value, indent)
            }
            case literal is LiteralExpression {
                return RenderLiteral(literal)
            }
            case identifier is IdentifierExpression {
                return identifier.Name
            }
            case reference is ManagedReferenceExpression {
                return "${(if reference.IsReadOnly { "readonly " } else { string.Empty })}managed(${RenderExpression(reference.Location, indent)})"
            }
            case _ is ThisExpression {
                return "this"
            }
            case member is MemberAccessExpression {
                return "${RenderPostfixTarget(member.Target, indent)}${(if member.IsArrow { "->" } else { "." })}${member.MemberName}"
            }
            case invocation is InvocationExpression {
                let typeArgs = if invocation.TypeArguments.Count == 0 {
                    string.Empty
                } else {
                    "[${string.Join(", ", invocation.TypeArguments.Select(RenderType))}]"
                }
                let args = string.Join(
                    ", ",
                    invocation.Arguments.Select((a GExpression) -> RenderExpression(a, indent))
                )
                return "${RenderPostfixTarget(invocation.Target, indent)}$typeArgs($args)"
            }
            case namedArgument is NamedArgumentExpression {
                return "${namedArgument.Name}: ${RenderExpression(namedArgument.Value, indent)}"
            }
            case index is IndexExpression {
                return "${RenderPostfixTarget(index.Target, indent)}[${string.Join(", ", index.Indices.Select((i GExpression) -> RenderExpression(i, indent)))}]"
            }
            case fromEnd is FromEndIndexExpression {
                // ADR-0187: `^x` is a unary-precedence System.Index expression.
                return "^${RenderExpression(fromEnd.Operand, indent, UnaryPrecedence)}"
            }
            case range_ is RangeIndexExpression {
                let rangeStart = if range_.Start != nil {
                    RenderExpression(range_.Start, indent)
                } else {
                    string.Empty
                }
                let rangeEnd = if range_.End != nil {
                    RenderExpression(range_.End, indent)
                } else {
                    string.Empty
                }
                return "$rangeStart..$rangeEnd"
            }
            case spread is SpreadElementExpression {
                return "...${RenderExpression(spread.Source, indent)}"
            }
            case composite is CompositeLiteralExpression {
                let inits = string.Join(
                    ", ",
                    composite.FieldInitializers.Select(
                        (f FieldInitializer) -> "${f.Name}: ${RenderExpression(f.Value, indent)}"
                    )
                )
                return "${RenderType(composite.Type)}{$inits}"
            }
            case objectCreation is ObjectCreationInitializerExpression {
                let memberInits = string.Join(
                    ", ",
                    objectCreation.MemberInitializers.Select(
                        (f FieldInitializer) -> "${f.Name} = ${RenderExpression(f.Value, indent)}"
                    )
                )
                return "${RenderExpression(objectCreation.Construction, indent)}{$memberInits}"
            }
            case anonymousClass is AnonymousClassLiteralExpression {
                let anonymousMembers = string.Join(
                    "; ",
                    anonymousClass.Members.Select(
                        (
                            f AnonymousClassMemberInitializer
                        ) -> "let ${f.Name} ${RenderType(f.Type)} = ${RenderExpression(f.Value, indent)}"
                    )
                )
                return "object { $anonymousMembers }"
            }
            case collection is CollectionInitializerExpression {
                return RenderCollectionInitializer(collection, indent)
            }
            case conversion is ConversionExpression {
                return if conversion.IsCheckedReferenceCast {
                    "cast[${RenderType(conversion.TargetType)}](${RenderExpression(conversion.Operand, indent)})"
                } else {
                    "${RenderType(conversion.TargetType)}(${RenderExpression(conversion.Operand, indent)})"
                }
            }
            case with is WithExpression {
                if with.Updates.Count == 0 {
                    return "${RenderExpression(with.Target, indent)} with { }"
                }
                let updates = string.Join(
                    ", ",
                    with.Updates.Select((f FieldInitializer) -> "${f.Name} = ${RenderExpression(f.Value, indent)}")
                )
                return "${RenderExpression(with.Target, indent)} with { $updates }"
            }
            case arrayLiteral is ArrayLiteralExpression {
                let elements = string.Join(
                    ", ",
                    arrayLiteral.Elements.Select((e GExpression) -> RenderExpression(e, indent))
                )
                return "[]${RenderArrayElementType(arrayLiteral.ElementType)}{$elements}"
            }
            case arrayAllocation is ArrayAllocationExpression {
                let allocation = "[${string.Join(", ", arrayAllocation.Dimensions.Select((d GExpression) -> RenderExpression(d, indent)))}]${RenderArrayElementType(arrayAllocation.ElementType)}"
                return if arrayAllocation.Elements.Count == 0 {
                    allocation
                } else {
                    "$allocation{${string.Join(", ", arrayAllocation.Elements.Select((e GExpression) -> RenderExpression(e, indent)))}}"
                }
            }
            case tuple is TupleLiteralExpression {
                // ADR-0172: labeled elements render as `label: value`.
                let tupleElements = string.Join(
                    ", ",
                    tuple.Elements.Select(
                        (e GExpression, i int32) -> if tuple.ElementNames?[i] is {} label {
                            "$label: ${RenderExpression(e, indent)}"
                        } else {
                            RenderExpression(e, indent)
                        }
                    )
                )
                return "($tupleElements)"
            }
            case unary is UnaryExpression {
                {
                    // Unary operators bind at precedence 6 — higher than every
                    // binary operator — so a binary-expression operand (e.g. a
                    // stray `BinaryExpression` reaching here without an explicit
                    // `ParenthesizedExpression` wrapper) must be parenthesized.
                    let operandText = RenderExpression(unary.Operand, indent, UnaryPrecedence)
                    // Issue #1721: nested same-character prefix operators
                    // silently coalesce into a different token if printed with
                    // no separating space — `!!flag` (double logical negation)
                    // lexes as the single BangBangToken (postfix non-null
                    // assertion), and `- -x` lexes as `--x` (predecrement),
                    // changing the parsed program. A space between the operator
                    // and an operand that starts with the same character keeps
                    // the tokens distinct and is always semantically safe.
                    let separator = if operandText.Length > 0 &&
                        operandText[0] == unary.Operator[unary.Operator.Length - 1] {
                        " "
                    } else {
                        string.Empty
                    }
                    return "${unary.Operator}$separator$operandText"
                }
            }
            case nonNull is NonNullAssertionExpression {
                let asserted = RenderExpression(nonNull.Operand, indent, UnaryPrecedence)
                return if (nonNull.Operand is IfExpression or IfLetExpression or SwitchExpression or BlockExpression) {
                    "($asserted)!!"
                } else {
                    "$asserted!!"
                }
            }
            case incDec is IncrementDecrementExpression {
                return if incDec.IsPrefix {
                    "${incDec.Operator}${RenderExpression(incDec.Operand, indent, UnaryPrecedence)}"
                } else {
                    "${RenderExpression(incDec.Operand, indent, UnaryPrecedence)}${incDec.Operator}"
                }
            }
            case stackAlloc is StackAllocExpression {
                {
                    let count = if stackAlloc.Count == nil {
                        string.Empty
                    } else {
                        RenderExpression(stackAlloc.Count, indent)
                    }
                    let head = "stackalloc [$count]${RenderType(stackAlloc.ElementType)}"
                    if stackAlloc.Elements == nil {
                        return head
                    }
                    let rendered = string.Join(
                        ", ",
                        stackAlloc.Elements.Select((e GExpression) -> RenderExpression(e, indent))
                    )
                    return "$head{$rendered}"
                }
            }
            case parenthesized is ParenthesizedExpression {
                // An `AssignmentExpression` renders its own parentheses
                // (ADR-0161), so a C# source-level `(x = 5)` would otherwise
                // print as `((x = 5))`.
                return if parenthesized.Inner is AssignmentExpression {
                    RenderExpression(parenthesized.Inner, indent)
                } else {
                    "(${RenderExpression(parenthesized.Inner, indent)})"
                }
            }
            case assignmentExpression is AssignmentExpression {
                // ADR-0161 / issue #3350: always parenthesized. Required in an
                // argument list, where a bare `name = value` warns as the retired
                // named-argument spelling (GS0524); harmless elsewhere, and it
                // keeps the assignment's precedence unambiguous inside a larger
                // expression (`a && (x = 5) > 0`).
                return "(" +
                    RenderExpression(assignmentExpression.Target, indent) +
                    " " +
                    assignmentExpression.Operator +
                    " " +
                    RenderExpression(assignmentExpression.Value, indent) +
                    ")"
            }
            case patternTest is PatternTestExpression {
                let patternText = RenderExpression(patternTest.Value, indent, GetBinaryPrecedence("is")) +
                    " is " +
                    RenderPattern(patternTest.Pattern, indent, includeTypeDesignator: false)
                return if patternTest.Pattern is BinaryPattern {
                    "($patternText)"
                } else {
                    patternText
                }
            }
            case checkedExpr is CheckedExpression {
                return "${(if checkedExpr.IsChecked { "checked" } else { "unchecked" })}(${RenderExpression(checkedExpr.Inner, indent)})"
            }
            case lambda is LambdaExpression {
                return RenderLambda(lambda, indent)
            }
            case await_ is AwaitExpression {
                // `await` binds at the same precedence slot as unary operators
                // (Parser.cs: `ParseBinaryExpression(6)` for the await operand).
                return "await ${RenderExpression(await_.Operand, indent, UnaryPrecedence)}"
            }
            case switchExpression is SwitchExpression {
                return RenderSwitchExpression(switchExpression, indent)
            }
            case ifExpression is IfExpression {
                return "if ${RenderExpression(ifExpression.Condition, indent)} " +
                    "${RenderBranch(ifExpression.ThenStatements, ifExpression.ThenExpression, indent)} else " +
                    "${RenderBranch(ifExpression.ElseStatements, ifExpression.ElseExpression, indent)}"
            }
            case ifLetExpression is IfLetExpression {
                return RenderIfLetExpression(ifLetExpression, indent)
            }
            case throwExpression is ThrowExpression {
                // G# supports throw-as-expression natively: render the bare
                // `throw <operand>` form, valid in coalesce-RHS, switch-arm,
                // and ternary expression positions (issue #1153).
                return "throw ${RenderExpression(throwExpression.Operand, indent)}"
            }
            case outArgument is OutArgumentExpression {
                return "${outArgument.Keyword} ${outArgument.Name}"
            }
            case typeOf is TypeOfExpression {
                return "typeof(${RenderType(typeOf.Type)})"
            }
            case defaultValue is DefaultValueExpression {
                return if defaultValue.Type == nil {
                    "default"
                } else {
                    "default(${RenderType(defaultValue.Type)})"
                }
            }
            case typeExpression is TypeExpression {
                return RenderType(typeExpression.Type)
            }
            case ConditionalReceiverExpression {
                return string.Empty
            }
            case conditionalAccess is ConditionalAccessExpression {
                return "${RenderExpression(conditionalAccess.Target, indent)}?${RenderExpression(conditionalAccess.WhenNotNull, indent)}"
            }
            case interpolated is InterpolatedStringExpression {
                return RenderInterpolatedString(interpolated, indent)
            }
            default {
                throw ArgumentException("Unsupported expression: ${expression?.GetType().Name}")
            }
        }
    }

    /// ADR-0151: renders the value-position `if let` form
    /// `if let a = e [, let b = e2]* [&& guard] { then } else { else }`.
    /// @remarks Each binding initializer is rendered at (cref:IfLetInitializerPrecedence)
    /// so a top-level `&&` / `||` / `??` is parenthesized:
    /// gsc parses an expression-form initializer only up to the logical-and
    /// tier, and the first top-level `&&` starts the guard. The
    /// guard itself needs no wrapping — gsc parses everything after the
    /// delimiter with the full expression grammar, so a flat reprint
    /// reproduces the original tree.
    private func RenderIfLetExpression(ifLet IfLetExpression, indent int32) string {
        let bindings = string.Join(
            ", ",
            ifLet.Bindings.Select(
                (binding IfLetBinding) -> {
                    let type = if binding.DeclaredType == nil {
                        string.Empty
                    } else {
                        " ${RenderType(binding.DeclaredType)}"
                    }
                    let initializer = RenderExpression(binding.Initializer, indent, IfLetInitializerPrecedence)
                    return "let ${binding.Name}$type = $initializer"
                }
            )
        )
        let guard_ = if ifLet.Guard == nil {
            string.Empty
        } else {
            " && ${RenderExpression(ifLet.Guard, indent)}"
        }
        return "if $bindings$guard_ " +
            "{ ${RenderBranchValue(ifLet.ThenExpression, indent)} } " +
            "else { ${RenderBranchValue(ifLet.ElseExpression, indent)} }"
    }

    private func RenderBranchValue(expression GExpression, indent int32) string {
        // A switch expression rendered bare as the tail of an `if`-expression
        // branch block (`else { switch … }`) is re-parsed as a switch STATEMENT
        // (whose arms use `{ … }` bodies, not `case …:`), so it is parenthesized
        // to keep it in expression position. Other expressions are unaffected.
        if expression is SwitchExpression || expression is IfExpression || expression is IfLetExpression {
            return "(${RenderExpression(expression, indent)})"
        }
        // A bare throw-expression is not accepted as the sole trailing value of
        // an if-expression block branch (gsc GS0277). Emit the throw as a
        // STATEMENT followed by a value-producing typed tail so the branch block
        // ends with a value-producing expression (issue #1153).
        if expression is ThrowExpression throwExpression {
            let throwTail = if throwExpression.ResultType == nil {
                "default"
            } else {
                "default(${RenderType(throwExpression.ResultType)})"
            }
            return (`throw ` + "${RenderExpression(throwExpression.Operand, indent)}" + `
` + "${Indent(indent + 1)}" + "$throwTail")
        }
        return RenderExpression(expression, indent)
    }

    private func RenderBranch(statements IReadOnlyList[GStatement], value GExpression, indent int32) string {
        if statements.Count == 0 {
            return "{ ${RenderBranchValue(value, indent)} }"
        }
        let sb = StringBuilder()
        sb.Append('{')
        for statement in statements {
            sb.Append('\n')
            sb.Append(RenderStatement(statement, indent + 1))
        }
        sb.Append('\n')
        sb.Append(Indent(indent + 1))
        sb.Append(RenderBranchValue(value, indent))
        sb.Append('\n')
        sb.Append(Indent(indent))
        sb.Append('}')
        return sb.ToString()
    }

    private func RenderCollectionInitializer(collection CollectionInitializerExpression, indent int32) string {
        // Canonical form: drop the empty `()` on a zero-argument GENERIC
        // construction so `List[int32](){...}` renders as `List[int32]{...}`
        // — gsc's parser recognises a bare `Type[args]{ ... }` as a collection
        // initializer for ANY element shape (`BraceLooksLikeGenericCollectionInitializer`).
        // A NON-generic zero-arg target (`IndexKeyed()`) has no such carve-out:
        // gsc's bare `Identifier{ ... }` grammar commits to a STRUCT LITERAL
        // (`Identifier :` fields only, `IsStructLiteralFollowingBrace`) and
        // silently fails to parse a `key: value`/`[key] = value` collection
        // element there (issue #1967) — so the `()` must stay so the parser
        // takes its `LooksLikeCollectionInitializerBrace` path instead.
        var target string
        if collection.Target == nil {
            // Issue #1567: a target-less collection initializer is the member
            // collection-initializer form `{ elems }` used as a composite/object-
            // initializer member value to populate a get-only collection
            // property (lowered to `.Add(...)` calls by gsc).
            target = string.Empty
        } else if collection.Target is InvocationExpression invocation &&
            invocation
            .Arguments
            .Count == 0 &&
            invocation
            .TypeArguments
            .Count > 0 &&
            !collection
            .Elements
            .Any((element CollectionInitializerElement) -> element.Value is SpreadElementExpression) {
            let typeArgs = "[${string.Join(", ", invocation.TypeArguments.Select(RenderType))}]"
            target = "${RenderPostfixTarget(invocation.Target, indent)}$typeArgs"
        } else {
            target = RenderExpression(collection.Target, indent)
        }
        let elements = collection.Elements.Select(
            (element CollectionInitializerElement) -> switch element.Kind {
                case CollectionInitializerElementKind.Keyed: "${RenderExpression(element.Key, indent)}: ${RenderExpression(element.Value, indent)}"
                case CollectionInitializerElementKind.Indexed: "[${RenderExpression(element.Key, indent)}] = ${RenderExpression(element.Value, indent)}"
                case CollectionInitializerElementKind.Assignment: "${element.MemberName} = ${RenderExpression(element.Value, indent)}"
                default: RenderExpression(element.Value, indent)
            }
        )
        return "$target{ ${string.Join(", ", elements)} }"
    }

    private func RenderLiteral(literal LiteralExpression) string {
        switch literal.Kind {
            case LiteralKind.ByteString {
                let result = System.Text.StringBuilder("b\"")
                for value in Convert.FromHexString(literal.Value) {
                    if value == 34 || value == 92 {
                        result.Append('\\')
                        result.Append(char(value))
                    } else if value >= 32 && value <= 126 {
                        result.Append(char(value))
                    } else {
                        result.Append("\\x")
                        result.Append(value.ToString("X2", System.Globalization.CultureInfo.InvariantCulture))
                    }
                }
                result.Append('"')
                return result.ToString()
            }
            case LiteralKind.String {
                // Issue #3501: a multiline C# literal (raw/verbatim test
                // fixture) renders as a Go-style backtick raw string keeping
                // its original line structure, instead of collapsing into an
                // escaped one-liner — the source of most >300-char emitted
                // lines. Backtick strings process no escapes and normalize
                // CR at lexing, so values containing CR keep the escaped
                // form; trivially short values do too.
                if literal.Value.IndexOf('\n') >= 0 && literal.Value.IndexOf('\r') < 0 &&
                    HasOnlyRawStringSafeCharacters(literal.Value) &&
                    (literal.Value.Length > 120 || literal.Value.IndexOf('\n') != literal.Value.LastIndexOf('\n')) {
                    if literal.Value.IndexOf('`') < 0 {
                        return "`${literal.Value}`"
                    }
                    // ADR-0179 phase 9b: a backtick raw string has no escape,
                    // so a value that CONTAINS one is unspellable as a single
                    // raw string. Go's answer is concatenation, and so is
                    // this one.
                    if RenderBacktickBearingRawString(literal.Value) is {} spliced {
                        return spliced
                    }
                }
                return "\"${RenderStringLiteralBody(literal.Value)}\""
            }
            case LiteralKind.RawString {
                return "`${literal.Value}`"
            }
            case LiteralKind.Char {
                return "'${RenderCharLiteralBody(literal.Value)}'"
            }
            default {
                return literal.Value
            }
        }
    }

    /// ADR-0179 phase 9b: spells a multi-line value that contains a backtick
    /// as a parenthesized concatenation of raw-string runs and quoted
    /// backtick runs — `(`a` + "`" + `b`)` — the shape Go uses for the
    /// same hole in its own raw strings.
    /// @remarks The value is split into maximal runs of backtick and non-backtick
    /// characters. Every non-backtick run is raw-safe by construction (the
    /// caller has already excluded CR and control characters), so it keeps
    /// its line structure inside backticks; every backtick run goes into an
    /// ordinary double-quoted string, where a backtick is not special. The
    /// concatenation is therefore character-for-character the original value
    /// — no escape sequence is introduced or removed on either side.
    ///
    /// The parentheses are load-bearing: a bare `a + b` substituted where
    /// a literal was expected would re-associate under a surrounding operator
    /// and would bind `.Length` to the last fragment instead of the whole
    /// string.
    ///
    /// Returns `null` when the splice does not actually help.
    /// A value that is mostly backticks fragments into many short pieces whose
    /// longest line beats nothing, and the escaped one-liner is then both
    /// shorter and simpler; the decision is made by measuring, not assumed.
    private func RenderBacktickBearingRawString(value string) string? {
        let parts = List[string]()
        var index = 0
        while index < value.Length {
            let isBacktickRun = value[index] == '`'
            var end = index
            while end < value.Length && (value[end] == '`') == isBacktickRun {
                end++
            }
            let run = value.Substring(index, end - index)
            parts.Add(
                if isBacktickRun {
                    "\"${RenderStringLiteralBody(run)}\""
                } else {
                    "`$run`"
                }
            )
            index = end
        }
        let spliced = "(${string.Join(" + ", parts)})"
        let escapedWidth = RenderStringLiteralBody(value).Length + 2
        // Two conditions, and the second is the one that matters. Reducing the
        // longest line is the point; but a value that is MOSTLY backticks
        // shreds into hundreds of two-character fragments whose lines are all
        // short and whose total text is many times the escaped form. That
        // trades one long line for a wall of `+` and is not an improvement, so
        // the splice also has to stay within twice the escaped width.
        return if LongestLineLength(spliced) < escapedWidth && spliced.Length <= (2 * escapedWidth) {
            spliced
        } else {
            default(string?)
        }
    }

    private func LongestLineLength(text string) int32 {
        var longest = 0
        var start = 0
        while start <= text.Length {
            let newline = text.IndexOf('\n', start)
            let end = if newline < 0 {
                text.Length
            } else {
                newline
            }
            longest = Math.Max(longest, end - start)
            if newline < 0 {
                break
            }
            start = newline + 1
        }
        return longest
    }

    // Raw backtick strings carry their characters verbatim, so a control
    // character other than '\n'/'\t' would land in the emitted source as a raw
    // byte — an embedded NUL even lexes as end-of-file (GS0003 unterminated
    // string). Such values keep the escaped one-line form.
    private func HasOnlyRawStringSafeCharacters(value string) bool {
        for c in value {
            if c < ' ' && c != '\n' && c != '\t' {
                return false
            }
        }
        return true
    }

    private func RenderLambda(lambda LambdaExpression, indent int32) string {
        let asyncPrefix = if lambda.IsAsync {
            "async "
        } else {
            string.Empty
        }
        let parameters = RenderParameterList(lambda.Parameters)
        if lambda.BlockBody != nil {
            // ADR-0128 / issue #1172: a block-bodied arrow lambda renders as the
            // idiomatic G# arrow form `(params) -> { … }`. The arrow lambda's block
            // body is now a STATEMENT block with an optional trailing value
            // expression — full parity with func literals — and its return type is
            // inferred, so no explicit return-type clause is needed.
            //
            // A C# local function (IsFunctionLiteral) is NOT an arrow lambda, so it
            // keeps the function-literal form `func (params) RetType { … }`; the
            // explicit return type is required so a value-returning literal is not
            // inferred as void (and supports recursion).
            let arrowOpen = if lambda.IsFunctionLiteral {
                "${asyncPrefix}func ($parameters)" +
                    (
                    if lambda.ReturnType != nil {
                        " " +
                            (
                            if lambda.IsRefReturn {
                                "ref "
                            } else {
                                string.Empty
                            }
                        ) +
                            RenderTypeReference(lambda.ReturnType)
                    } else {
                        string.Empty
                    }
                ) +
                    " {"
            } else {
                "$asyncPrefix($parameters) -> {"
            }
            let sb = StringBuilder()
            sb.Append(arrowOpen)
            for statement in lambda.BlockBody!!.Statements {
                sb.Append('\n')
                sb.Append(RenderStatement(statement, indent + 1))
            }
            sb.Append('\n')
            sb.Append(Indent(indent))
            sb.Append('}')
            return sb.ToString()
        }
        var expressionBody = RenderExpression(lambda.ExpressionBody, indent)
        if lambda.ExpressionBody is WithExpression {
            // Keep the low-precedence `with` tail inside the lambda body.
            expressionBody = "($expressionBody)"
        }
        return "$asyncPrefix($parameters) -> $expressionBody"
    }

    private func RenderSwitchExpression(switchExpression SwitchExpression, indent int32) string {
        let pad = Indent(indent)
        let armPad = Indent(indent + 1)
        let sb = StringBuilder()
        sb.Append("switch ${RenderExpression(switchExpression.Subject, indent)} {")
        for arm in switchExpression.Arms {
            sb.Append('\n')
            sb.Append(armPad)
            var marker string
            if arm.Pattern == nil && arm.Guard == nil {
                marker = "default:"
            } else if arm.Guard != nil {
                // A guarded discard (`_ when g =>`) must keep its guard: G#'s
                // spelling is `case _ when g:` — rendering it as `default:`
                // dropped the guard (a silent behavior change) AND collided
                // with the synthesized total arm (GS0169, the GeneratorHost
                // wall in #3501).
                let guardedPattern = if arm.Pattern == nil {
                    "_"
                } else {
                    RenderPattern(arm.Pattern, indent + 1)
                }
                marker = "case $guardedPattern when ${RenderExpression(arm.Guard, indent + 1)}:"
            } else {
                marker = "case ${RenderPattern(arm.Pattern, indent + 1)}:"
            }
            sb.Append(marker)
            sb.Append(' ')
            sb.Append(RenderExpression(arm.Body, indent + 1))
        }
        sb.Append('\n')
        sb.Append(pad)
        sb.Append('}')
        return sb.ToString()
    }

    private func RenderPattern(pattern GPattern?, indent int32, includeTypeDesignator bool = true) string {
        switch pattern {
            case constant is ConstantPattern {
                return RenderExpression(constant.Value, indent)
            }
            case relational is RelationalPattern {
                return "${relational.Operator} ${RenderExpression(relational.Value, indent)}"
            }
            case type is TypePattern {
                {
                    var typeText = RenderType(type.Type)
                    if type.Suffix != nil {
                        typeText += " " +
                            RenderPattern(PropertyPattern(type.Suffix.Fields), indent, includeTypeDesignator)
                    }
                    // ADR-0166: `Type name` is valid in every pattern position and
                    // is the only spelling a boolean `is` accepts; the switch-only
                    // `name is Type` spelling is kept for arms that ask for it.
                    if type.DesignationAfterType {
                        return if string.IsNullOrEmpty(type.Designator) || type.Designator == "_" {
                            typeText
                        } else {
                            "$typeText ${type.Designator}"
                        }
                    }
                    return if includeTypeDesignator {
                        "${type.Designator} is $typeText"
                    } else {
                        typeText
                    }
                }
            }
            case property is PropertyPattern {
                {
                    let fields = string.Join(
                        ", ",
                        property.Fields.Select(
                            (
                                f PropertyPatternField
                            ) -> "${f.Name}: ${RenderPattern(f.Pattern, indent, includeTypeDesignator)}"
                        )
                    )
                    let text = if property.Fields.Count == 0 {
                        "{ }"
                    } else {
                        "{ $fields }"
                    }
                    return if string.IsNullOrEmpty(property.Designator) || property.Designator == "_" {
                        text
                    } else {
                        "$text ${property.Designator}"
                    }
                }
            }
            case _ is DiscardPattern {
                return "_"
            }
            case varPattern is VarPattern {
                return "var ${varPattern.Designator}"
            }
            case binary is BinaryPattern {
                return "${RenderPattern(binary.Left, indent, includeTypeDesignator)} ${(if binary.IsConjunction { "and" } else { "or" })} ${RenderPattern(binary.Right, indent, includeTypeDesignator)}"
            }
            case not_ is NotPattern {
                // Issue #3501: `not` binds tighter than `and`/`or` in gsc's
                // pattern grammar, so a combinator child must keep its grouping
                // (`not (T and { … })`); printing it bare re-associates to
                // `(not T) and { … }` and the property pattern escapes the
                // negation (GS0172/GS0173 against the scrutinee's own type).
                return if not_.Pattern is BinaryPattern {
                    "not (${RenderPattern(not_.Pattern, indent, includeTypeDesignator)})"
                } else {
                    "not ${RenderPattern(not_.Pattern, indent, includeTypeDesignator)}"
                }
            }
            case paren is ParenthesizedPattern {
                return "(${RenderPattern(paren.Pattern, indent, includeTypeDesignator)})"
            }
            case list is ListPattern {
                return "[${string.Join(", ", list.Elements.Select((e GPattern) -> RenderPattern(e, indent, includeTypeDesignator)))}]"
            }
            case slice is SlicePattern {
                if slice.Pattern != nil {
                    return "..${RenderPattern(slice.Pattern, indent, includeTypeDesignator)}"
                }
                return if slice.Designator != nil {
                    "..${slice.Designator}"
                } else {
                    ".."
                }
            }
            default {
                throw ArgumentException("Unsupported pattern: ${pattern?.GetType().Name}")
            }
        }
    }

    private func RenderInterpolatedString(interpolated InterpolatedStringExpression, indent int32) string {
        if interpolated.Parts.Any((part InterpolationPart) -> !part.IsHole && part.Text!!.IndexOf('\n') >= 0) {
            return RenderMultilineInterpolatedString(interpolated, indent)
        }
        return RenderQuotedInterpolatedString(interpolated, indent)
    }

    private func RenderMultilineInterpolatedString(interpolated InterpolatedStringExpression, indent int32) string {
        let segments = List[string]()
        for part in interpolated.Parts {
            if part.IsHole {
                // Keep the hole inside interpolation: ToString concatenation
                // would lose alignment, format, culture and null semantics.
                segments.Add(
                    RenderQuotedInterpolatedString(InterpolatedStringExpression([]InterpolationPart{part}), indent)
                )
                continue
            }
            if part.Text!!.Length == 0 {
                segments.Add("\"\"")
                continue
            }
            var start = 0
            while start < part.Text!!.Length {
                let rawSafe = IsRawStringSafeCharacter(part.Text!![start]) && part.Text!![start] != '`'
                var end = start + 1
                while end < part.Text!!.Length &&
                    (IsRawStringSafeCharacter(part.Text!![end]) && part.Text!![end] != '`') == rawSafe {
                    end++
                }
                let run = part.Text!!.Substring(start, end - start)
                // Do not print a literal backtick inside a quoted segment:
                // raw-line tooling cannot distinguish it from a delimiter.
                segments.Add(
                    if rawSafe {
                        "`$run`"
                    } else {
                        "\"${RenderStringLiteralBody(run).Replace("`", "\\u0060")}\""
                    }
                )
                start = end
            }
        }
        return "(${string.Join(" + ", segments)})"
    }

    private func IsRawStringSafeCharacter(value char) bool -> value >= ' ' || value == '\n' || value == '\t'

    private func RenderQuotedInterpolatedString(interpolated InterpolatedStringExpression, indent int32) string {
        let sb = StringBuilder()
        sb.Append('"')
        for var i = 0; i < interpolated.Parts.Count; i++ {
            let part = interpolated.Parts[i]
            if !part.IsHole {
                sb.Append(RenderInterpolationText(part.Text))
                continue
            }
            let canUseShorthand = part.Expression is IdentifierExpression && string.IsNullOrEmpty(part.Alignment) &&
                string.IsNullOrEmpty(part.Format) && !NextLiteralContinuesIdentifier(interpolated.Parts, i)
            if canUseShorthand {
                sb.Append('$')
                sb.Append((cast[IdentifierExpression](part.Expression)).Name)
                continue
            }
            sb.Append("$${")
            sb.Append(RenderExpression(part.Expression, indent))
            if !string.IsNullOrEmpty(part.Alignment) {
                sb.Append(',')
                sb.Append(part.Alignment)
            }
            if !string.IsNullOrEmpty(part.Format) {
                sb.Append(':')
                sb.Append(part.Format)
            }
            sb.Append('}')
        }
        sb.Append('"')
        return sb.ToString()
    }

    private func NextLiteralContinuesIdentifier(parts IReadOnlyList[InterpolationPart], holeIndex int32) bool {
        if holeIndex + 1 >= parts.Count {
            return false
        }
        let next = parts[holeIndex + 1]
        if next.IsHole || string.IsNullOrEmpty(next.Text) {
            return false
        }
        let first = next.Text!![0]
        return char.IsLetterOrDigit(first) || first == '_'
    }

    private func TryFlattenAccessChain(expression GExpression?, out head GExpression?, out links List[string]) bool {
        head = expression
        links = List[string]()
        let reversed = List[string]()
        var current GExpression? = expression
        while true {
            if current is InvocationExpression{Target: MemberAccessExpression{IsArrow: false} call} chainCall {
                let typeArgs = if chainCall.TypeArguments.Count == 0 {
                    string.Empty
                } else {
                    "[${string.Join(", ", chainCall.TypeArguments.Select(RenderType))}]"
                }
                let args = string.Join(
                    ", ",
                    chainCall.Arguments.Select((argument GExpression) -> RenderExpression(argument, 0))
                )
                reversed.Add(".${call.MemberName}$typeArgs($args)")
                current = call.Target
                continue
            }
            if current is MemberAccessExpression{IsArrow: false} access {
                reversed.Add(".${access.MemberName}")
                current = access.Target
                continue
            }
            break
        }
        if reversed.Count < 2 {
            return false
        }
        head = current
        reversed.Reverse()
        links = reversed
        return true
    }

    private func RenderStatement(statement GStatement?, indent int32) string {
        var core = RenderStatementCore(statement, indent)
        if statement!!.TrailingComment != nil {
            core = "$core ${statement!!.TrailingComment}"
        }
        return PrependAttachedComments(statement, core, indent)
    }

    // Issue #3469: author comments captured from the source C# node's leading
    // trivia print, indented, immediately above the node they rode in on.
    private func PrependAttachedComments(node GNode?, rendered string, indent int32) string {
        if node?.AttachedComments is not{Count: > 0} comments {
            return rendered
        }
        let pad = Indent(indent)
        let sb = StringBuilder()
        for comment in comments {
            sb.Append(pad).Append(comment).Append('\n')
        }
        sb.Append(rendered)
        return sb.ToString()
    }

    private func RenderStatementCore(statement GStatement?, indent int32) string {
        let pad = Indent(indent)
        switch statement {
            case local is LocalDeclarationStatement {
                let typeClause = if local.Type == nil {
                    string.Empty
                } else {
                    " ${RenderType(local.Type)}"
                }
                let usingPrefix = if local.IsUsing {
                    (
                        if local.IsAwait {
                            "await using "
                        } else {
                            "using "
                        }
                    )
                } else {
                    string.Empty
                }
                let refPrefix = if local.IsReadOnlyRefAlias {
                    "ref readonly "
                } else {
                    (
                        if local.IsRefAlias {
                            "ref "
                        } else {
                            string.Empty
                        }
                    )
                }
                let declHead = "$pad${RenderSuppressionPrefix(local.SuppressedDiagnostics)}$usingPrefix${RenderBinding(local.Binding)} $refPrefix${local.Name}$typeClause"
                let initClause = if local.Initializer == nil {
                    string.Empty
                } else {
                    " = ${RenderWrappable(local.Initializer, indent, declHead.Length + 3)}"
                }
                return "$declHead$initClause"
            }
            case expression is ExpressionStatement {
                return "$pad${RenderWrappable(expression.Expression, indent, pad.Length)}"
            }
            case assignment is AssignmentStatement {
                let assignmentHead = "$pad${RenderExpression(assignment.Target, indent)} ${assignment.Operator} "
                return assignmentHead + RenderWrappable(assignment.Value, indent, assignmentHead.Length)
            }
            case multiAssignment is MultiAssignmentStatement {
                return "$pad" + string.Join(
                    ", ",
                    multiAssignment.Targets.Select(
                        (target GExpression, index int32) -> (
                            if multiAssignment.TargetBindings[index] is {} binding {
                                RenderBinding(binding) + " "
                            } else {
                                string.Empty
                            }
                        ) +
                            RenderExpression(target, indent)
                    )
                ) +
                    " = " +
                    string.Join(
                    ", ",
                    multiAssignment.Values.Select((value GExpression) -> RenderExpression(value, indent))
                )
            }
            case ret is ReturnStatement {
                return if ret.Expression == nil {
                    "${pad}return"
                } else {
                    (
                        if ret.IsRef {
                            "${pad}return ref ${RenderExpression(ret.Expression, indent)}"
                        } else {
                            "${pad}return ${RenderWrappable(ret.Expression, indent, pad.Length + 7)}"
                        }
                    )
                }
            }
            case thrown is ThrowStatement {
                return "${pad}throw ${RenderExpression(thrown.Expression, indent)}"
            }
            case RethrowStatement {
                return "${pad}rethrow"
            }
            case ifStatement is IfStatement {
                return RenderIf(ifStatement, indent)
            }
            case ifLetStatement is IfLetStatement {
                return RenderIfLet(ifLetStatement, indent)
            }
            case whileStatement is WhileStatement {
                return "${pad}while ${RenderWrappable(whileStatement.Condition, indent, pad.Length + 6)} ${RenderBlock(whileStatement.Body, indent)}"
            }
            case whileLetStatement is WhileLetStatement {
                return "${pad}while ${RenderLetBindings(whileLetStatement.Bindings, indent)} ${RenderBlock(whileLetStatement.Body, indent)}"
            }
            case lockStatement is LockStatement {
                return "${pad}lock ${RenderExpression(lockStatement.Target, indent)} ${RenderBlock(lockStatement.Body, indent)}"
            }
            case forStatement is ForStatement {
                return RenderForStatement(forStatement, indent)
            }
            case incDec is IncrementDecrementStatement {
                return "$pad${RenderExpression(incDec.Target, indent)}${incDec.Operator}"
            }
            case fixedStatement is FixedStatement {
                return "${pad}fixed ${fixedStatement.Name} ${RenderType(fixedStatement.PointerType)} = ${RenderExpression(fixedStatement.Source, indent)} ${RenderBlock(fixedStatement.Body, indent)}"
            }
            case forIn is ForInStatement {
                let loopVars = if string.IsNullOrEmpty(forIn.ValueName) {
                    (
                        if forIn.VariableType == nil {
                            forIn.VariableName
                        } else {
                            "${forIn.VariableName} ${RenderType(forIn.VariableType)}"
                        }
                    )
                } else {
                    "${forIn.VariableName}, ${forIn.ValueName}"
                }
                let forKeyword = if forIn.IsAwait {
                    "await for"
                } else {
                    "for"
                }
                return "$pad$forKeyword $loopVars in ${RenderExpression(forIn.Iterable, indent)} ${RenderBlock(forIn.Body, indent)}"
            }
            case forTupleIn is ForTupleInStatement {
                let tupleLoopVars = string.Join(", ", forTupleIn.Names)
                return "${pad}for ($tupleLoopVars) in ${RenderExpression(forTupleIn.Iterable, indent)} ${RenderBlock(forTupleIn.Body, indent)}"
            }
            case defer_ is DeferStatement {
                return "${pad}defer ${RenderExpression(defer_.Call, indent)}"
            }
            case tryStatement is TryStatement {
                return RenderTry(tryStatement, indent)
            }
            case block is BlockStatement {
                return "$pad${RenderSuppressionPrefix(block.SuppressedDiagnostics)}${RenderBlock(block, indent)}"
            }
            case raw is RawStatement {
                return "$pad${raw.Text}"
            }
            case yield is YieldStatement {
                return if yield.Expression == nil {
                    "${pad}yield break"
                } else {
                    "${pad}yield ${RenderExpression(yield.Expression, indent)}"
                }
            }
            case switchStatement is SwitchStatement {
                return RenderSwitchStatement(switchStatement, indent)
            }
            case BreakStatement {
                return "${pad}break"
            }
            case ContinueStatement {
                return "${pad}continue"
            }
            case FallthroughStatement {
                return "${pad}fallthrough"
            }
            case gotoStatement is GotoStatement {
                return "${pad}goto ${gotoStatement.Label}"
            }
            case labeledStatement is LabeledStatement {
                return ("$pad" + "${labeledStatement.Label}" + `:
` + "${RenderStatement(labeledStatement.Statement, indent)}")
            }
            case doWhile is DoWhileStatement {
                return "${pad}do ${RenderBlock(doWhile.Body, indent)} while ${RenderExpression(doWhile.Condition, indent)}"
            }
            case deconstruction is TupleDeconstructionStatement {
                let targets = string.Join(", ", deconstruction.Names)
                return "$pad${RenderBinding(deconstruction.Binding)} ($targets) = ${RenderExpression(deconstruction.Initializer, indent)}"
            }
            case localFunction is LocalFunctionStatement {
                let typeParamSuffix = if localFunction.TypeParameters.Count > 0 {
                    "[${string.Join(", ", localFunction.TypeParameters)}]"
                } else {
                    string.Empty
                }
                return "$pad${RenderBinding(BindingKind.Let)} ${localFunction.Name}$typeParamSuffix = ${RenderExpression(localFunction.Lambda, indent)}"
            }
            default {
                throw ArgumentException("Unsupported statement: ${statement?.GetType().Name}")
            }
        }
    }

    private func RenderSwitchStatement(switchStatement SwitchStatement, indent int32) string {
        let pad = Indent(indent)
        let casePad = Indent(indent + 1)
        let sb = StringBuilder()
        sb.Append("${pad}switch ${RenderExpression(switchStatement.Subject, indent)} {")
        for arm in switchStatement.Cases {
            sb.Append('\n')
            sb.Append(casePad)
            var head string
            if arm.Pattern == nil && arm.Guard == nil {
                head = "default"
            } else if arm.Guard != nil {
                // Same guarded-discard rule as RenderSwitchExpression: the
                // guard must survive as `case _ when g`, never fold to
                // `default`.
                let guardedPattern = if arm.Pattern == nil {
                    "_"
                } else {
                    RenderPattern(arm.Pattern, indent + 1)
                }
                head = "case $guardedPattern when ${RenderExpression(arm.Guard, indent + 1)}"
            } else {
                // Issue #3501 A3: a merged multi-label arm renders as the
                // Go-style comma list `case 1, 2, 3`.
                let patterns = string.Join(
                    ", ",
                    []GPattern{arm.Pattern!!}.Concat(arm.AdditionalPatterns).Select(
                        (p GPattern) -> RenderPattern(p, indent + 1)
                    )
                )
                head = "case $patterns"
            }
            sb.Append("$head ${RenderBlock(arm.Body, indent + 1)}")
        }
        sb.Append('\n')
        sb.Append(pad)
        sb.Append('}')
        return sb.ToString()
    }

    private func RenderForStatement(forStatement ForStatement, indent int32) string {
        let pad = Indent(indent)
        let init = if forStatement.Initializer == nil {
            string.Empty
        } else {
            RenderSimpleStatement(forStatement.Initializer, indent)
        }
        let cond = if forStatement.Condition == nil {
            string.Empty
        } else {
            RenderExpression(forStatement.Condition, indent)
        }
        let incr = if forStatement.Incrementor == nil {
            string.Empty
        } else {
            RenderSimpleStatement(forStatement.Incrementor, indent)
        }
        return "${pad}for $init; $cond; $incr ${RenderBlock(forStatement.Body, indent)}"
    }

    private func RenderSimpleStatement(statement GStatement?, indent int32) string {
        // A "simple" statement (init/incr clause of a C-style for) is rendered
        // inline with no leading indentation — and no leading comments, which
        // would corrupt the single-line clause (issue #3469).
        return RenderStatementCore(statement, indent).TrimStart()
    }

    private func RenderIfLet(ifLet IfLetStatement, indent int32) string {
        let pad = Indent(indent)
        let bindings = RenderLetBindings(ifLet.Bindings, indent)
        // No guard clause: cs2gs output must compile with the pinned previous
        // release, whose statement grammar has none (see IfLetStatement).
        // Initializers are still printed at IfLetInitializerPrecedence because
        // gsc ends every binding initializer at a top-level `&&` / `||`
        // (ADR-0201).
        let sb = StringBuilder()
        sb.Append("${pad}if $bindings ${RenderBlock(ifLet.Then, indent)}")
        if ifLet.Else is IfStatement elseIf {
            sb.Append(" else ")
            sb.Append(RenderIf(elseIf, indent).TrimStart())
        } else if ifLet.Else is IfLetStatement elseIfLet {
            sb.Append(" else ")
            sb.Append(RenderIfLet(elseIfLet, indent).TrimStart())
        } else if ifLet.Else is BlockStatement elseBlock {
            sb.Append(" else ")
            sb.Append(RenderBlock(elseBlock, indent))
        }
        return sb.ToString()
    }

    private func RenderLetBindings(bindings IReadOnlyList[IfLetBinding], indent int32) string {
        return string.Join(
            ", ",
            bindings.Select(
                (binding IfLetBinding) -> {
                    let type = if binding.DeclaredType == nil {
                        string.Empty
                    } else {
                        " ${RenderType(binding.DeclaredType)}"
                    }
                    let initializer = RenderExpression(binding.Initializer, indent, IfLetInitializerPrecedence)
                    return "let ${binding.Name}$type = $initializer"
                }
            )
        )
    }

    private func RenderIf(ifStatement IfStatement, indent int32) string {
        let pad = Indent(indent)
        let sb = StringBuilder()
        sb.Append(
            "${pad}if ${RenderWrappable(ifStatement.Condition, indent, pad.Length + 3)} ${RenderBlock(ifStatement.Then, indent)}"
        )
        if ifStatement.ElseBranch is IfStatement elseIf {
            sb.Append(" else ")
            sb.Append(RenderIf(elseIf, indent).TrimStart())
        } else if ifStatement.ElseBranch is BlockStatement elseBlock {
            sb.Append(" else ")
            sb.Append(RenderBlock(elseBlock, indent))
        }
        return sb.ToString()
    }

    private func RenderTry(tryStatement TryStatement, indent int32) string {
        let pad = Indent(indent)
        let sb = StringBuilder()
        sb.Append("${pad}try ${RenderBlock(tryStatement.TryBlock, indent)}")
        for catchClause in tryStatement.CatchClauses {
            if catchClause.ExceptionType != nil {
                let binder = if string.IsNullOrEmpty(catchClause.VariableName) {
                    RenderType(catchClause.ExceptionType)
                } else {
                    "${catchClause.VariableName} ${RenderType(catchClause.ExceptionType)}"
                }
                sb.Append(" catch ($binder)")
            } else {
                sb.Append(" catch")
            }
            // ADR-0177: `when` is contextual, and the filter sits in body-header
            // position, so it renders as a bare expression ahead of the block.
            if catchClause.Filter != nil {
                sb.Append(" when ${RenderExpression(catchClause.Filter, indent)}")
            }
            sb.Append(" ${RenderBlock(catchClause.Body, indent)}")
        }
        if tryStatement.FinallyBlock != nil {
            sb.Append(" finally ${RenderBlock(tryStatement.FinallyBlock, indent)}")
        }
        return sb.ToString()
    }

    /// Issue #4422: the ADR-0175 `@SuppressDiagnostic("ID", …) ` prefix of
    /// an annotated statement-position block or local declaration, or empty.
    /// @param ids The suppressed diagnostic identifiers.
    /// @returns The prefix, ending in a space, or the empty string.
    private func RenderSuppressionPrefix(ids IReadOnlyList[string]?) string {
        if ids == nil || ids.Count == 0 {
            return string.Empty
        }
        return "@SuppressDiagnostic(" + string.Join(", ", ids.Select((id string) -> "\"" + id + "\"")) + ") "
    }

    private func RenderBlock(block BlockStatement?, indent int32) string {
        let prefix = if block!!.IsUnsafe {
            "unsafe "
        } else {
            (
                if block!!.IsChecked {
                    "checked "
                } else {
                    (
                        if block!!.IsUnchecked {
                            "unchecked "
                        } else {
                            string.Empty
                        }
                    )
                }
            )
        }
        if block!!.Statements.Count == 0 {
            return prefix + "{\n" + Indent(indent) + "}"
        }
        let sb = StringBuilder()
        sb.Append(prefix)
        sb.Append('{')
        for statement in block!!.Statements {
            sb.Append('\n')
            sb.Append(RenderStatement(statement, indent + 1))
        }
        sb.Append('\n')
        sb.Append(Indent(indent))
        sb.Append('}')
        return sb.ToString()
    }

    private func RenderCompilationUnit(unit CompilationUnit) string {
        let sb = StringBuilder()
        var needsBlank = false
        if unit.LeadingComments.Count > 0 {
            for comment in unit.LeadingComments {
                sb.Append(comment)
                sb.Append('\n')
            }
            needsBlank = true
        }
        if !string.IsNullOrEmpty(unit.Package) {
            if needsBlank {
                sb.Append('\n')
            }
            sb.Append((`package ` + "${unit.Package}" + `
`))
            needsBlank = true
        }
        if unit.Imports.Count > 0 {
            if needsBlank {
                sb.Append('\n')
            }
            for import_ in unit.Imports {
                sb.Append(
                    if string.IsNullOrEmpty(import_.Alias) {
                        (`import ` + "${import_.Name}" + `
`)
                    } else {
                        (`import ` + "${import_.Alias}" + ` = ` + "${import_.Name}" + `
`)
                    }
                )
            }
            needsBlank = true
        }
        if unit.FileAttributes.Count > 0 {
            if needsBlank {
                sb.Append('\n')
            }
            for attribute in unit.FileAttributes {
                sb.Append(RenderAttributeInline(attribute))
                sb.Append('\n')
            }
            needsBlank = true
        }
        var previousText string? = nil
        for node in unit.Members {
            let text = RenderTopLevel(node)
            if needsBlank && previousText == nil {
                sb.Append('\n')
            } else if previousText != nil {
                sb.Append(
                    if NeedsBlankBetween(previousText, text) {
                        `

`
                    } else {
                        "\n"
                    }
                )
            }
            sb.Append(text)
            previousText = text
        }
        if previousText != nil {
            sb.Append('\n')
        }
        return sb.ToString()
    }

    private func NeedsBlankBetween(previous string, current string) bool {
        return previous.Contains('\n') || current.Contains('\n')
    }

    private func RenderTopLevel(node GNode?) string {
        if node is GStatement statement {
            return RenderStatement(statement, 0)
        }
        if node is GMember member {
            return RenderMember(member, 0)
        }
        throw ArgumentException("Unsupported top-level node: ${node?.GetType().Name}")
    }

    private func RenderMemberList(members IReadOnlyList[GMember], indent int32) string {
        let sb = StringBuilder()
        var previousText string? = nil
        for member in members {
            let text = RenderMember(member, indent)
            if previousText != nil {
                sb.Append(
                    if NeedsBlankBetween(previousText, text) {
                        `

`
                    } else {
                        "\n"
                    }
                )
            }
            sb.Append(text)
            previousText = text
        }
        return sb.ToString()
    }

    private func RenderMember(member GMember, indent int32) string {
        return PrependAttachedComments(member, RenderMemberCore(member, indent), indent)
    }

    private func RenderMemberCore(member GMember?, indent int32) string {
        switch member {
            case typeDeclaration is TypeDeclaration {
                return RenderTypeDeclaration(typeDeclaration, indent)
            }
            case enumDeclaration is EnumDeclaration {
                return RenderEnumDeclaration(enumDeclaration, indent)
            }
            case namedDelegate is NamedDelegateDeclaration {
                return RenderNamedDelegate(namedDelegate, indent)
            }
            case field is FieldDeclaration {
                return RenderField(field, indent)
            }
            case property is PropertyDeclaration {
                return RenderProperty(property, indent)
            }
            case method is MethodDeclaration {
                return RenderMethod(method, indent)
            }
            case constructor is ConstructorDeclaration {
                return RenderConstructor(constructor, indent)
            }
            case destructor is DestructorDeclaration {
                return "${RenderAttributeBlock(destructor.Attributes, indent)}${Indent(indent)}deinit ${RenderBlock(destructor.Body, indent)}"
            }
            case eventDeclaration is EventDeclaration {
                return RenderEvent(eventDeclaration, indent)
            }
            case sharedBlock is SharedBlock {
                return RenderSharedBlock(sharedBlock, indent)
            }
            case staticInitializer is StaticInitializerBlock {
                return "${Indent(indent)}init ${RenderBlock(staticInitializer.Body, indent)}"
            }
            default {
                throw ArgumentException("Unsupported member: ${member?.GetType().Name}")
            }
        }
    }

    private func RenderAttributeBlock(attributes IReadOnlyList[AttributeUse], indent int32) string {
        if attributes.Count == 0 {
            return string.Empty
        }
        let pad = Indent(indent)
        let sb = StringBuilder()
        for attribute in attributes {
            sb.Append(pad)
            sb.Append(RenderAttributeInline(attribute))
            sb.Append('\n')
        }
        return sb.ToString()
    }

    private func RenderTypeDeclaration(declaration TypeDeclaration, indent int32) string {
        let pad = Indent(indent)
        let sb = StringBuilder()
        sb.Append(RenderAttributeBlock(declaration.Attributes, indent))
        sb.Append(pad)
        sb.Append(RenderVisibility(declaration.Visibility))
        if declaration.IsUnsafe {
            // ADR-0122 / issue #1202 (issue #3684, family F9): the canonical
            // aggregate head is `[visibility]? [unsafe]? [open|sealed]? …` —
            // `ParseMember` consumes the accessibility keyword BEFORE
            // `TryDetectAggregateDeclarationHead` runs, so an `unsafe` that
            // precedes the visibility keyword is not recognised as a
            // declaration head at all and the token parses as an expression
            // statement (GS0125 `Variable 'unsafe' doesn't exist`). Emitting
            // it AFTER the visibility keyword matches the grammar; the
            // modifier then actually establishes the unsafe context, which is
            // what makes a `*T` member signature legal (otherwise `*T` means a
            // managed by-ref and GS0243 rejects it as a parameter type).
            sb.Append("unsafe ")
        }
        if declaration.IsOpen {
            sb.Append("open ")
        }
        if declaration.IsSealed {
            sb.Append("sealed ")
        }
        if declaration.IsAbstract {
            sb.Append("abstract ")
        }
        if declaration.IsShared {
            sb.Append("shared ")
        }
        if declaration.IsPartial {
            // ADR-0144 §G: the `partial` modifier is placed after
            // `open`/`sealed`, immediately before the aggregate keyword
            // (e.g. `public open partial class Foo`).
            sb.Append("partial ")
        }
        if declaration.IsRefLike {
            // ADR-0058 / issue #367: `ref` immediately precedes `struct`
            // (`ref struct Window { ... }`). gsc stamps such a type with
            // `System.Runtime.CompilerServices.IsByRefLikeAttribute`; without
            // it the emitted type is an ordinary struct and the CLR refuses to
            // load it once it holds a by-ref-like instance field (#3869).
            sb.Append("ref ")
        }
        sb.Append(RenderKindKeyword(declaration.Kind))
        sb.Append(' ')
        sb.Append(declaration.Name)
        sb.Append(RenderTypeParameterList(declaration.TypeParameters!!))
        if declaration.PrimaryConstructorParameters != nil {
            sb.Append('(')
            sb.Append(RenderParameterList(declaration.PrimaryConstructorParameters))
            sb.Append(')')
        }
        let baseParts = List[string]()
        if declaration.BaseType != nil {
            var baseTypeText = RenderType(declaration.BaseType)
            if declaration.BaseConstructorArguments != nil {
                // Issue #1909: `: Base(args)` forwards this type's primary-ctor
                // parameters (or other expressions) to the base class's
                // designated constructor (Parser.cs `baseCtorOpenParen`).
                let baseArgs = string.Join(
                    ", ",
                    declaration.BaseConstructorArguments.Select((a GExpression) -> RenderExpression(a, indent))
                )
                baseTypeText += "($baseArgs)"
            }
            baseParts.Add(baseTypeText)
        }
        baseParts.AddRange(declaration.Interfaces.Select(RenderType))
        if baseParts.Count > 0 {
            sb.Append(" : ")
            sb.Append(string.Join(", ", baseParts))
        }
        if !declaration.HasBody {
            return sb.ToString()
        }
        sb.Append(" {")
        let body = RenderMemberList(declaration.Members, indent + 1)
        if body.Length > 0 {
            sb.Append('\n')
            sb.Append(body)
        }
        sb.Append('\n')
        sb.Append(pad)
        sb.Append('}')
        return sb.ToString()
    }

    private func RenderEnumDeclaration(declaration EnumDeclaration, indent int32) string {
        let pad = Indent(indent)
        let cases = declaration.Cases.Select(
            (c EnumCase) -> {
                let text = if c.PayloadParameters.Count == 0 {
                    c.Name
                } else {
                    "${c.Name}(${RenderParameterList(c.PayloadParameters)})"
                }
                // Issue #1912: preserve an explicit constant value (`Banana = 2`,
                // `Unknown = -1`, a resolved `[Flags]`/alias value) so translated
                // G# keeps the C# runtime int32 value instead of a re-numbered
                // sequential ordinal.
                return if c.ExplicitValue is int32 explicitValue {
                    "$text = $explicitValue"
                } else {
                    text
                }
            }
        )
        let sb = StringBuilder()
        sb.Append(RenderAttributeBlock(declaration.Attributes, indent))
        sb.Append(pad)
        sb.Append(RenderVisibility(declaration.Visibility))
        sb.Append("enum ${declaration.Name} { ${string.Join(", ", cases)} }")
        return sb.ToString()
    }

    private func RenderEvent(declaration EventDeclaration, indent int32) string {
        let pad = Indent(indent)
        // ADR-0149: an explicit-interface qualifier clause renders
        // immediately after the `event` keyword, before the member name —
        // mirrors RenderProperty/RenderMethod exactly.
        let explicitClause = if declaration.ExplicitInterfaceType != nil {
            "(${RenderType(declaration.ExplicitInterfaceType)}) "
        } else {
            string.Empty
        }
        let modifiers = if declaration.IsOpen {
            (
                if declaration.IsOverride {
                    "open override "
                } else {
                    "open "
                }
            )
        } else {
            (
                if declaration.IsOverride {
                    "override "
                } else {
                    string.Empty
                }
            )
        }
        let header = "${RenderAttributeBlock(declaration.Attributes, indent)}$pad${RenderVisibility(declaration.Visibility)}${modifiers}event $explicitClause${declaration.Name} ${RenderType(declaration.Type)}"
        if !declaration.HasExplicitAccessors {
            return header
        }
        // ADR-0052 §2 "Event with explicit accessors": both `add` and `remove`
        // must be present; the binder rejects a lone accessor.
        let sb = StringBuilder()
        sb.Append(header)
        sb.Append(" {\n")
        sb.Append(Indent(indent + 1))
        sb.Append("add ")
        sb.Append(RenderBlock(declaration.AddBody, indent + 1))
        sb.Append('\n')
        sb.Append(Indent(indent + 1))
        sb.Append("remove ")
        sb.Append(RenderBlock(declaration.RemoveBody, indent + 1))
        sb.Append('\n')
        sb.Append(pad)
        sb.Append('}')
        return sb.ToString()
    }

    private func RenderNamedDelegate(declaration NamedDelegateDeclaration, indent int32) string {
        let pad = Indent(indent)
        let returnClause = if declaration.ReturnType == nil {
            string.Empty
        } else {
            " ${RenderType(declaration.ReturnType)}"
        }
        let sb = StringBuilder()
        sb.Append(RenderAttributeBlock(declaration.Attributes, indent))
        sb.Append(pad)
        sb.Append(RenderVisibility(declaration.Visibility))
        // Issue #3510: the canonical named-delegate spelling —
        // `delegate Name[TParams]?(params) ReturnType? ;`. The required
        // trailing semicolon terminates the optional return-type clause.
        sb.Append(
            "delegate ${declaration.Name}${RenderTypeParameterList(declaration.TypeParameters)}(${RenderParameterList(declaration.Parameters)})$returnClause;"
        )
        return sb.ToString()
    }

    private func RenderField(field FieldDeclaration, indent int32) string {
        let pad = Indent(indent)
        // ADR-0122 §10: a fixed-size buffer field has no `var`/`let`
        // binding keyword and no initializer — its "type" clause is the
        // bracketed element count followed by the element type
        // (`fixed Name [32]int8`), not the bare element type.
        let typeClause = if field.Type == nil {
            string.Empty
        } else {
            (
                if field.FixedBufferLength is int32 fixedBufferLength {
                    " [$fixedBufferLength]${RenderType(field.Type)}"
                } else {
                    " ${RenderType(field.Type)}"
                }
            )
        }
        let initClause = if field.Initializer == nil {
            string.Empty
        } else {
            " = ${RenderExpression(field.Initializer, indent)}"
        }
        let sb = StringBuilder()
        sb.Append(RenderAttributeBlock(field.Attributes, indent))
        sb.Append(pad)
        sb.Append(RenderVisibility(field.Visibility))
        sb.Append("${RenderBinding(field.Binding)} ${field.Name}$typeClause$initClause")
        return sb.ToString()
    }

    private func RenderProperty(property PropertyDeclaration, indent int32) string {
        let pad = Indent(indent)
        let sb = StringBuilder()
        sb.Append(RenderAttributeBlock(property.Attributes, indent))
        sb.Append(pad)
        sb.Append(RenderVisibility(property.Visibility))
        if property.IsAbstract {
            sb.Append("abstract ")
        }
        if property.IsOpen {
            sb.Append("open ")
        }
        if property.IsOverride {
            sb.Append("override ")
        }
        if property.IsIndexer {
            // ADR-0118: render the canonical indexer header `prop this[...] T`.
            // ADR-0149: an explicit-interface qualifier clause renders
            // immediately after the `prop` keyword, before `this`.
            sb.Append("prop ")
            if property.ExplicitInterfaceType != nil {
                sb.Append("(${RenderType(property.ExplicitInterfaceType)}) ")
            }
            sb.Append(
                "this[${RenderParameterList(property.IndexerParameters)}] ${RenderPropertyReturnPrefix(property)}${RenderType(property.Type)}"
            )
        } else {
            // ADR-0149: an explicit-interface qualifier clause renders
            // immediately after the `prop` keyword, before the member name.
            sb.Append("prop ")
            if property.ExplicitInterfaceType != nil {
                sb.Append("(${RenderType(property.ExplicitInterfaceType)}) ")
            }
            sb.Append("${property.Name} ${RenderPropertyReturnPrefix(property)}${RenderType(property.Type)}")
        }
        if property.ExpressionBody != nil {
            // A property type rendered with a leading '(' (a tuple type, or a
            // function type) followed by ` -> expr` re-parses as a function-TYPE
            // annotation (`(int64, int64) -> Expr`), swallowing the arrow body;
            // a type whose rendering ENDS inside a parenthesized component
            // (`[](string, string)`) lets the nested type position absorb the
            // arrow the same way (unlike funcs, props have no tuple-before-arrow
            // parser disambiguation at all). Spell those with an ADR-0131 arrow
            // get accessor inside a block, where the type ends unambiguously at
            // the '{'.
            if RenderType(property.Type).StartsWith("(", StringComparison.Ordinal) || RenderType(property.Type)
                .EndsWith(")", StringComparison.Ordinal) {
                sb.Append(" {\n")
                sb.Append("${Indent(indent + 1)}get -> ${RenderArrowInline(property.ExpressionBody, indent + 1)}")
                sb.Append('\n')
                sb.Append(pad)
                sb.Append('}')
                return sb.ToString()
            }
            // Issue #1278 / ADR-0131: expression-bodied read-only property/indexer.
            sb.Append(" -> ${RenderArrowInline(property.ExpressionBody, indent)}")
            return sb.ToString()
        }
        if property.Accessors.Count == 0 {
            return sb.ToString()
        }
        sb.Append(" {")
        for accessor in property.Accessors {
            sb.Append('\n')
            sb.Append(RenderAccessor(accessor, indent + 1))
        }
        sb.Append('\n')
        sb.Append(pad)
        sb.Append('}')
        return sb.ToString()
    }

    // Issue #3879 (ADR-0060 amendment): the `ref` return modifier sits between
    // the property/indexer name and its type — `prop P ref int32`,
    // `prop this[i int32] ref int32` — exactly where `func F() ref int32` puts
    // it. gsc's parser consumes it only when a type clause can start at the next
    // token, so the modifier never collides with a property NAMED `ref`.
    private func RenderPropertyReturnPrefix(property PropertyDeclaration) string -> if property.IsReadOnlyRefReturn {
        "ref readonly "
    } else {
        (
            if property.IsRefReturn {
                "ref "
            } else {
                string.Empty
            }
        )
    }

    private func RenderAccessor(accessor PropertyAccessor, indent int32) string {
        let pad = Indent(indent)
        let visibility = RenderVisibility(accessor.Visibility)
        var head string
        switch accessor.Kind {
            case AccessorKind.Get {
                head = "get"
            }
            case AccessorKind.Init {
                head = "init"
            }
            default {
                head = if string.IsNullOrEmpty(accessor.SetterParameterName) {
                    "set"
                } else {
                    "set(${accessor.SetterParameterName})"
                }
            }
        }
        if accessor.ExpressionBody != nil {
            // Issue #1278 / ADR-0131: expression-bodied accessor `get -> e` / `set -> e`.
            return "$pad$visibility$head -> ${RenderArrowInline(accessor.ExpressionBody, indent)}"
        }
        if accessor.Body == nil {
            return "$pad$visibility$head;"
        }
        return "$pad$visibility$head ${RenderBlock(accessor.Body, indent)}"
    }

    private func RenderMethod(method MethodDeclaration, indent int32) string {
        let pad = Indent(indent)
        let sb = StringBuilder()
        sb.Append(RenderAttributeBlock(method.Attributes, indent))
        sb.Append(pad)
        sb.Append(RenderVisibility(method.Visibility))
        if method.IsOpen {
            sb.Append("open ")
        }
        if method.IsOverride {
            sb.Append("override ")
        }
        if method.IsAsync {
            sb.Append("async ")
        } else if method.IsSuspend {
            // ADR-0174 D4: a suspending function; the return type is the
            // logical result, the `suspend` modifier supplies the ValueTask.
            sb.Append("suspend ")
        }
        if method.IsPartial {
            // ADR-0192 §A: `partial` joins the order-independent modifier run
            // with `async`/`suspend`; canonical style places it immediately
            // before `func`. Accessibility and `open`/`override` must precede
            // that run, which the order above already guarantees.
            sb.Append("partial ")
        }
        sb.Append("func ")
        if method.Receiver != nil {
            let receiverParameter = Parameter(
                method.Receiver.Name,
                method.Receiver.Type,
                attributes: method.Receiver.Attributes
            )
            sb.Append("(${RenderParameter(receiverParameter)}) ")
        } else if method.ExplicitInterfaceType != nil {
            // ADR-0149: an explicit-interface qualifier clause renders
            // immediately after the `func` keyword, before the member name —
            // the same physical slot as the receiver clause above (the two
            // are mutually exclusive; a C# method is never both an
            // extension method and an explicit interface implementation).
            sb.Append("(${RenderType(method.ExplicitInterfaceType)}) ")
        }
        sb.Append(method.Name)
        sb.Append(RenderTypeParameterList(method.TypeParameters))
        let parameterList = RenderParameterList(method.Parameters)
        // Issue #3501 B2: a signature whose one-line form exceeds the budget
        // wraps its parameter list after `(` and each comma.
        let signatureLineStart = sb.ToString().LastIndexOf('\n') + 1
        let signatureLineLength = sb.Length - signatureLineStart
        if method.Parameters.Count > 1 && signatureLineLength + parameterList.Length + 2 > MaxLineWidth {
            let parameterPad = Indent(indent + 1)
            sb.Append("(\n")
            sb.Append(parameterPad)
            sb.Append(string.Join(",\n" + parameterPad, method.Parameters.Select(RenderParameter)))
            sb.Append(')')
        } else {
            sb.Append('(')
            sb.Append(parameterList)
            sb.Append(')')
        }
        if method.ReturnType != nil {
            sb.Append(' ')
            if method.IsRefReturn || method.IsReadOnlyRefReturn {
                // Issue #1900: G#'s native ref-return modifier (`func F(...) ref T`,
                // ADR-0060 §follow-up, issue #490) — mapped from a C# ref-returning method.
                sb.Append(
                    if method.IsReadOnlyRefReturn {
                        "ref readonly "
                    } else {
                        "ref "
                    }
                )
            }
            sb.Append(RenderType(method.ReturnType))
        }
        if method.ExpressionBody != nil {
            // A return type whose rendering ends inside a parenthesized
            // component (`[](string, string)`, `Func[(int32, int32)]`'s slice
            // forms, ...) followed by ` -> expr` lets the NESTED type position
            // absorb the arrow as a function-type (`(string, string) -> Expr`),
            // so the emitted file fails the round-trip parse. gsc disambiguates
            // only the top-level tuple-return shape (`func F() (A, B) -> e`,
            // Parser.LooksLikeTupleReturnTypeBeforeArrowBody), which keeps the
            // flat arrow spelling; everything else falls back to a block body.
            if method.ReturnType != nil && !IsSingleTopLevelParenGroup(RenderType(method.ReturnType)) && RenderType(
                method.ReturnType
            )
                .EndsWith(")", StringComparison.Ordinal) {
                sb.Append(" {\n")
                sb.Append(RenderStatement(method.ExpressionBody, indent + 1))
                sb.Append('\n')
                sb.Append(pad)
                sb.Append('}')
                return sb.ToString()
            }
            // Issue #1278 / ADR-0131: expression-bodied method/function.
            sb.Append(" -> ${RenderArrowInline(method.ExpressionBody, indent)}")
            return sb.ToString()
        }
        if method.Body == nil {
            sb.Append(';')
            return sb.ToString()
        }
        sb.Append(' ')
        sb.Append(RenderBlock(method.Body, indent))
        return sb.ToString()
    }

    // True when the rendered type is one balanced top-level `(...)` group —
    // the tuple-return shape gsc's function parser explicitly disambiguates
    // ahead of an arrow body, so it may keep the flat arrow spelling.
    private func IsSingleTopLevelParenGroup(renderedType string) bool {
        if renderedType.Length < 2 || renderedType[0] != '(' {
            return false
        }
        var depth = 0
        for var i = 0; i < renderedType.Length; i++ {
            if renderedType[i] == '(' {
                depth++
            } else if renderedType[i] == ')' {
                depth--
                if depth == 0 {
                    return i == renderedType.Length - 1
                }
            }
        }
        return false
    }

    // Issue #1278 / ADR-0131: render the inline content of an expression-bodied
    // member's single statement as the right-hand side of the `->` arrow. A
    // value-returning member's body is a `return expr` whose `return` keyword is
    // dropped; a void member's body is an expression or assignment statement
    // rendered as-is.
    private func RenderArrowInline(statement GStatement?, indent int32) string {
        switch statement {
            case ret is ReturnStatement {
                // Issue #3501 B2: arrow bodies participate in the wrap pass —
                // a long value expression breaks the same way a `return`
                // statement's would (gsc parses the continuations after `->`).
                return if ret.Expression == nil {
                    string.Empty
                } else {
                    RenderWrappable(ret.Expression, indent, Indent(indent).Length + 8)
                }
            }
            case expr is ExpressionStatement {
                return RenderWrappable(expr.Expression, indent, Indent(indent).Length + 8)
            }
            case assignment is AssignmentStatement {
                return "${RenderExpression(assignment.Target, indent)} ${assignment.Operator} ${RenderExpression(assignment.Value, indent)}"
            }
            default {
                return RenderStatementCore(statement, 0).TrimStart()
            }
        }
    }

    private func RenderConstructor(constructor ConstructorDeclaration, indent int32) string {
        let pad = Indent(indent)
        let sb = StringBuilder()
        sb.Append(RenderAttributeBlock(constructor.Attributes, indent))
        sb.Append(pad)
        sb.Append(RenderVisibility(constructor.Visibility))
        if constructor.IsConvenience {
            sb.Append("convenience ")
        }
        sb.Append("init")
        // Issue #3501: constructors use the same budgeted parameter-list wrap
        // as function headers.
        let ctorParameterList = RenderParameterList(constructor.Parameters)
        let ctorLineStart = sb.ToString().LastIndexOf('\n') + 1
        let ctorLineLength = sb.Length - ctorLineStart
        if constructor.Parameters.Count > 1 && ctorLineLength + ctorParameterList.Length + 2 > MaxLineWidth {
            let ctorParameterPad = Indent(indent + 1)
            sb.Append("(\n")
            sb.Append(ctorParameterPad)
            sb.Append(string.Join(",\n" + ctorParameterPad, constructor.Parameters.Select(RenderParameter)))
            sb.Append(')')
        } else {
            sb.Append('(')
            sb.Append(ctorParameterList)
            sb.Append(')')
        }
        if constructor.BaseArguments != nil {
            let baseArgs = string.Join(
                ", ",
                constructor.BaseArguments.Select((a GExpression) -> RenderExpression(a, indent))
            )
            sb.Append(" : base($baseArgs)")
        }
        var body = constructor.Body
        if constructor.DelegatingArguments != nil {
            var delegation GStatement = ExpressionStatement(
                InvocationExpression(IdentifierExpression("init"), constructor.DelegatingArguments)
            )
            if constructor.DelegatingSuppressedDiagnostics.Count > 0 {
                delegation = BlockStatement(List[GStatement]{delegation}){
                    SuppressedDiagnostics = constructor.DelegatingSuppressedDiagnostics
                }
            }
            let statements = List[GStatement]{delegation}
            statements.AddRange(body.Statements)
            body = BlockStatement(statements, body.IsUnsafe, body.IsChecked, body.IsUnchecked)
        }
        sb.Append(' ')
        sb.Append(RenderBlock(body, indent))
        return sb.ToString()
    }

    private func RenderSharedBlock(sharedBlock SharedBlock, indent int32) string {
        let pad = Indent(indent)
        let sb = StringBuilder()
        sb.Append(pad)
        sb.Append("shared {")
        let body = RenderMemberList(sharedBlock.Members, indent + 1)
        if body.Length > 0 {
            sb.Append('\n')
            sb.Append(body)
        }
        sb.Append('\n')
        sb.Append(pad)
        sb.Append('}')
        return sb.ToString()
    }
}
