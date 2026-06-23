// <copyright file="GSharpPrinter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
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
        var rendered = RenderTypeCore(type);
        return type != null && type.IsNullable ? rendered + "?" : rendered;
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

            default:
                throw new ArgumentException($"Unsupported type reference: {type?.GetType().Name}");
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

    private static string RenderStringLiteralBody(string value)
    {
        var sb = new StringBuilder();
        foreach (var ch in value)
        {
            switch (ch)
            {
                case '\\':
                    sb.Append("\\\\");
                    break;
                case '"':
                    sb.Append("\\\"");
                    break;
                case '$':
                    sb.Append("$$");
                    break;
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

        return sb.ToString();
    }

    private static string RenderInterpolationText(string value)
    {
        var sb = new StringBuilder();
        foreach (var ch in value)
        {
            switch (ch)
            {
                case '\\':
                    sb.Append("\\\\");
                    break;
                case '"':
                    sb.Append("\\\"");
                    break;
                case '$':
                    sb.Append("$$");
                    break;
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

        return sb.ToString();
    }

    private static string RenderExpression(GExpression expression, int indent)
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
                return $"{RenderExpression(member.Target, indent)}.{member.MemberName}";

            case InvocationExpression invocation:
                var typeArgs = invocation.TypeArguments.Count == 0
                    ? string.Empty
                    : $"[{string.Join(", ", invocation.TypeArguments.Select(RenderType))}]";
                var args = string.Join(", ", invocation.Arguments.Select(a => RenderExpression(a, indent)));
                return $"{RenderExpression(invocation.Target, indent)}{typeArgs}({args})";

            case IndexExpression index:
                return $"{RenderExpression(index.Target, indent)}[{RenderExpression(index.Index, indent)}]";

            case CompositeLiteralExpression composite:
                var inits = string.Join(", ", composite.FieldInitializers.Select(f => $"{f.Name}: {RenderExpression(f.Value, indent)}"));
                return $"{RenderType(composite.Type)}{{{inits}}}";

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

            case TupleLiteralExpression tuple:
                var tupleElements = string.Join(", ", tuple.Elements.Select(e => RenderExpression(e, indent)));
                return $"({tupleElements})";

            case BinaryExpression binary:
                return $"{RenderExpression(binary.Left, indent)} {binary.Operator} {RenderExpression(binary.Right, indent)}";

            case UnaryExpression unary:
                return $"{unary.Operator}{RenderExpression(unary.Operand, indent)}";

            case NonNullAssertionExpression nonNull:
                return $"{RenderExpression(nonNull.Operand, indent)}!!";

            case ParenthesizedExpression parenthesized:
                return $"({RenderExpression(parenthesized.Inner, indent)})";

            case LambdaExpression lambda:
                return RenderLambda(lambda, indent);

            case AwaitExpression await:
                return $"await {RenderExpression(await.Operand, indent)}";

            case SwitchExpression switchExpression:
                return RenderSwitchExpression(switchExpression, indent);

            case IfExpression ifExpression:
                return $"if {RenderExpression(ifExpression.Condition, indent)} {{ {RenderExpression(ifExpression.ThenExpression, indent)} }} else {{ {RenderExpression(ifExpression.ElseExpression, indent)} }}";

            case ThrowExpression throwExpression:
                // G# has no throw-expression: lower to an if-expression whose
                // then-branch block runs the `throw` statement and supplies an
                // unreachable typed tail (spec §If expressions). The shape is a
                // primary expression, so it is valid in every value position.
                var throwTail = throwExpression.ResultType == null
                    ? "default"
                    : $"default({RenderType(throwExpression.ResultType)})";
                return $"if true {{ throw {RenderExpression(throwExpression.Operand, indent)}\n{Indent(indent + 1)}{throwTail} }} else {{ {throwTail} }}";

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

    private static string RenderCollectionInitializer(CollectionInitializerExpression collection, int indent)
    {
        // Canonical form: drop the empty `()` on a zero-argument construction
        // so `List[int32](){...}` renders as `List[int32]{...}`.
        string target;
        if (collection.Target is InvocationExpression invocation && invocation.Arguments.Count == 0)
        {
            var typeArgs = invocation.TypeArguments.Count == 0
                ? string.Empty
                : $"[{string.Join(", ", invocation.TypeArguments.Select(RenderType))}]";
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
                return $"'{literal.Value}'";
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
            var sb = new StringBuilder();
            sb.Append($"{asyncPrefix}({parameters}) -> {{");
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

            default:
                throw new ArgumentException($"Unsupported pattern: {pattern?.GetType().Name}");
        }
    }

    private static string RenderInterpolatedString(InterpolatedStringExpression interpolated, int indent)
    {
        var sb = new StringBuilder();
        sb.Append('"');
        foreach (var part in interpolated.Parts)
        {
            if (!part.IsHole)
            {
                sb.Append(RenderInterpolationText(part.Text));
                continue;
            }

            var canUseShorthand = part.Expression is IdentifierExpression
                && string.IsNullOrEmpty(part.Alignment)
                && string.IsNullOrEmpty(part.Format);

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
                var usingPrefix = local.IsUsing ? "using " : string.Empty;
                return $"{pad}{usingPrefix}{RenderBinding(local.Binding)} {local.Name}{typeClause}{initClause}";

            case ExpressionStatement expression:
                return $"{pad}{RenderExpression(expression.Expression, indent)}";

            case AssignmentStatement assignment:
                return $"{pad}{RenderExpression(assignment.Target, indent)} {assignment.Operator} {RenderExpression(assignment.Value, indent)}";

            case ReturnStatement ret:
                return ret.Expression == null
                    ? $"{pad}return"
                    : $"{pad}return {RenderExpression(ret.Expression, indent)}";

            case ThrowStatement thrown:
                return $"{pad}throw {RenderExpression(thrown.Expression, indent)}";

            case IfStatement ifStatement:
                return RenderIf(ifStatement, indent);

            case WhileStatement whileStatement:
                return $"{pad}while {RenderExpression(whileStatement.Condition, indent)} {RenderBlock(whileStatement.Body, indent)}";

            case ForStatement forStatement:
                return RenderForStatement(forStatement, indent);

            case IncrementDecrementStatement incDec:
                return $"{pad}{RenderExpression(incDec.Target, indent)}{incDec.Operator}";

            case ForInStatement forIn:
                var loopVars = string.IsNullOrEmpty(forIn.ValueName)
                    ? forIn.VariableName
                    : $"{forIn.VariableName}, {forIn.ValueName}";
                return $"{pad}for {loopVars} in {RenderExpression(forIn.Iterable, indent)} {RenderBlock(forIn.Body, indent)}";

            case DeferStatement defer:
                return $"{pad}defer {RenderBlock(defer.Body, indent)}";

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

            case DoWhileStatement doWhile:
                return $"{pad}do {RenderBlock(doWhile.Body, indent)} while {RenderExpression(doWhile.Condition, indent)}";

            case TupleDeconstructionStatement deconstruction:
                var targets = string.Join(", ", deconstruction.Names);
                return $"{pad}{RenderBinding(deconstruction.Binding)} ({targets}) = {RenderExpression(deconstruction.Initializer, indent)}";

            case LocalFunctionStatement localFunction:
                return $"{pad}{RenderBinding(BindingKind.Let)} {localFunction.Name} = {RenderExpression(localFunction.Lambda, indent)}";

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
        if (block.Statements.Count == 0)
        {
            return "{\n" + Indent(indent) + "}";
        }

        var sb = new StringBuilder();
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
                return $"{Indent(indent)}deinit {RenderBlock(destructor.Body, indent)}";
            case EventDeclaration eventDeclaration:
                return $"{Indent(indent)}{RenderVisibility(eventDeclaration.Visibility)}event {eventDeclaration.Name} {RenderType(eventDeclaration.Type)}";
            case SharedBlock sharedBlock:
                return RenderSharedBlock(sharedBlock, indent);
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
            baseParts.Add(RenderType(declaration.BaseType));
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
            c.PayloadParameters.Count == 0
                ? c.Name
                : $"{c.Name}({RenderParameterList(c.PayloadParameters)})");
        var sb = new StringBuilder();
        sb.Append(RenderAttributeBlock(declaration.Attributes, indent));
        sb.Append(pad);
        sb.Append(RenderVisibility(declaration.Visibility));
        sb.Append($"enum {declaration.Name} {{ {string.Join(", ", cases)} }}");
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
        sb.Append($"type {declaration.Name} = delegate func({RenderParameterList(declaration.Parameters)}){returnClause}");
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
            sb.Append($"prop this[{RenderParameterList(property.IndexerParameters)}] {RenderType(property.Type)}");
        }
        else
        {
            sb.Append($"prop {property.Name} {RenderType(property.Type)}");
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

        sb.Append(method.Name);
        sb.Append(RenderTypeParameterList(method.TypeParameters));
        sb.Append('(');
        sb.Append(RenderParameterList(method.Parameters));
        sb.Append(')');
        if (method.ReturnType != null)
        {
            sb.Append(' ');
            sb.Append(RenderType(method.ReturnType));
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
