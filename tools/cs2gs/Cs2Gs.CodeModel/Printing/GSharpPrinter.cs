// <copyright file="GSharpPrinter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using Cs2Gs.CodeModel.Ast;

namespace Cs2Gs.CodeModel.Printing;

/// <summary>
/// Turns a G# emit AST into canonical G# source text following ADR-0115 §B:
/// deterministic ordering, 4-space indentation, K&amp;R braces, visibility only
/// when non-default, in-body vs receiver-clause methods, base-first <c>:</c>
/// clauses, bracket generics, arrow delegate types, <c>${}</c> interpolation,
/// and <c>@Attr</c> application. The same AST always produces byte-identical
/// text.
/// </summary>
public static class GSharpPrinter
{
    private const string IndentUnit = "    ";

    // Unary operators (`+ - ! ^ * & <-`) bind at precedence 6 in G#'s
    // grammar — higher than every binary operator — per
    // SyntaxFacts.GetUnaryOperatorPrecedence.
    private const int UnaryPrecedence = 6;

    /// <summary>
    /// Prints a compilation unit to canonical G# source text.
    /// </summary>
    /// <param name="unit">The compilation unit to print.</param>
    /// <returns>The canonical G# source, terminated by a single newline.</returns>
    public static string Print(CompilationUnit unit)
    {
        if (unit == null)
        {
            throw new ArgumentNullException(nameof(unit));
        }

        return RenderCompilationUnit(unit);
    }

    /// <summary>
    /// Issue #943: renders a <see cref="GTypeReference"/> to its G# surface form
    /// (e.g. <c>IComparable[T]</c>). Exposed so the translator can place a
    /// constructed-generic interface constraint into a type parameter's legacy
    /// constraint slot.
    /// </summary>
    /// <param name="type">The type reference to render.</param>
    /// <returns>The rendered G# type form.</returns>
    public static string RenderTypeReference(GTypeReference type) => RenderType(type);

    private static string Indent(int level)
    {
        // ponytail: no shared cache — Print is a public static API and xunit
        // runs test classes in parallel, so a shared List<string> grown
        // on-demand here would race. Indent strings are tiny; allocate
        // per-call instead of guarding shared state.
        return string.Concat(Enumerable.Repeat(IndentUnit, level));
    }

    private static string RenderVisibility(Visibility visibility)
    {
        switch (visibility)
        {
            case Visibility.Public:
                return "public ";
            case Visibility.Internal:
                return "internal ";
            case Visibility.Private:
                return "private ";
            case Visibility.Protected:
                return "protected ";
            default:
                return string.Empty;
        }
    }

    private static string RenderBinding(BindingKind binding)
    {
        switch (binding)
        {
            case BindingKind.Let:
                return "let";
            case BindingKind.Const:
                return "const";
            default:
                return "var";
        }
    }

    private static string RenderKindKeyword(TypeDeclarationKind kind)
    {
        switch (kind)
        {
            case TypeDeclarationKind.Class:
                return "class";
            case TypeDeclarationKind.Struct:
                return "struct";
            case TypeDeclarationKind.DataClass:
                return "data class";
            case TypeDeclarationKind.DataStruct:
                return "data struct";
            case TypeDeclarationKind.InlineStruct:
                return "inline struct";
            case TypeDeclarationKind.Interface:
                return "interface";
            default:
                return "class";
        }
    }

    private static string RenderType(GTypeReference type)
    {
        // Issue #1212: an array's own nullability is spelled `[]?T` (the `?`
        // sits right after `]`), distinct from an array of nullable elements
        // `[]T?` (where the element rendering carries its own trailing `?`).
        if (type is ArrayTypeReference array)
        {
            var arrayMarker = array.IsNullable ? "?" : string.Empty;
            return $"[]{arrayMarker}{RenderType(array.ElementType)}";
        }

        // Issue #1745: `type` can't be null here — RenderTypeCore already
        // dereferenced it above (via the `type is ArrayTypeReference` check)
        // and, for any other unsupported/null input, throws inside its
        // switch's default case before returning. The `type == null` guard
        // that used to sit here was dead code.
        var rendered = RenderTypeCore(type);
        if (!type.IsNullable)
        {
            return rendered;
        }

        // A nullable function type must be parenthesized: `((T) -> R)?` (ADR-0137 /
        // issue #1399). A bare `(T) -> R?` binds `?` to the return type, not the
        // function type. Every other type spells nullable with a trailing `?`.
        return type is ArrowTypeReference ? $"({rendered})?" : rendered + "?";
    }

    private static string RenderTypeCore(GTypeReference type)
    {
        switch (type)
        {
            case NamedTypeReference named:
                if (named.TypeArguments.Count == 0)
                {
                    return named.Name;
                }

                return $"{named.Name}[{string.Join(", ", named.TypeArguments.Select(RenderType))}]";

            case ArrayTypeReference array:
                return $"[]{RenderType(array.ElementType)}";

            case PointerTypeReference pointer:
                return $"*{RenderType(pointer.ElementType)}";

            case TupleTypeReference tuple:
                return $"({string.Join(", ", tuple.ElementTypes.Select(RenderType))})";

            case ArrowTypeReference arrow:
                var prefix = arrow.IsAsync ? "async " : string.Empty;
                var parameters = string.Join(", ", arrow.ParameterTypes.Select(RenderType));
                var returns = RenderArrowReturn(arrow.ReturnTypes);
                return $"{prefix}({parameters}) -> {returns}";

            case FunctionPointerTypeReference functionPointer:
                return RenderFunctionPointer(functionPointer);

            default:
                throw new ArgumentException($"Unsupported type reference: {type?.GetType().Name}");
        }
    }

    private static string RenderFunctionPointer(FunctionPointerTypeReference functionPointer)
    {
        var parameters = string.Join(", ", functionPointer.ParameterTypes.Select(RenderType));
        if (functionPointer.IsManaged)
        {
            // ADR-0122 §9: the managed function pointer omits the return type
            // entirely for a void-returning pointer, e.g. `*func(int)`.
            return functionPointer.ReturnType is null
                ? $"*func({parameters})"
                : $"*func({parameters}) {RenderType(functionPointer.ReturnType)}";
        }

        // ADR-0095 §2: the unmanaged raw form always spells the return type
        // explicitly, using `void` for a void-returning pointer.
        var returnText = functionPointer.ReturnType is null ? "void" : RenderType(functionPointer.ReturnType);
        return $"unmanaged[{RenderCallingConvention(functionPointer.CallingConvention)}] ({parameters}) -> {returnText}";
    }

    private static string RenderCallingConvention(CallingConvention callingConvention)
    {
        // The G# `[CC]` identifier slot (see gsc's Binder.cs) recognises
        // "Cdecl"/"Stdcall"/"Thiscall"/"Fastcall" — capitalized-first-letter
        // spellings, distinct from the .NET CallingConvention enum's own
        // "StdCall"/"ThisCall"/"FastCall" member names.
        switch (callingConvention)
        {
            case CallingConvention.Cdecl:
                return "Cdecl";
            case CallingConvention.StdCall:
                return "Stdcall";
            case CallingConvention.ThisCall:
                return "Thiscall";
            case CallingConvention.FastCall:
                return "Fastcall";
            default:
                throw new ArgumentException($"Unsupported calling convention: {callingConvention}");
        }
    }

    private static string RenderArrowReturn(IReadOnlyList<GTypeReference> returnTypes)
    {
        if (returnTypes.Count == 0)
        {
            return "void";
        }

        if (returnTypes.Count == 1)
        {
            return RenderType(returnTypes[0]);
        }

        return $"({string.Join(", ", returnTypes.Select(RenderType))})";
    }

    private static string RenderParameter(Parameter parameter)
    {
        var sb = new StringBuilder();
        foreach (var attribute in parameter.Attributes)
        {
            sb.Append(RenderAttributeInline(attribute));
            sb.Append(' ');
        }

        if (!string.IsNullOrEmpty(parameter.RefKind))
        {
            sb.Append(parameter.RefKind);
            sb.Append(' ');
        }

        sb.Append(parameter.Name);
        sb.Append(' ');
        sb.Append(parameter.IsVariadic ? $"...{RenderType(parameter.Type)}" : RenderType(parameter.Type));

        if (parameter.DefaultValue != null)
        {
            sb.Append(" = ");
            sb.Append(RenderExpression(parameter.DefaultValue, 0));
        }

        return sb.ToString();
    }

    private static string RenderParameterList(IReadOnlyList<Parameter> parameters)
    {
        return string.Join(", ", parameters.Select(RenderParameter));
    }

    private static string RenderTypeParameter(TypeParameter typeParameter)
    {
        var sb = new StringBuilder();
        switch (typeParameter.Variance)
        {
            case Variance.Out:
                sb.Append("out ");
                break;
            case Variance.In:
                sb.Append("in ");
                break;
        }

        sb.Append(typeParameter.Name);

        if (!string.IsNullOrEmpty(typeParameter.LegacyConstraint))
        {
            sb.Append(' ');
            sb.Append(typeParameter.LegacyConstraint);
        }

        foreach (var flag in typeParameter.FlagConstraints)
        {
            sb.Append(' ');
            sb.Append(flag);
        }

        return sb.ToString();
    }

    private static string RenderTypeParameterList(IReadOnlyList<TypeParameter> typeParameters)
    {
        if (typeParameters.Count == 0)
        {
            return string.Empty;
        }

        return $"[{string.Join(", ", typeParameters.Select(RenderTypeParameter))}]";
    }

    private static string RenderAttributeInline(AttributeUse attribute)
    {
        var sb = new StringBuilder();
        sb.Append('@');
        if (!string.IsNullOrEmpty(attribute.Target))
        {
            sb.Append(attribute.Target);
            sb.Append(':');
        }

        sb.Append(attribute.Name);
        if (attribute.Arguments.Count > 0)
        {
            sb.Append('(');
            sb.Append(string.Join(", ", attribute.Arguments.Select(RenderAttributeArgument)));
            sb.Append(')');
        }

        return sb.ToString();
    }

    private static string RenderAttributeArgument(AttributeArgument argument)
    {
        var value = RenderExpression(argument.Value, 0);
        return string.IsNullOrEmpty(argument.Name) ? value : $"{argument.Name}: {value}";
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
    private static string RenderEscapedLiteralBody(string value, char quoteChar, bool escapeDollar)
    {
        var sb = new StringBuilder();
        foreach (var ch in value)
        {
            if (ch == '\\')
            {
                sb.Append("\\\\");
            }
            else if (ch == quoteChar)
            {
                sb.Append('\\').Append(quoteChar);
            }
            else if (escapeDollar && ch == '$')
            {
                sb.Append("$$");
            }
            else
            {
                switch (ch)
                {
                    case '\n':
                        sb.Append("\\n");
                        break;
                    case '\r':
                        sb.Append("\\r");
                        break;
                    case '\t':
                        sb.Append("\\t");
                        break;
                    default:
                        if (ch < ' ' || ch == '\u007F')
                        {
                            sb.Append("\\u").Append(((int)ch).ToString("X4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            sb.Append(ch);
                        }

                        break;
                }
            }
        }

        return sb.ToString();
    }

    private static string RenderStringLiteralBody(string value) =>
        RenderEscapedLiteralBody(value, '"', escapeDollar: true);

    private static string RenderInterpolationText(string value) =>
        RenderEscapedLiteralBody(value, '"', escapeDollar: true);

    // Issue #1722: char literals must escape the closing quote, backslash,
    // and control chars the same way strings do, or C#'s '\'' , '\\', '\n',
    // etc. produce malformed/corrupted G# (empty literal, unterminated
    // literal, or raw control bytes in the output file).
    private static string RenderCharLiteralBody(string value) =>
        RenderEscapedLiteralBody(value, '\'', escapeDollar: false);

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
    private static int GetBinaryPrecedence(string op) => op switch
    {
        "*" or "/" or "%" or "<<" or ">>" or ">>>" or "&" or "&^" => 5,
        "+" or "-" or "|" or "^" => 4,
        "==" or "!=" or "<" or "<=" or ">" or ">=" or "is" or "as" => 3,
        "&&" => 2,
        "||" => 1,
        "??" => 0,
        _ => throw new ArgumentException($"Unknown binary operator: {op}"),
    };

    /// <summary>
    /// Renders an expression, parenthesizing it if its own G# operator
    /// precedence is lower than <paramref name="minPrecedence"/> (the
    /// precedence required by the surrounding context to reproduce the
    /// original tree shape when re-parsed).
    /// </summary>
    private static string RenderExpression(GExpression expression, int indent, int minPrecedence)
    {
        if (expression is BinaryExpression outerBinary)
        {
            var precedence = GetBinaryPrecedence(outerBinary.Operator);

            // `??` is right-associative: its left operand must strictly
            // out-bind it (else a nested `??` on the left would silently
            // re-associate), while its right operand may sit at the same
            // level (a nested `??` on the right reproduces the natural
            // right-associative chain). Every other G# binary operator is
            // left-associative: the left operand may sit at the same level,
            // but the right operand must strictly out-bind it.
            var isRightAssociative = outerBinary.Operator == "??";
            var leftMin = isRightAssociative ? precedence + 1 : precedence;
            var rightMin = isRightAssociative ? precedence : precedence + 1;

            var leftText = RenderExpression(outerBinary.Left, indent, leftMin);
            var rightText = RenderExpression(outerBinary.Right, indent, rightMin);
            var rendered = $"{leftText} {outerBinary.Operator} {rightText}";
            return precedence < minPrecedence ? $"({rendered})" : rendered;
        }

        return RenderExpressionCore(expression, indent);
    }

    private static string RenderExpression(GExpression expression, int indent) =>
        RenderExpression(expression, indent, 0);

    private static string RenderExpressionCore(GExpression expression, int indent)
    {
        switch (expression)
        {
            case LiteralExpression literal:
                return RenderLiteral(literal);

            case IdentifierExpression identifier:
                return identifier.Name;

            case ThisExpression _:
                return "this";

            case MemberAccessExpression member:
                return $"{RenderExpression(member.Target, indent)}{(member.IsArrow ? "->" : ".")}{member.MemberName}";

            case InvocationExpression invocation:
                var typeArgs = invocation.TypeArguments.Count == 0
                    ? string.Empty
                    : $"[{string.Join(", ", invocation.TypeArguments.Select(RenderType))}]";
                var args = string.Join(", ", invocation.Arguments.Select(a => RenderExpression(a, indent)));
                return $"{RenderExpression(invocation.Target, indent)}{typeArgs}({args})";

            case IndexExpression index:
                return $"{RenderExpression(index.Target, indent)}[{RenderExpression(index.Index, indent)}]";

            case FromEndIndexExpression fromEnd:
                return $"^{RenderExpression(fromEnd.Operand, indent)}";

            case RangeIndexExpression range:
                var rangeStart = range.Start != null ? RenderExpression(range.Start, indent) : string.Empty;
                var rangeEnd = range.End != null ? RenderExpression(range.End, indent) : string.Empty;
                return $"{rangeStart}..{rangeEnd}";

            case CompositeLiteralExpression composite:
                var inits = string.Join(", ", composite.FieldInitializers.Select(f => $"{f.Name}: {RenderExpression(f.Value, indent)}"));
                return $"{RenderType(composite.Type)}{{{inits}}}";

            case ObjectCreationInitializerExpression objectCreation:
                var memberInits = string.Join(", ", objectCreation.MemberInitializers.Select(f => $"{f.Name} = {RenderExpression(f.Value, indent)}"));
                return $"{RenderExpression(objectCreation.Construction, indent)}{{{memberInits}}}";

            case AnonymousClassLiteralExpression anonymousClass:
                var anonymousMembers = string.Join("; ", anonymousClass.Members.Select(
                    f => $"let {f.Name} {RenderType(f.Type)} = {RenderExpression(f.Value, indent)}"));
                return $"object {{ {anonymousMembers} }}";

            case CollectionInitializerExpression collection:
                return RenderCollectionInitializer(collection, indent);

            case ConversionExpression conversion:
                return $"{RenderType(conversion.TargetType)}({RenderExpression(conversion.Operand, indent)})";

            case WithExpression with:
                if (with.Updates.Count == 0)
                {
                    return $"{RenderExpression(with.Target, indent)} with {{ }}";
                }

                var updates = string.Join(", ", with.Updates.Select(f => $"{f.Name} = {RenderExpression(f.Value, indent)}"));
                return $"{RenderExpression(with.Target, indent)} with {{ {updates} }}";

            case ArrayLiteralExpression arrayLiteral:
                var elements = string.Join(", ", arrayLiteral.Elements.Select(e => RenderExpression(e, indent)));
                return $"[]{RenderType(arrayLiteral.ElementType)}{{{elements}}}";

            case ArrayAllocationExpression arrayAllocation:
                return $"[{RenderExpression(arrayAllocation.Length, indent)}]{RenderType(arrayAllocation.ElementType)}";

            case TupleLiteralExpression tuple:
                var tupleElements = string.Join(", ", tuple.Elements.Select(e => RenderExpression(e, indent)));
                return $"({tupleElements})";

            case UnaryExpression unary:
                {
                    // Unary operators bind at precedence 6 — higher than every
                    // binary operator — so a binary-expression operand (e.g. a
                    // stray `BinaryExpression` reaching here without an explicit
                    // `ParenthesizedExpression` wrapper) must be parenthesized.
                    var operandText = RenderExpression(unary.Operand, indent, UnaryPrecedence);

                    // Issue #1721: nested same-character prefix operators
                    // silently coalesce into a different token if printed with
                    // no separating space — `!!flag` (double logical negation)
                    // lexes as the single BangBangToken (postfix non-null
                    // assertion), and `- -x` lexes as `--x` (predecrement),
                    // changing the parsed program. A space between the operator
                    // and an operand that starts with the same character keeps
                    // the tokens distinct and is always semantically safe.
                    var separator = operandText.Length > 0 && operandText[0] == unary.Operator[unary.Operator.Length - 1]
                        ? " "
                        : string.Empty;
                    return $"{unary.Operator}{separator}{operandText}";
                }

            case NonNullAssertionExpression nonNull:
                return $"{RenderExpression(nonNull.Operand, indent, UnaryPrecedence)}!!";

            case IncrementDecrementExpression incDec:
                return incDec.IsPrefix
                    ? $"{incDec.Operator}{RenderExpression(incDec.Operand, indent, UnaryPrecedence)}"
                    : $"{RenderExpression(incDec.Operand, indent, UnaryPrecedence)}{incDec.Operator}";

            case StackAllocExpression stackAlloc:
                {
                    var count = stackAlloc.Count == null ? string.Empty : RenderExpression(stackAlloc.Count, indent);
                    var head = $"stackalloc [{count}]{RenderType(stackAlloc.ElementType)}";
                    if (stackAlloc.Elements == null)
                    {
                        return head;
                    }

                    var rendered = string.Join(", ", stackAlloc.Elements.Select(e => RenderExpression(e, indent)));
                    return $"{head}{{{rendered}}}";
                }

            case ParenthesizedExpression parenthesized:
                return $"({RenderExpression(parenthesized.Inner, indent)})";

            case CheckedExpression checkedExpr:
                return $"{(checkedExpr.IsChecked ? "checked" : "unchecked")}({RenderExpression(checkedExpr.Inner, indent)})";

            case LambdaExpression lambda:
                return RenderLambda(lambda, indent);

            case AwaitExpression await:
                // `await` binds at the same precedence slot as unary operators
                // (Parser.cs: `ParseBinaryExpression(6)` for the await operand).
                return $"await {RenderExpression(await.Operand, indent, UnaryPrecedence)}";

            case SwitchExpression switchExpression:
                return RenderSwitchExpression(switchExpression, indent);

            case IfExpression ifExpression:
                return $"if {RenderExpression(ifExpression.Condition, indent)} {{ {RenderBranchValue(ifExpression.ThenExpression, indent)} }} else {{ {RenderBranchValue(ifExpression.ElseExpression, indent)} }}";

            case ThrowExpression throwExpression:
                // G# supports throw-as-expression natively: render the bare
                // `throw <operand>` form, valid in coalesce-RHS, switch-arm,
                // and ternary expression positions (issue #1153).
                return $"throw {RenderExpression(throwExpression.Operand, indent)}";

            case OutArgumentExpression outArgument:
                return $"{outArgument.Keyword} {outArgument.Name}";

            case TypeOfExpression typeOf:
                return $"typeof({RenderType(typeOf.Type)})";

            case DefaultValueExpression defaultValue:
                return defaultValue.Type == null
                    ? "default"
                    : $"default({RenderType(defaultValue.Type)})";

            case TypeExpression typeExpression:
                return RenderType(typeExpression.Type);

            case ConditionalReceiverExpression:
                return string.Empty;

            case ConditionalAccessExpression conditionalAccess:
                return $"{RenderExpression(conditionalAccess.Target, indent)}?{RenderExpression(conditionalAccess.WhenNotNull, indent)}";

            case InterpolatedStringExpression interpolated:
                return RenderInterpolatedString(interpolated, indent);

            default:
                throw new ArgumentException($"Unsupported expression: {expression?.GetType().Name}");
        }
    }

    private static string RenderBranchValue(GExpression expression, int indent)
    {
        // A switch expression rendered bare as the tail of an `if`-expression
        // branch block (`else { switch … }`) is re-parsed as a switch STATEMENT
        // (whose arms use `{ … }` bodies, not `case …:`), so it is parenthesized
        // to keep it in expression position. Other expressions are unaffected.
        if (expression is SwitchExpression)
        {
            return $"({RenderExpression(expression, indent)})";
        }

        // A bare throw-expression is not accepted as the sole trailing value of
        // an if-expression block branch (gsc GS0277). Emit the throw as a
        // STATEMENT followed by a value-producing typed tail so the branch block
        // ends with a value-producing expression (issue #1153).
        if (expression is ThrowExpression throwExpression)
        {
            var throwTail = throwExpression.ResultType == null
                ? "default"
                : $"default({RenderType(throwExpression.ResultType)})";
            return $"throw {RenderExpression(throwExpression.Operand, indent)}\n{Indent(indent + 1)}{throwTail}";
        }

        return RenderExpression(expression, indent);
    }

    private static string RenderCollectionInitializer(CollectionInitializerExpression collection, int indent)
    {
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
        string target;
        if (collection.Target == null)
        {
            // Issue #1567: a target-less collection initializer is the member
            // collection-initializer form `{ elems }` used as a composite/object-
            // initializer member value to populate a get-only collection
            // property (lowered to `.Add(...)` calls by gsc).
            target = string.Empty;
        }
        else if (collection.Target is InvocationExpression invocation
            && invocation.Arguments.Count == 0
            && invocation.TypeArguments.Count > 0)
        {
            var typeArgs = $"[{string.Join(", ", invocation.TypeArguments.Select(RenderType))}]";
            target = $"{RenderExpression(invocation.Target, indent)}{typeArgs}";
        }
        else
        {
            target = RenderExpression(collection.Target, indent);
        }

        var elements = collection.Elements.Select(element => element.Kind switch
        {
            CollectionInitializerElementKind.Keyed =>
                $"{RenderExpression(element.Key, indent)}: {RenderExpression(element.Value, indent)}",
            CollectionInitializerElementKind.Indexed =>
                $"[{RenderExpression(element.Key, indent)}] = {RenderExpression(element.Value, indent)}",
            _ => RenderExpression(element.Value, indent),
        });

        return $"{target}{{ {string.Join(", ", elements)} }}";
    }

    private static string RenderLiteral(LiteralExpression literal)
    {
        switch (literal.Kind)
        {
            case LiteralKind.String:
                return $"\"{RenderStringLiteralBody(literal.Value)}\"";
            case LiteralKind.Char:
                return $"'{RenderCharLiteralBody(literal.Value)}'";
            default:
                return literal.Value;
        }
    }

    private static string RenderLambda(LambdaExpression lambda, int indent)
    {
        var asyncPrefix = lambda.IsAsync ? "async " : string.Empty;
        var parameters = RenderParameterList(lambda.Parameters);

        if (lambda.BlockBody != null)
        {
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
            var arrowOpen = lambda.IsFunctionLiteral
                ? $"{asyncPrefix}func ({parameters})" +
                    (lambda.ReturnType != null ? " " + RenderTypeReference(lambda.ReturnType) : string.Empty) +
                    " {"
                : $"{asyncPrefix}({parameters}) -> {{";
            var sb = new StringBuilder();
            sb.Append(arrowOpen);
            foreach (var statement in lambda.BlockBody.Statements)
            {
                sb.Append('\n');
                sb.Append(RenderStatement(statement, indent + 1));
            }

            sb.Append('\n');
            sb.Append(Indent(indent));
            sb.Append('}');
            return sb.ToString();
        }

        return $"{asyncPrefix}({parameters}) -> {RenderExpression(lambda.ExpressionBody, indent)}";
    }

    private static string RenderSwitchExpression(SwitchExpression switchExpression, int indent)
    {
        var pad = Indent(indent);
        var armPad = Indent(indent + 1);
        var sb = new StringBuilder();
        sb.Append($"switch {RenderExpression(switchExpression.Subject, indent)} {{");
        foreach (var arm in switchExpression.Arms)
        {
            sb.Append('\n');
            sb.Append(armPad);
            string marker;
            if (arm.Pattern == null)
            {
                marker = "default:";
            }
            else if (arm.Guard != null)
            {
                marker = $"case {RenderPattern(arm.Pattern, indent + 1)} when {RenderExpression(arm.Guard, indent + 1)}:";
            }
            else
            {
                marker = $"case {RenderPattern(arm.Pattern, indent + 1)}:";
            }

            sb.Append(marker);
            sb.Append(' ');
            sb.Append(RenderExpression(arm.Body, indent + 1));
        }

        sb.Append('\n');
        sb.Append(pad);
        sb.Append('}');
        return sb.ToString();
    }

    private static string RenderPattern(GPattern pattern, int indent)
    {
        switch (pattern)
        {
            case ConstantPattern constant:
                return RenderExpression(constant.Value, indent);

            case RelationalPattern relational:
                return $"{relational.Operator} {RenderExpression(relational.Value, indent)}";

            case TypePattern type:
                return $"{type.Designator} is {RenderType(type.Type)}";

            case PropertyPattern property:
                var fields = string.Join(", ", property.Fields.Select(f => $"{f.Name}: {RenderPattern(f.Pattern, indent)}"));
                return $"{{ {fields} }}";

            case DiscardPattern _:
                return "_";

            case BinaryPattern binary:
                return $"{RenderPattern(binary.Left, indent)} {(binary.IsConjunction ? "and" : "or")} {RenderPattern(binary.Right, indent)}";

            case NotPattern not:
                return $"not {RenderPattern(not.Pattern, indent)}";

            case ParenthesizedPattern paren:
                return $"({RenderPattern(paren.Pattern, indent)})";

            case ListPattern list:
                return $"[{string.Join(", ", list.Elements.Select(e => RenderPattern(e, indent)))}]";

            case SlicePattern slice:
                if (slice.Pattern != null)
                {
                    return $"..{RenderPattern(slice.Pattern, indent)}";
                }

                return slice.Designator != null ? $"..{slice.Designator}" : "..";

            default:
                throw new ArgumentException($"Unsupported pattern: {pattern?.GetType().Name}");
        }
    }

    private static string RenderInterpolatedString(InterpolatedStringExpression interpolated, int indent)
    {
        var sb = new StringBuilder();
        sb.Append('"');
        for (var i = 0; i < interpolated.Parts.Count; i++)
        {
            var part = interpolated.Parts[i];
            if (!part.IsHole)
            {
                sb.Append(RenderInterpolationText(part.Text));
                continue;
            }

            var canUseShorthand = part.Expression is IdentifierExpression
                && string.IsNullOrEmpty(part.Alignment)
                && string.IsNullOrEmpty(part.Format)
                && !NextLiteralContinuesIdentifier(interpolated.Parts, i);

            if (canUseShorthand)
            {
                sb.Append('$');
                sb.Append(((IdentifierExpression)part.Expression).Name);
                continue;
            }

            sb.Append("${");
            sb.Append(RenderExpression(part.Expression, indent));
            if (!string.IsNullOrEmpty(part.Alignment))
            {
                sb.Append(',');
                sb.Append(part.Alignment);
            }

            if (!string.IsNullOrEmpty(part.Format))
            {
                sb.Append(':');
                sb.Append(part.Format);
            }

            sb.Append('}');
        }

        sb.Append('"');
        return sb.ToString();
    }

    private static bool NextLiteralContinuesIdentifier(IReadOnlyList<InterpolationPart> parts, int holeIndex)
    {
        if (holeIndex + 1 >= parts.Count)
        {
            return false;
        }

        var next = parts[holeIndex + 1];
        if (next.IsHole || string.IsNullOrEmpty(next.Text))
        {
            return false;
        }

        var first = next.Text[0];
        return char.IsLetterOrDigit(first) || first == '_';
    }

    private static string RenderStatement(GStatement statement, int indent)
    {
        var pad = Indent(indent);
        switch (statement)
        {
            case LocalDeclarationStatement local:
                var typeClause = local.Type == null ? string.Empty : $" {RenderType(local.Type)}";
                var initClause = local.Initializer == null
                    ? string.Empty
                    : $" = {RenderExpression(local.Initializer, indent)}";
                var usingPrefix = local.IsUsing ? (local.IsAwait ? "await using " : "using ") : string.Empty;
                var refPrefix = local.IsRefAlias ? "ref " : string.Empty;
                return $"{pad}{usingPrefix}{RenderBinding(local.Binding)} {refPrefix}{local.Name}{typeClause}{initClause}";

            case ExpressionStatement expression:
                return $"{pad}{RenderExpression(expression.Expression, indent)}";

            case AssignmentStatement assignment:
                return $"{pad}{RenderExpression(assignment.Target, indent)} {assignment.Operator} {RenderExpression(assignment.Value, indent)}";

            case ReturnStatement ret:
                return ret.Expression == null
                    ? $"{pad}return"
                    : ret.IsRef
                        ? $"{pad}return ref {RenderExpression(ret.Expression, indent)}"
                        : $"{pad}return {RenderExpression(ret.Expression, indent)}";

            case ThrowStatement thrown:
                return $"{pad}throw {RenderExpression(thrown.Expression, indent)}";

            case IfStatement ifStatement:
                return RenderIf(ifStatement, indent);

            case WhileStatement whileStatement:
                return $"{pad}while {RenderExpression(whileStatement.Condition, indent)} {RenderBlock(whileStatement.Body, indent)}";

            case LockStatement lockStatement:
                return $"{pad}lock {RenderExpression(lockStatement.Target, indent)} {RenderBlock(lockStatement.Body, indent)}";

            case ForStatement forStatement:
                return RenderForStatement(forStatement, indent);

            case IncrementDecrementStatement incDec:
                return $"{pad}{RenderExpression(incDec.Target, indent)}{incDec.Operator}";

            case FixedStatement fixedStatement:
                return $"{pad}fixed {fixedStatement.Name} {RenderType(fixedStatement.PointerType)} = {RenderExpression(fixedStatement.Source, indent)} {RenderBlock(fixedStatement.Body, indent)}";

            case ForInStatement forIn:
                var loopVars = string.IsNullOrEmpty(forIn.ValueName)
                    ? forIn.VariableName
                    : $"{forIn.VariableName}, {forIn.ValueName}";
                var forKeyword = forIn.IsAwait ? "await for" : "for";
                return $"{pad}{forKeyword} {loopVars} in {RenderExpression(forIn.Iterable, indent)} {RenderBlock(forIn.Body, indent)}";

            case ForTupleInStatement forTupleIn:
                var tupleLoopVars = string.Join(", ", forTupleIn.Names);
                return $"{pad}for ({tupleLoopVars}) in {RenderExpression(forTupleIn.Iterable, indent)} {RenderBlock(forTupleIn.Body, indent)}";

            case DeferStatement defer:
                return $"{pad}defer {RenderExpression(defer.Call, indent)}";

            case TryStatement tryStatement:
                return RenderTry(tryStatement, indent);

            case BlockStatement block:
                return $"{pad}{RenderBlock(block, indent)}";

            case RawStatement raw:
                return $"{pad}{raw.Text}";

            case YieldStatement yield:
                return $"{pad}yield {RenderExpression(yield.Expression, indent)}";

            case SwitchStatement switchStatement:
                return RenderSwitchStatement(switchStatement, indent);

            case BreakStatement:
                return $"{pad}break";

            case ContinueStatement:
                return $"{pad}continue";

            case GotoStatement gotoStatement:
                return $"{pad}goto {gotoStatement.Label}";

            case LabeledStatement labeledStatement:
                return $"{pad}{labeledStatement.Label}:\n{RenderStatement(labeledStatement.Statement, indent)}";

            case DoWhileStatement doWhile:
                return $"{pad}do {RenderBlock(doWhile.Body, indent)} while {RenderExpression(doWhile.Condition, indent)}";

            case TupleDeconstructionStatement deconstruction:
                var targets = string.Join(", ", deconstruction.Names);
                return $"{pad}{RenderBinding(deconstruction.Binding)} ({targets}) = {RenderExpression(deconstruction.Initializer, indent)}";

            case LocalFunctionStatement localFunction:
                var typeParamSuffix = localFunction.TypeParameters.Count > 0
                    ? $"[{string.Join(", ", localFunction.TypeParameters)}]"
                    : string.Empty;
                return $"{pad}{RenderBinding(BindingKind.Let)} {localFunction.Name}{typeParamSuffix} = {RenderExpression(localFunction.Lambda, indent)}";

            default:
                throw new ArgumentException($"Unsupported statement: {statement?.GetType().Name}");
        }
    }

    private static string RenderSwitchStatement(SwitchStatement switchStatement, int indent)
    {
        var pad = Indent(indent);
        var casePad = Indent(indent + 1);
        var sb = new StringBuilder();
        sb.Append($"{pad}switch {RenderExpression(switchStatement.Subject, indent)} {{");
        foreach (var arm in switchStatement.Cases)
        {
            sb.Append('\n');
            sb.Append(casePad);
            string head;
            if (arm.Pattern == null)
            {
                head = "default";
            }
            else if (arm.Guard != null)
            {
                head = $"case {RenderPattern(arm.Pattern, indent + 1)} when {RenderExpression(arm.Guard, indent + 1)}";
            }
            else
            {
                head = $"case {RenderPattern(arm.Pattern, indent + 1)}";
            }

            sb.Append($"{head} {RenderBlock(arm.Body, indent + 1)}");
        }

        sb.Append('\n');
        sb.Append(pad);
        sb.Append('}');
        return sb.ToString();
    }

    private static string RenderForStatement(ForStatement forStatement, int indent)
    {
        var pad = Indent(indent);
        var init = forStatement.Initializer == null
            ? string.Empty
            : RenderSimpleStatement(forStatement.Initializer, indent);
        var cond = forStatement.Condition == null
            ? string.Empty
            : RenderExpression(forStatement.Condition, indent);
        var incr = forStatement.Incrementor == null
            ? string.Empty
            : RenderSimpleStatement(forStatement.Incrementor, indent);
        return $"{pad}for {init}; {cond}; {incr} {RenderBlock(forStatement.Body, indent)}";
    }

    private static string RenderSimpleStatement(GStatement statement, int indent)
    {
        // A "simple" statement (init/incr clause of a C-style for) is rendered
        // inline with no leading indentation.
        return RenderStatement(statement, indent).TrimStart();
    }

    private static string RenderIf(IfStatement ifStatement, int indent)
    {
        var pad = Indent(indent);
        var sb = new StringBuilder();
        sb.Append($"{pad}if {RenderExpression(ifStatement.Condition, indent)} {RenderBlock(ifStatement.Then, indent)}");
        if (ifStatement.ElseBranch is IfStatement elseIf)
        {
            sb.Append(" else ");
            sb.Append(RenderIf(elseIf, indent).TrimStart());
        }
        else if (ifStatement.ElseBranch is BlockStatement elseBlock)
        {
            sb.Append(" else ");
            sb.Append(RenderBlock(elseBlock, indent));
        }

        return sb.ToString();
    }

    private static string RenderTry(TryStatement tryStatement, int indent)
    {
        var pad = Indent(indent);
        var sb = new StringBuilder();
        sb.Append($"{pad}try {RenderBlock(tryStatement.TryBlock, indent)}");
        foreach (var catchClause in tryStatement.CatchClauses)
        {
            if (catchClause.ExceptionType != null)
            {
                var binder = string.IsNullOrEmpty(catchClause.VariableName)
                    ? RenderType(catchClause.ExceptionType)
                    : $"{catchClause.VariableName} {RenderType(catchClause.ExceptionType)}";
                sb.Append($" catch ({binder}) {RenderBlock(catchClause.Body, indent)}");
            }
            else
            {
                sb.Append($" catch {RenderBlock(catchClause.Body, indent)}");
            }
        }

        if (tryStatement.FinallyBlock != null)
        {
            sb.Append($" finally {RenderBlock(tryStatement.FinallyBlock, indent)}");
        }

        return sb.ToString();
    }

    private static string RenderBlock(BlockStatement block, int indent)
    {
        var prefix = block.IsUnsafe ? "unsafe " : block.IsChecked ? "checked " : block.IsUnchecked ? "unchecked " : string.Empty;
        if (block.Statements.Count == 0)
        {
            return prefix + "{\n" + Indent(indent) + "}";
        }

        var sb = new StringBuilder();
        sb.Append(prefix);
        sb.Append('{');
        foreach (var statement in block.Statements)
        {
            sb.Append('\n');
            sb.Append(RenderStatement(statement, indent + 1));
        }

        sb.Append('\n');
        sb.Append(Indent(indent));
        sb.Append('}');
        return sb.ToString();
    }

    private static string RenderCompilationUnit(CompilationUnit unit)
    {
        var sb = new StringBuilder();
        var needsBlank = false;

        if (unit.LeadingComments.Count > 0)
        {
            foreach (var comment in unit.LeadingComments)
            {
                sb.Append("// ");
                sb.Append(comment);
                sb.Append('\n');
            }

            needsBlank = true;
        }

        if (!string.IsNullOrEmpty(unit.Package))
        {
            if (needsBlank)
            {
                sb.Append('\n');
            }

            sb.Append($"package {unit.Package}\n");
            needsBlank = true;
        }

        if (unit.Imports.Count > 0)
        {
            if (needsBlank)
            {
                sb.Append('\n');
            }

            foreach (var import in unit.Imports)
            {
                sb.Append(string.IsNullOrEmpty(import.Alias)
                    ? $"import {import.Name}\n"
                    : $"import {import.Alias} = {import.Name}\n");
            }

            needsBlank = true;
        }

        string previousText = null;
        foreach (var node in unit.Members)
        {
            var text = RenderTopLevel(node);
            if (needsBlank && previousText == null)
            {
                sb.Append('\n');
            }
            else if (previousText != null)
            {
                sb.Append(NeedsBlankBetween(previousText, text) ? "\n\n" : "\n");
            }

            sb.Append(text);
            previousText = text;
        }

        if (previousText != null)
        {
            sb.Append('\n');
        }

        return sb.ToString();
    }

    private static bool NeedsBlankBetween(string previous, string current)
    {
        return previous.Contains('\n') || current.Contains('\n');
    }

    private static string RenderTopLevel(GNode node)
    {
        if (node is GStatement statement)
        {
            return RenderStatement(statement, 0);
        }

        if (node is GMember member)
        {
            return RenderMember(member, 0);
        }

        throw new ArgumentException($"Unsupported top-level node: {node?.GetType().Name}");
    }

    private static string RenderMemberList(IReadOnlyList<GMember> members, int indent)
    {
        var sb = new StringBuilder();
        string previousText = null;
        foreach (var member in members)
        {
            var text = RenderMember(member, indent);
            if (previousText != null)
            {
                sb.Append(NeedsBlankBetween(previousText, text) ? "\n\n" : "\n");
            }

            sb.Append(text);
            previousText = text;
        }

        return sb.ToString();
    }

    private static string RenderMember(GMember member, int indent)
    {
        switch (member)
        {
            case TypeDeclaration typeDeclaration:
                return RenderTypeDeclaration(typeDeclaration, indent);
            case EnumDeclaration enumDeclaration:
                return RenderEnumDeclaration(enumDeclaration, indent);
            case NamedDelegateDeclaration namedDelegate:
                return RenderNamedDelegate(namedDelegate, indent);
            case FieldDeclaration field:
                return RenderField(field, indent);
            case PropertyDeclaration property:
                return RenderProperty(property, indent);
            case MethodDeclaration method:
                return RenderMethod(method, indent);
            case ConstructorDeclaration constructor:
                return RenderConstructor(constructor, indent);
            case DestructorDeclaration destructor:
                return $"{RenderAttributeBlock(destructor.Attributes, indent)}{Indent(indent)}deinit {RenderBlock(destructor.Body, indent)}";
            case EventDeclaration eventDeclaration:
                return RenderEvent(eventDeclaration, indent);
            case SharedBlock sharedBlock:
                return RenderSharedBlock(sharedBlock, indent);
            case StaticInitializerBlock staticInitializer:
                return $"{Indent(indent)}init {RenderBlock(staticInitializer.Body, indent)}";
            default:
                throw new ArgumentException($"Unsupported member: {member?.GetType().Name}");
        }
    }

    private static string RenderAttributeBlock(IReadOnlyList<AttributeUse> attributes, int indent)
    {
        if (attributes.Count == 0)
        {
            return string.Empty;
        }

        var pad = Indent(indent);
        var sb = new StringBuilder();
        foreach (var attribute in attributes)
        {
            sb.Append(pad);
            sb.Append(RenderAttributeInline(attribute));
            sb.Append('\n');
        }

        return sb.ToString();
    }

    private static string RenderTypeDeclaration(TypeDeclaration declaration, int indent)
    {
        var pad = Indent(indent);
        var sb = new StringBuilder();
        sb.Append(RenderAttributeBlock(declaration.Attributes, indent));
        sb.Append(pad);
        if (declaration.IsUnsafe)
        {
            // ADR-0122 / issue #1014: the `unsafe` contextual modifier precedes
            // the accessibility keyword (`unsafe public class …`).
            sb.Append("unsafe ");
        }

        sb.Append(RenderVisibility(declaration.Visibility));
        if (declaration.IsOpen)
        {
            sb.Append("open ");
        }

        if (declaration.IsSealed)
        {
            sb.Append("sealed ");
        }

        if (declaration.IsAbstract)
        {
            sb.Append("abstract ");
        }

        if (declaration.IsPartial)
        {
            // ADR-0144 §G: the `partial` modifier is placed after
            // `open`/`sealed`, immediately before the aggregate keyword
            // (e.g. `public open partial class Foo`).
            sb.Append("partial ");
        }

        sb.Append(RenderKindKeyword(declaration.Kind));
        sb.Append(' ');
        sb.Append(declaration.Name);
        sb.Append(RenderTypeParameterList(declaration.TypeParameters));

        if (declaration.PrimaryConstructorParameters != null)
        {
            sb.Append('(');
            sb.Append(RenderParameterList(declaration.PrimaryConstructorParameters));
            sb.Append(')');
        }

        var baseParts = new List<string>();
        if (declaration.BaseType != null)
        {
            var baseTypeText = RenderType(declaration.BaseType);
            if (declaration.BaseConstructorArguments != null)
            {
                // Issue #1909: `: Base(args)` forwards this type's primary-ctor
                // parameters (or other expressions) to the base class's
                // designated constructor (Parser.cs `baseCtorOpenParen`).
                var baseArgs = string.Join(", ", declaration.BaseConstructorArguments.Select(a => RenderExpression(a, indent)));
                baseTypeText += $"({baseArgs})";
            }

            baseParts.Add(baseTypeText);
        }

        baseParts.AddRange(declaration.Interfaces.Select(RenderType));
        if (baseParts.Count > 0)
        {
            sb.Append(" : ");
            sb.Append(string.Join(", ", baseParts));
        }

        if (!declaration.HasBody)
        {
            return sb.ToString();
        }

        sb.Append(" {");
        var body = RenderMemberList(declaration.Members, indent + 1);
        if (body.Length > 0)
        {
            sb.Append('\n');
            sb.Append(body);
        }

        sb.Append('\n');
        sb.Append(pad);
        sb.Append('}');
        return sb.ToString();
    }

    private static string RenderEnumDeclaration(EnumDeclaration declaration, int indent)
    {
        var pad = Indent(indent);
        var cases = declaration.Cases.Select(c =>
        {
            var text = c.PayloadParameters.Count == 0
                ? c.Name
                : $"{c.Name}({RenderParameterList(c.PayloadParameters)})";

            // Issue #1912: preserve an explicit constant value (`Banana = 2`,
            // `Unknown = -1`, a resolved `[Flags]`/alias value) so translated
            // G# keeps the C# runtime int32 value instead of a re-numbered
            // sequential ordinal.
            return c.ExplicitValue is int explicitValue ? $"{text} = {explicitValue}" : text;
        });
        var sb = new StringBuilder();
        sb.Append(RenderAttributeBlock(declaration.Attributes, indent));
        sb.Append(pad);
        sb.Append(RenderVisibility(declaration.Visibility));
        sb.Append($"enum {declaration.Name} {{ {string.Join(", ", cases)} }}");
        return sb.ToString();
    }

    private static string RenderEvent(EventDeclaration declaration, int indent)
    {
        var pad = Indent(indent);
        var header = $"{RenderAttributeBlock(declaration.Attributes, indent)}{pad}{RenderVisibility(declaration.Visibility)}event {declaration.Name} {RenderType(declaration.Type)}";
        if (!declaration.HasExplicitAccessors)
        {
            return header;
        }

        // ADR-0052 §2 "Event with explicit accessors": both `add` and `remove`
        // must be present; the binder rejects a lone accessor.
        var sb = new StringBuilder();
        sb.Append(header);
        sb.Append(" {\n");
        sb.Append(Indent(indent + 1));
        sb.Append("add ");
        sb.Append(RenderBlock(declaration.AddBody, indent + 1));
        sb.Append('\n');
        sb.Append(Indent(indent + 1));
        sb.Append("remove ");
        sb.Append(RenderBlock(declaration.RemoveBody, indent + 1));
        sb.Append('\n');
        sb.Append(pad);
        sb.Append('}');
        return sb.ToString();
    }

    private static string RenderNamedDelegate(NamedDelegateDeclaration declaration, int indent)
    {
        var pad = Indent(indent);
        var returnClause = declaration.ReturnType == null
            ? string.Empty
            : $" {RenderType(declaration.ReturnType)}";
        var sb = new StringBuilder();
        sb.Append(RenderAttributeBlock(declaration.Attributes, indent));
        sb.Append(pad);
        sb.Append(RenderVisibility(declaration.Visibility));
        sb.Append($"type {declaration.Name}{RenderTypeParameterList(declaration.TypeParameters)} = delegate func({RenderParameterList(declaration.Parameters)}){returnClause}");
        return sb.ToString();
    }

    private static string RenderField(FieldDeclaration field, int indent)
    {
        var pad = Indent(indent);
        var typeClause = field.Type == null ? string.Empty : $" {RenderType(field.Type)}";
        var initClause = field.Initializer == null
            ? string.Empty
            : $" = {RenderExpression(field.Initializer, indent)}";
        var sb = new StringBuilder();
        sb.Append(RenderAttributeBlock(field.Attributes, indent));
        sb.Append(pad);
        sb.Append(RenderVisibility(field.Visibility));
        sb.Append($"{RenderBinding(field.Binding)} {field.Name}{typeClause}{initClause}");
        return sb.ToString();
    }

    private static string RenderProperty(PropertyDeclaration property, int indent)
    {
        var pad = Indent(indent);
        var sb = new StringBuilder();
        sb.Append(RenderAttributeBlock(property.Attributes, indent));
        sb.Append(pad);
        sb.Append(RenderVisibility(property.Visibility));
        if (property.IsOpen)
        {
            sb.Append("open ");
        }

        if (property.IsOverride)
        {
            sb.Append("override ");
        }

        if (property.IsIndexer)
        {
            // ADR-0118: render the canonical indexer header `prop this[...] T`.
            // ADR-0148: an explicit-interface qualifier clause renders
            // immediately after the `prop` keyword, before `this`.
            sb.Append("prop ");
            if (property.ExplicitInterfaceType != null)
            {
                sb.Append($"({RenderType(property.ExplicitInterfaceType)}) ");
            }

            sb.Append($"this[{RenderParameterList(property.IndexerParameters)}] {RenderType(property.Type)}");
        }
        else
        {
            // ADR-0148: an explicit-interface qualifier clause renders
            // immediately after the `prop` keyword, before the member name.
            sb.Append("prop ");
            if (property.ExplicitInterfaceType != null)
            {
                sb.Append($"({RenderType(property.ExplicitInterfaceType)}) ");
            }

            sb.Append($"{property.Name} {RenderType(property.Type)}");
        }

        if (property.ExpressionBody != null)
        {
            // Issue #1278 / ADR-0131: expression-bodied read-only property/indexer.
            sb.Append($" -> {RenderArrowInline(property.ExpressionBody, indent)}");
            return sb.ToString();
        }

        if (property.Accessors.Count == 0)
        {
            return sb.ToString();
        }

        sb.Append(" {");
        foreach (var accessor in property.Accessors)
        {
            sb.Append('\n');
            sb.Append(RenderAccessor(accessor, indent + 1));
        }

        sb.Append('\n');
        sb.Append(pad);
        sb.Append('}');
        return sb.ToString();
    }

    private static string RenderAccessor(PropertyAccessor accessor, int indent)
    {
        var pad = Indent(indent);
        string head;
        switch (accessor.Kind)
        {
            case AccessorKind.Get:
                head = "get";
                break;
            case AccessorKind.Init:
                head = "init";
                break;
            default:
                head = string.IsNullOrEmpty(accessor.SetterParameterName)
                    ? "set"
                    : $"set({accessor.SetterParameterName})";
                break;
        }

        if (accessor.ExpressionBody != null)
        {
            // Issue #1278 / ADR-0131: expression-bodied accessor `get -> e` / `set -> e`.
            return $"{pad}{head} -> {RenderArrowInline(accessor.ExpressionBody, indent)}";
        }

        if (accessor.Body == null)
        {
            return $"{pad}{head};";
        }

        return $"{pad}{head} {RenderBlock(accessor.Body, indent)}";
    }

    private static string RenderMethod(MethodDeclaration method, int indent)
    {
        var pad = Indent(indent);
        var sb = new StringBuilder();
        sb.Append(RenderAttributeBlock(method.Attributes, indent));
        sb.Append(pad);
        sb.Append(RenderVisibility(method.Visibility));
        if (method.IsOpen)
        {
            sb.Append("open ");
        }

        if (method.IsOverride)
        {
            sb.Append("override ");
        }

        if (method.IsAsync)
        {
            sb.Append("async ");
        }

        sb.Append("func ");
        if (method.Receiver != null)
        {
            sb.Append($"({method.Receiver.Name} {RenderType(method.Receiver.Type)}) ");
        }
        else if (method.ExplicitInterfaceType != null)
        {
            // ADR-0148: an explicit-interface qualifier clause renders
            // immediately after the `func` keyword, before the member name —
            // the same physical slot as the receiver clause above (the two
            // are mutually exclusive; a C# method is never both an
            // extension method and an explicit interface implementation).
            sb.Append($"({RenderType(method.ExplicitInterfaceType)}) ");
        }

        sb.Append(method.Name);
        sb.Append(RenderTypeParameterList(method.TypeParameters));
        sb.Append('(');
        sb.Append(RenderParameterList(method.Parameters));
        sb.Append(')');
        if (method.ReturnType != null)
        {
            sb.Append(' ');
            if (method.IsRefReturn)
            {
                // Issue #1900: G#'s native ref-return modifier (`func F(...) ref T`,
                // ADR-0060 §follow-up, issue #490) — mapped from a C# ref-returning method.
                sb.Append("ref ");
            }

            sb.Append(RenderType(method.ReturnType));
        }

        if (method.ExpressionBody != null)
        {
            // Issue #1278 / ADR-0131: expression-bodied method/function.
            sb.Append($" -> {RenderArrowInline(method.ExpressionBody, indent)}");
            return sb.ToString();
        }

        if (method.Body == null)
        {
            sb.Append(';');
            return sb.ToString();
        }

        sb.Append(' ');
        sb.Append(RenderBlock(method.Body, indent));
        return sb.ToString();
    }

    // Issue #1278 / ADR-0131: render the inline content of an expression-bodied
    // member's single statement as the right-hand side of the `->` arrow. A
    // value-returning member's body is a `return expr` whose `return` keyword is
    // dropped; a void member's body is an expression or assignment statement
    // rendered as-is.
    private static string RenderArrowInline(GStatement statement, int indent)
    {
        switch (statement)
        {
            case ReturnStatement ret:
                return ret.Expression == null ? string.Empty : RenderExpression(ret.Expression, indent);
            case ExpressionStatement expr:
                return RenderExpression(expr.Expression, indent);
            case AssignmentStatement assignment:
                return $"{RenderExpression(assignment.Target, indent)} {assignment.Operator} {RenderExpression(assignment.Value, indent)}";
            default:
                return RenderStatement(statement, 0).TrimStart();
        }
    }

    private static string RenderConstructor(ConstructorDeclaration constructor, int indent)
    {
        var pad = Indent(indent);
        var sb = new StringBuilder();
        sb.Append(RenderAttributeBlock(constructor.Attributes, indent));
        sb.Append(pad);
        sb.Append(RenderVisibility(constructor.Visibility));
        if (constructor.IsConvenience)
        {
            sb.Append("convenience ");
        }

        sb.Append($"init({RenderParameterList(constructor.Parameters)})");
        if (constructor.BaseArguments != null)
        {
            var baseArgs = string.Join(", ", constructor.BaseArguments.Select(a => RenderExpression(a, indent)));
            sb.Append($" : base({baseArgs})");
        }

        sb.Append(' ');
        sb.Append(RenderBlock(constructor.Body, indent));
        return sb.ToString();
    }

    private static string RenderSharedBlock(SharedBlock sharedBlock, int indent)
    {
        var pad = Indent(indent);
        var sb = new StringBuilder();
        sb.Append(pad);
        sb.Append("shared {");
        var body = RenderMemberList(sharedBlock.Members, indent + 1);
        if (body.Length > 0)
        {
            sb.Append('\n');
            sb.Append(body);
        }

        sb.Append('\n');
        sb.Append(pad);
        sb.Append('}');
        return sb.ToString();
    }
}
